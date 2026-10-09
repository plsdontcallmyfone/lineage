#!/usr/bin/env bun
// Tops up the identity service's encrypted reserve on the site from the local account pool
// (~/.config/lineage/github-pool.json), so the whole pool is never on the server (plan B).
//
//   bun scripts/identity/push-reserve.ts --host <server> [--target 5] [--ssh-key ~/.ssh/lineage_site] [--pool <file>] [--plan]
//
// 1. Reads the server reserve (logins and statuses only) and copies what happened there back into
//    the local pool file: an account the service assigned is recorded as assigned to that agent, one
//    it found unusable keeps its status (token_invalid, excluded).
// 2. When fewer than --target accounts are available on the server, takes the next local accounts
//    that are available, not excluded by login and not reserved, checks each token still answers
//    GET /user for its login (read only), and sends them over ssh stdin to `main.ts reserve-add`, run
//    as the lineage-identity user, which encrypts them. Pushed accounts are marked server_reserve
//    locally, so nothing here assigns them again.
// Tokens never appear in argv, output or logs: only logins are printed.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POOL, EXCLUDED_LOGINS, Pool } from "../../packages/souls/src/github/pool.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const host = opt("host");
if (!host) {
  console.error("usage: push-reserve.ts --host <server> [--target 5] [--ssh-key <file>] [--pool <file>] [--plan]");
  process.exit(2);
}
const target = Number(opt("target", "5"));
const plan = argv.includes("--plan");
const sshKey = opt("ssh-key", join(homedir(), ".ssh/lineage_site"))!;
const pool = new Pool(opt("pool", DEFAULT_POOL)!);
const MAIN = "/opt/lineage/current/packages/identity/src/main.ts";
const RUN_AS = `runuser -u lineage-identity -- env HOME=/var/lib/lineage/identity/home BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 LINEAGE_IDENTITY_DIR=/var/lib/lineage/identity LINEAGE_IDENTITY_KEY=/etc/lineage-identity/master.key /usr/local/bin/bun ${MAIN}`;

function ssh(cmd: string, input?: string): string {
  const r = spawnSync("ssh", ["-i", sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `root@${host}`, `cd /opt/lineage/current && ${cmd}`], { input, encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`ssh ${cmd.split(" ").slice(-1)[0]} failed: ${(r.stderr || "").slice(0, 400)}`);
  return r.stdout.trim().split("\n").pop() ?? "";
}

const server = JSON.parse(ssh(`${RUN_AS} reserve-list`)) as { accounts: { login: string; status: string; assigned_agent: string | null; note: string | null }[] };
const local = pool.read();
for (const s of server.accounts) {
  const a = local.accounts.find((x) => x.login === s.login);
  if (!a) continue;
  const want = s.status === "available" || s.status === "assigning" ? "server_reserve" : s.status;
  if (a.status !== want || a.assigned_agent !== s.assigned_agent) {
    console.log(`sync ${s.login}: ${a.status} -> ${want}${s.assigned_agent ? ` (agent ${s.assigned_agent})` : ""}`);
    if (!plan) pool.update(s.login, { status: want, assigned_agent: s.assigned_agent, note: `server reserve (lineage-identity): ${s.status}${s.note ? `, ${s.note}` : ""}` });
  }
}
const available = server.accounts.filter((a) => a.status === "available").length;
const need = Math.max(0, target - available);
console.log(`server reserve: ${available} available of ${server.accounts.length}; target ${target}; pushing ${need}`);

const picked: { login: string; token: string }[] = [];
for (const a of pool.candidates(EXCLUDED_LOGINS)) {
  if (picked.length >= need) break;
  if (server.accounts.some((s) => s.login === a.login)) continue;
  const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${a.token}`, accept: "application/vnd.github+json", "user-agent": "lineage-push-reserve" } });
  const u: any = r.ok ? await r.json() : null;
  if (!u || String(u.login).toLowerCase() !== a.login.toLowerCase()) {
    console.log(`skip ${a.login}: token does not answer for this login (HTTP ${r.status})`);
    if (!plan && (r.status === 401 || r.status === 403)) pool.update(a.login, { status: "token_invalid", note: `push-reserve: GitHub answered ${r.status}` });
    continue;
  }
  picked.push({ login: a.login, token: a.token });
}
if (!picked.length) process.exit(0);
if (plan) {
  console.log(`plan: would push ${picked.map((p) => p.login).join(", ")}`);
  process.exit(0);
}
const res = JSON.parse(ssh(`${RUN_AS} reserve-add`, picked.map((p) => JSON.stringify(p)).join("\n") + "\n")) as { added: string[]; present: string[]; refused: string[] };
const at = new Date().toISOString();
for (const l of [...res.added, ...res.present]) pool.update(l, { status: "server_reserve", note: `pushed to the site reserve ${at}` });
console.log(`pushed: ${res.added.join(", ") || "none"}${res.present.length ? `; already there: ${res.present.join(", ")}` : ""}${res.refused.length ? `; refused: ${res.refused.join(", ")}` : ""}`);
