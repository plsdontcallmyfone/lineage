import type { Address } from "./codec.ts";
import type { Ix } from "./registry.ts";
import type { Rpc } from "./rpc.ts";
import { system } from "./spl.ts";

// Jito bundles for the mainnet launch (owner direction 2026-10-11: one approval, all or nothing).
// From Jito's docs (docs.jito.wtf/lowlatencytxnsend, read 2026-10-11): sendBundle on
// https://mainnet.block-engine.jito.wtf/api/v1/bundles takes [[signed txs], {"encoding": "base64"}],
// at most 5 transactions, executed in order in one slot, all or nothing; a tip of at least 1,000
// lamports is a SOL transfer to one of the tip accounts from getTipAccounts (picked at random, never
// through a lookup table, best inside the main transaction); getInflightBundleStatuses reports
// Invalid, Pending, Failed or Landed for the last 5 minutes; default rate 1 request per second per IP.
// The page reaches the block engine through the web server's /chain/rpc proxy (apps/web/chain-routes.ts),
// which forwards these methods on mainnet only.

export const JITO_MIN_TIP = 1_000n;
export const JITO_MAX_TXS = 5;
export const JITO_METHODS = ["sendBundle", "getTipAccounts", "getInflightBundleStatuses", "getBundleStatuses"] as const;
export const JITO_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
/** Jito's public tip floor (SOL per landed bundle, percentiles), read by the web server. */
export const JITO_TIP_FLOOR = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";

/** The tip: a System transfer to one tip account picked at random. */
export function jitoTipIx(payer: Address, tipAccounts: Address[], lamports: bigint, pick: () => number = Math.random): Ix {
  if (!tipAccounts.length) throw new Error("no Jito tip accounts");
  if (lamports < JITO_MIN_TIP) throw new Error(`a Jito tip is at least ${JITO_MIN_TIP} lamports`);
  return system.transfer(payer, tipAccounts[Math.floor(pick() * tipAccounts.length) % tipAccounts.length]!, lamports);
}

/** Lamports from the tip floor answer: the EMA of the landed 50th percentile, never below the minimum. */
export function tipFromFloor(floor: unknown): bigint {
  const row = Array.isArray(floor) ? floor[0] : null;
  const sol = row && typeof row === "object" ? (row as Record<string, unknown>).ema_landed_tips_50th_percentile ?? (row as Record<string, unknown>).landed_tips_50th_percentile : null;
  if (typeof sol !== "number" || !Number.isFinite(sol) || sol <= 0) return JITO_MIN_TIP;
  const l = BigInt(Math.ceil(sol * 1e9));
  return l < JITO_MIN_TIP ? JITO_MIN_TIP : l;
}

export type BundleState = "Invalid" | "Pending" | "Failed" | "Landed";

/** Sends signed transactions as one bundle and waits until it lands or fails. Throws on Invalid or Failed (nothing was committed). */
export async function sendJitoBundle(rpc: Rpc, wires: string[], o: { onStatus?: (s: string) => void; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ bundleId: string; slot: number | null }> {
  if (!wires.length || wires.length > JITO_MAX_TXS) throw new Error(`a bundle holds 1 to ${JITO_MAX_TXS} transactions, not ${wires.length}`);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const bundleId = await rpc.call<string>("sendBundle", [wires, { encoding: "base64" }]);
  o.onStatus?.(`bundle ${bundleId.slice(0, 8)}… sent to Jito; waiting for it to land`);
  const until = Date.now() + (o.timeoutMs ?? 90_000);
  while (Date.now() < until) {
    await sleep(2_000);
    const r = await rpc.call<{ value: { bundle_id: string; status: BundleState; landed_slot: number | null }[] } | null>("getInflightBundleStatuses", [[bundleId]]).catch(() => null);
    const s = r?.value?.[0];
    if (!s) continue;
    if (s.status === "Landed") return { bundleId, slot: s.landed_slot };
    if (s.status === "Failed" || s.status === "Invalid") throw new Error(`the Jito bundle ${s.status === "Failed" ? "failed" : "was refused as invalid"}; nothing was committed`);
  }
  throw new Error("the Jito bundle has not landed in time; nothing was committed unless its transactions show on chain later");
}
