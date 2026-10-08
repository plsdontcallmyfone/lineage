import { canonicalJson, merkleProof, merkleRoot, signStatement, type AgentKey } from "@lineage/protocol";
import {
  ChainReader,
  hexToBytes,
  launch,
  launchPdas,
  Rpc,
  sendAndConfirm,
  TxError,
  usageLeaf,
  type LaunchConfig,
  type SendResult,
} from "@lineage/chain";
import { CoreClient } from "../../core/src/client.ts";
import type { ClosedEpoch } from "./state.ts";

// Where hosted agents, their keys and their compute vaults live. `SimBackend` reads the simulated
// Core and posts usage to its usage endpoint; `ChainBackend` reads the registry and launch programs
// on devnet and posts usage with `post_usage` and `debit_compute` (SPEC 14.2, 14.5).

export interface HostedAgent {
  agent: string;
  mint: string | null;
  launcher: string | null;
  target_repo: string | null;
}

export interface Vault {
  balance: bigint;
  awake: boolean;
}

export interface Backend {
  readonly mode: "sim" | "devnet";
  /** Token decimals and onchain limits. */
  init(): Promise<{ decimals: number; sleepThreshold: bigint; wakeThreshold: bigint; maxDebitPerEpoch: bigint | null }>;
  discover(): Promise<HostedAgent[]>;
  /** The key that currently speaks for `agent` (null: revoked). */
  signingKey(agent: string): Promise<string | null>;
  vault(a: HostedAgent): Promise<Vault>;
  /** What the owner needs to bind the agent to `key` (public data only). */
  bindRequest(agent: string, key: AgentKey): Promise<Record<string, unknown>>;
  /** devnet: the epoch number the next post must use and the earliest unix second it may land; sim: the next period. */
  nextEpoch(nextPeriod: number): Promise<{ epoch: number; earliestS: number }>;
  /** Posts a closed epoch and debits every leaf, idempotently (records each landed step in `e` via `save`). */
  post(e: ClosedEpoch, save: () => void): Promise<void>;
  /** Re-evaluates sleep and wake where the backend does not do it itself; returns true when it sent something. */
  refreshAwake(a: HostedAgent, v: Vault, wakeThreshold: bigint, sleepThreshold: bigint): Promise<boolean>;
}

// ------------------------------------------------------------------------------------------------

export class SimBackend implements Backend {
  readonly mode = "sim" as const;
  private client: CoreClient;
  private anon: CoreClient;
  constructor(core: string, private runtimeKey: AgentKey) {
    this.client = new CoreClient(core, runtimeKey);
    this.anon = new CoreClient(core, null);
  }

  private async ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
    const r = await p;
    if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  }

  async init() {
    const c = await this.ok(this.anon.get("/v1/config"), "config");
    if (c.runtime !== this.runtimeKey.id) throw new Error(`Core's runtime authority is ${c.runtime ?? "unset"}, not this runtime's key ${this.runtimeKey.id}; start Core with --runtime-key`);
    return { decimals: Number(c.network.token_decimals), sleepThreshold: BigInt(c.network.sleep_threshold), wakeThreshold: BigInt(c.network.wake_threshold), maxDebitPerEpoch: null };
  }

  async discover(): Promise<HostedAgent[]> {
    const all = await this.ok<any[]>(this.anon.get("/v1/agents"), "agents");
    return all.filter((a) => a.kind === "launched" && a.hosted === true).map((a) => ({ agent: a.agent_id, mint: a.mint ?? null, launcher: a.launcher ?? null, target_repo: a.target_repo ?? null }));
  }

  async signingKey(agent: string) {
    const h = await this.ok(this.anon.get(`/v1/agents/${agent}/keys`), "keys");
    return h.revoked ? null : (h.signing_key as string);
  }

  async vault(a: HostedAgent): Promise<Vault> {
    const v = await this.ok(this.anon.get(`/v1/agents/${a.agent}`), "agent");
    return { balance: BigInt(v.compute ?? "0"), awake: !!v.awake };
  }

  /** M1 rotation (SPEC 14.6): the launcher posts this with the agent's current key; the runtime key signs the statement. */
  async bindRequest(agent: string, key: AgentKey) {
    const h = await this.ok(this.anon.get(`/v1/agents/${agent}/keys`), "keys");
    const seq = Number(h.seq) + 1;
    return {
      mode: "sim",
      agent,
      endpoint: `POST /v1/agents/${agent}/keys/rotate (signed by the agent's current key)`,
      body: { new_key: key.id, new_key_sig: signStatement(key, "rotate", { agent, new_key: key.id, seq }) },
      seq,
    };
  }

  async nextEpoch(nextPeriod: number) {
    return { epoch: nextPeriod, earliestS: 0 };
  }

  async post(e: ClosedEpoch, save: () => void) {
    for (const l of e.leaves) {
      if (e.debits[l.agent]) continue;
      if (BigInt(l.amount) === 0n) {
        e.debits[l.agent] = "none";
        save();
        continue;
      }
      const ref = `runtime:${this.runtimeKey.id}:${e.epoch}:${l.agent}`;
      const r = await this.ok(
        this.client.post("/v1/admin/usage", {
          agent: l.agent,
          amount: l.amount,
          model_tokens: l.model_tokens,
          sandbox_seconds: l.sandbox_s,
          note: `hosted runtime usage epoch ${e.epoch}`,
          ref,
          detail: { usage_epoch: e.epoch, usd: l.usd.toFixed(6), cost: l.cost, model_tokens: l.model_tokens, sandbox_s: l.sandbox_s },
        }),
        "usage",
      );
      e.debits[l.agent] = `sim:${r.usage_id}`;
      save();
    }
    e.done = true;
    save();
  }

  async refreshAwake() {
    return false; // Core re-evaluates sleep and wake on every fee, debit and claim
  }
}

// ------------------------------------------------------------------------------------------------

export interface ChainBackendOptions {
  rpcUrl: string;
  /** called for every landed transaction, for the devnet log */
  onTx?: (what: string, r: SendResult) => void;
  log?: (m: string) => void;
}

export class ChainBackend implements Backend {
  readonly mode = "devnet" as const;
  readonly rpc: Rpc;
  readonly reader: ChainReader;
  private cfg: LaunchConfig | null = null;
  private epochLengthS = 0;
  constructor(private runtimeKey: AgentKey, private o: ChainBackendOptions) {
    this.rpc = withBackoff(Rpc.http(o.rpcUrl, "confirmed"), o.log);
    this.reader = new ChainReader(this.rpc);
  }

  private async config(fresh = false): Promise<LaunchConfig> {
    if (!this.cfg || fresh) {
      const c = await this.reader.launchConfig();
      if (!c) throw new Error("lineage_launch is not initialized on this cluster");
      this.cfg = c;
    }
    return this.cfg;
  }

  async init() {
    const c = await this.config(true);
    if (c.runtimeAuthority !== this.runtimeKey.id) throw new Error(`LaunchConfig.runtime_authority is ${c.runtimeAuthority}, not this runtime's key ${this.runtimeKey.id}`);
    const mint = await this.reader.mint(c.lineMint);
    const reg = await this.reader.registryConfig();
    if (!reg) throw new Error("lineage_registry is not initialized on this cluster");
    this.epochLengthS = reg.params.epochLengthS;
    return { decimals: mint!.decimals, sleepThreshold: c.sleepThreshold, wakeThreshold: c.wakeThreshold, maxDebitPerEpoch: c.maxDebitPerEpoch && c.maxDebitPerEpoch > 0n ? c.maxDebitPerEpoch : null };
  }

  async discover(): Promise<HostedAgent[]> {
    const all = await this.reader.launches();
    return all.filter((l) => l.hosted).map((l) => ({ agent: l.agent, mint: l.mint, launcher: l.launcher, target_repo: l.repoUrl }));
  }

  async signingKey(agent: string) {
    const a = await this.reader.agent(agent);
    if (!a) return null;
    return a.signingKey ?? null;
  }

  async vault(a: HostedAgent): Promise<Vault> {
    const [bal, l] = await Promise.all([this.reader.tokenBalance(launchPdas.computeVault(a.agent)), this.reader.agentLaunch(a.mint!)]);
    return { balance: bal ?? 0n, awake: !!l?.awake };
  }

  /** The owner signs `rotate_agent_key` (Wallet page, or a TEST owner key); this runtime co-signs as the new key (`lineage-runtime cosign`). */
  async bindRequest(agent: string, key: AgentKey) {
    return {
      mode: "devnet",
      agent,
      new_key: key.id,
      how: "Wallet page, Identity tab: rotate the agent's key to new_key; paste the signed transaction into `lineage-runtime cosign --agent <id> --tx <base64>`",
    };
  }

  async nextEpoch() {
    const c = await this.config(true);
    if (!c.usageEpochsPosted) return { epoch: 0, earliestS: 0 };
    const epoch = Number(c.lastUsageEpoch!) + 1;
    const ahead = Math.max(0, epoch - Number(c.usageAnchor!) - 1);
    return { epoch, earliestS: Number(c.usageAnchorTs!) + ahead * this.epochLengthS };
  }

  private async send(what: string, ixs: Parameters<typeof sendAndConfirm>[2]): Promise<SendResult> {
    const r = await sendAndConfirm(this.rpc, this.runtimeKey, ixs, { log: this.o.log });
    this.o.onTx?.(what, r);
    return r;
  }

  /** Leaves sorted by hash (as every Lineage root); one proof per agent. */
  static tree(e: ClosedEpoch) {
    const items = e.leaves
      .filter((l) => BigInt(l.amount) > 0n)
      .map((l) => ({ l, h: usageLeaf({ epoch: e.epoch, agent: l.agent, amount: l.amount, model_tokens: l.model_tokens, sandbox_s: l.sandbox_s }) }))
      .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
    const hashes = items.map((i) => i.h);
    return { root: merkleRoot(hashes), items: items.map((i, k) => ({ ...i, proof: merkleProof(hashes, k) })) };
  }

  async post(e: ClosedEpoch, save: () => void) {
    const t = ChainBackend.tree(e);
    if (t.items.length === 0) {
      e.done = true;
      save();
      return;
    }
    e.root = t.root;
    save();
    const usagePda = launchPdas.usage(e.epoch);
    const existing = await this.rpc.getAccountInfo(usagePda);
    if (!existing) {
      const r = await this.send(`post_usage epoch ${e.epoch} root ${t.root} (${t.items.length} agents)`, [launch.postUsage({ runtimeAuthority: this.runtimeKey.id, epoch: e.epoch, root: t.root })]);
      e.post = r.signature;
      save();
    } else if (!e.post) e.post = "already-posted";
    const c = await this.config(true);
    for (const it of t.items) {
      if (e.debits[it.l.agent]) continue;
      const receipt = await this.rpc.getAccountInfo(launchPdas.debitReceipt(e.epoch, it.l.agent));
      if (receipt) {
        e.debits[it.l.agent] = "already-debited";
        save();
        continue;
      }
      const launchRec = (await this.reader.launches()).find((x) => x.agent === it.l.agent);
      if (!launchRec) throw new Error(`no AgentLaunch for ${it.l.agent}`);
      const r = await this.send(`debit_compute epoch ${e.epoch} agent ${it.l.agent} amount ${it.l.amount} (model_tokens ${it.l.model_tokens}, sandbox_s ${it.l.sandbox_s})`, [
        launch.debitCompute({
          runtimeAuthority: this.runtimeKey.id,
          epoch: e.epoch,
          agent: it.l.agent,
          agentMint: launchRec.mint,
          computeSink: c.computeSink,
          lineMint: c.lineMint,
          amount: BigInt(it.l.amount),
          modelTokens: it.l.model_tokens,
          sandboxS: it.l.sandbox_s,
          proof: it.proof.map(hexToBytes),
          lineTokenProgram: c.lineTokenProgram,
        }),
      ]);
      e.debits[it.l.agent] = r.signature;
      save();
    }
    e.done = true;
    save();
  }

  /** Permissionless `refresh_awake` when the vault crossed a threshold by a plain transfer (author rewards). */
  async refreshAwake(a: HostedAgent, v: Vault, wake: bigint, sleep: bigint) {
    const stale = (!v.awake && v.balance >= wake) || (v.awake && v.balance < sleep);
    if (!stale || !a.mint) return false;
    await this.send(`refresh_awake ${a.agent} (vault ${v.balance}, awake ${v.awake})`, [launch.refreshAwake({ agent: a.agent, agentMint: a.mint })]);
    return true;
  }
}

/**
 * Public devnet RPC answers HTTP 429 under load. The transport already retries a few times; this adds
 * a slower outer backoff (up to about two minutes) for rate limits only, so a busy endpoint delays
 * the runtime instead of failing a post half way (every post step is idempotent anyway).
 */
export function withBackoff(rpc: Rpc, log?: (m: string) => void): Rpc {
  const r = rpc as unknown as { transport: (m: string, p: unknown[]) => Promise<unknown> };
  const inner = r.transport;
  r.transport = async (method, params) => {
    for (let i = 0; ; i++) {
      try {
        return await inner(method, params);
      } catch (e) {
        if (i >= 6 || !/429|Too Many/i.test(String((e as Error).message))) throw e;
        const ms = Math.min(60_000, 5_000 * 2 ** i);
        log?.(`rpc ${method} rate limited; retrying in ${ms / 1000} s`);
        await new Promise((res) => setTimeout(res, ms));
      }
    }
  };
  return rpc;
}

export { TxError, canonicalJson };
