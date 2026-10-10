// Network profile (M3, SPEC 14.10): devnet or mainnet, from config/profile.json. Pure and
// browser-safe: parsing, selection and the public view a page may see. Node services load the file
// and resolve the RPC with profile-node.ts. The public view never carries an RPC URL: the browser
// talks to the web server's /chain/rpc proxy, which holds the keyed endpoint.

import { PROGRAM_IDS, type ProgramIds } from "./programs.ts";

export type NetworkName = "devnet" | "mainnet";
export const NETWORKS: readonly NetworkName[] = ["devnet", "mainnet"];

export interface QuoteConfig {
  /** "chain_state": mint and decimals come from the deployed state file (devnet tLINE); "config": from this block */
  source: "chain_state" | "config";
  symbol: string;
  /** "test" (devnet tLINE), "stand-in" (a mainnet mint standing in for $LINE), "live" ($LINE itself) */
  status: "test" | "stand-in" | "live";
  mint?: string;
  decimals?: number;
  token_program?: string;
  /** $LINE's mainnet mint once it exists; null = TBA */
  line_mint?: string | null;
}

export type FeePolicy =
  | { mode: "fixed"; cu_price_micro_lamports: number }
  | { mode: "recent"; percentile: number; floor_micro_lamports: number; cap_micro_lamports: number };

export interface ConfirmPolicy {
  poll_ms: number;
  resend_ms: number;
  /** how many times an expired blockhash is rebuilt and signed again (0: report expiry) */
  rebuilds: number;
}

export interface NetworkProfile {
  network: NetworkName;
  cluster: string;
  genesis: string;
  quote: QuoteConfig;
  state_file: string;
  faucet: boolean;
  test_labels: boolean;
  swap: boolean;
  /** explorer.solana.com ?cluster= value; null for mainnet (no parameter) */
  explorer_cluster: string | null;
  /** a real USD price feed for the quote token; null = show quote-token amounts, no USD */
  usd_feed: string | null;
  fees: FeePolicy;
  confirm: ConfirmPolicy;
  /** registry, launch and msg program ids of this network: the ones its build declares (programs.ts, cargo feature `mainnet`) */
  programs: ProgramIds;
  /** how this cluster's Pump build seeds a coin quoted in $LINE (pump-launch.ts PumpQuoteSeed); "swap" when absent */
  pump_quote_seed: "swap" | "spot";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function parseQuote(q: unknown, where: string): QuoteConfig {
  if (!isObj(q)) throw new Error(`${where}.quote is required`);
  if (q.source !== "chain_state" && q.source !== "config") throw new Error(`${where}.quote.source must be chain_state or config`);
  if (typeof q.symbol !== "string" || !q.symbol) throw new Error(`${where}.quote.symbol is required`);
  if (q.status !== "test" && q.status !== "stand-in" && q.status !== "live") throw new Error(`${where}.quote.status must be test, stand-in or live`);
  const out: QuoteConfig = { source: q.source, symbol: q.symbol, status: q.status };
  if (q.source === "config") {
    if (typeof q.mint !== "string" || !B58.test(q.mint)) throw new Error(`${where}.quote.mint must be a base58 address`);
    if (!Number.isInteger(q.decimals) || (q.decimals as number) < 0 || (q.decimals as number) > 18) throw new Error(`${where}.quote.decimals must be an integer 0..18`);
    if (typeof q.token_program !== "string" || !B58.test(q.token_program)) throw new Error(`${where}.quote.token_program must be a base58 address`);
    out.mint = q.mint;
    out.decimals = q.decimals as number;
    out.token_program = q.token_program;
  }
  if (q.line_mint !== undefined && q.line_mint !== null && (typeof q.line_mint !== "string" || !B58.test(q.line_mint))) throw new Error(`${where}.quote.line_mint must be null or an address`);
  out.line_mint = (q.line_mint as string | null | undefined) ?? null;
  if (out.status === "live" && out.source === "config" && out.line_mint !== out.mint) throw new Error(`${where}.quote: status live needs line_mint equal to mint`);
  return out;
}

function parseFees(f: unknown, where: string): FeePolicy {
  if (!isObj(f)) throw new Error(`${where}.fees is required`);
  const int = (k: string, lo = 0) => {
    const v = f[k];
    if (!Number.isInteger(v) || (v as number) < lo) throw new Error(`${where}.fees.${k} must be an integer >= ${lo}`);
    return v as number;
  };
  if (f.mode === "fixed") return { mode: "fixed", cu_price_micro_lamports: int("cu_price_micro_lamports") };
  if (f.mode === "recent") {
    const p = { mode: "recent" as const, percentile: int("percentile", 1), floor_micro_lamports: int("floor_micro_lamports"), cap_micro_lamports: int("cap_micro_lamports", 1) };
    if (p.percentile > 100) throw new Error(`${where}.fees.percentile must be 1..100`);
    if (p.floor_micro_lamports > p.cap_micro_lamports) throw new Error(`${where}.fees: floor above cap`);
    return p;
  }
  throw new Error(`${where}.fees.mode must be fixed or recent`);
}

function parseConfirm(c: unknown, where: string): ConfirmPolicy {
  if (!isObj(c)) throw new Error(`${where}.confirm is required`);
  for (const k of ["poll_ms", "resend_ms", "rebuilds"]) if (!Number.isInteger(c[k]) || (c[k] as number) < 0) throw new Error(`${where}.confirm.${k} must be an integer >= 0`);
  return { poll_ms: c.poll_ms as number, resend_ms: c.resend_ms as number, rebuilds: c.rebuilds as number };
}

/**
 * The profile's `programs` block. The ids are fixed by the program builds (declare_id! per cargo
 * feature), so the block may only restate them: absent means the build's ids, a different id is refused.
 */
function parsePrograms(network: NetworkName, raw: unknown, where: string): ProgramIds {
  const want = PROGRAM_IDS[network];
  if (raw === undefined) return { ...want };
  if (!isObj(raw)) throw new Error(`${where}.programs must be an object`);
  for (const k of ["registry", "launch", "msg"] as const)
    if (raw[k] !== want[k]) throw new Error(`${where}.programs.${k} must be ${want[k]}, the id the ${network} build declares`);
  return { ...want };
}

/** Parses one profile block. */
export function parseProfile(network: NetworkName, raw: unknown): NetworkProfile {
  const where = `profiles.${network}`;
  if (!isObj(raw)) throw new Error(`${where} is missing`);
  for (const k of ["cluster", "genesis", "state_file"]) if (typeof raw[k] !== "string" || !raw[k]) throw new Error(`${where}.${k} is required`);
  for (const k of ["faucet", "test_labels", "swap"]) if (typeof raw[k] !== "boolean") throw new Error(`${where}.${k} must be true or false`);
  const p: NetworkProfile = {
    network,
    cluster: raw.cluster as string,
    genesis: raw.genesis as string,
    quote: parseQuote(raw.quote, where),
    state_file: raw.state_file as string,
    faucet: raw.faucet as boolean,
    test_labels: raw.test_labels as boolean,
    swap: raw.swap as boolean,
    explorer_cluster: typeof raw.explorer_cluster === "string" ? raw.explorer_cluster : null,
    usd_feed: typeof raw.usd_feed === "string" && raw.usd_feed ? raw.usd_feed : null,
    fees: parseFees(raw.fees, where),
    confirm: parseConfirm(raw.confirm, where),
    programs: parsePrograms(network, raw.programs, where),
    pump_quote_seed: raw.pump_quote_seed === undefined ? "swap" : raw.pump_quote_seed === "swap" || raw.pump_quote_seed === "spot" ? raw.pump_quote_seed
      : (() => { throw new Error(`${where}.pump_quote_seed must be swap or spot`); })(),
  };
  // mainnet guards: these are the properties M3 promises, refused here rather than trusted
  if (network === "mainnet") {
    if (p.faucet) throw new Error(`${where}.faucet must be false: there is no faucet on mainnet`);
    if (p.test_labels) throw new Error(`${where}.test_labels must be false on mainnet`);
    if (p.quote.source !== "config") throw new Error(`${where}.quote.source must be config: the mainnet quote mint and decimals come from config`);
    if (p.quote.status === "test") throw new Error(`${where}.quote.status cannot be test on mainnet`);
    if (p.fees.mode !== "recent") throw new Error(`${where}.fees.mode must be recent on mainnet`);
  }
  return p;
}

/** Picks the active profile: `override` (LINEAGE_NETWORK) when set, else the file's `network`. */
export function selectProfile(raw: unknown, override?: string | null): NetworkProfile {
  if (!isObj(raw) || !isObj(raw.profiles)) throw new Error("profile config: profiles is required");
  const name = (override && override.trim()) || raw.network;
  if (name !== "devnet" && name !== "mainnet") throw new Error(`network must be devnet or mainnet, not ${JSON.stringify(name)}`);
  return parseProfile(name, raw.profiles[name]);
}

/** What a page may see: no RPC URL, no keys. Served at /chain/config as `profile`. */
export interface PublicProfile {
  network: NetworkName;
  cluster: string;
  genesis: string;
  quote: { symbol: string; status: QuoteConfig["status"]; mint: string | null; decimals: number | null; token_program: string | null; line_mint: string | null };
  faucet: boolean;
  test_labels: boolean;
  swap: boolean;
  explorer_cluster: string | null;
  usd_feed: boolean;
  fees: FeePolicy;
  confirm: ConfirmPolicy;
  programs: ProgramIds;
  pump_quote_seed: "swap" | "spot";
}

export function publicProfile(p: NetworkProfile): PublicProfile {
  return {
    network: p.network,
    cluster: p.cluster,
    genesis: p.genesis,
    quote: { symbol: p.quote.symbol, status: p.quote.status, mint: p.quote.mint ?? null, decimals: p.quote.decimals ?? null, token_program: p.quote.token_program ?? null, line_mint: p.quote.line_mint ?? null },
    faucet: p.faucet,
    test_labels: p.test_labels,
    swap: p.swap,
    explorer_cluster: p.explorer_cluster,
    usd_feed: !!p.usd_feed,
    fees: p.fees,
    confirm: p.confirm,
    programs: p.programs,
    pump_quote_seed: p.pump_quote_seed,
  };
}

/** The devnet profile as the code behaved before profiles existed: the browser's fallback when a server predates /chain/config `profile`. */
export const DEVNET_PUBLIC_PROFILE: PublicProfile = {
  network: "devnet",
  cluster: "devnet",
  genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  quote: { symbol: "tLINE", status: "test", mint: null, decimals: null, token_program: null, line_mint: null },
  faucet: true,
  test_labels: true,
  swap: false,
  explorer_cluster: "devnet",
  usd_feed: false,
  fees: { mode: "fixed", cu_price_micro_lamports: 1 },
  confirm: { poll_ms: 900, resend_ms: 2500, rebuilds: 0 },
  programs: { ...PROGRAM_IDS.devnet },
  pump_quote_seed: "spot",
};

/** explorer.solana.com link for a transaction or address under this profile. */
export function explorerUrl(p: Pick<PublicProfile, "explorer_cluster">, kind: "tx" | "address", v: string): string {
  return `https://explorer.solana.com/${kind}/${v}${p.explorer_cluster ? `?cluster=${p.explorer_cluster}` : ""}`;
}

/**
 * Applies a profile's quote to a deployed state (devnet.json or mainnet.json). Devnet: the state's
 * line_mint and decimals as before. Mainnet: mint, decimals and token program from config; a state
 * file that names a different mint is refused (one source of truth).
 */
export function quoteOfState<T extends Record<string, unknown>>(p: NetworkProfile | PublicProfile, state: T | null): (T & { line_mint: string; line_decimals: number; line_token_program: string }) | null {
  // devnet (quote from the chain state): unchanged
  if (!p.quote.mint) return state as (T & { line_mint: string; line_decimals: number; line_token_program: string }) | null;
  const mint = p.quote.mint!, decimals = p.quote.decimals!, tp = p.quote.token_program!;
  if (state && typeof state.line_mint === "string" && state.line_mint !== mint) throw new Error(`state file names line_mint ${state.line_mint}, the ${p.network} profile's quote mint is ${mint}`);
  if (!state) return null;
  return { ...state, line_mint: mint, line_decimals: decimals, line_token_program: tp };
}

/** The mainnet swap target must be the profile's quote mint (config/swap.json and config/profile.json agree). */
export function checkSwapTarget(p: NetworkProfile | PublicProfile, swap: { target_mint: string; target_decimals: number; target_token_program: string } | null): string | null {
  if (!p.swap) return null;
  if (!swap) return "the swap config is missing";
  if (swap.target_mint !== p.quote.mint) return `config/swap.json target_mint ${swap.target_mint} differs from the profile's quote mint ${p.quote.mint}`;
  if (swap.target_decimals !== p.quote.decimals) return `config/swap.json target_decimals ${swap.target_decimals} differs from the profile's ${p.quote.decimals}`;
  if (swap.target_token_program !== p.quote.token_program) return "config/swap.json target_token_program differs from the profile's";
  return null;
}
