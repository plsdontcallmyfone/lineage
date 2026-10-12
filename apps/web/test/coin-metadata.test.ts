// A launched coin's metadata URI (the defect of the first mainnet test launch: every coin carried
// https://lineage.invalid/...). The server's /coin/* routes answer from chain data alone, the launch
// page refuses to build a launch unless it read the URI back, and the image is a real PNG of the
// agent's face.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { checkMetadataUri, coinMetadataDoc, LAUNCH_PROGRAM_ID, launchPdas, Rpc, TOKEN_2022_PROGRAM } from "../../../packages/chain/src/index.ts";
import { avatarGrid } from "../../../packages/embed/src/pattern.ts";
import { coinRoutes, facePng, hslToRgb } from "../coin-metadata.ts";
import { checkedCoinUri, loadCoinOrigin } from "../wallet/coin-uri.ts";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/coin-tbasalt.json"), "utf8")) as { mint: string; mint_data: string; launch_data: string };
const ORIGIN = "https://app.units.gg";
const HERE = "https://main-157-245-71-188.sslip.io";
const MINT = fx.mint;
const AGENT = "FScgU8v8PtabhWzCxhX1iQEs7JyMP34MV4UWH2gpZrKG";
const NEW_MINT = "C5dYJH9gpLkPrmbWatMhFj2mWGx9pvyRoUenJmFhL6br";
const acct = (owner: string, data: string) => ({ lamports: 1, owner, executable: false, data: [data, "base64"], space: 0 });

/** A chain that holds the recorded coin (its AgentLaunch owned by the active launch program) and nothing else. */
function chain(o: { down?: boolean; foreign?: boolean } = {}) {
  const calls: string[][] = [];
  const rpc = new Rpc(async (method, params) => {
    if (o.down) throw new Error("mainnet RPC did not answer (HTTP 429)");
    if (method !== "getMultipleAccounts") throw new Error(`unexpected ${method}`);
    const keys = params[0] as string[];
    calls.push(keys);
    return { value: keys.map((k) => (k === MINT ? acct(TOKEN_2022_PROGRAM, fx.mint_data) : k === launchPdas.agentLaunch(MINT) && !o.foreign ? acct(LAUNCH_PROGRAM_ID, fx.launch_data) : null)) };
  });
  return { rpc, calls };
}
/** The site as a fetch: the routes answer on HERE; ORIGIN has no DNS record unless `dns`. */
function site(c = chain(), dns = false) {
  const seen: string[] = [];
  const routes: ReturnType<typeof coinRoutes> = coinRoutes({ origin: ORIGIN, rpc: c.rpc, fetch: ((u: string) => f(u)) as unknown as typeof fetch });
  const f = (async (u: string) => {
    const url = new URL(String(u), HERE);
    seen.push(url.href);
    if (url.origin !== HERE && !(dns && url.origin === ORIGIN)) throw new Error("Unable to connect");
    return routes.route(new Request(url), url.pathname);
  }) as unknown as typeof fetch;
  return { f, seen, routes, c };
}

describe("/coin routes", () => {
  test("a launched coin's document comes from its mint and its AgentLaunch, and resolves with its image", async () => {
    const s = site();
    const r = await s.f(`${HERE}/coin/${MINT}.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("x-units-coin")).toBeNull();
    const doc = await r.json();
    expect(doc).toEqual(coinMetadataDoc({ origin: ORIGIN, mint: MINT, agent: AGENT, name: "Test Basalt", symbol: "TBASALT", repoUrl: "https://github.com/keis/base58" }));
    // read once from chain, then held (a coin's name, symbol and launch record do not change)
    await s.f(`${HERE}/coin/${MINT}.json?name=Other&symbol=X&agent=${AGENT}&repo=https://github.com/a/b`).then(async (x) => expect(await x.json()).toEqual(doc));
    expect(s.c.calls.length).toBe(1);
    // the whole chain as a wallet would walk it, on the host that answers
    const walked = await checkMetadataUri(`${ORIGIN}/coin/${MINT}.json`, { fetch: s.f, via: (u) => u.replace(ORIGIN, HERE), expect: { name: "Test Basalt", symbol: "TBASALT" } });
    expect(walked).toMatchObject({ ok: true, image: { type: "image/png" } });
  });

  test("what is not a coin of this deployment is not answered", async () => {
    expect((await site(chain({ foreign: true })).f(`${HERE}/coin/${MINT}.json`)).status).toBe(404);
    const s = site();
    expect((await s.f(`${HERE}/coin/${NEW_MINT}.json`)).status).toBe(404);
    expect((await s.f(`${HERE}/coin/not-an-address.json`)).status).toBe(404);
    expect((await s.f(`${HERE}/coin/face/not-an-address.png`)).status).toBe(404);
    expect((await s.routes.route(new Request(`${HERE}/coin/${MINT}.json`, { method: "POST" }), `/coin/${MINT}.json`)).status).toBe(405);
    const down = await site(chain({ down: true })).f(`${HERE}/coin/${MINT}.json`);
    expect(down.status).toBe(503);
    expect(await down.text()).not.toContain("429");
  });

  test("before the coin exists the path answers a preview from the query, uncached and marked; bad input is refused", async () => {
    const s = site();
    const q = (o: Record<string, string>) => `${HERE}/coin/${NEW_MINT}.json?${new URLSearchParams(o)}`;
    const good = { name: "New One", symbol: "NEW1", agent: AGENT, repo: "https://github.com/keis/base58" };
    const r = await s.f(q(good));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-units-coin")).toBe("preview");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual(coinMetadataDoc({ origin: ORIGIN, mint: NEW_MINT, agent: AGENT, name: "New One", symbol: "NEW1", repoUrl: good.repo }));
    for (const bad of [{ ...good, symbol: "lower" }, { ...good, agent: "nope" }, { ...good, repo: "https://evil.example/x" }, { ...good, name: "x".repeat(33) }, { name: "New One" } as Record<string, string>])
      expect((await s.f(q(bad))).status).toBe(404);
    // nothing of a preview is kept: the bare path is still unknown
    expect((await s.f(`${HERE}/coin/${NEW_MINT}.json`)).status).toBe(404);
  });

  test("the face is a 512 by 512 PNG of the cells every page draws for the agent", async () => {
    const r = await site().f(`${HERE}/coin/face/${AGENT}.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toContain("immutable");
    const b = new Uint8Array(await r.arrayBuffer());
    expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dv = new DataView(b.buffer, b.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20), b[24], b[25]]).toEqual([512, 512, 8, 2]);
    // every chunk's CRC holds, and the pixels are the grid's: centre of each cell, and the ground in the margin
    let o = 8, idat: Uint8Array | null = null;
    while (o < b.length) {
      const len = dv.getUint32(o), type = new TextDecoder().decode(b.subarray(o + 4, o + 8));
      expect(Bun.hash.crc32(b.subarray(o + 4, o + 8 + len))).toBe(dv.getUint32(o + 8 + len));
      if (type === "IDAT") idat = b.subarray(o + 8, o + 8 + len);
      o += 12 + len;
    }
    const raw = new Uint8Array(inflateSync(idat!));
    expect(raw.length).toBe(512 * (1 + 512 * 3));
    const px = (x: number, y: number) => [...raw.subarray(y * 1537 + 1 + x * 3, y * 1537 + 4 + x * 3)];
    const g = avatarGrid(AGENT);
    const cell = 512 / 6, off = cell / 2;
    expect(g.cells.length).toBeGreaterThan(0);
    expect(px(4, 4)).toEqual(hslToRgb(g.bg));
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++) {
        const c = g.cells.find((k) => k.x === x && k.y === y);
        expect(px(Math.floor(off + (x + 0.5) * cell), Math.floor(off + (y + 0.5) * cell))).toEqual(hslToRgb(c ? c.fill : g.bg));
      }
    expect(facePng(AGENT)).toEqual(b);
    expect(hslToRgb("hsl(0 100% 50%)")).toEqual([255, 0, 0]);
    expect(hslToRgb("hsl(120 100% 25%)")).toEqual([0, 128, 0]);
  });
});

describe("the launch page's check before signing", () => {
  const launch = { origin: ORIGIN, here: HERE, mint: NEW_MINT, agent: AGENT, name: "New One", symbol: "NEW1", repoUrl: "https://github.com/keis/base58" };

  test("the URI written on chain names the permanent origin and was read back on this host, though that origin has no DNS record yet", async () => {
    const s = site();
    expect(await loadCoinOrigin(s.f)).toEqual({ origin: ORIGIN, answers: false });
    const uri = await checkedCoinUri({ ...launch, fetch: s.f });
    expect(uri).toBe(`https://app.units.gg/coin/${NEW_MINT}.json`);
    // the document path and the image were both fetched from this host; nothing was asked of the origin without DNS by the check
    expect(s.seen.filter((u) => u.startsWith(`${HERE}/coin/${NEW_MINT}.json?`)).length).toBe(1);
    expect(s.seen).toContain(`${HERE}/coin/face/${AGENT}.png`);
  });

  test("once the origin answers, the page is told so", async () => {
    expect(await loadCoinOrigin(site(chain(), true).f)).toEqual({ origin: ORIGIN, answers: true });
  });

  test("no URI, no launch: a server without the route, a dead route, a wrong document or a dead image all refuse", async () => {
    const html = (async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(loadCoinOrigin(html)).rejects.toThrow(/does not serve coin metadata/);
    await expect(loadCoinOrigin((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).rejects.toThrow(/does not serve coin metadata/);
    await expect(checkedCoinUri({ ...launch, fetch: html })).rejects.toThrow(/not confirmed \(the URI did not answer with JSON\).*not built/);
    await expect(checkedCoinUri({ ...launch, fetch: site(chain({ down: true })).f })).rejects.toThrow(/not confirmed \(the URI answered HTTP 503\)/);
    const s = site();
    const noImage = (async (u: string) => (String(u).includes("/coin/face/") ? new Response("nope", { status: 502 }) : s.f(u))) as unknown as typeof fetch;
    await expect(checkedCoinUri({ ...launch, fetch: noImage })).rejects.toThrow(/the image answered HTTP 502/);
    const other = (async (u: string) => (String(u).includes(".json") ? Response.json({ ...coinMetadataDoc(launch), description: "something else" }) : s.f(u))) as unknown as typeof fetch;
    await expect(checkedCoinUri({ ...launch, fetch: other })).rejects.toThrow(/a different "description"/);
    // a mint that is already a coin answers its own document, never this launch's
    await expect(checkedCoinUri({ ...launch, mint: MINT, fetch: s.f })).rejects.toThrow(/"name" is "Test Basalt", the coin's is "New One"/);
  });
});
