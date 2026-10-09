// Polite reads of a public Core (verify.ts, replica mode). The live site's gate allows 120 requests a
// minute per address (burst 60), and a full recompute makes hundreds, so remote reads are paced and a
// 429, 502 or 503 is retried with backoff (Retry-After when the gate sends one). Local Cores are not
// paced.

const RETRY = new Set([429, 502, 503, 504]);

export function politeFetch(base: string, opts: { minIntervalMs?: number; attempts?: number; fetchImpl?: typeof fetch } = {}) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(base);
  const gap = opts.minIntervalMs ?? (local ? 0 : 520);
  const attempts = opts.attempts ?? 8;
  const f = opts.fetchImpl ?? fetch;
  let next = 0;
  return async (url: string, init?: RequestInit): Promise<Response> => {
    for (let i = 0; ; i++) {
      const wait = next - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      next = Date.now() + gap;
      let r: Response | null = null;
      try {
        r = await f(url, init);
      } catch (e) {
        if (i + 1 >= attempts) throw e;
      }
      if (r && (!RETRY.has(r.status) || i + 1 >= attempts)) return r;
      const after = Number(r?.headers.get("retry-after"));
      await Bun.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(1000 * 2 ** i, 30_000));
    }
  };
}
