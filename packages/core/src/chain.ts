import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  ChainReader,
  hexToBytes,
  launchPdas,
  loadKeypair,
  registry,
  registryPdas,
  Rpc,
  sendAndConfirm,
  type Ix,
  type LaunchConfig,
  type RegistryConfig,
  type Signer,
} from "@lineage/chain";
import { bountiesOf } from "./bounties.ts";
import type { NetworkConfig } from "./config.ts";
import type { ChainAgent, Core } from "./core.ts";

// Chain mode (SPEC 14). Config: a `chain` object in the network config file (or `--chain <file>`):
//   { "mode": "devnet", "rpc_url": ..., "registry_program": ..., "launch_program": ...,
//     "line_mint": ..., "core_authority_key": "~/.config/lineage/devnet/core-authority.json" }
// `mode` "sim" or no `chain` object keeps the simulated M1 ledger. In chain mode the registry and
// launch programs are the source of truth for agents, bonds, fees and vault balances; ChainBridge
// reads them every poll and mirrors them into Core, and sends what Core decides (epoch roots,
// slashes) with the Core authority key. Every balance it exposes was read from chain at `slot`.

export interface ChainSettings {
  mode: "devnet";
  rpc_url: string;
  registry_program: string;
  launch_program: string;
  line_mint?: string;
  /** Keypair file of the registry's Core authority; without it the bridge only reads. */
  core_authority_key?: string;
  poll_ms?: number;
}

export function parseChainSettings(raw: unknown): ChainSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.mode === undefined || r.mode === "sim") return null;
  if (r.mode !== "devnet") throw new Error(`chain.mode must be "sim" or "devnet", not ${JSON.stringify(r.mode)}`);
  for (const k of ["rpc_url", "registry_program", "launch_program"]) if (typeof r[k] !== "string") throw new Error(`chain.${k} is required in chain mode`);
  return r as unknown as ChainSettings;
}

export const expandHome = (p: string) => (p.startsWith("~/") ? homedir() + p.slice(1) : p);

/** Reads `chain` from a config file (the network config, or a dedicated chain file). */
export function loadChainSettings(path: string): ChainSettings | null {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return parseChainSettings(raw.chain ?? (raw.mode ? raw : null));
}

/**
 * The network config with every value the programs hold taken from chain: amounts in the mint's
 * base units, splits, slashes and thresholds. Timing and judging values stay from the file.
 */
export function networkFromChain(base: NetworkConfig, reg: RegistryConfig, launch: LaunchConfig | null, decimals: number): NetworkConfig {
  const p = reg.params;
  return {
    ...base,
    token_decimals: decimals,
    register_burn: p.registerBurn,
    min_bond: p.minBond,
    bond_cap: p.bondCap,
    unbond_cooldown_s: Number(p.unbondCooldownS),
    reserve_bps: p.reserveBps,
    pool_bps: p.poolBps,
    canary_slash_bps: p.canarySlashBps,
    minority_slash_bps: p.minoritySlashBps,
    reveal_slash_bps: p.revealSlashBps,
    strike_limit: p.strikeLimit,
    u_replay: p.uReplay,
    u_author: p.uAuthor,
    finder_share: p.finderShareBps / 10_000,
    value_cap: p.valueCap,
    rebate_per_class: p.rebatePerClass,
    max_open_candidates_per_agent: p.maxOpenCandidatesPerAgent,
    author_reward_to: p.authorRewardTo === 1 ? "launcher" : "compute",
    quorum: p.quorum,
    ...(launch
      ? { agent_compute_bps: launch.agentComputeBps, protocol_bps: launch.protocolBps, sleep_threshold: launch.sleepThreshold, wake_threshold: launch.wakeThreshold }
      : {}),
  };
}

/** What a fresh Core in chain mode needs before it starts: chain-held parameters and the first epoch number. */
export async function chainBootstrap(base: NetworkConfig, reader: ChainReader) {
  const reg = await reader.registryConfig();
  if (!reg) throw new Error("lineage_registry is not initialized on this cluster");
  const launch = await reader.launchConfig();
  const mint = await reader.mint(reg.mint);
  if (!mint) throw new Error(`registry mint ${reg.mint} not found`);
  return {
    network: networkFromChain(base, reg, launch, mint.decimals),
    firstEpoch: reg.epochsPosted === 0n ? 0 : Number(reg.lastEpoch) + 1,
    registry: reg,
    launch,
    decimals: mint.decimals,
  };
}

export type ChainSend = (label: string, ixs: Ix[]) => Promise<{ signature: string }>;

const s = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

/**
 * The 32-byte id a slash is sent with (its SlashReceipt PDA seed): a digest of Core's slash row,
 * so every retry of one slash carries the same id and lands at most once.
 */
export function slashId(sl: { id: number; agent_id: string; reason: string; ref: string; epoch: number }): string {
  return createHash("sha256").update(JSON.stringify(["lineage-slash", sl.id, sl.agent_id, sl.reason, sl.ref, sl.epoch])).digest("hex");
}

/** Retry delay after `failures` failed sends: 5 s doubling, at most 10 minutes. */
export const backoffMs = (failures: number) => Math.min(5_000 * 2 ** Math.max(0, failures - 1), 600_000);

export class ChainBridge {
  readonly reader: ChainReader;
  private running: Promise<unknown> | null = null;
  private snapshot: Record<string, unknown> | null = null;
  private send: ChainSend | null;
  lastError: string | null = null;

  constructor(
    readonly core: Core,
    readonly settings: ChainSettings,
    opts: { reader?: ChainReader; coreKey?: Signer | null; send?: ChainSend; log?: (m: string) => void } = {},
  ) {
    this.reader = opts.reader ?? new ChainReader(Rpc.http(settings.rpc_url), settings.registry_program, settings.launch_program);
    const key = opts.coreKey === undefined ? (settings.core_authority_key ? loadKeypair(expandHome(settings.core_authority_key)) : null) : opts.coreKey;
    this.coreKeyId = key?.id ?? null;
    // the Core authority also signs reputation credentials (identity plan I2); verification never needs it
    if (key) core.issuerKey = key;
    this.send = opts.send ?? (key ? (label, ixs) => sendAndConfirm(this.reader.rpc, key, ixs, { log: (m) => this.log(`${label}: ${m}`) }) : null);
    this.log = opts.log ?? (() => undefined);
    core.chainView = () => this.snapshot;
    core.chainSync = () => this.tick(true);
  }
  readonly coreKeyId: string | null;
  private log: (m: string) => void;
  /** Failed sends by key ("slash:<id>", "epoch:<n>"): count and the earliest next attempt (Core clock, ms). */
  private retry = new Map<string, { failures: number; at: number }>();
  private due(key: string) {
    const r = this.retry.get(key);
    return !r || this.core.now() >= r.at;
  }
  private failed(key: string) {
    const failures = (this.retry.get(key)?.failures ?? 0) + 1;
    this.retry.set(key, { failures, at: this.core.now() + backoffMs(failures) });
  }
  /** The signature of a transaction that landed although its send reported an error. */
  private async landedSignature(e: unknown, account: string): Promise<string> {
    const sig = (e as { signature?: string }).signature;
    if (sig) return sig;
    try {
      const sigs = await this.reader.rpc.call<{ signature: string }[]>("getSignaturesForAddress", [account, { limit: 1000 }]);
      if (sigs.length) return sigs[sigs.length - 1]!.signature;
    } catch {
      // fall through
    }
    return `landed:${account}`;
  }

  view() {
    return this.snapshot ?? { mode: this.settings.mode, read_at: null };
  }

  /**
   * One sync: send pending slashes, mirror claims and agents, mirror vaults, post closed epochs.
   * Never overlaps itself; `fresh` waits for a sync in flight and then runs a new one, so it sees
   * everything that confirmed before the call.
   */
  async tick(fresh = false): Promise<unknown> {
    if (fresh && this.running) await this.running.catch(() => undefined);
    if (!this.running)
      this.running = this.tickInner()
        .then((v) => {
          this.lastError = null;
          return v;
        })
        .catch((e) => {
          this.lastError = (e as Error).message;
          this.log(`chain sync failed: ${this.lastError}`);
          throw e;
        })
        .finally(() => {
          this.running = null;
        });
    return this.running;
  }

  private async tickInner() {
    const reg = await this.reader.registryConfig();
    if (!reg) throw new Error("registry not initialized");
    const launchCfg = await this.reader.launchConfig();
    const tokenProgram = reg.tokenProgram;
    if (this.send && this.coreKeyId === reg.coreAuthority) await this.sendSlashes(reg.mint, tokenProgram);

    // claims made on chain for epochs Core posted (before the vault read, so a compute leaf is counted once)
    for (const { n, leaves } of this.core.chainPostedLeaves()) {
      const receipts = await this.reader.claimReceipts(n, leaves.map((l) => hexToBytes(l.leaf)));
      receipts.forEach((r, i) => {
        if (r) this.core.chainRecordClaim(n, leaves[i]!);
      });
    }

    // agents (verifiers and launched), with launched agents' AgentLaunch and compute vault
    const [agents, launches] = await Promise.all([this.reader.agents(), this.reader.launches()]);
    // Agent records the first layout wrote are grown to Agent v2 (signing key = agent key) by
    // `migrate_agent`, which anyone may send: the bridge does when it can sign, so slashes and
    // claims on those agents keep working after the registry upgrade.
    if (this.send && this.coreKeyId === reg.coreAuthority)
      for (const a of agents.filter((x) => x.version === 1)) {
        if (!this.due(`migrate:${a.agent}`)) continue;
        try {
          await this.send(`migrate_agent ${a.agent}`, [registry.migrateAgent({ payer: this.coreKeyId!, agent: a.agent })]);
          this.retry.delete(`migrate:${a.agent}`);
        } catch (e) {
          this.log(`migrate_agent ${a.agent} failed: ${(e as Error).message}`);
          this.failed(`migrate:${a.agent}`);
        }
      }
    const launchByAgent = new Map(launches.map((l) => [l.agent, l]));
    const launchedIds = agents.filter((a) => a.kind === "launched").map((a) => a.agent);
    const vaults = await this.reader.vaults(launchedIds);
    for (const a of agents) {
      const l = launchByAgent.get(a.agent);
      const rec: ChainAgent = {
        agent: a.agent, owner: a.owner, kind: a.kind, burned: a.burned, bond: a.bond, unbondAmount: a.unbondAmount, unbondReadyAt: a.unbondReadyAt,
        registeredAt: a.registeredAt, operator: a.operator, capabilities: a.capabilities,
        signingKey: a.signingKey, keySeq: a.keySeq, keyChangedAt: a.keyChangedAt, ownerSince: a.ownerSince, pendingOwner: a.pendingOwner,
        ...(l ? { launch: { mint: l.mint, launcher: l.launcher, repoUrl: l.repoUrl, identityMode: l.identityMode, hosted: l.hosted }, compute: vaults.compute[a.agent] ?? 0n } : {}),
      };
      try {
        this.core.chainSyncAgent(rec);
      } catch (e) {
        this.log(`agent ${a.agent} not mirrored: ${(e as Error).message}`);
      }
    }

    this.core.chainSetBalances({ treasury: vaults.treasury ?? 0n, reserve: vaults.reserve ?? 0n, pool: vaults.pool ?? 0n });

    // bounties (C6): mirror every Bounty account; the open signature is looked up once per new bounty
    let bountyCount = 0;
    let bountyConfig: Awaited<ReturnType<ChainReader["bountyConfig"]>> = null;
    try {
      const bs = await this.reader.bounties();
      bountyConfig = await this.reader.bountyConfig();
      const sigs = new Map<string, string | null>();
      const known = new Set(bountiesOf(this.core).list({ status: "all" }).map((b) => b.bounty_id));
      for (const b of bs.filter((x) => !known.has(x.address))) {
        const list = await this.reader.rpc.call<{ signature: string }[]>("getSignaturesForAddress", [b.address, { limit: 1000 }]).catch(() => []);
        sigs.set(b.address, list.length ? list[list.length - 1]!.signature : null);
      }
      bountiesOf(this.core).sync(bs, (a) => sigs.get(a) ?? null);
      bountyCount = bs.length;
    } catch (e) {
      this.log(`bounties not mirrored: ${(e as Error).message}`);
    }

    const posted: { n: number; signature?: string; error?: string }[] = [];
    if (this.send && this.coreKeyId === reg.coreAuthority) {
      let last = reg.epochsPosted === 0n ? -1n : reg.lastEpoch;
      for (const ep of this.core.chainPendingEpochs()) {
        if (!this.due(`epoch:${ep.n}`)) break;
        if (BigInt(ep.n) <= last) {
          const error = `epoch ${ep.n} is not after the last posted epoch ${last} on chain`;
          this.core.chainEpochResult(ep.n, { error });
          this.failed(`epoch:${ep.n}`);
          posted.push({ n: ep.n, error });
          continue;
        }
        const pool = BigInt(ep.pool_amount ?? "0");
        const rebate = BigInt(ep.rebate_amount ?? "0");
        try {
          const r = await this.send(`post_epoch ${ep.n}`, [
            registry.postEpoch({
              coreAuthority: this.coreKeyId!, mint: reg.mint, epoch: ep.n, payoutRoot: ep.root!, lineageRoot: ep.lineage_root!,
              recordRoot: ep.record_root ?? undefined,
              totalUnitsMicro: BigInt(Math.round((ep.total_units ?? 0) * 1e6)), poolAmount: pool, rebateAmount: rebate, tokenProgram,
            }),
          ]);
          this.core.chainEpochResult(ep.n, { signature: r.signature });
          this.retry.delete(`epoch:${ep.n}`);
          posted.push({ n: ep.n, signature: r.signature });
          last = BigInt(ep.n);
        } catch (e) {
          // The send may have landed although it reported an error (an expired confirmation, a
          // dropped connection): the Epoch PDA with Core's root means it did.
          const onchain = await this.reader.epoch(ep.n).catch(() => null);
          if (onchain && onchain.payoutRoot === ep.root) {
            const signature = await this.landedSignature(e, registryPdas.epoch(ep.n));
            this.core.chainEpochResult(ep.n, { signature });
            this.retry.delete(`epoch:${ep.n}`);
            posted.push({ n: ep.n, signature });
            last = BigInt(ep.n);
            continue;
          }
          const error = (e as Error).message;
          this.core.chainEpochResult(ep.n, { error });
          this.failed(`epoch:${ep.n}`);
          posted.push({ n: ep.n, error });
          break;
        }
      }
    }

    const kinds = { verifier: 0, launched: 0 };
    for (const a of agents) kinds[a.kind]++;
    this.snapshot = {
      mode: this.settings.mode,
      rpc_url: this.settings.rpc_url,
      read_at: this.core.now(),
      slot: vaults.slot,
      registry_program: this.settings.registry_program,
      launch_program: this.settings.launch_program,
      line_mint: reg.mint,
      token_program: tokenProgram,
      core_authority: reg.coreAuthority,
      core_signing: this.coreKeyId === reg.coreAuthority,
      admin: reg.admin,
      paused: reg.paused,
      epochs_posted: reg.epochsPosted.toString(),
      last_epoch: reg.epochsPosted === 0n ? null : reg.lastEpoch.toString(),
      params: { register_burn: s(reg.params.registerBurn), min_bond: s(reg.params.minBond), reserve_bps: reg.params.reserveBps, pool_bps: reg.params.poolBps,
        rebate_per_class: s(reg.params.rebatePerClass) },
      launch: launchCfg
        ? { agent_compute_bps: launchCfg.agentComputeBps, protocol_bps: launchCfg.protocolBps, sleep_threshold: s(launchCfg.sleepThreshold),
            wake_threshold: s(launchCfg.wakeThreshold), dbc_config: launchCfg.dbcConfig, migration_quote_threshold: s(launchCfg.migrationQuoteThreshold),
            compute_sink: launchCfg.computeSink, paused: launchCfg.paused }
        : null,
      balances: { treasury: s(vaults.treasury), reserve: s(vaults.reserve), pool: s(vaults.pool), payable: s(vaults.payable), bond_vault: s(vaults.bondVault) },
      vault_addresses: { treasury: registryPdas.treasury(), reserve: registryPdas.reserve(), pool: registryPdas.pool(), payable: registryPdas.payable(),
        bond_vault: registryPdas.bondVault() },
      compute: Object.fromEntries(launchedIds.map((a) => [a, { vault: launchPdas.computeVault(a), balance: s(vaults.compute[a]) }])),
      bounties: { count: bountyCount, config: bountyConfig
        ? { max_bounty_out_bps: bountyConfig.maxBountyOutBps, self_hosted_in_cap: s(bountyConfig.selfHostedInCap), window_s: bountyConfig.windowS,
            min_ttl_s: bountyConfig.minTtlS, max_ttl_s: bountyConfig.maxTtlS, refund_grace_s: bountyConfig.refundGraceS, min_amount: s(bountyConfig.minAmount),
            paused: bountyConfig.paused }
        : null },
      agents: kinds,
      agents_v1: agents.filter((a) => a.version === 1).length,
      posted_epochs: this.core.chainEpochs(),
      this_sync: { posted },
    };
    return this.snapshot;
  }

  /**
   * Sends pending slashes, each with its deterministic slash id. A slash counts as sent only once
   * it landed: on a send error the SlashReceipt PDA is read back, and a slash that did not land
   * stays pending and is retried with backoff (the receipt refuses a second landing).
   */
  private async sendSlashes(mint: string, tokenProgram: string) {
    for (const sl of this.core.chainPendingSlashes()) {
      const key = `slash:${sl.id}`;
      if (!this.due(key)) continue;
      const id = slashId(sl);
      try {
        const r = await this.send!(`slash ${sl.agent_id}`, [
          registry.slash({ coreAuthority: this.coreKeyId!, agent: sl.agent_id, mint, offence: sl.offence, epoch: sl.epoch, slashId: id, tokenProgram }),
        ]);
        this.core.chainSlashResult(sl.id, { signature: r.signature });
        this.retry.delete(key);
      } catch (e) {
        const receipt = await this.reader.slashReceipt(id).catch(() => null);
        if (receipt && receipt.agent === sl.agent_id) {
          this.core.chainSlashResult(sl.id, { signature: await this.landedSignature(e, registryPdas.slashReceipt(id)) });
          this.retry.delete(key);
          continue;
        }
        this.core.chainSlashResult(sl.id, { error: (e as Error).message });
        this.failed(key);
      }
    }
  }
}
