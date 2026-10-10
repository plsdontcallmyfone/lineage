#!/usr/bin/env bun
// Headless checks of the consolidated app (docs/plans/APP-CONSOLIDATION.md) and a real devnet launch
// through /launch. chromium-headless-shell via playwright-core from a scratch directory (never a repo
// dependency, never the owner's browser, no visible window).
//
//   --phase ui      at 1280 and 390 px, light and dark: the header (amendment 2026-10-10 (2): Explorer,
//                   Agents, Launch; Eco page; profile icon after connect), Explorer cards with only
//                   price, market cap, 24h volume, 24h change and what the agent is building, the
//                   Agents directory and the Eco page without hidden launches, a hidden token marked,
//                   no fee displays,
//                   every Launch step (with a mock Wallet Standard wallet; the soul draft is answered
//                   locally with a real soul document so no model is paid for), Profile connected and
//                   disconnected, a token page's Commits panel, the docs; no console errors, no
//                   horizontal scroll; removed routes redirect
//   --phase launch  a real devnet launch through /launch: a fresh test wallet funded by the Lineage
//                   deployer (SOL, key passed explicitly) and the faucet key (tLINE), the soul drafted
//                   by the site's drafter, the wizard's Launch button, the hosted bind, then the live
//                   status list; transactions are logged to apps/web/scripts/APP-LAUNCH-LAST.json
//
// The page under test is a dashboard server built from this tree, run against the deployed site's
// Core, market indexer, identity service, runtime and soul drafter:
//   bun apps/web/server.ts --port 9662 --core <site> --market <site> --upstream <site>
//
// Usage: bun apps/web/scripts/app-check.ts --pw <dir with node_modules/playwright-core> [--base http://127.0.0.1:9662]
//          [--phase ui|launch] [--shots <dir>] [--repo https://github.com/...]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, ChainReader, launchPdas, registryPdas, loadKeypair, loadOrCreateKeypair, Rpc, sendAndConfirm, signBytes, system, token, TOKEN_2022_PROGRAM } from "@lineage/chain";
import { assertDevnet } from "../../../packages/chain/src/browser/client.ts";
import { decodeMessage, parseWire, placeSignature } from "../../../packages/chain/src/browser/wire.ts";
import { devnetRpcUrl } from "../../../packages/chain/src/endpoint.ts";
import { newSoul } from "../../../packages/souls/src/schema.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
const BASE = arg("base", "http://127.0.0.1:9662")!.replace(/\/+$/, "");
const PHASE = arg("phase", "ui")!;
const SHOTS = arg("shots");
const ROOT = join(import.meta.dir, "../../..");
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const T0 = Date.now();
const log = (m: string) => console.log(`[app-check ${PHASE} +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  return ok;
};

// Wick Radix: a live agent with a real Verified commit (agwyus9p/base58), for the Commits panel
const WICK = { agent: "5iCWSoXAsvhdDiwsexnuAXU3RcNXgbXw7TzuRZH2LYoA", mint: "A8YeMNZuSfKZZpgMpj8sYwmsHpDsm5CkjTYp966mpsFS" };

const state = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
await assertDevnet(rpc);
const reader = new ChainReader(rpc);
const T22 = TOKEN_2022_PROGRAM;
const LINE = state.line_mint as string;
const DEC = Number(state.line_decimals);

// ---------------------------------------------------------------- browser with a mock Wallet Standard wallet

async function browser(wallet: ReturnType<typeof loadKeypair> | null) {
  if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
  const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
  const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  const b = await chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
  const signed: string[] = [];
  const context = async (o: { width: number; dark: boolean }) => {
    const ctx = await b.newContext({ viewport: { width: o.width, height: o.width < 600 ? 844 : 900 }, colorScheme: o.dark ? "dark" : "light", deviceScaleFactor: 1 });
    await ctx.addInitScript((dark: boolean) => {
      try {
        localStorage.setItem("lineage-theme", dark ? "dark" : "light");
      } catch {}
    }, o.dark);
    if (wallet) {
      await ctx.exposeFunction("__lineageMockSign", (b64: string) => {
        const wire = new Uint8Array(Buffer.from(b64, "base64"));
        const { message } = parseWire(wire);
        const d = decodeMessage(message);
        signed.push(`${d.version}:${d.instructions.map((i) => i.programId.slice(0, 6)).join(",")}`);
        return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, message))).toString("base64");
      });
      await ctx.exposeFunction("__lineageMockSignMsg", (b64: string) => Buffer.from(signBytes(wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64"));
      await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
        const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
        const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"], label: "test" };
        const w = {
          version: "1.0.0",
          name: "Lineage Test Wallet",
          icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
          chains: ["solana:devnet"],
          accounts: [] as unknown[],
          features: {
            "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
            "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
            "standard:events": { version: "1.0.0", on: () => () => {} },
            "solana:signTransaction": {
              version: "1.0.0",
              supportedTransactionVersions: ["legacy", 0],
              signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
                Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await (window as any).__lineageMockSign(b64(i.transaction))) }))),
            },
            "solana:signMessage": {
              version: "1.0.0",
              signMessage: async (...inputs: { message: Uint8Array }[]) =>
                Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__lineageMockSignMsg(b64(i.message))) }))),
            },
          },
        };
        window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
        window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
      }, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
    }
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m: any) => m.type() === "error" && errors.push(`console: ${m.text()} ${m.location()?.url ?? ""}`));
    return { ctx, page, errors };
  };
  return { b, context, signed };
}

const shot = async (page: any, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};
const noHScroll = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ---------------------------------------------------------------- ui

async function phaseUi() {
  // the wizard test wallet: it launched TLAMP (phase launch) and still holds tLINE for a review
  const wallet = loadKeypair(join(KEYS, "app-launch-test.json"));
  const persona = JSON.parse(readFileSync(join(ROOT, "scripts/launch-e2e/STATE.json"), "utf8")).soul_core.doc.persona;
  const { b, context } = await browser(wallet);
  // the hidden list (Core GET /v1/hidden through the app's /api): listings must leave these out
  const hid = (await fetch(`${BASE}/api/hidden`).then((r) => r.json()).catch(() => ({ hidden: [] }))).hidden as { mint: string; agent: string | null }[];
  const hiddenMints = new Set(hid.map((h) => h.mint));
  const hiddenAgents = new Set(hid.map((h) => h.agent).filter(Boolean) as string[]);
  const hiddenSample = hid[0]?.mint ?? null;
  log(`hidden list: ${hid.length} launches`);
  try {
    for (const width of [1280, 390]) {
      for (const dark of [false, true]) {
        const tag = `${width}-${dark ? "dark" : "light"}`;
        // the deployed site's gate allows 120 Core reads a minute per address: let the bucket refill between passes
        if (results.length) await new Promise((r) => setTimeout(r, 45_000));
        const { ctx, page, errors } = await context({ width, dark });
        // the soul draft is answered here with a real soul document (no model spend in UI checks)
        await page.route("**/souls/draft", async (route: any) => {
          const body = JSON.parse(route.request().postData() ?? "{}");
          const doc = newSoul({ agent: body.agent, seed: body.seed, persona, created_at: Math.floor(Date.now() / 1000), origin: { by: "model", model: "ui-check (a stored soul, no model call)" } as any });
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc, usd: 0 }) });
        });

        // Explorer and the header
        await page.goto(`${BASE}/`);
        await page.locator(".ex-card, .ex-empty").first().waitFor({ timeout: 60_000 });
        const nav = (await page.locator(".nav a").allInnerTexts()).map((s: string) => s.trim().toLowerCase());
        check(`${tag} header: Explorer, Agents, Launch; Eco, Connect, theme`, nav.join(",") === "explorer,agents,launch" && (await page.locator("a#eco-open[href='/eco']").isVisible()) && (await page.locator("#cn-btn").isVisible()) && (await page.locator("#theme").isVisible()), nav.join(","));
        check(`${tag} explorer is the home at /`, (await page.locator(".nav a[aria-current=page]").innerText()).trim().toLowerCase() === "explorer");
        const card0 = (await page.locator(".ex-card").first().innerText()).replace(/\s+/g, " ");
        const labels = (await page.locator(".ex-card").first().locator(".bd-params > div > span").allInnerTexts()).map((x: string) => x.trim().toLowerCase());
        check(`${tag} explorer card: price, market cap, 24h volume, 24h change and what it is building`, labels.join(",") === "price,market cap,24h volume,24h change" && (await page.locator(".ex-card").first().locator(".bd-building").count()) === 1, `${labels.join(",")} | ${card0.slice(0, 200)}`);
        const exText = (await page.locator(".ex-grid").innerText()).toLowerCase();
        check(`${tag} explorer: no fee, model TBA or verified-count rows`, !/fee|model tba|\d+ verified/.test(exText), exText.match(/.{0,40}(fee|model tba|\d+ verified).{0,40}/)?.[0] ?? "");
        const exMints = await page.locator(".ex-card").evaluateAll((els: Element[]) => els.map((e) => (e as HTMLElement).dataset.mint));
        check(`${tag} explorer: hidden launches left out`, exMints.length > 0 && !exMints.some((m: string) => hiddenMints.has(m)), `${exMints.length} cards`);
        check(`${tag} explorer: no horizontal scroll`, await noHScroll(page));
        await shot(page, `${tag}-explorer`);

        // Agents
        await page.click('.nav a[href="/agents"]');
        await page.locator(".ag-card, .empty").first().waitFor({ timeout: 60_000 });
        const agIds = await page.locator(".ag-card").evaluateAll((els: Element[]) => els.map((e) => (e as HTMLElement).dataset.agent));
        check(`${tag} agents: a directory with avatar, tagline, building, token price and change`, agIds.length > 0 && (await page.locator(".ag-card").first().locator("img.av").count()) >= 1 && (await page.locator(".ag-card").first().locator(".bd-building").count()) === 1 && (await page.locator(".ag-card").first().locator(".ag-chg").count()) === 1, `${agIds.length} agents`);
        check(`${tag} agents: hidden test agents left out`, !agIds.some((a: string) => hiddenAgents.has(a)));
        check(`${tag} agents: no horizontal scroll`, await noHScroll(page));
        await shot(page, `${tag}-agents`);

        // Eco page
        await page.click("#eco-open");
        await page.locator(".eco-page").waitFor({ timeout: 60_000 });
        const secs = await page.locator(".eco-sec").evaluateAll((els: Element[]) => els.map((e) => e.id));
        check(`${tag} eco page: agents, projects, leaderboard and feed`, ["eco-agents", "eco-projects", "eco-board", "eco-feed"].every((x) => secs.includes(x)) && new URL(page.url()).pathname === "/eco", secs.join(","));
        const ecoAgents = await page.locator(".eco-page [data-agent], .eco-page a[href^='/agents/']").evaluateAll((els: Element[]) => els.map((e) => (e as HTMLElement).dataset.agent ?? (e.getAttribute("href") ?? "").split("/")[2]));
        check(`${tag} eco page: hidden test agents left out`, !ecoAgents.some((a: string) => hiddenAgents.has(a)), `${new Set(ecoAgents).size} agents linked`);
        check(`${tag} eco page: docs entry links to /docs`, (await page.locator('.eco-links a[href="/docs"]').count()) === 1);
        check(`${tag} eco page: no horizontal scroll`, await noHScroll(page));
        await shot(page, `${tag}-eco`);

        // a hidden launch still resolves by direct link, marked
        if (hiddenSample) {
          await page.goto(`${BASE}/tokens/${hiddenSample}`);
          await page.locator(".mk-statspanel").waitFor({ timeout: 60_000 });
          check(`${tag} hidden token page resolves, marked hidden from listings`, /Hidden from listings/.test(await page.locator(".bd-hidden").innerText().catch(() => "")));
        }

        // Profile, disconnected
        await page.goto(`${BASE}/profile`);
        await page.locator(".me-prompt").waitFor({ timeout: 30_000 });
        check(`${tag} profile disconnected: a single prompt to connect`, (await page.locator("#me-signed").isHidden()) && /Connect a wallet/.test(await page.locator(".me-prompt").innerText()));
        await shot(page, `${tag}-profile-disconnected`);

        // Connect from the header
        await page.click("#cn-btn");
        await page.locator("#cn-btn.on").waitFor({ timeout: 20_000 });
        check(`${tag} connect: the button becomes a profile icon`, (await page.locator("#cn-btn.on img.cn-av").count()) === 1 && (await page.locator("#cn-btn").getAttribute("aria-label") ?? "").includes(wallet.id.slice(0, 4)));
        await page.locator(".me-agents .me-ag").first().waitFor({ timeout: 90_000 });
        await page.waitForFunction(() => !document.querySelector(".wl-bal")?.textContent?.includes("TBA"), null, { timeout: 60_000 }).catch(() => {});
        await page.locator(".me-ag .bd-building").first().waitFor({ timeout: 60_000 });
        const mine = await page.locator(".me-ag").count();
        check(`${tag} profile connected: my agents first, each with what it is building and its token figures`, (await page.locator(".wl-bal").count()) === 1 && mine >= 1 && (await page.locator(".me-ag .bd-params").count()) >= 1, `${mine} agents`);
        await page.locator("#w-hold table, #w-hold [data-none]").first().waitFor({ timeout: 60_000 });
        await page.locator("#w-follow .me-follow, #w-follow [data-none]").first().waitFor({ timeout: 30_000 });
        check(`${tag} profile: no horizontal scroll`, await noHScroll(page));
        await shot(page, `${tag}-profile-connected`);
        await page.locator('[data-act="me-manage"]').first().click();
        await page.locator("#me-manage:not([hidden]) #w-id .kv").first().waitFor({ timeout: 60_000 });
        await page.locator("#w-gh .kv, #w-gh .wl-fine").first().waitFor({ timeout: 30_000 }).catch(() => {});
        check(`${tag} profile manage: images, fund trading, signing key and GitHub token; no fee crank`, (await page.locator('[data-me-up="avatar"]').count()) === 1 && (await page.locator('[data-act="me-fund"]').count()) === 1 && (await page.locator('[data-act="me-crank"]').count()) === 0 && (await page.locator("#w-id .kv").count()) >= 1);
        check(`${tag} profile: no fee rows`, !/fees? (claimed|to compute|split)|crank/i.test(await page.locator("#me-signed").innerText()));
        await shot(page, `${tag}-profile-manage`);
        // the connection persists across a reload
        await page.reload();
        await page.locator("#cn-btn.on").waitFor({ timeout: 20_000 });
        check(`${tag} connection persists across a reload`, true);
        await page.click("#cn-btn");
        const menu = (await page.locator("#cn-menu").innerText()).replace(/\s+/g, " ");
        check(`${tag} connected menu: My profile, Copy address, Disconnect`, /My profile/.test(menu) && /Copy address/.test(menu) && /Disconnect/.test(menu), menu);
        await shot(page, `${tag}-connect-menu`);
        await page.keyboard.press("Escape");

        // Launch, every step
        await page.goto(`${BASE}/launch`);
        await page.locator(".lz-nav").waitFor({ timeout: 30_000 });
        await page.locator('[name="l_deposit"]').evaluate((e: HTMLInputElement) => e.value).catch(() => "");
        check(`${tag} launch: six steps, only the first reachable`, (await page.locator(".lz-step").count()) === 6 && (await page.locator(".lz-step:not([disabled])").count()) === 1);
        await shot(page, `${tag}-launch-1-coin-empty`);
        await page.fill('[name="l_name"]', `ui check ${width}`);
        await page.fill('[name="l_desc"]', "A devnet check of the launch wizard. Nothing is launched by this run.");
        await page.locator('[name="l_image"]').setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
        await page.fill('[name="l_links"]', "https://example.com");
        await page.locator('[data-act="lz-next"]:not([disabled])').waitFor({ timeout: 10_000 });
        await shot(page, `${tag}-launch-1-coin`);
        await page.click('[data-act="lz-next"]');
        await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
        await page.locator("#w-work .lz-rec, #w-work .banner").first().waitFor({ timeout: 60_000 });
        const work = (await page.locator("#w-work").innerText()).replace(/\s+/g, " ");
        check(`${tag} launch step 2: targets read from Core`, /base58-py/.test(work) && /_ir/.test(work), work.slice(0, 200));
        await shot(page, `${tag}-launch-2-work`);
        await page.click('[data-act="lz-next"]');
        await page.fill('[name="s_vibe"]', "dry, exact, cheerful about small wins");
        await page.fill('[name="s_specialty"]', "base58 hot paths, same bytes out");
        await page.fill('[name="s_values"]', "measure before claiming, small diffs");
        await page.locator('input[name="l_temp"][value="balanced"]').check();
        await page.click('[data-act="soul-generate"]');
        await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 60_000 });
        await page.locator('[name="l_model"]').first().waitFor({ timeout: 30_000 });
        const eff = await page.locator("#w-temp-eff").innerText();
        check(`${tag} launch step 3: soul drafted, temperament read back from it, model table`, /balanced/.test(eff) && (await page.locator(".wl-prov-i").count()) >= 2, eff);
        await shot(page, `${tag}-launch-3-agent`);
        await page.click('[data-act="lz-next"]');
        await page.locator('input[name="l_identity"][value="token"]').check();
        check(`${tag} launch step 4: token mode shows the token check`, (await page.locator('[data-act="gh-check"]').count()) === 1);
        await shot(page, `${tag}-launch-4-identity-token`);
        await page.locator('input[name="l_identity"][value="purchased"]').check();
        await shot(page, `${tag}-launch-4-identity`);
        await page.click('[data-act="lz-next"]');
        await page.locator("#w-fees .wl-params").waitFor({ timeout: 30_000 });
        await page.locator("#w-prepay b.num").first().waitFor({ timeout: 30_000 });
        const fund = (await page.locator('[data-step="4"]').innerText()).replace(/\s+/g, " ");
        check(`${tag} launch step 5: 10 USD default, first-run budget, launch parameters from chain, no fee split`, (await page.locator('[name="l_deposit"]').inputValue()) === "10" && /First-run budget/.test(fund) && /agent wakes at/.test(fund) && !/fee split|protocol treasury|to the protocol/i.test(fund), fund.slice(0, 240));
        await shot(page, `${tag}-launch-5-funding`);
        const nextOk = await page.locator('[data-act="lz-next"]:not([disabled])').count();
        if (!nextOk) check(`${tag} launch step 5: Next`, false, await page.locator(".lz-why").innerText().catch(() => ""));
        await page.click('[data-act="lz-next"]');
        await page.locator(".lz-review").waitFor();
        await page.locator("#w-launch-out .mark.good, #w-launch-out [data-err]").first().waitFor({ timeout: 120_000 });
        const rv = (await page.locator('[data-step="5"]').innerText()).replace(/\s+/g, " ");
        check(`${tag} launch step 6: review rows and a devnet simulation, Launch offered`, /simulation succeeded on devnet/i.test(rv) && (await page.locator(`[data-act="launch-sign"]`).count()) === 1 && /Prepaid credits/i.test(rv), rv.slice(0, 200));
        check(`${tag} launch: no horizontal scroll`, await noHScroll(page));
        await shot(page, `${tag}-launch-6-review`);
        // the step nav jumps back to any reached step
        await page.click('.lz-step[data-i="0"]');
        check(`${tag} launch: step nav goes back to a reached step`, await page.locator('[data-step="0"]').isVisible());

        // token page: Commits panel (Wick Radix, a real Verified commit)
        await page.goto(`${BASE}/tokens/${WICK.mint}`);
        await page.locator(".cm-panel table, .cm-panel .empty").first().waitFor({ timeout: 60_000 });
        const cm = (await page.locator(".cm-panel").innerText()).replace(/\s+/g, " ");
        const repoHref = await page.locator('.cm-panel .panel-h a[href^="https://github.com/"]').getAttribute("href").catch(() => null);
        check(`${tag} token page: Commits panel with the Verified commit and the repo link`, /d02114a/.test(cm) && /Verified/.test(cm) && repoHref === "https://github.com/agwyus9p/base58" && (await page.locator('.cm-panel a[href^="/generations/"]').count()) > 0, cm.slice(0, 220));
        const tb = await page.locator(".mk-tb-acct").waitFor({ timeout: 90_000 }).then(() => true, () => false);
        check(`${tag} token page: trade box uses the header's connection`, tb && (await page.locator(".mk-tb-acct").innerText()).includes(wallet.id.slice(0, 4)));
        const stl = (await page.locator(".mk-stats .stat .eyebrow").allInnerTexts()).map((x: string) => x.trim().toLowerCase());
        check(`${tag} token page: price, market cap, 24h volume, 24h change and what the agent is building`, stl.join(",") === "price,market cap,24h volume,24h change" && (await page.locator(".mk-buildpanel .bd-building").count()) === 1, stl.join(","));
        check(`${tag} token page: no fee history or fee panel`, !/fee history|fees and compute|fees to compute|crank/i.test(await page.locator("#main").innerText()));
        check(`${tag} token page: no horizontal scroll`, await noHScroll(page));
        await shot(page, `${tag}-token-commits`);

        // docs
        await page.goto(`${BASE}/docs`);
        await page.locator(".dc-h1").waitFor();
        check(`${tag} docs: static site outside the app shell`, (await page.locator("#app").count()) === 0 && (await page.locator(".dc-nav a").count()) === 9);
        await page.goto(`${BASE}/docs/verification`);
        await page.waitForFunction(() => [...document.querySelectorAll("[data-live]")].some((e) => !e.classList.contains("tba")), null, { timeout: 30_000 }).catch(() => {});
        const live = await page.locator("[data-live]").allInnerTexts();
        check(`${tag} docs: live figures filled from Core`, live.length > 0 && live.some((x: string) => x !== "TBA"), live.join(" | "));
        check(`${tag} docs: no horizontal scroll`, await noHScroll(page));
        await shot(page, `${tag}-docs`);

        // removed routes
        for (const [from, to] of [["/network", "/"], ["/live", "/"], ["/tokens", "/"], ["/wallet", "/profile"], ["/spawn", "/launch"], ["/manual", "/docs"]]) {
          await page.goto(`${BASE}${from}`);
          check(`${tag} ${from} redirects to ${to}`, new URL(page.url()).pathname === to, page.url());
        }
        check(`${tag} no console errors`, errors.length === 0, errors.slice(0, 6).join(" ; "));
        await ctx.close();
      }
    }
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------- launch (real devnet)

const OUT = join(import.meta.dir, "APP-LAUNCH-LAST.json");
const SEED = {
  name: "Ledger Lamp",
  symbol: "TLAMP",
  desc: "A devnet TEST agent launched through the Launch wizard to prove it end to end. Its TEST token has no value and it talks only about its engineering.",
  links: "https://github.com/plsdontcallmyfone/lineage",
  repo: arg("repo", "https://github.com/keis/base58")!,
  vibe: "plain, careful, quietly pleased by a smaller number",
  specialty: "base58 encode and decode hot paths: fewer big-int steps, same bytes out",
  values: "measure before claiming, small reviewable diffs, say plainly it is a test",
};

async function phaseLaunch() {
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  if (prev?.agent) throw new Error(`already launched ${prev.agent}; move ${OUT} away to launch another`);
  const wallet = loadOrCreateKeypair(join(KEYS, "app-launch-test.json")).key;
  const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
  const txs: { what: string; signature: string; fee: number | null; at: string }[] = [];
  const logTx = (what: string, signature: string, fee: number | null | undefined) => txs.push({ what, signature, fee: fee ?? null, at: new Date().toISOString() });
  const save = (extra: Record<string, unknown>) => writeFileSync(OUT, JSON.stringify({ wallet: wallet.id, deployer: dep.id, txs, results, ...extra }, null, 2) + "\n");
  // fund the test wallet: SOL from the Lineage deployer, tLINE from the faucet key (both passed explicitly)
  const solBal = await rpc.getBalance(wallet.id);
  if (solBal < 200_000_000n) {
    const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, wallet.id, 250_000_000n - solBal)]);
    logTx(`fund the test wallet with ${Number(250_000_000n - solBal) / 1e9} SOL from the Lineage deployer`, r.signature, r.fee);
  }
  const want = 700n * 10n ** BigInt(DEC); // the 10 USD deposit (200 tLINE) now, and later UI checks that review another
  const bal = (await reader.tokenBalance(ata(wallet.id, LINE, T22))) ?? 0n;
  if (bal < want) {
    const fk = loadKeypair(join(KEYS, "faucet.json"));
    const r = await sendAndConfirm(rpc, fk, [token.createAtaIdempotent(fk.id, wallet.id, LINE, T22), token.transferChecked(ata(fk.id, LINE, T22), LINE, ata(wallet.id, LINE, T22), fk.id, want - bal, DEC, T22)]);
    logTx(`top up the test wallet with ${Number(want - bal) / 10 ** DEC} tLINE from the faucet key`, r.signature, r.fee);
  }
  save({});
  const { b, context, signed } = await browser(wallet);
  const { page, errors } = await context({ width: 1280, dark: false });
  const s = (n: string) => SHOTS && page.screenshot({ path: join(SHOTS, `launch-${n}.png`), fullPage: true });
  try {
    await page.goto(`${BASE}/launch`);
    await page.click("#cn-btn");
    await page.locator("#cn-btn.on").waitFor({ timeout: 20_000 });
    await page.fill('[name="l_name"]', SEED.name);
    await page.fill('[name="l_symbol"]', SEED.symbol);
    await page.fill('[name="l_desc"]', SEED.desc);
    await page.fill('[name="l_links"]', SEED.links);
    await page.click('[data-act="lz-next"]');
    await page.fill('[name="l_repo"]', SEED.repo);
    await page.locator("#w-work .lz-rec, #w-work .banner").first().waitFor({ timeout: 60_000 });
    await page.click('[data-act="lz-next"]');
    await page.fill('[name="s_vibe"]', SEED.vibe);
    await page.fill('[name="s_specialty"]', SEED.specialty);
    await page.fill('[name="s_values"]', SEED.values);
    await page.locator('input[name="l_temp"][value="careful"]').check();
    await page.click('[data-act="soul-generate"]');
    await page.waitForSelector(".wl-soul .wl-hash, #w-soul [data-err]", { timeout: 300_000 });
    const soulText = await page.locator("#w-soul").innerText();
    check("launch: the site's drafter expanded the seed into a soul", /Drafted by/.test(soulText), soulText.split("\n")[0]);
    await page.click('[data-act="lz-next"]');
    await page.locator('input[name="l_identity"][value="purchased"]').check();
    await page.click('[data-act="lz-next"]');
    await page.locator("#w-prepay b.num").first().waitFor({ timeout: 30_000 });
    await page.click('[data-act="lz-next"]');
    await page.waitForSelector("text=simulation succeeded on devnet", { timeout: 120_000 });
    const review = (await page.locator('[data-step="5"]').innerText()).replace(/\s+/g, " ");
    const path = /2 signatures/.test(review) ? "split" : /one v0 transaction/.test(review) ? "v0" : "legacy";
    check("launch: review simulated on devnet", true, `path ${path}`);
    await s("review");
    const n0 = signed.length;
    // a double click must still send one launch
    await page.locator('[data-act="launch-sign"]').dblclick();
    await page.locator('[data-track="confirmed"][data-state="ok"]').waitFor({ timeout: 180_000 });
    const launches = (await reader.launches()).filter((l) => l.launcher === wallet.id);
    check("launch: exactly one AgentLaunch for this wallet (the double click sent one launch)", launches.length === 1, `${launches.length}`);
    const l = launches[0]!;
    log(`launched agent ${l.agent}, mint ${l.mint}`);
    const sigs = await rpc.call<{ signature: string }[]>("getSignaturesForAddress", [launchPdas.agentLaunch(l.mint), { limit: 20 }]);
    const launchSig = sigs[sigs.length - 1]!.signature;
    const tx = await rpc.call<any>("getTransaction", [launchSig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    logTx(`launch_agent + deposit + refresh_awake${path === "split" ? "" : " + set_profile"} (${tx?.version === 0 ? "v0" : "legacy"}) ${SEED.symbol} through /launch`, launchSig, tx?.meta?.fee);
    save({ agent: l.agent, mint: l.mint, path });
    await page.locator('[data-track="runtime"][data-state="ok"]').waitFor({ timeout: 300_000 }).then(
      () => check("launch: hosted runtime bound (rotate_agent_key co-signed by the runtime)", true),
      async () => check("launch: hosted runtime bound", false, await page.locator("#w-rt-bind").innerText().catch(() => "")),
    );
    const rec = await reader.agent(l.agent);
    const rs = await rpc.call<{ signature: string }[]>("getSignaturesForAddress", [registryPdas.agent(l.agent), { limit: 20 }]).catch(() => []);
    for (const x of rs) {
      const t = await rpc.call<any>("getTransaction", [x.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
      const logs: string[] = t?.meta?.logMessages ?? [];
      if (logs.some((m) => m.includes("Instruction: RotateAgentKey"))) logTx(`rotate_agent_key ${SEED.symbol} to the hosted runtime (co-signed by the runtime)`, x.signature, t?.meta?.fee);
      if (x.signature !== launchSig && logs.some((m) => m.includes("Instruction: SetProfile"))) logTx(`set_profile (soul) ${SEED.symbol}`, x.signature, t?.meta?.fee);
    }
    await page.locator('[data-track="vault"][data-state="ok"]').waitFor({ timeout: 120_000 }).catch(() => {});
    await page.locator('[data-track="github"][data-state="ok"]').waitFor({ timeout: 240_000 }).catch(() => {});
    await s("launched");
    const steps = await page.locator("[data-track]").evaluateAll((els: HTMLElement[]) => els.map((e) => `${e.dataset.track}=${e.dataset.state}: ${e.innerText.replace(/\s+/g, " ")}`));
    for (const st of steps) log(`  ${st}`);
    check("launch: vault funded and awake", steps.some((x: string) => x.startsWith("vault=ok")), steps.find((x: string) => x.startsWith("vault")) ?? "");
    check("launch: GitHub account ready", steps.some((x: string) => x.startsWith("github=ok")), steps.find((x: string) => x.startsWith("github")) ?? "");
    check("launch: signing key is the runtime's on chain", !!rec?.signingKey && rec.signingKey !== l.agent, rec?.signingKey ?? "none");
    check("launch: wallet signatures through the mock", signed.length - n0 >= 2, signed.slice(n0).join(" ; "));
    check("launch: no page errors", errors.length === 0, errors.slice(0, 4).join(" ; "));
    save({ agent: l.agent, mint: l.mint, path, steps, signing_key: rec?.signingKey ?? null, wallet_signatures: signed.slice(n0) });
  } finally {
    await b.close();
  }
}

if (PHASE === "ui") await phaseUi();
else if (PHASE === "launch") await phaseLaunch();
else throw new Error(`unknown phase ${PHASE}`);
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
writeFileSync(join(import.meta.dir, `APP-CHECK-${PHASE.toUpperCase()}-LAST.json`), JSON.stringify({ at: new Date().toISOString(), base: BASE, passed: results.length - failed.length, total: results.length, results }, null, 2) + "\n");
process.exit(failed.length ? 1 : 0);
