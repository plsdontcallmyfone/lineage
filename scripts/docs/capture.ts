#!/usr/bin/env bun
// Captures what the docs show from the live devnet site, so no example in the docs is written by hand:
//
//   bun scripts/docs/capture.ts [api] [verify] [shots] [--site <url>] [--gen <gen_id>]
//
//   api      request and response of the Core and market indexer routes the docs use as examples
//            -> apps/docs/captured/api-examples.json (responses trimmed by a fixed rule, every cut marked)
//   verify   picks a real accepted generation, runs scripts/identity/verify-generation.ts and
//            scripts/verify.ts on it against the site and stores the exact output and the facts the
//            tutorial quotes -> apps/docs/captured/verify.json
//   shots    headless Chromium screenshots of the current app (launch wizard steps, a generation page,
//            the analytics page, a live desktop when one runs) -> apps/docs/public/shots/*.jpg and
//            apps/docs/captured/shots.json
//
// With no part named, all three run. Everything is read-only: only GETs go to Core and the indexer,
// the browser runs with a mock wallet that refuses every transaction and a guard that aborts every
// request that could write (the same rule as tests/ui/support/fixtures.ts), and the soul draft of the
// wizard is answered from a stored soul, so no model is called. Headless Chromium only, never a
// person's own browser. The build (scripts/docs/build.ts) reads the files written here; it never
// fetches, so the site server can build the docs at startup without the network.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const DATA = join(ROOT, "apps/docs/captured");
const SHOTS = join(ROOT, "apps/docs/public/shots");
const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const SITE = (opt("site") ?? "https://157-245-71-188.sslip.io").replace(/\/+$/, "");
const parts = ["api", "verify", "shots"].filter((p) => argv.includes(p));
const want = (p: string) => !parts.length || parts.includes(p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const save = (file: string, v: unknown) => {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, file), JSON.stringify(v, null, 2) + "\n");
  console.log(`wrote apps/docs/captured/${file}`);
};
const load = <T,>(file: string): T | null => (existsSync(join(DATA, file)) ? (JSON.parse(readFileSync(join(DATA, file), "utf8")) as T) : null);

/** A GET that waits as the site's gate asks (it rate-limits reads per address). */
async function get(path: string): Promise<{ status: number; ms: number; body: any; type: string }> {
  for (let i = 0; ; i++) {
    const t = Date.now();
    const r = await fetch(SITE + path, { headers: { accept: "application/json" } });
    if ([429, 502, 503].includes(r.status) && i < 5) {
      await sleep(1000 * Math.min(20, Number(r.headers.get("retry-after") ?? 5)));
      continue;
    }
    const type = r.headers.get("content-type") ?? "";
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: kept as text */
    }
    return { status: r.status, ms: Date.now() - t, body, type };
  }
}

// ---- the trim rule: the same for every example, and every cut is visible in the output ----
const MAX_STR = 96;
/** Arrays keep their first `arr` items, objects their first `keys` fields, strings their first 96 characters. */
export function trim(v: unknown, o: { arr: number; keys: number }, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}... (${v.length} characters)` : v;
  if (Array.isArray(v)) {
    const n = depth === 0 ? Math.max(o.arr, 1) : o.arr;
    const head = v.slice(0, n).map((x) => trim(x, o, depth + 1));
    return v.length > n ? [...head, `... ${v.length - n} more`] : head;
  }
  if (v && typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, x] of e.slice(0, o.keys)) out[k] = trim(x, o, depth + 1);
    if (e.length > o.keys) out["..."] = `${e.length - o.keys} more fields`;
    return out;
  }
  return v;
}

interface Picks {
  gen: string;
  candidate: string;
  unit: string;
  agent: string;
  mint: string;
}

/** The ids the examples use: the tutorial's generation (kept across captures), its unit and author, and the author's coin. */
async function picks(): Promise<Picks> {
  const prev = load<{ generation?: { gen_id: string } }>("verify.json");
  let gen = opt("gen") ?? prev?.generation?.gen_id ?? null;
  if (!gen) {
    // the newest accepted generation whose commit an agent published under its own account, Verified
    const rows = (await get("/api/analytics/generations?limit=50")).body.rows as any[];
    const hit = rows.find((r) => r.github?.status === "published" && r.github?.verified) ?? rows[0];
    if (!hit) throw new Error("the site lists no accepted generation");
    gen = hit.gen_id as string;
  }
  const g = (await get(`/api/generations/${gen}`)).body;
  if (!g?.gen_id) throw new Error(`generation ${gen} not found on ${SITE}`);
  const tokens = (await get("/market/tokens?limit=200")).body.tokens as any[];
  const mint = tokens.find((t) => t.agent === g.author)?.mint ?? tokens[0]?.mint;
  return { gen, candidate: g.candidate_id, unit: g.lineage_id, agent: g.author, mint };
}

async function captureApi(p: Picks) {
  const T = (arr: number, keys = 14) => ({ arr, keys });
  const list: { id: string; title: string; path: string; why: string; t: { arr: number; keys: number } }[] = [
    { id: "health", title: "Is Core up, and which epoch is open", path: "/v1/health", why: "The cheapest call. Use it as a liveness probe.", t: T(2) },
    { id: "config", title: "Every network parameter", path: "/v1/config", why: "Quorum, tolerances, slashes, epoch length, the launch costs (`prepay`). The docs' highlighted figures are read from this route.", t: T(2, 16) },
    { id: "stats", title: "Network counters", path: "/v1/stats", why: "Units, generations, candidates, agents, the open epoch and the chain view.", t: T(1, 12) },
    { id: "units", title: "List the units", path: "/v1/units", why: "One row per repository and recipe, with its tip. `/v1/lineages` answers the same.", t: T(1, 14) },
    { id: "unit", title: "One unit", path: `/v1/units/${p.unit}`, why: "The recipe, the calibration baseline and the chain of generations.", t: T(1, 12) },
    { id: "generation", title: "One accepted generation", path: `/v1/generations/${p.gen}`, why: "The patch, the verdict, every counted replay with its raw samples, and the GitHub commit.", t: T(1, 18) },
    { id: "candidate", title: "One final candidate", path: `/v1/candidates/${p.candidate}`, why: "What was submitted and how it ended. Author and team appear only once it is final.", t: T(1, 14) },
    { id: "agent-profile", title: "An agent's public profile", path: `/v1/agents/${p.agent}/profile`, why: "Soul summary, stats with ranks, followers, the last verified improvement.", t: T(1, 12) },
    { id: "agent-spend", title: "An agent's runway", path: `/v1/agents/${p.agent}/spend`, why: "Vault balance, burn per hour, runway, model and route, and why the agent waits if it waits.", t: T(1, 16) },
    { id: "agent-journal", title: "An agent's journal", path: `/v1/agents/${p.agent}/journal?limit=1`, why: "Signed notes, public once the work they mention is final.", t: T(1, 12) },
    { id: "guard-config", title: "The guard limits in force", path: "/v1/guard-config", why: "Every version of the limits on non-target metrics, with its digest and start time.", t: T(1, 12) },
    { id: "launch-fronting", title: "What a launch costs", path: "/v1/launch-fronting", why: "The credits a launcher must front, the initial buy share and the units account price.", t: T(2, 14) },
    { id: "models", title: "Models that can be picked now", path: "/v1/models", why: "The registry with prices and, per model, whether the runtime can route it right now.", t: T(1, 12) },
    { id: "analytics-generations", title: "Accepted generations as a table", path: "/v1/analytics/generations?limit=1", why: "Filter by repo, agent, metric, class, model, provider and time; sort by time or effect.", t: T(1, 14) },
    { id: "shared-findings", title: "What other agents already tried", path: `/v1/learnings/shared?lineage=${p.unit}&limit=2`, why: "The shared findings a worker reads before an attempt on this unit.", t: T(2, 14) },
  ];
  const market: typeof list = [
    { id: "market-summary", title: "Market totals", path: "/market/summary", why: "Listed coins, how many are awake, working and graduated.", t: T(2) },
    { id: "market-tokens", title: "Coins by market cap", path: "/market/tokens?sort=market_cap&limit=1", why: "The five figures of each coin and what its agent is building.", t: T(1, 40) },
    { id: "market-candles", title: "Candles of one coin", path: `/market/tokens/${p.mint}/candles?tf=1h`, why: "Open, high, low, close and volume per interval, in the quote token.", t: T(2) },
  ];
  const examples: any[] = [];
  for (const e of [...list, ...market]) {
    const core = e.path.startsWith("/v1/");
    const url = core ? `/api/${e.path.slice("/v1/".length)}` : e.path;
    const r = await get(url);
    if (r.status !== 200) throw new Error(`${url}: HTTP ${r.status}`);
    examples.push({ id: e.id, group: core ? "core" : "market", title: e.title, why: e.why, method: "GET", path: e.path.replace(/\?.*$/, ""), request: url, status: r.status, response: trim(r.body, e.t) });
    console.log(`  ${r.status} GET ${url} (${r.ms} ms)`);
    await sleep(600);
  }
  save("api-examples.json", {
    captured_at: new Date().toISOString(),
    site: SITE,
    trim: `Arrays show their first items, long objects their first fields and strings their first ${MAX_STR} characters; every cut is marked in place ("... n more").`,
    examples,
  });
}

function run(cmd: string[]): { cmd: string; exit: number; out: string; s: number } {
  const t = Date.now();
  const r = spawnSync("bun", cmd, { cwd: ROOT, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { cmd: `bun ${cmd.join(" ")}`, exit: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd(), s: Math.round((Date.now() - t) / 100) / 10 };
}

const int = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function captureVerify(p: Picks) {
  const g = (await get(`/api/generations/${p.gen}`)).body;
  const unit = (await get(`/api/units/${p.unit}`)).body;
  const gc = (await get("/api/guard-config")).body;
  const cand = (await get(`/api/candidates/${p.candidate}`)).body;
  const counted = (g.replays as any[]).filter((r) => r.role === "counted");
  const first = counted[0]?.result?.metrics ?? {};
  const facts: Record<string, string> = {
    gen_id: g.gen_id,
    gen8: g.gen_id.slice(0, 8),
    candidate_id: g.candidate_id,
    candidate12: g.candidate_id.slice(0, 12),
    unit_id: g.lineage_id,
    unit8: g.lineage_id.slice(0, 8),
    height: String(g.height),
    parent_height: String(g.height - 1),
    kind: g.kind,
    target: String(g.target),
    recipe: unit?.recipe?.name ?? unit?.recipe_name ?? "TBA",
    repo: unit?.recipe?.repo ?? "TBA",
    repo_key: String(unit?.recipe?.repo ?? "TBA").replace("https://github.com/", ""),
    author: g.author,
    epoch: String(g.epoch),
    accepted_at: new Date(g.accepted_at).toISOString().replace(/\.\d+Z$/, "Z"),
    replays_counted: String(counted.length),
    ratio: Number(g.effect?.ratio).toFixed(6),
    gain_pct: ((1 - Number(g.effect?.ratio)) * 100).toFixed(2),
    patch_hash: g.patch_hash,
    verdict_digest: g.verdict_digest,
    commit_url: g.github?.url ?? "TBA",
    commit_repo: g.github?.repo ?? "TBA",
    commit_sha12: String(g.github?.sha ?? g.github?.commit ?? "").slice(0, 12) || "TBA",
    rule_version: String(g.verdict?.rule_version ?? 1),
    committed_at: cand?.committed_at ? new Date(cand.committed_at).toISOString().replace(/\.\d+Z$/, "Z") : "TBA",
    guard_activation: gc?.activation_ms ? new Date(gc.activation_ms).toISOString().replace(/\.\d+Z$/, "Z") : "TBA",
    guard_default_pct: gc?.current ? String(Number(gc.current.default_max_regression) * 100) : "TBA",
    site: SITE,
  };
  // the target metric and the other metrics, from the first counted replay's raw samples
  const metrics: { name: string; base: string; cand: string; change: string; target: boolean }[] = [];
  for (const [name, m] of Object.entries(first) as [string, any][]) {
    if (!Array.isArray(m?.base) || !Array.isArray(m?.cand) || !m.base.length || !m.cand.length) continue;
    const b = median(m.base);
    const c = median(m.cand);
    metrics.push({ name, base: int(b), cand: int(c), change: `${(((c - b) / b) * 100).toFixed(2)}%`, target: name === g.target });
  }
  const t = metrics.find((m) => m.target);
  if (t) Object.assign(facts, { target_base: t.base, target_cand: t.cand, target_change: t.change });
  console.log(`  generation ${facts.gen8} (${facts.recipe} #${facts.height}, ${facts.kind} ${facts.target})`);
  const outputs = {
    "verify-generation": run(["scripts/identity/verify-generation.ts", p.gen, "--core", SITE]),
    "verify-candidate": run(["scripts/verify.ts", "--core", SITE, "--candidate", p.candidate, "--no-draws"]),
    "verify-all": run(["scripts/verify.ts", "--core", SITE]),
  };
  for (const [k, o] of Object.entries(outputs)) console.log(`  ${k}: exit ${o.exit} in ${o.s} s`);
  // the full run prints one line per verdict: keep the first lines and the summary, and say how many were cut
  const all = outputs["verify-all"];
  const lines = all.out.split("\n");
  const verdictLines = lines.filter((l) => /^(ok|FAIL|MISMATCH)\s/.test(l));
  const rest = lines.filter((l) => !/^(ok|FAIL|MISMATCH)\s/.test(l));
  const shown = verdictLines.slice(0, 4);
  const cut = verdictLines.length - shown.length;
  all.out = [...shown, ...(cut > 0 ? [`... ${cut} more lines, one per verdict`] : []), ...rest].join("\n");
  save("verify.json", { captured_at: new Date().toISOString(), site: SITE, generation: { gen_id: p.gen }, facts, metrics, outputs });
}

// ---- screenshots ----
async function captureShots(p: Picks) {
  const { chromium } = await import("@playwright/test");
  const { installMockWallet, testWallet, MOCK_WALLET_NAME } = await import("../../tests/ui/support/wallet.ts");
  const { newSoul } = await import("../../packages/souls/src/schema.ts");
  mkdirSync(SHOTS, { recursive: true });
  const persona = JSON.parse(readFileSync(join(ROOT, "scripts/launch-e2e/STATE.json"), "utf8")).soul_core.doc.persona;
  const wallet = testWallet();
  const browser = await chromium.launch({ headless: true });
  const READ_RPC = /^(get\w+|simulateTransaction|isBlockhashValid|minimumLedgerSlot)$/;
  const blocked: string[] = [];
  const context = async (width: number, withWallet: boolean) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: width < 600 ? 2 : 1.5, colorScheme: "light", isMobile: width < 600, hasTouch: width < 600 });
    if (withWallet) await installMockWallet(ctx, wallet, []);
    // the write guard of tests/ui/support/fixtures.ts: reads pass, anything that could change state is aborted
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return route.fallback();
      if (url.pathname.endsWith("/souls/draft")) {
        const body = JSON.parse(req.postData() ?? "{}");
        const doc = newSoul({ agent: body.agent, seed: body.seed, persona, created_at: Math.floor(Date.now() / 1000), origin: { by: "model", model: "docs capture (a stored soul, no model call)" } as any });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc, usd: 0 }) });
      }
      if (url.pathname === "/chain/rpc") {
        let calls: { method?: string }[] = [];
        try {
          const body = JSON.parse(req.postData() ?? "null");
          calls = Array.isArray(body) ? body : [body];
        } catch {
          /* refused below */
        }
        if (calls.length && calls.every((c) => READ_RPC.test(String(c?.method)))) return route.fallback();
      }
      if (url.origin !== new URL(SITE).origin && url.host === "auth.privy.io") return route.fallback(); // Privy's own analytics, nothing of units
      blocked.push(`${req.method()} ${url.pathname}`);
      return route.abort("blockedbyclient");
    });
    return ctx;
  };
  const manifest: Record<string, { file: string; width: number; height: number; url: string; what: string; captured_at: string }> = load<any>("shots.json")?.shots ?? {};
  const snap = async (page: import("@playwright/test").Page, name: string, what: string, sel?: string, clip?: { x: number; y: number; width: number; height: number }) => {
    const file = `${name}.jpg`;
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const target = sel ? page.locator(sel).first() : null;
    if (target) await target.scrollIntoViewIfNeeded();
    const buf = target ? await target.screenshot({ type: "jpeg", quality: 84 }) : await page.screenshot({ type: "jpeg", quality: 84, ...(clip ? { clip, fullPage: true } : {}) });
    writeFileSync(join(SHOTS, file), buf);
    // JPEG size from its SOF marker
    let w = 0;
    let h = 0;
    for (let i = 2; i < buf.length - 8; ) {
      if (buf[i] !== 0xff) break;
      const m = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        h = buf.readUInt16BE(i + 5);
        w = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
    manifest[name] = { file, width: w, height: h, url: new URL(page.url()).pathname, what, captured_at: new Date().toISOString() };
    console.log(`  ${file} ${w}x${h} (${Math.round(buf.length / 1024)} KB)`);
  };
  const open = async (page: import("@playwright/test").Page, path: string, wait?: string) => {
    await page.goto(SITE + path, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (wait) await page.locator(wait).first().waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  };
  const attempt = async (name: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      console.log(`  ${name}: NOT captured (${String((e as Error).message).split("\n")[0]})`);
    }
  };

  // 1. the launch wizard, step by step (mock wallet, nothing signed, nothing sent)
  if (!argv.includes("--pages-only")) {
    const ctx = await context(1280, true);
    const page = await ctx.newPage();
    await attempt("launch wizard", async () => {
      await open(page, "/launch", "#lz-nav .lz-step");
      await page.evaluate((n) => (localStorage.setItem("units-wallet", n), localStorage.setItem("lineage-wallet", n)), MOCK_WALLET_NAME);
      await page.reload();
      await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
      await page.locator("#lz-nav .lz-step").first().waitFor();
      // a step taller than the window is captured whole: keep the sticky header out of it
      await page.addStyleTag({ content: ".top{position:absolute!important}" });
      await page.fill('[name="l_name"]', "base58 speedups");
      await page.fill('[name="l_symbol"]', "TB58");
      await page.fill('[name="l_desc"]', "Makes base58 encoding and decoding cheaper, one measured change at a time.");
      await snap(page, "launch-1-coin", "Launch wizard, step 1: the coin", '[data-step="0"]');
      await page.click('[data-act="lz-next"]');
      await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
      await page.locator("#w-work .lz-rec, #w-work .banner, #w-work .dim").first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      await snap(page, "launch-2-work", "Launch wizard, step 2: the work", '[data-step="1"]');
      await page.click('[data-act="lz-next"]');
      await page.fill('[name="s_vibe"]', "dry, exact, cheerful about small wins");
      await page.fill('[name="s_specialty"]', "base58 hot paths, same bytes out");
      await page.fill('[name="s_values"]', "measure before claiming, small diffs");
      await page.click('[data-act="soul-generate"]');
      await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 60_000 });
      await page.waitForTimeout(800);
      // the step is several screens tall: the soul card's head and the model picker are captured on their own
      const clipOf = async (from: string, height: number) => {
        const b = await page.locator(from).first().evaluate((el) => {
          const r = el.getBoundingClientRect();
          const p = el.closest("[data-step]")!.getBoundingClientRect();
          return { x: p.left + window.scrollX, y: r.top + window.scrollY, width: p.width };
        });
        return { x: Math.max(0, b.x), y: Math.max(0, b.y - 44), width: b.width, height };
      };
      await snap(page, "launch-3-soul", "Launch wizard, step 3: the seed and the soul it generates", undefined, await clipOf('[name="s_vibe"]', 470));
      await snap(page, "launch-3-model", "Launch wizard, step 3: the model picker, by provider", undefined, await clipOf(".wl-prov", 480));
      await page.click('[data-act="lz-next"]');
      await page.locator("#w-id-price").waitFor();
      await page.waitForTimeout(800);
      await snap(page, "launch-4-identity", "Launch wizard, step 4: identity", '[data-step="3"]');
      await page.click('[data-act="lz-next"]');
      await page.locator("[data-fronting-total]").filter({ hasText: "SOL" }).waitFor({ timeout: 120_000 });
      await page.click(".lz-sum-more summary");
      await snap(page, "launch-5-funding", "Launch wizard, step 5: funding, with the breakdown open", '[data-step="4"]');
      await page.click('[data-act="lz-next"]');
      await page.locator("#w-launch-out .mark.good, #w-launch-out [data-err]").first().waitFor({ timeout: 120_000 });
      await page.waitForTimeout(800);
      await snap(page, "launch-6-review", "Launch wizard, step 6: review (Launch was not pressed)", '[data-step="5"]');
    });
    await ctx.close();
  }

  // 2. pages anyone can open: the generation summary, analytics, projects, a coin page, a profile
  for (const width of argv.includes("--wizard-only") ? [] : [1280]) {
    const ctx = await context(width, false);
    const page = await ctx.newPage();
    await attempt("generation", async () => {
      await open(page, `/generations/${p.gen}`, ".panel");
      await page.waitForTimeout(1500);
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await snap(page, "generation-summary", "A generation page: the summary at the top");
      await page.setViewportSize({ width, height: 900 });
    });
    await attempt("analytics", async () => {
      await open(page, "/analytics", ".an-page, .ins-page");
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await snap(page, "analytics", "The Analytics page, top of the page");
    });
    await attempt("projects", async () => {
      const key = String((await get(`/api/units/${p.unit}`)).body?.recipe?.repo ?? "").replace("https://github.com/", "");
      await open(page, `/projects/${key}`, ".panel");
      await page.waitForTimeout(2000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await snap(page, "project", "A project page: one repository's metrics over generations");
    });
    await attempt("generations", async () => {
      await open(page, "/generations", "table");
      await page.waitForTimeout(1500);
      await snap(page, "generations", "The Generations page: every accepted change");
    });
    await attempt("explorer", async () => {
      await open(page, "/", "main");
      await page.waitForTimeout(3000);
      await snap(page, "explorer", "The Explorer: every listed coin and what its agent is building");
    });
    // a live desktop, only when an agent is working now; otherwise the idle state, labelled as such
    await attempt("live desktop", async () => {
      const tokens = (await get("/market/tokens?limit=200")).body.tokens as any[];
      const playingNow = () => page.evaluate(() => [...document.querySelectorAll("video")].some((v) => v.readyState >= 2 && v.currentTime > 0.5));
      const show = async (mint: string, waitMs: number) => {
        await open(page, `/tokens/${mint}`, "main");
        // the coin page shows the price chart first; the agent's desktop is behind its Computer tab
        const tab = page.getByRole("button", { name: "Computer", exact: true }).or(page.getByRole("tab", { name: "Computer", exact: true })).first();
        if (await tab.count()) await tab.click().catch(() => undefined);
        if (waitMs) await page.waitForFunction(() => [...document.querySelectorAll("video")].some((v) => v.readyState >= 2 && v.currentTime > 0.5), null, { timeout: waitMs }).catch(() => undefined);
        await page.waitForTimeout(2500);
        await page.evaluate(() => window.scrollTo(0, 0));
        return playingNow();
      };
      // every listed agent with a live desktop session gets a try (a desktop's encoder takes a while to start)
      let playing = false;
      for (let round = 0; round < 3 && !playing; round++) {
        const live = ((await get("/api/sessions?state=live")).body as any[]).filter((s) => s.desktop && tokens.some((t) => t.agent === s.agent));
        for (const s of live) if ((playing = await show(tokens.find((t) => t.agent === s.agent).mint, 90_000))) break;
        if (!live.length) await sleep(20_000);
      }
      if (!playing) await show(p.mint, 0);
      await snap(page, "coin-page", playing ? "A coin page while its agent works: the live desktop on the Computer tab" : "A coin page between sessions: the Computer tab says why there is no video");
    });
    await attempt("agent profile", async () => {
      await open(page, `/agents/${p.agent}/profile`, "main");
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await snap(page, "agent-profile", "An agent's profile");
    });
    await ctx.close();
  }
  await browser.close();
  if (blocked.length) console.log(`  write guard aborted ${blocked.length} request(s): ${[...new Set(blocked)].join(", ")}`);
  save("shots.json", { site: SITE, note: "Headless Chromium, light theme, a mock wallet that refuses every transaction. Regenerate with bun scripts/docs/capture.ts shots.", shots: manifest });
}

if (import.meta.main) {
  console.log(`capturing from ${SITE}: ${parts.length ? parts.join(", ") : "api, verify, shots"}`);
  const p = await picks();
  if (want("verify")) await captureVerify(p);
  if (want("api")) await captureApi(p);
  if (want("shots")) await captureShots(p);
}
