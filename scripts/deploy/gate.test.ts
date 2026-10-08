import { describe, expect, test } from "bun:test";
import { classify, clientIp, Limiter, LIMITS } from "./gate.ts";

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
