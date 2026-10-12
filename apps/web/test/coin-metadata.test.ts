// A launched coin's metadata URI (the defect of the first mainnet test launch: every coin carried
// https://lineage.invalid/...). The server's /coin/* routes answer from chain data alone, the launch
// page refuses to build a launch unless it read the URI back, and the image is a real PNG of the
// agent's face.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { bytesToHex, checkMetadataUri, coinImageId, coinImageOfUri, coinLinkProblem, coinLinksFromStored, coinLinksId, coinLinksJson, coinLinksOfUri, coinMetadataDoc, coinMetadataUri, coinMetadataUriBytes, MAX_LAUNCH_STRINGS, normalizeCoinLinks, LAUNCH_PROGRAM_ID, launchPdas, Rpc, sha256, TOKEN_2022_PROGRAM } from "../../../packages/chain/src/index.ts";
import { generateWebKey } from "../../../packages/chain/src/browser/wire.ts";
import { verifyStatement } from "../../../packages/core/src/protocol.ts";
import { avatarGrid } from "../../../packages/embed/src/pattern.ts";
import { coinRoutes, facePng, hslToRgb } from "../coin-metadata.ts";
import { checkedCoinUri, loadCoinOrigin, storeCoinImage, storeCoinLinks } from "../wallet/coin-uri.ts";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/coin-tbasalt.json"), "utf8")) as { mint: string; mint_data: string; launch_data: string };
const ORIGIN = "https://app.units.gg";
const HERE = "https://main-157-245-71-188.sslip.io";
const MINT = fx.mint;
const AGENT = "FScgU8v8PtabhWzCxhX1iQEs7JyMP34MV4UWH2gpZrKG";
const NEW_MINT = "C5dYJH9gpLkPrmbWatMhFj2mWGx9pvyRoUenJmFhL6br";
const acct = (owner: string, data: string) => ({ lamports: 1, owner, executable: false, data: [data, "base64"], space: 0 });

const PNG = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6b3b10000000049454e44ae426082", "hex"));
const PNG_SHA = bytesToHex(sha256(PNG));
const PNG_ID = coinImageId(PNG_SHA);
const file = (bytes: Uint8Array, type = "image/png") => ({ type, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer });
/** The recorded mint with another URI in its metadata extension (the name and symbol before it are untouched). */
function mintWithUri(uri: string): string {
  const d = Buffer.from(fx.mint_data, "base64");
  const old = "https://lineage.invalid/mainnet/agents/tbasalt.json?class=python";
  const at = d.indexOf(Buffer.from(old));
  if (at < 0 || uri.length > old.length) throw new Error("the stand-in URI must fit the recorded one");
  d.write(uri.padEnd(old.length, "&"), at);
  return d.toString("base64");
}

/** A chain that holds the recorded coin (its AgentLaunch owned by the active launch program) and nothing else. */
function chain(o: { down?: boolean; foreign?: boolean; mintData?: string } = {}) {
  const calls: string[][] = [];
  const rpc = new Rpc(async (method, params) => {
    if (o.down) throw new Error("mainnet RPC did not answer (HTTP 429)");
    if (method !== "getMultipleAccounts") throw new Error(`unexpected ${method}`);
    const keys = params[0] as string[];
    calls.push(keys);
    return { value: keys.map((k) => (k === MINT ? acct(TOKEN_2022_PROGRAM, o.mintData ?? fx.mint_data) : k === launchPdas.agentLaunch(MINT) && !o.foreign ? acct(LAUNCH_PROGRAM_ID, fx.launch_data) : null)) };
  });
  return { rpc, calls };
}
const CORE = "http://core.test";
/**
 * The site as a fetch: the /coin routes answer on HERE; ORIGIN has no DNS record unless `dns`. Behind it a
 * stand-in for Core's media store: POST /social/media/<agent> keeps a coin image when its statement verifies
 * with Core's own verifier as signed by the agent key (the rule of packages/core/src/social.ts uploadMedia,
 * whose own test is packages/core/test/social.test.ts), GET /v1/media/<sha256> serves it.
 */
function site(c = chain(), dns = false) {
  const seen: string[] = [];
  const media = new Map<string, { type: string; bytes: Uint8Array }>();
  const posts: { agent: string; statement: Record<string, unknown> }[] = [];
  const routes: ReturnType<typeof coinRoutes> = coinRoutes({ origin: ORIGIN, core: CORE, rpc: c.rpc, fetch: ((u: string) => f(u)) as unknown as typeof fetch });
  const f = (async (u: string, init?: { method?: string; body?: string }) => {
    const url = new URL(String(u), HERE);
    seen.push(url.href);
    if (url.origin === CORE) {
      const m = media.get(url.pathname.replace("/v1/media/", ""));
      return m ? new Response(m.bytes as unknown as BodyInit, { headers: { "content-type": m.type } }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.origin !== HERE && !(dns && url.origin === ORIGIN)) throw new Error("Unable to connect");
    const up = /^\/social\/media\/([^/]+)$/.exec(url.pathname);
    if (up && init?.method === "POST") {
      const b = JSON.parse(init.body!) as { statement: Record<string, any>; sig: string; data: string };
      const st = b.statement;
      if ((st.slot !== "coin" && st.slot !== "links") || st.agent !== up[1] || st.signer !== up[1] || !verifyStatement(st.signer, b.sig, "media", st)) return Response.json({ error: "bad_signature", message: "sig does not verify" }, { status: 401 });
      posts.push({ agent: up[1]!, statement: st });
      const bytes = new Uint8Array(Buffer.from(b.data, "base64"));
      if (st.sha256 === "") return Response.json({ cleared: true });
      if (bytesToHex(sha256(bytes)) !== st.sha256 || st.size !== bytes.length) return Response.json({ error: "hash_mismatch" }, { status: 400 });
      media.set(st.sha256, { type: st.type, bytes });
      return Response.json({ sha256: st.sha256 });
    }
    return routes.route(new Request(url), url.pathname);
  }) as unknown as typeof fetch;
  return { f, seen, routes, c, media, posts };
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

describe("the image the launcher chose", () => {
  const launch = { origin: ORIGIN, here: HERE, mint: NEW_MINT, name: "New One", symbol: "NEW1", repoUrl: "https://github.com/keis/base58" };

  test("the document with a chosen image and without one", () => {
    const base = { ...launch, agent: AGENT };
    expect(coinMetadataDoc(base).image).toBe(`${ORIGIN}/coin/face/${AGENT}.png`);
    expect(coinMetadataDoc({ ...base, imageId: null }).image).toBe(`${ORIGIN}/coin/face/${AGENT}.png`);
    const chosen = coinMetadataDoc({ ...base, imageId: PNG_ID });
    expect(chosen.image).toBe(`${ORIGIN}/coin/image/${PNG_ID}`);
    expect({ ...chosen, image: "" }).toEqual({ ...coinMetadataDoc(base), image: "" });
    expect(coinMetadataUri(ORIGIN, NEW_MINT, PNG_ID)).toBe(`${ORIGIN}/coin/${NEW_MINT}.json?i=${PNG_ID}`);
    expect(coinImageOfUri(coinMetadataUri(ORIGIN, NEW_MINT, PNG_ID))).toBe(PNG_ID);
    for (const none of [coinMetadataUri(ORIGIN, NEW_MINT), `${ORIGIN}/coin/${NEW_MINT}.json?i=not-a-hash`, "https://lineage.invalid/mainnet/agents/tbasalt.json?class=python", "", null]) expect(coinImageOfUri(none)).toBeNull();
  });

  test("picked in the wizard: stored under the agent key's signature before signing, named in the URI by its hash, read back byte for byte", async () => {
    const s = site();
    const agent = await generateWebKey();
    const image = await storeCoinImage(agent, file(PNG), s.f);
    expect(image).toEqual({ imageId: PNG_ID, sha256: PNG_SHA });
    // the statement Core's verifier accepted: the agent key speaks for itself, slot coin
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.statement).toMatchObject({ kind: "units-media", slot: "coin", agent: agent.id, signer: agent.id, sha256: PNG_SHA, type: "image/png", size: PNG.length });
    const uri = await checkedCoinUri({ ...launch, agent: agent.id, image, fetch: s.f });
    expect(uri).toBe(`https://app.units.gg/coin/${NEW_MINT}.json?i=${PNG_ID}`);
    // the pre-signing check fetched the chosen image on this host, through the app server, from Core
    expect(s.seen).toContain(`${HERE}/coin/image/${PNG_ID}`);
    expect(s.seen).toContain(`${CORE}/v1/media/${PNG_SHA}`);
    const img = await s.f(`${HERE}/coin/image/${PNG_ID}`);
    expect([img.status, img.headers.get("content-type"), img.headers.get("cache-control"), img.headers.get("access-control-allow-origin")]).toEqual([200, "image/png", "public, max-age=31536000, immutable", "*"]);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });

  test("no image picked: nothing is uploaded and the coin shows the generated face; a pick taken back is cleared", async () => {
    const s = site();
    const agent = await generateWebKey();
    expect(await storeCoinImage(agent, null, s.f)).toBeNull();
    expect(s.posts).toHaveLength(0);
    expect(await checkedCoinUri({ ...launch, agent: agent.id, image: null, fetch: s.f })).toBe(`https://app.units.gg/coin/${NEW_MINT}.json`);
    expect(s.seen).toContain(`${HERE}/coin/face/${agent.id}.png`);
    await storeCoinImage(agent, file(PNG), s.f);
    expect(await storeCoinImage(agent, null, s.f)).toBeNull();
    expect(s.posts.map((p) => p.statement.sha256)).toEqual([PNG_SHA, ""]);
  });

  test("no launch is built when the image is refused, is not stored, or comes back as other bytes", async () => {
    const agent = await generateWebKey();
    await expect(storeCoinImage(agent, file(new TextEncoder().encode("<svg/>"), "image/svg+xml"))).rejects.toThrow(/PNG, JPEG or WebP, at most 256 KB/);
    await expect(storeCoinImage(agent, file(new Uint8Array(256 * 1024 + 1)))).rejects.toThrow(/at most 256 KB/);
    const refused = (async () => Response.json({ error: "social_busy", message: "too many social writes right now" }, { status: 429 })) as unknown as typeof fetch;
    await expect(storeCoinImage(agent, file(PNG), refused)).rejects.toThrow(/was not stored \(too many social writes right now\).*not built/);
    // named in the URI but never stored: the image does not load
    const s = site();
    await expect(checkedCoinUri({ ...launch, agent: agent.id, image: { imageId: PNG_ID, sha256: PNG_SHA }, fetch: s.f })).rejects.toThrow(/the image answered HTTP 404/);
    // stored, but the host hands back different bytes
    s.media.set(PNG_SHA, { type: "image/png", bytes: Uint8Array.from([...PNG, 0]) });
    await expect(checkedCoinUri({ ...launch, agent: agent.id, image: { imageId: PNG_ID, sha256: PNG_SHA }, fetch: s.f })).rejects.toThrow(/did not come back as the file you chose/);
  });

  test("after the launch the image is the one the coin's own URI names: a request cannot name another, and an unknown hash is not served", async () => {
    // the recorded coin, as if launched with the chosen image (its on-chain URI rewritten in place, same length)
    const onChain = `https://a.gg/?i=${PNG_ID}`;
    expect(coinImageOfUri(onChain)).toBe(PNG_ID);
    const s = site(chain({ mintData: mintWithUri(onChain) }));
    s.media.set(PNG_SHA, { type: "image/png", bytes: PNG });
    const other = coinImageId("ab".repeat(32));
    for (const q of ["", `?i=${other}`, `?i=${other}&name=Evil&symbol=EVIL&agent=${AGENT}&repo=https://github.com/a/b`]) {
      const doc = await (await s.f(`${HERE}/coin/${MINT}.json${q}`)).json();
      expect(doc).toEqual(coinMetadataDoc({ origin: ORIGIN, mint: MINT, agent: AGENT, name: "Test Basalt", symbol: "TBASALT", repoUrl: "https://github.com/keis/base58", imageId: PNG_ID }));
    }
    // the coin launched without one keeps the generated face whatever a request says
    const plain = await (await site().f(`${HERE}/coin/${MINT}.json?i=${PNG_ID}`)).json();
    expect(plain.image).toBe(`${ORIGIN}/coin/face/${AGENT}.png`);
    expect((await s.f(`${HERE}/coin/image/${other}`)).status).toBe(404);
    expect((await s.f(`${HERE}/coin/image/not-an-id`)).status).toBe(404);
    // an image the admin hid in Core (410 there) is gone here too, and a non-image is never passed on
    const hidden = coinRoutes({ origin: ORIGIN, core: CORE, rpc: chain().rpc, fetch: (async () => Response.json({ error: "hidden" }, { status: 410 })) as unknown as typeof fetch });
    expect((await hidden.route(new Request(`${HERE}/coin/image/${PNG_ID}`), `/coin/image/${PNG_ID}`)).status).toBe(410);
    const html = coinRoutes({ origin: ORIGIN, core: CORE, rpc: chain().rpc, fetch: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch });
    expect((await html.route(new Request(`${HERE}/coin/image/${PNG_ID}`), `/coin/image/${PNG_ID}`)).status).toBe(404);
  });
});

// The coin's links (owner 2026-10-12): three fields in pump.fun's names, bound into the on-chain URI by the
// hash of their text, the way the image is.
describe("links: twitter, telegram, website", () => {
  const LINKS = { twitter: "https://x.com/unitscoin", telegram: "https://t.me/unitscoin", website: "https://example.org/coin" };
  const TEXT = '{"twitter":"https://x.com/unitscoin","telegram":"https://t.me/unitscoin","website":"https://example.org/coin"}';
  const ID = coinLinksId(LINKS)!;
  const SHA = bytesToHex(sha256(new TextEncoder().encode(TEXT)));
  const base = { origin: ORIGIN, mint: NEW_MINT, agent: AGENT, name: "Test Basalt", symbol: "TBASALT", repoUrl: "https://github.com/keis/base58" };
  const launch = { origin: ORIGIN, here: HERE, mint: NEW_MINT, name: "New One", symbol: "NEW1", repoUrl: "https://github.com/keis/base58" };

  test("each field takes an https link on its own site; anything else is refused with the field's name", () => {
    expect(normalizeCoinLinks({ twitter: " https://x.com/unitscoin ", telegram: "", website: "https://example.org/coin" })).toEqual({ links: { twitter: "https://x.com/unitscoin", website: "https://example.org/coin" }, problems: [] });
    expect(normalizeCoinLinks({}).links).toEqual({});
    for (const ok of ["https://x.com/a", "https://twitter.com/a", "https://www.x.com/a/status/1"]) expect(coinLinkProblem("twitter", ok)).toBeNull();
    for (const ok of ["https://t.me/a", "https://t.me/+AbCd"]) expect(coinLinkProblem("telegram", ok)).toBeNull();
    expect(coinLinkProblem("twitter", "https://t.me/a")).toMatch(/^Twitter \(X\): a link on x\.com or twitter\.com/);
    expect(coinLinkProblem("twitter", "https://x.com.evil.example/a")).toMatch(/x\.com or twitter\.com/);
    expect(coinLinkProblem("twitter", "https://x.com/")).toMatch(/an account or a post/);
    expect(coinLinkProblem("telegram", "https://x.com/a")).toMatch(/^Telegram: a link on t\.me/);
    for (const bad of ["http://example.org", "example.org", "javascript:alert(1)", "https://user:pw@example.org", "https://localhost", "https://exa mple.org", 'https://example.org/"><script>', `https://example.org/${"a".repeat(120)}`]) expect(coinLinkProblem("website", bad), bad).toMatch(/^Website: /);
    expect(normalizeCoinLinks({ website: "https://example.org", discord: "https://discord.gg/x" }).problems[0]).toMatch(/unknown field/);
    expect(normalizeCoinLinks({ website: 5 }).problems[0]).toMatch(/Website/);
  });

  test("the document with links and without: pump.fun's three fields, present only when given; the website falls back to the agent's page", () => {
    const none = coinMetadataDoc(base);
    expect(none).not.toHaveProperty("twitter");
    expect(none).not.toHaveProperty("telegram");
    expect(none.website).toBe(`${ORIGIN}/tokens/${NEW_MINT}`);
    const all = coinMetadataDoc({ ...base, links: LINKS });
    expect([all.twitter, all.telegram, all.website]).toEqual([LINKS.twitter, LINKS.telegram, LINKS.website]);
    expect(Object.keys(all)).toEqual(["name", "symbol", "description", "showName", "image", "createdOn", "twitter", "telegram", "website"]);
    const tw = coinMetadataDoc({ ...base, links: { twitter: LINKS.twitter } });
    expect(tw.twitter).toBe(LINKS.twitter);
    expect(tw).not.toHaveProperty("telegram");
    expect(tw.website).toBe(`${ORIGIN}/tokens/${NEW_MINT}`);
    expect(all.image).toBe(none.image);
  });

  test("one text, one id: the id is the sha256 of the canonical text and rides in the URI beside the image's", () => {
    expect(coinLinksJson({ website: LINKS.website, telegram: LINKS.telegram, twitter: LINKS.twitter })).toBe(TEXT);
    expect(coinLinksJson({})).toBe("");
    expect(coinLinksId({})).toBeNull();
    expect(coinImageId(SHA)).toBe(ID);
    expect(coinMetadataUri(ORIGIN, NEW_MINT, null, ID)).toBe(`${ORIGIN}/coin/${NEW_MINT}.json?l=${ID}`);
    const both = coinMetadataUri(ORIGIN, NEW_MINT, PNG_ID, ID);
    expect(both).toBe(`${ORIGIN}/coin/${NEW_MINT}.json?i=${PNG_ID}&l=${ID}`);
    expect([coinImageOfUri(both), coinLinksOfUri(both)]).toEqual([PNG_ID, ID]);
    for (const none of [coinMetadataUri(ORIGIN, NEW_MINT, PNG_ID), `${ORIGIN}/coin/${NEW_MINT}.json?l=nope`, "", null]) expect(coinLinksOfUri(none)).toBeNull();
    expect(coinLinksFromStored(TEXT, ID)).toEqual(LINKS);
  });

  test("the URI with an image and links leaves the launch its room: measured against the launch's string budget", () => {
    // the longest URI: the origin, a 44 character mint, an image id and a links id
    const longest = coinMetadataUriBytes(ORIGIN, true, true);
    expect(longest).toBe(coinMetadataUriBytes(ORIGIN, true, false) + 47);
    expect(longest).toBe(169);
    // with a 32 byte name and a 10 character ticker, what is left for the repository URL (https://github.com/owner/name)
    expect(MAX_LAUNCH_STRINGS - longest - 32 - 10).toBe(116);
  });

  test("typed in the wizard: stored under the agent key's signature, named in the URI by their hash, read back in the document before signing", async () => {
    const s = site();
    const agent = await generateWebKey();
    expect(await storeCoinLinks(agent, {}, s.f)).toBeNull();
    expect(s.posts).toHaveLength(0);
    expect(await storeCoinLinks(agent, LINKS, s.f)).toBe(ID);
    expect(s.posts[0]!.statement).toMatchObject({ kind: "units-media", slot: "links", agent: agent.id, signer: agent.id, sha256: SHA, type: "application/json", size: TEXT.length });
    expect(new TextDecoder().decode(s.media.get(SHA)!.bytes)).toBe(TEXT);
    // the same links again are not sent again
    await storeCoinLinks(agent, LINKS, s.f);
    expect(s.posts).toHaveLength(1);
    const uri = await checkedCoinUri({ ...launch, agent: agent.id, image: null, links: LINKS, fetch: s.f });
    expect(uri).toBe(`https://app.units.gg/coin/${NEW_MINT}.json?l=${ID}`);
    expect(s.seen).toContain(`${CORE}/v1/media/${SHA}`);
    const preview = await (await s.f(`${HERE}/coin/${NEW_MINT}.json?l=${ID}&name=New+One&symbol=NEW1&agent=${agent.id}&repo=https://github.com/keis/base58`)).json();
    expect([preview.twitter, preview.telegram, preview.website]).toEqual([LINKS.twitter, LINKS.telegram, LINKS.website]);
  });

  test("no launch is built when the links are refused, are not stored, or come back different", async () => {
    const agent = await generateWebKey();
    const refused = (async () => Response.json({ error: "bad_links", message: "the canonical JSON of the coin's links" }, { status: 400 })) as unknown as typeof fetch;
    await expect(storeCoinLinks(agent, LINKS, refused)).rejects.toThrow(/links were not stored .*not built/);
    // named in the URI but never stored
    const s = site();
    await expect(checkedCoinUri({ ...launch, agent: agent.id, image: null, links: LINKS, fetch: s.f })).rejects.toThrow(/was not confirmed/);
    // a host that answers the document with another link, or with a link this launch did not give
    const lying = (extra: Record<string, string>) => (async (u: string) => {
      const url = new URL(String(u), HERE);
      if (url.pathname.startsWith("/coin/face/")) return new Response(PNG as unknown as BodyInit, { headers: { "content-type": "image/png" } });
      return Response.json({ ...coinMetadataDoc({ ...launch, agent: agent.id, origin: ORIGIN, links: LINKS }), ...extra });
    }) as unknown as typeof fetch;
    await expect(checkedCoinUri({ ...launch, agent: agent.id, image: null, links: LINKS, fetch: lying({ twitter: "https://x.com/someone_else" }) })).rejects.toThrow(/a different "twitter"/);
    await expect(checkedCoinUri({ ...launch, agent: agent.id, image: null, links: { website: LINKS.website }, fetch: lying({}) })).rejects.toThrow(/a "twitter" link this launch did not give/);
  });

  test("after the launch the links are the ones the coin's own URI names: no request, no later upload and no changed text can alter them", async () => {
    const onChain = `https://a.gg/?l=${ID}`;
    const s = site(chain({ mintData: mintWithUri(onChain) }));
    s.media.set(SHA, { type: "application/json", bytes: new TextEncoder().encode(TEXT) });
    const want = coinMetadataDoc({ origin: ORIGIN, mint: MINT, agent: AGENT, name: "Test Basalt", symbol: "TBASALT", repoUrl: "https://github.com/keis/base58", links: LINKS });
    const evil = { twitter: "https://x.com/evil", website: "https://evil.example" };
    const evilText = coinLinksJson(evil), evilId = coinLinksId(evil)!;
    s.media.set(bytesToHex(sha256(new TextEncoder().encode(evilText))), { type: "application/json", bytes: new TextEncoder().encode(evilText) });
    // a request that names other links (stored, valid, by their own id) gets the coin's own
    for (const q of ["", `?l=${evilId}`, `?l=${evilId}&name=Evil&symbol=EVIL&agent=${AGENT}&repo=https://github.com/a/b`, "?twitter=https://x.com/evil&website=https://evil.example"]) {
      const r = await s.f(`${HERE}/coin/${MINT}.json${q}`);
      expect(await r.json()).toEqual(want);
    }
    // a coin launched without links shows none whatever a request says, and its website is the agent's page
    const plain = await (await site().f(`${HERE}/coin/${MINT}.json?l=${evilId}`)).json();
    expect(plain).not.toHaveProperty("twitter");
    expect(plain.website).toBe(`${ORIGIN}/tokens/${MINT}`);
  });

  test("the text stored under the coin's hash was swapped or is not canonical: it is never served as the coin's links, and that answer is not kept", async () => {
    const onChain = `https://a.gg/?l=${ID}`;
    for (const swapped of ['{"twitter":"https://x.com/evil"}', TEXT + " ", '{"website":"https://example.org/coin","twitter":"https://x.com/unitscoin","telegram":"https://t.me/unitscoin"}', "not json", ""]) {
      expect(coinLinksFromStored(swapped, ID)).toBeNull();
      const s = site(chain({ mintData: mintWithUri(onChain) }));
      s.media.set(SHA, { type: "application/json", bytes: new TextEncoder().encode(swapped) });
      const r = await s.f(`${HERE}/coin/${MINT}.json`);
      const doc = await r.json();
      expect(doc).not.toHaveProperty("twitter");
      expect(doc).not.toHaveProperty("telegram");
      expect(doc.website).toBe(`${ORIGIN}/tokens/${MINT}`);
      expect([r.headers.get("cache-control"), r.headers.get("x-units-coin")]).toEqual(["no-store", "links-missing"]);
      // once the right text is there the coin's links are served, and only then kept
      s.media.set(SHA, { type: "application/json", bytes: new TextEncoder().encode(TEXT) });
      const again = await s.f(`${HERE}/coin/${MINT}.json`);
      expect((await again.json()).twitter).toBe(LINKS.twitter);
      expect(again.headers.get("cache-control")).toBe("public, max-age=3600");
    }
    // a text that is valid links but not the ones the id names
    expect(coinLinksFromStored('{"twitter":"https://x.com/evil"}', coinLinksId({ twitter: "https://x.com/evil" })!)).toEqual({ twitter: "https://x.com/evil" });
    expect(coinLinksFromStored('{"twitter":"https://x.com/evil"}', ID)).toBeNull();
  });

  test("the links store down: the coin's document is not answered without them (503), and a preview naming links that are not stored is refused", async () => {
    const down = coinRoutes({ origin: ORIGIN, core: CORE, rpc: chain({ mintData: mintWithUri(`https://a.gg/?l=${ID}`) }).rpc, fetch: (async () => Response.json({ error: "x" }, { status: 502 })) as unknown as typeof fetch });
    expect((await down.route(new Request(`${HERE}/coin/${MINT}.json`), `/coin/${MINT}.json`)).status).toBe(503);
    const s = site();
    const q = `name=Test+Basalt&symbol=TBASALT&agent=${AGENT}&repo=https://github.com/keis/base58`;
    expect((await s.f(`${HERE}/coin/${NEW_MINT}.json?l=${ID}&${q}`)).status).toBe(404);
    expect((await s.f(`${HERE}/coin/${NEW_MINT}.json?l=nope&${q}`)).status).toBe(404);
  });
});
