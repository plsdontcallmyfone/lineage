// The launch page's side of a coin's metadata URI (packages/chain/src/coin-metadata.ts,
// apps/web/coin-metadata.ts). The URI written on chain is <metadata origin>/coin/<mint>.json, where
// the origin is the server's one config value (GET /coin/origin). Before the wallet is asked to sign,
// the page reads that exact path, and the image the document names, on the host it is served from
// (the same server, the same route; the permanent origin's DNS record may not exist yet) and refuses
// to build the launch unless both answer what the coin will show.
import { checkMetadataUri, coinMetadataDoc, coinMetadataUri, metadataOrigin } from "../../../packages/chain/src/browser/index.ts";

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

/**
 * The URI for this launch, after reading it back: the document must be exactly what the chain data
 * will produce (name, symbol, description, image, links) and its image must load. `here` is the
 * origin of the page. Throws with the reason otherwise.
 */
export async function checkedCoinUri(o: { origin: string; here: string; mint: string; agent: string; name: string; symbol: string; repoUrl: string; fetch?: typeof fetch }): Promise<string> {
  const uri = coinMetadataUri(o.origin, o.mint);
  const want = coinMetadataDoc(o);
  const via = (u: string) => (u.startsWith(`${o.origin}/`) ? `${o.here}${u.slice(o.origin.length)}` : u);
  const query = new URLSearchParams({ name: o.name, symbol: o.symbol, agent: o.agent, repo: o.repoUrl }).toString();
  const c = await checkMetadataUri(uri, { expect: { name: o.name, symbol: o.symbol }, via, query, fetch: o.fetch, timeoutMs: 12_000 });
  if (!c.ok) throw new Error(`The coin's metadata URI was not confirmed (${c.problem}), so the launch was not built: a coin's URI is on chain for good. Try again in a moment.`);
  const got = c.metadata as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(want)) if (got[k] !== v) throw new Error(`The coin's metadata URI answered a different "${k}" than this launch would write, so the launch was not built.`);
  return uri;
}
