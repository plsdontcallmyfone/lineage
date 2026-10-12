#!/usr/bin/env bun
// Adds, updates or removes one sandbox host in the site's hosts file (packages/sandbox/src/remote.ts
// SandboxHostsFile). Run by provision.sh on the site as the runtime's user; the runtime re-reads the
// file every minute, so no restart is needed.
//
//   bun scripts/deploy/capacity-host/register.ts --file <hosts.json> --name <n> --address <ip> [--port 22]
//     --key <private key path> --known-hosts <path> --health '<json from units-sandbox-gw health>'
//   bun scripts/deploy/capacity-host/register.ts --file <hosts.json> --remove <n>
//
// slots is what the host itself reports for evaluations (eval_slots, from its own size: sizing.ts).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseHostsFile, type SandboxHost, type SandboxHostsFile } from "../../../packages/sandbox/src/remote.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const file = opt("file");
if (!file) throw new Error("--file is required");
const doc: SandboxHostsFile & { hosts: (SandboxHost & { registered_at?: string; basis?: string })[] } = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { hosts: [] };
doc._note = "Sandbox hosts for the hosted runtime's evaluations (scripts/deploy/capacity-host/provision.sh, docs/plans/SCALE-OUT.md). The runtime re-reads this file every minute; with no host free or up an evaluation runs on the site.";

const remove = opt("remove");
if (remove) {
  const n = doc.hosts.length;
  doc.hosts = doc.hosts.filter((h) => h.name !== remove);
  console.log(`${n === doc.hosts.length ? `${remove} was not listed` : `removed ${remove}`}; ${doc.hosts.length} host(s) left (evaluations running there finish, no new ones start)`);
} else {
  const name = opt("name")!;
  const address = opt("address")!;
  const health = JSON.parse(opt("health") ?? "null") as { cpus: number; mem_mib: number; eval_slots: number; release: string; docker: boolean } | null;
  if (!health?.cpus || !health.mem_mib) throw new Error("--health (the gateway's answer) is required");
  if (!health.docker) throw new Error("Docker does not answer on the host; not registered");
  if ((health as { eval_job?: boolean }).eval_job === false) throw new Error("the host's release has no evaluation job runner (packages/worker/src/eval-job.ts): deploy the site with the scale-out lane's code, update the host, then register");
  if (!(health.eval_slots >= 1)) throw new Error("the host reports no evaluation slots (ROLE=verifier hosts are not sandbox hosts); not registered");
  const entry = { name, address, port: Number(opt("port") ?? 22), user: "units-cap", key: opt("key")!, known_hosts: opt("known-hosts")!, slots: health.eval_slots, basis: `${health.cpus} cores, ${health.mem_mib} MiB, release ${health.release}`, registered_at: new Date().toISOString() };
  doc.hosts = [...doc.hosts.filter((h) => h.name !== name), entry];
  console.log(`registered ${name} (${address}): ${entry.slots} evaluations at once (${entry.basis})`);
}
parseHostsFile(JSON.stringify(doc)); // refuse to write a file the runtime would not read
writeFileSync(`${file}.tmp`, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
renameSync(`${file}.tmp`, file);
