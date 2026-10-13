#!/usr/bin/env bun
// Verifies an accepted generation against its public GitHub commit (docs/plans/GENERATIONS-ON-GITHUB.md 5).
//
//   bun scripts/identity/verify-generation.ts <gen_id> [--core <units site or Core base URL>] [--json]
//
// Reads the generation from Core (GET /v1/generations/:id, its `github` field), the commit from
// GitHub's public API and the git objects with `git fetch`, and checks: trailers name the generation,
// lineage, height, Core's patch_hash, verdict and author; the commit's diff is Core's patch (same
// patch_hash, or the same tree when git re-diffs with other context); its parent is the parent
// generation's recorded commit (the pinned snapshot commit at height 1); GitHub shows it Verified.
// No credentials are needed; GITHUB_TOKEN, when set, only raises the API rate limit.
// Exit 0 when every check passes (a warning still passes), 1 otherwise. A generation whose commit was
// in a repository deleted on purpose (Core's github status "removed", docs/plans/GITHUB-ORG.md 6)
// prints the reason and exits 0: there is nothing on GitHub to verify, and that is explained, not a failure.
import { verifyGeneration } from "../../packages/mirror/src/verify.ts";

const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const genId = argv.find((a, i) => /^[0-9a-f]{64}$/.test(a) && argv[i - 1] !== "--core");
if (!genId) {
  console.error("usage: verify-generation.ts <gen_id (64 hex)> [--core <url>] [--json]");
  process.exit(2);
}
const core = (opt("core") ?? (process.env.UNITS_CORE ?? process.env.LINEAGE_CORE) ?? "https://app.units.gg").replace(/\/+$/, "");
const r = await verifyGeneration({ core, genId, token: process.env.GITHUB_TOKEN || null });
if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
else {
  console.log(`generation ${genId}`);
  if (r.url) console.log(`commit     ${r.url}`);
  for (const c of r.checks) console.log(`${c.ok === true ? "PASS" : c.ok === null ? "WARN" : "FAIL"} ${c.name}: ${c.detail}`);
  console.log(r.removed ? "removed from GitHub (explained above); nothing to verify there" : r.ok ? "verified" : "NOT verified");
}
process.exit(r.ok ? 0 : 1);
