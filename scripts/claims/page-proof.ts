// A claim through the Claim page in headless Chromium (docs/plans/GITHUB-FEE-CLAIMS.md), with a
// Wallet Standard test wallet that really signs: the page asks, a function exposed to it signs the
// statement and the transaction with the claimer's key (the page never sees the key). Used by
// scripts/pools/devnet-proof.ts against the staging Core; never the owner's own browser.
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { signBytes, type Signer } from "@units/chain";
import { parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import type { MockGithub } from "./mock-github.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** The dashboard server on `port`, reading the staging Core. Returns its base URL and a stop that kills only this child. */
export async function startWeb(port: number, core: string, market = "https://157-245-71-188.sslip.io"): Promise<{ base: string; stop(): void }> {
  // `market`: the devnet site's public indexer, read-only. Never the default (127.0.0.1:9668): when this server itself runs on
  // 9668 it would proxy /market to itself and stall every request.
  let busy = "";
  try {
    busy = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).trim();
  } catch { /* free */ }
  if (busy) throw new Error(`port ${port} is in use by pid ${busy}; not binding`);
  const child: ChildProcess = spawn("bun", ["apps/web/server.ts", "--port", String(port), "--core", core, "--market", market], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, UNITS_NETWORK: "devnet", UNITS_FEATURE_AGENT_POOLS: "1", UNITS_FEATURE_GITHUB_FEE_CLAIMS: "1" } });
  const out: string[] = [];
  child.stdout!.on("data", (d) => out.push(String(d)));
  child.stderr!.on("data", (d) => out.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  const stop = () => { if (child.pid && child.exitCode === null) process.kill(child.pid); };
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode !== null) throw new Error(`web server exited: ${out.join("").slice(-800)}`);
    if (await fetch(`${base}/chain/config`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)) return { base, stop };
  }
  stop();
  throw new Error(`web server did not start: ${out.join("").slice(-800)}`);
}

export interface PageClaim {
  login: string;
  claimed: string;
  signature: string;
  per_agent: { agent: string; share: string; accrued: string }[];
  claimable_before: string;
  claimable_after: string;
  screenshots: string[];
  console_errors: string[];
}

/**
 * One claim through /claim. `mode` "oauth": the page's Sign in button (the mock provider signs in
 * as its first user). `mode` "gist": the page's gist path; the text the page shows is posted to the
 * mock GitHub as a public gist of `login`, as the user would on gist.github.com.
 */
export async function claimThroughPage(o: { base: string; wallet: Signer; mode: "oauth" | "gist"; login: string; mock: MockGithub; shots?: string; width?: number; dark?: boolean; lookOnly?: boolean }): Promise<PageClaim> {
  const browser: Browser = await chromium.launch({ headless: true });
  const shots: string[] = [];
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: o.width ?? 1280, height: 1000 }, colorScheme: o.dark ? "dark" : "light" });
    await ctx.exposeFunction("__unitsSignTx", (b64: string) => {
      const wire = new Uint8Array(Buffer.from(b64, "base64"));
      return Buffer.from(placeSignature(wire, o.wallet.id, signBytes(o.wallet, parseWire(wire).message))).toString("base64");
    });
    await ctx.exposeFunction("__unitsSignMsg", (b64: string) => Buffer.from(signBytes(o.wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64"));
    await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
      const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
      const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"], label: "claimer" };
      const w: any = {
        version: "1.0.0", name: "units Test Wallet", chains: ["solana:devnet"], accounts: [] as unknown[],
        icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
          "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
            signTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await (window as any).__unitsSignTx(b64(i.transaction))) }))) },
          "solana:signMessage": { version: "1.0.0",
            signMessage: async (...inputs: { message: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__unitsSignMsg(b64(i.message))) }))) },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
    }, { address: o.wallet.id, pub: Array.from(o.wallet.secret.subarray(32)) });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    if (process.env.PAGE_PROOF_DEBUG) page.on("request", (r) => { if (!/\.(js|css|woff2?|svg|png)(\?|$)/.test(r.url())) console.log(`[req] ${r.method()} ${r.url().slice(0, 120)} ${(r.postData() ?? "").slice(0, 90)}`); });
    if (process.env.PAGE_PROOF_DEBUG) page.on("requestfailed", (r) => console.log(`[failed] ${r.url()} ${r.failure()?.errorText}`));
    if (process.env.PAGE_PROOF_DEBUG) page.on("response", (r) => { if (!/\.(js|css|woff2?|svg|png)(\?|$)/.test(r.url())) console.log(`[net] ${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`); });
    if (process.env.PAGE_PROOF_DEBUG) page.on("console", (m) => console.log(`[page ${m.type()}] ${m.text().slice(0, 300)}`));
    const shot = async (name: string) => {
      if (!o.shots) return;
      const p = join(o.shots, `${name}.png`);
      await page.screenshot({ path: p, fullPage: true });
      shots.push(p);
    };
    const busyDone = () => page.waitForFunction(() => !document.querySelector("[data-claim-busy]"), null, { timeout: 120_000 });
    await page.goto(`${o.base}/claim`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-claim="oauth"], [data-claim="connect"], details.cl-gist', { timeout: 60_000 });
    await shot(`claim-${o.mode}-1-start`);
    if (o.mode === "oauth") {
      await page.click('[data-claim="oauth"]');
      await page.waitForSelector("[data-claim-login]", { timeout: 60_000 });
      if (!(await page.locator('[data-claim="bind"]').count())) {
        await page.click('[data-claim="connect"]');
        await page.waitForSelector('[data-claim="bind"]', { timeout: 30_000 });
      }
      if (process.env.PAGE_PROOF_DEBUG) {
        console.log("bind button:", await page.locator('[data-claim="bind"]').innerText());
        console.log("direct sign:", await page.evaluate(async () => { try { return String((await (window as any).__unitsSignMsg(btoa("hi"))).length); } catch (e) { return "ERR " + e; } }));
      }
      await page.click('[data-claim="bind"]');
    } else {
      await page.locator("details.cl-gist > summary").click();
      if (await page.locator('details.cl-gist [data-claim="connect"]').count()) await page.click('details.cl-gist [data-claim="connect"]');
      await page.waitForSelector('[name="cl_login"]', { timeout: 30_000 });
      await page.fill('[name="cl_login"]', o.login);
      await page.click('[data-claim="gist-sign"]');
      await page.waitForSelector("[data-claim-gist-text]", { timeout: 30_000 });
      const text = await page.locator("[data-claim-gist-text]").inputValue();
      await shot(`claim-${o.mode}-2-statement`);
      await page.fill('[name="cl_gist"]', o.mock.addGist(o.login, text));
      await page.click('[data-claim="gist-verify"]');
    }
    await page.waitForSelector("[data-claim-wallet]", { timeout: 60_000 }).catch(async (e) => {
      if (process.env.PAGE_PROOF_DEBUG) console.log("probe:", await page.evaluate(async () => {
        const one = async (path: string, init?: RequestInit) => { const t = Date.now(); try { const r = await fetch(path, { ...init, signal: AbortSignal.timeout(5000) }); return `${path} ${r.status} ${Date.now() - t}ms`; } catch (e) { return `${path} ERR ${e}`; } };
        return [await one("/api/fee-claims/providers"), await one("/api/fee-claims/wallet", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), `resources ${performance.getEntriesByType("resource").filter((x: any) => !x.responseEnd).map((x) => x.name).join(",")}`];
      }));
      throw new Error(`the wallet was not bound: ${(await page.locator(".cl-status").innerText().catch(() => "")).slice(0, 300) || (e as Error).message}; page errors: ${errors.join(" | ").slice(0, 600)}`);
    });
    await page.waitForSelector("[data-claimable]", { timeout: 60_000 });
    const login = (await page.locator("[data-claim-login]").innerText()).replace(/^@/, "");
    const bound = await page.locator("[data-claim-wallet]").getAttribute("data-claim-wallet");
    if (login.toLowerCase() !== o.login.toLowerCase() || bound !== o.wallet.id) throw new Error(`the page shows @${login} with ${bound}, expected @${o.login} with ${o.wallet.id}`);
    const before = (await page.locator("[data-claim-balances] [data-claimable]").first().getAttribute("data-claimable"))!;
    const perAgent = await page.locator("tr[data-claim-agent]").evaluateAll((rows) => rows.map((r) => ({ agent: r.getAttribute("data-claim-agent")!, share: r.children[1]!.textContent!.trim(), accrued: r.children[2]!.textContent!.trim() })));
    await shot(`claim-${o.mode}-3-balance${o.lookOnly ? `-${o.width ?? 1280}${o.dark ? "-dark" : ""}` : ""}`);
    if (o.lookOnly) {
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (wide) errors.push("horizontal scroll");
      return { login, claimed: "0", signature: "", per_agent: perAgent, claimable_before: before, claimable_after: before, screenshots: shots, console_errors: errors };
    }
    await page.click('[data-claim="claim"]');
    await page.waitForSelector("[data-claim-tx]", { timeout: 180_000 });
    await busyDone();
    const signature = (await page.locator("[data-claim-tx]").getAttribute("data-claim-tx"))!;
    const claimed = (await page.locator("[data-claimed]").getAttribute("data-claimed"))!;
    const after = (await page.locator("[data-claim-balances] [data-claimable]").first().getAttribute("data-claimable"))!;
    await shot(`claim-${o.mode}-4-claimed`);
    // the page's own rules: no monospace, no em dash, no horizontal scroll
    const mono = await page.evaluate(() => [...document.querySelectorAll("#claim-root *")].filter((e) => /mono|courier|menlo|consolas/i.test(getComputedStyle(e).fontFamily)).length);
    const text = await page.locator("#claim-root").innerText();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (mono) errors.push(`${mono} elements in a monospace font`);
    if (text.includes(String.fromCharCode(0x2014))) errors.push("an em dash on the page");
    if (wide) errors.push("horizontal scroll");
    return { login, claimed, signature, per_agent: perAgent, claimable_before: before, claimable_after: after, screenshots: shots, console_errors: errors };
  } finally {
    await browser.close();
  }
}
