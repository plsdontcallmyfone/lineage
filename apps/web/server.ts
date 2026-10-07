// Lineage dashboard server. Serves the client bundle, proxies GET requests to Core, and (Wallet page) devnet RPC and faucet.
//
//   bun apps/web/server.ts --port 9661 --core http://127.0.0.1:9660 [--host 127.0.0.1] [--dev]
//
// Routes:
//   /api/<path>        GET proxy to <core>/v1/<path> (JSON, blobs)
//   /live/events       SSE fan-out of Core's event stream (one upstream connection, shared)
//   /live/recent       last N events held in memory (?limit=, ?agent=, ?candidate=)
//   /live/spec         docs/SPEC.md as text (the Manual page renders it with live config values)
//   /assets/app.js     client bundle (Bun.build at startup; rebuilt per request with --dev)
//   /assets/wallet.js  wallet bundle (packages/chain in the browser; loaded by the Wallet page only)
//   /chain/config      public devnet addresses (scripts/devnet/devnet.json) and the RPC's cluster
//   /chain/rpc         POST JSON-RPC proxy to the devnet RPC (read, simulate, send; method allowlist)
//   /chain/faucet      GET faucet state, POST {wallet} one small tLINE transfer (rate-limited, logged)
//   everything else    index.html (client-side routing)
//
// The server never holds a user's key: wallets sign in the browser. The only key it loads is the
// devnet faucet's own (~/.config/lineage/devnet/faucet.json).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chainBrowserPlugin } from "../../packages/chain/src/browser/plugin.ts";
import { DEVNET_GENESIS, KNOWN_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { Faucet } from "./wallet/faucet.ts";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg("port", "9661"));
const CORE = (arg("core", process.env.LINEAGE_CORE ?? "http://127.0.0.1:9660") ?? "").replace(/\/+$/, "");
const HOST = arg("host", "127.0.0.1")!;
const DEV = process.argv.includes("--dev");
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

// ------------------------------------------------------------------------------------------------
// devnet: public state, RPC proxy, faucet

const DEVNET_STATE = join(DIR, "../../scripts/devnet/devnet.json");
const RPC_URL = arg("rpc", process.env.LINEAGE_DEVNET_RPC ?? "https://api.devnet.solana.com")!;
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const devnet = existsSync(DEVNET_STATE) ? JSON.parse(readFileSync(DEVNET_STATE, "utf8")) : null;
const RPC_METHODS = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getLatestBlockhash", "getBlockHeight", "getSlot",
  "getMinimumBalanceForRentExemption", "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getTransaction", "getGenesisHash",
  "getFeeForMessage", "getTokenAccountBalance", "getSignaturesForAddress",
]);
let genesis: string | null = null;
async function rpcCall(method: string, params: unknown[]): Promise<Response> {
  let last = "";
  for (let i = 0; i < 7; i++) {
    if (i) await Bun.sleep(Math.min(8000, 400 * 2 ** i));
    try {
      const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) {
        last = `HTTP ${r.status}`;
        continue;
      }
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) {
      last = (e as Error).message;
    }
  }
  return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `devnet RPC did not answer (${last})` } }, { status: 502 });
}
async function cluster(): Promise<{ genesis: string | null; cluster: string; devnet: boolean }> {
  if (!genesis) {
    try {
      const r = (await (await rpcCall("getGenesisHash", [])).json()) as { result?: string };
      genesis = r.result ?? null;
    } catch {
      genesis = null;
    }
  }
  return { genesis, cluster: genesis ? (KNOWN_GENESIS[genesis] ?? "unknown") : "unreachable", devnet: genesis === DEVNET_GENESIS };
}
const faucet = devnet?.line_mint
  ? new Faucet({
      keyPath: join(KEYS, "faucet.json"),
      logPath: join(KEYS, "faucet-log.jsonl"),
      rpcUrl: RPC_URL,
      lineMint: devnet.line_mint,
      decimals: devnet.line_decimals,
      amount: BigInt(arg("faucet-amount", String(1000n * 10n ** BigInt(devnet.line_decimals)))!),
      perWalletMs: Number(arg("faucet-window-h", "24")) * 3_600_000,
      perHour: Number(arg("faucet-per-hour", "30")),
    })
  : null;

async function chainRoute(req: Request, p: string): Promise<Response> {
  if (p === "/chain/config") {
    const c = await cluster();
    const pub = devnet
      ? Object.fromEntries(Object.entries(devnet).filter(([k]) => !/key/i.test(k) && k !== "test_epoch_leaves"))
      : null;
    return Response.json({ rpc: "/chain/rpc", rpc_upstream: RPC_URL, ...c, devnet: c.devnet, state: pub, faucet: faucet?.address ?? null });
  }
  if (p === "/chain/rpc") {
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    const body = (await req.json().catch(() => null)) as { method?: string; params?: unknown[]; id?: unknown } | null;
    if (!body?.method || !RPC_METHODS.has(body.method)) return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: `method ${body?.method} not allowed here` } }, { status: 400 });
    if (body.method === "sendTransaction" && !(await cluster()).devnet) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "upstream is not devnet; refusing to send" } }, { status: 403 });
    return rpcCall(body.method, body.params ?? []);
  }
  if (p === "/chain/faucet") {
    if (!faucet) return Response.json({ enabled: false, reason: "no devnet state (scripts/devnet/devnet.json)" });
    if (req.method === "GET") {
      const w = new URL(req.url).searchParams.get("wallet");
      return Response.json({ ...(await faucet.info().catch((e) => ({ enabled: false, reason: (e as Error).message }))), last: w ? faucet.lastDrip(w) : undefined });
    }
    if (req.method !== "POST") return new Response("GET or POST", { status: 405 });
    const body = (await req.json().catch(() => null)) as { wallet?: string } | null;
    const r = await faucet.drip(String(body?.wallet ?? ""));
    return Response.json(r.body, { status: r.status });
  }
  return new Response("not found", { status: 404 });
}

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

const indexHtml = () => Bun.file(join(DIR, "public/index.html"));

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p.startsWith("/chain/")) return chainRoute(req, p);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405 });
    if (p.startsWith("/api/")) {
      const rest = p.slice(5);
      if (rest === "events") return liveStream(Number(url.searchParams.get("since") ?? 0));
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
    if (p === "/assets/app.css") return new Response(Bun.file(join(DIR, "public/app.css")), { headers: { "content-type": "text/css; charset=utf-8" } });
    if (p === "/favicon.svg") return new Response(Bun.file(join(DIR, "public/favicon.svg")), { headers: { "content-type": "image/svg+xml" } });
    return new Response(indexHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`lineage web on http://${HOST}:${server.port} (core ${CORE}, pid ${process.pid})`);
const stop = () => {
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
