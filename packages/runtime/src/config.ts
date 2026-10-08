import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Hosted runtime configuration (SPEC 17.2). Prices and caps are configuration, never constants:
// `compute_price_*` is the published rate at which model spend and sandbox time are converted into
// $LINE debits (launch values TBA, owner decision; the values in config/runtime.json are TEST values).

export interface RuntimeConfig {
  /** sim: agents, keys and usage live in a simulated Core; devnet: discovered and debited on chain. */
  mode: "sim" | "devnet";
  /** Core base URL. */
  core: string;
  /** Where state, the lock and runtime-generated agent keys live. */
  state_dir: string;
  /** Runtime authority keypair (Solana JSON): signs provenance, posts usage (devnet: post_usage, debit_compute). */
  runtime_key: string;
  /** devnet RPC; default packages/chain devnetRpcUrl(). */
  rpc_url?: string;
  /** Claude proposer. */
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  max_turns: number;
  max_evals: number;
  /** Spend control (USD of model usage). */
  attempt_max_usd: number;
  agent_epoch_max_usd: number;
  /** Lifetime cap of this runtime across restarts (persisted spend). */
  global_max_usd: number;
  /** An attempt whose allowed spend would be lower than this is not started. */
  min_attempt_usd: number;
  /** Published compute prices, whole $LINE as decimal strings. TEST values until the owner sets launch values. */
  compute_price_line_per_usd: string;
  compute_price_line_per_sandbox_s: string;
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
}

export const DEFAULTS: Omit<RuntimeConfig, "mode" | "core" | "runtime_key" | "compute_price_line_per_usd" | "compute_price_line_per_sandbox_s"> = {
  state_dir: join(process.env.LINEAGE_HOME ?? join(homedir(), ".lineage"), "runtime", "default"),
  model: "claude-opus-5-5",
  effort: "high",
  max_turns: 40,
  max_evals: 4,
  attempt_max_usd: 1,
  agent_epoch_max_usd: 5,
  global_max_usd: 10,
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
  if (c.mode !== "sim" && c.mode !== "devnet") throw new Error("runtime config: mode is sim or devnet");
  if (typeof c.core !== "string" || !c.core) throw new Error("runtime config: core is required");
  if (typeof c.runtime_key !== "string") throw new Error("runtime config: runtime_key is required");
  for (const k of ["compute_price_line_per_usd", "compute_price_line_per_sandbox_s"] as const)
    if (typeof c[k] !== "string" || !/^\d+(\.\d+)?$/.test(c[k])) throw new Error(`runtime config: ${k} is a decimal string of whole $LINE`);
  for (const k of ["attempt_max_usd", "agent_epoch_max_usd", "global_max_usd", "min_attempt_usd"] as const)
    if (typeof c[k] !== "number" || !(c[k] >= 0)) throw new Error(`runtime config: ${k} must be a non-negative number`);
  if (!(c.max_concurrent >= 1)) throw new Error("runtime config: max_concurrent >= 1");
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
}

export function resolvePrices(c: RuntimeConfig, decimals: number): Prices {
  return { decimals, perUsd: toBase(c.compute_price_line_per_usd, decimals), perSandboxS: toBase(c.compute_price_line_per_sandbox_s, decimals) };
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
