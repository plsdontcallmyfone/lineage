import { describe, expect, test } from "bun:test";
import { classify, clientIp, clientKey, Limiter, LIMITS, MAX_BUCKETS, originAllowed, readCapped, StreamSlots, upstreamHeaders } from "./gate.ts";

describe("classify", () => {
  test("Core public reads pass, admin does not", () => {
    expect(classify("GET", "/v1/lineages")).toMatchObject({ klass: "v1", upstream: "core", cors: true });
    expect(classify("GET", "/v1/events")).toMatchObject({ stream: true });
    expect(classify("GET", "/v1/admin/ledger")).toEqual({ refuse: 404, why: "admin" });
    expect(classify("POST", "/v1/candidates")).toEqual({ refuse: 405, why: "method" });
    expect(classify("DELETE", "/api/lineages")).toEqual({ refuse: 405, why: "method" });
  });
  test("chain writes are same-origin and classed", () => {
    expect(classify("POST", "/chain/rpc")).toMatchObject({ klass: "rpc", sameOrigin: true, cors: false });
    expect(classify("POST", "/chain/faucet")).toMatchObject({ klass: "faucet", sameOrigin: true });
    expect(classify("POST", "/chain/config")).toEqual({ refuse: 405, why: "method" });
    expect(classify("GET", "/chain/config")).toMatchObject({ upstream: "web", cors: false });
  });
  test("only bounty terms take PUT", () => {
    const id = "2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY";
    expect(classify("PUT", `/api/bounties/${id}/terms`)).toMatchObject({ klass: "terms", upstream: "web" });
    expect(classify("PUT", `/v1/bounties/${id}/terms`)).toMatchObject({ klass: "terms", upstream: "core" });
    expect(classify("PUT", `/v1/bounties/${id}/other`)).toEqual({ refuse: 405, why: "method" });
  });
  test("pages and live data", () => {
    expect(classify("GET", "/")).toMatchObject({ klass: "page", upstream: "web" });
    expect(classify("GET", "/live/events")).toMatchObject({ klass: "api", stream: true });
    expect(classify("GET", "/api/events")).toMatchObject({ stream: true });
  });
});

describe("limiter", () => {
  test("burst then refill at the class rate", () => {
    let now = 0;
    const l = new Limiter(() => now);
    for (let i = 0; i < LIMITS.faucet.burst; i++) expect(l.take("1.2.3.4", "faucet").ok).toBe(true);
    const r = l.take("1.2.3.4", "faucet");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryS).toBe(1200);
    expect(l.take("5.6.7.8", "faucet").ok).toBe(true);
    now += 20 * 60_000;
    expect(l.take("1.2.3.4", "faucet").ok).toBe(true);
    expect(l.take("1.2.3.4", "faucet").ok).toBe(false);
  });
  test("sweep drops full buckets only", () => {
    let now = 0;
    const l = new Limiter(() => now);
    l.take("a", "v1");
    for (let i = 0; i < LIMITS.faucet.burst; i++) l.take("b", "faucet");
    now += 60_000;
    l.sweep();
    expect(l.size).toBe(1);
  });
});

test("client address is the last forwarded entry", () => {
  const req = new Request("http://x/", { headers: { "x-forwarded-for": "9.9.9.9, 1.2.3.4" } });
  expect(clientIp(req, "127.0.0.1")).toBe("1.2.3.4");
  expect(clientIp(new Request("http://x/"), "127.0.0.1")).toBe("127.0.0.1");
});

// ---------------------------------------------------------------------------------------------
// offchain audit A2 (docs/AUDIT.md, Offchain): each test failed on the gate before its fix

describe("audit A2: gate", () => {
  test("OFF-D1 stream slots are reserved before the upstream answers (parallel opens cannot pass the cap)", () => {
    const s = new StreamSlots(4, 6);
    const held = [1, 2, 3, 4].map(() => s.reserve("a"));
    expect(held.every(Boolean)).toBe(true);
    expect(s.reserve("a")).toBeNull();
    held[0]!();
    held[0]!(); // idempotent
    expect(s.of("a")).toBe(3);
    expect(s.reserve("a")).not.toBeNull();
    expect(s.reserve("b")).not.toBeNull();
    expect(s.reserve("c")).not.toBeNull();
    expect(s.reserve("d")).toBeNull(); // global cap 6
    expect(s.total).toBe(6);
  });

  test("OFF-D2 an IPv6 /64 is one client; IPv4-mapped is its IPv4", () => {
    expect(clientKey("2001:db8:1:2::1")).toBe(clientKey("2001:db8:1:2:ffff:1:2:3"));
    expect(clientKey("2001:db8:1:2::1")).not.toBe(clientKey("2001:db8:1:3::1"));
    expect(clientKey("2001:0db8:0001:0002:0000:0000:0000:0009")).toBe(clientKey("2001:db8:1:2::9"));
    expect(clientKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(clientKey("[2001:db8::1]")).toBe(clientKey("2001:db8::2"));
    expect(clientKey("1.2.3.4")).toBe("1.2.3.4");
    // rotating addresses inside one /64 share one faucet bucket
    const l = new Limiter(() => 0);
    for (let i = 1; i <= LIMITS.faucet.burst; i++) expect(l.take(clientKey(`2001:db8:5:6::${i}`), "faucet").ok).toBe(true);
    expect(l.take(clientKey("2001:db8:5:6::abcd"), "faucet").ok).toBe(false);
  });

  test("OFF-D3 the limiter holds a bounded number of buckets", () => {
    const l = new Limiter(() => 0, 1000);
    for (let i = 0; i < 10_000; i++) l.take(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, "faucet");
    expect(l.size).toBeLessThanOrEqual(1000);
    expect(MAX_BUCKETS).toBeGreaterThan(0);
  });

  test("OFF-D4 /api cannot reach Core's admin routes or smuggle path separators", () => {
    expect(classify("GET", "/api/admin/ledger")).toEqual({ refuse: 404, why: "admin" });
    expect(classify("GET", "/api//admin/ledger")).toEqual({ refuse: 404, why: "admin" });
    expect(classify("GET", "/api/x%2f..%2fadmin")).toEqual({ refuse: 404, why: "admin" });
    expect(classify("GET", "/api/lineages")).toMatchObject({ klass: "api" });
    expect(classify("POST", "/souls/draft")).toEqual({ refuse: 405, why: "method" });
  });

  test("OFF-D5 bodies are read with a cap and a deadline, never buffered past the cap", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(16 * 1024));
      },
    });
    expect(await readCapped(endless, 64 * 1024, 5_000)).toEqual({ ok: false, status: 413 });
    expect(pulled).toBeLessThan(10);
    const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)); } });
    expect(await readCapped(stalled, 1024, 50)).toEqual({ ok: false, status: 408 });
    const ok = await readCapped(new Response("hello").body, 1024, 1000);
    expect(ok.ok && new TextDecoder().decode(ok.bytes)).toBe("hello");
  });

  test("OFF-D6 chain writes need a listed Origin; a missing Origin is refused", () => {
    expect(originAllowed(null, "site.example", [])).toBe(false);
    expect(originAllowed("https://site.example", "site.example", [])).toBe(true);
    expect(originAllowed("https://evil.example", "site.example", [])).toBe(false);
    expect(originAllowed("https://a.example", "site.example", ["https://a.example"])).toBe(true);
  });

  test("OFF-D7 upstreams get one X-Forwarded-For and no client proxy or credential headers", () => {
    const req = new Request("http://x/", {
      headers: { forwarded: "for=6.6.6.6", "x-real-ip": "6.6.6.6", cookie: "a=b", "proxy-authorization": "x", "x-forwarded-for": "6.6.6.6, 1.2.3.4", "x-lineage-agent": "A", accept: "text/event-stream" },
    });
    const h = upstreamHeaders(req, "1.2.3.4");
    expect(h.get("x-forwarded-for")).toBe("1.2.3.4");
    for (const k of ["forwarded", "x-real-ip", "cookie", "proxy-authorization"]) expect(h.has(k)).toBe(false);
    expect(h.get("x-lineage-agent")).toBe("A");
    expect(h.get("accept")).toBe("text/event-stream");
  });

  test("OFF-D8 /market goes through the gate in its own class to the indexer", () => {
    expect(classify("GET", "/market/tokens")).toMatchObject({ klass: "market", upstream: "indexer" });
    expect(classify("POST", "/market/tokens")).toEqual({ refuse: 405, why: "method" });
    expect(LIMITS.market.perMin).toBeGreaterThan(0);
  });
});

test("OFF-D9 the page CSP allows exactly the inline theme script of index.html, in Caddy and in the web server", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { join } = await import("node:path");
  const root = join(import.meta.dir, "../..");
  const html = readFileSync(join(root, "apps/web/public/index.html"), "utf8");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
  expect(inline).toHaveLength(1);
  for (const f of ["scripts/deploy/caddy/Caddyfile.tmpl", "apps/web/server.ts"]) {
    const src = readFileSync(join(root, f), "utf8");
    const csp = /default-src 'self';[^"]*/.exec(src)?.[0] ?? "";
    expect(csp).toContain(`script-src 'self' ${inline[0]};`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  }
});
