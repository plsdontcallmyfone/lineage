// The rule for "a coin's metadata URI resolves" (packages/chain/src/coin-metadata.ts), with stub fetches.
import { describe, expect, test } from "bun:test";
import { checkMetadataUri, coinMetadataDoc, coinMetadataProblem, coinMetadataUri, coinMetadataUriBytes, metadataOrigin } from "../src/coin-metadata.ts";

const ORIGIN = "https://app.units.gg";
const MINT = "BKXoeWvAMK2bqVTnfMP2azaawfj7ssxHwrEDFySb1mzj";
const AGENT = "FScgU8v8PtabhWzCxhX1iQEs7JyMP34MV4UWH2gpZrKG";
const doc = coinMetadataDoc({ origin: ORIGIN, mint: MINT, agent: AGENT, name: "Test Basalt", symbol: "TBASALT", repoUrl: "https://github.com/keis/base58" });

const stub = (routes: Record<string, () => Response>) => {
  const seen: string[] = [];
  const f = (async (u: string) => {
    seen.push(String(u));
    const r = routes[String(u)];
    if (!r) throw new Error("Unable to connect");
    return r();
  }) as unknown as typeof fetch;
  return { f, seen };
};
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

describe("coin metadata", () => {
  test("the URI and the document are built from the one origin", () => {
    expect(coinMetadataUri(ORIGIN, MINT)).toBe(`https://app.units.gg/coin/${MINT}.json`);
    expect(coinMetadataUri(`${ORIGIN}/`, MINT)).toBe(`https://app.units.gg/coin/${MINT}.json`);
    expect(coinMetadataUriBytes(ORIGIN)).toBe(coinMetadataUri(ORIGIN, MINT).length);
    expect(doc).toEqual({
      name: "Test Basalt", symbol: "TBASALT", description: "Test Basalt is an autonomous coding agent launched on units. It works on https://github.com/keis/base58.",
      showName: true, image: `https://app.units.gg/coin/face/${AGENT}.png`, createdOn: ORIGIN, website: `https://app.units.gg/tokens/${MINT}`,
    });
    expect(coinMetadataProblem(doc, { name: "Test Basalt", symbol: "TBASALT" })).toBeNull();
    expect(JSON.stringify(doc)).not.toContain("—");
    for (const bad of ["http://app.units.gg", "https://app.units.gg/x", "app.units.gg", "https://lineage.invalid/a b"]) expect(() => metadataOrigin(bad)).toThrow();
  });

  test("what is refused as metadata", () => {
    expect(coinMetadataProblem(null)).toMatch(/not a JSON object/);
    expect(coinMetadataProblem({ ...doc, image: undefined })).toMatch(/"image" is missing/);
    expect(coinMetadataProblem({ ...doc, image: "ipfs://x" })).toMatch(/not an https URL/);
    expect(coinMetadataProblem({ ...doc, name: " " })).toMatch(/"name" is empty/);
    expect(coinMetadataProblem(doc, { symbol: "OTHER" })).toMatch(/"symbol" is "TBASALT", the coin's is "OTHER"/);
  });

  test("a URI resolves only when the document and its image both answer", async () => {
    const uri = coinMetadataUri(ORIGIN, MINT);
    const ok = stub({ [uri]: () => Response.json(doc), [doc.image]: png });
    const r = await checkMetadataUri(uri, { fetch: ok.f, expect: { name: "Test Basalt" } });
    expect(r).toMatchObject({ ok: true, problem: null, image: { type: "image/png", bytes: 4 } });
    expect(ok.seen).toEqual([uri, doc.image]);

    // the URI every coin carried before this fix: the host does not exist
    expect(await checkMetadataUri("https://lineage.invalid/mainnet/agents/tbasalt.json?class=python", { fetch: stub({}).f })).toMatchObject({ ok: false, problem: expect.stringMatching(/did not answer/) });
    expect((await checkMetadataUri(uri, { fetch: stub({ [uri]: () => new Response("gone", { status: 404 }) }).f })).problem).toBe("the URI answered HTTP 404");
    expect((await checkMetadataUri(uri, { fetch: stub({ [uri]: () => new Response("<html>") }).f })).problem).toBe("the URI did not answer with JSON");
    expect((await checkMetadataUri(uri, { fetch: stub({ [uri]: () => Response.json(doc) }).f })).problem).toMatch(/the image did not answer/);
    expect((await checkMetadataUri(uri, { fetch: stub({ [uri]: () => Response.json(doc), [doc.image]: () => new Response("<html>", { headers: { "content-type": "text/html" } }) }).f })).problem).toBe("the image answered with content type text/html");
    expect((await checkMetadataUri(uri, { fetch: stub({ [uri]: () => Response.json(doc), [doc.image]: () => new Response("", { status: 429 }) }).f })).problem).toBe("the image answered HTTP 429");
    expect((await checkMetadataUri("ipfs://Qm", { fetch: stub({}).f })).problem).toBe("the URI is not an https URL");
  });

  test("the page reads the origin's paths on its own host, with the preview query on the document only", async () => {
    const here = "https://main-157-245-71-188.sslip.io";
    const uri = coinMetadataUri(ORIGIN, MINT);
    const s = stub({ [`${here}/coin/${MINT}.json?name=x`]: () => Response.json(doc), [`${here}/coin/face/${AGENT}.png`]: png });
    const r = await checkMetadataUri(uri, { fetch: s.f, via: (u) => u.replace(ORIGIN, here), query: "name=x" });
    expect(r.ok).toBe(true);
    expect(s.seen).toEqual([`${here}/coin/${MINT}.json?name=x`, `${here}/coin/face/${AGENT}.png`]);
  });
});
