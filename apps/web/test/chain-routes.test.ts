// The web server's /chain/* routes under the network profile (M3, SPEC 14.10), with a mock upstream:
// devnet answers as before; mainnet has no faucet, shows the profile (no TEST labels, the configured
// quote), allows the priority-fee read, and never lets the keyed upstream URL reach a browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectProfile } from "../../../packages/chain/src/profile.ts";
import { chainRoutes, scrubber, type FaucetLike } from "../chain-routes.ts";

const raw = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/profile.json"), "utf8"));
const devnet = selectProfile(raw, "devnet");
const mainnet = selectProfile(raw, "mainnet");
const KEY = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const KEYED = `https://mainnet.helius-rpc.example/?api-key=${KEY}`;

function upstream(genesis: string, opts: { throwWithUrl?: boolean } = {}) {
  const seen: { url: string; method: string }[] = [];
  const f = (async (url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    seen.push({ url, method: b.method });
    if (opts.throwWithUrl && b.method !== "getGenesisHash") throw new Error(`Unable to connect to ${url}`);
    const result = b.method === "getGenesisHash" ? genesis : b.method === "getRecentPrioritizationFees" ? [{ slot: 1, prioritizationFee: 7 }] : `echo ${url}`;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, seen };
}
const faucet: FaucetLike = {
  address: "Fauc3tAddr",
  info: async () => ({ enabled: true, amount: "1000" }),
  lastDrip: () => null,
  drip: async () => ({ status: 200, body: { signature: "s" } }),
};
const post = (body: unknown) => new Request("http://x/chain/rpc", { method: "POST", body: JSON.stringify(body) });
const nosleep = async () => {};

describe("devnet profile: as before", () => {
  const state = { line_mint: "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU", line_decimals: 6, rpc_url: "https://api.devnet.solana.com", core_authority_key: "~/k.json", test_epoch_leaves: [] };

  test("/chain/config keeps every earlier field, the faucet and devnet, and adds the public profile", async () => {
    const u = upstream(devnet.genesis);
    const r = chainRoutes({ profile: devnet, rpcUrl: "https://api.devnet.solana.com", state, faucet, fetch: u.f, sleep: nosleep });
    const j = await (await r.route(new Request("http://x/chain/config"), "/chain/config")).json();
    expect(j).toMatchObject({ rpc: "/chain/rpc", rpc_upstream: "https://api.devnet.solana.com", genesis: devnet.genesis, cluster: "devnet", devnet: true, faucet: "Fauc3tAddr" });
    // same state filtering as before: keys and test leaves out, the public devnet URL kept
    expect(j.state).toEqual({ line_mint: state.line_mint, line_decimals: 6, rpc_url: state.rpc_url });
    expect(j.profile).toMatchObject({ network: "devnet", faucet: true, test_labels: true, quote: { symbol: "tLINE" } });
  });

  test("sends are allowed to devnet and refused when the upstream is another cluster", async () => {
    const ok = chainRoutes({ profile: devnet, rpcUrl: "u", state, faucet, fetch: upstream(devnet.genesis).f, sleep: nosleep });
    expect((await ok.route(post({ method: "sendTransaction", params: [] }), "/chain/rpc")).status).toBe(200);
    const bad = chainRoutes({ profile: devnet, rpcUrl: "u", state, faucet, fetch: upstream(mainnet.genesis).f, sleep: nosleep });
    const res = await bad.route(post({ id: 1, method: "sendTransaction", params: [] }), "/chain/rpc");
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("upstream is not devnet; refusing to send");
  });

  test("faucet routes reach the faucet", async () => {
    const r = chainRoutes({ profile: devnet, rpcUrl: "u", state, faucet, fetch: upstream(devnet.genesis).f, sleep: nosleep });
    expect(await (await r.route(new Request("http://x/chain/faucet"), "/chain/faucet")).json()).toMatchObject({ enabled: true });
  });
});

describe("mainnet profile", () => {
  const state = { registry_program: "R", launch_program: "L", line_mint: mainnet.quote.mint, line_decimals: 6, rpc_url: KEYED, deployer_key: "~/x.json" };

  test("no faucet: none is built, the route says so, config names none", async () => {
    const r = chainRoutes({ profile: mainnet, rpcUrl: KEYED, state, faucet, fetch: upstream(mainnet.genesis).f, sleep: nosleep });
    expect(r.faucet).toBeNull();
    const fj = await (await r.route(new Request("http://x/chain/faucet"), "/chain/faucet")).json();
    expect(fj).toEqual({ enabled: false, reason: "no faucet on mainnet" });
    const post = await r.route(new Request("http://x/chain/faucet", { method: "POST", body: "{}" }), "/chain/faucet");
    expect(await post.json()).toMatchObject({ enabled: false });
    const cj = await (await r.route(new Request("http://x/chain/config"), "/chain/config")).json();
    expect(cj.faucet).toBeNull();
    expect(cj.profile).toMatchObject({ network: "mainnet", faucet: false, test_labels: false, swap: true, quote: { symbol: mainnet.quote.symbol, mint: mainnet.quote.mint, decimals: 6 } });
    expect(JSON.stringify(cj)).not.toMatch(/TEST/);
  });

  test("the keyed URL never reaches the browser: config, state, RPC answers and errors", async () => {
    const u = upstream(mainnet.genesis);
    const r = chainRoutes({ profile: mainnet, rpcUrl: KEYED, state, faucet: null, fetch: u.f, sleep: nosleep });
    const cfg = await (await r.route(new Request("http://x/chain/config"), "/chain/config")).text();
    expect(cfg).not.toContain(KEY);
    expect(cfg).toContain("(keyed)");
    expect(JSON.parse(cfg).state.rpc_url).toBeUndefined();
    // an upstream answer that echoes its own URL is scrubbed
    const echo = await (await r.route(post({ method: "getSlot", params: [] }), "/chain/rpc")).text();
    expect(echo).not.toContain(KEY);
    // a network error message that names the URL is scrubbed
    const t = upstream(mainnet.genesis, { throwWithUrl: true });
    const r2 = chainRoutes({ profile: mainnet, rpcUrl: KEYED, state, faucet: null, fetch: t.f, sleep: nosleep });
    const err = await r2.route(post({ method: "getSlot", params: [] }), "/chain/rpc");
    expect(err.status).toBe(502);
    const body = await err.text();
    expect(body).not.toContain(KEY);
    expect(body).toContain("mainnet-beta RPC did not answer");
    // the server itself did call the keyed upstream
    expect(u.seen.every((s) => s.url === KEYED)).toBe(true);
  });

  test("priority-fee reads are proxied; sends only when the upstream is mainnet", async () => {
    const r = chainRoutes({ profile: mainnet, rpcUrl: KEYED, state, faucet: null, fetch: upstream(mainnet.genesis).f, sleep: nosleep });
    const fees = await (await r.route(post({ method: "getRecentPrioritizationFees", params: [["a"]] }), "/chain/rpc")).json();
    expect(fees.result).toEqual([{ slot: 1, prioritizationFee: 7 }]);
    const wrong = chainRoutes({ profile: mainnet, rpcUrl: KEYED, state, faucet: null, fetch: upstream(devnet.genesis).f, sleep: nosleep });
    const res = await wrong.route(post({ id: 2, method: "sendTransaction", params: [] }), "/chain/rpc");
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("upstream is not mainnet-beta; refusing to send");
  });
});

test("scrubber removes the URL, its query value and long path segments", () => {
  const s = scrubber(KEYED);
  expect(s(`x ${KEYED} y`)).toBe("x [redacted] y");
  expect(s(`key=${KEY}`)).not.toContain(KEY);
  const p = scrubber("https://rpc.example/v2/abcdefghijkl");
  expect(p("GET /v2/abcdefghijkl failed")).not.toContain("abcdefghijkl");
});
