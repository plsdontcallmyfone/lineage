import { base58Decode } from "@units/protocol";
import type { Address } from "./codec.ts";
import type { AgentLaunch } from "./launch.ts";
import { pumpGraduateIxs } from "./pump-launch.ts";
import { curveMigrated, decodeBondingCurve, decodePumpEvent, decodePumpPool, PUMP, pumpPdas, type BondingCurve, type PumpPool } from "./pump.ts";
import type { Ix } from "./registry.ts";
import type { AccountInfo, Rpc } from "./rpc.ts";

// Where an agent coin stands between its bonding curve and its PumpSwap pool, and the one step that
// moves it on (scripts/mainnet/graduate.ts, the graduation keeper). Four states, each read from
// chain, none remembered anywhere:
//
//   curve                the curve takes trades
//   awaiting_migration   the curve is complete (every trade on it fails, BondingCurveComplete) and
//                        its PumpSwap pool does not exist yet: pump.fun's migrate_v2 makes it.
//                        Permissionless; pump.fun's own keeper normally sends it within seconds
//   migrated             the pool exists, units_launch has not recorded it: record_pump_graduation
//                        (permissionless) sets AgentLaunch.graduated and pump_pool
//   recorded             nothing left to do, for good
//
// The step is decided from the state alone, so a run that stops anywhere is resumed by the next one,
// and a step somebody else sent first (pump.fun's keeper, a trader, another run) is simply found done.

export type GraduationState = "curve" | "awaiting_migration" | "migrated" | "recorded";

export interface GraduationReading {
  state: GraduationState;
  /** The canonical PumpSwap pool of the coin quoted in the quote coin (its address whether or not it exists yet). */
  pool: Address;
  curve: BondingCurve | null;
  poolData: PumpPool | null;
}

/** Thrown for a coin the keeper must not touch: not a pump.fun launch, or accounts that are not what the launch program will accept. */
export class GraduationRefused extends Error {}

/**
 * The state of one coin from its three accounts. `curve` and `pool` are the accounts at
 * `launch.bondingCurve` and at the canonical pool address (null when absent). Pure. The pool is
 * checked the way record_pump_graduation checks it (owner PumpSwap, index 0, creator = Pump's pool
 * authority of the mint, base = the coin, quote = the quote coin), so a state of "migrated" means
 * the record will be accepted.
 */
export function graduationState(launch: Pick<AgentLaunch, "venue" | "mint" | "graduated" | "bondingCurve">, lineMint: Address,
  curve: Pick<AccountInfo, "owner" | "data"> | null, pool: Pick<AccountInfo, "owner" | "data"> | null): GraduationReading {
  if (launch.venue !== "pump") throw new GraduationRefused("not a pump.fun launch");
  const poolAt = pumpPdas.pool(launch.mint, lineMint);
  if (launch.bondingCurve !== pumpPdas.bondingCurve(launch.mint)) throw new GraduationRefused("the recorded curve is not pump.fun's curve of this mint");
  if (launch.graduated) return { state: "recorded", pool: poolAt, curve: null, poolData: null };
  if (!curve || curve.owner !== PUMP.program) throw new GraduationRefused("no pump.fun bonding curve at the recorded address");
  const c = decodeBondingCurve(curve.data);
  if (pool) {
    if (pool.owner !== PUMP.amm) throw new GraduationRefused("the account at the pool's address is not owned by PumpSwap");
    const p = decodePumpPool(pool.data);
    if (p.index !== 0 || p.creator !== pumpPdas.poolAuthority(launch.mint) || p.baseMint !== launch.mint || p.quoteMint !== lineMint)
      throw new GraduationRefused("the pool is not the canonical pool of this coin and the quote coin");
    if (!c.complete) throw new GraduationRefused("a pool exists while the curve is not complete");
    return { state: "migrated", pool: poolAt, curve: c, poolData: p };
  }
  if (!c.complete) return { state: "curve", pool: poolAt, curve: c, poolData: null };
  if (curveMigrated(c)) throw new GraduationRefused("the curve says it migrated and the canonical pool is not there");
  return { state: "awaiting_migration", pool: poolAt, curve: c, poolData: null };
}

export type GraduationStep =
  | { kind: "none"; why: string }
  | { kind: "wait"; why: string }
  | { kind: "record"; why: string }
  | { kind: "migrate"; why: string };

export interface GraduationPolicy {
  /** false: never send pump.fun's migration, only record once somebody did. */
  migrate: boolean;
  /** Seconds after completion before this keeper sends the migration itself (pump.fun's keeper comes first). */
  migrateAfterS: number;
  /** Pump Global.enable_migrate. */
  enableMigrate: boolean;
  /** Unix seconds the curve completed at, or null when it could not be found (then it is treated as long ago). */
  completedAt: number | null;
  now: number;
}

/** The one step to take now for a coin in `state`. Pure. */
export function graduationStep(state: GraduationState, p: GraduationPolicy): GraduationStep {
  if (state === "curve") return { kind: "none", why: "on its curve" };
  if (state === "recorded") return { kind: "none", why: "graduation recorded" };
  if (state === "migrated") return { kind: "record", why: "its pool exists and the launch program has not recorded it" };
  if (!p.migrate) return { kind: "wait", why: "its curve is complete; waiting for pump.fun's migration (this keeper is set not to send it)" };
  if (!p.enableMigrate) return { kind: "wait", why: "its curve is complete; pump.fun has migrations switched off (Global.enable_migrate)" };
  const age = p.completedAt === null ? null : p.now - p.completedAt;
  if (age !== null && age < p.migrateAfterS)
    return { kind: "wait", why: `its curve completed ${Math.max(0, age)} s ago; pump.fun's own keeper is given ${p.migrateAfterS} s before this one sends the migration` };
  return { kind: "migrate", why: `its curve is complete${age === null ? "" : ` since ${age} s`} and its pool does not exist` };
}

/**
 * The instructions of a step: pump.fun's migrate_v2 followed by record_pump_graduation in one
 * transaction (so a migration this keeper pays for is recorded in the same breath), or the record
 * alone. The only signer is `payer`.
 */
export function graduationIxs(step: "migrate" | "record", a: { payer: Address; agentMint: Address; lineMint: Address; withdrawAuthority: Address; lineTokenProgram?: Address }): Ix[] {
  return pumpGraduateIxs({ ...a, migrated: step === "record" });
}

interface SigRow { signature: string; err: unknown; blockTime?: number | null }
interface TxRow { meta: { innerInstructions?: { instructions: { data: string }[] }[] } | null }

/**
 * When the curve completed: the block time of the newest successful transaction on the curve that
 * carries pump.fun's CompleteEvent, looking at most `limit` signatures back. null when none is found
 * there (a curve that has been busy since, which only its sweeps can make it) or the time is unknown.
 */
export async function curveCompletedAt(rpc: Rpc, curve: Address, limit = 40): Promise<number | null> {
  const sigs = await rpc.call<SigRow[]>("getSignaturesForAddress", [curve, { limit, commitment: "confirmed" }]);
  for (const s of sigs) {
    if (s.err) continue;
    let t: TxRow | null = null;
    // mainnet carries version 1 transactions: ask for them, and fall back for an RPC that does not know the number
    for (const v of [1, 0]) {
      try {
        t = await rpc.call<TxRow | null>("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: v }]);
        break;
      } catch (e) {
        if (v === 0) throw e;
      }
    }
    for (const g of t?.meta?.innerInstructions ?? []) for (const i of g.instructions) {
      let ev;
      try {
        ev = decodePumpEvent(base58Decode(i.data));
      } catch {
        continue;
      }
      if (ev?.name === "CompleteEvent") return typeof s.blockTime === "number" ? s.blockTime : null;
    }
  }
  return null;
}

/**
 * The chain's own clock in unix seconds: the block time of the newest confirmed slot that has one.
 * Ages of chain events are measured against this, not against the machine's clock (a server clock
 * that is off would otherwise shorten or lengthen the keeper's wait). The machine's clock only when
 * the RPC gives no block time.
 */
export async function chainTime(rpc: Rpc): Promise<number> {
  try {
    const slot = await rpc.getSlot();
    for (const s of [slot, slot - 1, slot - 2]) {
      const t = await rpc.call<number | null>("getBlockTime", [s]).catch(() => null);
      if (typeof t === "number") return t;
    }
  } catch {
    /* fall through */
  }
  return Math.floor(Date.now() / 1000);
}
