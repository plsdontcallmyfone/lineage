#!/usr/bin/env bun
// lineage-identity: the GitHub identity service (plan AUDIT-AND-IDENTITY B, SPEC 13.9).
//
//   main.ts init                       make the key file and the store directory (idempotent)
//   main.ts serve [--port 9665] [--host 127.0.0.1] [--interval 30]
//                                      launch watcher + HTTP API (lineage-identity.service)
//   main.ts cycle [--force] [--dry-run] mirror + PR bot for agents with credentials (lineage-identity-cycle.timer)
//   main.ts reserve-add                read {"login","token"} JSON lines on stdin into the encrypted reserve
//   main.ts reserve-list               logins and statuses of the reserve (no tokens)
//   main.ts status                     the service summary (no tokens)
//
// Common flags and their environment fallbacks:
//   --dir      LINEAGE_IDENTITY_DIR   store directory        (default /var/lib/lineage/identity)
//   --key      LINEAGE_IDENTITY_KEY   32-byte key file       (default /etc/lineage-identity/master.key)
//   --run-dir  LINEAGE_IDENTITY_RUN   materialised keys      (default /run/lineage-identity)
//   --core     LINEAGE_CORE           Core base URL          (default http://127.0.0.1:9660)
//   --site     LINEAGE_SITE_URL       public site base URL   (profile links, commit messages)
//   --core-key LINEAGE_IDENTITY_CORE_KEY  Core runtime/admin key file (PR records)
//   --since    LINEAGE_IDENTITY_SINCE unix seconds; launches before it are ignored (default: first start)
// Tokens are never printed.

import { ChainReader, Rpc } from "../../chain/src/index.ts";
import { devnetRpcUrl, redactRpc } from "../../chain/src/endpoint.ts";
import type { SoulDoc } from "../../souls/src/schema.ts";
import { cycleOnce } from "./cycle.ts";
import { handler } from "./http.ts";
import { safeLog } from "./redact.ts";
import { IdentityService } from "./service.ts";
import { EncryptedStore, ensureKeyFile } from "./store.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n: string, env?: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : (env && process.env[env]) || d;
};
const flag = (n: string) => argv.includes(`--${n}`);
const DIR = arg("dir", "LINEAGE_IDENTITY_DIR", "/var/lib/lineage/identity")!;
const KEY = arg("key", "LINEAGE_IDENTITY_KEY", "/etc/lineage-identity/master.key")!;
const RUN = arg("run-dir", "LINEAGE_IDENTITY_RUN", "/run/lineage-identity")!;
const CORE = arg("core", "LINEAGE_CORE", "http://127.0.0.1:9660")!.replace(/\/+$/, "");
const SITE = arg("site", "LINEAGE_SITE_URL") ?? null;
const log = safeLog(cmd === "cycle" ? "identity-cycle" : "identity");

if (cmd === "init") {
  const k = ensureKeyFile(KEY);
  new EncryptedStore(DIR, KEY);
  console.log(JSON.stringify({ key: k.created ? "created" : "present", dir: DIR }));
  process.exit(0);
}
if (!["serve", "cycle", "reserve-add", "reserve-list", "status"].includes(cmd ?? "")) {
  console.error("usage: main.ts init | serve | cycle | reserve-add | reserve-list | status  (see the header)");
  process.exit(2);
}

const store = new EncryptedStore(DIR, KEY);
const meta = store.get<{ since: number }>("meta", "watcher");
const since = Number(arg("since", "LINEAGE_IDENTITY_SINCE") ?? meta?.since ?? Math.floor(Date.now() / 1000));
if (!meta || meta.since !== since) store.put("meta", "watcher", { since });

const rpcUrl = devnetRpcUrl();
const reader = new ChainReader(Rpc.http(rpcUrl, "confirmed"));
async function soul(agent: string): Promise<SoulDoc | null> {
  const r = await fetch(`${CORE}/v1/agents/${agent}/soul`, { signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Core answered ${r.status} for the soul`);
  const j: any = await r.json();
  return (j?.doc ?? j) as SoulDoc;
}
const svc = new IdentityService({
  store, runDir: RUN, chain: { launches: () => reader.launches(), agentLaunch: (m) => reader.agentLaunch(m), agent: (a) => reader.agent(a) },
  soul, site: SITE, since, log,
  soulWaitS: Number(process.env.LINEAGE_IDENTITY_SOUL_WAIT_S ?? 600),
});

if (cmd === "reserve-add") {
  const out = { added: [] as string[], present: [] as string[], refused: [] as string[] };
  for (const line of (await Bun.stdin.text()).split("\n")) {
    if (!line.trim()) continue;
    let r: { login?: unknown; token?: unknown };
    try {
      r = JSON.parse(line);
    } catch {
      out.refused.push("(unparsable line)");
      continue;
    }
    if (typeof r.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(r.login) || typeof r.token !== "string" || r.token.length < 20) {
      out.refused.push(typeof r.login === "string" ? r.login.slice(0, 39) : "(no login)");
      continue;
    }
    out[svc.reserve.add(r.login, r.token)].push(r.login);
  }
  console.log(JSON.stringify(out));
} else if (cmd === "reserve-list") {
  console.log(JSON.stringify({ accounts: svc.reserve.publicList() }));
} else if (cmd === "status") {
  console.log(JSON.stringify(svc.summary(), null, 2));
} else if (cmd === "cycle") {
  const s = await cycleOnce({ svc, core: CORE, site: SITE ?? undefined, coreKeyFile: arg("core-key", "LINEAGE_IDENTITY_CORE_KEY") ?? null, dryRun: flag("dry-run"), force: flag("force"), log });
  log(`cycle done: ${s.agents} agents, ${s.lineages.length} lineages built, ${s.skipped_unchanged} unchanged, ${s.published} published (${s.verified} verified), ${s.prs.filter((p) => p.action === "opened").length} PRs opened, ${s.rejected.length} rejected${s.error ? `, error: ${s.error}` : ""}`);
  process.exit(s.error ? 1 : 0);
} else {
  const port = Number(arg("port", "LINEAGE_IDENTITY_PORT", "9665"));
  const host = arg("host", undefined, "127.0.0.1")!;
  const interval = Number(arg("interval", undefined, "30")) * 1000;
  const h = handler(svc, log);
  Bun.serve({ port, hostname: host, fetch: (req, srv) => h(req, srv.requestIP(req)?.address ?? null) });
  log(`listening on ${host}:${port}; chain ${redactRpc(rpcUrl)}; Core ${CORE}; launches since ${new Date(since * 1000).toISOString()}; reserve ${JSON.stringify(svc.summary().reserve)}`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await svc.watchOnce();
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, interval);
}
