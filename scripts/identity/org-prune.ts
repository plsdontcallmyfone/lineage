#!/usr/bin/env bun
// Deletes the units-agents organization's old per-upstream mirror forks (owner decision 2026-10-11,
// docs/plans/GITHUB-ORG.md 6) and marks Core's records of the commits they held as removed.
//
//   bun scripts/identity/org-prune.ts --host <server> [--delete] [--mark-core] [--repos a/b,c/d] [--ssh-key ~/.ssh/lineage_site]
//
// Runs itself over ssh on the server as the identity user (the publisher token stays in the
// encrypted store and is never printed). Without --delete it only lists. Always kept:
// units-learnings, findings, generations. --delete needs the publisher token's delete_repo scope;
// without it nothing is deleted, the exit code is 3 and the list is printed for the owner.
// --mark-core posts { removed: { repos, reason } } to Core (POST /v1/github/generations, the identity
// Core key) for the repositories deleted in this run, or those named with --repos (a rerun after the
// owner deleted them by hand), each with its pre-move <publisher>/<name> name as well.
//
// On the server (internal): bun scripts/identity/org-prune.ts --remote [--delete] [--mark-core] [--repos ...]

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);

const KEEP = ["units-learnings", "findings", "generations"];
const REASON = "test data, repository deleted 2026-10-11";
const REPOS = opt("repos");
if (REPOS && !/^[A-Za-z0-9_.\/,-]+$/.test(REPOS)) {
  console.error("--repos: owner/name,owner/name");
  process.exit(2);
}

if (!flag("remote")) {
  const host = opt("host");
  if (!host) {
    console.error("usage: org-prune.ts --host <server> [--delete] [--mark-core] [--repos a/b,c/d] [--ssh-key <file>]");
    process.exit(2);
  }
  const sshKey = opt("ssh-key", join(homedir(), ".ssh/lineage_site"))!;
  const pass = [...["delete", "mark-core"].filter(flag).map((f) => `--${f}`), ...(REPOS ? ["--repos", REPOS] : [])].join(" ");
  const RUN_AS =
    "runuser -u units-identity -- env HOME=/var/lib/units/identity/home BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 UNITS_IDENTITY_DIR=/var/lib/units/identity UNITS_IDENTITY_KEY=/etc/units-identity/master.key UNITS_IDENTITY_CORE_KEY=/etc/units-identity/core-key.json UNITS_CORE=http://127.0.0.1:9660 /usr/local/bin/bun scripts/identity/org-prune.ts --remote";
  const r = spawnSync("ssh", ["-i", sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `root@${host}`, `cd /opt/units/current && ${RUN_AS} ${pass}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  process.exit(r.status ?? 1);
}

const { EncryptedStore } = await import("../../packages/identity/src/store.ts");
const { GitHub, redactTokens } = await import("../../packages/souls/src/github/api.ts");
const store = new EncryptedStore(process.env.UNITS_IDENTITY_DIR ?? "/var/lib/units/identity", process.env.UNITS_IDENTITY_KEY ?? "/etc/units-identity/master.key");
const pub = store.get<{ login: string; token: string; owner?: string | null }>("publisher", "app");
if (!pub) {
  console.error("no publisher account is configured");
  process.exit(1);
}
const org = pub.owner && pub.owner.toLowerCase() !== pub.login.toLowerCase() ? pub.owner : "units-agents";
const gh = new GitHub({ token: pub.token });
const me = await gh.request<{ login: string }>("GET", "/user");
const scopes = (me.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const list = async () => (await gh.paged<{ name: string; full_name: string }>(`/orgs/${org}/repos?type=all`)).map((r) => r.full_name);
const before = await list();
const keep = before.filter((full) => KEEP.includes(full.split("/")[1]!.toLowerCase()));
const doomed = before.filter((full) => !keep.includes(full));
const out: Record<string, unknown> = { org, publisher: me.data.login, scopes, before, keep, delete: doomed };
const deleted: string[] = [];
const failed: { repo: string; why: string }[] = [];

if (flag("delete")) {
  if (!scopes.includes("delete_repo")) {
    out.result = "stopped: the publisher token lacks the delete_repo scope; nothing was deleted";
    console.log(JSON.stringify(out, null, 2));
    process.exit(3);
  }
  for (const full of doomed) {
    try {
      const r = await gh.request("DELETE", `/repos/${full}`, undefined, { okStatuses: [404] });
      if (r.status === 204 || r.status === 404) deleted.push(full);
      else failed.push({ repo: full, why: `status ${r.status}` });
    } catch (e) {
      failed.push({ repo: full, why: redactTokens((e as Error).message).slice(0, 200) });
    }
  }
  out.deleted = deleted;
  out.failed = failed;
}

if (flag("mark-core")) {
  const named = (REPOS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const marks = [...new Set([...deleted, ...named].flatMap((full) => [full, `${pub.login}/${full.split("/")[1]}`]))];
  if (marks.length) {
    const { CoreClient } = await import("../../packages/core/src/client.ts");
    const { keyFromSolanaJson } = await import("../../packages/protocol/src/index.ts");
    const raw = JSON.parse(readFileSync(process.env.UNITS_IDENTITY_CORE_KEY ?? "/etc/units-identity/core-key.json", "utf8"));
    const cc = new CoreClient((process.env.UNITS_CORE ?? "http://127.0.0.1:9660").replace(/\/+$/, ""), Array.isArray(raw) ? keyFromSolanaJson(raw) : raw);
    const r = await cc.post("/v1/github/generations", { removed: { repos: marks, reason: REASON } });
    out.core = { status: r.status, repos: marks, removed: r.body?.removed ?? r.body, reason: REASON };
  } else out.core = { repos: [], removed: [] };
}
out.after = await list();
console.log(JSON.stringify(out, null, 2));
process.exit(failed.length ? 1 : 0);
