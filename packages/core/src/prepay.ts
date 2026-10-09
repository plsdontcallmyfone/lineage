import { base58Decode } from "@lineage/protocol";
import { ixDisc, LAUNCH_PROGRAM_ID, launchPdas, usdToBase, type AgentLaunch, type PrepayConfig, type Rpc } from "@lineage/chain";
import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import { ACC } from "./ledger.ts";

// Prepaid credits at launch (plan C, owner decision 2026-10-09). A launch carries a deposit into the
// agent's compute vault and the permissionless refresh_awake in the same transaction, so the agent
// starts working at once. The minimum is `prepay.min_usd` in the network config (admin-editable,
// converted at `prepay.line_per_usd`, a TEST rate on devnet). lineage_launch does not enforce it
// (no program change), so the wallet and Core do:
//   - simulated mode: POST /v1/admin/launches with `deposit` below the minimum is refused;
//   - chain mode: for every launch created at or after `prepay.since` Core reads the launch
//     transaction once, records its deposit, and an agent whose deposit fell short stays asleep in
//     Core until its compute vault holds at least the minimum (its effective wake threshold is
//     max(wake_threshold, minimum)). Core refuses an asleep agent's commits, and hosted workers check
//     Core before any model spend.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prepay (
  agent_id TEXT PRIMARY KEY,
  mint TEXT,
  launched_at INTEGER,
  signature TEXT,
  deposit TEXT NOT NULL,
  min TEXT NOT NULL,
  ok INTEGER NOT NULL,
  woke INTEGER NOT NULL,
  source TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);`;

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  ledger: Core["ledger"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
}

export interface PrepayRow {
  agent_id: string;
  mint: string | null;
  launched_at: number | null;
  signature: string | null;
  deposit: string;
  min: string;
  ok: number;
  woke: number;
  source: "chain" | "sim";
  checked_at: number;
}

const instances = new WeakMap<Core, Prepay>();
export function prepayOf(core: Core): Prepay {
  let p = instances.get(core);
  if (!p) instances.set(core, (p = new Prepay(core)));
  return p;
}

const REFRESH = ixDisc("refresh_awake");

export class Prepay {
  private readonly c: Internals;
  /** launch transactions that could not be read yet (retried next sync) */
  private misses = new Map<string, number>();
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  config(): PrepayConfig | null {
    return (this.c.cfg as { prepay?: PrepayConfig | null }).prepay ?? null;
  }

  /** The minimum deposit in base units, or null without a prepay config. */
  minBase(): bigint | null {
    const p = this.config();
    return p ? usdToBase(p.min_usd, p.line_per_usd, this.c.cfg.token_decimals) : null;
  }

  row(agent: string): PrepayRow | null {
    return this.c.db.query<PrepayRow, [string]>("SELECT * FROM prepay WHERE agent_id = ?").get(agent);
  }

  /** GET /v1/agents/:id/prepay */
  view(agent: string) {
    const p = this.config();
    const r = this.row(agent);
    return {
      agent,
      config: p ? { ...p, min_base_units: this.minBase()!.toString() } : null,
      checked: !!r,
      deposit: r?.deposit ?? null,
      min: r?.min ?? null,
      ok: r ? !!r.ok : null,
      woke_in_launch_tx: r ? !!r.woke : null,
      signature: r?.signature ?? null,
      source: r?.source ?? null,
      launched_at: r?.launched_at ?? null,
    };
  }

  /** The wake threshold Core applies to `agent`: raised to the minimum for an underfunded launch. */
  wakeThreshold(agent: string, base: bigint): bigint {
    const r = this.row(agent);
    if (!r || r.ok) return base;
    const m = BigInt(r.min);
    return m > base ? m : base;
  }

  /** Simulated mode: refuses a deposit below the minimum (called before the launch is recorded). */
  checkSimDeposit(deposit: bigint) {
    const m = this.minBase();
    if (m !== null && deposit < m) {
      throw bad("deposit_below_minimum", `deposit ${deposit} is below the minimum ${m} base units (prepay.min_usd ${this.config()!.min_usd} USD at ${this.config()!.line_per_usd} $LINE per USD)`);
    }
  }

  /** Records a launch's deposit; an underfunded agent that is awake below the minimum is put to sleep. Inside the caller's transaction. */
  record(agent: string, o: { mint: string | null; launchedAt: number | null; signature: string | null; deposit: bigint; woke: boolean; source: "chain" | "sim" }) {
    const min = this.minBase() ?? 0n;
    const ok = o.deposit >= min;
    this.c.db
      .query("INSERT OR REPLACE INTO prepay (agent_id, mint, launched_at, signature, deposit, min, ok, woke, source, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(agent, o.mint, o.launchedAt, o.signature, o.deposit.toString(), min.toString(), ok ? 1 : 0, o.woke ? 1 : 0, o.source, this.c.now());
    this.c.emitEvent("agent.prepay", { agent, deposit: o.deposit.toString(), min: min.toString(), ok, woke: o.woke, signature: o.signature });
    if (!ok) {
      const bal = this.c.ledger.balance(ACC.compute(agent));
      const a = this.c.db.query<{ awake: number }, [string]>("SELECT awake FROM agents WHERE agent_id = ?").get(agent);
      if (a?.awake && bal < min) {
        this.c.db.query("UPDATE agents SET awake = 0 WHERE agent_id = ?").run(agent);
        this.c.emitEvent("agent.asleep", { agent, compute: bal.toString(), reason: "prepay_below_minimum" });
      }
    }
  }

  /**
   * Chain mode: reads the launch transaction of every launch created at or after `since` that has no
   * record yet (oldest signature of its AgentLaunch account), and records the compute vault's balance
   * after it (the vault is created by that transaction, so this is the deposit) and whether it ran
   * refresh_awake. Returns how many it recorded.
   */
  async syncChain(rpc: Rpc, launches: AgentLaunch[], tx: <T>(fn: () => T) => T, log: (m: string) => void = () => {}): Promise<number> {
    const p = this.config();
    if (!p) return 0;
    let n = 0;
    for (const l of launches) {
      if (Number(l.createdAt) < p.since || this.row(l.agent)) continue;
      if (!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(l.agent)) continue; // mirrored first
      const tries = this.misses.get(l.agent) ?? 0;
      if (tries >= 5) continue;
      try {
        const got = await readLaunchDeposit(rpc, l);
        if (!got) {
          this.misses.set(l.agent, tries + 1);
          continue;
        }
        tx(() => this.record(l.agent, { mint: l.mint, launchedAt: Number(l.createdAt), signature: got.signature, deposit: got.deposit, woke: got.woke, source: "chain" }));
        this.misses.delete(l.agent);
        n++;
      } catch (e) {
        this.misses.set(l.agent, tries + 1);
        log(`prepay: launch of ${l.agent} not read: ${(e as Error).message}`);
      }
    }
    return n;
  }
}

interface TxJson {
  transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
  meta: { err: unknown; postTokenBalances?: { accountIndex: number; mint: string; uiTokenAmount: { amount: string } }[]; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
}

/** The deposit and refresh_awake of one launch, read from its transaction (legacy or v0). */
export async function readLaunchDeposit(rpc: Rpc, l: AgentLaunch): Promise<{ signature: string; deposit: bigint; woke: boolean } | null> {
  const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [launchPdas.agentLaunch(l.mint), { limit: 1000, commitment: "confirmed" }]);
  const ok = sigs.filter((s) => !s.err);
  if (!ok.length) return null;
  const signature = ok[ok.length - 1]!.signature;
  const t = await rpc.call<TxJson | null>("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!t?.meta || t.meta.err) return null;
  const keys = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
  const vault = launchPdas.computeVault(l.agent);
  const vi = keys.indexOf(vault);
  const bal = (t.meta.postTokenBalances ?? []).find((b) => b.accountIndex === vi);
  const deposit = bal ? BigInt(bal.uiTokenAmount.amount) : 0n;
  const agentLaunch = launchPdas.agentLaunch(l.mint);
  const woke = t.transaction.message.instructions.some((ix) => {
    if (keys[ix.programIdIndex] !== LAUNCH_PROGRAM_ID) return false;
    const d = base58Decode(ix.data);
    return d.length === 8 && REFRESH.every((b, i) => d[i] === b) && keys[ix.accounts[1]!] === agentLaunch;
  });
  return { signature, deposit, woke };
}

