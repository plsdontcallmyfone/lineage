#!/usr/bin/env bun
// Headless UI check of the social pages (plan PANEL-SOCIAL-PROVIDERS L, F, S) against a running
// dashboard (scripts/social/local-run.ts --keep): /leaderboard, /feed, /following, an agent profile,
// a session page with its feed panel, and <lineage-leaderboard> / <lineage-feed> on a page of another
// origin, at 1280 and 390 px, light and dark. Checks: no horizontal scroll, no console errors, no
// monospace, figures equal Core's, the generated pattern when there is no avatar and the signed
// upload when there is, and a follow and a reaction signed by a test wallet (Wallet Standard,
// WebCrypto Ed25519) through the page. Headless Chromium only; screenshots go to --shots.
//
//   bun scripts/social/ui-check.ts --pw <dir with node_modules/playwright-core> [--exe <chromium>]
//     --web http://127.0.0.1:9665 --core http://127.0.0.1:9664 --agent <A> --other <B> [--shots <dir>] [--embed-port 9666]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d?: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const PW = arg("pw");
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required");
const WEB = arg("web", "http://127.0.0.1:9665")!;
const CORE = arg("core", "http://127.0.0.1:9664")!;
const A = arg("agent")!;
const B = arg("other")!;
const SHOTS = arg("shots", "/tmp/lineage-social-shots")!;
const EMBED_PORT = Number(arg("embed-port", "9666"));
mkdirSync(SHOTS, { recursive: true });
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const core = async (p: string) => (await fetch(`${CORE}/v1/${p}`)).json() as Promise<any>;

// The kit reads Core directly here (Core answers CORS *); on the site the gate adds CORS to /api.
// a Wallet Standard wallet backed by a WebCrypto Ed25519 key, registered before the app loads
const FAKE_WALLET = `(() => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let o = ""; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const b of bytes) { if (b) break; o = "1" + o; } return o; };
  let kp = null, account = null;
  const ready = crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]).then(async (k) => {
    kp = k; const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
    account = { address: b58(pub), publicKey: pub, chains: ["solana:devnet"], features: ["solana:signMessage"] };
    window.__testWallet = account.address;
  });
  const wallet = { version: "1.0.0", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", chains: ["solana:devnet"], get accounts() { return account ? [account] : []; },
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => { await ready; return { accounts: [account] }; } },
      "solana:signTransaction": { version: "1.0.0", signTransaction: async () => { throw new Error("not in this test"); } },
      "solana:signMessage": { version: "1.0.0", signMessage: async ({ message }) => { await ready; return [{ signedMessage: message, signature: new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, message)) }]; } },
    } };
  const reg = (api) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => reg(e.detail));
  try { window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: reg })); } catch {}
})();`;

const embedHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>embed</title>
<style>body{margin:0;padding:16px;font-family:system-ui;background:#f4f2ee}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}</style></head>
<body><div class="g"><lineage-leaderboard limit="5" title="Top agents"></lineage-leaderboard><lineage-feed limit="8"></lineage-feed></div>
<script src="${WEB}/embed/lineage-embed.js" data-core="${CORE}/v1" data-events="${CORE}/v1/events" data-site="${WEB}"></script></body></html>`;
const embedSrv = Bun.serve({ port: EMBED_PORT, hostname: "127.0.0.1", fetch: () => new Response(embedHtml, { headers: { "content-type": "text/html" } }) });

const browser = await chromium.launch({ executablePath: arg("exe"), headless: true });
async function open(width: number, dark: boolean) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1, colorScheme: dark ? "dark" : "light" });
  await ctx.addInitScript(FAKE_WALLET);
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
  p.on("response", (r: any) => r.status() === 503 && /\/file\?/.test(r.url()) && errors.push("status of 503 (tree file)"));
  p.on("pageerror", (e: Error) => errors.push(String(e)));
  return { ctx, p, errors };
}
async function common(p: any, errors: string[], label: string) {
  const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${label}: no horizontal scroll`, sw <= 0, `overflow ${sw}px`);
  const mono = await p.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.childElementCount === 0 && (e.textContent ?? "").trim() && /mono|courier|menlo|consolas/i.test(getComputedStyle(e).fontFamily)).map((e) => e.tagName).slice(0, 5));
  check(`${label}: no monospace`, mono.length === 0, mono.join(","));
  check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
}

const lb = await core("leaderboard");
const prof = await core(`agents/${A}/profile`);
const sessions = await core(`sessions?agent=${A}&limit=1`);
const sess = (Array.isArray(sessions) ? sessions : sessions.sessions ?? [])[0];

for (const width of [1280, 390])
  for (const dark of [false, true]) {
    const tag = `${width}${dark ? "-dark" : ""}`;
    // leaderboard
    {
      const { ctx, p, errors } = await open(width, dark);
      await p.goto(`${WEB}/leaderboard`, { waitUntil: "load" });
      await p.waitForSelector("table.lb");
      const first = await p.$eval("table.lb tbody tr td:nth-child(2) b", (e: Element) => e.textContent);
      check(`leaderboard ${tag}: first row is Core's first`, first === (lb.agents[0].name ?? lb.agents[0].agent.slice(0, 4)), `${first}`);
      const acc = await p.$eval("table.lb tbody tr td:nth-child(5)", (e: Element) => (e.textContent ?? "").trim().split(/\s/)[0]);
      check(`leaderboard ${tag}: accepted equals Core`, Number(acc) === lb.agents[0].accepted, `${acc}`);
      if (width === 1280 && !dark) {
        await p.click('a.seg-b[href*="sort=followers"]');
        await p.waitForFunction(() => location.search.includes("sort=followers"));
        await p.waitForTimeout(600);
        const top = await p.$eval("table.lb tbody tr td:nth-child(2) a", (e: Element) => e.getAttribute("href"));
        check("leaderboard: sort by followers re-renders in place", top === `/agents/${A}/profile`, `${top}`);
      }
      await p.screenshot({ path: join(SHOTS, `leaderboard-${tag}.png`), fullPage: true });
      await common(p, errors, `leaderboard ${tag}`);
      await ctx.close();
    }
    // feed
    {
      const { ctx, p, errors } = await open(width, dark);
      await p.goto(`${WEB}/feed`, { waitUntil: "load" });
      await p.waitForSelector(".fd");
      const n = await p.$$eval(".fd", (x: Element[]) => x.length);
      const api = await core("feed?kinds=post,intent,generation&limit=80");
      check(`feed ${tag}: items equal Core's`, n === api.items.length, `${n} vs ${api.items.length}`);
      await p.screenshot({ path: join(SHOTS, `feed-${tag}.png`), fullPage: false });
      await common(p, errors, `feed ${tag}`);
      await ctx.close();
    }
    // profile (+ follow and react through the page with the test wallet)
    {
      const { ctx, p, errors } = await open(width, dark);
      await p.goto(`${WEB}/agents/${A}/profile`, { waitUntil: "load" });
      await p.waitForSelector(".pf-head");
      const src = await p.$eval(".pf-av", (e: HTMLImageElement) => e.getAttribute("src"));
      check(`profile ${tag}: avatar is the signed upload`, src === `/api/media/${prof.media.avatar.sha256}`, `${src?.slice(0, 40)}`);
      const loaded = await p.$eval(".pf-av", (e: HTMLImageElement) => e.complete && e.naturalWidth > 0);
      check(`profile ${tag}: avatar image renders`, loaded);
      const fc = await p.$eval(".pf-fc b", (e: Element) => Number(e.textContent));
      const now = await core(`agents/${A}/followers`);
      check(`profile ${tag}: followers equal Core`, fc === now.followers, `${fc}`);
      if (width === 1280 && !dark) {
        await p.click("[data-pf-follow]");
        await p.waitForFunction((n: number) => Number(document.querySelector(".pf-fc b")?.textContent) === n + 1, fc, { timeout: 10_000 });
        const after = await core(`agents/${A}/followers`);
        check("profile: a follow signed by the test wallet through the page reaches Core", after.followers === fc + 1, `${after.followers}`);
        const bar = await p.$(".fd-post .rx");
        if (bar) {
          const before = Number(await p.$eval('.fd-post .rx [data-rx="insight"] .num', (e: Element) => e.textContent));
          await p.click('.fd-post .rx [data-rx="insight"]');
          await p.waitForFunction((b: number) => Number(document.querySelector('.fd-post .rx [data-rx="insight"] .num')?.textContent) === b + 1, before, { timeout: 10_000 });
          check("profile: a reaction signed through the page is counted", true, `${before} -> ${before + 1}`);
        } else check("profile: a reaction signed through the page is counted", false, "no post on the profile");
      }
      await p.screenshot({ path: join(SHOTS, `profile-${tag}.png`), fullPage: true });
      await common(p, errors, `profile ${tag}`);
      await ctx.close();
    }
    // a profile without media: the generated pattern
    if (!dark) {
      const { ctx, p, errors } = await open(width, dark);
      await p.goto(`${WEB}/agents/${B}/profile`, { waitUntil: "load" });
      await p.waitForSelector(".pf-head");
      const src = await p.$eval(".pf-av", (e: HTMLImageElement) => e.getAttribute("src") ?? "");
      check(`profile without media ${tag}: generated pattern`, src.startsWith("data:image/svg+xml"), src.slice(0, 30));
      await p.screenshot({ path: join(SHOTS, `profile-b-${tag}.png`), fullPage: false });
      await common(p, errors, `profile b ${tag}`);
      await ctx.close();
    }
    // session page with the lineage chat next to the live panel
    if (sess && !dark) {
      const { ctx, p, errors } = await open(width, dark);
      await p.goto(`${WEB}/sessions/${sess.session_id}`, { waitUntil: "load" });
      await p.waitForSelector("#session-feed .fd", { timeout: 15_000 });
      check(`session ${tag}: lineage chat panel next to the live panel`, true);
      await p.screenshot({ path: join(SHOTS, `session-${tag}.png`), fullPage: false });
      // the run's Core starts with --no-trees, so the live panel's file read answers 503 (not a social page error)
      await common(p, errors.filter((e) => !/favicon|status of 503/.test(e)), `session ${tag}`);
      await ctx.close();
    }
    // embed elements on another origin
    if (!dark) {
      const { ctx, p, errors } = await open(width, dark);
      await p.goto(`http://127.0.0.1:${EMBED_PORT}/`, { waitUntil: "load" });
      await p.waitForFunction(() => (document.querySelector("lineage-leaderboard") as any)?.shadowRoot?.querySelector(".row") && (document.querySelector("lineage-feed") as any)?.shadowRoot?.querySelector(".it"), undefined, { timeout: 15_000 });
      const rows = await p.evaluate(() => (document.querySelector("lineage-leaderboard") as any).shadowRoot.querySelectorAll(".row").length);
      check(`embed ${tag}: <lineage-leaderboard> rows from Core`, rows === Math.min(5, lb.agents.length), `${rows}`);
      await p.screenshot({ path: join(SHOTS, `embed-${tag}.png`), fullPage: true });
      await common(p, errors, `embed ${tag}`);
      await ctx.close();
    }
  }

// following page for the test wallet's address is per context; check a wallet from the run instead
{
  const lb2 = await core(`agents/${A}/followers`);
  const w = lb2.recent[0]?.wallet;
  const { ctx, p, errors } = await open(1280, false);
  await p.goto(`${WEB}/following?wallet=${w}`, { waitUntil: "load" });
  await p.waitForSelector(".fd");
  check("following: posts and generations of followed agents", (await p.$$eval(".fd", (x: Element[]) => x.length)) > 0);
  await p.screenshot({ path: join(SHOTS, "following-1280.png"), fullPage: false });
  await common(p, errors, "following 1280");
  await ctx.close();
}

await browser.close();
embedSrv.stop(true);
const failed = results.filter((r) => !r.ok);
writeFileSync(join(import.meta.dir, "UI-CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
