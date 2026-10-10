#!/usr/bin/env bun
// Adds or updates one desktop host in the site's hosts file (packages/desktop/src/remote.ts HostConfig),
// with desktops_max computed from the host's measured CPUs and memory (placement.ts hostCapacity).
// Run by provision.sh on the site as the runtime's user; the runtime re-reads the file every minute.
//
//   bun scripts/deploy/desktop-host/register.ts --file <hosts.json> --name <n> --address <ip> [--port 22]
//     --key <private key path> --known-hosts <path> --health '<json from lineage-desk-gw health>' [--max N]
//   bun scripts/deploy/desktop-host/register.ts --file <hosts.json> --remove <n>
//
// --max overrides the computed capacity downwards only (never above what the host measured).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostCapacity } from "../../../packages/desktop/src/placement.ts";
import type { HostConfig } from "../../../packages/desktop/src/remote.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const file = opt("file");
if (!file) throw new Error("--file is required");
const doc: { _note?: string; hosts: (HostConfig & { capacity?: string; registered_at?: string })[] } = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { hosts: [] };
doc._note = "Desktop hosts for the hosted runtime (scripts/deploy/desktop-host/provision.sh). desktops_max from hostCapacity of the measured host; the runtime re-reads this file every minute.";

const remove = opt("remove");
if (remove) {
  doc.hosts = doc.hosts.filter((h) => h.name !== remove);
  console.log(`removed ${remove}; ${doc.hosts.length} host(s) left (its running desktops finish, no new ones start there)`);
} else {
  const name = opt("name")!;
  const address = opt("address")!;
  const health = JSON.parse(opt("health") ?? "null") as { cpus: number; mem_mib: number; image: string | null } | null;
  if (!/^[a-z0-9-]{1,32}$/.test(name ?? "") || !address || !health?.cpus || !health.mem_mib) throw new Error("--name, --address and --health (cpus, mem_mib) are required");
  if (!health.image) throw new Error("the host has no lineage/desktop image; not registered");
  const cap = hostCapacity({ cpus: health.cpus, mem_mib: health.mem_mib });
  const max = opt("max") !== undefined ? Math.min(cap.desktops_max, Number(opt("max"))) : cap.desktops_max;
  const entry = {
    name, address, port: Number(opt("port") ?? 22), user: "lineage-desk", key: opt("key")!, known_hosts: opt("known-hosts")!,
    desktops_max: max, capacity: cap.basis, registered_at: new Date().toISOString(),
  };
  doc.hosts = [...doc.hosts.filter((h) => h.name !== name), entry];
  console.log(`registered ${name} (${address}): desktops_max ${max} (${cap.basis})`);
}
writeFileSync(`${file}.tmp`, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
renameSync(`${file}.tmp`, file);
