import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRail, type OpenRouterRailConfig, type RailName } from "./rail.ts";

// Hosted runtime configuration (SPEC 17.2). Prices and caps are configuration, never constants:
// `compute_price_*` is the published rate at which model spend and sandbox time are converted into
// $LINE debits (launch values TBA, owner decision; the values in config/runtime.json are TEST values).

export interface RuntimeConfig {
  /** sim: agents, keys and usage live in a simulated Core; devnet (or mainnet): discovered and debited on chain. The chain mode must equal the network profile (config/profile.json, SPEC 14.10). */
  mode: "sim" | "devnet" | "mainnet";
  /** Core base URL. */
  core: string;
  /** Where state, the lock and runtime-generated agent keys live. */
  state_dir: string;
  /** Runtime authority keypair (Solana JSON): signs provenance, posts usage (devnet: post_usage, debit_compute). */
  runtime_key: string;
  /** chain RPC; default the network profile's (devnet: packages/chain devnetRpcUrl(); mainnet: LINEAGE_MAINNET_RPC). A keyed URL here is a secret. */
  rpc_url?: string;
  /** Claude proposer. */
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  max_turns: number;
  max_evals: number;
  /** Spend control (USD of model usage). */
  attempt_max_usd: number;
  /** Optional per-agent cap per usage epoch; null or absent = none (owner decision 2026-10-10: the vault pays, no cap). */
  agent_epoch_max_usd?: number | null;
  /**
   * Cap on this runtime's model spend across all agents (persisted across restarts). Without
   * `global_window_s` it is a lifetime cap; with it, it is a cap per window (below).
   */
  global_max_usd: number;
  /**
   * Optional spend window of `global_max_usd`, in seconds: windows are aligned to the Unix epoch, so
   * 86400 is one UTC calendar day (00:00 to 24:00 UTC) and the cap resets at 00:00 UTC. Absent or
   * null: `global_max_usd` caps the runtime's lifetime spend.
   */
  global_window_s?: number | null;
  /**
   * What the global cap counts (plan MODELS-AND-SELF-FUNDING): "subsidized" (default) only spend the
   * vaults could not pay (each usage leaf's shortfall), so self-funded agents are never blocked by it;
   * "all" every metered USD, as before 2026-10-10 (a kill switch the owner can set without code).
   */
  global_cap_scope?: "subsidized" | "all";
  /** Mainnet: the quote token's live USD price (price.ts); devnet and sim use compute_price_line_per_usd. */
  price?: { api?: string; max_age_s?: number; min_usd: number; max_usd: number; refresh_s?: number } | null;
  /** OpenRouter balance checks (provider-balance.ts): seconds between reads (default 300) and the alert floor in USD (default 5). */
  openrouter_check_s?: number;
  openrouter_floor_usd?: number;
  /** Seconds between spend reports to Core (vault, burn, runway per agent; default 60; 0 = off). */
  spend_report_s?: number;
  /** An attempt whose allowed spend would be lower than this is not started. */
  min_attempt_usd: number;
  /** Published compute prices, whole $LINE as decimal strings. TEST values until the owner sets launch values. */
  compute_price_line_per_usd: string;
  compute_price_line_per_sandbox_s: string;
  /**
   * Onchain messages (SPEC 12.5): whole $LINE per SOL the runtime paid as fee payer for an agent's
   * messages (fees and its message state rent), billed like model tokens. Optional; absent = "0"
   * (then the lamports are recorded but not debited). TEST value until the owner sets a launch value.
   */
  compute_price_line_per_sol?: string;
  /** Sandbox seconds held back from an attempt's budget for its evaluations. */
  sandbox_reserve_s: number;
  /** Length of a usage epoch; devnet additionally respects the onchain clock (14.5). */
  usage_epoch_s: number;
  /** Close the usage epoch early once an agent with usage has no budget left (so it is debited and sleeps promptly). */
  close_when_exhausted: boolean;
  poll_ms: number;
  /** Authoring attempts running at once across all agents (each runs sandboxes). */
  max_concurrent: number;
  /** Optional: author only on these lineage ids. */
  lineages?: string[];
  /** Stop authoring for an agent after this many candidates (tests and proofs); default unlimited. */
  max_candidates_per_agent?: number;
  /** Credit rail (plan C): "anthropic" (default) or "openrouter" (OFF until openrouter.enabled; rail.ts). */
  rail?: RailName;
  openrouter?: OpenRouterRailConfig | null;
  /** Agent posts (plan S, posts.ts): defaults POSTS_DEFAULTS; `{ "enabled": false }` keeps only media folding. */
  posts?: Partial<import("./posts.ts").PostsConfig>;
  /** devnet: serve the bind endpoint (bind.ts) on 127.0.0.1 at this port, so hosted launches bind from the Wallet page; absent = off. */
  bind_port?: number;
  /**
   * Agent desktops (SPEC 17.7, packages/desktop): live desktops on our own server, at most this many
   * at once (TEST 2 on the site; absent or 0 = none). The stream is served on bind_port (or
   * desktop_port) at /desktops/<session>/*, which the gate forwards.
   */
  desktops_max?: number;
  /** E2B Desktop overflow (owner decision 2026-10-10): at most this many at once (TEST 3); needs E2B_API_KEY in ~/.config/lineage/e2b.env. */
  e2b_max?: number;
  /** E2B spend cap per UTC day in USD (TEST 5), separate from the model cap; at the cap no new E2B desktops start. */
  desktop_usd_per_day?: number;
  /** Hosts a desktop's browser may reach (each with its subdomains); default the code host. */
  desktop_allow?: string[];
  /** Port for /desktops/* when bind_port is absent (sim mode, local proofs). */
  desktop_port?: number;
  e2b?: { template?: string; vcpu?: number; ram_gib?: number; session_max_s?: number };
}

export const DEFAULTS: Omit<RuntimeConfig, "mode" | "core" | "runtime_key" | "compute_price_line_per_usd" | "compute_price_line_per_sandbox_s"> = {
  state_dir: join(process.env.LINEAGE_HOME ?? join(homedir(), ".lineage"), "runtime", "default"),
  model: "claude-opus-5-5",
  effort: "high",
  max_turns: 40,
  max_evals: 4,
  attempt_max_usd: 1,
  agent_epoch_max_usd: null,
  global_max_usd: 10,
  global_cap_scope: "subsidized",
  min_attempt_usd: 0.05,
  sandbox_reserve_s: 600,
  usage_epoch_s: 3600,
  close_when_exhausted: true,
  poll_ms: 5000,
  max_concurrent: 1,
};

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function parseConfig(raw: Record<string, unknown>): RuntimeConfig {
  const c = { ...DEFAULTS, ...raw } as RuntimeConfig & { _note?: string };
  if (c.mode !== "sim" && c.mode !== "devnet" && c.mode !== "mainnet") throw new Error("runtime config: mode is sim, devnet or mainnet");
  if (typeof c.core !== "string" || !c.core) throw new Error("runtime config: core is required");
  if (typeof c.runtime_key !== "string") throw new Error("runtime config: runtime_key is required");
  if (c.compute_price_line_per_sol !== undefined && (typeof c.compute_price_line_per_sol !== "string" || !/^\d+(\.\d+)?$/.test(c.compute_price_line_per_sol)))
    throw new Error("runtime config: compute_price_line_per_sol is a decimal string of whole $LINE");
  for (const k of ["compute_price_line_per_usd", "compute_price_line_per_sandbox_s"] as const)
    if (typeof c[k] !== "string" || !/^\d+(\.\d+)?$/.test(c[k])) throw new Error(`runtime config: ${k} is a decimal string of whole $LINE`);
  for (const k of ["attempt_max_usd", "global_max_usd", "min_attempt_usd"] as const)
    if (typeof c[k] !== "number" || !(c[k] >= 0)) throw new Error(`runtime config: ${k} must be a non-negative number`);
  if (c.agent_epoch_max_usd !== undefined && c.agent_epoch_max_usd !== null && !(typeof c.agent_epoch_max_usd === "number" && c.agent_epoch_max_usd >= 0)) throw new Error("runtime config: agent_epoch_max_usd must be a non-negative number or null");
  if (c.global_cap_scope !== "subsidized" && c.global_cap_scope !== "all") throw new Error('runtime config: global_cap_scope is "subsidized" or "all"');
  if (c.price !== undefined && c.price !== null && !(typeof c.price.min_usd === "number" && typeof c.price.max_usd === "number" && c.price.min_usd > 0 && c.price.max_usd > c.price.min_usd)) throw new Error("runtime config: price needs min_usd < max_usd, both positive (the sanity band)");
  if (c.global_window_s !== undefined && c.global_window_s !== null && !(Number.isInteger(c.global_window_s) && c.global_window_s >= 60))
    throw new Error("runtime config: global_window_s is a whole number of seconds >= 60 (86400 = one UTC day), or null for a lifetime cap");
  if (!(c.max_concurrent >= 1)) throw new Error("runtime config: max_concurrent >= 1");
  if (c.bind_port !== undefined && !(Number.isInteger(c.bind_port) && c.bind_port > 0 && c.bind_port < 65536)) throw new Error("runtime config: bind_port is a TCP port");
  if (c.desktop_port !== undefined && !(Number.isInteger(c.desktop_port) && c.desktop_port > 0 && c.desktop_port < 65536)) throw new Error("runtime config: desktop_port is a TCP port");
  for (const k of ["desktops_max", "e2b_max"] as const) if (c[k] !== undefined && !(Number.isInteger(c[k]) && c[k]! >= 0 && c[k]! <= 16)) throw new Error(`runtime config: ${k} is a whole number from 0 to 16`);
  if (c.desktop_usd_per_day !== undefined && !(typeof c.desktop_usd_per_day === "number" && c.desktop_usd_per_day >= 0)) throw new Error("runtime config: desktop_usd_per_day must be a non-negative number");
  if (c.desktop_allow !== undefined && !(Array.isArray(c.desktop_allow) && c.desktop_allow.every((h) => typeof h === "string" && /^[A-Za-z0-9.-]{1,253}$/.test(h)))) throw new Error("runtime config: desktop_allow is a list of host names");
  const rail = parseRail(c);
  c.rail = rail.rail;
  c.openrouter = rail.openrouter;
  c.state_dir = expand(c.state_dir);
  c.runtime_key = expand(c.runtime_key);
  delete (c as { _note?: string })._note;
  return c;
}

export function loadConfig(path: string, over: Record<string, unknown> = {}): RuntimeConfig {
  return parseConfig({ ...(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>), ...over });
}

/** Reads ~/.config/lineage/model.env (KEY=VALUE lines) into the environment. The key is never printed. */
export function loadModelEnv(path = join(homedir(), ".config/lineage/model.env")): boolean {
  if (existsSync(path))
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Start (ms) of the spend window holding `nowMs`; windows of `windowS` seconds aligned to the Unix epoch (86400 = UTC days). */
export function windowStart(nowMs: number, windowS: number): number {
  const w = windowS * 1000;
  return Math.floor(nowMs / w) * w;
}

/** A decimal string of whole tokens as integer base units (exact; extra decimals are refused). */
export function toBase(dec: string, decimals: number): bigint {
  const [i, f = ""] = dec.split(".");
  if (f.length > decimals) throw new Error(`${dec} has more than ${decimals} decimals`);
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Prices in base units, resolved against the token's decimals. */
export interface Prices {
  decimals: number;
  /** base units per 1 USD of model spend */
  perUsd: bigint;
  /** base units per sandbox second */
  perSandboxS: bigint;
  /** base units per SOL of chain fees paid for the agent (onchain messages) */
  perSol?: bigint;
}

export function resolvePrices(c: RuntimeConfig, decimals: number): Prices {
  return {
    decimals,
    perUsd: toBase(c.compute_price_line_per_usd, decimals),
    perSandboxS: toBase(c.compute_price_line_per_sandbox_s, decimals),
    perSol: toBase(c.compute_price_line_per_sol ?? "0", decimals),
  };
}

/** What `lamports` of chain fees cost in base units at `perSol` (rounded up). */
export function chainCostOf(p: Prices, lamports: number): bigint {
  if (!p.perSol || lamports <= 0) return 0n;
  return (BigInt(Math.ceil(lamports)) * p.perSol + 999_999_999n) / 1_000_000_000n;
}

/**
 * What an amount of usage costs in base units: model spend at `perUsd` (USD rounded up to the
 * micro dollar, the product rounded up) plus whole sandbox seconds (rounded up) at `perSandboxS`.
 */
export function costOf(p: Prices, usd: number, sandboxS: number): bigint {
  const micro = BigInt(Math.ceil(usd * 1e6 - 1e-6));
  const model = (micro * p.perUsd + 999_999n) / 1_000_000n;
  return model + BigInt(Math.ceil(sandboxS)) * p.perSandboxS;
}

/** The most USD of model spend `budget` base units pay for, after holding back `reserveS` sandbox seconds. */
export function usdFor(p: Prices, budget: bigint, reserveS: number): number {
  const left = budget - BigInt(Math.ceil(reserveS)) * p.perSandboxS;
  if (left <= 0n || p.perUsd === 0n) return p.perUsd === 0n && left > 0n ? Infinity : 0;
  return Number((left * 1_000_000n) / p.perUsd) / 1e6;
}
