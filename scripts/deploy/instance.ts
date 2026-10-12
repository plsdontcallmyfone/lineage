#!/usr/bin/env bun
// A second site instance on the same server (docs/DEPLOY-SITE.md "Second instance (mainnet test)").
// UNITS_INSTANCE unset is the site as it always was (unit names units-*, /opt/units, /var/lib/units,
// /etc/units, ports 9660-9669); nothing here changes it. UNITS_INSTANCE=mainnet is a whole second
// set beside it: unit names units-main-*, its own accounts, /opt/units-main, /var/lib/units-main,
// /etc/units-main, ports 9760-9769 and its own Caddy host. The unit files and the Caddy site block are
// rendered from the first instance's own files (scripts/deploy/systemd, caddy/Caddyfile.tmpl) by the
// rules below, so a hardening line added there reaches both.
//
//   bun scripts/deploy/instance.ts layout [name]                    the layout as JSON
//   bun scripts/deploy/instance.ts units <name> <systemd dir> <out dir>   render the instance's unit files
//   bun scripts/deploy/instance.ts caddy <name> <Caddyfile.tmpl> <sites> [tls line]   render its site block
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface InstanceLayout {
  /** "" for the first (devnet) instance */
  name: string;
  network: "devnet" | "mainnet";
  /** unit and account prefix: units, units-main */
  prefix: string;
  base: string;
  state: string;
  etc: string;
  etcCore: string;
  home: string;
  /** where keys copied from the owner's machine live under <home>/.config/lineage */
  keysDir: string;
  /**
   * The deployed chain state. First instance: scripts/devnet/devnet.json in the release. A second
   * instance: /etc/<prefix>/state.json (shipped from the owner's untracked scripts/mainnet/mainnet.json;
   * the instance's profile overlay names it as state_file, so every service reads the same file).
   */
  stateFile: string;
  ports: { core: number; web: number; gate: number; identity: number; bind: number; indexer: number };
  /** added to every port of the first instance's block */
  portOffset: number;
  users: { main: string; core: string; web: string; gate: string; indexer: string };
  /** the units this kit runs for the instance; workers and the runtime need Docker */
  units: { public: string[]; workers: string[]; runtime: string };
  /** /etc/caddy/sites.d/<file>: the instance's site block, imported by the main Caddyfile */
  caddyFile: string | null;
  profileLocal: string | null;
}

/** The E2B day budget both instances share (packages/runtime desktops.ts): one directory, one file per instance. */
export const SHARED_E2B_DIR = "/var/lib/units-shared/e2b-spend";
export const SHARED_E2B_GROUP = "units-e2b";

const TAGS: Record<string, { tag: string; network: "mainnet"; offset: number }> = { mainnet: { tag: "main", network: "mainnet", offset: 100 } };

export function instanceLayout(name: string | undefined | null): InstanceLayout {
  const n = (name ?? "").trim();
  if (n && !TAGS[n]) throw new Error(`unknown UNITS_INSTANCE ${JSON.stringify(n)} (known: ${Object.keys(TAGS).join(", ")}; unset is the devnet site)`);
  const t = n ? TAGS[n]! : null;
  const prefix = t ? `units-${t.tag}` : "units";
  const off = t?.offset ?? 0;
  const network = t?.network ?? "devnet";
  return {
    name: n,
    network,
    prefix,
    base: `/opt/${prefix}`,
    state: `/var/lib/${prefix}`,
    etc: `/etc/${prefix}`,
    etcCore: `/etc/${prefix}-core`,
    home: `/home/${prefix}`,
    keysDir: network,
    stateFile: t ? `/etc/${prefix}/state.json` : "scripts/devnet/devnet.json",
    ports: { core: 9660 + off, web: 9661 + off, gate: 9662 + off, identity: 9665 + off, bind: 9667 + off, indexer: 9668 + off },
    portOffset: off,
    users: { main: prefix, core: `${prefix}-core`, web: `${prefix}-web`, gate: `${prefix}-gate`, indexer: `${prefix}-indexer` },
    units: {
      public: [`${prefix}-core`, `${prefix}-indexer`, `${prefix}-web`, `${prefix}-gate`],
      workers: [`${prefix}-bootstrap`, `${prefix}-reference`, `${prefix}-verifier@v1`, `${prefix}-verifier@v2`],
      runtime: `${prefix}-runtime`,
    },
    caddyFile: t ? `/etc/caddy/sites.d/${prefix}.caddy` : null,
    profileLocal: t ? `/etc/${prefix}/profile.local.json` : null,
  };
}

/** The unit files an instance gets (the identity service, backups and the monitor stay with the first instance). */
export const INSTANCE_UNIT_FILES = ["units-core.service", "units-web.service", "units-gate.service", "units-indexer.service", "units-runtime.service",
  "units-bootstrap.service", "units-reference.service", "units-verifier@.service"];

const shiftPorts = (s: string, off: number) => s.replace(/\b966(\d)\b/g, (_, d) => String(9660 + Number(d) + off));

/**
 * One of the first instance's unit files as the instance's: names, accounts, paths and ports moved;
 * the pre-rebrand lineage-* ordering lines dropped; the per-role secret env file added (the keyed RPC
 * is in /etc/<prefix>/<role>.env, mode 600, read by systemd as root, never in site.env, which every
 * unit of the instance reads); the gate told where the instance's runtime bind endpoint is.
 */
export function renderUnit(file: string, text: string, L: InstanceLayout): { file: string; text: string } {
  if (!L.name) return { file, text };
  const p = L.prefix;
  const role = file.replace(/^units-/, "").replace(/@?\.service$/, "");
  const out: string[] = [];
  for (let line of text.split("\n")) {
    if (/^(Conflicts|After)=lineage-/.test(line)) continue;
    line = line.replace(/\bunits-/g, `${p}-`);
    line = line.replace(/\/(opt|var\/lib|etc|home)\/units(?=[\/\s]|$)/g, `/$1/${p}`);
    line = line.replace(/^(User|Group)=units$/, `$1=${p}`);
    line = line.replace(/\/\.config\/lineage\/devnet\//g, `/.config/lineage/${L.keysDir}/`);
    line = shiftPorts(line, L.portOffset);
    if (line.startsWith("Description=")) line = line.replace(/devnet/g, L.network) + ` [instance ${L.name}]`;
    if (role === "gate" && line.startsWith("ExecStart=")) line += ` --runtime http://127.0.0.1:${L.ports.bind}`;
    if (role === "core" && line.startsWith("ExecStart=")) line = line.replace("ExecStart=", `Environment=UNITS_PORT_BLOCK=${9660 + L.portOffset}-${9669 + L.portOffset}\nExecStart=`);
    out.push(line);
    if (line === `EnvironmentFile=-${L.etc}/site.env` && !["web", "indexer", "gate"].includes(role)) out.push(`EnvironmentFile=-${L.etc}/${role === "verifier" || role === "reference" || role === "bootstrap" ? "worker" : role}.env`);
  }
  const t = out.join("\n");
  const live = t.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  if (/\blineage-[a-z]/.test(live.replace(/\/\.config\/lineage|\.lineage/g, ""))) throw new Error(`${file}: a lineage-* name survived the instance rendering`);
  if (/\/(opt|var\/lib|etc|home)\/units[\/\s]/.test(t)) throw new Error(`${file}: a first-instance path survived the instance rendering`);
  if (/\b966\d\b/.test(t)) throw new Error(`${file}: a first-instance port survived the instance rendering`);
  return { file: file.replace(/^units-/, `${p}-`), text: t };
}

/**
 * The instance's Caddy site block, from the first instance's template: the same headers, body caps and
 * retries, its own upstream ports and access log, no identity route (the identity service stays with
 * the first instance). It lives in /etc/caddy/sites.d and the main Caddyfile imports that directory, so
 * a deploy of the first instance (which rewrites /etc/caddy/Caddyfile) does not remove it.
 */
export function renderCaddySite(tmpl: string, L: InstanceLayout, sites: string, tls = ""): string {
  if (!L.name) throw new Error("the first instance's Caddyfile is rendered by remote.sh");
  const at = tmpl.indexOf("@SITES@ {");
  if (at < 0) throw new Error("Caddyfile.tmpl has no @SITES@ block");
  // the site block only: up to its closing brace at the start of a line
  const end = tmpl.indexOf("\n}\n", at);
  if (end < 0) throw new Error("Caddyfile.tmpl: the @SITES@ block does not close");
  let block = tmpl.slice(at, end + 2);
  // the identity reverse_proxy block: this instance has no identity service
  block = block.replace(/\n\treverse_proxy \/identity\/\* [^\n]*\{\n(?:\t\t[^\n]*\n)*\t\}/, "");
  if (block.includes("/identity/* 127.0.0.1")) throw new Error("the identity route survived the instance rendering");
  block = shiftPorts(block, L.portOffset).replace("@SITES@", sites.split(",").map((s) => s.trim()).filter(Boolean).join(", ")).replace("@TLS@", tls);
  block = block.replace("/var/log/caddy/lineage-access.log", `/var/log/caddy/${L.prefix}-access.log`);
  if (L.network === "mainnet") block = block.replace(/ https:\/\/api\.devnet\.solana\.com wss:\/\/api\.devnet\.solana\.com/, "");
  return `# Rendered by scripts/deploy/remote-instance.sh (scripts/deploy/instance.ts) for the ${L.name} instance.\n${block.trimEnd()}\n`;
}

export const CADDY_IMPORT = "import /etc/caddy/sites.d/*.caddy";

if (import.meta.main) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === "layout") console.log(JSON.stringify(instanceLayout(a[0] ?? process.env.UNITS_INSTANCE), null, 2));
  else if (cmd === "units") {
    const L = instanceLayout(a[0]);
    mkdirSync(a[2]!, { recursive: true });
    const have = new Set(readdirSync(a[1]!));
    for (const f of INSTANCE_UNIT_FILES) {
      if (!have.has(f)) throw new Error(`no ${f} in ${a[1]}`);
      const r = renderUnit(f, readFileSync(join(a[1]!, f), "utf8"), L);
      writeFileSync(join(a[2]!, r.file), r.text);
    }
    console.log(`rendered ${INSTANCE_UNIT_FILES.length} unit files for ${L.prefix}`);
  } else if (cmd === "caddy") {
    process.stdout.write(renderCaddySite(readFileSync(a[1]!, "utf8"), instanceLayout(a[0]), a[2]!, a[3] ?? ""));
  } else {
    console.error("usage: instance.ts layout [name] | units <name> <systemd dir> <out dir> | caddy <name> <Caddyfile.tmpl> <sites> [tls line]");
    process.exit(2);
  }
}
