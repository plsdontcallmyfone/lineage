// Lineage dashboard server (read-only). Serves the client bundle and proxies GET requests to Core.
//
//   bun apps/web/server.ts --port 9661 --core http://127.0.0.1:9660 [--host 127.0.0.1] [--dev]
//
// Routes:
//   /api/<path>        GET proxy to <core>/v1/<path> (JSON, blobs)
//   /live/events       SSE fan-out of Core's event stream (one upstream connection, shared)
//   /live/recent       last N events held in memory (?limit=, ?agent=, ?candidate=)
//   /live/spec         docs/SPEC.md as text (the Manual page renders it with live config values)
//   /assets/app.js     client bundle (Bun.build at startup; rebuilt per request with --dev)
//   everything else    index.html (client-side routing)

import { execFileSync } from "node:child_process";
import { join } from "node:path";

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
