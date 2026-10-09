import { RpcError, type Transport } from "@lineage/chain";

// The indexer's JSON-RPC transport: one request at a time with a minimum gap between requests
// (public devnet rate limits per IP), and on HTTP 429 or 5xx an exponential backoff that honours
// Retry-After, up to `maxWaitMs` per call. RPC-level errors are thrown at once. Counters feed
// GET /market/status. The URL may carry a key: it is never logged or returned (redactRpc).

export interface RpcStats {
  calls: number;
  errors: number;
  http429: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

export function throttledTransport(url: string, opts: { minGapMs?: number; maxWaitMs?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}):
  { transport: Transport; stats: RpcStats } {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minGap = opts.minGapMs ?? 250;
  const maxWait = opts.maxWaitMs ?? 120_000;
  const stats: RpcStats = { calls: 0, errors: 0, http429: 0, lastError: null, lastErrorAt: null };
  let chain: Promise<unknown> = Promise.resolve();
  let last = 0;
  let id = 0;
  const once = async (method: string, params: unknown[]): Promise<unknown> => {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const gap = last + minGap - Date.now();
      if (gap > 0) await sleep(gap);
      last = Date.now();
      stats.calls++;
      let res: Response | null = null;
      let why = "";
      try {
        res = await f(url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      } catch (e) {
        why = `network: ${(e as Error).message?.slice(0, 80) ?? "error"}`;
      }
      if (res && res.status !== 429 && res.status < 500) {
        const body = (await res.json()) as { result?: unknown; error?: { message: string; code: number; data?: unknown } };
        if (body.error) {
          stats.errors++;
          stats.lastError = `${method}: ${body.error.message}`.slice(0, 200);
          stats.lastErrorAt = Date.now();
          throw new RpcError(`${method}: ${body.error.message}`, body.error.code, body.error.data);
        }
        return body.result;
      }
      if (res?.status === 429) stats.http429++;
      stats.errors++;
      why ||= `HTTP ${res!.status}`;
      stats.lastError = `${method}: ${why}`;
      stats.lastErrorAt = Date.now();
      const ra = Number(res?.headers.get("retry-after") ?? "");
      const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, 500 * 2 ** attempt);
      if (waited + backoff > maxWait) throw new RpcError(`${method}: gave up after ${attempt + 1} attempts (${why})`);
      waited += backoff;
      await sleep(backoff);
    }
  };
  const transport: Transport = (method, params) => {
    const p = chain.then(() => once(method, params));
    chain = p.catch(() => undefined);
    return p;
  };
  return { transport, stats };
}
