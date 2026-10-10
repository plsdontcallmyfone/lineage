#!/usr/bin/env bun
// Sets the publisher account on the site's identity service (docs/plans/GENERATIONS-ON-GITHUB.md 1.1, 6):
// the Lineage-owned GitHub account that signs and pushes the mirror commits of app-identity agents.
//
//   bun scripts/identity/set-publisher.ts --host <server> --token-file <file> [--ssh-key ~/.ssh/lineage_site]
//   bun scripts/identity/set-publisher.ts --host <server> --status
//
// The token is read from the local file and sent over ssh stdin to `main.ts publisher-set`, which runs
// as the identity user: it validates the token, refuses reserved, pool, reserve and agent logins,
// registers an SSH signing key on the account and stores it encrypted. The token is never printed.
// The next identity cycle (every 5 minutes) publishes the generations queued as "awaiting publisher".
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const host = opt("host");
const tokenFile = opt("token-file");
if (!host || (!tokenFile && !argv.includes("--status"))) {
  console.error("usage: set-publisher.ts --host <server> (--token-file <file> | --status) [--ssh-key <file>]");
  process.exit(2);
}
const sshKey = opt("ssh-key", join(homedir(), ".ssh/lineage_site"))!;
const RUN_AS = "runuser -u lineage-identity -- env HOME=/var/lib/lineage/identity/home BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 LINEAGE_IDENTITY_DIR=/var/lib/lineage/identity LINEAGE_IDENTITY_KEY=/etc/lineage-identity/master.key LINEAGE_IDENTITY_RUN=/run/lineage-identity-publisher /usr/local/bin/bun packages/identity/src/main.ts";
const cmd = tokenFile ? "publisher-set" : "publisher-status";
const input = tokenFile ? readFileSync(tokenFile, "utf8").trim() + "\n" : undefined;
const r = spawnSync("ssh", ["-i", sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `root@${host}`, `cd /opt/lineage/current && ${RUN_AS} ${cmd}`], { input, encoding: "utf8" });
process.stdout.write(r.stdout ?? "");
process.stderr.write((r.stderr ?? "").replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "<token>"));
process.exit(r.status ?? 1);
