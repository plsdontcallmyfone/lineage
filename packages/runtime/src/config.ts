import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRail, type OpenRouterRailConfig, type RailName } from "./rail.ts";
import { efficiencyError, type RuntimeEfficiency } from "../../worker/src/proposers/efficiency.ts";
import { unitSetupError, type UnitSetupConfig } from "./unit-setup.ts";

// Hosted runtime configuration (SPEC 17.2). Prices and caps are configuration, never constants:
// `compute_price_*` is the published rate at which model spend and sandbox time are converted into
// $UNITS debits (launch values TBA, owner decision; the values in config/runtime.json are TEST values).

export interface RuntimeConfig {
  /** sim: agents, keys and usage live in a simulated Core; devnet (or mainnet): discovered and debited on chain. The chain mode must equal the network profile (config/profile.json, SPEC 14.10). */
  mode: "sim" | "devnet" | "mainnet";
  /** Core base URL. */
  core: string;
  /** Where state, the lock and runtime-generated agent keys live. */
  state_dir: string;
  /** Runtime authority keypair (Solana JSON): signs provenance, posts usage (devnet: post_usage, debit_compute). */
  runtime_key: string;
  /** chain RPC; default the network profile's (devnet: packages/chain devnetRpcUrl(); mainnet: UNITS_MAINNET_RPC). A keyed URL here is a secret. */
  rpc_url?: string;
  /** Claude proposer. */
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  max_turns: number;
  max_evals: number;
  /** Attempt efficiency (docs/plans/AGENT-EFFICIENCY.md): the proposer's cap mode and usage log, and stacked authoring on the agent's own pending candidate. Absent: all off. */
  efficiency?: RuntimeEfficiency;
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
  /**
   * Mainnet: the quote token's live USD price (price.ts); devnet and sim use compute_price_line_per_usd.
   * `source: "config"` keeps the configured rate on mainnet too: for a stand-in quote token no feed
   * prices (the mainnet test's throwaway coin); the rate is then a TEST value, as on devnet.
   */
  price?: { source?: "jupiter" | "config"; api?: string; max_age_s?: number; min_usd?: number; max_usd?: number; refresh_s?: number } | null;
  /** OpenRouter balance checks (provider-balance.ts): seconds between reads (default 300) and the alert floor in USD (default 5). */
  openrouter_check_s?: number;
  openrouter_floor_usd?: number;
  /** Seconds between spend reports to Core (vault, burn, runway per agent; default 60; 0 = off). */
  spend_report_s?: number;
  /**
   * Network compute (plan MODELS-AND-SELF-FUNDING section D, owner 2026-10-13): an agent whose vault
   * cannot pay for an attempt keeps working on the network's OpenRouter balance, one attempt every
   * `min_interval_s` (default 900), each capped at `attempt_max_usd` (null or absent: the normal
   * attempt cap), under the global cap and the OpenRouter balance gate. Absent or `enabled: false`: off.
   */
  platform_funding?: { enabled: boolean; min_interval_s?: number; attempt_max_usd?: number | null };
  /** An attempt whose allowed spend would be lower than this is not started. */
  min_attempt_usd: number;
  /**
   * The minimum useful attempt (owner direction 2026-10-12): an authoring attempt is not started, takes
   * no desktop and opens no session unless its budget also covers the journal reserve plus
   * `model_calls` model calls at the agent's own model's rate, each priced as `call_input_tokens`
   * freshly written input and `call_output_tokens` output (the proposer's smallest turn). The floor is
   * the larger of that and min_attempt_usd. An agent below it is paused with the reason and checked
   * again after `recheck_s`, or at once when its vault balance rises. null turns the model-rate part
   * off. Defaults: 2 calls, 20,000 input tokens (hosted attempts on the site wrote 22,381 to 31,604
   * tokens to the cache on their first calls, runtime log 2026-10-12), 4,096 output tokens, 300 s.
   */
  min_useful_attempt?: { model_calls?: number; call_input_tokens?: number; call_output_tokens?: number; recheck_s?: number } | null;
  /** Published compute prices, whole $UNITS as decimal strings. TEST values until the owner sets launch values. */
  compute_price_line_per_usd: string;
  compute_price_line_per_sandbox_s: string;
  /**
   * Onchain messages (SPEC 12.5): whole $UNITS per SOL the runtime paid as fee payer for an agent's
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
  /** Authoring attempts running at once across all agents (each runs sandboxes); the floor of the slots. */
  max_concurrent: number;
  /** Slots grow to one per funded bound agent up to this ceiling (default max_concurrent): what the server carries. */
  max_concurrent_ceiling?: number;
  /** Unit setup (unit-setup.ts): a hosted agent on a repository with no unit drafts its recipe. Absent: on, with the defaults there. */
  unit_setup?: UnitSetupConfig;
  /** Seconds between the end of a funded agent's attempt and its next one (TEST 30); failures back off 30 s doubling to 15 min. */
  attempt_gap_s?: number;
  /** Optional: author only on these lineage ids. */
  lineages?: string[];
  /** Stop authoring for an agent after this many candidates (tests and proofs); default unlimited. */
  max_candidates_per_agent?: number;
  /** Credit rail (plan C): "anthropic" (default) or "openrouter" (OFF until openrouter.enabled; rail.ts). */
  rail?: RailName;
  openrouter?: OpenRouterRailConfig | null;
  /** Agent posts (plan S, posts.ts): defaults POSTS_DEFAULTS; `{ "enabled": false }` keeps only media folding. */
  posts?: Partial<import("./posts.ts").PostsConfig>;
  /** The follow step after a session (follows.ts): defaults FOLLOWS_DEFAULTS; `{ "enabled": false }` leaves follows to the worker's `follow` command. */
  follows?: Partial<import("./follows.ts").FollowsConfig>;
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
  /**
   * One E2B day budget across several runtimes on one server (desktops.ts): each publishes its E2B
   * spend of the UTC day as <dir>/<name>.json and counts the `peers`' published spend against its own
   * `desktop_usd_per_day`, so the instances together stay under one cap. `strict`: a peer whose file is
   * missing, unreadable or older than `stale_s` (default 600) leaves this runtime no E2B budget at all
   * (the mainnet test instance); without it such a peer counts as 0 (the first instance behaves as it
   * did before a second one exists).
   */
  desktop_shared?: { dir: string; name: string; peers: string[]; strict?: boolean; stale_s?: number } | null;
  /** Hosts a desktop's browser may reach (each with its subdomains); default the code host. */
  desktop_allow?: string[];
  /** Port for /desktops/* when bind_port is absent (sim mode, local proofs). */
  desktop_port?: number;
  e2b?: { template?: string; vcpu?: number; ram_gib?: number; session_max_s?: number };
  /** Full-quality desktop recordings and their publication (default false: live only, owner direction 2026-10-10). */
  recordings?: boolean;
  /** Desktop hosts (packages/desktop/src/remote.ts): a JSON file {hosts: [...]} that scripts/deploy/desktop-host/register.ts writes; re-read every minute. */
  desktop_hosts_file?: string;
  /** Every attempt needs a live desktop when desktops are on (owner decision 2026-10-10; default true): with none free the attempt waits. */
  desktop_required?: boolean;
  /**
   * Desktop reaper (packages/desktop pool.ts reap): a desktop container on this server is removed when its
   * attempt is not running any more or when it is older than desktop_max_age_s (default 7200), at start
   * and every desktop_reap_every_s seconds (default 300; 0: only at start).
   */
  desktop_max_age_s?: number;
  desktop_reap_every_s?: number;
  /**
   * "per_attempt" (default): a desktop per running attempt (hosts, this server, then E2B). "per_agent"
   * (owner decision 2026-10-12, packages/desktop agent-desktops.ts): every bound agent has its own E2B
   * desktop from its binding on, paused while it is idle and resumed for its next attempt; then
   * `e2b_max` is the most desktops RUNNING at once (E2B does not count paused ones; measured
   * 2026-10-12), `desktop_usd_per_day` counts every second a desktop runs, `e2b.session_max_s` is the
   * plan's session length, and desktops_max and the desktop hosts are not used.
   */
  desktop_mode?: "per_agent" | "per_attempt";
  /** per_agent: pause a desktop whose agent has not been in an attempt for this long, s (default 600; an asleep agent's is paused at once). */
  desktop_idle_s?: number;
  /** per_agent: between attempts, restart E2B's session window (pause, resume) when less than this is left of e2b.session_max_s, s (default 1800, at most half of it). */
  desktop_renew_before_s?: number;
  /** per_agent: the sandbox timeout the runtime pushes forward, s (default 900): E2B pauses a desktop this long after the runtime's last sign of life. */
  desktop_keepalive_s?: number;
  /** per_agent: the longest a desktop that E2B paused under a running attempt may take to come back, s (default 60); after it the stream ends and the attempt goes on without. */
  desktop_resume_gap_max_s?: number;
  /** per_agent: a desktop whose agent is not bound to this runtime any more is killed after this long, s (default 300). */
  desktop_remove_after_s?: number;
  /**
   * per_agent: false keeps an awake agent's desktop running, and its screen live, however long it
   * waits for its next attempt (owner 2026-10-12, "it should keep running all time"); a desktop is then
   * paused only when its agent cannot work (asleep, or its vault cannot pay for an attempt), when the
   * day budget is used up, or to make room at e2b_max. Default true: paused after desktop_idle_s.
   */
  desktop_idle_pause?: boolean;
  /**
   * The live video's mask (default true): the editor's text and the run terminal pixelated, and the
   * stream stopped while those windows are not where the mask is. false (owner decision 2026-10-12, "we
   * don't want to be blurred"): the video shows the desktop as it is and no window check stops it; a
   * viewer can then read a change before it is committed. Only the video: session events, notes, patch
   * text and evaluation output stay sealed at Core until the verdict either way.
   */
  desktop_mask?: boolean;
  /** per_agent: desktops created at once (default 4; E2B allows 1 create per second on Hobby, 5 on Pro). */
  desktop_start_parallel?: number;
  /** per_agent: this runtime's label on its sandboxes (default: desktop_shared.name or the mode, plus a digest of the host name and state_dir). Two runtimes on one E2B account need different labels. */
  desktop_owner?: string;
}

/** Defaults of cfg.platform_funding. */
export const PLATFORM_FUNDING_DEFAULTS = { enabled: false, min_interval_s: 900, attempt_max_usd: null as number | null };

export const DEFAULTS: Omit<RuntimeConfig, "mode" | "core" | "runtime_key" | "compute_price_line_per_usd" | "compute_price_line_per_sandbox_s"> = {
  state_dir: join((process.env.UNITS_HOME ?? process.env.LINEAGE_HOME) ?? join(homedir(), ".lineage"), "runtime", "default"),
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
  attempt_gap_s: 30,
};

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function parseConfig(raw: Record<string, unknown>): RuntimeConfig {
  const c = { ...DEFAULTS, ...raw } as RuntimeConfig & { _note?: string };
  if (c.mode !== "sim" && c.mode !== "devnet" && c.mode !== "mainnet") throw new Error("runtime config: mode is sim, devnet or mainnet");
  if (typeof c.core !== "string" || !c.core) throw new Error("runtime config: core is required");
  if (typeof c.runtime_key !== "string") throw new Error("runtime config: runtime_key is required");
  if (c.compute_price_line_per_sol !== undefined && (typeof c.compute_price_line_per_sol !== "string" || !/^\d+(\.\d+)?$/.test(c.compute_price_line_per_sol)))
    throw new Error("runtime config: compute_price_line_per_sol is a decimal string of whole $UNITS");
  for (const k of ["compute_price_line_per_usd", "compute_price_line_per_sandbox_s"] as const)
    if (typeof c[k] !== "string" || !/^\d+(\.\d+)?$/.test(c[k])) throw new Error(`runtime config: ${k} is a decimal string of whole $UNITS`);
  for (const k of ["attempt_max_usd", "global_max_usd", "min_attempt_usd"] as const)
    if (typeof c[k] !== "number" || !(c[k] >= 0)) throw new Error(`runtime config: ${k} must be a non-negative number`);
  if (c.agent_epoch_max_usd !== undefined && c.agent_epoch_max_usd !== null && !(typeof c.agent_epoch_max_usd === "number" && c.agent_epoch_max_usd >= 0)) throw new Error("runtime config: agent_epoch_max_usd must be a non-negative number or null");
  if (c.global_cap_scope !== "subsidized" && c.global_cap_scope !== "all") throw new Error('runtime config: global_cap_scope is "subsidized" or "all"');
  if (c.price !== undefined && c.price !== null && c.price.source !== undefined && c.price.source !== "jupiter" && c.price.source !== "config") throw new Error('runtime config: price.source is "jupiter" or "config"');
  if (c.price !== undefined && c.price !== null && c.price.source !== "config" && !(typeof c.price.min_usd === "number" && typeof c.price.max_usd === "number" && c.price.min_usd > 0 && c.price.max_usd > c.price.min_usd)) throw new Error("runtime config: price needs min_usd < max_usd, both positive (the sanity band)");
  if (c.desktop_shared !== undefined && c.desktop_shared !== null) {
    const d = c.desktop_shared;
    const nameOk = (x: unknown) => typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(x);
    if (typeof d.dir !== "string" || !d.dir.startsWith("/") || !nameOk(d.name) || !Array.isArray(d.peers) || !d.peers.every(nameOk) || d.peers.includes(d.name))
      throw new Error("runtime config: desktop_shared needs an absolute dir, a name and a list of other names (peers)");
    if (d.stale_s !== undefined && !(typeof d.stale_s === "number" && d.stale_s >= 30)) throw new Error("runtime config: desktop_shared.stale_s is at least 30 seconds");
  }
  if (c.global_window_s !== undefined && c.global_window_s !== null && !(Number.isInteger(c.global_window_s) && c.global_window_s >= 60))
    throw new Error("runtime config: global_window_s is a whole number of seconds >= 60 (86400 = one UTC day), or null for a lifetime cap");
  if (!(c.max_concurrent >= 1)) throw new Error("runtime config: max_concurrent >= 1");
  if (c.max_concurrent_ceiling !== undefined && !(Number.isInteger(c.max_concurrent_ceiling) && c.max_concurrent_ceiling >= c.max_concurrent && c.max_concurrent_ceiling <= 64)) throw new Error("runtime config: max_concurrent_ceiling is a whole number from max_concurrent to 64");
  if (c.min_useful_attempt !== undefined && c.min_useful_attempt !== null) {
    const m = c.min_useful_attempt as Record<string, unknown>;
    if (typeof m !== "object" || Array.isArray(m)) throw new Error("runtime config: min_useful_attempt is an object or null");
    for (const k of ["model_calls", "call_input_tokens", "call_output_tokens", "recheck_s"])
      if (m[k] !== undefined && !(typeof m[k] === "number" && Number.isFinite(m[k]) && (m[k] as number) >= 0)) throw new Error(`runtime config: min_useful_attempt.${k} is a number of 0 or more`);
  }
  if (c.platform_funding !== undefined) {
    const f = c.platform_funding as Record<string, unknown> | null;
    if (!f || typeof f !== "object" || Array.isArray(f) || typeof f.enabled !== "boolean") throw new Error("runtime config: platform_funding is { enabled: true or false, min_interval_s, attempt_max_usd }");
    if (f.min_interval_s !== undefined && !(typeof f.min_interval_s === "number" && Number.isFinite(f.min_interval_s) && f.min_interval_s >= 0)) throw new Error("runtime config: platform_funding.min_interval_s is a number of seconds, 0 or more");
    if (f.attempt_max_usd !== undefined && f.attempt_max_usd !== null && !(typeof f.attempt_max_usd === "number" && Number.isFinite(f.attempt_max_usd) && f.attempt_max_usd >= 0)) throw new Error("runtime config: platform_funding.attempt_max_usd is a non-negative number or null");
  }
  if (c.attempt_gap_s !== undefined && !(typeof c.attempt_gap_s === "number" && c.attempt_gap_s >= 0 && c.attempt_gap_s <= 3600)) throw new Error("runtime config: attempt_gap_s is 0 to 3600 seconds");
  if (c.bind_port !== undefined && !(Number.isInteger(c.bind_port) && c.bind_port > 0 && c.bind_port < 65536)) throw new Error("runtime config: bind_port is a TCP port");
  if (c.desktop_port !== undefined && !(Number.isInteger(c.desktop_port) && c.desktop_port > 0 && c.desktop_port < 65536)) throw new Error("runtime config: desktop_port is a TCP port");
  if (c.desktops_max !== undefined && !(Number.isInteger(c.desktops_max) && c.desktops_max >= 0 && c.desktops_max <= 16)) throw new Error("runtime config: desktops_max is a whole number from 0 to 16");
  // E2B sells up to 1,100 sandboxes at once (e2b.dev/pricing, read 2026-10-12)
  if (c.e2b_max !== undefined && !(Number.isInteger(c.e2b_max) && c.e2b_max >= 0 && c.e2b_max <= 1100)) throw new Error("runtime config: e2b_max is a whole number from 0 to 1100");
  for (const k of ["desktop_idle_pause", "desktop_mask"] as const) if (c[k] !== undefined && typeof c[k] !== "boolean") throw new Error(`runtime config: ${k} is true or false`);
  if (c.desktop_mode !== undefined && c.desktop_mode !== "per_agent" && c.desktop_mode !== "per_attempt") throw new Error('runtime config: desktop_mode is "per_agent" or "per_attempt"');
  for (const [k, min] of [["desktop_idle_s", 0], ["desktop_renew_before_s", 0], ["desktop_keepalive_s", 60], ["desktop_resume_gap_max_s", 1], ["desktop_remove_after_s", 0], ["desktop_start_parallel", 1]] as const)
    if (c[k] !== undefined && !(typeof c[k] === "number" && Number.isFinite(c[k]) && c[k]! >= min)) throw new Error(`runtime config: ${k} is a number of at least ${min}`);
  if (c.desktop_owner !== undefined && !(typeof c.desktop_owner === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(c.desktop_owner))) throw new Error("runtime config: desktop_owner is 1 to 64 letters, digits, dots, dashes or underscores");
  if (c.desktop_mode === "per_agent" && !((c.e2b_max ?? 0) > 0)) throw new Error("runtime config: desktop_mode per_agent needs e2b_max above 0");
  if (c.recordings !== undefined && typeof c.recordings !== "boolean") throw new Error("runtime config: recordings is true or false");
  if (c.desktop_required !== undefined && typeof c.desktop_required !== "boolean") throw new Error("runtime config: desktop_required is true or false");
  if (c.desktop_max_age_s !== undefined && !(typeof c.desktop_max_age_s === "number" && c.desktop_max_age_s >= 300)) throw new Error("runtime config: desktop_max_age_s is at least 300 seconds");
  if (c.desktop_reap_every_s !== undefined && !(typeof c.desktop_reap_every_s === "number" && (c.desktop_reap_every_s === 0 || c.desktop_reap_every_s >= 30))) throw new Error("runtime config: desktop_reap_every_s is 0 (only at start) or at least 30 seconds");
  if (c.desktop_hosts_file !== undefined && typeof c.desktop_hosts_file !== "string") throw new Error("runtime config: desktop_hosts_file is a path");
  if (c.desktop_usd_per_day !== undefined && !(typeof c.desktop_usd_per_day === "number" && c.desktop_usd_per_day >= 0)) throw new Error("runtime config: desktop_usd_per_day must be a non-negative number");
  if (c.desktop_allow !== undefined && !(Array.isArray(c.desktop_allow) && c.desktop_allow.every((h) => typeof h === "string" && /^[A-Za-z0-9.-]{1,253}$/.test(h)))) throw new Error("runtime config: desktop_allow is a list of host names");
  const suErr = unitSetupError(c.unit_setup);
  if (suErr) throw new Error(`runtime config: ${suErr}`);
  if (c.efficiency !== undefined) {
    const err = efficiencyError(c.efficiency);
    if (err) throw new Error(`runtime config: ${err}`);
  }
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
