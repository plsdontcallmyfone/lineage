// The off-chain metadata document a coin's on-chain URI points at: what pump.fun, wallets and explorers
// load a coin's name, symbol, description and image from. The shape is the one pump.fun's own launches
// write, read from mainnet coins on 2026-10-12 with scripts/mainnet/coin-metadata.ts (Cat Boss
// 5N3mG2A5..., beer 8nejek5U...): {name, symbol, description, showName: true, image, createdOn:
// "https://pump.fun"} plus twitter, telegram and website only when the launcher gave them.
//
// Where it lives (decided 2026-10-12): on our own site, at <metadata origin>/coin/<mint>.json with the
// image at <metadata origin>/coin/face/<agent>.png, both answered from chain data alone
// (apps/web/coin-metadata.ts). Not IPFS: pump.fun's upload endpoint (pump.fun/api/ipfs) is closed to
// outside callers (PumpPortal's creation docs, read 2026-10-12: "no longer supported", they now ask for
// a Pinata account and key), and the public gateway its URIs name (ipfs.io, also dweb.link) answered
// 429 "switching to a service worker gateway only" to every programmatic read on 2026-10-12, so an
// https://ipfs.io/ipfs/<cid> URI depends on a host as much as ours does. The metadata origin is one
// config value (config/sites.json metadata_origin, UNITS_METADATA_ORIGIN); it is written on chain and
// cannot be changed for a coin afterwards.
//
// Pure (no fetch of its own unless one is passed), so the launch page, the web server, the owner's
// check script and tests share one rule for "this URI resolves to usable metadata".

export interface CoinMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  showName?: boolean;
  createdOn?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/** The origin as written on chain: https, a host, no path. Throws otherwise. */
export function metadataOrigin(origin: string): string {
  const o = origin.replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o)) throw new Error(`the coin metadata origin must be https://host with no path, got "${origin}"`);
  return o;
}
export const coinMetadataPath = (mint: string) => `/coin/${mint}.json`;
export const coinFacePath = (agent: string) => `/coin/face/${agent}.png`;
/** The URI create_v2 writes into the coin. */
export const coinMetadataUri = (origin: string, mint: string) => `${metadataOrigin(origin)}${coinMetadataPath(mint)}`;
/** The longest such URI in bytes (a mint address is at most 44 characters). */
export const coinMetadataUriBytes = (origin: string) => coinMetadataUri(origin, "1".repeat(44)).length;

/** The document served at a coin's URI: built from what the chain records about the launch, nothing else. */
export function coinMetadataDoc(o: { origin: string; mint: string; agent: string; name: string; symbol: string; repoUrl: string }): CoinMetadata {
  const origin = metadataOrigin(o.origin);
  return {
    name: o.name,
    symbol: o.symbol,
    description: `${o.name.trim()} is an autonomous coding agent launched on units. It works on ${o.repoUrl}.`,
    showName: true,
    image: `${origin}${coinFacePath(o.agent)}`,
    createdOn: origin,
    website: `${origin}/tokens/${o.mint}`,
  };
}

const httpsUrl = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
};

/** Why this document is not usable coin metadata (optionally: not the metadata of this name and symbol), or null. */
export function coinMetadataProblem(doc: unknown, expect: { name?: string; symbol?: string } = {}): string | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "the document is not a JSON object";
  const d = doc as Record<string, unknown>;
  for (const k of ["name", "symbol", "description", "image"] as const) if (typeof d[k] !== "string") return `"${k}" is missing or not a string`;
  if (!(d.name as string).trim()) return `"name" is empty`;
  if (!(d.symbol as string).trim()) return `"symbol" is empty`;
  if (!httpsUrl(d.image)) return `"image" is not an https URL`;
  if (expect.name !== undefined && d.name !== expect.name) return `"name" is ${JSON.stringify(d.name)}, the coin's is ${JSON.stringify(expect.name)}`;
  if (expect.symbol !== undefined && d.symbol !== expect.symbol) return `"symbol" is ${JSON.stringify(d.symbol)}, the coin's is ${JSON.stringify(expect.symbol)}`;
  return null;
}

export interface UriCheck {
  ok: boolean;
  /** why not, when not ok */
  problem: string | null;
  metadata: CoinMetadata | null;
  /** the image answered with an image content type */
  image: { url: string; type: string; bytes: number } | null;
}

/**
 * Fetches a metadata URI and its image and says whether both resolve: the URI answers 200 with JSON
 * that passes coinMetadataProblem, and its image answers 200 with an image content type. Never throws.
 */
export async function checkMetadataUri(
  uri: string,
  o: {
    expect?: { name?: string; symbol?: string };
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** where to read a URL from instead (the launch page reads the metadata origin's paths on the host it is served from) */
    via?: (url: string) => string;
    /** appended to the metadata request only (the launch page's preview of a coin that is not on chain yet) */
    query?: string;
  } = {},
): Promise<UriCheck> {
  const f = o.fetch ?? fetch;
  const via = o.via ?? ((u: string) => u);
  const bad = (problem: string, metadata: CoinMetadata | null = null): UriCheck => ({ ok: false, problem, metadata, image: null });
  if (!httpsUrl(uri)) return bad("the URI is not an https URL");
  const signal = () => AbortSignal.timeout(o.timeoutMs ?? 15_000);
  let doc: unknown;
  try {
    const r = await f(`${via(uri)}${o.query ? `?${o.query}` : ""}`, { signal: signal(), headers: { accept: "application/json" } });
    if (!r.ok) return bad(`the URI answered HTTP ${r.status}`);
    const text = await r.text();
    try {
      doc = JSON.parse(text);
    } catch {
      return bad("the URI did not answer with JSON");
    }
  } catch (e) {
    return bad(`the URI did not answer (${(e as Error).message})`);
  }
  const problem = coinMetadataProblem(doc, o.expect);
  if (problem) return bad(problem);
  const metadata = doc as CoinMetadata;
  try {
    const r = await f(via(metadata.image), { signal: signal() });
    if (!r.ok) return bad(`the image answered HTTP ${r.status}`, metadata);
    const type = (r.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const bytes = (await r.arrayBuffer()).byteLength;
    if (!type.startsWith("image/")) return bad(`the image answered with content type ${type || "none"}`, metadata);
    if (!bytes) return bad("the image is empty", metadata);
    return { ok: true, problem: null, metadata, image: { url: metadata.image, type, bytes } };
  } catch (e) {
    return bad(`the image did not answer (${(e as Error).message})`, metadata);
  }
}
