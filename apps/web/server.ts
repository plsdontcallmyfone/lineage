// Lineage dashboard server. Serves the client bundle, proxies GET requests to Core, and (Wallet page) devnet RPC and faucet.
//
//   bun apps/web/server.ts --port 9661 --core http://127.0.0.1:9660 [--host 127.0.0.1] [--dev]
//
// Routes:
//   /api/<path>        GET proxy to <core>/v1/<path> (JSON, blobs)
//   /live/events       SSE fan-out of Core's event stream (one upstream connection, shared)
//   /live/recent       last N events held in memory (?limit=, ?agent=, ?candidate=)
//   /live/spec         docs/SPEC.md as text
//   /docs, /docs/*     the docs site (apps/docs, built by scripts/docs/build.ts at startup), static, outside the app shell
//   /assets/app.js     client bundle (Bun.build at startup; rebuilt per request with --dev)
//   /assets/wallet.js  wallet bundle (packages/chain in the browser; loaded by Launch, Profile and the token page's trade box)
//   /chain/config      public devnet addresses (scripts/devnet/devnet.json) and the RPC's cluster
//   /chain/rpc         POST JSON-RPC proxy to the devnet RPC (read, simulate, send; method allowlist)
//   /chain/faucet      GET faucet state, POST {wallet} one small tLINE transfer (rate-limited, logged)
//   /souls/config      GET soul draft service state (caps, today's spend; TEST values)
//   /souls/draft       POST {seed, agent, repo} a soul draft by Claude (per-soul, daily and per-address caps)
//   /souls/publish     POST {doc, sig} forwarded to Core's PUT /v1/agents/:id/soul (SPEC 14.8)
//   /market/<path>     GET proxy to the market indexer (packages/indexer; --market, default http://127.0.0.1:9668)
//   /embed/lineage-embed.js   the embed kit (packages/embed, built at startup; rebuilt per request with --dev), CORS *
//   /embed/lineage-explorer.js  <lineage-explorer>'s module, loaded on demand by the kit
//   /embed/demo.html          the kit's demo page (every element, two themes)
//   /fonts/<file>      self-hosted fonts (public/fonts, SIL OFL 1.1, licenses in public/fonts/OFL.txt)
//   /network, /live, /explorer, /wallet, /spawn, /manual   302 to what replaced them (app consolidation)
//   everything else    index.html (client-side routing; the Explorer is /)
//
// --upstream <site> (testing a local build against a deployed site): the writes this server would
// otherwise handle or route locally (/souls/*, /social/*, /runtime/*, /identity/*, /chain/faucet) are
// forwarded to that site with its own Origin, so a local page drives the site's soul drafter, runtime,
// identity service and faucet. Combine with --core <site> and --market <site>.
//
// The server never holds a user's key: wallets sign in the browser. The only key it loads is the
// devnet faucet's own (~/.config/lineage/devnet/faucet.json).

import { redactRpc } from "../../packages/chain/src/endpoint.ts";
import { applyNetworkProfile, rpcUrlFor, stateFor } from "../../packages/chain/src/profile-node.ts";
import { chainRoutes } from "./chain-routes.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chainBrowserPlugin } from "../../packages/chain/src/browser/plugin.ts";
import { Faucet } from "./wallet/faucet.ts";
import { publishSoul, SoulDrafts } from "./wallet/souls.ts";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg("port", "9661"));
const CORE = (arg("core", process.env.LINEAGE_CORE ?? "http://127.0.0.1:9660") ?? "").replace(/\/+$/, "");
const HOST = arg("host", "127.0.0.1")!;
const DEV = process.argv.includes("--dev");
const MARKET = (arg("market", process.env.LINEAGE_MARKET ?? "http://127.0.0.1:9668") ?? "").replace(/\/+$/, "");
// the GitHub identity service (packages/identity); on the site Caddy routes /identity/* to it directly
const IDENTITY = (arg("identity", process.env.LINEAGE_IDENTITY ?? "http://127.0.0.1:9665") ?? "").replace(/\/+$/, "");
const UPSTREAM = (arg("upstream", "") ?? "").replace(/\/+$/, "");
const RUNTIME = (arg("runtime", process.env.LINEAGE_RUNTIME ?? "http://127.0.0.1:9667") ?? "").replace(/\/+$/, "");
const DIR = import.meta.dir;

try {
  const busy = execFileSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf8" }).trim();
  if (busy) {
    console.error(`port ${PORT} is in use by pid ${busy.replace(/\n/g, ", ")}; not binding`);
    process.exit(1);
  }
} catch {
  /* lsof exits non-zero when nothing listens */
}

// ------------------------------------------------------------------------------------------------
// client bundle

let bundle: string | null = null;
async function build(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(DIR, "src/main.ts")], target: "browser", minify: !DEV, sourcemap: DEV ? "inline" : "none" });
  if (!out.success) throw new Error(out.logs.map((l) => String(l)).join("\n"));
  return await out.outputs[0]!.text();
}
bundle = await build();

let walletBundle: string | null = null;
async function buildWallet(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(DIR, "wallet/main.ts")], target: "browser", format: "esm", minify: !DEV, sourcemap: DEV ? "inline" : "none",
    plugins: [chainBrowserPlugin] });
  if (!out.success) throw new Error(out.logs.map((l) => String(l)).join("\n"));
  return await out.outputs[0]!.text();
}
walletBundle = await buildWallet();

// the Privy login island (apps/web/privy/main.tsx, React), built on first request: it is large and
// only loaded when a visitor clicks Connect
let privyBundle: Promise<string> | null = null;
async function buildPrivy(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(DIR, "privy/main.tsx")], target: "browser", format: "esm", minify: !DEV, sourcemap: "none",
    define: { "process.env.NODE_ENV": JSON.stringify(DEV ? "development" : "production"), global: "globalThis" } });
  if (!out.success) throw new Error(out.logs.map((l) => String(l)).join("\n"));
  return await out.outputs[0]!.text();
}

// docs site (apps/docs): static files built in memory, served at /docs outside the app shell
const { buildDocs, docsLookup } = await import("../../scripts/docs/build.ts");
let docs = await buildDocs({ base: "/docs" });
async function docsRoute(p: string): Promise<Response> {
  if (DEV) docs = await buildDocs({ base: "/docs" });
  if (p === "/docs/") return Response.redirect("/docs", 301);
  const f = docsLookup(docs, p.slice("/docs".length));
  if (!f) return new Response(docs.get("index.html") ? "No such docs page. The docs start at /docs." : "not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const page = f.type.startsWith("text/html");
  return new Response(f.body as BodyInit, { headers: page ? PAGE_HEADERS : { "content-type": f.type, "cache-control": DEV ? "no-store" : "public, max-age=300" } });
}

/** --upstream: forward one write to the deployed site, as that site's own page would send it. */
async function toUpstream(req: Request, url: URL): Promise<Response> {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const r = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json", accept: "application/json", origin: UPSTREAM }, body }).catch(() => null);
  if (!r) return Response.json({ error: "upstream_unreachable", message: `${UPSTREAM} did not answer` }, { status: 502 });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
}

const REDIRECTS: Record<string, string> = { "/network": "/", "/live": "/", "/explorer": "/", "/tokens": "/", "/wallet": "/profile", "/spawn": "/launch", "/manual": "/docs" };

const FONT_TYPES: Record<string, string> = { woff2: "font/woff2", txt: "text/plain; charset=utf-8" };

// embed kit (packages/embed, docs/EMBED.md): one file any front end loads with a script tag
const { buildEmbed } = await import("../../packages/embed/scripts/build.ts");
let embedBundle: string = await buildEmbed({ dev: DEV });
let explorerBundle: string | null = null; // built on first request (the explorer lane's module, loaded on demand by <lineage-explorer>)
async function embedRoute(p: string): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" };
  if (p === "/embed/lineage-embed.js") {
    if (DEV) embedBundle = await buildEmbed({ dev: true }).catch((e) => `console.error(${JSON.stringify(String(e))})`);
    return new Response(embedBundle, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": DEV ? "no-store" : "public, max-age=300", ...cors } });
  }
  if (p === "/embed/lineage-explorer.js") {
    if (DEV || !explorerBundle) explorerBundle = await buildEmbed({ dev: DEV, entry: "explorer-entry" }).catch((e) => `console.error(${JSON.stringify(String(e))})`);
    return new Response(explorerBundle, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": DEV ? "no-store" : "public, max-age=300", ...cors } });
  }
  if (p === "/embed/demo.html" || p === "/embed/" || p === "/embed")
    return new Response(Bun.file(join(DIR, "../../packages/embed/demo/demo.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  return new Response("not found", { status: 404 });
}

// ------------------------------------------------------------------------------------------------
// chain: public state, RPC proxy, faucet, under the network profile (config/profile.json,
// LINEAGE_NETWORK; SPEC 14.10). devnet as before; mainnet: no faucet, keyed RPC from env, never sent here.

const PROFILE = applyNetworkProfile();
const RPC_URL = arg("rpc") ?? rpcUrlFor(PROFILE);
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const chainState = stateFor(PROFILE);
const faucet = PROFILE.faucet && chainState?.line_mint
  ? new Faucet({
      keyPath: join(KEYS, "faucet.json"),
      logPath: join(KEYS, "faucet-log.jsonl"),
      rpcUrl: RPC_URL,
      lineMint: chainState.line_mint as string,
      decimals: chainState.line_decimals as number,
      amount: BigInt(arg("faucet-amount", String(1000n * 10n ** BigInt(chainState.line_decimals as number)))!),
      perWalletMs: Number(arg("faucet-window-h", "24")) * 3_600_000,
      perHour: Number(arg("faucet-per-hour", "30")),
    })
  : null;
const chain = chainRoutes({ profile: PROFILE, rpcUrl: RPC_URL, state: chainState, faucet });
const chainRoute = (req: Request, p: string) => chain.route(req, p);
console.log(`network ${PROFILE.network}: rpc ${redactRpc(RPC_URL)}, quote ${PROFILE.quote.symbol}${PROFILE.faucet ? "" : ", no faucet"}`);

// ------------------------------------------------------------------------------------------------
// shared upstream event stream

interface Ev {
  id: number;
  at: number;
  type: string;
  data: any;
}
const MAX_EVENTS = 100_000;
const events: Ev[] = [];
let lastId = 0;
let upstream: "connecting" | "open" | "down" = "connecting";
const clients = new Set<(chunk: string) => void>();
const enc = new TextEncoder();

function broadcast(chunk: string) {
  for (const c of clients) c(chunk);
}

async function follow() {
  for (;;) {
    try {
      upstream = "connecting";
      // a restarted Core (new data dir) restarts event ids: compare the first event we hold with Core's
      if (events.length) {
        const mine = events[0]!;
        const theirs = (await (await fetch(`${CORE}/v1/events/log?since=${mine.id - 1}&limit=1`)).json()) as Ev[];
        if (!theirs.length || theirs[0]!.id !== mine.id || theirs[0]!.at !== mine.at) {
          events.length = 0;
          lastId = 0;
          broadcast(`event: reset\ndata: {}\n\n`);
        }
      }
      const res = await fetch(`${CORE}/v1/events?since=${lastId}`, { headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      upstream = "open";
      broadcast(`event: status\ndata: ${JSON.stringify({ upstream })}\n\n`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (!data) continue;
          try {
            const e = JSON.parse(data) as Ev;
            if (e.id <= lastId) continue;
            lastId = e.id;
            events.push(e);
            if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
            broadcast(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
          } catch {
            /* ignore malformed */
          }
        }
      }
    } catch {
      /* fall through to retry */
    }
    upstream = "down";
    broadcast(`event: status\ndata: ${JSON.stringify({ upstream })}\n\n`);
    await Bun.sleep(2000);
  }
}
follow();

function liveStream(since: number): Response {
  let send: ((c: string) => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (c: string) => {
        try {
          controller.enqueue(enc.encode(c));
        } catch {
          if (send) clients.delete(send);
        }
      };
      send(`retry: 3000\nevent: status\ndata: ${JSON.stringify({ upstream })}\n\n`);
      if (since > 0) for (const e of events) if (e.id > since) send(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
      clients.add(send);
      hb = setInterval(() => send?.(": ping\n\n"), 15_000);
    },
    cancel() {
      if (send) clients.delete(send);
      if (hb) clearInterval(hb);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

function recent(url: URL): Response {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 2000);
  const agent = url.searchParams.get("agent");
  const cand = url.searchParams.get("candidate");
  const types = url.searchParams.get("types")?.split(",");
  const out: Ev[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i]!;
    if (types && !types.includes(e.type)) continue;
    if (agent && !(e.data && (e.data.agent === agent || e.data.author === agent))) continue;
    if (cand && !(e.data && (e.data.candidate_id === cand || e.data.commit_id === cand))) continue;
    out.push(e);
  }
  return Response.json({ upstream, last_id: lastId, held: events.length, events: out });
}

// ------------------------------------------------------------------------------------------------
// proxy

async function proxy(path: string, search: string): Promise<Response> {
  try {
    const res = await fetch(`${CORE}/v1/${path}${search}`);
    const headers = new Headers();
    headers.set("content-type", res.headers.get("content-type") ?? "application/octet-stream");
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return Response.json({ error: "core_unreachable", message: `Core at ${CORE} did not answer (${(e as Error).message})`, core: CORE }, { status: 502 });
  }
}

// market indexer (plan L2): read-only, JSON; an unreachable indexer answers 503 so the page can say so
async function marketProxy(path: string, search: string): Promise<Response> {
  try {
    const res = await fetch(`${MARKET}${path}${search}`);
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: "market_unreachable", code: "market_unreachable", message: `the market indexer at ${MARKET} did not answer (${(e as Error).message})` }, { status: 503 });
  }
}

// ------------------------------------------------------------------------------------------------
// souls (SPEC 14.8): drafts for the Wallet page's launch step; the page signs and publishes

const drafts = new SoulDrafts();
async function soulsRoute(req: Request, p: string, who: string): Promise<Response> {
  if (p === "/souls/config") return Response.json(await drafts.info());
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const body = await req.json().catch(() => null);
  const r = p === "/souls/draft" ? await drafts.draft(body, who) : p === "/souls/publish" ? await publishSoul(CORE, body) : { status: 404, body: { error: "not_found" } };
  return Response.json(r.body, { status: r.status });
}

const indexHtml = () => Bun.file(join(DIR, "public/index.html"));
// Page security headers (audit A2), the same policy Caddy sets on the site (scripts/deploy/caddy/Caddyfile.tmpl);
// the hash is the inline theme script in public/index.html (gate.test.ts checks both stay in step).
const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com 'sha256-63H06+4kOPnJGg/D6siH2d7URozVzLhxtBaUeqTsuPE='; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://fonts.privy.io; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self' https://api.github.com https://auth.privy.io https://*.rpc.privy.systems https://api.devnet.solana.com wss://api.devnet.solana.com wss://relay.walletconnect.com wss://relay.walletconnect.org https://explorer-api.walletconnect.com; frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin" };

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (UPSTREAM && (/^\/(souls|social|runtime|identity)\//.test(p) || p === "/chain/faucet")) return toUpstream(req, url);
    if (p.startsWith("/chain/")) return chainRoute(req, p);
    if (p.startsWith("/runtime/bind/")) {
      // local development: the hosted runtime's bind endpoint (on the site the gate routes it)
      const r = await fetch(`${RUNTIME}${p}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? await req.text() : undefined }).catch(() => null);
      return r ? new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } }) : Response.json({ error: "runtime_unavailable", message: "the hosted runtime is not running here" }, { status: 503 });
    }
    if (p.startsWith("/identity/")) {
      // local development only: passed through unchanged (bodies may hold a token; never logged)
      const r = await fetch(`${IDENTITY}${p}${url.search}`, { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json" }, body: req.method === "POST" ? await req.text() : undefined }).catch(() => null);
      return r ? new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } }) : Response.json({ error: "identity_unavailable" }, { status: 502 });
    }
    // the per-address draft cap keys on the LAST X-Forwarded-For entry, the one the gate (or Caddy)
    // wrote; the first entry is whatever the client sent (audit A2)
    if (p.startsWith("/souls/")) return soulsRoute(req, p, req.headers.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean).pop() || srv.requestIP(req)?.address || "?");
    // social writes (plan S): follows, reactions and the launcher's profile images are statements the
    // wallet signed; Core verifies them, so the dashboard forwards them unchanged with a body cap
    const social = /^\/social\/(follow|react|media\/[1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
    if (social && req.method === "POST") {
      const body = await req.arrayBuffer();
      if (body.byteLength > (social[1]!.startsWith("media") ? 1_500_000 : 8 * 1024)) return Response.json({ error: "too_large", message: "body too large" }, { status: 413 });
      const target = social[1]!.startsWith("media/") ? `/v1/agents/${social[1]!.slice(6)}/media` : `/v1/social/${social[1]}`;
      try {
        const res = await fetch(`${CORE}${target}`, { method: "POST", headers: { "content-type": "application/json" }, body });
        return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
      } catch (e) {
        return Response.json({ error: "core_unreachable", message: (e as Error).message }, { status: 502 });
      }
    }
    // the one write the dashboard forwards: bounty terms, which Core keeps only if their sha256
    // equals the digest committed onchain (so the web server needs no authority of its own)
    const terms = /^\/api\/bounties\/([A-Za-z0-9]{32,44})\/terms$/.exec(p);
    if (terms && req.method === "PUT") {
      const body = await req.arrayBuffer();
      if (body.byteLength > 16 * 1024) return new Response("terms too large", { status: 413 });
      try {
        const res = await fetch(`${CORE}/v1/bounties/${terms[1]}/terms`, { method: "PUT", headers: { "content-type": req.headers.get("content-type") ?? "application/json" }, body });
        return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
      } catch (e) {
        return Response.json({ error: "core_unreachable", message: (e as Error).message }, { status: 502 });
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405 });
    if (p.startsWith("/market/")) return marketProxy(p, url.search);
    if (p === "/docs" || p.startsWith("/docs/")) return docsRoute(p);
    const moved = REDIRECTS[p.replace(/\/+$/, "")];
    if (moved) return new Response(null, { status: 302, headers: { location: moved + url.search } });
    if (p === "/embed" || p.startsWith("/embed/")) return embedRoute(p);
    if (p.startsWith("/api/")) {
      const rest = p.slice(5);
      if (rest === "events") return liveStream(Number(url.searchParams.get("since") ?? 0));
      // `?optional=1`: the page treats 404 and 409 as "none", so answer 200 with the miss in the
      // body instead of a failed request the browser logs as a console error
      if (url.searchParams.get("optional") === "1") {
        const q = new URLSearchParams(url.search);
        q.delete("optional");
        const qs = q.toString();
        const res = await proxy(rest, qs ? `?${qs}` : "");
        if (res.status !== 404 && res.status !== 409) return res;
        const body = await res.json().catch(() => ({}));
        return Response.json({ _miss: { status: res.status, error: body?.error ?? "http_error", message: body?.message ?? `HTTP ${res.status}` } }, { headers: { "cache-control": "no-store" } });
      }
      return proxy(rest, url.search);
    }
    if (p === "/live/events") return liveStream(Number(req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? 0));
    if (p === "/live/recent") return recent(url);
    if (p === "/live/spec") return new Response(Bun.file(join(DIR, "../../docs/SPEC.md")), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
    if (p === "/live/status") return Response.json({ upstream, core: CORE, last_id: lastId, held: events.length });
    if (p === "/assets/app.js") {
      if (DEV) bundle = await build().catch((e) => `console.error(${JSON.stringify(String(e))})`);
      return new Response(bundle, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": DEV ? "no-store" : "public, max-age=60" } });
    }
    if (p === "/assets/wallet.js") {
      if (DEV) walletBundle = await buildWallet().catch((e) => `console.error(${JSON.stringify(String(e))})`);
      return new Response(walletBundle, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": DEV ? "no-store" : "public, max-age=60" } });
    }
    if (p === "/assets/privy.js") {
      if (DEV || !privyBundle) privyBundle = buildPrivy();
      const js = await privyBundle.catch((e) => `throw new Error(${JSON.stringify(String(e))})`);
      return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": DEV ? "no-store" : "public, max-age=300" } });
    }
    if (p === "/assets/app.css") return new Response(Bun.file(join(DIR, "public/app.css")), { headers: { "content-type": "text/css; charset=utf-8" } });
    if (p === "/favicon.svg") return new Response(Bun.file(join(DIR, "public/favicon.svg")), { headers: { "content-type": "image/svg+xml" } });
    const font = /^\/fonts\/([A-Za-z0-9-]+\.(woff2|txt))$/.exec(p);
    if (font) {
      const f = Bun.file(join(DIR, "public/fonts", font[1]!));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      return new Response(f, { headers: { "content-type": FONT_TYPES[font[2]!]!, "cache-control": "public, max-age=86400" } });
    }
    return new Response(indexHtml(), { headers: PAGE_HEADERS });
  },
});

console.log(`lineage web on http://${HOST}:${server.port} (core ${CORE}, market ${MARKET}, pid ${process.pid})`);
const stop = () => {
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
