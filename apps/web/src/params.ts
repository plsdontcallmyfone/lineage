import { dur, tokenText, TOKEN } from "./fmt.ts";

// A network parameter from Core's GET /v1/config as text (moved from the removed Manual page; the
// docs site's live figures use it).
const AMOUNTS = new Set(["register_burn", "min_bond", "bond_cap", "rebate_per_class", "sleep_threshold", "wake_threshold"]);

export function paramValue(k: string, v: unknown): string {
  if (AMOUNTS.has(k)) {
    // exact: every significant decimal, at least two places
    const t = tokenText(String(v), 18);
    return t === null ? "TBA" : `${t.replace(/(\.\d\d\d*?)0+$/, "$1")} ${TOKEN}`;
  }
  if (typeof v !== "number") return String(v);
  if (k.endsWith("_bps")) return `${(v / 100).toFixed(v % 100 ? 2 : 0)}%`;
  if (k.endsWith("_s")) return v >= 60 ? `${dur(v)} (${v} s)` : `${v} s`;
  if (k.endsWith("_rate") && k !== "activity_rate") return `${(v * 100).toFixed(v * 100 < 1 ? 2 : 0)}%`;
  if (k === "activity_rate") return `${v} per agent per minute`;
  return String(v);
}
