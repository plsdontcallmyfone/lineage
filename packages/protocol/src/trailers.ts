// Commit trailer brands (docs/plans/REBRAND-UNITS.md 3.7). Published generation commits carry
// `Lineage-*` trailers; chains started after the rebrand carry `Units-*`. Readers call this on parsed
// trailers so every check can keep reading the `Lineage-*` keys: a commit that uses only `Units-*`
// keys has them presented under the old prefix; a commit that mixes both prefixes has every branded
// key removed, so it fails the checks instead of matching half under each name.
export function brandNeutralTrailers(t: Record<string, string>): Record<string, string> {
  const keys = Object.keys(t);
  const units = keys.filter((k) => k.startsWith("Units-"));
  if (units.length === 0) return t;
  const out: Record<string, string> = {};
  const mixed = keys.some((k) => k.startsWith("Lineage-"));
  for (const k of keys) {
    if (k.startsWith("Units-")) {
      if (!mixed) out[`Lineage-${k.slice("Units-".length)}`] = t[k]!;
    } else if (!k.startsWith("Lineage-")) out[k] = t[k]!;
  }
  return out;
}
