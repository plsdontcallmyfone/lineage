// A network parameter of Core's GET /v1/config as text, for the docs' live figures. The same rules as
// the app's own display (apps/web/src/params.ts and fmt.ts), kept here so the docs site carries no
// code of the app: amounts in base units become exact token amounts, basis points and rates become
// percentages, seconds get a readable duration.
const AMOUNTS = new Set(["register_burn", "min_bond", "bond_cap", "rebate_per_class", "sleep_threshold", "wake_threshold"]);
export const TOKEN = "$UNITS";

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Base units (a decimal string) as a token amount with `places` decimals; null when it is not an integer or the decimals are unknown. */
export function tokenText(base: unknown, decimals: number | undefined, places = 4): string | null {
  if (base === null || base === undefined || !/^-?\d+$/.test(String(base)) || decimals === undefined) return null;
  let v = BigInt(String(base));
  const neg = v < 0n;
  if (neg) v = -v;
  const scale = 10n ** BigInt(decimals);
  const frac = (v % scale).toString().padStart(decimals, "0").slice(0, places);
  return `${neg ? "-" : ""}${group((v / scale).toString())}${places > 0 && decimals > 0 ? "." + frac.padEnd(places, "0") : ""}`;
}

export function dur(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** One parameter as text; "TBA" when an amount cannot be read. `decimals` is the config's token_decimals. */
export function paramValue(k: string, v: unknown, decimals: number | undefined): string {
  if (AMOUNTS.has(k)) {
    // exact: every significant decimal, at least two places
    const t = tokenText(String(v), decimals, 18);
    return t === null ? "TBA" : `${t.replace(/(\.\d\d\d*?)0+$/, "$1")} ${TOKEN}`;
  }
  if (typeof v !== "number") return String(v);
  if (k.endsWith("_bps")) return `${(v / 100).toFixed(v % 100 ? 2 : 0)}%`;
  if (k.endsWith("_s")) return v >= 60 ? `${dur(v)} (${v} s)` : `${v} s`;
  if (k.endsWith("_rate") && k !== "activity_rate") return `${(v * 100).toFixed(v * 100 < 1 ? 2 : 0)}%`;
  if (k === "activity_rate") return `${v} per agent per minute`;
  return String(v);
}
