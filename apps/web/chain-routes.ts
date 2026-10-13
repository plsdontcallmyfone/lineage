// The web server's /chain/* routes (server side only, never bundled): the page's chain config, the
// JSON-RPC proxy and the faucet, under the network profile (M3, SPEC 14.10). The upstream RPC may be
// a keyed endpoint: its URL stays here. /chain/config shows it redacted (host only), errors are
// scrubbed of it, and the browser only ever talks to /chain/rpc (behind the site gate).
import { redactRpc } from "../../packages/chain/src/endpoint.ts";
import { KNOWN_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { publicProfile, type NetworkProfile } from "../../packages/chain/src/profile.ts";
import { JITO_BLOCK_ENGINE, JITO_METHODS, JITO_TIP_FLOOR, tipFromFloor } from "../../packages/chain/src/jito.ts";

/**
 * SOL/USD for the launch wizard (owner direction 2026-10-11: the launcher pays in SOL, amounts shown
 * in USD too). Jupiter Price API V3 (developers.jup.ag/docs/price, read 2026-10-10; GET
 * https://api.jup.ag/price/v3?ids=<mint> answers { usdPrice, blockId, decimals, ... }; keyless works,
 * Pyth Hermes now answers 401 without a key). No timestamp is given, so a reading is used for at most
 * MAX_AGE_S after this server read it, its blockId may never go backwards, and the price must sit in a
 * sanity band. Otherwise there is no price and the wizard disables the launch ("no SOL price").
 */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOL_PRICE_API = "https://api.jup.ag/price/v3";
export const SOL_PRICE_MAX_AGE_S = 60;
const SOL_BAND = { min: 1, max: 100_000 };

export const RPC_METHODS = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getLatestBlockhash", "getBlockHeight", "getSlot",
  "getMinimumBalanceForRentExemption", "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getTransaction", "getGenesisHash",
  "getFeeForMessage", "getTokenAccountBalance", "getSignaturesForAddress", "getRecentPrioritizationFees",
]);

export interface FaucetLike {
  address: string | null;
  info(): Promise<unknown>;
  lastDrip(wallet: string): unknown;
  drip(wallet: string): Promise<{ status: number; body: unknown }>;
}

export interface ChainRoutesOptions {
  profile: NetworkProfile;
  rpcUrl: string;
  /** extra request headers for the upstream RPC (the Origin a site's /chain/rpc proxy expects) */
  rpcHeaders?: Record<string, string>;
  /** how the upstream is named in /chain/config `rpc_upstream`; default redactRpc(rpcUrl) (host only) */
  rpcLabel?: string;
  /** deployed public state with the profile's quote applied (profile-node stateFor) */
  state: Record<string, unknown> | null;
  /** built only when the profile has a faucet */
  faucet: FaucetLike | null;
  /** the required bind's escape hatch (docs/plans/SEAMLESS-BIND.md 9.2): true lets a hosted launch go out without its bind. Off unless set. */
  bindOptional?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Removes the upstream URL and any key-bearing part of it from a message bound for a browser. */
export function scrubber(url: string): (s: string) => string {
  const parts: string[] = [url];
  try {
    const u = new URL(url);
    if (u.search.length > 1) parts.push(u.search.slice(1), ...[...u.searchParams.values()].filter((v) => v.length >= 8));
    if (u.pathname.length > 1) parts.push(...u.pathname.split("/").filter((x) => x.length >= 8));
    if (u.username) parts.push(u.username);
    if (u.password) parts.push(u.password);
  } catch {
    /* not a URL: the whole string only */
  }
  // short fragments are not secrets and would mangle ordinary JSON
  const sorted = [...new Set(parts)].filter((p) => p.length >= 8).sort((a, b) => b.length - a.length);
  return (s: string) => sorted.reduce((acc, p) => acc.split(p).join("[redacted]"), s);
}

export function chainRoutes(o: ChainRoutesOptions) {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const p = o.profile;
  const scrub = scrubber(o.rpcUrl);
  const name = p.network === "devnet" ? "devnet" : p.cluster;
  const faucet = p.faucet ? o.faucet : null;
  let genesis: string | null = null;
  let solPrice: { usd: number; block: number; readAt: number } | null = null;
  let solErr: string | null = null;
  let tipCache: { lamports: string; at: number } | null = null;
  const now = () => Date.now();

  async function readSolPrice(): Promise<Response> {
    const fresh = solPrice && now() - solPrice.readAt < 15_000;
    if (!fresh) {
      try {
        const r = await f(`${SOL_PRICE_API}?ids=${SOL_MINT}`, { signal: AbortSignal.timeout(8_000) } as RequestInit);
        if (!r.ok) throw new Error(`Jupiter answered HTTP ${r.status}`);
        const e = ((await r.json()) as Record<string, { usdPrice?: unknown; blockId?: unknown } | null>)?.[SOL_MINT];
        const usd = e?.usdPrice, block = Number(e?.blockId ?? 0);
        if (typeof usd !== "number" || !Number.isFinite(usd) || usd < SOL_BAND.min || usd > SOL_BAND.max) throw new Error("Jupiter gave no usable SOL price");
        if (solPrice && block < solPrice.block) throw new Error("Jupiter's SOL price went back to an older block");
        solPrice = { usd, block, readAt: now() };
        solErr = null;
      } catch (e) {
        solErr = scrub((e as Error).message);
      }
    }
    const age = solPrice ? Math.round((now() - solPrice.readAt) / 1000) : null;
    if (!solPrice || age! > SOL_PRICE_MAX_AGE_S)
      return Response.json({ ok: false, reason: solErr ?? "no SOL price", source: "jupiter" }, { headers: { "cache-control": "no-store" } });
    return Response.json({ ok: true, usd: solPrice.usd, block: solPrice.block, age_s: age, max_age_s: SOL_PRICE_MAX_AGE_S, source: "jupiter" }, { headers: { "cache-control": "no-store" } });
  }

  /** Jito's block engine (mainnet only): sendBundle and friends, plus getTipFloor (lamports, from the public tip floor). */
  async function jito(method: string, params: unknown[], id: unknown): Promise<Response> {
    if (p.network !== "mainnet") return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Jito bundles are mainnet only; this is ${p.network}` } }, { status: 400 });
    if (method === "getTipFloor") {
      if (!tipCache || now() - tipCache.at > 30_000) {
        const floor = await f(JITO_TIP_FLOOR, { signal: AbortSignal.timeout(8_000) } as RequestInit).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        tipCache = { lamports: tipFromFloor(floor).toString(), at: now() };
      }
      return Response.json({ jsonrpc: "2.0", id, result: { lamports: tipCache.lamports } });
    }
    if (method === "sendBundle" && !(await cluster()).matches) return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: `upstream is not ${name}; refusing to send` } }, { status: 403 });
    const r = await f(process.env.UNITS_JITO_URL ?? JITO_BLOCK_ENGINE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).catch((e) => e as Error);
    if (r instanceof Error) return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: `Jito did not answer (${r.message})` } }, { status: 502 });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }

  async function rpcCall(method: string, params: unknown[]): Promise<Response> {
    let last = "";
    for (let i = 0; i < 7; i++) {
      if (i) await sleep(Math.min(8000, 400 * 2 ** i));
      try {
        const r = await f(o.rpcUrl, { method: "POST", headers: { "content-type": "application/json", ...(o.rpcHeaders ?? {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        if (r.status === 429 || r.status >= 500) {
          last = `HTTP ${r.status}`;
          continue;
        }
        return new Response(scrub(await r.text()), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      } catch (e) {
        last = scrub((e as Error).message);
      }
    }
    return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `${name} RPC did not answer (${last})` } }, { status: 502 });
  }

  async function cluster(): Promise<{ genesis: string | null; cluster: string; devnet: boolean; matches: boolean }> {
    if (!genesis) {
      try {
        const r = (await (await rpcCall("getGenesisHash", [])).json()) as { result?: string };
        genesis = r.result ?? null;
      } catch {
        genesis = null;
      }
    }
    return { genesis, cluster: genesis ? (KNOWN_GENESIS[genesis] ?? "unknown") : "unreachable", devnet: genesis === KNOWN_GENESIS_DEVNET, matches: genesis === p.genesis };
  }

  async function route(req: Request, path: string): Promise<Response> {
    if (path === "/chain/config") {
      const c = await cluster();
      const pub = o.state ? Object.fromEntries(Object.entries(o.state).filter(([k]) => !/key/i.test(k) && k !== "test_epoch_leaves" && (p.network === "devnet" || k !== "rpc_url"))) : null;
      return Response.json({ rpc: "/chain/rpc", rpc_upstream: o.rpcLabel ?? redactRpc(o.rpcUrl), genesis: c.genesis, cluster: c.cluster, devnet: c.devnet, state: pub, faucet: faucet?.address ?? null, profile: publicProfile(p), ...(o.bindOptional ? { bind_optional: true } : {}) });
    }
    if (path === "/chain/rpc") {
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      const body = (await req.json().catch(() => null)) as { method?: string; params?: unknown[]; id?: unknown } | null;
      if (body?.method && ((JITO_METHODS as readonly string[]).includes(body.method) || body.method === "getTipFloor")) return jito(body.method, body.params ?? [], body.id ?? null);
      if (!body?.method || !RPC_METHODS.has(body.method)) return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: `method ${body?.method} not allowed here` } }, { status: 400 });
      if (body.method === "sendTransaction" && !(await cluster()).matches)
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: `upstream is not ${name}; refusing to send` } }, { status: 403 });
      return rpcCall(body.method, body.params ?? []);
    }
    if (path === "/chain/sol-price") return readSolPrice();
    if (path === "/chain/faucet") {
      if (!faucet) return Response.json({ enabled: false, reason: p.faucet ? "no devnet state (scripts/devnet/devnet.json)" : `no faucet on ${p.network}` });
      if (req.method === "GET") {
        const w = new URL(req.url).searchParams.get("wallet");
        return Response.json({ ...((await faucet.info().catch((e) => ({ enabled: false, reason: (e as Error).message }))) as object), last: w ? faucet.lastDrip(w) : undefined });
      }
      if (req.method !== "POST") return new Response("GET or POST", { status: 405 });
      const body = (await req.json().catch(() => null)) as { wallet?: string } | null;
      const r = await faucet.drip(String(body?.wallet ?? ""));
      return Response.json(r.body, { status: r.status });
    }
    return new Response("not found", { status: 404 });
  }

  return { route, cluster, faucet };
}

const KNOWN_GENESIS_DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
