import type { Address } from "./codec.ts";
import type { Ix } from "./registry.ts";
import type { Rpc } from "./rpc.ts";
import type { ConfirmPolicy, FeePolicy } from "./profile.ts";

// Priority fees and confirmation for mainnet sends (M3, SPEC 14.10). Browser-safe, no timers of its
// own beyond the injectable `sleep`, so the tests drive it with a mock RPC and a fake clock.
//
// Fee: getRecentPrioritizationFees over the transaction's writable accounts (the RPC answers the
// per-slot minimum fee that landed a transaction locking all of them, for the last 150 slots); the
// configured percentile of those values, never below the floor and never above the cap. A profile
// with a fixed price (devnet: 1 micro-lamport, as before) skips the read.
//
// Confirmation: send once with preflight (a program error comes back before anything is paid), then
// poll statuses and rebroadcast the same signed bytes every resend_ms (skipPreflight) until it is
// confirmed, lands with an error (reported, never resent), or the block height passes the
// blockhash's lastValidBlockHeight. On expiry the status is read once more with history search (it
// may have landed in the last blocks); only when it is still unknown is it reported as expired,
// which is safe to rebuild: an expired blockhash can never land later.

export interface PriorityFee {
  microLamports: number;
  /** "fixed" (profile price), "recent" (from the RPC), "floor" (no samples or all below the floor) */
  source: "fixed" | "recent" | "floor";
  samples: number;
  /** the percentile value before the cap, when it was cut */
  cappedFrom?: number;
}

/** Writable account keys of a set of instructions (what getRecentPrioritizationFees should look at). */
export function writableAccounts(ixs: Ix[], payer?: Address): Address[] {
  const s = new Set<Address>(payer ? [payer] : []);
  for (const ix of ixs) for (const k of ix.keys) if (k.isWritable) s.add(k.pubkey);
  // the RPC accepts at most 128 accounts
  return [...s].slice(0, 128);
}

/** The value at `pct` (1..100, nearest rank) of `xs`. */
export function percentile(xs: number[], pct: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((pct / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1]!;
}

/** The compute unit price for a transaction touching `accounts`, under `policy`. */
export async function priorityFee(rpc: Rpc, accounts: Address[], policy: FeePolicy): Promise<PriorityFee> {
  if (policy.mode === "fixed") return { microLamports: policy.cu_price_micro_lamports, source: "fixed", samples: 0 };
  const rows = await rpc.call<{ slot: number; prioritizationFee: number }[]>("getRecentPrioritizationFees", [accounts]);
  const vals = (rows ?? []).map((r) => Number(r.prioritizationFee)).filter((v) => Number.isFinite(v) && v >= 0);
  const p = percentile(vals, policy.percentile);
  if (!vals.length || p <= policy.floor_micro_lamports) return { microLamports: policy.floor_micro_lamports, source: "floor", samples: vals.length };
  if (p > policy.cap_micro_lamports) return { microLamports: policy.cap_micro_lamports, source: "recent", samples: vals.length, cappedFrom: p };
  return { microLamports: p, source: "recent", samples: vals.length };
}

export class BlockhashExpiredError extends Error {
  constructor(readonly signature: string) {
    super(`blockhash expired before ${signature} landed; nothing was charged`);
  }
}

export interface Landed {
  signature: string;
  slot: number;
  fee?: number;
  err: unknown;
  logs: string[];
  /** times the signed bytes were sent (first send included) */
  sends: number;
}

export interface ConfirmDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onStatus?: (s: string) => void;
}

const b64 = (u: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
/** The first signature of a wire transaction (its id). */
export function firstSignature(wire: Uint8Array): string {
  if (wire[0]! < 1 || wire[0]! > 127) throw new Error("wire transaction without a signature slot");
  return b58(wire.subarray(1, 65));
}

/**
 * Sends a fully signed wire transaction and waits for it under `policy` (see the header). Throws
 * BlockhashExpiredError when it can no longer land; a transaction that lands with an error is returned
 * with `err` set, never resent.
 */
export async function sendAndConfirmWire(rpc: Rpc, wire: Uint8Array, lastValidBlockHeight: number, policy: ConfirmPolicy, deps: ConfirmDeps = {}): Promise<Landed> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const signature = firstSignature(wire);
  const enc = b64(wire);
  const send = (preflight: boolean) =>
    rpc.call<string>("sendTransaction", [enc, { encoding: "base64", skipPreflight: !preflight, preflightCommitment: rpc.commitment, maxRetries: 0 }]);
  await send(true);
  let sends = 1;
  deps.onStatus?.(`sent ${signature}`);
  let last = now();
  const landed = async (st: { err: unknown; slot: number }): Promise<Landed> => {
    const t = await rpc.getTransaction(signature).catch(() => null);
    return { signature, slot: st.slot, fee: t?.meta?.fee, err: st.err, logs: t?.meta?.logMessages ?? [], sends };
  };
  for (;;) {
    await sleep(policy.poll_ms);
    const [st] = await rpc.getSignatureStatuses([signature]);
    if (st && (st.err || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return landed(st);
    if (!st && (await rpc.getBlockHeight()) > lastValidBlockHeight) {
      const [late] = await rpc.getSignatureStatuses([signature]);
      if (late) continue; // seen in the last blocks: keep polling until it confirms
      throw new BlockhashExpiredError(signature);
    }
    if (now() - last >= policy.resend_ms) {
      await send(false).catch(() => undefined);
      sends++;
      last = now();
      deps.onStatus?.(`waiting for confirmation of ${signature} (sent ${sends} times)`);
    }
  }
}

/**
 * Signs and sends with rebuilds: `attempt()` builds a fresh blockhash and returns the signed wire
 * (a wallet asks the person again); on BlockhashExpiredError it is called again, at most
 * `policy.rebuilds` more times.
 */
export async function sendWithRebuilds(rpc: Rpc, attempt: (n: number) => Promise<{ wire: Uint8Array; lastValidBlockHeight: number }>, policy: ConfirmPolicy, deps: ConfirmDeps = {}): Promise<Landed> {
  for (let n = 0; ; n++) {
    const { wire, lastValidBlockHeight } = await attempt(n);
    try {
      return await sendAndConfirmWire(rpc, wire, lastValidBlockHeight, policy, deps);
    } catch (e) {
      if (!(e instanceof BlockhashExpiredError) || n >= policy.rebuilds) throw e;
      deps.onStatus?.(`${e.message}; building again with a fresh blockhash (${n + 1} of ${policy.rebuilds})`);
    }
  }
}
