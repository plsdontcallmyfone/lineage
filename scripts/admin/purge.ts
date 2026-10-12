#!/usr/bin/env bun
// Purge a launch for good (packages/core/src/purge.ts): the agent, its coin's rows, everything it
// produced, and the units it built go back to generation 0. Runs on the server, as the user that may
// read Core's admin key, against the Core of that instance:
//
//   bun scripts/admin/purge.ts --core http://127.0.0.1:9760 --admin-key /etc/units-main-core/admin.json \
//     --agent <agent id> [--mint <coin mint>] [--agent ... --mint ...] --plan
//
// --plan    prints what a run would delete, per table, and changes nothing (the same code, rolled back)
// (no flag) Core first writes a consistent copy of its database (VACUUM INTO) to
//           <data>/purge-backups/pre-purge-<time>-<pid>.db, or to --backup-dir, and refuses without it
// --force   also purges while a candidate, a replay or a session of the agent is open
// --mint    checked against the coin Core holds for the agent before anything is sent
//
// Exit 0: done (or planned). Exit 1: refused; Core's reason is printed and nothing was changed.
import { readFileSync } from "node:fs";
import { CoreClient } from "../../packages/core/src/client.ts";
import { keyFromSolanaJson } from "../../packages/protocol/src/index.ts";

const argv = process.argv.slice(2);
const all = (k: string) => argv.flatMap((a, i) => (a === `--${k}` && argv[i + 1] ? [argv[i + 1]!] : []));
const one = (k: string) => all(k)[0];
const flag = (k: string) => argv.includes(`--${k}`);
const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const core = one("core") ?? fail("--core <url of this instance's Core> is required");
const keyFile = one("admin-key") ?? fail("--admin-key <file> is required");
const agents = all("agent");
const mints = all("mint");
if (!agents.length) fail("--agent <agent id> is required (repeat for more)");
if (mints.length && mints.length !== agents.length) fail("give one --mint per --agent, in the same order, or none");

const admin = new CoreClient(core, keyFromSolanaJson(JSON.parse(readFileSync(keyFile, "utf8"))));
for (const [i, a] of agents.entries()) {
  const r = await admin.get(`/v1/agents/${a}`);
  if (r.status === 404) {
    console.log(`${a}: not in this Core (purged already, or never here)`);
    continue;
  }
  if (r.status >= 300) fail(`${a}: Core answered ${r.status} ${JSON.stringify(r.body)}`);
  if (mints[i] && r.body.mint !== mints[i]) fail(`${a}: Core holds coin ${r.body.mint}, not ${mints[i]}. Nothing was sent.`);
  console.log(`${a}: kind ${r.body.kind}, coin ${r.body.mint ?? "none"}`);
}

const plan = flag("plan");
const body = { agents, ...(plan ? { plan: true } : {}), ...(flag("force") ? { force: true } : {}), ...(one("backup-dir") ? { backup_dir: one("backup-dir") } : {}), ...(one("note") ? { note: one("note") } : {}) };
const r = await admin.post("/v1/admin/purge", body);
if (r.status >= 300) fail(`REFUSED (${r.status} ${r.body?.error ?? ""}): ${r.body?.message ?? JSON.stringify(r.body)}`);
const rep = r.body as { agents: number; already_purged: number; tables: Record<string, { action: string; rows: number }>; units_reset: { lineage_id: string; height_before: number; generations_removed: number }[]; ledger: { transactions_removed: number; accounts_recomputed: number }; blobs_removed: number; backup: string | null; scanned: { tables: number; rows: number } };
console.log(plan ? "\nPLAN (nothing was changed). A run would:" : "\nDONE.");
console.log(`  agents ${plan ? "to purge" : "purged"}: ${rep.agents}${rep.already_purged ? `, purged before: ${rep.already_purged}` : ""}`);
const w = Math.max(5, ...Object.keys(rep.tables).map((t) => t.length));
console.log(`  ${"table".padEnd(w)}  ${"rows".padStart(8)}  what`);
for (const [t, x] of Object.entries(rep.tables).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${t.padEnd(w)}  ${String(x.rows).padStart(8)}  ${x.action}`);
for (const u of rep.units_reset) console.log(`  unit ${u.lineage_id}: generation ${u.height_before} to 0 (${u.generations_removed} generation rows), calibration and qualifications kept`);
console.log(`  ledger: ${rep.ledger.transactions_removed} transactions, ${rep.ledger.accounts_recomputed} balances recomputed; reconciles`);
console.log(`  checked after: every cell of ${rep.scanned.rows} rows in ${rep.scanned.tables} tables, none names the launch`);
if (!plan) {
  console.log(`  database copy taken before: ${rep.backup ?? "none (nothing was left to delete)"}`);
  console.log(`  files removed from the blob store: ${rep.blobs_removed}`);
  const listed = await admin.get("/v1/purged");
  console.log(`  GET /v1/purged lists ${listed.body?.count ?? "?"} launch(es); the runtime and the indexer drop them on their next pass`);
}
