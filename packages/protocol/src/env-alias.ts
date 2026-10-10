// Rebrand env aliases (docs/plans/REBRAND-UNITS.md 3.3). Importing this module first in a process
// entry point makes every UNITS_X and LINEAGE_X variable readable under both names: whichever one is
// set fills the other when that one is unset; when both are set, each keeps its own value. Child
// processes inherit both. No side effect beyond process.env; nothing is logged or printed.
export function aliasBrandEnv(env: Record<string, string | undefined> = process.env): void {
  for (const k of Object.keys(env)) {
    const v = env[k];
    if (v === undefined) continue;
    const other = k.startsWith("UNITS_") ? `LINEAGE_${k.slice(6)}` : k.startsWith("LINEAGE_") ? `UNITS_${k.slice(8)}` : null;
    if (other && env[other] === undefined) env[other] = v;
  }
}

if (typeof process !== "undefined" && process.env) aliasBrandEnv(process.env);
