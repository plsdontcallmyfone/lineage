#!/usr/bin/env bun
// Headless check of the network profile switch in the pages (M3, SPEC 14.10): the same tree served
// twice, once under the devnet profile (as before) and once under the mainnet profile with a sentinel
// key on the RPC URL; chromium-headless-shell via playwright-core from a scratch directory (never a
// repo dependency, never the owner's browser). Nothing is signed: no wallet is connected.
//
//   bun scripts/mainnet-mode/ui-check.ts --pw <dir with node_modules/playwright-core> --devnet http://127.0.0.1:9663 --mainnet http://127.0.0.1:9664 --sentinel <key>
//
// Checks on each: /launch (gate, deposit and allocation fieldsets, pay-with control), /profile, a
// token page's trade box; on mainnet also that no response the browser received (pages, bundles,
// /chain/config, /chain/rpc answers) contains the sentinel.
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw")!;
const DEV = arg("devnet", "http://127.0.0.1:9663")!;
const MAIN = arg("mainnet", "http://127.0.0.1:9664")!;
const SENTINEL = arg("sentinel")!;
const MINT = arg("mint", "A8YeMNZuSfKZZpgMpj8sYwmsHpDsm5CkjTYp966mpsFS")!; // Wick Radix (TESTB58), a live devnet token
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
};

const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });

async function run(net: "devnet" | "mainnet", base: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const bodies: { url: string; text: string }[] = [];
  page.on("response", async (r: any) => {
    try {
      if (r.url().startsWith(base)) bodies.push({ url: r.url(), text: await r.text() });
    } catch {
      /* redirects and aborted requests have no body */
    }
  });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));

  // /launch: the wallet bundle's launch wizard (every step is in the DOM; read textContent, hidden or not)
  await page.goto(`${base}/launch`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (document.querySelector("#w-gate")?.textContent ?? "").trim().length > 0 && !/Checking the cluster/.test(document.querySelector("#w-gate")!.textContent!), null, { timeout: 60_000 });
  await page.waitForFunction(() => !!document.querySelector("[data-swap-help]") && !/Checking the network/.test(document.querySelector("[data-swap-help]")!.textContent!), null, { timeout: 30_000 }).catch(() => {});
  const gate = (await page.locator("#w-gate").textContent()) ?? "";
  const launch = await page.evaluate(() => (document.querySelector("main") ?? document.body).textContent ?? "");
  const deposit = await page.evaluate(() => document.querySelector('[name="l_deposit"]')?.closest("label")?.querySelector(".eyebrow")?.textContent ?? "");
  const alloc = await page.evaluate(() => document.querySelector('[name="l_alloc"]')?.closest("label")?.querySelector(".eyebrow")?.textContent ?? "");
  const pay = await page.evaluate(() => [...(document.querySelector('select[name="l_deposit_pay"]') as HTMLSelectElement | null)?.options ?? []].map((o) => `${o.value}:${o.disabled ? "off" : "on"}:${o.textContent}`));
  const swapHelp = await page.evaluate(() => document.querySelector("[data-swap-help]")?.textContent ?? "");

  // /profile, no wallet connected
  await page.goto(`${base}/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (document.querySelector("#w-conn")?.textContent ?? "").length > 0 && !/Reading the wallet/.test(document.querySelector("#w-conn")!.textContent!), null, { timeout: 60_000 }).catch(() => {});
  const profile = (await page.locator("#w-conn").textContent().catch(() => "")) ?? "";

  // a token page's trade box
  await page.goto(`${base}/tokens/${MINT}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mk-tb").first().waitFor({ timeout: 60_000 }).catch(() => {});
  await page.waitForFunction(() => !/Checking that the RPC/.test(document.querySelector(".mk-tb")?.textContent ?? "Checking that the RPC"), null, { timeout: 60_000 }).catch(() => {});
  const box = (await page.locator(".mk-tb").first().textContent().catch(() => "")) ?? "";
  const cfg = await (await fetch(`${base}/chain/config`)).json();

  if (net === "devnet") {
    check("devnet: gate says devnet only with the TEST mint", /Devnet only/.test(gate) && /TEST mint/.test(gate), gate);
    check("devnet: deposit in USD, allocation in tLINE", /Deposit \(USD\)/.test(deposit) && /Allocation \(tLINE\)/.test(alloc), `${deposit} | ${alloc}`);
    check("devnet: pay with tLINE; SOL and USDC unavailable", pay.join(",") === "LINE:on:tLINE,SOL:off:SOL (swap),USDC:off:USDC (swap)", pay.join(","));
    check("devnet: swap help says unavailable here", /unavailable here/.test(swapHelp), swapHelp);
    check("devnet: trade box offers the faucet and TEST tokens", /Devnet only, TEST tokens/.test(box) && /faucet/.test(box), box.slice(0, 200));
    check("devnet: /chain/config has the faucet and the devnet profile", !!cfg.faucet && cfg.profile?.network === "devnet" && cfg.profile.test_labels === true, `${cfg.faucet} ${cfg.profile?.network}`);
    check("devnet: explorer links carry ?cluster=devnet", /cluster=devnet/.test(await page.content()));
  } else {
    check("mainnet: gate names mainnet, no devnet wording", /mainnet/i.test(gate) && !/Devnet only/.test(gate), gate);
    check("mainnet: the wallet regions show no TEST label, no faucet, no tLINE", !/TEST|faucet|tLINE/i.test(gate + deposit + alloc + pay.join(" ") + swapHelp + profile + box),
      [gate, deposit, alloc, swapHelp, profile, box].join(" | ").match(/.{0,40}(TEST|faucet|tLINE).{0,40}/i)?.[0] ?? "");
    check("mainnet: deposit and allocation in the quote token (no USD without a price feed)", /Deposit \(PYUSD\)/.test(deposit) && /Allocation \(PYUSD\)/.test(alloc), `${deposit} | ${alloc}`);
    check("mainnet: pay with PYUSD, SOL or USDC (swap enabled)", pay.join(",") === "LINE:on:PYUSD,SOL:on:SOL (swap),USDC:on:USDC (swap)", pay.join(","));
    check("mainnet: swap help names the stand-in and the limits", /PYUSD \(stand-in for \$LINE\)/.test(swapHelp) && /slippage/.test(swapHelp), swapHelp);
    check("mainnet: launch and trade wait for a mainnet deployment", /not deployed on mainnet/.test(gate + launch) && /not deployed on mainnet/.test(box), box.slice(0, 200));
    check("mainnet: /chain/config has no faucet and the mainnet profile", cfg.faucet === null && cfg.profile?.network === "mainnet" && cfg.profile.test_labels === false && cfg.profile.quote.symbol === "PYUSD");
    const leaks = bodies.filter((b) => b.text.includes(SENTINEL)).map((b) => b.url);
    check("mainnet: no response the browser got carries the RPC key", leaks.length === 0 && bodies.length > 5, `${bodies.length} responses read${leaks.length ? `; leaked in ${leaks.join(", ")}` : ""}`);
    check("mainnet: the RPC is shown redacted", cfg.rpc_upstream === "https://api.mainnet-beta.solana.com (keyed)", cfg.rpc_upstream);
    check("mainnet: explorer links carry no cluster parameter", !/cluster=devnet/.test(await page.content()));
  }
  check(`${net}: no page errors`, errors.length === 0, errors.join("; "));
  await ctx.close();
}

try {
  await run("devnet", DEV);
  await run("mainnet", MAIN);
} finally {
  await browser.close();
}
const passed = results.filter((r) => r.ok).length;
writeFileSync(join(import.meta.dir, "UI-CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), passed, checks: results.length, results }, null, 1) + "\n");
console.log(`\n${passed}/${results.length} checks passed (scripts/mainnet-mode/UI-CHECK-LAST.json)`);
process.exit(passed === results.length ? 0 : 1);
