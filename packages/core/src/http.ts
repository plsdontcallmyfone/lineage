import type { Server } from "bun";
import { bountiesOf } from "./bounties.ts";
import { networkConfigJson } from "./config.ts";
import type { Core, CoreEvent } from "./core.ts";
import { ApiError, bad, forbidden, notFound } from "./errors.ts";
import { LedgerError } from "./ledger.ts";
import { verifyRequest } from "./protocol.ts";

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
      let last = since;
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
  const q = (c: Ctx, k: string) => c.url.searchParams.get(k) ?? undefined;
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
    route("GET", "/v1/stats", "none", () => core.stats()),
    route("GET", "/v1/chain", "none", () => (core.chainMode ? (core.chainView?.() ?? { mode: "devnet", read_at: null }) : { mode: "sim" })),
    route("GET", "/v1/lineages", "none", () => core.listLineages()),
    route("GET", "/v1/lineages/:id", "none", (c) => core.lineageView(c.params.id!)),
    route("GET", "/v1/lineages/:id/tree", "none", (c) => core.tree(c.params.id!, q(c, "gen"))),
    route("GET", "/v1/lineages/:id/file", "none", (c) => core.live.file(c.params.id!, q(c, "gen"), q(c, "path"))),
    route("GET", "/v1/live", "none", () => core.live.live()),
    route("GET", "/v1/heartbeats", "none", () => core.live.listMachines()),
    route("GET", "/v1/heartbeats/:id/history", "none", (c) => core.live.replayHistory(c.params.id!, 50)),
    route("GET", "/v1/activity", "optional", (c) =>
      core.live.listActivity(
        { lineage: q(c, "lineage"), agent: q(c, "agent"), since: q(c, "since") ? Number(q(c, "since")) : undefined, limit: q(c, "limit") ? Number(q(c, "limit")) : undefined },
        c.agent,
      ),
    ),
    route("GET", "/v1/generations/:id", "none", (c) => core.generationView(c.params.id!)),
    route("GET", "/v1/findings", "none", (c) => core.findings(q(c, "lineage"), q(c, "status") ?? "open")),
    route("GET", "/v1/candidates", "optional", (c) =>
      core.listCandidates({ lineage: q(c, "lineage"), status: q(c, "status"), author: q(c, "author"), limit: q(c, "limit") ? Number(q(c, "limit")) : undefined }, c.agent),
    ),
    route("GET", "/v1/candidates/:id", "optional", (c) => core.candidateView(c.params.id!, c.agent)),
    // hosted runtime (SPEC 17.2, identity plan I5): provenance once final, public usage records per agent
    route("GET", "/v1/candidates/:id/provenance", "optional", (c) => core.hosted.view(c.params.id!, c.agent)),
    route("GET", "/v1/agents/:id/usage", "none", (c) => core.hosted.usageOf(c.params.id!, q(c, "limit") ? Number(q(c, "limit")) : undefined)),
    // collaboration (SPEC 12.1): intents and the lineage workboard
    route("GET", "/v1/intents", "optional", (c) =>
      core.collab.listIntents({ lineage: q(c, "lineage"), agent: q(c, "agent"), target: q(c, "target"), status: q(c, "status"), limit: q(c, "limit") ? Number(q(c, "limit")) : undefined }, c.agent),
    ),
    route("GET", "/v1/lineages/:id/workboard", "none", (c) => core.collab.workboard(c.params.id!)),
    route("GET", "/v1/agents/:id/intents", "optional", (c) => ({ stats: core.collab.intentStats(c.params.id!), intents: core.collab.listIntents({ agent: c.params.id!, status: "all", limit: 100 }, c.agent) })),
    route("GET", "/v1/agents/:id/teams", "optional", (c) => core.tx(() => core.collab.teamsOf(c.params.id!, c.agent))),
    route("GET", "/v1/agents", "none", () => core.listAgents()),
    route("GET", "/v1/agents/:id", "none", (c) => core.agentView(c.params.id!)),
    // identity (identity plan I1, I2): key history, reputation records with proofs, portable credential
    route("GET", "/v1/agents/:id/keys", "none", (c) => core.identity.history(c.params.id!)),
    route("GET", "/v1/agents/:id/records", "none", (c) => core.records.view(c.params.id!, q(c, "epoch") !== undefined ? Number(q(c, "epoch")) : undefined)),
    route("GET", "/v1/agents/:id/credential", "none", (c) => core.records.credentialFor(c.params.id!)),
    // bounties (C6, packages/core/src/bounties.ts): read-only mirror of the onchain escrows
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
    route("GET", "/v1/events/log", "none", (c) => core.events(Number(q(c, "since") ?? 0), Math.min(Number(q(c, "limit") ?? 1000), 5000))),
    route("GET", "/v1/events", "none", (c) => sse(core, Number(c.req.headers.get("last-event-id") ?? q(c, "since") ?? 0))),
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
    route("POST", "/v1/admin/faucet", "admin", (c) => core.faucet(c.json())),
    route("POST", "/v1/admin/creator-rewards", "admin", (c) => core.creatorRewards(c.json())),
    route("POST", "/v1/admin/agent-fees", "admin", (c) => core.agentFees(c.json())),
    route("POST", "/v1/admin/usage", "runtime", (c) => core.usage(c.json())),
    route("POST", "/v1/admin/epochs/close", "admin", () => core.closeEpoch()),
    route("POST", "/v1/admin/tick", "admin", () => (core.tick(), { ok: true, now: core.now() })),
    route("POST", "/v1/admin/chain/sync", "admin", async () => {
      if (!core.chainSync) throw new ApiError(409, "not_chain_mode", "Core runs the simulated ledger");
      return await core.chainSync();
    }),
    route("GET", "/v1/admin/ledger", "admin", (c) => ({ entries: core.ledger.entries(q(c, "account"), Number(q(c, "limit") ?? 500)) })),
  ];
}

export function createHandler(core: Core) {
  const routes = buildRoutes(core);
  return async function handle(req: Request): Promise<Response> {
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
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
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
      return json({ error: "internal", message: String((e as Error)?.message ?? e) }, 500);
    }
  };
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
