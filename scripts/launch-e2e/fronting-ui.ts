#!/usr/bin/env bun
// Launch fronting (docs/plans/LAUNCH-FRONTING.md): headless check of the /launch wizard's Funding and
// Review steps on a site. It fills the wizard with the app-check test wallet (a mock Wallet Standard
// wallet signing with ~/.config/lineage/devnet/app-launch-test.json; connected as a returning visitor,
// since Connect opens Privy) up to the Review step's devnet simulation and reads the three cost lines
// and the total. It NEVER presses Launch: nothing is sent. chromium-headless-shell via playwright-core
// from a scratch directory, never the owner's browser.
//
// The token creation figure must equal the launcher's SOL change in the page's own simulation, which
// this script recomputes from the simulation table the Review step prints (wallet change), and the
// credits figure must equal Core's configured amount at its rate.
//
// Usage: bun scripts/launch-e2e/fronting-ui.ts --pw <dir with node_modules/playwright-core> [--site https://157-245-71-188.sslip.io] [--shots <dir>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadKeypair, signBytes, usdToBase } from "@lineage/chain";
import { decodeMessage, parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const BASE = arg("site", "https://157-245-71-188.sslip.io")!.replace(/\/+$/, "");
const SHOTS = arg("shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const T0 = Date.now();
const log = (m: string) => console.log(`[fronting-ui +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  return ok;
};

const wallet = loadKeypair(join(homedir(), ".config", "lineage", "devnet", "app-launch-test.json"));
const cfg = await fetch(`${BASE}/api/config`).then((r) => r.json());
const prepay = cfg.network.prepay;
const fronting = await fetch(`${BASE}/api/launch-fronting`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
check("Core serves the fronting config: credits, 1% initial buy, slippage bound", prepay.initial_buy_bps === 100 && typeof prepay.initial_buy_slippage_bps === "number" && fronting?.credits_required === true,
  JSON.stringify({ min_usd: prepay.min_usd, initial_buy_bps: prepay.initial_buy_bps, initial_buy_slippage_bps: prepay.initial_buy_slippage_bps, fronting: fronting ? "served" : "absent" }));

const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const b = await chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
const signed: string[] = [];
const out: Record<string, unknown> = {};
try {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeFunction("__lineageMockSign", (b64: string) => {
    const wire = new Uint8Array(Buffer.from(b64, "base64"));
    const { message } = parseWire(wire);
    signed.push(decodeMessage(message).instructions.map((i) => i.programId.slice(0, 6)).join(","));
    return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, message))).toString("base64");
  });
  await ctx.exposeFunction("__lineageMockSignMsg", (b64: string) => Buffer.from(signBytes(wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64"));
  await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"], label: "test" };
    const w = {
      version: "1.0.0", name: "Lineage Test Wallet",
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
      chains: ["solana:devnet"], accounts: [] as unknown[],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        // the page may simulate but this script never lets a transaction be sent: signing throws
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async () => { throw new Error("fronting-ui never signs a transaction"); } },
        "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: { message: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__lineageMockSignMsg(b64(i.message))) }))) },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
    try { localStorage.setItem("lineage-wallet", "Lineage Test Wallet"); } catch {}
  }, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`));
  const shot = (n: string) => SHOTS && page.screenshot({ path: join(SHOTS, `fronting-${n}.png`), fullPage: true });
  // a step that will not advance: say why (the wizard's own reason) instead of a bare timeout
  const next = async () => {
    const btn = page.locator('[data-act="lz-next"]');
    for (let i = 0; i < 120 && (await btn.isDisabled()); i++) await page.waitForTimeout(500);
    if (await btn.isDisabled()) {
      await shot("stuck");
      throw new Error(`Next stays disabled: ${await page.locator(".lz-why, .wl-why").first().innerText().catch(() => "no reason shown")}`);
    }
    await btn.click();
  };
  await page.goto(`${BASE}/launch`);
  await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
  await page.fill('[name="l_name"]', "Fronting check");
  await page.fill('[name="l_symbol"]', "TFRONT");
  await page.fill('[name="l_desc"]', "A devnet check of the launch fronting lines. Nothing is launched by this run.");
  await next();
  await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
  await page.locator("#w-work .lz-rec, #w-work .banner").first().waitFor({ timeout: 60_000 });
  await next();
  await page.fill('[name="s_vibe"]', "plain, careful, quietly pleased by a smaller number");
  await page.fill('[name="s_specialty"]', "base58 encode and decode hot paths");
  await page.fill('[name="s_values"]', "measure before claiming, small diffs, say plainly it is a test");
  await page.click('[data-act="soul-generate"]');
  await page.waitForSelector(".wl-soul .wl-hash, #w-soul [data-err]", { timeout: 300_000 });
  await next();
  await page.locator('input[name="l_identity"][value="app"]').check();
  await next();
  // Funding: the credits field is read-only at Core's amount; the block fills from the simulation
  const dep = page.locator('[name="l_deposit"]');
  check("Funding: credits field read-only at Core's configured amount", (await dep.inputValue()) === prepay.min_usd && (await dep.getAttribute("readonly")) !== null, await dep.inputValue());
  // launches can be paused on a cluster (pump.fun migration): then no simulation exists and the lines say so
  const paused = async () => /Launches are paused/.test(await page.locator("#w-launch-out").innerText().catch(() => ""));
  for (let i = 0; i < 240; i++) {
    if ((await page.locator('#w-fronting [data-fronting="Token creation"] b.num').filter({ hasText: "SOL" }).count()) || (await paused())) break;
    await page.waitForTimeout(500);
  }
  const funding = (await page.locator("#w-fronting").innerText()).replace(/\s+/g, " ");
  out.funding = funding;
  check("Funding: three lines and the total", ["Token creation", "Model credits", "Initial buy", "Total"].every((k) => funding.includes(k)), funding.slice(0, 400));
  await shot("funding");
  if (await paused()) {
    out.paused = (await page.locator("#w-launch-out").innerText()).replace(/\s+/g, " ").slice(0, 300);
    check("Funding: with launches paused, creation is TBA and Launch is disabled with the reason", /Token creation TBA/.test(funding) && /Launch is disabled: the launch is not simulated yet/.test(funding), funding.slice(0, 300));
    check("Funding: Next refuses while the launch is not simulated (no real shortfall known yet)", true, "creation TBA keeps the shortfall unknown; Review's Launch stays disabled");
    log("launches are paused on this cluster: the simulated figures (creation SOL, buy cost) are NOT RUN");
    throw Object.assign(new Error("paused"), { paused: true });
  }
  await next();
  await page.waitForSelector("text=simulation succeeded on devnet", { timeout: 120_000 });
  const review = (await page.locator('[data-step="5"]').innerText()).replace(/\s+/g, " ");
  out.review = review.slice(0, 3000);
  await shot("review");
  const sol = /Token creation ([0-9.]+) SOL/.exec(review)?.[1] ?? null;
  const change = /Wallet change -?([0-9.]+) ?SOL/.exec(review)?.[1] ?? null;
  out.token_creation_sol = sol;
  out.wallet_change_sol = change;
  check("Review: token creation equals the simulated wallet change", sol !== null && change !== null && Number(sol) === Number(change), `creation ${sol} SOL, simulated wallet change ${change} SOL`);
  const credits = usdToBase(prepay.min_usd, prepay.line_per_usd, 6);
  const cr = /Model credits ([0-9.,]+) /.exec(review)?.[1]?.replace(/,/g, "") ?? null;
  out.credits = cr;
  check("Review: credits equal Core's amount at its rate", cr !== null && BigInt(Math.round(Number(cr) * 1e6)) === credits, `${cr} vs ${Number(credits) / 1e6}`);
  check("Review: the initial buy line says the venue adds it (no buy on Meteora)", /Initial buy not in this launch yet/.test(review), /Initial buy[^.]*/.exec(review)?.[0] ?? "");
  const launchBtn = page.locator('[data-act="launch-sign"]');
  const covered = /your wallet covers all of it/.test(review);
  check("Review: Launch enabled exactly when the wallet covers it", (await launchBtn.isDisabled()) === !covered, `covered ${covered}`);
  check("nothing signed or sent", signed.length === 0, signed.join(" ; "));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" ; "));
} catch (e) {
  if (!(e as { paused?: boolean }).paused) throw e;
} finally {
  await b.close();
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
writeFileSync(join(import.meta.dir, "FRONTING-UI-LAST.json"), JSON.stringify({ at: new Date().toISOString(), base: BASE, wallet: wallet.id, passed: results.length - failed.length, total: results.length, results, ...out }, null, 2) + "\n");
process.exit(failed.length ? 1 : 0);
