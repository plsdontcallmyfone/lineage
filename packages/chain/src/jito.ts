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
// Status values, read again 2026-10-12 after the first mainnet launch: "Invalid: Bundle ID not in our
// system (5 minute look back)", "Pending: Not failed, not landed, not invalid", "Failed: All regions
// that have received the bundle have marked it as failed and it hasn't been forwarded", "Landed:
// Landed on-chain"; sendBundle's id means "the bundle has been received", not that it will land. The
// docs give no time after sendBundle at which a status exists, and that launch read Invalid 2 s after
// submission. So Invalid, or no answer (the status calls of every visitor share this server's address
// and Jito's 1 request per second), is not a refusal: it is tolerated for JITO_INVALID_GRACE_MS, and
// whether the bundle landed is always also read from the chain by the transactions' own signatures.
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
/** How long "Invalid" or no status answer after sendBundle is waited out before the ordered sends take over. */
export const JITO_INVALID_GRACE_MS = 15_000;
export const JITO_POLL_MS = 2_000;

export interface SigStatus { slot: number; err: unknown; confirmationStatus?: string }
const onChain = (s: SigStatus | null | undefined) => !!s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");

/**
 * Sends signed transactions as one bundle and waits until it lands. Throws when it failed, when Jito
 * still does not know it after `invalidGraceMs`, or at `timeoutMs`; the message says nothing was
 * committed only when the chain agrees. With `signatures` (each transaction's own, in order) the chain
 * is read at every poll and once more before any throw: a bundle whose transactions are all on chain
 * has landed whatever the block engine answers, so a late landing is never reported as a refusal.
 */
export async function sendJitoBundle(
  rpc: Rpc,
  wires: string[],
  o: { onStatus?: (s: string) => void; timeoutMs?: number; invalidGraceMs?: number; pollMs?: number; signatures?: string[]; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ bundleId: string; slot: number | null }> {
  if (!wires.length || wires.length > JITO_MAX_TXS) throw new Error(`a bundle holds 1 to ${JITO_MAX_TXS} transactions, not ${wires.length}`);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const grace = o.invalidGraceMs ?? JITO_INVALID_GRACE_MS;
  const bundleId = await rpc.call<string>("sendBundle", [wires, { encoding: "base64" }]);
  const sent = now();
  o.onStatus?.(`bundle ${bundleId.slice(0, 8)}… sent to Jito; waiting for it to land`);
  /** the slot when every transaction of the bundle is on chain without an error, else null */
  const landedOnChain = async (): Promise<number | null> => {
    if (!o.signatures?.length) return null;
    const st = await rpc.call<{ value: (SigStatus | null)[] }>("getSignatureStatuses", [o.signatures]).catch(() => null);
    const v = st?.value ?? [];
    return v.length === o.signatures.length && v.every((x) => onChain(x) && !x!.err) ? v[v.length - 1]!.slot : null;
  };
  const giveUp = async (why: string): Promise<{ bundleId: string; slot: number | null }> => {
    const slot = await landedOnChain();
    if (slot !== null) return { bundleId, slot };
    throw new Error(why);
  };
  const until = sent + (o.timeoutMs ?? 90_000);
  let known = false;
  while (now() < until) {
    await sleep(o.pollMs ?? JITO_POLL_MS);
    const r = await rpc.call<{ value: { bundle_id: string; status: BundleState; landed_slot: number | null }[] } | null>("getInflightBundleStatuses", [[bundleId]]).catch(() => null);
    const s = r?.value?.[0];
    if (s?.status === "Landed") return { bundleId, slot: s.landed_slot };
    if (s?.status === "Failed") return giveUp("the Jito bundle failed; nothing was committed");
    if (s?.status === "Pending") {
      if (!known) o.onStatus?.(`bundle ${bundleId.slice(0, 8)}… is pending at Jito`);
      known = true;
    }
    const slot = await landedOnChain();
    if (slot !== null) return { bundleId, slot };
    // Invalid (Jito does not know the id yet) or no answer: waited out for the grace time, counted from the submission
    if (!known && now() - sent >= grace) return giveUp(`Jito still does not know the bundle ${Math.round((now() - sent) / 1000)} s after it was sent; none of its transactions is on chain`);
  }
  return giveUp("the Jito bundle has not landed in time; none of its transactions is on chain yet");
}

/**
 * The same signed transactions, one by one, in order (devnet always; mainnet after a bundle that did
 * not land). After a bundle (`afterBundle`) every transaction is looked up by its signature before it
 * is sent, again when its simulation fails and again when its send fails: a bundle that lands late
 * puts the very same signatures on chain, so such a transaction is counted as landed and never
 * reported as failed. (The bytes are identical, so the chain itself cannot run one twice.)
 */
export async function sendInOrder<C extends { err: unknown; logs?: string[] }>(o: {
  count: number;
  signature: (i: number) => string;
  label: (i: number) => string;
  afterBundle: boolean;
  statuses: (signatures: string[]) => Promise<(SigStatus | null)[]>;
  /** optional: the transaction simulated on the state the earlier ones left (asked for every transaction but the first). The launch page passes none: its sends go through the node's preflight instead. */
  simulate?: (i: number) => Promise<{ err: unknown; logs?: string[] }>;
  /** sends and confirms; a thrown error is a failure of this transaction */
  send: (i: number) => Promise<C>;
  /** the confirmation of a transaction found on chain by its signature */
  found: (i: number, s: SigStatus) => C;
  skip?: (i: number) => Promise<boolean>;
  onStatus?: (s: string) => void;
}): Promise<{ landed: { index: number; label: string; confirmed: C }[]; failed: { index: number; label: string; error: string; logs?: string[] } | null }> {
  const landed: { index: number; label: string; confirmed: C }[] = [];
  const already = async (i: number): Promise<SigStatus | null> => {
    if (!o.afterBundle) return null;
    const [s] = await o.statuses([o.signature(i)]).catch(() => [null]);
    return onChain(s) ? s! : null;
  };
  for (let i = 0; i < o.count; i++) {
    const label = o.label(i);
    if (await o.skip?.(i)) continue;
    const take = (s: SigStatus): { index: number; label: string; error: string } | null => {
      if (s.err) return { index: i, label, error: `failed on chain: ${JSON.stringify(s.err)}` };
      landed.push({ index: i, label, confirmed: o.found(i, s) });
      return null;
    };
    const was = await already(i);
    if (was) {
      const bad = take(was);
      if (bad) return { landed, failed: bad };
      continue;
    }
    if (i > 0 && o.simulate) {
      const sim = await o.simulate(i);
      if (sim.err) {
        const late = await already(i);
        if (!late) return { landed, failed: { index: i, label, error: `simulation failed: ${JSON.stringify(sim.err)}; not sent`, logs: sim.logs } };
        const bad = take(late);
        if (bad) return { landed, failed: bad };
        continue;
      }
    }
    o.onStatus?.(`sending ${label} (${i + 1} of ${o.count})${o.afterBundle ? ", in order after Jito did not take the bundle" : ""}`);
    let c: C | null = null;
    let thrown: string | null = null;
    let thrownLogs: string[] | undefined;
    let unsent = false;
    try {
      c = await o.send(i);
    } catch (e) {
      thrown = (e as Error).message;
      // a node's preflight refusal: the transaction never went out (client.ts PreflightRefused)
      unsent = (e as { unsent?: unknown }).unsent === true;
      thrownLogs = Array.isArray((e as { logs?: unknown }).logs) ? ((e as { logs: string[] }).logs) : undefined;
    }
    if (!c || c.err) {
      const late = await already(i);
      if (late && !late.err) {
        landed.push({ index: i, label, confirmed: o.found(i, late) });
        continue;
      }
      const err = c ? c.err : thrown;
      if (!c && unsent) return { landed, failed: { index: i, label, error: String(thrown), logs: thrownLogs } };
      return { landed, failed: { index: i, label, error: `failed on chain: ${typeof err === "string" ? err : JSON.stringify(err)}`, logs: c?.logs } };
    }
    landed.push({ index: i, label, confirmed: c });
  }
  return { landed, failed: null };
}
