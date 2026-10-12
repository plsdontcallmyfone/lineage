import { readFileSync } from "node:fs";
import { base58Decode } from "@units/protocol";
import type { Address } from "@units/chain";
import type { FeePolicy } from "../../chain/src/profile.ts";

// The $UNITS fee keeper's configuration (owner decision 2026-10-12: "50% of creator fees goes to
// paying for compute and 50% buyback and burns"). Every value is the owner's to set and to change:
// nothing here has a default, so a missing field is an error, never a guess. Public values only; the
// signing key is a file named by `key_path` and the RPC URL may come from UNITS_FEE_KEEPER_RPC
// instead (a keyed URL is a secret and is never printed).

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Hard ceiling on `slippage_bps`: a config above it is refused whatever the owner wrote. */
export const MAX_SLIPPAGE_BPS = 1000;

export interface KeeperConfig {
  /** Mainnet sends need this true AND the `--send` flag. Ignored on any other cluster. */
  enabled: boolean;
  /** JSON-RPC endpoint; null when it comes from UNITS_FEE_KEEPER_RPC. */
  rpc_url: string | null;
  /** The $UNITS mint (a SOL-paired pump.fun coin). */
  mint: Address;
  /** The wallet that created the coin: pump.fun pays its creator fees to this address. */
  creator: Address;
  /** Solana CLI keypair file of `creator`. Null: dry runs only. */
  key_path: string | null;
  /** Where the compute share is sent, as SOL. */
  compute_address: Address;
  /** Share of each collection that funds compute, in basis points. */
  compute_bps: number;
  /** Share of each collection that buys $UNITS and burns it. compute_bps + burn_bps = 10000. */
  burn_bps: number;
  /**
   * The float kept in the creator wallet out of collected fees for the keeper's own transaction fees
   * and one-off account rent: each collection refills it to this level before the split.
   */
  fee_reserve_lamports: bigint;
  /** A collection is sent only when it brings at least this much to the wallet after its own cost. */
  min_collect_lamports: bigint;
  /** A buyback is sent only for at least this much SOL. */
  min_buyback_lamports: bigint;
  /** Most SOL one buyback transaction may spend; a larger amount is spread over the next runs. */
  max_buyback_lamports: bigint;
  /** A buy pays at most this much above the price read from chain right before sending. */
  slippage_bps: number;
  /** Priority fee: the percentile of recent fees on the accounts the transaction writes, never above the cap. */
  priority_fee: Extract<FeePolicy, { mode: "recent" }>;
  /** Seconds to wait for a sent transaction before the run ends and the next one picks it up. */
  confirm_timeout_s: number;
  /** The keeper's private state (what is owed, the transaction in flight). */
  state_path: string;
  /** The public record: one JSON line per run that moved something. */
  log_path: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isAddress(s: unknown): s is Address {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

/** Parses and checks a config object. Throws naming the first field that is missing or wrong. */
export function parseConfig(raw: unknown, env: Record<string, string | undefined> = {}): KeeperConfig {
  if (!isObj(raw)) throw new Error("config must be a JSON object");
  const where = (k: string) => `config.${k}`;
  const address = (k: string): Address => {
    if (!isAddress(raw[k])) throw new Error(`${where(k)} must be a base58 address (there is no default)`);
    return raw[k] as Address;
  };
  const lamports = (k: string, min = 0n): bigint => {
    const v = raw[k];
    const ok = (typeof v === "string" && /^\d+$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
    if (!ok) throw new Error(`${where(k)} must be a whole number of lamports (a number or a decimal string)`);
    const n = BigInt(v as string | number);
    if (n < min) throw new Error(`${where(k)} must be at least ${min}`);
    return n;
  };
  const int = (o: Record<string, unknown>, k: string, name: string, lo: number, hi: number): number => {
    const v = o[k];
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw new Error(`${name} must be an integer from ${lo} to ${hi}`);
    return v as number;
  };
  const path = (k: string): string => {
    if (typeof raw[k] !== "string" || !(raw[k] as string).startsWith("/")) throw new Error(`${where(k)} must be an absolute path`);
    return raw[k] as string;
  };
  if (typeof raw.enabled !== "boolean") throw new Error(`${where("enabled")} must be true or false`);
  const envUrl = env.UNITS_FEE_KEEPER_RPC?.trim();
  if (raw.rpc_url !== null && raw.rpc_url !== undefined && (typeof raw.rpc_url !== "string" || !/^https?:\/\//.test(raw.rpc_url)))
    throw new Error(`${where("rpc_url")} must be an http(s) URL, or null with UNITS_FEE_KEEPER_RPC set`);
  const rpc_url = envUrl || (raw.rpc_url as string | null | undefined) || null;
  if (!rpc_url) throw new Error("no RPC endpoint: set config.rpc_url or UNITS_FEE_KEEPER_RPC");
  if (!/^https?:\/\//.test(rpc_url)) throw new Error("UNITS_FEE_KEEPER_RPC must be an http(s) URL");
  const mint = address("mint"), creator = address("creator"), compute_address = address("compute_address");
  if (compute_address === creator) throw new Error("config.compute_address is the creator wallet itself: the compute share would never leave it");
  if (compute_address === mint || creator === mint) throw new Error("config.mint cannot also be the creator or the compute address");
  if (raw.key_path !== null && raw.key_path !== undefined && (typeof raw.key_path !== "string" || !raw.key_path.startsWith("/")))
    throw new Error(`${where("key_path")} must be an absolute path, or null for dry runs only`);
  const compute_bps = int(raw, "compute_bps", where("compute_bps"), 0, 10_000), burn_bps = int(raw, "burn_bps", where("burn_bps"), 0, 10_000);
  if (compute_bps + burn_bps !== 10_000) throw new Error(`config.compute_bps + config.burn_bps must be 10000 (they are ${compute_bps} + ${burn_bps})`);
  const slippage_bps = int(raw, "slippage_bps", where("slippage_bps"), 0, MAX_SLIPPAGE_BPS);
  if (!isObj(raw.priority_fee)) throw new Error(`${where("priority_fee")} must be { percentile, floor_micro_lamports, cap_micro_lamports }`);
  const pf = raw.priority_fee;
  const priority_fee = {
    mode: "recent" as const,
    percentile: int(pf, "percentile", "config.priority_fee.percentile", 1, 100),
    floor_micro_lamports: int(pf, "floor_micro_lamports", "config.priority_fee.floor_micro_lamports", 0, Number.MAX_SAFE_INTEGER),
    cap_micro_lamports: int(pf, "cap_micro_lamports", "config.priority_fee.cap_micro_lamports", 0, Number.MAX_SAFE_INTEGER),
  };
  if (priority_fee.floor_micro_lamports > priority_fee.cap_micro_lamports) throw new Error("config.priority_fee.floor_micro_lamports is above the cap");
  const min_buyback_lamports = lamports("min_buyback_lamports", 1n), max_buyback_lamports = lamports("max_buyback_lamports", 1n);
  if (min_buyback_lamports > max_buyback_lamports) throw new Error("config.min_buyback_lamports is above config.max_buyback_lamports: no buyback could ever be sent");
  const state_path = path("state_path"), log_path = path("log_path");
  if (state_path === log_path) throw new Error("config.state_path and config.log_path must be two files");
  return {
    enabled: raw.enabled, rpc_url, mint, creator, key_path: (raw.key_path as string | null | undefined) ?? null, compute_address, compute_bps, burn_bps,
    fee_reserve_lamports: lamports("fee_reserve_lamports"), min_collect_lamports: lamports("min_collect_lamports", 1n), min_buyback_lamports, max_buyback_lamports,
    slippage_bps, priority_fee, confirm_timeout_s: int(raw, "confirm_timeout_s", where("confirm_timeout_s"), 10, 600), state_path, log_path,
  };
}

export function loadConfig(file: string, env: Record<string, string | undefined> = process.env): KeeperConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read the config ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseConfig(raw, env);
}

/** The config as it may be printed: everything but the RPC URL, which may carry a key. */
export function publicConfig(c: KeeperConfig): Record<string, unknown> {
  const { rpc_url: _rpc, ...rest } = c;
  return JSON.parse(JSON.stringify({ ...rest, rpc_url: "(not printed)" }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
