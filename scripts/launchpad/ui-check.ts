#!/usr/bin/env bun
// Headless check of the launchpad pages (plan L3 exit, updated for APP-CONSOLIDATION.md amendment
// 2026-10-10 (2)): the Explorer at / (the token list; /tokens redirects there) and /tokens/:mint at
// 1280 and 390 px, light and dark, against a running dashboard (apps/web/server.ts) and market
// indexer, or the deployed site for both. A token shows only price, market cap, 24h volume, 24h change
// and what its agent is building; no fee figure, fee split or compute vault shows anywhere. Checks no
// horizontal page scroll, no console errors, no monospace text, the live panel mounted in agent mode,
// and that every figure on the page equals the indexer's JSON formatted with the page's own
// formatters (apps/web/src/market.ts). Sends nothing to chain.
//
// playwright-core is not a repo dependency: pass its location.
// Usage: bun scripts/launchpad/ui-check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9663
//        [--market http://127.0.0.1:9668] [--core http://127.0.0.1:9662] [--mints <mint>,<mint>] [--shots <dir>]
// Against the site: --web https://<site> --market https://<site>
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fmtAmount, fmtChange, fmtInt, fmtPrice, fmtProgress } from "../../apps/web/src/market.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const WEB = arg("web", "http://127.0.0.1:9663")!.replace(/\/+$/, "");
const MARKET = arg("market", "http://127.0.0.1:9668")!.replace(/\/+$/, "");
const CORE = arg("core")?.replace(/\/+$/, "");
const SHOTS = arg("shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const GRADUATED = "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz";

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
/** GET JSON; a transient 502/503/504 from the site's gateway is retried a few times */
const j = async (u: string): Promise<any> => {
  for (let i = 0; ; i++) {
    const r = await fetch(u);
    if (r.ok) return r.json();
    if (i >= 3 || ![502, 503, 504].includes(r.status)) throw new Error(`${u}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
};

// a listed curve-phase token with trades (the most traded one) and the graduated one, unless --mints names them
const list = (await j(`${MARKET}/market/tokens?sort=volume`)).tokens as any[];
const curve = [...list].filter((t) => t.phase === "curve").sort((a, b) => b.trades - a.trades)[0];
const MINTS = arg("mints")?.split(",") ?? [GRADUATED, curve?.mint].filter(Boolean);

// the token parameters, in the order every card and the token page show them
const PARAM_LABELS = ["Price", "Market cap", "24h volume", "24h change"];
const params = (t: any) => [fmtPrice(t.price), fmtAmount(t.market_cap), fmtAmount(t.volume_24h), fmtChange(t.change_24h)];
/** Fee wording in an element's visible text, with the live panel, commits, trade rows and agents' own feed posts left out (an agent writes what it likes, e.g. "1% of treasury" for its trading budget). */
const feeText = (page: any, scope: string) =>
  page.evaluate((sc: string) => {
    const root = document.querySelector(sc);
    if (!root) return `no ${sc} element`;
    const c = root.cloneNode(true) as HTMLElement;
    for (const x of c.querySelectorAll(".lp, #mk-live, #mk-commits, #mk-trades, .ex-screen, .fd, script, style")) x.remove();
    const m = (c.textContent ?? "").match(/[^.]{0,40}\b(fees?|fee split|fees to compute|compute vault|treasury|cranks?)\b[^.]{0,40}/i);
    return m ? m[0].replace(/\s+/g, " ").trim() : null;
  }, scope);

// figures the page marks with data-f, and how the page formats each
const F: Record<string, (t: any) => string> = {
  price: (t) => fmtPrice(t.price),
  market_cap: (t) => fmtAmount(t.market_cap),
  volume_24h: (t) => fmtAmount(t.volume_24h),
  change_24h: (t) => fmtChange(t.change_24h),
  curve_progress: (t) => fmtProgress(t.curve_progress),
  holders: (t) => (t.holders === null ? "TBA" : fmtInt(t.holders)),
  supply: (t) => fmtAmount(t.supply),
  trades_24h: (t) => fmtInt(t.trades_24h),
  trades: (t) => fmtInt(t.trades),
  quote_reserve: (t) => fmtAmount(t.quote_reserve),
  migration_threshold: (t) => fmtAmount(t.migration_threshold),
};
/** data-f fields that must never show (fee and compute vault figures were removed from the UI) */
const GONE = /^(fees_|compute_|vault_|cranks)/;

const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await chromium.launch(existsSync(exe) ? { executablePath: exe } : {});

async function open(path: string, width: number, scheme: "light" | "dark") {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("response", (r: any) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(`${WEB}${path}`, { waitUntil: "networkidle" });
  return { ctx, page, errors };
}

async function layout(page: any, label: string, errors: string[]) {
  const m = await page.evaluate(() => {
    const d = document.documentElement;
    const mono: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!(el as HTMLElement).innerText?.trim() || el.children.length) continue;
      const f = getComputedStyle(el).fontFamily.toLowerCase();
      if (/mono|courier|consolas|menlo/.test(f)) mono.push(`${el.tagName}.${(el as HTMLElement).className}`);
    }
    return { sw: d.scrollWidth, cw: d.clientWidth, bw: document.body.scrollWidth, mono: mono.slice(0, 5) };
  });
  check(`${label}: no horizontal page scroll`, m.sw <= m.cw && m.bw <= m.cw, `scrollWidth ${m.sw}, body ${m.bw}, viewport ${m.cw}`);
  check(`${label}: no monospace text`, m.mono.length === 0, m.mono.join(", "));
  check(`${label}: no console errors or failed requests`, errors.length === 0, errors.slice(0, 4).join(" | "));
}

/** Compares every [data-f] figure inside `scope` with the indexer's object formatted the same way. Retries once (the indexer moves on). */
async function figures(page: any, scope: string, fetchT: () => Promise<any>, label: string) {
  let bad: string[] = [];
  let n = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await fetchT();
    const shown = (await page.$$eval(`${scope} [data-f]`, (els: Element[]) => els.map((e) => [(e as HTMLElement).dataset.f!, (e as HTMLElement).innerText.trim()]))) as [string, string][];
    n = shown.length;
    bad = [
      ...shown.filter(([f]) => GONE.test(f)).map(([f, txt]) => `${f} shown (${txt}), fee figures are removed`),
      ...shown.filter(([f, txt]) => F[f] && F[f]!(t) !== txt).map(([f, txt]) => `${f}: page ${txt}, indexer ${F[f]!(t)}`),
    ];
    if (!bad.length) break;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
  }
  check(`${label}: ${n} figures equal the indexer's`, n > 0 && bad.length === 0, bad.slice(0, 4).join("; "));
}

try {
  for (const width of [1280, 390]) {
    for (const scheme of ["light", "dark"] as const) {
      // ---------------------------------------------------------------- list (the Explorer at /)
      {
        const { ctx, page, errors } = await open("/", width, scheme);
        await page.locator(".ex-card[data-mint]").first().waitFor({ timeout: 30_000 });
        const label = `/ ${width} ${scheme}`;
        const cards = await page.locator(".ex-card[data-mint]").count();
        const idx = (await j(`${MARKET}/market/tokens?sort=market_cap&limit=24`)).tokens as any[];
        check(`${label}: one card per listed token`, cards === idx.length, `${cards} cards, ${idx.length} tokens`);
        if (scheme === "light") {
          for (const sort of ["newest", "volume", "change", "market_cap"]) {
            await page.click(`[data-ex-sort="${sort}"]`);
            await page.waitForTimeout(1200);
            const order = (await page.$$eval(".ex-card[data-mint]", (els: Element[]) => els.map((e) => (e as HTMLElement).dataset.mint))) as string[];
            const want = ((await j(`${MARKET}/market/tokens?sort=${sort}&limit=24`)).tokens as any[]).map((t) => t.mint);
            check(`${label}: sorted by ${sort} as the indexer sorts`, JSON.stringify(order) === JSON.stringify(want), order.slice(0, 3).map((m) => m.slice(0, 6)).join(","));
          }
        }
        // every card: the four figures in order, equal to the indexer's, and what the agent is building
        let bad: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          const rows = (await j(`${MARKET}/market/tokens?sort=market_cap&limit=24`)).tokens as any[];
          const shown = (await page.$$eval(".ex-card[data-mint]", (els: Element[]) =>
            els.map((e) => ({
              mint: (e as HTMLElement).dataset.mint!,
              cells: [...e.querySelectorAll(".bd-params > div")].map((d) => [d.querySelector("span")!.textContent!.trim(), d.querySelector("b")!.textContent!.trim()]),
              building: e.querySelectorAll(".bd-building").length,
            })),
          )) as { mint: string; cells: string[][]; building: number }[];
          bad = shown.flatMap((c) => {
            const t = rows.find((x) => x.mint === c.mint);
            if (!t) return [`${c.mint.slice(0, 6)}: not in the indexer's list`];
            const out: string[] = [];
            if (JSON.stringify(c.cells.map((x) => x[0])) !== JSON.stringify(PARAM_LABELS)) out.push(`${c.mint.slice(0, 6)} labels ${c.cells.map((x) => x[0]).join("|")}`);
            if (JSON.stringify(c.cells.map((x) => x[1])) !== JSON.stringify(params(t))) out.push(`${c.mint.slice(0, 6)} page ${c.cells.map((x) => x[1]).join("|")} indexer ${params(t).join("|")}`);
            if (c.building !== 1) out.push(`${c.mint.slice(0, 6)} has ${c.building} building lines`);
            return out;
          });
          if (!bad.length) break;
          await page.reload({ waitUntil: "networkidle" });
          await page.locator(".ex-card[data-mint]").first().waitFor({ timeout: 30_000 });
        }
        check(`${label}: cards show only price, market cap, 24h volume, 24h change and what the agent is building, equal to the indexer's`, bad.length === 0, bad.slice(0, 3).join("; "));
        const fee = await feeText(page, "main");
        check(`${label}: no fee figure, fee split or compute vault`, fee === null, fee ?? "");
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `explorer-${width}-${scheme}.png`), fullPage: true });
        await layout(page, label, errors);
        await ctx.close();
      }
      // ---------------------------------------------------------------- token pages
      for (const mint of MINTS) {
        const { ctx, page, errors } = await open(`/tokens/${mint}`, width, scheme);
        const label = `/tokens/${mint.slice(0, 6)} ${width} ${scheme}`;
        await page.locator("#mk-stats .stat").first().waitFor({ timeout: 30_000 });
        await page.locator(".mk-tb").waitFor({ timeout: 30_000 });
        await page.waitForFunction(() => {
          const s = document.querySelector(".lp-state span")?.textContent ?? "";
          return s && s !== "Loading";
        }, null, { timeout: 30_000 });
        await page.waitForTimeout(1200);
        const t = await j(`${MARKET}/market/tokens/${mint}`);
        await figures(page, "main", () => j(`${MARKET}/market/tokens/${mint}`), label);
        // the token parameters: four figures in order, then what the agent is building
        const labels = (await page.$$eval("#mk-stats .stat .eyebrow", (els: Element[]) => els.map((e) => e.textContent!.trim()))) as string[];
        check(`${label}: stats are price, market cap, 24h volume, 24h change`, JSON.stringify(labels) === JSON.stringify(PARAM_LABELS), labels.join("|"));
        check(`${label}: says what the agent is building`, (await page.locator("#mk-building .bd-building").count()) === 1);
        check(`${label}: no fee history, fee panel or compute vault`, (await page.locator("#mk-feehist, #mk-fees, [data-f^=fees_], [data-f^=compute_]").count()) === 0);
        const fee = await feeText(page, "main");
        check(`${label}: no fee wording outside the agent's own session`, fee === null, fee ?? "");
        // phase and venue
        const phase = await page.locator("#mk-phase [data-phase]").getAttribute("data-phase");
        check(`${label}: phase shown as the indexer's`, phase === (t.phase === "graduated" ? "graduated" : t.migrated ? "migrated" : "curve"), `${phase} vs ${t.phase}`);
        const venue = await page.locator(".mk-tb-venue").innerText();
        check(`${label}: trade box venue read from chain`, t.phase === "graduated" ? /DAMM v2/.test(venue) : /DBC curve/.test(venue), venue.replace(/\s+/g, " "));
        // trades and holders against the indexer
        const tr = (await j(`${MARKET}/market/tokens/${mint}/trades?limit=25`)).trades as any[];
        const shownSigs = (await page.$$eval("#mk-trades tr[data-sig]", (els: Element[]) => els.map((e) => (e as HTMLElement).dataset.sig))) as string[];
        check(`${label}: recent trades are the indexer's`, JSON.stringify(shownSigs) === JSON.stringify(tr.map((x) => x.signature)), `${shownSigs.length} rows, ${tr.length} indexed`);
        const firstRow = tr[0] ? ((await page.locator("#mk-trades tr[data-sig]").first().textContent()) ?? "").replace(/\s+/g, " ") : "";
        if (tr[0]) check(`${label}: first trade amounts`, firstRow.includes(fmtAmount(tr[0].base_amount)) && firstRow.includes(fmtAmount(tr[0].quote_amount)) && firstRow.includes(fmtPrice(tr[0].price)), firstRow);
        const hold = (await j(`${MARKET}/market/tokens/${mint}/holders?limit=20`)).top as any[];
        const owners = (await page.$$eval("#mk-holders tr[data-owner]", (els: Element[]) => els.map((e) => (e as HTMLElement).dataset.owner))) as string[];
        check(`${label}: holders are the indexer's`, JSON.stringify(owners) === JSON.stringify(hold.map((x) => x.owner)), `${owners.length} holders`);
        // chart
        const candles = await page.locator("#mk-chart svg .c").count();
        check(`${label}: price chart draws the indexer's candles`, t.trades === 0 ? (await page.locator("#mk-chart .mk-chart-empty").count()) === 1 : candles > 0, `${candles} candles`);
        // live panel in agent mode
        const lp = await page.evaluate(() => ({
          state: document.querySelector(".lp-state")?.getAttribute("data-s"),
          text: document.querySelector(".lp-state span")?.textContent,
          list: [...document.querySelectorAll(".lp-list [data-sess]")].map((b) => (b as HTMLElement).dataset.sess),
          current: document.querySelector(".lp-list [aria-current=true]")?.getAttribute("data-sess") ?? null,
          msg: (document.querySelector(".lp-msg:not([hidden])") as HTMLElement | null)?.innerText ?? null,
        }));
        if (CORE) {
          const sess = (await j(`${CORE}/v1/sessions?agent=${t.agent}&limit=12`)) as any[];
          if (sess.length) {
            const want = sess.find((s) => s.state === "live") ?? sess[0];
            check(`${label}: live panel (agent mode) shows the agent's ${want.state === "live" ? "live" : "latest"} session, earlier ones listed`, lp.list.length === sess.length && lp.list.every((x: string) => sess.some((s) => s.session_id === x)) && !!lp.current && sess.some((s) => s.session_id === lp.current), `${lp.text}, ${lp.list.length} listed, current ${lp.current?.slice(0, 8)}, Core newest ${want.session_id.slice(0, 8)}`);
          } else check(`${label}: live panel (agent mode) says the agent has no session yet`, /no authoring session yet/i.test(lp.msg ?? ""), lp.msg ?? "");
        } else check(`${label}: live panel mounted`, !!lp.state, `${lp.state} ${lp.text}`);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `token-${mint.slice(0, 6)}-${width}-${scheme}.png`), fullPage: true });
        await layout(page, label, errors);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed`);
writeFileSync(join(import.meta.dir, "UI-CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), web: WEB, market: MARKET, mints: MINTS, pass, total: results.length, results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
