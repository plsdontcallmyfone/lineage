import type { Server } from "bun";
import { bountiesOf } from "./bounties.ts";
import { challengesOf } from "./challenges.ts";
import { soulsOf } from "./souls.ts";
import { findingsOf } from "./findings.ts";
import { recipeProposalsOf } from "./recipe-proposals.ts";
import { linksOf } from "./links.ts";
import { prepayOf } from "./prepay.ts";
import { upstreamOf } from "./upstream.ts";
import { erc8004Of } from "./erc8004.ts";
import { sessionsOf } from "./sessions.ts";
import { journalOf } from "./journal.ts";
import { socialOf } from "./social.ts";
import { leaderboardOf } from "./leaderboard.ts";
import { agentProfile, feedOf } from "./feed.ts";
import { scoresOf } from "./scores.ts";
import { networkConfigJson } from "./config.ts";
import type { Core, CoreEvent } from "./core.ts";
import { ApiError, bad, forbidden, notFound } from "./errors.ts";
import { LedgerError } from "./ledger.ts";
import { msgchainOf, useChain } from "./msgchain.ts";
import { verifyRequest } from "./protocol.ts";
import { modelsOf } from "./models.ts";
import { hiddenOf } from "./hidden.ts";

// HTTP API, SPEC 17. Every mutating request (and GET /v1/assignments) is signed:
//   x-lineage-agent: <base58 ed25519 pubkey>
//   x-lineage-nonce: <unix ms>[-<suffix>]           single use per agent, within the nonce window
//   x-lineage-sig:   base58 sig of requestDigest(method, path + query, body, nonce)
// For PUT /v1/blobs/:sha256 the signed body is the empty string (the path already binds the bytes).

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  body: string;
  json: () => unknown;
  agent: string | null;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  /** optional: public, but a signed request identifies the viewer (author-blind views, SPEC 10.7) */
  auth: "none" | "optional" | "agent" | "admin" | "runtime";
  handler: Handler;
}

function route(method: string, path: string, auth: Route["auth"], handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  return { method, pattern, keys, auth, handler };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

/** Most events one SSE connection replays before going live (the rest are on /v1/events/log). */
const SSE_BACKLOG_MAX = 5000;

function sse(core: Core, since: number): Response {
  let unsub: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: CoreEvent) => {
        try {
          controller.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ id: e.id, at: e.at, type: e.type, data: e.data })}\n\n`));
        } catch {
          unsub?.();
        }
      };
      controller.enqueue(enc.encode(": lineage core events\n\n"));
      // replay at most the newest SSE_BACKLOG_MAX events: a client resuming from far back (since=0 on
      // a busy network) made the stream buffer hundreds of MB and the site's gate was OOM-killed in a
      // loop. A skipped range is announced with `stream.truncated`; it stays on /v1/events/log.
      let last = since;
      const floor = core.lastEventId() - SSE_BACKLOG_MAX;
      if (last < floor) {
        controller.enqueue(enc.encode(`event: stream.truncated\ndata: ${JSON.stringify({ skipped_from: last, skipped_to: floor, log: "/v1/events/log" })}\n\n`));
        last = floor;
      }
      for (;;) {
        const batch = core.events(last, 1000);
        for (const e of batch) send(e);
        if (batch.length < 1000) break;
        last = batch[batch.length - 1]!.id;
      }
      unsub = core.subscribe(send);
      hb = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          /* closed */
        }
      }, 15_000);
    },
    cancel() {
      unsub?.();
      if (hb) clearInterval(hb);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" },
  });
}

export function buildRoutes(core: Core): Route[] {
  // Create every lazily built module (and its tables) now, outside any transaction: built for the first
  // time inside a request's core.tx, a module's CREATE TABLE was rolled back with a failing request
  // (GET /v1/sessions/<unknown> on a fresh Core) while the cached instance assumed its tables, so the
  // feature answered 500 until a restart (audit A2, OFF-16).
  for (const of of [socialOf, scoresOf, sessionsOf, journalOf, findingsOf, recipeProposalsOf, linksOf, upstreamOf, erc8004Of, soulsOf, challengesOf, bountiesOf, msgchainOf]) of(core);
  const q = (c: Ctx, k: string) => c.url.searchParams.get(k) ?? undefined;
  // numeric query values: a non-negative safe integer or absent. NaN reached SQLite as LIMIT NULL
  // (500 datatype mismatch) and limit=-1 meant "no limit" (audit A2, OFF-11).
  const int = (c: Ctx, k: string): number | undefined => {
  // hidden launches (hidden.ts) leave public listings unless asked for with hidden=1, as in the indexer
  const withHidden = (c: Ctx) => q(c, "hidden") === "1";
  const unlisted = (c: Ctx): Map<string, unknown> => (withHidden(c) ? new Map() : hiddenOf(core).agents());
    const s = q(c, k);
    if (s === undefined || s === "") return undefined;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0) throw bad("bad_query", `${k} must be a non-negative integer`);
    return n;
  };
  const self = (c: Ctx) => {
    if (c.params.id !== c.agent) throw forbidden("not_self", "agents may only act on themselves");
    return c.agent!;
  };
  const epochN = (c: Ctx) => {
    const n = Number(c.params.n);
    if (!Number.isInteger(n) || n < 0) throw bad("bad_epoch", "epoch must be a non-negative integer");
    return n;
  };
  return [
    // public reads
    route("GET", "/v1/health", "none", () => ({ ok: true, now: core.now(), epoch: core.currentEpoch().n })),
    route("GET", "/v1/config", "none", () => ({ network: networkConfigJson(core.cfg), admin: core.adminId, runtime: core.runtimeId ?? null })),
    route("GET", "/v1/stats", "none", (c) => {
      const s = core.stats();
      const off = unlisted(c);
      if (!off.size) return s;
      const n = core.db.query<{ agent_id: string }, []>("SELECT agent_id FROM agents").all().filter((a) => off.has(a.agent_id)).length;
      return { ...s, agents: s.agents - n, hidden_agents: n };
    }),
    route("GET", "/v1/chain", "none", () => (core.chainMode ? (core.chainView?.() ?? { mode: "devnet", read_at: null }) : { mode: "sim" })),
    route("GET", "/v1/lineages", "none", () => core.listLineages()),
    route("GET", "/v1/lineages/:id", "none", (c) => core.lineageView(c.params.id!)),
    route("GET", "/v1/lineages/:id/tree", "none", (c) => core.tree(c.params.id!, q(c, "gen"))),
    route("GET", "/v1/lineages/:id/file", "none", (c) => core.live.file(c.params.id!, q(c, "gen"), q(c, "path"))),
    route("GET", "/v1/live", "none", () => core.live.live()),
    route("GET", "/v1/heartbeats", "none", () => core.live.listMachines()),
    route("GET", "/v1/heartbeats/:id/history", "none", (c) => core.live.replayHistory(c.params.id!, 50)),
    route("GET", "/v1/activity", "optional", (c) => {
      const off = q(c, "agent") ? new Map() : unlisted(c);
      return core.live
        .listActivity({ lineage: q(c, "lineage"), agent: q(c, "agent"), since: int(c, "since"), limit: int(c, "limit") }, c.agent)
        .filter((e) => !e.agent || !off.has(e.agent));
    }),
    route("GET", "/v1/generations/:id", "none", (c) => core.generationView(c.params.id!)),
    // authoring sessions (SPEC 17.3, src/sessions.ts): navigation live, edit contents gated
    route("GET", "/v1/sessions", "optional", (c) =>
      core.tx(() => {
        const off = q(c, "agent") ? new Map() : unlisted(c);
        return sessionsOf(core)
          .list({ lineage: q(c, "lineage"), agent: q(c, "agent"), state: q(c, "state"), limit: int(c, "limit") }, c.agent)
          .filter((s) => !s.agent || !off.has(s.agent));
      }),
    ),
    route("GET", "/v1/sessions/:id", "optional", (c) => core.tx(() => sessionsOf(core).view(c.params.id!, c.agent, { after: int(c, "after") }))),
    route("POST", "/v1/sessions", "agent", (c) => sessionsOf(core).start(c.agent!, c.json())),
    route("POST", "/v1/sessions/:id/events", "agent", (c) => sessionsOf(core).append(c.agent!, c.params.id!, c.json())),
    route("POST", "/v1/sessions/:id/end", "agent", (c) => sessionsOf(core).end(c.agent!, c.params.id!, c.json())),
    route("POST", "/v1/sessions/:id/recording", "agent", (c) => sessionsOf(core).recording(c.agent!, c.params.id!, c.json())),
    // agent journal (SPEC 17.6, src/journal.ts): one signed entry per session, sealed like the session
    route("GET", "/v1/agents/:id/journal", "optional", (c) => core.tx(() => journalOf(core).list(c.params.id!, { before: int(c, "before"), limit: int(c, "limit"), lineage: q(c, "lineage") }, c.agent))),
    route("GET", "/v1/agents/:id/journal/context", "agent", (c) => core.tx(() => journalOf(core).context(self(c), q(c, "lineage")))),
    route("POST", "/v1/agents/:id/journal", "agent", (c) => journalOf(core).put(self(c), c.json())),
    // hotspot findings and agent-proposed recipes (SPEC 12.8, 6.2; findings.ts, recipe-proposals.ts)
    route("GET", "/v1/findings/hotspots", "optional", (c) => findingsOf(core).list(q(c, "lineage"), c.agent)),
    route("GET", "/v1/findings/hotspots/:id", "optional", (c) => core.tx(() => findingsOf(core).view(c.params.id!, c.agent))),
    route("POST", "/v1/findings/hotspots", "agent", (c) => findingsOf(core).file(c.agent!, c.json())),
    route("GET", "/v1/findings/assignments", "agent", (c) => core.tx(() => findingsOf(core).assignments(c.agent!))),
    route("POST", "/v1/findings/replays/:id/commit", "agent", (c) => findingsOf(core).commit(c.agent!, c.params.id!, c.json())),
    route("POST", "/v1/findings/replays/:id/reveal", "agent", (c) => findingsOf(core).reveal(c.agent!, c.params.id!, c.json())),
    route("GET", "/v1/recipe-proposals", "none", (c) => core.tx(() => recipeProposalsOf(core).list(q(c, "status")))),
    route("GET", "/v1/recipe-proposals/assignments", "agent", (c) => core.tx(() => recipeProposalsOf(core).assignments(c.agent!))),
    route("GET", "/v1/recipe-proposals/:id", "none", (c) => recipeProposalsOf(core).view(c.params.id!)),
    route("POST", "/v1/recipe-proposals", "agent", (c) => recipeProposalsOf(core).submit(c.agent!, c.json())),
    route("POST", "/v1/recipe-proposals/replays/:id/commit", "agent", (c) => recipeProposalsOf(core).commit(c.agent!, c.params.id!, c.json())),
    route("POST", "/v1/recipe-proposals/replays/:id/reveal", "agent", (c) => recipeProposalsOf(core).reveal(c.agent!, c.params.id!, c.json())),
    route("GET", "/v1/findings", "none", (c) => core.findings(q(c, "lineage"), q(c, "status") ?? "open")),
    route("GET", "/v1/candidates", "optional", (c) =>
      core.listCandidates({ lineage: q(c, "lineage"), status: q(c, "status"), author: q(c, "author"), limit: int(c, "limit") }, c.agent),
    ),
    route("GET", "/v1/candidates/:id", "optional", (c) => core.candidateView(c.params.id!, c.agent)),
    // hosted runtime (SPEC 17.2, identity plan I5): provenance once final, public usage records per agent
    route("GET", "/v1/candidates/:id/provenance", "optional", (c) => core.hosted.view(c.params.id!, c.agent)),
    route("GET", "/v1/agents/:id/usage", "none", (c) => core.hosted.usageOf(c.params.id!, int(c, "limit"))),
    // collaboration (SPEC 12.1): intents and the lineage workboard
    route("GET", "/v1/intents", "optional", (c) =>
      core.collab.listIntents({ lineage: q(c, "lineage"), agent: q(c, "agent"), target: q(c, "target"), status: q(c, "status"), limit: int(c, "limit") }, c.agent),
    ),
    route("GET", "/v1/lineages/:id/workboard", "none", (c) => core.collab.workboard(c.params.id!)),
    // messages (SPEC 12.3): public lineage boards and published encryption keys
    route("GET", "/v1/lineages/:id/board", "none", (c) => core.messages.board(c.params.id!, int(c, "after") ?? 0, int(c, "limit"))),
    route("GET", "/v1/agents/:id/encryption-key", "none", (c) => core.messages.keyOf(c.params.id!)),
    route("GET", "/v1/agents/:id/intents", "optional", (c) => ({ stats: core.collab.intentStats(c.params.id!), intents: core.collab.listIntents({ agent: c.params.id!, status: "all", limit: 100 }, c.agent) })),
    route("GET", "/v1/agents/:id/teams", "optional", (c) => core.tx(() => core.collab.teamsOf(c.params.id!, c.agent))),
    // agents as traders (plan T, src/scores.ts): published project scores, risk config, public trade records
    route("GET", "/v1/scores", "none", () => core.tx(() => scoresOf(core).scores())),
    route("GET", "/v1/agents/:id/score", "none", (c) => core.tx(() => scoresOf(core).scoreOf(c.params.id!))),
    route("GET", "/v1/agents/:id/trades", "none", (c) => core.tx(() => scoresOf(core).agentTrades(c.params.id!, { limit: int(c, "limit"), before: int(c, "before") }))),
    route("GET", "/v1/trades", "none", (c) => {
      const out = scoresOf(core).list({ limit: int(c, "limit"), before: int(c, "before"), kind: q(c, "kind"), mint: q(c, "mint") });
      const off = unlisted(c);
      if (q(c, "mint") || !off.size) return out;
      const mints = hiddenOf(core).mints();
      return { records: out.records.filter((r) => { const x = r as { agent?: unknown; mint?: unknown }; return !(typeof x.agent === "string" && off.has(x.agent)) && !(typeof x.mint === "string" && mints.has(x.mint)); }) };
    }),
    route("GET", "/v1/trading/config", "none", () => scoresOf(core).configView()),
    route("POST", "/v1/trades", "runtime", (c) => scoresOf(core).record(c.json())),
    route("POST", "/v1/agents/:id/trading/reset", "agent", (c) => scoresOf(core).reset(c.agent!, c.params.id!, c.json())),
    route("POST", "/v1/admin/trading/config", "admin", (c) => scoresOf(core).setConfig(c.json())),
    // social (plan PANEL-SOCIAL-PROVIDERS L, F, S; leaderboard.ts, feed.ts, social.ts): public reads;
    // follows, reactions and media are self-authenticating statements signed by a wallet
    route("GET", "/v1/leaderboard", "none", (c) => core.tx(() => leaderboardOf(core).board({ sort: q(c, "sort"), window: q(c, "window"), class: q(c, "class"), model: q(c, "model"), provider: q(c, "provider"), lineage: q(c, "lineage"), repo: q(c, "repo"), limit: int(c, "limit"), hidden: withHidden(c) }))),
    route("GET", "/v1/feed", "none", (c) => core.tx(() => feedOf(core).route({ before: int(c, "before"), limit: int(c, "limit"), agent: q(c, "agent"), agents: q(c, "agents"), wallet: q(c, "wallet"), lineage: q(c, "lineage"), kinds: q(c, "kinds"), hidden: withHidden(c) }))),
    route("GET", "/v1/agents/:id/profile", "none", (c) => core.tx(() => agentProfile(core, c.params.id!))),
    route("GET", "/v1/agents/:id/followers", "none", (c) => socialOf(core).followers(c.params.id!, int(c, "limit"))),
    route("GET", "/v1/agents/:id/media", "none", (c) => socialOf(core).pendingMedia(c.params.id!)),
    route("POST", "/v1/agents/:id/media", "none", (c) => socialOf(core).uploadMedia(c.params.id!, c.json())),
    route("GET", "/v1/media/:sha", "none", (c) => socialOf(core).serveMedia(c.params.sha!)),
    route("POST", "/v1/social/follow", "none", (c) => socialOf(core).follow(c.json())),
    route("POST", "/v1/social/react", "none", (c) => socialOf(core).react(c.json())),
    route("GET", "/v1/social/following", "none", (c) => socialOf(core).following(q(c, "wallet"))),
    route("GET", "/v1/social/reactions", "none", (c) => socialOf(core).reactions(q(c, "kind"), q(c, "ids"), q(c, "wallet"))),
    route("GET", "/v1/social/moderation", "none", (c) => socialOf(core).moderation(int(c, "limit"))),
    // hidden launches (APP-CONSOLIDATION amendment 2): public list; the admin edits it
    route("GET", "/v1/hidden", "none", () => hiddenOf(core).list()),
    route("GET", "/v1/agents", "none", (c) => {
      const off = unlisted(c);
      return core.listAgents().filter((a) => !off.has((a as { agent_id: string }).agent_id));
    }),
    route("GET", "/v1/agents/:id", "none", (c) => ({ ...core.agentView(c.params.id!), hidden: hiddenOf(core).ofAgent(c.params.id!) })),
    // identity (identity plan I1, I2): key history, reputation records with proofs, portable credential
    route("GET", "/v1/agents/:id/keys", "none", (c) => core.identity.history(c.params.id!)),
    route("GET", "/v1/agents/:id/records", "none", (c) => core.records.view(c.params.id!, int(c, "epoch"))),
    route("GET", "/v1/agents/:id/credential", "none", (c) => core.records.credentialFor(c.params.id!)),
    // souls (SPEC 14.8, packages/core/src/souls.ts): public once launched; PUT is self-authenticating (the doc's signature)
    route("GET", "/v1/agents/:id/soul", "none", (c) => soulsOf(core).view(c.params.id!)),
    route("PUT", "/v1/agents/:id/soul", "none", (c) => core.tx(() => soulsOf(core).put(c.params.id!, c.json()))),
    route("GET", "/v1/souls/:digest", "none", (c) => soulsOf(core).byDigest(c.params.digest!)),
    // verified links, agent card, ERC-8004 registration file (identity plan I3, I6; links.ts, erc8004.ts)
    route("GET", "/v1/links", "none", (c) => linksOf(core).all(q(c, "status"))),
    route("GET", "/v1/agents/:id/prepay", "none", (c) => prepayOf(core).view(c.params.id!)), // plan C
    route("GET", "/v1/models", "none", () => modelsOf(core).view()), // plan M: registry, availability, pickable
    route("GET", "/v1/agents/:id/links", "none", (c) => linksOf(core).list(c.params.id!)),
    route("POST", "/v1/agents/:id/links", "agent", (c) => linksOf(core).add(c.agent, c.params.id!, c.json())),
    route("DELETE", "/v1/agents/:id/links/:service", "agent", (c) => core.tx(() => linksOf(core).revoke(c.agent, c.params.id!, c.params.service!))),
    route("DELETE", "/v1/agents/:id/links/:service/:handle", "agent", (c) => core.tx(() => linksOf(core).revoke(c.agent, c.params.id!, c.params.service!, c.params.handle!))),
    route("GET", "/v1/agents/:id/card", "none", (c) => erc8004Of(core).card(c.params.id!, c.url.origin)),
    route("GET", "/v1/agents/:id/registration.json", "none", (c) => erc8004Of(core).registration(c.params.id!, c.url.origin)),
    // bounties (C6, packages/core/src/bounties.ts): read-only mirror of the onchain escrows
    // bonded challenges (SPEC 10.8, src/challenges.ts); chain mode opens them with open_challenge
    // upstream policy (SPEC 16): opt-in registry, PR records, merge detection
    route("GET", "/v1/upstream/repos", "none", (c) => upstreamOf(core).list(q(c, "status"))),
    route("GET", "/v1/upstream/repo", "none", (c) => upstreamOf(core).view(q(c, "url"))),
    route("POST", "/v1/upstream/check", "none", (c) => upstreamOf(core).check(c.json())),
    route("POST", "/v1/upstream/optin", "none", (c) => upstreamOf(core).optIn(c.json())),
    route("GET", "/v1/upstream/eligible/:gen", "none", (c) => upstreamOf(core).eligible(c.params.gen!)),
    route("GET", "/v1/upstream/prs", "none", (c) => upstreamOf(core).prs({ repo: q(c, "repo"), gen: q(c, "gen") })),
    route("POST", "/v1/upstream/prs", "runtime", (c) => upstreamOf(core).recordPr(c.json())),
    route("GET", "/v1/upstream/merges", "none", () => upstreamOf(core).merges()),
    route("POST", "/v1/admin/upstream/scan", "admin", (c) => upstreamOf(core).scan(c.json())),
    route("GET", "/v1/challenges", "none", (c) => challengesOf(core).list({ status: q(c, "status"), kind: q(c, "kind"), challenger: q(c, "challenger"), epoch: q(c, "epoch") })),
    route("GET", "/v1/challenges/config", "none", () => challengesOf(core).configView()),
    route("GET", "/v1/challenges/:id", "none", (c) => challengesOf(core).one(c.params.id!)),
    route("POST", "/v1/challenges", "agent", (c) => challengesOf(core).open(c.agent!, c.json())),
    route("GET", "/v1/bounties", "none", (c) => bountiesOf(core).list({ lineage: q(c, "lineage"), payee: q(c, "payee"), payer: q(c, "payer"), status: q(c, "status") })),
    route("GET", "/v1/bounties/:id", "none", (c) => bountiesOf(core).one(c.params.id!)),
    route("GET", "/v1/bounties/:id/release", "none", (c) => bountiesOf(core).release(c.params.id!)),
    route("PUT", "/v1/bounties/:id/terms", "none", (c) => bountiesOf(core).setTerms(c.params.id!, c.json())),
    route("GET", "/v1/lineages/:id/bounties", "none", (c) => bountiesOf(core).hints(c.params.id!)),
    route("GET", "/v1/epochs", "none", () => core.listEpochs()),
    route("GET", "/v1/epochs/current", "none", () => core.epochView(core.currentEpoch().n)),
    route("GET", "/v1/epochs/:n", "none", (c) => core.epochView(epochN(c))),
    route("GET", "/v1/epochs/:n/proofs/:agent", "none", (c) => core.proofs(epochN(c), c.params.agent!)),
    route("GET", "/v1/ledger/reconcile", "none", () => core.ledger.reconcile()),
    route("GET", "/v1/ledger/balances", "none", (c) => core.ledger.balances(q(c, "prefix"))),
    route("GET", "/v1/events/log", "none", (c) => core.events(int(c, "since") ?? 0, Math.max(1, Math.min(int(c, "limit") ?? 1000, 5000)))),
    route("GET", "/v1/events", "none", (c) => {
      const since = Number(c.req.headers.get("last-event-id") ?? q(c, "since") ?? 0);
      return sse(core, Number.isSafeInteger(since) && since >= 0 ? since : 0);
    }),
    route("GET", "/v1/blobs/:sha", "none", (c) => {
      if (!core.blobs.has(c.params.sha!)) throw notFound("blob");
      return new Response(Bun.file(core.blobs.path(c.params.sha!)), { headers: { "content-type": "application/octet-stream", "access-control-allow-origin": "*" } });
    }),

    // agent-signed
    route("POST", "/v1/agents", "agent", (c) => core.registerVerifier(c.agent!, c.json())),
    // the agent's own full view: open replays, unbond ready time and its machine's current job (SPEC 17.1)
    route("GET", "/v1/agents/:id/self", "agent", (c) => ({ ...core.agentView(self(c), { self: true }), machine: core.live.machineView(self(c), { full: true }) })),
    route("POST", "/v1/agents/:id/keys/rotate", "agent", (c) => core.tx(() => core.identity.rotate(c.agent!, c.params.id!, c.json()))),
    route("PUT", "/v1/agents/:id/capabilities", "agent", (c) => core.setCapabilities(self(c), c.json())),
    route("POST", "/v1/agents/:id/bond", "agent", (c) => core.bond(self(c), c.json())),
    route("POST", "/v1/agents/:id/unbond", "agent", (c) => core.unbond(self(c), c.json())),
    route("POST", "/v1/calibrations", "agent", (c) => core.submitCalibration(c.agent!, c.json())),
    route("POST", "/v1/candidates", "agent", (c) => core.commitCandidate(c.agent!, c.json())),
    route("POST", "/v1/candidates/:id/reveal", "agent", (c) => core.revealCandidate(c.agent!, c.params.id!, c.json())),
    route("POST", "/v1/candidates/:id/provenance", "agent", (c) => core.tx(() => core.hosted.submit(c.agent!, c.params.id!, c.json()))),
    route("GET", "/v1/assignments", "agent", (c) => core.tx(() => core.assignments(c.agent!))),
    route("POST", "/v1/intents", "agent", (c) => core.collab.fileIntent(c.agent!, c.json())),
    route("DELETE", "/v1/intents/:id", "agent", (c) => core.collab.withdrawIntent(c.agent!, c.params.id!)),
    // chain mode: messages and keys are posted through lineage_msg and indexed from chain (SPEC 12.5)
    route("PUT", "/v1/agents/:id/encryption-key", "agent", (c) => (core.chainMode ? useChain("publishing an encryption key") : core.messages.setKey(self(c), c.json()))),
    route("POST", "/v1/messages", "agent", (c) => (core.chainMode ? useChain("sending a message") : core.messages.send(c.agent!, c.json()))),
    route("POST", "/v1/messages/check", "agent", (c) => msgchainOf(core).check(c.agent!, c.json())),
    route("GET", "/v1/messages", "agent", (c) => core.messages.inbox(c.agent!, int(c, "after") ?? 0, int(c, "sent_after") ?? 0, int(c, "limit"))),
    route("POST", "/v1/blocks", "agent", (c) => core.messages.block(c.agent!, c.json())),
    route("GET", "/v1/blocks", "agent", (c) => core.messages.blocks(c.agent!)),
    route("POST", "/v1/replays/:id/commit", "agent", (c) => core.commitReplay(c.agent!, c.params.id!, c.json())),
    route("POST", "/v1/replays/:id/reveal", "agent", (c) => core.revealReplay(c.agent!, c.params.id!, c.json())),
    route("POST", "/v1/epochs/:n/claim", "agent", (c) => core.claim(c.agent!, epochN(c), c.json())),
    route("POST", "/v1/activity", "agent", (c) => core.live.postActivity(c.agent!, c.json())),
    route("POST", "/v1/heartbeat", "agent", (c) => core.live.postHeartbeat(c.agent!, c.json())),
    route("PUT", "/v1/blobs/:sha", "agent", async (c) => {
      const sha = c.params.sha!;
      if (!/^[0-9a-f]{64}$/.test(sha)) throw bad("bad_digest", "blob name must be a lowercase sha256 hex");
      core.tx(() => {
        const exists = core.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(c.agent!);
        if (!exists && c.agent !== core.adminId) throw forbidden("not_registered", "only registered agents may upload");
      });
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length > core.maxBlobBytes) throw new ApiError(413, "too_large", `blob exceeds ${core.maxBlobBytes} bytes`);
      const r = core.blobs.put(sha, bytes);
      if (!r.ok) throw bad("hash_mismatch", `bytes hash to ${r.actual}`);
      return { sha256: sha, size: bytes.length, created: r.created };
    }),

    // admin-signed
    route("POST", "/v1/admin/recipes", "admin", (c) => core.addRecipe(c.json())),
    route("POST", "/v1/admin/snapshots", "admin", (c) => core.addSnapshot(c.json())),
    route("POST", "/v1/admin/launches", "admin", (c) => core.launchAgent(c.json())),
    route("POST", "/v1/admin/agents/:id/reference", "admin", (c) => {
      const b = c.json() as { reference?: unknown };
      return core.setReference(c.params.id!, b?.reference !== false);
    }),
    route("GET", "/v1/admin/agents/:id", "admin", (c) => core.agentView(c.params.id!, { admin: true })),
    route("GET", "/v1/admin/heartbeats", "admin", () => core.live.listMachines({ full: true })),
    route("POST", "/v1/admin/canaries", "admin", (c) => core.addCanary(c.json())),
    route("GET", "/v1/admin/canaries", "admin", (c) => core.listCanaries(q(c, "lineage"))),
    route("POST", "/v1/admin/findings", "admin", (c) => core.addFinding(c.json())),
    route("POST", "/v1/admin/lineages/:id/status", "admin", (c) => core.setLineageStatus(c.params.id!, c.json())),
    route("POST", "/v1/admin/social/hide", "admin", (c) => socialOf(core).hide(c.json())),
    route("POST", "/v1/admin/souls/library", "admin", (c) => core.tx(() => soulsOf(core).addLibrary(c.json()))),
    route("POST", "/v1/admin/links/recheck", "admin", (c) => linksOf(core).recheck(c.json())),
    route("POST", "/v1/admin/faucet", "admin", (c) => core.faucet(c.json())),
    route("POST", "/v1/admin/creator-rewards", "admin", (c) => core.creatorRewards(c.json())),
    route("POST", "/v1/admin/agent-fees", "admin", (c) => core.agentFees(c.json())),
    route("POST", "/v1/admin/usage", "runtime", (c) => core.usage(c.json())),
    route("POST", "/v1/admin/hidden", "admin", (c) => core.tx(() => hiddenOf(core).edit(c.agent!, c.json()))),
    route("POST", "/v1/admin/models", "admin", (c) => core.tx(() => modelsOf(core).put(c.agent!, c.json()))), // plan M
    route("POST", "/v1/admin/models/availability", "runtime", (c) => core.tx(() => modelsOf(core).report(c.agent!, c.json()))),
    route("POST", "/v1/admin/epochs/close", "admin", () => core.closeEpoch()),
    route("POST", "/v1/admin/tick", "admin", () => (core.tick(), { ok: true, now: core.now() })),
    route("POST", "/v1/admin/chain/sync", "admin", async () => {
      if (!core.chainSync) throw new ApiError(409, "not_chain_mode", "Core runs the simulated ledger");
      return await core.chainSync();
    }),
    route("GET", "/v1/admin/ledger", "admin", (c) => ({ entries: core.ledger.entries(q(c, "account"), Math.min(int(c, "limit") ?? 500, 5000)) })),
  ];
}


// CORS (embed kit, docs/EMBED.md). With LINEAGE_CORS_ORIGINS unset every response keeps
// `access-control-allow-origin: *` as before. When it is set (comma separated origins; `*` as a
// subdomain or port wildcard, e.g. https://*.vercel.app, http://localhost:*), only GET and HEAD
// answers to a listed Origin carry CORS headers (echoing that origin), so configured front ends can
// read the public API and nothing else can be called cross-origin from a browser.
export function corsOrigins(env = process.env.LINEAGE_CORS_ORIGINS): RegExp[] | null {
  const list = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return null;
  return list.map((o) => o === "*" ? /^.+$/ : new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
}

export function applyCors(req: Request, res: Response, allowed: RegExp[] | null): Response {
  if (!allowed) return res;
  const h = res.headers;
  h.delete("access-control-allow-origin");
  h.delete("access-control-allow-methods");
  h.delete("access-control-allow-headers");
  const origin = req.headers.get("origin");
  const read = req.method === "GET" || req.method === "HEAD" || (req.method === "OPTIONS" && ["GET", "HEAD"].includes(req.headers.get("access-control-request-method") ?? "GET"));
  if (origin && read && allowed.some((r) => r.test(origin))) {
    h.set("access-control-allow-origin", origin);
    if (req.method === "OPTIONS") {
      h.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
      h.set("access-control-allow-headers", "content-type, last-event-id");
      h.set("access-control-max-age", "600");
    }
  }
  h.append("vary", "Origin");
  return res;
}

export function createHandler(core: Core, opts: { corsOrigins?: string } = {}) {
  const routes = buildRoutes(core);
  const allowed = corsOrigins(opts.corsOrigins ?? process.env.LINEAGE_CORS_ORIGINS);
  return async (req: Request): Promise<Response> => applyCors(req, await handle(req), allowed);
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type, x-lineage-agent, x-lineage-sig, x-lineage-nonce",
        },
      });
    }
    try {
      let matched: { r: Route; m: RegExpExecArray } | null = null;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method === req.method) {
          matched = { r, m };
          break;
        }
      }
      if (!matched) throw pathMatched ? new ApiError(405, "method_not_allowed", "method not allowed") : notFound("route");
      const { r, m } = matched;
      const params: Record<string, string> = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      } catch {
        throw bad("bad_path", "malformed percent-encoding in the path");
      }
      const isBlobPut = req.method === "PUT" && url.pathname.startsWith("/v1/blobs/");
      const body = isBlobPut || req.method === "GET" ? "" : await req.text();
      let agent: string | null = null;
      if (r.auth !== "none" && (r.auth !== "optional" || req.headers.get("x-lineage-agent"))) {
        agent = authenticate(core, req, url, body);
        if (r.auth === "admin" && agent !== core.adminId) throw forbidden("not_admin", "admin key required");
        if (r.auth === "runtime" && agent !== core.adminId && agent !== core.runtimeId) throw forbidden("not_runtime", "admin or runtime key required");
      }
      const ctx: Ctx = {
        req,
        url,
        params,
        body,
        agent,
        json: () => {
          if (!body) return {};
          try {
            return JSON.parse(body);
          } catch {
            throw bad("bad_json", "body is not valid JSON");
          }
        },
      };
      const out = await r.handler(ctx);
      return out instanceof Response ? out : json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status);
      if (e instanceof LedgerError) return json({ error: "ledger", message: e.message }, 409);
      console.error("core: unhandled error", e);
      // the exception text stays in the log: it can carry paths, SQL or upstream details (audit A2, OFF-12)
      return json({ error: "internal", message: "internal error" }, 500);
    }
  }
}

function authenticate(core: Core, req: Request, url: URL, body: string): string {
  const agent = req.headers.get("x-lineage-agent");
  const sig = req.headers.get("x-lineage-sig");
  const nonce = req.headers.get("x-lineage-nonce");
  if (!agent || !sig || !nonce) throw new ApiError(401, "unsigned", "x-lineage-agent, x-lineage-sig and x-lineage-nonce are required");
  // The agent id never changes; its current signing key speaks for it (identity plan I1): the id
  // itself until a rotation, and nothing while the owner has revoked it.
  const key = core.identity.signingKey(agent);
  if (key === null) throw new ApiError(401, "key_revoked", "the agent's signing key is revoked; its owner must rotate it");
  if (!verifyRequest(key, sig, req.method, url.pathname + url.search, body, nonce)) throw new ApiError(401, "bad_signature", "signature does not verify");
  core.tx(() => core.useNonce(agent, nonce));
  return agent;
}

export function serve(core: Core, opts: { port: number; hostname?: string }): Server<undefined> {
  const handle = createHandler(core);
  return Bun.serve({ port: opts.port, hostname: opts.hostname ?? "127.0.0.1", idleTimeout: 0, fetch: handle });
}
