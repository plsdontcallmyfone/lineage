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
//   GET  /api/*, /live/*      dashboard data (CORS *); not /api/admin*, not encoded slashes or //
//   GET  /market/*            market indexer read API (own class; the indexer's own CORS and preflight)
//   POST /chain/rpc           devnet JSON-RPC proxy (web keeps its method allowlist); same origin only
//   POST /chain/faucet        tLINE faucet (web keeps its per-wallet and hourly limits); same origin only
//                             (an Origin header is required: browsers always send one on POST)
//   POST /social/follow, /social/react, /social/media/:agent   wallet-signed social statements (Core
//                             verifies each signature); same origin only; own class; bodies capped at
//                             8 KB, or 1.5 MB for a launcher's image (base64 in JSON)
//   GET, POST /runtime/bind/:agent   the hosted runtime's bind endpoint (packages/runtime/src/bind.ts):
//                             the runtime key a hosted launch rotates to, and the owner-signed rotation
//                             it co-signs; POST same origin only (a browser sends no Origin on a
//                             same-origin GET; GET only reads, or makes the key of a real hosted launch); own class
//   POST /souls/draft, /souls/publish   the launch page's soul step (owner direction 2026-10-10, launch e2e):
//                             a Claude draft under the dashboard's own caps (per soul, per UTC day, per
//                             address per hour), and publishing a soul the agent key signed (Core checks
//                             it against the digest on chain); same origin only; own class; anything
//                             else under /souls is refused
//   GET  /desktops/<session>/live.m3u8, init.mp4, seg-<n>.m4s   an agent desktop's live stream (SPEC 17.7),
//                             served by the hosted runtime (packages/desktop/src/serve.ts); CORS *; own
//                             class; at most DESKTOP_VIEWERS distinct viewers per session and
//                             DESKTOP_VIEWERS_TOTAL over all sessions (a viewer is an address key seen
//                             in the last VIEWER_WINDOW_MS)
//   GET  everything else      dashboard pages and assets
//   GET  /gate/health         { ok } (no counters: they told an attacker how close the caps were)
// Client address: the last X-Forwarded-For entry (Caddy sets it to the peer it saw), else the socket.
// Limits key on clientKey(): an IPv6 address counts as its /64, an IPv4-mapped one as the IPv4.
//   [--indexer http://127.0.0.1:9668]   the market indexer upstream for /market/*
//   [--runtime http://127.0.0.1:9667]   the hosted runtime's bind endpoint for /runtime/bind/*

export type Klass = "v1" | "api" | "rpc" | "faucet" | "terms" | "page" | "market" | "social" | "bind" | "souls" | "desktop";
export const LIMITS: Record<Klass, { perMin: number; burst: number }> = {
  v1: { perMin: 120, burst: 60 },
  api: { perMin: 240, burst: 120 },
  rpc: { perMin: 120, burst: 40 },
  faucet: { perMin: 3 / 60, burst: 3 },
  terms: { perMin: 10, burst: 5 },
  page: { perMin: 600, burst: 200 },
  market: { perMin: 240, burst: 120 },
  // follows, reactions and images: a person clicks these; Core keeps its own per-wallet limits too
  social: { perMin: 20, burst: 10 },
  // a hosted launch binds once; the page polls the key for a few seconds after its launch
  bind: { perMin: 30, burst: 15 },
  // the dashboard caps drafts per address per hour and per UTC day; this only keeps floods off it
  souls: { perMin: 6, burst: 6 },
  // one viewer polls the playlist and fetches a segment every 2 s (about 60 a minute); a few tabs fit
  desktop: { perMin: 240, burst: 60 },
};
export const DESKTOP_VIEWERS = 50;
export const DESKTOP_VIEWERS_TOTAL = 300;
export const VIEWER_WINDOW_MS = 20_000;
export const MAX_STREAMS_PER_IP = 4;
export const MAX_STREAMS = 400;
export const MAX_BODY = 64 * 1024;
/** Social statements (follow, react) are small; a launcher image is at most 1 MB of bytes, base64 in JSON. */
export const SOCIAL_MAX_BODY = 8 * 1024;
export const MEDIA_MAX_BODY = 1_500_000;
/** A request body must arrive within this many ms (slowloris). */
export const BODY_TIMEOUT_MS = 10_000;
/** Most distinct rate-limit buckets held at once; beyond it the stalest are evicted. */
export const MAX_BUCKETS = 50_000;

export interface Route {
  klass: Klass;
  upstream: "web" | "core" | "indexer" | "runtime";
  cors: boolean;
  stream: boolean;
  sameOrigin: boolean;
  /** Body cap for this route when it differs from MAX_BODY. */
  maxBody?: number;
}

export const DESKTOP_PATH = /^\/desktops\/[0-9a-f]{64}\/(live\.m3u8|init\.mp4|seg-\d{1,20}\.m4s)$/;

/**
 * Distinct viewers of each desktop stream: an address key counts while it fetched within the window.
 * A new viewer is refused when its session or the gate is at its cap; a known one always passes.
 */
export class DesktopViewers {
  private s = new Map<string, Map<string, number>>();
  constructor(private now: () => number = Date.now, private per = DESKTOP_VIEWERS, private total = DESKTOP_VIEWERS_TOTAL, private windowMs = VIEWER_WINDOW_MS) {}
  private prune() {
    const t = this.now() - this.windowMs;
    for (const [k, m] of this.s) {
      for (const [ip, at] of m) if (at < t) m.delete(ip);
      if (!m.size) this.s.delete(k);
    }
  }
  count(session?: string): number {
    this.prune();
    if (session) return this.s.get(session)?.size ?? 0;
    let n = 0;
    for (const m of this.s.values()) n += m.size;
    return n;
  }
  admit(session: string, ip: string): boolean {
    this.prune();
    const m = this.s.get(session) ?? new Map<string, number>();
    if (!m.has(ip) && (m.size >= this.per || this.count() >= this.total)) return false;
    m.set(ip, this.now());
    this.s.set(session, m);
    return true;
  }
}

/** Decides what a request is, or the status to refuse it with. Pure; tested in gate.test.ts. */
export function classify(method: string, path: string): Route | { refuse: number; why: string } {
  if (/^\/runtime\/bind\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(path) && (method === "GET" || method === "POST"))
    return { klass: "bind", upstream: "runtime", cors: false, stream: false, sameOrigin: method === "POST", maxBody: SOCIAL_MAX_BODY };
  const terms = /^\/(v1|api)\/bounties\/[1-9A-HJ-NP-Za-km-z]{32,44}\/terms$/.test(path);
  if (method === "PUT") return terms ? { klass: "terms", upstream: path.startsWith("/v1/") ? "core" : "web", cors: true, stream: false, sameOrigin: false } : { refuse: 405, why: "method" };
  if (method === "POST") {
    if (path === "/chain/rpc") return { klass: "rpc", upstream: "web", cors: false, stream: false, sameOrigin: true };
    if (path === "/chain/faucet") return { klass: "faucet", upstream: "web", cors: false, stream: false, sameOrigin: true };
    if (path === "/souls/draft" || path === "/souls/publish") return { klass: "souls", upstream: "web", cors: false, stream: false, sameOrigin: true };
    if (path === "/social/follow" || path === "/social/react") return { klass: "social", upstream: "web", cors: false, stream: false, sameOrigin: true, maxBody: SOCIAL_MAX_BODY };
    if (/^\/social\/media\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(path)) return { klass: "social", upstream: "web", cors: false, stream: false, sameOrigin: true, maxBody: MEDIA_MAX_BODY };
    return { refuse: 405, why: "method" };
  }
  if (method !== "GET" && method !== "HEAD") return { refuse: 405, why: "method" };
  if (path.startsWith("/desktops/")) {
    if (!DESKTOP_PATH.test(path)) return { refuse: 404, why: "desktop" };
    return { klass: "desktop", upstream: "runtime", cors: true, stream: false, sameOrigin: false };
  }
  if (path.startsWith("/v1/")) {
    if (path.startsWith("/v1/admin")) return { refuse: 404, why: "admin" };
    return { klass: "v1", upstream: "core", cors: true, stream: path === "/v1/events", sameOrigin: false };
  }
  if (path.startsWith("/api/") || path.startsWith("/live/")) {
    // the dashboard forwards /api/<rest> to Core's /v1/<rest>: keep admin and path tricks out here too
    // (safe today only because that proxy sends no signature headers; audit A2)
    if (/^\/api\/+admin/i.test(path) || /%2f|%5c|\/\/|\\/i.test(path)) return { refuse: 404, why: "admin" };
    return { klass: "api", upstream: "web", cors: true, stream: path === "/api/events" || path === "/live/events", sameOrigin: false };
  }
  if (path.startsWith("/market/")) return { klass: "market", upstream: "indexer", cors: false, stream: false, sameOrigin: false };
  if (path.startsWith("/chain/")) return { klass: "api", upstream: "web", cors: false, stream: false, sameOrigin: false };
  return { klass: "page", upstream: "web", cors: false, stream: false, sameOrigin: false };
}

/** Token buckets per (address key, class), at most `maxKeys` held (the stalest are evicted first). */
export class Limiter {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private now: () => number = Date.now, private maxKeys = MAX_BUCKETS) {}
  take(ip: string, k: Klass): { ok: true } | { ok: false; retryS: number } {
    const { perMin, burst } = LIMITS[k];
    const key = `${k}|${ip}`;
    const t = this.now();
    const cur = this.b.get(key) ?? { tokens: burst, at: t };
    cur.tokens = Math.min(burst, cur.tokens + ((t - cur.at) / 60_000) * perMin);
    cur.at = t;
    // re-insert so Map order is least recently used first
    this.b.delete(key);
    this.b.set(key, cur);
    while (this.b.size > this.maxKeys) this.b.delete(this.b.keys().next().value!);
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

/**
 * The rate-limit identity of an address: IPv4 as is, an IPv4-mapped IPv6 address as its IPv4, any
 * other IPv6 address as its /64 (one host usually holds a whole /64, so per-address keys were free to
 * rotate; audit A2).
 */
export function clientKey(ip: string): string {
  let a = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1]!;
  if (!a.includes(":")) return a;
  // expand :: and take the first four groups
  const [head, tail] = a.includes("::") ? (a.split("::") as [string, string]) : [a, ""];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (t.length && t[t.length - 1]!.includes(".")) t.splice(t.length - 1, 1, "0", "0");
  const groups = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  if (groups.length < 4) return a;
  return `${groups.slice(0, 4).map((g) => (parseInt(g || "0", 16) || 0).toString(16)).join(":")}::/64`;
}

/** Open event streams per address key and in total; a slot is reserved before the upstream is asked. */
export class StreamSlots {
  private per = new Map<string, number>();
  total = 0;
  constructor(private perIp = MAX_STREAMS_PER_IP, private max = MAX_STREAMS) {}
  /** A release function, or null when the address or the gate is at its cap. Release is idempotent. */
  reserve(ip: string): (() => void) | null {
    const n = this.per.get(ip) ?? 0;
    if (n >= this.perIp || this.total >= this.max) return null;
    this.per.set(ip, n + 1);
    this.total++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.total--;
      const m = (this.per.get(ip) ?? 1) - 1;
      if (m <= 0) this.per.delete(ip);
      else this.per.set(ip, m);
    };
  }
  of(ip: string): number {
    return this.per.get(ip) ?? 0;
  }
}

/**
 * Same-origin check for the chain writes: the Origin header must be present and listed (or, with no
 * list, be https://<Host>). A request without Origin is not from a browser page of this site.
 */
export function originAllowed(origin: string | null, host: string | null, origins: string[]): boolean {
  if (!origin) return false;
  const allowed = origins.length ? origins : [`https://${host ?? ""}`];
  return allowed.includes(origin);
}

/** Reads a request body with a byte cap and a deadline, without buffering past the cap. */
/** Largest refused body the gate still reads to the end (and discards) before answering. */
export const DRAIN_MAX = 4 * 1024 * 1024;

/** Reads and discards a request body, bounded by DRAIN_MAX bytes and BODY_TIMEOUT_MS. */
export async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const deadline = Date.now() + BODY_TIMEOUT_MS;
  let n = 0;
  try {
    while (Date.now() < deadline && n <= DRAIN_MAX) {
      const { done, value } = await reader.read();
      if (done) return;
      n += value.byteLength;
    }
  } catch {
    /* the client went away */
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readCapped(body: ReadableStream<Uint8Array> | null, max = MAX_BODY, timeoutMs = BODY_TIMEOUT_MS): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 408 | 413 }> {
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), timeoutMs)));
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), deadline]);
      if (r === "timeout") {
        reader.cancel().catch(() => undefined);
        return { ok: false, status: 408 };
      }
      if (r.done) break;
      size += r.value.byteLength;
      if (size > max) {
        reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(r.value);
    }
  } finally {
    clearTimeout(timer);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return { ok: true, bytes: out };
}

const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "host", "content-length", "content-encoding"];
/** Client headers an upstream must not see or trust. */
const STRIP = [...HOP, "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cookie", "proxy-authorization", "authorization"];

/** Headers sent upstream: the client's minus hop-by-hop, proxy and credential headers, plus one X-Forwarded-For. */
export function upstreamHeaders(req: Request, ip: string): Headers {
  const headers = new Headers();
  for (const [k, v] of req.headers) if (!STRIP.includes(k.toLowerCase())) headers.set(k, v);
  headers.set("x-forwarded-for", ip);
  return headers;
}

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, last-event-id, x-lineage-agent, x-lineage-nonce, x-lineage-sig",
  "access-control-max-age": "600",
};

if (import.meta.main) {
  const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
  const PORT = Number(arg("port", "9662"));
  const HOST = arg("host", "127.0.0.1");
  const UP = {
    web: arg("web", "http://127.0.0.1:9661").replace(/\/+$/, ""),
    core: arg("core", "http://127.0.0.1:9660").replace(/\/+$/, ""),
    indexer: arg("indexer", "http://127.0.0.1:9668").replace(/\/+$/, ""),
    runtime: arg("runtime", "http://127.0.0.1:9667").replace(/\/+$/, ""),
  };
  const ORIGINS = arg("origin", "").split(",").map((s) => s.trim()).filter(Boolean);
  const limiter = new Limiter();
  const slots = new StreamSlots();
  const viewers = new DesktopViewers();
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
      if (path === "/gate/health") return Response.json({ ok: true });
      const ip = clientKey(clientIp(req, srv.requestIP(req)?.address ?? null));
      const r = classify(req.method === "OPTIONS" ? (req.headers.get("access-control-request-method") ?? "GET") : req.method, path);
      // a preflight is answered here, except the market indexer's, which keeps its own CORS policy
      if (req.method === "OPTIONS" && ("refuse" in r || r.upstream !== "indexer"))
        return "refuse" in r || !r.cors ? new Response(null, { status: 403 }) : new Response(null, { status: 204, headers: CORS_HEADERS });
      if ("refuse" in r) return refuse(r.refuse, r.why === "method" ? "method_not_allowed" : "not_found");
      // a refusal that leaves a request body unread also closes the connection: otherwise the client
      // reuses it and its next request waits behind the unread bytes (a 413 on a 1.7 MB upload froze the
      // next request on that connection)
      const unread: Record<string, string> = (req.method === "POST" || req.method === "PUT") && req.body !== null ? { connection: "close" } : {};
      if (r.sameOrigin && !originAllowed(req.headers.get("origin"), req.headers.get("host"), ORIGINS)) return refuse(403, "cross_origin", unread);
      const t = limiter.take(ip, r.klass);
      if (!t.ok) return refuse(429, "rate_limited", { "retry-after": String(t.retryS), ...unread }, r.cors);
      if (r.klass === "desktop" && !viewers.admit(path.split("/")[2]!, ip)) return refuse(429, "too_many_viewers", { "retry-after": "30" }, r.cors);
      const maxBody = r.maxBody ?? MAX_BODY;
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > maxBody) {
        // read and discard a moderately oversized body first, so even a client that ignores
        // `connection: close` finds a clean connection; anything bigger is just closed
        if (len <= DRAIN_MAX) await drain(req.body);
        return refuse(413, "body_too_large", unread, r.cors);
      }
      let body: Uint8Array | undefined;
      if (req.method === "POST" || req.method === "PUT") {
        const b = await readCapped(req.body, maxBody);
        if (!b.ok) return refuse(b.status, b.status === 413 ? "body_too_large" : "body_timeout", unread, r.cors);
        body = b.bytes;
      }
      // the slot is taken before the upstream is asked, so parallel opens cannot pass the cap together
      const release = r.stream ? slots.reserve(ip) : null;
      if (r.stream && !release) return refuse(429, "too_many_streams", { "retry-after": "30" }, r.cors);
      let res: Response;
      try {
        res = await fetch(`${UP[r.upstream]}${path}${url.search}`, { method: req.method, headers: upstreamHeaders(req, ip), body, redirect: "manual", signal: req.signal, decompress: true } as RequestInit);
      } catch (e) {
        release?.();
        return refuse(502, "upstream_unreachable", {}, r.cors);
      }
      const out = new Headers();
      for (const [k, v] of res.headers) if (!HOP.includes(k.toLowerCase()) && k.toLowerCase() !== "set-cookie") out.set(k, v);
      if (r.cors) for (const [k, v] of Object.entries(CORS_HEADERS)) out.set(k, v);
      if (!release) return new Response(res.body, { status: res.status, headers: out });
      if (!res.body) {
        release();
        return new Response(null, { status: res.status, headers: out });
      }
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
  console.log(`lineage gate on http://${HOST}:${server.port} (web ${UP.web}, core ${UP.core}, indexer ${UP.indexer}, pid ${process.pid})`);
  const stop = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
