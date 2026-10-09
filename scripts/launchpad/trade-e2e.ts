#!/usr/bin/env bun
// Real devnet buy and sell through the token page's trade box (plan L3 exit), in the wallet e2e
// harness's manner: headless Chromium drives /tokens/:mint, and a mock Wallet Standard wallet
// injected into the page signs with a local devnet test key held by this process
// (~/.config/lineage/devnet/launchpad-ui-test.json; the page only ever sees signatures). The test
// wallet is funded by the Lineage deployer (~/.config/lineage/devnet-deployer.json, passed
// explicitly; the global solana config is never read).
//
// For each mint (default: the most traded curve token and the graduated TGRAD token, so both DBC and
// DAMM v2 run): buy with tLINE, then sell half of what was bought. After each trade the balances are
// read back from chain and must equal the page's simulated quote, the page's balances must equal
// chain, and the market indexer must report the trade with the same amounts; the page's trade list
// must then show it. Every transaction is logged in onchain/DEVNET.md under this lane's section.
//
// playwright-core is not a repo dependency: pass its location.
// Usage: bun scripts/launchpad/trade-e2e.ts --pw <dir> [--port 9665] [--core http://127.0.0.1:9662]
//        [--market http://127.0.0.1:9668] [--mints <mint>,<mint>] [--buy 50] [--shots <dir>]
import { spawn, spawnSync } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, ChainReader, loadKeypair, loadOrCreateKeypair, Rpc, sendAndConfirm, signBytes, system, token, TOKEN_2022_PROGRAM } from "@lineage/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import { units } from "../../apps/web/wallet/chain.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const PORT = Number(arg("port", "9665"));
const CORE = arg("core", "http://127.0.0.1:9662")!;
const MARKET = arg("market", "http://127.0.0.1:9668")!.replace(/\/+$/, "");
const BUY = arg("buy", "50")!;
const SHOTS = arg("shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ROOT = join(import.meta.dir, "..", "..");
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const GRADUATED = "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz";
const T22 = TOKEN_2022_PROGRAM;
const T0 = Date.now();
const log = (m: string) => console.log(`[trade-e2e +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const busy = spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim();
if (busy) throw new Error(`port ${PORT} busy (pid ${busy}); pick another in 9662-9669`);

// ---------------------------------------------------------------- devnet log (own section)
const DEVNET_MD = join(ROOT, "onchain", "DEVNET.md");
const HEAD = "## Launchpad pages (L3): token page trades";
const txs: { what: string; sig: string; fee: number | string }[] = [];
function logTx(what: string, sig: string, fee?: number | string) {
  txs.push({ what, sig, fee: fee ?? "?" });
  let md = readFileSync(DEVNET_MD, "utf8");
  if (!md.includes(HEAD)) {
    appendFileSync(DEVNET_MD, `\n${HEAD}\n\nDevnet transactions sent through the token page's trade box (apps/web/wallet/trade.ts) by scripts/launchpad/trade-e2e.ts: headless Chromium with a mock Wallet Standard wallet signing with the test key ~/.config/lineage/devnet/launchpad-ui-test.json, funded by the Lineage deployer. TEST tokens only. Fee in lamports as returned by the RPC.\n\n| When (UTC) | What | Fee | Signature |\n|---|---|---|---|\n`);
    md = readFileSync(DEVNET_MD, "utf8");
  }
  const row = `| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | ${what.replace(/\|/g, "/")} | ${fee ?? "?"} | \`${sig}\` |\n`;
  // insert after the last row of this section's table (other lanes may have appended sections after it)
  const start = md.indexOf(HEAD);
  const next = md.indexOf("\n## ", start + HEAD.length);
  const end = next < 0 ? md.length : next + 1;
  const sec = md.slice(start, end);
  const lastRow = sec.lastIndexOf("\n|");
  const lineEnd = sec.indexOf("\n", lastRow + 1);
  const at = start + (lineEnd < 0 ? sec.length : lineEnd + 1);
  writeFileSync(DEVNET_MD, md.slice(0, at) + row + md.slice(at));
}

// ---------------------------------------------------------------- chain, test wallet, funding
const state = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
await assertDevnet(rpc);
const reader = new ChainReader(rpc);
const LINE = state.line_mint as string;
const QD = Number(state.line_decimals);
const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
const wallet = loadOrCreateKeypair(join(KEYS, "launchpad-ui-test.json")).key;
log(`test wallet ${wallet.id}`);
const solNow = await rpc.getBalance(wallet.id);
if (solNow < 60_000_000n) {
  const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, wallet.id, 100_000_000n - solNow)]);
  logTx(`fund the test wallet ${wallet.id} with ${Number(100_000_000n - solNow) / 1e9} SOL from the deployer`, r.signature, r.fee);
}
const LINE_TOP = 1_000n * 10n ** BigInt(QD);
const lineNow = (await reader.tokenBalance(ata(wallet.id, LINE, T22))) ?? 0n;
if (lineNow < LINE_TOP / 2n) {
  const r = await sendAndConfirm(rpc, dep, [
    token.createAtaIdempotent(dep.id, wallet.id, LINE, T22),
    token.transferChecked(ata(dep.id, LINE, T22), LINE, ata(wallet.id, LINE, T22), dep.id, LINE_TOP - lineNow, QD, T22),
  ]);
  logTx(`fund the test wallet with ${units(LINE_TOP - lineNow, QD)} tLINE from the deployer`, r.signature, r.fee);
}

const tokens = (await (await fetch(`${MARKET}/market/tokens`)).json()).tokens as any[];
const curveMint = tokens.filter((t) => t.phase === "curve").sort((a, b) => b.trades - a.trades)[0]?.mint;
const MINTS = arg("mints")?.split(",") ?? [curveMint, GRADUATED].filter(Boolean);

// ---------------------------------------------------------------- web server and browser
const web = spawn(["bun", join(ROOT, "apps/web/server.ts"), "--port", String(PORT), "--core", CORE, "--market", MARKET], { stdout: "pipe", stderr: "pipe", cwd: ROOT });
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/chain/config`).then((r) => r.ok).catch(() => false)) break;
  await Bun.sleep(500);
}
const BASE = `http://127.0.0.1:${PORT}`;
const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await chromium.launch(existsSync(exe) ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: "light" });
await ctx.exposeFunction("__lineageMockSign", (b64: string) => {
  // the "person" approves: sign the message as the test key. The page never sees this key.
  const wire = new Uint8Array(Buffer.from(b64, "base64"));
  const { message } = parseWire(wire);
  return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, message))).toString("base64");
});
await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction"], label: "test" };
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
        supportedTransactionVersions: ["legacy"],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await (window as any).__lineageMockSign(b64(i.transaction))) }))),
      },
    },
  };
  window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
}, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
page.on("console", (m: any) => {
  if (m.type() === "error") errors.push(m.text());
});
const T = 120_000;

async function balances(mint: string) {
  const [l, a] = await Promise.all([reader.tokenBalance(ata(wallet.id, LINE, T22)), reader.tokenBalance(ata(wallet.id, mint, T22))]);
  return { line: l ?? 0n, tok: a ?? 0n };
}

async function indexed(mint: string, sig: string): Promise<any | null> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${MARKET}/market/tokens/${mint}/trades?limit=50`).then((x) => x.json()).catch(() => null);
    const t = r?.trades?.find((x: any) => x.signature === sig);
    if (t) return t;
    await Bun.sleep(3000);
  }
  return null;
}

async function trade(mint: string, sym: string, decimals: number, side: "buy" | "sell", amount: string, venue: string) {
  await page.click(`[data-tb="side"][data-side="${side}"]`);
  await page.fill('[name="tb_amount"]', amount);
  await page.click('[data-tb="review"]');
  await page.locator("[data-quote-out]").waitFor({ timeout: T });
  const out = BigInt((await page.locator("[data-quote-out]").getAttribute("data-quote-out"))!);
  const before = await balances(mint);
  await page.click('[data-tb="sign"]');
  await page.locator(".mk-tb-done").waitFor({ timeout: T });
  const sig = (await page.locator(".mk-tb-done").getAttribute("data-sig"))!;
  const after = await balances(mint);
  const tx = await rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
  logTx(`${side} ${side === "buy" ? `${amount} tLINE of ${sym}` : `${amount} ${sym}`} on ${venue} through /tokens/${mint} (test wallet ${wallet.id.slice(0, 6)}...)`, sig, tx?.meta?.fee);
  const inBase = side === "buy" ? BigInt(Math.round(Number(amount) * 10 ** QD)) : BigInt(Math.round(Number(amount) * 10 ** decimals));
  const dIn = side === "buy" ? before.line - after.line : before.tok - after.tok;
  const dOut = side === "buy" ? after.tok - before.tok : after.line - before.line;
  check(`${sym} ${side} on ${venue}: confirmed, chain balances moved by the amount in and the simulated out`, dIn === inBase && dOut === out, `${sig.slice(0, 10)}..., in ${dIn}, out ${dOut}, quoted ${out}`);
  const shown = (await page.locator(side === "buy" ? '[data-bal="token"]' : '[data-bal="line"]').innerText()).trim();
  const want = units(side === "buy" ? after.tok : after.line, side === "buy" ? decimals : QD);
  check(`${sym} ${side}: page balance equals chain after the trade`, shown === want, `${shown} vs ${want}`);
  const ix = await indexed(mint, sig);
  check(`${sym} ${side}: the indexer reports it with the same amounts`, !!ix && ix.side === side && BigInt(ix.base_raw) === (side === "buy" ? dOut : dIn) && BigInt(ix.quote_raw) === (side === "buy" ? dIn : dOut),
    ix ? `${ix.side} base ${ix.base_raw} quote ${ix.quote_raw} venue ${ix.venue}` : "not indexed within 120 s");
  // the page refreshes in place after a trade; wait for the row
  const row = await page.locator(`#mk-trades tr[data-sig="${sig}"]`).waitFor({ timeout: 60_000 }).then(() => true, () => false);
  check(`${sym} ${side}: the page's trade list shows it`, row);
  return { sig, dOut };
}

try {
  for (const mint of MINTS) {
    const t = await (await fetch(`${MARKET}/market/tokens/${mint}`)).json();
    const sym = t.symbol ?? mint.slice(0, 6);
    const venue = t.phase === "graduated" ? "DAMM v2" : "DBC";
    await page.goto(`${BASE}/tokens/${mint}`);
    await page.locator(`[data-tb="connect"][data-name="Lineage Test Wallet"], [data-bal="line"]`).first().waitFor({ timeout: 60_000 });
    if (await page.locator('[data-tb="connect"]').count()) await page.click('[data-tb="connect"][data-name="Lineage Test Wallet"]');
    await page.locator('[data-bal="line"]').waitFor({ timeout: T });
    const b0 = await balances(mint);
    const lineShown = (await page.locator('[data-bal="line"]').innerText()).trim();
    check(`${sym}: page shows the wallet's tLINE as chain does`, lineShown === units(b0.line, QD), `${lineShown} vs ${units(b0.line, QD)}`);
    const v = await page.locator(".mk-tb-venue").innerText();
    check(`${sym}: venue ${venue}`, venue === "DAMM v2" ? /DAMM v2/.test(v) : /DBC curve/.test(v), v.replace(/\s+/g, " "));
    const buy = await trade(mint, sym, t.decimals, "buy", BUY, venue);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `trade-${sym}-bought.png`), fullPage: false });
    const half = buy.dOut / 2n;
    const sellAmt = units(half, t.decimals).replace(/,/g, "");
    await trade(mint, sym, t.decimals, "sell", sellAmt, venue);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `trade-${sym}-sold.png`), fullPage: true });
  }
  check("no page errors during the trades", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("run completed", false, String((e as Error).stack ?? e));
} finally {
  await browser.close();
  web.kill();
}
const pass = results.filter((r) => r.ok).length;
log(`${pass}/${results.length} checks passed`);
writeFileSync(join(import.meta.dir, "TRADE-E2E-LAST.json"), JSON.stringify({ at: new Date().toISOString(), wallet: wallet.id, mints: MINTS, pass, total: results.length, results, transactions: txs }, null, 2));
process.exit(pass === results.length ? 0 : 1);
