// The launch page's side of a coin's metadata URI (packages/chain/src/coin-metadata.ts,
// apps/web/coin-metadata.ts). The URI written on chain is <metadata origin>/coin/<mint>.json, where
// the origin is the server's one config value (GET /coin/origin). Before the wallet is asked to sign,
// the page reads that exact path, and the image the document names, on the host it is served from
// (the same server, the same route; the permanent origin's DNS record may not exist yet) and refuses
// to build the launch unless both answer what the coin will show.
//
// The image is the one the launcher picked in the wizard's Coin step. It is uploaded here, before the
// wallet signs, through the existing media route (POST /social/media/<agent>, slot "coin") with a
// statement signed by the agent key this page made for the launch: no wallet prompt, and nobody else
// can speak for that key. The URI then carries the image's sha256 (?i=), so the choice is on chain with
// the coin: no later upload, by anyone, changes what a launched coin shows.
import { base58Encode, bytesToHex, checkMetadataUri, coinImageId, coinLinksId, coinLinksJson, coinMetadataDoc, coinMetadataUri, metadataOrigin, sha256, type CoinLinks, type WebKey } from "../../../packages/chain/src/browser/index.ts";

export interface CoinOrigin {
  /** the origin written on chain */
  origin: string;
  /** whether that origin answers the metadata route right now (DNS, certificate, routing) */
  answers: boolean;
}

/** The server's metadata origin. Throws when the server does not serve coin metadata (an older build). */
export async function loadCoinOrigin(f: typeof fetch = fetch): Promise<CoinOrigin> {
  const r = await f("/coin/origin", { headers: { accept: "application/json" } }).catch(() => null);
  const j = r?.ok && /json/.test(r.headers.get("content-type") ?? "") ? ((await r.json().catch(() => null)) as Partial<CoinOrigin> | null) : null;
  if (!j || typeof j.origin !== "string") throw new Error("This server does not serve coin metadata (/coin/origin), so a launch from it would carry a dead metadata URI. Nothing was built.");
  return { origin: metadataOrigin(j.origin), answers: j.answers === true };
}

export const COIN_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const COIN_IMAGE_MAX_BYTES = 256 * 1024;

const canonicalJson = (v: unknown): string =>
  v === null ? "null"
  : Array.isArray(v) ? `[${v.map(canonicalJson).join(",")}]`
  : typeof v === "object" ? `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);
const hexOf = (b: Uint8Array | string) => bytesToHex(sha256(b));
// agent keys of this page that have a coin image stored (a pick that is taken back is cleared again)
const stored = new Set<string>();

/**
 * Stores the picked image as the coin image of `agent` (not launched yet) and returns its id and
 * sha256, or null when nothing is picked. Signed by the agent key (a "media" statement, slot "coin").
 */
export async function storeCoinImage(agent: WebKey, file: { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null, f: typeof fetch = fetch): Promise<{ imageId: string; sha256: string } | null> {
  const send = async (st: Record<string, unknown>, data: string) => {
    const sig = base58Encode(await agent.sign(new TextEncoder().encode(hexOf(canonicalJson(["units-media-v1", canonicalJson(st)])))));
    const r = await f(`/social/media/${agent.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ statement: st, sig, data }) });
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { message?: string; error?: string } | null;
      throw new Error(`The coin image was not stored (${j?.message ?? j?.error ?? `HTTP ${r.status}`}), so the launch was not built.`);
    }
  };
  const base = { v: 1, kind: "units-media", agent: agent.id, slot: "coin", signer: agent.id, created_at: Math.floor(Date.now() / 1000), nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(12))) };
  if (!file) {
    if (stored.delete(agent.id)) await send({ ...base, sha256: "", type: "", size: 0 }, "");
    return null;
  }
  if (!COIN_IMAGE_TYPES.includes(file.type) || file.size > COIN_IMAGE_MAX_BYTES) throw new Error("Coin image: PNG, JPEG or WebP, at most 256 KB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = hexOf(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await send({ ...base, sha256: sha, type: file.type, size: bytes.length }, btoa(bin));
  stored.add(agent.id);
  return { imageId: coinImageId(sha), sha256: sha };
}

// links texts already stored for an agent key (the same text is not sent again on every rebuild)
const storedLinks = new Set<string>();
/**
 * Stores the coin's links (twitter, telegram, website) for `agent` (not launched yet) and returns their
 * id, the sha256 of their canonical text in base58, or null when there are none. Signed by the agent key
 * (a "media" statement, slot "links"). The id goes into the coin's on-chain URI (&l=), so the links cannot
 * be changed after the launch.
 */
export async function storeCoinLinks(agent: WebKey, links: CoinLinks, f: typeof fetch = fetch): Promise<string | null> {
  const text = coinLinksJson(links);
  const id = coinLinksId(links);
  if (!text || !id) return null;
  if (storedLinks.has(`${agent.id}:${id}`)) return id;
  const bytes = new TextEncoder().encode(text);
  const st = { v: 1, kind: "units-media", agent: agent.id, slot: "links", signer: agent.id, created_at: Math.floor(Date.now() / 1000), nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(12))), sha256: hexOf(bytes), type: "application/json", size: bytes.length };
  const sig = base58Encode(await agent.sign(new TextEncoder().encode(hexOf(canonicalJson(["units-media-v1", canonicalJson(st)])))));
  const r = await f(`/social/media/${agent.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ statement: st, sig, data: btoa(String.fromCharCode(...bytes)) }) });
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(`The coin's links were not stored (${j?.message ?? j?.error ?? `HTTP ${r.status}`}), so the launch was not built.`);
  }
  storedLinks.add(`${agent.id}:${id}`);
  return id;
}

/**
 * The URI for this launch, after reading it back: the document must be exactly what the chain data
 * will produce (name, symbol, description, image, links) and its image must load (the chosen image
 * with the bytes that were picked, else the generated face). `here` is the
 * origin of the page. Throws with the reason otherwise.
 */
export async function checkedCoinUri(o: { origin: string; here: string; mint: string; agent: string; name: string; symbol: string; repoUrl: string; image?: { imageId: string; sha256: string } | null; links?: CoinLinks | null; fetch?: typeof fetch }): Promise<string> {
  // the links are named in the URI by the hash of their text; the document read back must carry exactly them
  const linksId = o.links ? coinLinksId(o.links) : null;
  const uri = coinMetadataUri(o.origin, o.mint, o.image?.imageId, linksId);
  const want = coinMetadataDoc({ ...o, imageId: o.image?.imageId, links: o.links });
  const via = (u: string) => (u.startsWith(`${o.origin}/`) ? `${o.here}${u.slice(o.origin.length)}` : u);
  const query = new URLSearchParams({ name: o.name, symbol: o.symbol, agent: o.agent, repo: o.repoUrl }).toString();
  const c = await checkMetadataUri(uri, { expect: { name: o.name, symbol: o.symbol }, via, query, fetch: o.fetch, timeoutMs: 12_000 });
  if (!c.ok) throw new Error(`The coin's metadata URI was not confirmed (${c.problem}), so the launch was not built: a coin's URI is on chain for good. Try again in a moment.`);
  const got = c.metadata as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(want)) if (got[k] !== v) throw new Error(`The coin's metadata URI answered a different "${k}" than this launch would write, so the launch was not built.`);
  // and no link this launch did not give
  for (const k of ["twitter", "telegram"]) if (!(k in want) && got[k]) throw new Error(`The coin's metadata URI answered a "${k}" link this launch did not give, so the launch was not built.`);
  // the chosen image, byte for byte: what the document names is what the launcher picked
  if (o.image && c.image!.sha256 !== o.image.sha256) throw new Error("The coin's image did not come back as the file you chose, so the launch was not built.");
  return uri;
}
