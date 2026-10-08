#!/usr/bin/env bun
// Lineage site gate: the only thing Caddy talks to. Rate limits per client address, CORS, method
// and path allowlists, body size cap, and a cap on open event streams, in front of the dashboard
// (apps/web/server.ts) and Core's public read API.
//
//   bun scripts/deploy/gate.ts [--port 9662] [--host 127.0.0.1] [--web http://127.0.0.1:9661]
//     [--core http://127.0.0.1:9660] [--origin https://a.example,https://b.example]
//
// Routes (everything else is 405 or 404 here, before any upstream sees it):
//   GET  /v1/*               Core's public API (not /v1/admin/*), CORS *: lets anyone run
//                            `bun scripts/verify.ts --core https://<site>` and scripts/replay.ts
//   PUT  /v1/bounties/:id/terms, /api/bounties/:id/terms   (Core keeps terms only if they hash to the onchain digest)
//   GET  /api/*, /live/*      dashboard data (CORS *)
//   POST /chain/rpc           devnet JSON-RPC proxy (web keeps its method allowlist); same origin only
//   POST /chain/faucet        tLINE faucet (web keeps its per-wallet and hourly limits); same origin only
//   GET  everything else      dashboard pages and assets
//   GET  /gate/health         { ok, streams, buckets }
// Client address: the last X-Forwarded-For entry (Caddy sets it to the peer it saw), else the socket.

export type Klass = "v1" | "api" | "rpc" | "faucet" | "terms" | "page";
export const LIMITS: Record<Klass, { perMin: number; burst: number }> = {
  v1: { perMin: 120, burst: 60 },
  api: { perMin: 240, burst: 120 },
  rpc: { perMin: 120, burst: 40 },
  faucet: { perMin: 3 / 60, burst: 3 },
  terms: { perMin: 10, burst: 5 },
  page: { perMin: 600, burst: 200 },
};
export const MAX_STREAMS_PER_IP = 4;
export const MAX_STREAMS = 400;
export const MAX_BODY = 64 * 1024;

export interface Route {
  klass: Klass;
  upstream: "web" | "core";
  cors: boolean;
  stream: boolean;
  sameOrigin: boolean;
}

/** Decides what a request is, or the status to refuse it with. Pure; tested in gate.test.ts. */
export function classify(method: string, path: string): Route | { refuse: number; why: string } {
  const terms = /^\/(v1|api)\/bounties\/[1-9A-HJ-NP-Za-km-z]{32,44}\/terms$/.test(path);
  if (method === "PUT") return terms ? { klass: "terms", upstream: path.startsWith("/v1/") ? "core" : "web", cors: true, stream: false, sameOrigin: false } : { refuse: 405, why: "method" };
  if (method === "POST") {
    if (path === "/chain/rpc") return { klass: "rpc", upstream: "web", cors: false, stream: false, sameOrigin: true };
    if (path === "/chain/faucet") return { klass: "faucet", upstream: "web", cors: false, stream: false, sameOrigin: true };
    return { refuse: 405, why: "method" };
  }
  if (method !== "GET" && method !== "HEAD") return { refuse: 405, why: "method" };
  if (path.startsWith("/v1/")) {
    if (path.startsWith("/v1/admin")) return { refuse: 404, why: "admin" };
    return { klass: "v1", upstream: "core", cors: true, stream: path === "/v1/events", sameOrigin: false };
  }
  if (path.startsWith("/api/") || path.startsWith("/live/"))
    return { klass: "api", upstream: "web", cors: true, stream: path === "/api/events" || path === "/live/events", sameOrigin: false };
  if (path.startsWith("/chain/")) return { klass: "api", upstream: "web", cors: false, stream: false, sameOrigin: false };
  return { klass: "page", upstream: "web", cors: false, stream: false, sameOrigin: false };
}

/** Token buckets per (address, class). */
export class Limiter {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private now: () => number = Date.now) {}
  take(ip: string, k: Klass): { ok: true } | { ok: false; retryS: number } {
    const { perMin, burst } = LIMITS[k];
    const key = `${k}|${ip}`;
    const t = this.now();
    const cur = this.b.get(key) ?? { tokens: burst, at: t };
    cur.tokens = Math.min(burst, cur.tokens + ((t - cur.at) / 60_000) * perMin);
    cur.at = t;
    this.b.set(key, cur);
    if (cur.tokens >= 1) {
      cur.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryS: Math.ceil(((1 - cur.tokens) / perMin) * 60) };
  }
  /** Drops buckets that are full again (idle long enough). */
  sweep() {
    const t = this.now();
    for (const [key, v] of this.b) {
      const { perMin, burst } = LIMITS[key.split("|")[0] as Klass];
      if (v.tokens + ((t - v.at) / 60_000) * perMin >= burst) this.b.delete(key);
    }
  }
  get size() {
    return this.b.size;
  }
}

export function clientIp(req: Request, peer: string | null): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return peer ?? "unknown";
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, last-event-id, x-lineage-agent, x-lineage-ts, x-lineage-sig",
  "access-control-max-age": "600",
};
const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "host", "content-length", "content-encoding"];

if (import.meta.main) {
  const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
  const PORT = Number(arg("port", "9662"));
  const HOST = arg("host", "127.0.0.1");
  const UP = { web: arg("web", "http://127.0.0.1:9661").replace(/\/+$/, ""), core: arg("core", "http://127.0.0.1:9660").replace(/\/+$/, "") };
  const ORIGINS = arg("origin", "").split(",").map((s) => s.trim()).filter(Boolean);
  const limiter = new Limiter();
  const streams = new Map<string, number>();
  let streamTotal = 0;
  setInterval(() => limiter.sweep(), 60_000);

  const refuse = (status: number, error: string, extra: Record<string, string> = {}, cors = false) =>
    Response.json({ error, message: `gate: ${error}` }, { status, headers: { ...(cors ? CORS_HEADERS : {}), "cache-control": "no-store", ...extra } });

  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/gate/health") return Response.json({ ok: true, streams: streamTotal, buckets: limiter.size });
      const ip = clientIp(req, srv.requestIP(req)?.address ?? null);
      if (req.method === "OPTIONS") {
        const r = classify(req.headers.get("access-control-request-method") ?? "GET", path);
        return "refuse" in r || !r.cors ? new Response(null, { status: 403 }) : new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      const r = classify(req.method, path);
      if ("refuse" in r) return refuse(r.refuse, r.why === "method" ? "method_not_allowed" : "not_found");
      if (r.sameOrigin) {
        const origin = req.headers.get("origin");
        const allowed = ORIGINS.length ? ORIGINS : [`https://${req.headers.get("host") ?? ""}`];
        if (origin && !allowed.includes(origin)) return refuse(403, "cross_origin");
      }
      const t = limiter.take(ip, r.klass);
      if (!t.ok) return refuse(429, "rate_limited", { "retry-after": String(t.retryS) }, r.cors);
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > MAX_BODY) return refuse(413, "body_too_large", {}, r.cors);
      let body: ArrayBuffer | undefined;
      if (req.method === "POST" || req.method === "PUT") {
        body = await req.arrayBuffer();
        if (body.byteLength > MAX_BODY) return refuse(413, "body_too_large", {}, r.cors);
      }
      if (r.stream) {
        if ((streams.get(ip) ?? 0) >= MAX_STREAMS_PER_IP || streamTotal >= MAX_STREAMS) return refuse(429, "too_many_streams", { "retry-after": "30" }, r.cors);
      }
      const headers = new Headers();
      for (const [k, v] of req.headers) if (!HOP.includes(k.toLowerCase())) headers.set(k, v);
      headers.set("x-forwarded-for", ip);
      let res: Response;
      try {
        res = await fetch(`${UP[r.upstream]}${path}${url.search}`, { method: req.method, headers, body, redirect: "manual", signal: req.signal, decompress: true } as RequestInit);
      } catch (e) {
        return refuse(502, "upstream_unreachable", {}, r.cors);
      }
      const out = new Headers();
      for (const [k, v] of res.headers) if (!HOP.includes(k.toLowerCase())) out.set(k, v);
      if (r.cors) for (const [k, v] of Object.entries(CORS_HEADERS)) out.set(k, v);
      if (!r.stream || !res.body) return new Response(res.body, { status: res.status, headers: out });
      streams.set(ip, (streams.get(ip) ?? 0) + 1);
      streamTotal++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        streamTotal--;
        const n = (streams.get(ip) ?? 1) - 1;
        if (n <= 0) streams.delete(ip);
        else streams.set(ip, n);
      };
      const reader = res.body.getReader();
      const piped = new ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              release();
              c.close();
            } else c.enqueue(value);
          } catch {
            release();
            c.close();
          }
        },
        cancel() {
          release();
          reader.cancel().catch(() => undefined);
        },
      });
      req.signal.addEventListener("abort", release);
      return new Response(piped, { status: res.status, headers: out });
    },
  });
  console.log(`lineage gate on http://${HOST}:${server.port} (web ${UP.web}, core ${UP.core}, pid ${process.pid})`);
  const stop = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
