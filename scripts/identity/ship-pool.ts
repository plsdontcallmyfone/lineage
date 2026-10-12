#!/usr/bin/env bun
// Sends GitHub accounts of the local pool to an instance's identity service, through the owner's ledger
// (pool-ledger.ts), so that no account ever reaches two instances or two agents.
//
//   bun scripts/identity/ship-pool.ts seed [--exclusions <file>] [--exclusions-instance devnet]
//       makes or completes the ledger from the local pool file (every account that is not plainly
//       available) and an optional list of logins, one per line. Sends nothing.
//   bun scripts/identity/ship-pool.ts plan --instance mainnet [--count N | --all]
//       read only, no network: what would go, what is refused and why (logins and counts)
//   IDENTITY_POOL_SEND=yes bun scripts/identity/ship-pool.ts ship --instance mainnet --host <server> (--count N | --all)
//       checks each token (GET /user, read only), writes the ledger entry and marks the pool file, THEN
//       sends over ssh stdin to `remote-instance.sh mainnet identity-pool` (main.ts reserve-add, run as the
//       identity account, which encrypts them). A re-run sends again only what was not confirmed.
//   bun scripts/identity/ship-pool.ts sync --instance mainnet|devnet --host <server>
//       read only on the server (reserve-list): assignments and unknown logins into the ledger
//   bun scripts/identity/ship-pool.ts status
//       ledger counts
// Common: --pool <file> (default ~/.config/lineage/github-pool.json), --ledger <file> (default
// ~/.config/units/github-pool-ledger.json), --ssh-key, --ssh-port, --ssh-user.
// scripts/deploy/instance.sh <host> identity-pool-plan | identity-pool | identity-pool-sync call this.
// Tokens never appear in argv, output or logs: only logins are printed.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POOL, Pool, type PoolAccount } from "../../packages/souls/src/github/pool.ts";
import { DEFAULT_LEDGER, Ledger, planShip, seed, ship, syncFromServer } from "./pool-ledger.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const has = (k: string) => argv.includes(`--${k}`);
const usage = () => {
  console.error("usage: ship-pool.ts seed [--exclusions <file>] | plan --instance <name> [--count N | --all] | ship --instance <name> --host <server> (--count N | --all) | sync --instance <name> --host <server> | status   (see the header)");
  process.exit(2);
};
if (!["seed", "plan", "ship", "sync", "status"].includes(cmd ?? "")) usage();

const pool = new Pool(opt("pool", DEFAULT_POOL)!);
const ledger = new Ledger(opt("ledger", DEFAULT_LEDGER)!);
const instance = opt("instance");
const host = opt("host") ?? null;
const INSTANCES: Record<string, { add: string; list: string }> = {
  // a second instance: remote-instance.sh runs main.ts as the instance's identity account with its RPC env
  mainnet: { add: "bash /root/lineage-deploy/remote-instance.sh mainnet identity-pool", list: "bash /root/lineage-deploy/remote-instance.sh mainnet identity-pool-list" },
  // the first instance, as push-reserve.ts reaches it
  devnet: (() => {
    const run = "cd /opt/units/current && runuser -u units-identity -- env HOME=/var/lib/units/identity/home BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 UNITS_NETWORK=devnet UNITS_IDENTITY_DIR=/var/lib/units/identity UNITS_IDENTITY_KEY=/etc/units-identity/master.key /usr/local/bin/bun /opt/units/current/packages/identity/src/main.ts";
    return { add: `${run} reserve-add`, list: `${run} reserve-list` };
  })(),
};
function needInstance(): string {
  if (!instance || !INSTANCES[instance]) {
    console.error(`--instance is one of: ${Object.keys(INSTANCES).join(", ")}`);
    process.exit(2);
  }
  return instance;
}
function ssh(remote: string, input?: string): string {
  if (!host) {
    console.error("--host <server> is needed");
    process.exit(2);
  }
  const r = spawnSync("ssh", ["-i", opt("ssh-key", join(homedir(), ".ssh/lineage_site"))!, "-p", opt("ssh-port", "22")!, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${opt("ssh-user", "root")}@${host}`, remote], { input: input ?? "", encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`ssh failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  return r.stdout.trim().split("\n").pop() ?? "";
}
function countOpt(required: boolean): number | null {
  if (has("all")) return null;
  const c = opt("count");
  if (c !== undefined && /^[1-9]\d*$/.test(c)) return Number(c);
  if (required || c !== undefined) {
    console.error("say how many: --count N (a positive whole number) or --all");
    process.exit(2);
  }
  return null;
}
const loginsOf = (a: PoolAccount[]) => a.map((x) => x.login).join(", ") || "none";

if (cmd === "status") {
  console.log(JSON.stringify({ ledger: ledger.path, exists: existsSync(ledger.path), counts: ledger.summary(), pool: pool.summary() }, null, 2));
} else if (cmd === "seed") {
  const f = opt("exclusions");
  const exclusions = f ? readFileSync(f, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter((l) => /^[A-Za-z0-9-]{1,39}$/.test(l)) : [];
  const r = seed(pool, ledger, { exclusions, exclusionsInstance: opt("exclusions-instance") ?? null });
  // an empty ledger is still written, so its absence never reads as "nothing was ever sent"
  if (!existsSync(ledger.path)) ledger.write(ledger.read());
  console.log(`ledger ${ledger.path}: ${r.added.length} entries added (${r.added.join(", ") || "none"}); now ${JSON.stringify(ledger.summary())}`);
} else if (cmd === "plan") {
  const inst = needInstance();
  const p = planShip(pool, ledger, inst, { count: countOpt(false) });
  if (!existsSync(ledger.path)) console.log(`NOTE: no ledger at ${ledger.path} yet; run seed first so earlier shipments and assignments are counted`);
  console.log(`to ${inst}: ${p.fresh.length} never sent anywhere${p.held_back ? ` (${p.held_back} more qualify, held back by --count)` : ""}, ${p.resend.length} to send again (written to the ledger for ${inst}, not confirmed)`);
  console.log(`would send: ${loginsOf([...p.resend, ...p.fresh])}`);
  console.log(`refused (${p.refused.length}): ${p.refused.map((r) => `${r.login} [${r.why}]`).join("; ") || "none"}`);
  console.log("plan only: nothing was sent, no token was checked, no file was written");
} else if (cmd === "sync") {
  const inst = needInstance();
  const server = JSON.parse(ssh(INSTANCES[inst]!.list)) as { accounts: { login: string; status: string; assigned_agent: string | null }[] };
  const r = syncFromServer(ledger, inst, server.accounts);
  console.log(`${inst} reserve: ${server.accounts.length} accounts (${server.accounts.filter((a) => a.assigned_agent).length} bound to an agent); ledger entries changed: ${r.recorded.join(", ") || "none"}`);
} else {
  const inst = needInstance();
  if (process.env.IDENTITY_POOL_SEND !== "yes") {
    console.error(`ship sends GitHub accounts to the ${inst} instance and marks them used for good: run plan first, then IDENTITY_POOL_SEND=yes with the owner's approval`);
    process.exit(1);
  }
  if (!existsSync(ledger.path)) {
    console.error(`no ledger at ${ledger.path}: run \`ship-pool.ts seed\` first (it records what earlier went to devnet), then plan`);
    process.exit(1);
  }
  const count = countOpt(true);
  const r = await ship({
    pool, ledger, instance: inst, host, count, log: (m) => console.log(m),
    verify: async (a) => {
      const res = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${a.token}`, accept: "application/vnd.github+json", "user-agent": "units-ship-pool" } });
      const u: any = res.ok ? await res.json() : null;
      if (u && String(u.login).toLowerCase() === a.login.toLowerCase()) return { ok: true };
      return { ok: false, why: `token does not answer for this login (HTTP ${res.status})`, invalid: res.status === 401 || (res.ok && !!u) };
    },
    transfer: async (lines) => JSON.parse(ssh(INSTANCES[inst]!.add, lines)),
  });
  console.log(`sent to ${inst}: ${r.sent.length} (${r.sent.join(", ") || "none"})`);
  console.log(`server: added ${r.added.length}, already there ${r.present.length}, refused ${r.refused_by_server.length}${r.refused_by_server.length ? ` (${r.refused_by_server.join(", ")}; they stay marked for ${inst} in the ledger)` : ""}`);
  if (r.skipped.length) console.log(`not sent (${r.skipped.length}): ${r.skipped.map((s) => `${s.login} [${s.why}]`).join("; ")}`);
  console.log(`ledger ${ledger.path}: ${JSON.stringify(ledger.summary())}`);
}
