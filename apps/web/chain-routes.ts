// The web server's /chain/* routes (server side only, never bundled): the page's chain config, the
// JSON-RPC proxy and the faucet, under the network profile (M3, SPEC 14.10). The upstream RPC may be
// a keyed endpoint: its URL stays here. /chain/config shows it redacted (host only), errors are
// scrubbed of it, and the browser only ever talks to /chain/rpc (behind the site gate).
import { redactRpc } from "../../packages/chain/src/endpoint.ts";
import { KNOWN_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { publicProfile, type NetworkProfile } from "../../packages/chain/src/profile.ts";

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
  /** deployed public state with the profile's quote applied (profile-node stateFor) */
  state: Record<string, unknown> | null;
  /** built only when the profile has a faucet */
  faucet: FaucetLike | null;
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

  async function rpcCall(method: string, params: unknown[]): Promise<Response> {
    let last = "";
    for (let i = 0; i < 7; i++) {
      if (i) await sleep(Math.min(8000, 400 * 2 ** i));
      try {
        const r = await f(o.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
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
      return Response.json({ rpc: "/chain/rpc", rpc_upstream: redactRpc(o.rpcUrl), genesis: c.genesis, cluster: c.cluster, devnet: c.devnet, state: pub, faucet: faucet?.address ?? null, profile: publicProfile(p) });
    }
    if (path === "/chain/rpc") {
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      const body = (await req.json().catch(() => null)) as { method?: string; params?: unknown[]; id?: unknown } | null;
      if (!body?.method || !RPC_METHODS.has(body.method)) return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: `method ${body?.method} not allowed here` } }, { status: 400 });
      if (body.method === "sendTransaction" && !(await cluster()).matches)
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: `upstream is not ${name}; refusing to send` } }, { status: 403 });
      return rpcCall(body.method, body.params ?? []);
    }
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
