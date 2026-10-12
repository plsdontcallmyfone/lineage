#!/usr/bin/env bun
// units-identity: the GitHub identity service (plan AUDIT-AND-IDENTITY B, SPEC 13.9).
//
//   main.ts init                       make the key file and the store directory (idempotent)
//   main.ts serve [--port 9665] [--host 127.0.0.1] [--interval 30]
//                                      launch watcher + HTTP API (lineage-identity.service)
//   main.ts cycle [--force] [--dry-run] mirror + PR bot for agents with credentials (lineage-identity-cycle.timer)
//   main.ts reserve-add                read {"login","token"} JSON lines on stdin into the encrypted reserve
//   main.ts reserve-list               logins and statuses of the reserve (no tokens)
//   main.ts pool                       counts of the reserve and the low-water flag (what GET /identity/pool serves)
//   main.ts reserve-release --login <login> --confirm release-<login>
//                                      frees an account bound to an agent whose provisioning never finished; the
//                                      only way an account returns to the reserve (refused once it is assigned)
//   main.ts status                     the service summary (no tokens)
//   main.ts publisher-set              read the publisher account's token on stdin: validated, refused for
//                                      reserved/pool/reserve/agent logins, signing key registered, stored
//                                      encrypted (docs/plans/GENERATIONS-ON-GITHUB.md 1.1)
//   main.ts publisher-status | publisher-clear
//   main.ts publisher-move [--dry-run]  transfer the publisher's mirror forks and units-learnings into the org
//                                      and publish there from the next cycle (docs/plans/GITHUB-ORG.md 3)
//   main.ts org-join [--agent <id>] [--force] [--dry-run]
//                                      invite, accept and publicize agents' accounts in the org (org.ts); without
//                                      --agent: every agent with a pending or failed record
//   main.ts org-status                 the publisher's role, every agent's org record, the org's public members
//   main.ts learnings [--agent <id>] [--force] [--dry-run]
//                                      publish agents' learnings repositories <login>/units-learnings
//                                      (docs/plans/AGENT-LEARNINGS.md 7); also run at the end of every cycle
//   main.ts findings-dump [--force] [--dry-run]
//                                      publish the next batch of every listed agent's findings to
//                                      units-agents/findings (docs/plans/AGENT-LEARNINGS.md 12); also run at the end of every cycle
//   main.ts genesis --agent <id> [--no-token | --with-token] [--force] [--sign-key <keypair.json>] [--readme]
//                                      publish (or re-publish) the agent's GitHub genesis repository
//                                      (docs/plans/GITHUB-GENESIS.md); --readme refreshes only the status
//
// Common flags and their environment fallbacks:
//   --dir      UNITS_IDENTITY_DIR   store directory        (default /var/lib/units/identity)
//   --key      UNITS_IDENTITY_KEY   32-byte key file       (default /etc/units-identity/master.key)
//   --run-dir  UNITS_IDENTITY_RUN   materialised keys      (default /run/units-identity)
//   --core     UNITS_CORE           Core base URL          (default http://127.0.0.1:9660)
//   --site     UNITS_SITE_URL       public site base URL   (profile links, commit messages)
//   --core-key UNITS_IDENTITY_CORE_KEY  Core runtime/admin key file (PR records)
//   --since    UNITS_IDENTITY_SINCE unix seconds; launches before it are ignored (default: first start)
//   --payment-since  UNITS_IDENTITY_PAYMENT_SINCE unix seconds; purchased launches from it on need the units account
//              payment in their launch transactions (default: the first start of a service that checks it)
//   --indexer  UNITS_INDEXER        market indexer base     (default http://127.0.0.1:9668; launch tx, symbol)
//   --signer   UNITS_GENESIS_SIGNER hosted runtime base     (default http://127.0.0.1:9667; signs genesis proofs)
//   --org      UNITS_GITHUB_ORG     organization agents join (default units-agents)
//   --pool-low-water  UNITS_IDENTITY_POOL_LOW_WATER  free accounts at or below which /identity/pool says low (default 5)
// Tokens are never printed.

import "../../protocol/src/env-alias.ts"; // first: UNITS_* and LINEAGE_* env names both readable (docs/plans/REBRAND-UNITS.md 3.3)
import { ChainReader, identityPaymentIn, launchBundleTxs, Rpc } from "../../chain/src/index.ts";
import { redactRpc } from "../../chain/src/endpoint.ts";
import type { SoulDoc } from "../../souls/src/schema.ts";
import { readFileSync } from "node:fs";
import { keyFromSolanaJson } from "../../protocol/src/index.ts";
import { applyNetworkProfile, loadNetworkProfile, rpcUrlFor } from "../../chain/src/profile-node.ts";
import { cycleOnce } from "./cycle.ts";
import { clearPublisher, moveToOrg, publisherPublic, setPublisher } from "./publisher.ts";
import { DEFAULT_ORG, OrgMembership } from "./org.ts";
import { tokenShapeOk } from "./github-token.ts";
import { errText } from "./redact.ts";
import { GenesisRunner, httpSources } from "./genesis.ts";
import { httpLearningsSources, LearningsPublisher } from "./learnings.ts";
import { FindingsDumpPublisher, httpDumpSources } from "./findings-dump.ts";
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
const DIR = arg("dir", "UNITS_IDENTITY_DIR", "/var/lib/units/identity")!;
const KEY = arg("key", "UNITS_IDENTITY_KEY", "/etc/units-identity/master.key")!;
const RUN = arg("run-dir", "UNITS_IDENTITY_RUN", "/run/units-identity")!;
const CORE = arg("core", "UNITS_CORE", "http://127.0.0.1:9660")!.replace(/\/+$/, "");
const SITE = arg("site", "UNITS_SITE_URL") ?? null;
const log = safeLog(cmd === "cycle" ? "identity-cycle" : "identity");

if (cmd === "init") {
  const k = ensureKeyFile(KEY);
  new EncryptedStore(DIR, KEY);
  console.log(JSON.stringify({ key: k.created ? "created" : "present", dir: DIR }));
  process.exit(0);
}
if (!["serve", "cycle", "reserve-add", "reserve-list", "pool", "reserve-release", "status", "genesis", "publisher-set", "publisher-status", "publisher-clear", "learnings", "adopt", "publisher-move", "org-join", "org-status", "findings-dump"].includes(cmd ?? "")) {
  console.error("usage: main.ts init | serve | cycle | reserve-add | reserve-list | pool | reserve-release | status | genesis | publisher-set | publisher-status | publisher-clear | publisher-move | org-join | org-status | learnings | findings-dump | adopt  (see the header)");
  process.exit(2);
}

const store = new EncryptedStore(DIR, KEY);
if (cmd === "adopt") {
  // adopt.ts: an existing account for an agent (import from stdin, or rekey from an earlier agent); prints no token
  const { adopt } = await import("./adopt.ts");
  try {
    console.log(JSON.stringify(await adopt(store, JSON.parse(await Bun.stdin.text()))));
    process.exit(0);
  } catch (e) {
    console.error(`adopt: ${(e as Error).message}`);
    process.exit(1);
  }
}
const meta = store.get<{ since: number }>("meta", "watcher");
const since = Number(arg("since", "UNITS_IDENTITY_SINCE") ?? meta?.since ?? Math.floor(Date.now() / 1000));
if (!meta || meta.since !== since) store.put("meta", "watcher", { since });

// the network profile's program ids and RPC (config/profile.json; the devnet site's unit pins UNITS_NETWORK=devnet)
const rpcUrl = rpcUrlFor(applyNetworkProfile());
const reader = new ChainReader(Rpc.http(rpcUrl, "confirmed"));
async function soul(agent: string): Promise<SoulDoc | null> {
  const r = await fetch(`${CORE}/v1/agents/${agent}/soul`, { signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Core answered ${r.status} for the soul`);
  const j: any = await r.json();
  return (j?.doc ?? j) as SoulDoc;
}
// "A units account" payment (owner direction 2026-10-11): required for purchased launches from the
// first start of a service that checks it (persisted, so a restart never moves it); earlier launches keep what they have
const payMeta = store.get<{ since: number }>("meta", "payment");
const paymentSince = Number(arg("payment-since", "UNITS_IDENTITY_PAYMENT_SINCE") ?? payMeta?.since ?? Math.floor(Date.now() / 1000));
if (!payMeta || payMeta.since !== paymentSince) store.put("meta", "payment", { since: paymentSince });
async function paymentTerms(): Promise<{ lamports: bigint; recipient: string } | null> {
  // the configured terms (GET /v1/launch-fronting), not GET /v1/config: there Core hides the recipient from
  // launchers while no account is free, and a launch that paid just before must still be recognised as paid
  const r = await fetch(`${CORE}/v1/launch-fronting`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Core answered ${r.status} for its launch fronting`);
  const p = (await r.json()) as any;
  if (!p?.identity_account_recipient || !/^\d+$/.test(String(p.identity_account_price_lamports ?? ""))) return null;
  return { lamports: BigInt(p.identity_account_price_lamports), recipient: p.identity_account_recipient };
}
const svc = new IdentityService({
  store, runDir: RUN, chain: { launches: () => reader.launches(), agentLaunch: (m) => reader.agentLaunch(m), agent: (a) => reader.agent(a) },
  soul, site: SITE, since, log,
  payment: {
    since: paymentSince,
    terms: paymentTerms,
    paid: async (l, recipient) => identityPaymentIn(await launchBundleTxs(reader.rpc, { mint: l.mint, launcher: l.launcher }), { payer: l.launcher, recipient }),
  },
  org: arg("org", "UNITS_GITHUB_ORG", DEFAULT_ORG),
  poolLowWater: (() => {
    const v = arg("pool-low-water", "UNITS_IDENTITY_POOL_LOW_WATER");
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  })(),
  soulWaitS: Number((process.env.UNITS_IDENTITY_SOUL_WAIT_S ?? process.env.LINEAGE_IDENTITY_SOUL_WAIT_S) ?? 600),
});

const net = loadNetworkProfile();
const genesis = new GenesisRunner({
  svc, site: SITE, network: { name: net.network, explorer_cluster: net.explorer_cluster }, log,
  sources: httpSources({ core: CORE, indexer: arg("indexer", "UNITS_INDEXER", "http://127.0.0.1:9668"), runtime: arg("signer", "UNITS_GENESIS_SIGNER", "http://127.0.0.1:9667"), log }),
});
const org = new OrgMembership({ svc, log });
svc.afterReady = async (a) => {
  // the org join does not wait for the genesis repository, and neither blocks the other on failure
  await Promise.allSettled([genesis.run(a), org.afterReady(a)]);
};

if (cmd === "org-join") {
  const agent = arg("agent");
  const ids = agent ? [agent] : svc.o.store.list("org");
  const out = [];
  for (const a of ids) {
    const r = await org.join(a, { force: flag("force") || !!agent, dryRun: flag("dry-run") });
    out.push({ agent: a, login: r.login, status: r.status, step: r.step, public: r.public, reason: r.reason });
  }
  console.log(JSON.stringify({ org: org.org, agents: out }, null, 2));
  process.exit(out.every((x) => x.status === "joined" || flag("dry-run")) ? 0 : 1);
}
if (cmd === "org-status") {
  console.log(JSON.stringify(await org.status(), null, 2));
  process.exit(0);
}
if (cmd === "publisher-move") {
  try {
    console.log(JSON.stringify(await moveToOrg(svc, org.org, { dryRun: flag("dry-run") }), null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`publisher-move: ${errText(e)}`);
    process.exit(1);
  }
}

function learningsPublisher(): LearningsPublisher {
  const keyFile = arg("core-key", "UNITS_IDENTITY_CORE_KEY");
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

async function runFindingsDump(): Promise<boolean> {
  try {
    const keyFile = arg("core-key", "UNITS_IDENTITY_CORE_KEY");
    let post: ((path: string, body: unknown) => Promise<{ status: number; body: any }>) | null = null;
    if (keyFile) {
      const raw = JSON.parse(readFileSync(keyFile, "utf8"));
      const cc = new CoreClient(CORE, Array.isArray(raw) ? keyFromSolanaJson(raw) : raw);
      post = (path, body) => cc.post(path, body);
    }
    const s = await new FindingsDumpPublisher({ svc, sources: httpDumpSources({ core: CORE, post }), site: SITE, log }).run({ force: flag("force"), dryRun: flag("dry-run") });
    log(`findings dump: ${s.result}, ${s.added} added, ${s.removed} removed, ${s.episodes} episodes on ${s.units} units in ${s.repo ?? "(no repository)"} up to cursor ${s.last_seq}${s.more ? ", more to come" : ""}${s.reason ? ` (${s.reason})` : ""}`);
    if (cmd === "findings-dump") console.log(JSON.stringify(s, null, 2));
    return s.result !== "failed";
  } catch (e) {
    log(`findings dump: ${errText(e)}`);
    return false;
  }
}

if (cmd === "findings-dump") process.exit((await runFindingsDump()) ? 0 : 1);

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
} else if (cmd === "pool") {
  console.log(JSON.stringify(svc.pool()));
} else if (cmd === "reserve-release") {
  try {
    const credLogins = svc.creds.agents().map((a) => svc.creds.record(a)?.login ?? "").filter(Boolean);
    console.log(JSON.stringify(svc.reserve.release(arg("login") ?? "", arg("confirm") ?? "", credLogins)));
  } catch (e) {
    console.error(`reserve-release: ${errText(e)}`);
    process.exit(1);
  }
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
  const s = await cycleOnce({ svc, core: CORE, site: SITE ?? undefined, coreKeyFile: arg("core-key", "UNITS_IDENTITY_CORE_KEY") ?? null, dryRun: flag("dry-run"), force: flag("force"), log });
  log(`cycle done: ${s.agents} agents, ${s.lineages.length} lineages built, ${s.skipped_unchanged} unchanged, ${s.published} published (${s.verified} verified), ${s.prs.filter((p) => p.action === "opened").length} PRs opened, ${s.rejected.length} rejected, GitHub records ${s.recorded} recorded + ${s.awaiting} awaiting publisher${s.publisher ? ` (publisher ${s.publisher})` : " (no publisher)"}, ${s.record_failures.length} not recorded${s.error ? `, error: ${s.error}` : ""}`);
  await runLearnings();
  await runFindingsDump();
  process.exit(s.error ? 1 : 0);
} else {
  const port = Number(arg("port", "UNITS_IDENTITY_PORT", "9665"));
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
      await org.tick().catch((e) => log(`org: ${errText(e)}`));
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, interval);
}
