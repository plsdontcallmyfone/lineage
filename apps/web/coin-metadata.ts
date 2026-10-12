// The web server's /coin/* routes (server side only, never bundled): the metadata document and the
// image a launched coin's on-chain URI points at (packages/chain/src/coin-metadata.ts has the shape and
// why it is served from here and not from IPFS).
//
//   GET /coin/<mint>.json        the coin's metadata, built from chain data alone: the name and symbol in
//                                the mint's Token-2022 metadata, the agent and repository in its
//                                AgentLaunch record, the chosen image in the mint's own URI (?i=). Nothing is stored: any server of this deployment with
//                                a chain RPC answers it again, for good. 404 for a mint this deployment's
//                                launch program did not register.
//                                Before the coin exists (the launch page checks the route before it lets
//                                the wallet sign) the same path answers a preview built from
//                                ?name=&symbol=&agent=&repo= (and ?i=), marked `x-units-coin: preview`, never cached;
//                                once the mint is on chain the query is ignored.
//                                The links (twitter, telegram, website: the fields pump.fun reads) are the ones whose
//                                canonical text hashes to the id in the mint's own URI (&l=): the text comes from
//                                Core's blob store and is checked against that hash here, so a changed or swapped
//                                text is never served. A coin without &l= has no twitter or telegram and its
//                                website is the agent's page on the app.
//   GET /coin/image/<id>         the image the launcher chose: <id> is its sha256 in base58, the same id the coin's
//                                on-chain URI carries as ?i=, so what a coin shows is fixed by the chain. The bytes
//                                come from Core's blob store (GET /v1/media/<sha256>; uploaded by the launch page
//                                before the wallet signs, signed by the agent key); served immutable
//   GET /coin/face/<agent>.png   the agent's generated face (packages/embed/src/pattern.ts avatarGrid, the
//                                one every page draws for it), 512 by 512; a pure function of the agent id
//   GET /coin/origin             {origin, here, answers}: the origin written on chain and whether it
//                                answers this route right now (the launch page warns when it does not)
//
// Every answer is readable from any origin (wallets and explorers fetch it from their own pages).
import { deflateSync } from "node:zlib";
import { addressBytes, coinFacePath, coinImageOfUri, coinImageSha, coinLinksFromStored, coinLinksOfUri, coinMetadataDoc, coinMetadataPath, decodeAgentLaunch, launchPdas, LAUNCH_PROGRAM_ID, metadataOrigin, type CoinMetadata, type Rpc } from "../../packages/chain/src/index.ts";
import { readMint } from "../../packages/indexer/src/accounts.ts";
import { avatarGrid } from "../../packages/embed/src/pattern.ts";

export const FACE_SIZE = 512;
const CORS = { "access-control-allow-origin": "*", "x-content-type-options": "nosniff" };
const isAddress = (s: string) => {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && addressBytes(s).length === 32;
  } catch {
    return false;
  }
};

/** "hsl(H S% L%)" as 8-bit RGB. */
export function hslToRgb(css: string): [number, number, number] {
  const m = /^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/.exec(css);
  if (!m) throw new Error(`not an hsl colour: ${css}`);
  const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const ch = (t: number) => {
    t = (t + 1) % 1;
    return Math.round(255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p));
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}

const crcChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/** The agent's face as a PNG (8-bit RGB): the cells of avatarGrid with the SVG's rounded corners, edges smoothed by 3 by 3 sampling. */
export function facePng(agent: string, size = FACE_SIZE): Uint8Array {
  const g = avatarGrid(agent);
  const bg = hslToRgb(g.bg);
  const fills = new Map<number, [number, number, number]>();
  for (const c of g.cells) fills.set(c.y * 5 + c.x, hslToRgb(c.fill));
  const cell = size / 6, off = cell / 2, rx = cell * 0.18, N = 3;
  // the colour of the cell covering a point, or null (outside the grid, an empty cell, or cut by a rounded corner)
  const at = (px: number, py: number): [number, number, number] | null => {
    const cx = Math.floor((px - off) / cell), cy = Math.floor((py - off) / cell);
    if (cx < 0 || cx > 4 || cy < 0 || cy > 4) return null;
    const f = fills.get(cy * 5 + cx);
    if (!f) return null;
    const lx = px - off - cx * cell, ly = py - off - cy * cell;
    const dx = lx < rx ? rx - lx : lx > cell - rx ? lx - (cell - rx) : 0, dy = ly < rx ? rx - ly : ly > cell - rx ? ly - (cell - rx) : 0;
    return dx * dx + dy * dy > rx * rx ? null : f;
  };
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) {
      let r = 0, gr = 0, b = 0;
      for (let sy = 0; sy < N; sy++)
        for (let sx = 0; sx < N; sx++) {
          const c = at(x + (sx + 0.5) / N, y + (sy + 0.5) / N) ?? bg;
          r += c[0], gr += c[1], b += c[2];
        }
      const o = row + 1 + x * 3;
      raw[o] = Math.round(r / (N * N)), raw[o + 1] = Math.round(gr / (N * N)), raw[o + 2] = Math.round(b / (N * N));
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size), dv.setUint32(4, size);
  ihdr[8] = 8, ihdr[9] = 2;
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), crcChunk("IHDR", ihdr), crcChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), crcChunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

export interface CoinRoutesOptions {
  /** the origin written on chain (config/sites.json metadata_origin, UNITS_METADATA_ORIGIN) */
  origin: string;
  rpc: Rpc;
  /** Core's base URL: the chosen images live in its blob store (GET /v1/media/<sha256>) */
  core: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** coins and faces kept in memory (both are immutable) */
  maxCached?: number;
}

export function coinRoutes(o: CoinRoutesOptions) {
  const origin = metadataOrigin(o.origin);
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const max = o.maxCached ?? 2000;
  const docs = new Map<string, CoinMetadata>();
  const faces = new Map<string, Uint8Array>();
  const incomplete = new Set<string>();
  const keep = <V>(m: Map<string, V>, k: string, v: V) => {
    if (m.size >= max) m.delete(m.keys().next().value!);
    m.set(k, v);
  };
  let probe: { answers: boolean; at: number } | null = null;
  const json = (body: unknown, status: number, cache: string, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, ...CORS, ...extra } });

  /**
   * The links of id `linksId` (the sha256, base58, a coin's URI carries): read from Core's blob store and
   * accepted only when the stored text hashes to that id and is the canonical text of valid links.
   * null: nothing usable is stored under that hash. Throws when Core cannot be asked (the caller answers 503:
   * a document without its links is never served as the coin's).
   */
  async function linksOf(linksId: string) {
    const sha = coinImageSha(linksId)!;
    const r = await f(`${o.core.replace(/\/+$/, "")}/v1/media/${sha}`, { signal: AbortSignal.timeout(10_000) } as RequestInit);
    if (r.status >= 500) throw new Error(`the links store answered HTTP ${r.status}`);
    if (r.status !== 200) return null;
    const text = await r.text();
    return text.length > 2000 ? null : coinLinksFromStored(text, linksId);
  }

  /** The coin's document from chain, null when this deployment did not launch it, "absent" when the mint has no account yet. */
  async function fromChain(mint: string): Promise<CoinMetadata | null | "absent"> {
    const [m, l] = await o.rpc.getMultipleAccounts([mint, launchPdas.agentLaunch(mint)]);
    if (!m) return "absent";
    if (!l || l.owner !== LAUNCH_PROGRAM_ID) return null;
    const meta = readMint(m.data);
    const launch = decodeAgentLaunch(l.data);
    if (meta.name === null || meta.symbol === null || launch.mint !== mint) return null;
    // the chosen image and the links are the ones the coin's own on-chain URI names, never ones a request names
    const linksId = coinLinksOfUri(meta.uri);
    const links = linksId ? await linksOf(linksId) : null;
    // the URI names links and the store has none under that hash: the coin's document without them, answered but never kept
    if (linksId && !links) incomplete.add(mint);
    else incomplete.delete(mint);
    return coinMetadataDoc({ origin, mint, agent: launch.agent, name: meta.name, symbol: meta.symbol, repoUrl: launch.repoUrl, imageId: coinImageOfUri(meta.uri), links });
  }

  async function route(req: Request, path: string): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "read_only" }, 405, "no-store");
    const url = new URL(req.url);
    if (path === "/coin/origin") {
      // does the origin written on chain answer this very route? (DNS, certificate and routing in one read)
      if (url.searchParams.get("probe") !== "1" && (!probe || now() - probe.at > 60_000)) {
        const answers = await f(`${origin}/coin/origin?probe=1`, { signal: AbortSignal.timeout(6_000) } as RequestInit)
          .then(async (r) => r.ok && ((await r.json()) as { origin?: string })?.origin === origin)
          .catch(() => false);
        probe = { answers, at: now() };
      }
      return json({ origin, answers: url.searchParams.get("probe") === "1" ? true : probe!.answers }, 200, "no-store");
    }
    const face = /^\/coin\/face\/([^/]+)\.png$/.exec(path);
    if (face) {
      if (!isAddress(face[1]!)) return json({ error: "not_found" }, 404, "no-store");
      let png = faces.get(face[1]!);
      if (!png) keep(faces, face[1]!, (png = facePng(face[1]!)));
      return new Response(png as unknown as BodyInit, { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable", ...CORS } });
    }
    const image = /^\/coin\/image\/([^/.]+)$/.exec(path);
    if (image) {
      const sha = coinImageSha(image[1]);
      if (!sha) return json({ error: "not_found" }, 404, "no-store");
      const r = await f(`${o.core.replace(/\/+$/, "")}/v1/media/${sha}`, { signal: AbortSignal.timeout(10_000) } as RequestInit).catch(() => null);
      if (!r) return json({ error: "core_unavailable", message: "the image store did not answer; try again" }, 503, "no-store", { "retry-after": "5" });
      const type = (r.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (r.status !== 200 || !/^image\/(png|jpeg|webp)$/.test(type)) return json({ error: r.status === 410 ? "hidden" : "not_found" }, r.status === 410 ? 410 : r.status >= 500 ? 503 : 404, "no-store");
      // named by its hash: the bytes can never change
      return new Response(r.body, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "content-security-policy": "default-src 'none'", ...CORS } });
    }
    const doc = /^\/coin\/([^/]+)\.json$/.exec(path);
    if (!doc || !isAddress(doc[1]!)) return json({ error: "not_found" }, 404, "no-store");
    const mint = doc[1]!;
    const held = docs.get(mint);
    if (held) return json(held, 200, "public, max-age=3600");
    let c: Awaited<ReturnType<typeof fromChain>>;
    try {
      c = await fromChain(mint);
    } catch (e) {
      return json({ error: "chain_unavailable", message: "the chain could not be read; try again" }, 503, "no-store", { "retry-after": "5" });
    }
    if (c && c !== "absent") {
      if (incomplete.has(mint)) return json(c, 200, "no-store", { "x-units-coin": "links-missing" });
      keep(docs, mint, c);
      return json(c, 200, "public, max-age=3600");
    }
    if (c === "absent") {
      const q = url.searchParams;
      const name = q.get("name"), symbol = q.get("symbol"), agent = q.get("agent"), repo = q.get("repo"), i = q.get("i"), l = q.get("l");
      // the preview names its links by their id too, and shows them only when the stored text hashes to it
      let links = null;
      if (l !== null) {
        if (!coinImageSha(l)) return json({ error: "not_found", message: "no coin launched here has this mint" }, 404, "no-store");
        try {
          links = await linksOf(l);
        } catch {
          return json({ error: "core_unavailable", message: "the links store did not answer; try again" }, 503, "no-store", { "retry-after": "5" });
        }
        if (!links) return json({ error: "links_not_stored", message: "no links are stored under this id" }, 404, "no-store");
      }
      if (name && symbol && agent && repo && isAddress(agent) && (i === null || coinImageSha(i)) && new TextEncoder().encode(name).length <= 32 && /^[A-Z0-9]{1,10}$/.test(symbol) && /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
        return json(coinMetadataDoc({ origin, mint, agent, name, symbol, repoUrl: repo, imageId: i, links }), 200, "no-store", { "x-units-coin": "preview" });
    }
    return json({ error: "not_found", message: "no coin launched here has this mint" }, 404, "no-store");
  }
  return { route, origin, paths: { doc: coinMetadataPath, face: coinFacePath } };
}
