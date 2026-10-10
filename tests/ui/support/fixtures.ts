import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { installMockWallet, testWallet, type TestWallet } from "./wallet.ts";

// Fixtures every UI test gets (docs/UI-TESTS.md):
//  - the app's theme follows the project's colorScheme (localStorage "lineage-theme", as the toggle sets it)
//  - console errors and uncaught page errors are collected; a test fails on any that is not allow-listed
//  - a write guard: every request that could change state is aborted and fails the test. Allowed are
//    reads, devnet JSON-RPC reads and simulations through /chain/rpc, and routes a test answers itself
//    (the soul draft). No transaction can be sent: sendTransaction and airdrops are refused here and the
//    mock wallet refuses to sign transactions.
//  - a read pacer for Core (/api/*) and the indexer (/market/*): the deployed site's gate allows about
//    120 Core reads a minute per address (scripts/deploy/gate.ts), and a test run from one address
//    reads far faster than a person does. GETs are paced per worker, a 429/502/503 is retried after the
//    wait the gate asks for, and identical Core reads within 30 s are answered from this worker's cache.
//    Devnet JSON-RPC reads through /chain/rpc (the gate's rpc limit) are paced and retried the same way.
//    The app still gets the live response; nothing is stubbed.
//  - `wallet`: the mock Wallet Standard wallet (support/wallet.ts), installed only when a test asks for it
//  - `data`: the indexer and Core API of the app under test, for asserting figures against

/**
 * Console errors that are not app bugs. Keep each with its reason; everything else fails the test.
 *  - net::ERR_BLOCKED_BY_CLIENT: a request the write guard aborted (the guard fails the test itself,
 *    listing the request, so the console line adds nothing)
 *  - a 429 on /live/events: the deployed site's gate caps open event streams per address
 *    (scripts/deploy/gate.ts, too_many_streams); parallel test pages from one address exceed it, and the
 *    app's EventSource reconnects on its own. Only that stream, only status 429.
 */
export const CONSOLE_ALLOW: RegExp[] = [/net::ERR_BLOCKED_BY_CLIENT/, /status of 429 \(\) \S+\/live\/events(\?|$)/];

// ---------------------------------------------------------------- read pacing (one bucket per worker)

const WORKERS = Math.max(1, Number(process.env.UI_WORKERS ?? 2));
type Bucket = { perMin: number; tokens: number; at: number };
const mkBucket = (perMin: number): Bucket => ({ perMin: perMin / WORKERS, tokens: Math.max(4, perMin / WORKERS / 3), at: Date.now() });
// under the gate's limits for one address: Core 120/min, devnet RPC 120/min (burst 40)
const CORE = mkBucket(Number(process.env.UI_READS_PER_MIN ?? 100));
const RPC = mkBucket(Number(process.env.UI_RPC_PER_MIN ?? 90));
async function pace(b: Bucket = CORE) {
  for (;;) {
    const now = Date.now();
    b.tokens = Math.min(Math.max(4, b.perMin / 3), b.tokens + ((now - b.at) / 60_000) * b.perMin);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.ceil(((1 - b.tokens) / b.perMin) * 60_000)));
  }
}
const coreCache = new Map<string, { at: number; status: number; headers: Record<string, string>; body: Buffer }>();
const CACHE_MS = 30_000;

/** A read through the pacer: Core GETs (/api/*, cached 30 s), indexer GETs (/market/*), devnet RPC reads. */
async function pacedRead(route: import("@playwright/test").Route, url: URL) {
  const core = url.pathname.startsWith("/api/");
  const bucket = core ? CORE : url.pathname === "/chain/rpc" ? RPC : null;
  const key = url.pathname + url.search;
  const hit = core ? coreCache.get(key) : undefined;
  if (hit && Date.now() - hit.at < CACHE_MS) return route.fulfill({ status: hit.status, headers: hit.headers, body: hit.body });
  for (let i = 0; ; i++) {
    if (bucket) await pace(bucket);
    let r;
    try {
      r = await route.fetch({ timeout: 60_000 });
    } catch {
      return route.abort("failed").catch(() => {});
    }
    if ([429, 502, 503].includes(r.status()) && i < 6) {
      const wait = Math.min(30, Number(r.headers()["retry-after"] ?? 5)) * 1000;
      if (bucket) bucket.tokens = 0;
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    // the test may end (and its context close) while a read is in flight: drop it quietly then
    const body = await r.body().catch(() => null);
    if (!body) return route.abort("failed").catch(() => {});
    if (core && r.status() === 200) coreCache.set(key, { at: Date.now(), status: 200, headers: r.headers(), body });
    return route.fulfill({ response: r, body }).catch(() => {});
  }
}

const READ_RPC = /^(get\w+|simulateTransaction|isBlockhashValid|minimumLedgerSlot)$/;

export interface Data {
  /** GET /market/tokens (listed tokens, hidden ones left out), all rows */
  tokens(): Promise<any[]>;
  token(mint: string): Promise<any>;
  hidden(): Promise<{ mint: string; agent: string | null; reason: string }[]>;
  core<T = any>(path: string): Promise<T>;
  get<T = any>(path: string): Promise<T>;
}

async function getJson(request: APIRequestContext, path: string) {
  for (let i = 0; ; i++) {
    if (path.startsWith("/api/")) await pace();
    const r = await request.get(path, { headers: { accept: "application/json" } });
    // the site's gate rate-limits reads per address: wait as it asks, a few times, then fail loudly
    if ((r.status() === 429 || r.status() === 502 || r.status() === 503) && i < 4) {
      await new Promise((res) => setTimeout(res, 1000 * Math.min(20, Number(r.headers()["retry-after"] ?? 5))));
      continue;
    }
    expect(r.ok(), `GET ${path}: HTTP ${r.status()}`).toBeTruthy();
    return r.json();
  }
}

type Fixtures = {
  guard: { errors: string[]; blocked: string[]; allowWrite: (re: RegExp) => void };
  wallet: TestWallet & { log: string[] };
  data: Data;
};

export const test = base.extend<Fixtures>({
  guard: [
    async ({ context, page }, use, info) => {
      const dark = info.project.use.colorScheme === "dark";
      await context.addInitScript((d: boolean) => {
        try {
          localStorage.setItem("lineage-theme", d ? "dark" : "light");
        } catch {}
      }, dark);
      const errors: string[] = [];
      const blocked: string[] = [];
      const allowed: RegExp[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = `console: ${m.text()} ${m.location()?.url ?? ""}`.trim();
        if (!CONSOLE_ALLOW.some((re) => re.test(text))) errors.push(text);
      });
      await context.route("**/*", async (route) => {
        const req = route.request();
        const method = req.method();
        const url = new URL(req.url());
        if (method === "GET" && /^\/(api|market)\//.test(url.pathname) && url.origin === new URL(info.project.use.baseURL!).origin) return pacedRead(route, url);
        if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.fallback();
        if (allowed.some((re) => re.test(url.pathname))) return route.fallback();
        if (url.pathname === "/chain/rpc") {
          let calls: { method?: string }[] = [];
          try {
            const body = JSON.parse(req.postData() ?? "null");
            calls = Array.isArray(body) ? body : [body];
          } catch {}
          if (calls.length && calls.every((c) => READ_RPC.test(String(c?.method)))) return pacedRead(route, url);
          blocked.push(`${method} ${url.pathname} ${calls.map((c) => c?.method).join(",")}`);
        } else blocked.push(`${method} ${url.pathname}`);
        return route.abort("blockedbyclient");
      });
      const g = { errors, blocked, allowWrite: (re: RegExp) => void allowed.push(re) };
      await use(g);
      expect(blocked, "requests that would write (aborted by the write guard)").toEqual([]);
      expect(errors, "console errors and page errors").toEqual([]);
    },
    { auto: true },
  ],

  wallet: async ({ context }, use) => {
    const w = testWallet();
    const log: string[] = [];
    await installMockWallet(context, w, log);
    await use({ ...w, log });
    expect(log.filter((x) => x.startsWith("signTransaction")), "transactions offered to the wallet").toEqual([]);
  },

  data: async ({ request }, use) => {
    const cache = new Map<string, Promise<any>>();
    const once = (p: string) => {
      if (!cache.has(p)) cache.set(p, getJson(request, p));
      return cache.get(p)!;
    };
    await use({
      tokens: async () => (await once("/market/tokens?sort=market_cap&limit=200")).tokens,
      token: (mint) => getJson(request, `/market/tokens/${mint}`),
      hidden: async () => (await once("/api/hidden")).hidden ?? [],
      core: (path) => once(`/api/${path.replace(/^\/+/, "")}`),
      get: (path) => getJson(request, path),
    });
  },
});

export { expect };
export type { Page };
