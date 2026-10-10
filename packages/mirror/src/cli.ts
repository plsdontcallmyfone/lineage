#!/usr/bin/env bun
// lineage-mirror: one mirror cycle (SPEC 16, plan W1), optionally followed by the PR bot (W2).
//
//   bun packages/mirror/src/cli.ts --core <url> [--site <url>] [--lineage <id prefix>]... [--agent <id>]...
//       [--credentials <dir>] [--dry-run] [--no-verify] [--report <file.json>]
//       [--pr --runtime-key <keyfile.json>]
//
// Credentials come from the runtime-only store (default ~/.lineage/runtime/credentials); tokens are
// never printed, and the report holds logins, forks, commit ids and verification results only.

import "../../protocol/src/env-alias.ts"; // first: UNITS_* and LINEAGE_* env names both readable (docs/plans/REBRAND-UNITS.md 3.3)
import { readFileSync, writeFileSync } from "node:fs";
import { FileCredentialStore, DEFAULT_STORE } from "../../souls/src/github/credentials.ts";
import { keyFromSolanaJson } from "../../protocol/src/auth.ts";
import { CoreReader } from "./coreapi.ts";
import { mirrorOnce, storeIdentities } from "./mirror.ts";
import { prCycle } from "./prbot.ts";

const argv = process.argv.slice(2);
const one = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const many = (n: string) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]!] : []));
const core = one("core");
if (!core) {
  console.error("usage: lineage-mirror --core <url> [--site <url>] [--lineage <id>] [--agent <id>] [--credentials <dir>] [--dry-run] [--no-verify] [--report <file>] [--pr --runtime-key <file>]");
  process.exit(2);
}
const log = (m: string) => console.log(`[mirror] ${m}`);
const reader = new CoreReader(core);
const identities = storeIdentities(new FileCredentialStore(one("credentials") ?? DEFAULT_STORE));
const pr = argv.includes("--pr");
const report = await mirrorOnce({
  core: reader, identities, site: one("site"), lineages: many("lineage"), agents: many("agent"),
  dryRun: argv.includes("--dry-run"), verify: !argv.includes("--no-verify"), log,
});
let prs: unknown = null;
if (pr) {
  const keyFile = one("runtime-key");
  if (!keyFile) throw new Error("--pr needs --runtime-key (Core accepts PR records from its runtime or admin key only)");
  const raw = JSON.parse(readFileSync(keyFile, "utf8"));
  const key = Array.isArray(raw) ? keyFromSolanaJson(raw) : raw;
  prs = await prCycle({ core: reader, coreUrl: core, runtimeKey: key, identities, mirror: report, dryRun: argv.includes("--dry-run"), log });
}
const { chains: _chains, ...out } = report;
const json = JSON.stringify({ ...out, prs }, null, 2) + "\n";
if (one("report")) writeFileSync(one("report")!, json);
for (const l of report.lineages) log(`${l.recipe} ${l.lineage_id.slice(0, 8)}: ${l.status}${l.detail ? ` (${l.detail})` : ""}${l.pushes.map((p) => `; ${p.login} ${p.action}`).join("")}`);
for (const g of report.generations) log(`  gen ${g.height} ${g.gen_id.slice(0, 12)} ${g.status} ${g.identity}${g.login ? ` ${g.login}` : ""} ${g.sha?.slice(0, 12) ?? "-"} verified=${g.verified}`);
