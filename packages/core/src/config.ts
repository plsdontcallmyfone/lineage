import { readFileSync } from "node:fs";

// Network parameters (SPEC 13, config/network.json). Token amounts are integer base units, held as
// bigint in Core and as decimal strings on disk and on the wire.

export interface NetworkConfig {
  quorum: number;
  max_reassign: number;
  det_tolerance: number;
  bootstrap_resamples: number;
  reveal_window_s: number;
  replay_window_factor: number;
  replay_window_min_s: number;
  canary_rate: number;
  audit_rate: number;
  max_open_replays: number;
  max_open_candidates_per_agent: number;
  epoch_length_s: number;
  register_burn: bigint;
  min_bond: bigint;
  bond_cap: bigint;
  unbond_cooldown_s: number;
  reserve_bps: number;
  pool_bps: number;
  u_replay: number;
  u_author: number;
  finder_share: number;
  value_cap: number;
  rebate_per_class: bigint;
  canary_slash_bps: number;
  minority_slash_bps: number;
  reveal_slash_bps: number;
  strike_limit: number;
  token_decimals: number;
  agent_compute_bps: number;
  protocol_bps: number;
  sleep_threshold: bigint;
  wake_threshold: bigint;
  /** Where author (and finder) epoch rewards are paid: the agent's compute vault or its launcher's wallet. */
  author_reward_to: "compute" | "launcher";
  /** Cooldown before a verifier may retry a failed or expired qualification (SPEC 6.1). Optional, default 600. */
  qualify_retry_s: number;
  /** Activity events accepted per agent per minute (SPEC 17.1). Optional, default 120. */
  activity_rate: number;
  /** Worker heartbeat period; a machine is awake while its last heartbeat is younger than 3x this (SPEC 17.1). Optional, default 10. */
  heartbeat_s: number;
  /** Random auditors drawn per audit besides the reference runner (SPEC 10.6). Optional, default 2. */
  audit_replayers: number;
  /** Shadow author identities kept launched per lineage that has canaries (SPEC 10.5). Optional, default 3. */
  shadow_pool: number;
  /** Shadow launches are spread uniformly at random over this many seconds after they are planned. Optional, default 3600. */
  shadow_launch_spread_s: number;
  /** A shadow must have existed this long before it authors a canary. Optional, default 900. */
  shadow_min_age_s: number;
  /** Delay between the triggering assignment and the canary commit, drawn uniformly from [min, max] seconds. Optional, default [30, 600]. */
  canary_inject_delay_s: [number, number];
  /** Canary commit-to-reveal delay range in seconds, used until the lineage has 5 real reveals to sample from. Optional, default [5, 120]. */
  canary_reveal_delay_s: [number, number];
  // Collaboration (SPEC 12.1, 12.2). Defaults are test values; launch values are TBA (owner).
  /** Intents an agent may hold publicly open at once (an intent that led to a commit counts until it publicly ends). Optional, default 3. */
  max_intents_per_agent: number;
  /** Longest intent TTL in seconds. Optional, default 3600. */
  intent_max_ttl_s: number;
  /** Intents an agent may file per hour. Optional, default 20. */
  intent_rate_per_hour: number;
  /** Activity window of the lineage workboard, seconds. Optional, default 600. */
  workboard_window_s: number;
  /** Members of a team candidate, the lead included. Optional, default 4. */
  max_team_size: number;
  /** Eligible bond a team may exclude from replaying its candidate beyond the lead's own group, in bps of the lineage's eligible bond. Optional, default 2500. */
  max_team_excluded_bond_bps: number;
  /** Open candidates a stacked candidate may sit on (its `depends_on` chain until the first final one). Optional, default 3 (SPEC 12.4). */
  max_series_depth: number;
  /** Messages (direct and board) an agent may send per minute. Optional, default 20 (SPEC 12.3). */
  msg_rate_per_min: number;
  /** Messages an agent may send per day. Optional, default 500 (SPEC 12.3). */
  msg_daily: number;
  /** Largest message body (plaintext or ciphertext) in bytes. Optional, default 4096 (SPEC 12.3). */
  msg_max_bytes: number;
  /** Members (= sub-patches) of a team candidate with a measured split. Optional, default 3 (SPEC 12.6, test value). */
  max_split_members: number;
  /** Share of a port's author units credited to the original generation's authors, bps. Optional, default 2000 (SPEC 12.7, test value). */
  port_share_bps: number;
}

const AMOUNT_KEYS = ["register_burn", "min_bond", "bond_cap", "rebate_per_class", "sleep_threshold", "wake_threshold"] as const;
const NUMBER_KEYS = [
  "quorum",
  "max_reassign",
  "det_tolerance",
  "bootstrap_resamples",
  "reveal_window_s",
  "replay_window_factor",
  "replay_window_min_s",
  "canary_rate",
  "audit_rate",
  "max_open_replays",
  "max_open_candidates_per_agent",
  "epoch_length_s",
  "unbond_cooldown_s",
  "reserve_bps",
  "pool_bps",
  "u_replay",
  "u_author",
  "finder_share",
  "value_cap",
  "canary_slash_bps",
  "minority_slash_bps",
  "reveal_slash_bps",
  "strike_limit",
  "token_decimals",
  "agent_compute_bps",
  "protocol_bps",
] as const;

export function parseNetworkConfig(raw: Record<string, unknown>): NetworkConfig {
  const out: Record<string, unknown> = {};
  for (const k of NUMBER_KEYS) {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`network config: ${k} must be a number`);
    out[k] = v;
  }
  for (const k of AMOUNT_KEYS) {
    const v = raw[k];
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`network config: ${k} must be an integer string`);
    const s = String(v);
    if (!/^\d+$/.test(s)) throw new Error(`network config: ${k} must be a non-negative integer`);
    out[k] = BigInt(s);
  }
  const to = raw.author_reward_to ?? "compute";
  if (to !== "compute" && to !== "launcher") throw new Error('network config: author_reward_to must be "compute" or "launcher"');
  out.author_reward_to = to;
  const retry = raw.qualify_retry_s ?? 600;
  if (typeof retry !== "number" || !Number.isFinite(retry) || retry < 0) throw new Error("network config: qualify_retry_s must be a non-negative number");
  out.qualify_retry_s = retry;
  const rate = raw.activity_rate ?? 120;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 1) throw new Error("network config: activity_rate must be a positive integer");
  out.activity_rate = rate;
  const hb = raw.heartbeat_s ?? 10;
  if (typeof hb !== "number" || !Number.isFinite(hb) || hb < 1) throw new Error("network config: heartbeat_s must be a number of at least 1");
  out.heartbeat_s = hb;
  const posInt = (k: string, def: number, min: number) => {
    const v = raw[k] ?? def;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new Error(`network config: ${k} must be an integer of at least ${min}`);
    out[k] = v;
  };
  posInt("audit_replayers", 2, 1);
  posInt("shadow_pool", 3, 0);
  posInt("shadow_launch_spread_s", 3600, 0);
  posInt("shadow_min_age_s", 900, 0);
  const range = (k: string, def: [number, number]) => {
    const v = raw[k] ?? def;
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0) || v[0] > v[1])
      throw new Error(`network config: ${k} must be [min, max] seconds with 0 <= min <= max`);
    out[k] = [v[0], v[1]];
  };
  posInt("max_intents_per_agent", 3, 1);
  posInt("intent_max_ttl_s", 3600, 1);
  posInt("intent_rate_per_hour", 20, 1);
  posInt("workboard_window_s", 600, 1);
  posInt("max_team_size", 4, 2);
  posInt("max_team_excluded_bond_bps", 2500, 0);
  posInt("max_series_depth", 3, 1);
  posInt("msg_rate_per_min", 20, 1);
  posInt("msg_daily", 500, 1);
  posInt("msg_max_bytes", 4096, 64);
  posInt("max_split_members", 3, 2);
  posInt("port_share_bps", 2000, 0);
  if ((out.port_share_bps as number) > 10_000) throw new Error("network config: port_share_bps exceeds 10000");
  range("canary_inject_delay_s", [30, 600]);
  range("canary_reveal_delay_s", [5, 120]);
  const cfg = out as unknown as NetworkConfig;
  if (cfg.agent_compute_bps + cfg.protocol_bps > 10_000) throw new Error("network config: agent_compute_bps + protocol_bps exceeds 10000");
  if (cfg.wake_threshold < cfg.sleep_threshold) throw new Error("network config: wake_threshold below sleep_threshold");
  if (cfg.quorum < 1) throw new Error("network config: quorum must be at least 1");
  if (cfg.reserve_bps + cfg.pool_bps > 10_000) throw new Error("network config: reserve_bps + pool_bps exceeds 10000");
  return cfg;
}

export function loadNetworkConfig(path: string): NetworkConfig {
  return parseNetworkConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** JSON view of the config (amounts as strings). */
export function networkConfigJson(cfg: NetworkConfig): Record<string, unknown> {
  const o: Record<string, unknown> = { ...cfg };
  for (const k of AMOUNT_KEYS) o[k] = cfg[k].toString();
  return o;
}
