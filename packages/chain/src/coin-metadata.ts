// The off-chain metadata document a coin's on-chain URI points at: what pump.fun, wallets and explorers
// load a coin's name, symbol, description and image from. The shape is the one pump.fun's own launches
// write, read from mainnet coins on 2026-10-12 with scripts/mainnet/coin-metadata.ts (Cat Boss
// 5N3mG2A5..., beer 8nejek5U...): {name, symbol, description, showName: true, image, createdOn:
// "https://pump.fun"} plus twitter, telegram and website only when the launcher gave them.
//
// Where it lives (decided 2026-10-12): on our own site, at <metadata origin>/coin/<mint>.json, answered
// from chain data alone (apps/web/coin-metadata.ts). The image is the one the launcher chose in the
// wizard (owner 2026-10-12: "people get to choose the images"): the URI carries its sha256 as ?i=<base58>,
// so the choice is on chain with the coin and nothing behind the URI can swap it, and the document names
// <metadata origin>/coin/image/<that id>, the bytes with that hash from Core's blob store. A launch with
// no chosen image has no ?i= and shows the agent's generated face, <metadata origin>/coin/face/<agent>.png.
// Not IPFS: pump.fun's upload endpoint (pump.fun/api/ipfs) is closed to
// outside callers (PumpPortal's creation docs, read 2026-10-12: "no longer supported", they now ask for
// a Pinata account and key), and the public gateway its URIs name (ipfs.io, also dweb.link) answered
// 429 "switching to a service worker gateway only" to every programmatic read on 2026-10-12, so an
// https://ipfs.io/ipfs/<cid> URI depends on a host as much as ours does. The metadata origin is one
// config value (config/sites.json metadata_origin, UNITS_METADATA_ORIGIN); it is written on chain and
// cannot be changed for a coin afterwards.
//
// Links (owner 2026-10-12: "connected correctly to pump.fun's preferences"): the three fields pump.fun reads
// from this document, `twitter`, `telegram` and `website`, each a full https URL (read again on 2026-10-12
// from fresh pump.fun coins through its own listing, e.g. Symbiote DqTMXtLn...: "twitter":"https://x.com/...",
// "telegram":"", "website":"https://..."). They are bound the way the image is: the launcher's links are
// one small canonical JSON text, stored before the launch in Core's blob store with a statement signed by the
// agent key, and the coin's on-chain URI carries that text's sha256 as &l=<base58>. The server answers a
// coin's document with the links only when the stored text hashes to the id in the mint's own URI, so nobody,
// the server included, can change or add a link after the launch. No links: no &l=, and `website` is the
// agent's page on the app, as before.
//
// Pure (no fetch of its own unless one is passed), so the launch page, the web server, the owner's
// check script and tests share one rule for "this URI resolves to usable metadata".

import { addressBytes, bytesToHex, hexToBytes, sha256, toAddress } from "./codec.ts";

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
export const coinImagePath = (imageId: string) => `/coin/image/${imageId}`;
/** A chosen image's id in a URI: its sha256 in base58 (43 or 44 characters). */
export const coinImageId = (sha256Hex: string): string => {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error("a coin image is named by its sha256 (64 hex)");
  return toAddress(hexToBytes(sha256Hex));
};
/** The sha256 (hex) an image id stands for, or null when it is not one. */
export const coinImageSha = (imageId: string | null | undefined): string | null => {
  try {
    return imageId && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(imageId) && addressBytes(imageId).length === 32 ? bytesToHex(addressBytes(imageId)) : null;
  } catch {
    return null;
  }
};
/** The launcher's links, in pump.fun's field names. Each is a full https URL; a missing one is absent. */
export interface CoinLinks {
  twitter?: string;
  telegram?: string;
  website?: string;
}
export const COIN_LINK_KEYS = ["twitter", "telegram", "website"] as const;
/** The longest a link may be, in characters (the three fit in a small document; pump.fun shows them as buttons). */
export const COIN_LINK_MAX = 120;
const LINK_HOSTS: Record<(typeof COIN_LINK_KEYS)[number], RegExp | null> = { twitter: /^(www\.)?(x|twitter)\.com$/, telegram: /^(www\.)?t\.me$/, website: null };
const LINK_NAMES: Record<(typeof COIN_LINK_KEYS)[number], string> = { twitter: "Twitter (X)", telegram: "Telegram", website: "Website" };

/** Why this is not a usable link for the field, or null. */
export function coinLinkProblem(key: (typeof COIN_LINK_KEYS)[number], value: string): string | null {
  const n = LINK_NAMES[key];
  if (value.length > COIN_LINK_MAX) return `${n}: at most ${COIN_LINK_MAX} characters.`;
  if (/[\s<>"'`\\]/.test(value)) return `${n}: a link has no spaces or quotes.`;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return `${n}: not a link (it starts with https://).`;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return `${n}: an https:// link.`;
  const host = LINK_HOSTS[key];
  if (host && !host.test(u.hostname.toLowerCase())) return key === "twitter" ? `${n}: a link on x.com or twitter.com.` : `${n}: a link on t.me.`;
  if (host && u.pathname.replace(/\/+$/, "") === "") return `${n}: the link of an account or a post, not the site alone.`;
  return null;
}

/**
 * The links as they are stored and served: only the three known fields, trimmed, empty ones dropped.
 * `problems` lists what is wrong (unknown fields, non-strings, bad links); `links` is usable only when it is empty.
 */
export function normalizeCoinLinks(input: unknown): { links: CoinLinks; problems: string[] } {
  const links: CoinLinks = {};
  const problems: string[] = [];
  if (input === null || input === undefined) return { links, problems };
  if (typeof input !== "object" || Array.isArray(input)) return { links, problems: ["links: an object with twitter, telegram and website"] };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(COIN_LINK_KEYS as readonly string[]).includes(k)) problems.push(`links: unknown field ${JSON.stringify(k).slice(0, 40)}`);
    else if (v !== undefined && typeof v !== "string") problems.push(`${LINK_NAMES[k as (typeof COIN_LINK_KEYS)[number]]}: a text`);
  }
  for (const k of COIN_LINK_KEYS) {
    const raw = (input as Record<string, unknown>)[k];
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (!v) continue;
    const bad = coinLinkProblem(k, v);
    if (bad) problems.push(bad);
    else links[k] = v;
  }
  return { links, problems };
}
/** The one text a set of links is stored and hashed as: the present fields in pump.fun's order. "" when there are none. */
export function coinLinksJson(links: CoinLinks): string {
  const out: Record<string, string> = {};
  for (const k of COIN_LINK_KEYS) if (links[k]) out[k] = links[k]!;
  return Object.keys(out).length ? JSON.stringify(out) : "";
}
/** The links' id in a URI: the sha256 of their text in base58, or null when there are none. */
export function coinLinksId(links: CoinLinks): string | null {
  const text = coinLinksJson(links);
  return text ? toAddress(sha256(new TextEncoder().encode(text))) : null;
}
/** The links a stored text holds when it is exactly the text of the id `linksId`; null otherwise (tampered, not canonical, not links). */
export function coinLinksFromStored(text: string, linksId: string): CoinLinks | null {
  if (coinImageSha(linksId) === null || toAddress(sha256(new TextEncoder().encode(text))) !== linksId) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const n = normalizeCoinLinks(parsed);
  return !n.problems.length && coinLinksJson(n.links) === text ? n.links : null;
}

/** The URI create_v2 writes into the coin; `imageId` when the launcher chose an image, `linksId` when they gave links. */
export const coinMetadataUri = (origin: string, mint: string, imageId?: string | null, linksId?: string | null) => {
  const q = [imageId ? `i=${imageId}` : "", linksId ? `l=${linksId}` : ""].filter(Boolean).join("&");
  return `${metadataOrigin(origin)}${coinMetadataPath(mint)}${q ? `?${q}` : ""}`;
};
/** The longest such URI in bytes (a mint address, an image id and a links id are at most 44 characters each). */
export const coinMetadataUriBytes = (origin: string, withImage = false, withLinks = false) => coinMetadataUri(origin, "1".repeat(44), withImage ? "1".repeat(44) : null, withLinks ? "1".repeat(44) : null).length;
/** The links id a coin's on-chain URI names, or null (no links, or not a URI of ours). */
export function coinLinksOfUri(uri: string | null | undefined): string | null {
  try {
    const l = new URL(uri ?? "").searchParams.get("l");
    return coinImageSha(l) ? l : null;
  } catch {
    return null;
  }
}
/** The image id a coin's on-chain URI names, or null (no chosen image, or not a URI of ours). */
export function coinImageOfUri(uri: string | null | undefined): string | null {
  try {
    const i = new URL(uri ?? "").searchParams.get("i");
    return coinImageSha(i) ? i : null;
  } catch {
    return null;
  }
}

/** The document served at a coin's URI: built from what the chain records about the launch, nothing else. */
export function coinMetadataDoc(o: { origin: string; mint: string; agent: string; name: string; symbol: string; repoUrl: string; imageId?: string | null; links?: CoinLinks | null }): CoinMetadata {
  const origin = metadataOrigin(o.origin);
  const l = o.links ?? {};
  return {
    name: o.name,
    symbol: o.symbol,
    description: `${o.name.trim()} is an autonomous coding agent launched on units. It works on ${o.repoUrl}.`,
    showName: true,
    image: `${origin}${o.imageId ? coinImagePath(o.imageId) : coinFacePath(o.agent)}`,
    createdOn: origin,
    // pump.fun's own fields, present only when the launcher gave them; the website falls back to the agent's page on the app
    ...(l.twitter ? { twitter: l.twitter } : {}),
    ...(l.telegram ? { telegram: l.telegram } : {}),
    website: l.website || `${origin}/tokens/${o.mint}`,
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
  image: { url: string; type: string; bytes: number; sha256: string } | null;
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
    const r = await f(`${via(uri)}${o.query ? `${uri.includes("?") ? "&" : "?"}${o.query}` : ""}`, { signal: signal(), headers: { accept: "application/json" } });
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
    const body = new Uint8Array(await r.arrayBuffer());
    if (!type.startsWith("image/")) return bad(`the image answered with content type ${type || "none"}`, metadata);
    if (!body.length) return bad("the image is empty", metadata);
    return { ok: true, problem: null, metadata, image: { url: metadata.image, type, bytes: body.length, sha256: bytesToHex(sha256(body)) } };
  } catch (e) {
    return bad(`the image did not answer (${(e as Error).message})`, metadata);
  }
}
