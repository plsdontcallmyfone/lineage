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
