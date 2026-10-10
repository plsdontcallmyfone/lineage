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
//   main.ts publisher-set              read the publisher account's token on stdin: validated, refused for
//                                      reserved/pool/reserve/agent logins, signing key registered, stored
//                                      encrypted (docs/plans/GENERATIONS-ON-GITHUB.md 1.1)
//   main.ts publisher-status | publisher-clear
//   main.ts learnings [--agent <id>] [--force] [--dry-run]
//                                      publish agents' learnings repositories <login>/lineage-learnings
//                                      (docs/plans/AGENT-LEARNINGS.md 7); also run at the end of every cycle
//   main.ts genesis --agent <id> [--no-token | --with-token] [--force] [--sign-key <keypair.json>] [--readme]
//                                      publish (or re-publish) the agent's GitHub genesis repository
//                                      (docs/plans/GITHUB-GENESIS.md); --readme refreshes only the status
//
// Common flags and their environment fallbacks:
//   --dir      LINEAGE_IDENTITY_DIR   store directory        (default /var/lib/lineage/identity)
//   --key      LINEAGE_IDENTITY_KEY   32-byte key file       (default /etc/lineage-identity/master.key)
//   --run-dir  LINEAGE_IDENTITY_RUN   materialised keys      (default /run/lineage-identity)
//   --core     LINEAGE_CORE           Core base URL          (default http://127.0.0.1:9660)
//   --site     LINEAGE_SITE_URL       public site base URL   (profile links, commit messages)
//   --core-key LINEAGE_IDENTITY_CORE_KEY  Core runtime/admin key file (PR records)
//   --since    LINEAGE_IDENTITY_SINCE unix seconds; launches before it are ignored (default: first start)
//   --indexer  LINEAGE_INDEXER        market indexer base     (default http://127.0.0.1:9668; launch tx, symbol)
//   --signer   LINEAGE_GENESIS_SIGNER hosted runtime base     (default http://127.0.0.1:9667; signs genesis proofs)
// Tokens are never printed.

import { ChainReader, Rpc } from "../../chain/src/index.ts";
import { devnetRpcUrl, redactRpc } from "../../chain/src/endpoint.ts";
import type { SoulDoc } from "../../souls/src/schema.ts";
import { readFileSync } from "node:fs";
import { keyFromSolanaJson } from "../../protocol/src/index.ts";
import { loadNetworkProfile } from "../../chain/src/profile-node.ts";
import { cycleOnce } from "./cycle.ts";
import { clearPublisher, publisherPublic, setPublisher } from "./publisher.ts";
import { tokenShapeOk } from "./github-token.ts";
import { errText } from "./redact.ts";
import { GenesisRunner, httpSources } from "./genesis.ts";
import { httpLearningsSources, LearningsPublisher } from "./learnings.ts";
import { CoreClient } from "../../core/src/client.ts";
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
if (!["serve", "cycle", "reserve-add", "reserve-list", "status", "genesis", "publisher-set", "publisher-status", "publisher-clear", "learnings"].includes(cmd ?? "")) {
  console.error("usage: main.ts init | serve | cycle | reserve-add | reserve-list | status | genesis | publisher-set | publisher-status | publisher-clear | learnings  (see the header)");
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

const net = loadNetworkProfile();
const genesis = new GenesisRunner({
  svc, site: SITE, network: { name: net.network, explorer_cluster: net.explorer_cluster }, log,
  sources: httpSources({ core: CORE, indexer: arg("indexer", "LINEAGE_INDEXER", "http://127.0.0.1:9668"), runtime: arg("signer", "LINEAGE_GENESIS_SIGNER", "http://127.0.0.1:9667"), log }),
});
svc.afterReady = (a) => genesis.run(a);

function learningsPublisher(): LearningsPublisher {
  const keyFile = arg("core-key", "LINEAGE_IDENTITY_CORE_KEY");
  let post: ((path: string, body: unknown) => Promise<{ status: number; body: any }>) | null = null;
  if (keyFile) {
    const raw = JSON.parse(readFileSync(keyFile, "utf8"));
    const cc = new CoreClient(CORE, Array.isArray(raw) ? keyFromSolanaJson(raw) : raw);
    post = (path, body) => cc.post(path, body);
  }
  return new LearningsPublisher({ svc, sources: httpLearningsSources({ core: CORE, post }), site: SITE, log });
}
async function runLearnings(): Promise<boolean> {
  try {
    const agent = arg("agent");
    const s = await learningsPublisher().tick({ agents: agent ? [agent] : undefined, force: flag("force"), dryRun: flag("dry-run") });
    log(`learnings: ${s.agents} agents with episodes, ${s.published.length} repositories committed, ${s.unchanged} unchanged, ${s.rate_limited} rate limited, ${s.awaiting.length} awaiting publisher, ${s.failed.length} failed`);
    if (cmd === "learnings") console.log(JSON.stringify(s, null, 2));
    return s.failed.length === 0;
  } catch (e) {
    log(`learnings: ${errText(e)}`);
    return false;
  }
}

if (cmd === "learnings") process.exit((await runLearnings()) ? 0 : 1);

if (cmd === "genesis") {
  const agent = arg("agent");
  if (!agent || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agent)) {
    console.error("genesis needs --agent <id>");
    process.exit(2);
  }
  if (flag("readme")) {
    console.log(JSON.stringify({ readme: await genesis.refresh(agent, { force: true }), genesis: svc.view(agent).genesis }, null, 2));
    process.exit(0);
  }
  const keyFile = arg("sign-key");
  const key = keyFile ? keyFromSolanaJson(JSON.parse(readFileSync(keyFile, "utf8"))) : undefined;
  const noToken = flag("no-token") ? true : flag("with-token") ? false : undefined;
  const r = await genesis.run(agent, { explicit: true, noToken, force: flag("force"), key });
  console.log(JSON.stringify({ status: r.status, reason: r.reason, opts: r.opts, genesis: svc.view(agent).genesis, core: r.core }, null, 2));
  process.exit(r.status === "published" ? 0 : 1);
}

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
  console.log(JSON.stringify({ ...svc.summary(), publisher: publisherPublic(svc) }, null, 2));
} else if (cmd === "publisher-status") {
  console.log(JSON.stringify(publisherPublic(svc)));
} else if (cmd === "publisher-clear") {
  console.log(JSON.stringify(await clearPublisher(svc)));
} else if (cmd === "publisher-set") {
  const token = (await Bun.stdin.text()).trim();
  if (!tokenShapeOk(token)) {
    console.error("publisher-set: a GitHub token is expected on stdin");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await setPublisher(svc, token)));
  } catch (e) {
    console.error(`publisher-set: ${errText(e)}`);
    process.exit(1);
  }
} else if (cmd === "cycle") {
  const s = await cycleOnce({ svc, core: CORE, site: SITE ?? undefined, coreKeyFile: arg("core-key", "LINEAGE_IDENTITY_CORE_KEY") ?? null, dryRun: flag("dry-run"), force: flag("force"), log });
  log(`cycle done: ${s.agents} agents, ${s.lineages.length} lineages built, ${s.skipped_unchanged} unchanged, ${s.published} published (${s.verified} verified), ${s.prs.filter((p) => p.action === "opened").length} PRs opened, ${s.rejected.length} rejected, GitHub records ${s.recorded} recorded + ${s.awaiting} awaiting publisher${s.publisher ? ` (publisher ${s.publisher})` : " (no publisher)"}, ${s.record_failures.length} not recorded${s.error ? `, error: ${s.error}` : ""}`);
  await runLearnings();
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
      await genesis.tick();
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, interval);
}
