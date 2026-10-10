#!/usr/bin/env bun
// Devnet v2 relaunch: the identity side, run BEFORE the purchased relaunches so the site's identity
// watcher finds each agent ready and never assigns a reserve account (packages/identity/src/adopt.ts).
//   - TSOUL (6C8N2z5L...): import its pool account owunqwxs (assigned to it in the operator's pool file,
//     provisioned by the souls lane before the identity service existed) from the local credential store
//     ~/.lineage/runtime/credentials (token and git signing key), as the coordinator asked 2026-10-10.
//   - Wick Radix and Neap: relaunched under new agent keys; their accounts (agwyus9p, nbebp7jy) move to
//     the new agent ids (rekey). Their earlier records stay as history.
// Input goes over ssh stdin to `main.ts adopt` as the lineage-identity user; no token is ever in argv
// or printed. Agent ids and mints come from scripts/devnet/RELAUNCH-V2.json (relaunch-v2.ts plan).
//
//   bun scripts/devnet/adopt-v2.ts [--host 157.245.71.188] [--only TSOUL,TESTB58,TLAMP]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POOL } from "../../packages/souls/src/github/pool.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const host = opt("host", "157.245.71.188")!;
const only = opt("only") ? new Set(opt("only")!.split(",")) : null;
const MAIN = "/opt/lineage/current/packages/identity/src/main.ts";
const RUN_AS = `runuser -u lineage-identity -- env HOME=/var/lib/lineage/identity/home BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 LINEAGE_IDENTITY_DIR=/var/lib/lineage/identity LINEAGE_IDENTITY_KEY=/etc/lineage-identity/master.key /usr/local/bin/bun ${MAIN}`;
const rows = JSON.parse(readFileSync(join(import.meta.dir, "RELAUNCH-V2.json"), "utf8")).rows as Record<string, { agent: string; old_agent: string; mint: string; launcher: string; repo: string }>;

function adopt(input: unknown): string {
  const r = spawnSync("ssh", ["-i", join(homedir(), ".ssh/lineage_site"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", `root@${host}`, `cd /opt/lineage/current && ${RUN_AS} adopt`],
    { input: JSON.stringify(input), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`adopt failed: ${(r.stderr || "").slice(0, 400)}`);
  return r.stdout.trim().split("\n").pop() ?? "";
}

const now = Math.floor(Date.now() / 1000);
for (const sym of ["TSOUL", "TESTB58", "TLAMP"].filter((s) => !only || only.has(s))) {
  const row = rows[sym];
  if (!row) throw new Error(`${sym}: run relaunch-v2.ts plan first`);
  const base = { agent: row.agent, mint: row.mint, launcher: row.launcher, repo: row.repo, launched_at: now };
  if (sym === "TSOUL") {
    const pool = JSON.parse(readFileSync(DEFAULT_POOL, "utf8"));
    const acct = (pool.accounts ?? pool).find((a: { login: string }) => a.login === "owunqwxs");
    if (!acct || acct.assigned_agent !== row.agent) throw new Error("owunqwxs is not assigned to TSOUL in the pool file");
    const c = JSON.parse(readFileSync(join(homedir(), ".lineage/runtime/credentials", `${row.agent}.json`), "utf8"));
    if (c.login !== "owunqwxs") throw new Error("the local credential of TSOUL is not owunqwxs");
    const cred = { login: c.login, github_id: c.github_id, token: c.token, ssh_private_key: readFileSync(c.ssh_private_key_path, "utf8"), ssh_public_key: c.ssh_public_key,
      ssh_signing_key_id: c.ssh_signing_key_id, assigned_at: c.assigned_at };
    console.log(`${sym}: ${adopt({ ...base, cred })}`);
  } else console.log(`${sym}: ${adopt({ ...base, from_agent: row.old_agent })}`);
}
