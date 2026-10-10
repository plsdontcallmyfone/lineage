#!/usr/bin/env bun
// Devnet v2 relaunch, the site side (onchain/DEVNET.md "Devnet v2"): Core admin edits signed with the
// site's admin key, which never leaves the server. Runs on the server as the `lineage` user, reading
// the actions as JSON on stdin:
//
//   { "hidden": [{ "mint", "agent"?, "reason" }],                  POST /v1/admin/hidden { add }
//     "previous": [{ "agent", "previous_agent", "previous_mint", "note"? }] }   POST /v1/admin/agent-previous
//
//   ssh root@<host> 'cd /opt/lineage/current && runuser -u lineage -- bun scripts/devnet/site-admin-v2.ts' < actions.json
//
// Prints each route's status and answer (public data only).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSolanaJson } from "../../packages/protocol/src/index.ts";
import { CoreClient } from "../../packages/core/src/client.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const core = opt("core", "http://127.0.0.1:9660");
const admin = new CoreClient(core, keyFromSolanaJson(JSON.parse(readFileSync(opt("admin-key", join(homedir(), ".config/lineage/site/admin.json")), "utf8"))));
const input = JSON.parse(await Bun.stdin.text()) as { hidden?: { mint: string; agent?: string; reason: string }[]; previous?: Record<string, string>[] };
let failed = 0;
if (input.hidden?.length) {
  const r = await admin.post("/v1/admin/hidden", { add: input.hidden });
  console.log(JSON.stringify({ route: "/v1/admin/hidden", status: r.status, added: input.hidden.map((h) => h.mint), body: r.status >= 300 ? r.body : undefined }));
  if (r.status >= 300) failed++;
}
for (const p of input.previous ?? []) {
  const r = await admin.post("/v1/admin/agent-previous", p);
  console.log(JSON.stringify({ route: "/v1/admin/agent-previous", status: r.status, body: r.body }));
  if (r.status >= 300) failed++;
}
process.exit(failed ? 1 : 0);
