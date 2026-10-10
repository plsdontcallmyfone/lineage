#!/usr/bin/env bun
// Devnet v2 (pump.fun): real buys and sells through the LIVE site's token page trade box, headless
// (never the owner's Chrome). A mock Wallet Standard wallet injected into the page signs with a local
// devnet test key held by this process (~/.config/lineage/devnet/launchpad-ui-test.json); it connects
// through the returning-visitor path (localStorage "lineage-wallet", as tests/ui does). The test
// wallet's SOL comes from the Lineage deployer and its tLINE from the devnet treasury (keys passed
// explicitly). For each mint: buy with tLINE on the pump.fun curve, then sell half of what was bought;
// chain balances must move by the amount in and the page's simulated out, the page must show chain's
// balances, and the site's indexer must report each trade with the same amounts.
// Transactions are written to scripts/devnet/TRADE-V2-LAST.json and onchain/DEVNET.md (Devnet v2).
//
//   bun scripts/devnet/trade-v2-e2e.ts --pw <dir with node_modules/playwright-core> [--site https://157-245-71-188.sslip.io]
//        [--mints <mint>,...] [--buy 50]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, loadOrCreateKeypair, sendAndConfirm, signBytes, system, token, TOKEN_2022_PROGRAM } from "@lineage/chain";
import { parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
// the wallet's formatter (apps/web/wallet/chain.ts units), inlined: that module needs a browser
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function units(base: bigint, decimals: number): string {
  const neg = base < 0n, v = neg ? -base : base, scale = 10n ** BigInt(decimals);
  const f = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${group((v / scale).toString())}${f ? "." + f : ""}`;
}
import { deployer, key, loadState, logTx as devnetLog, reader, rpc } from "./lib.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const SITE = arg("site", "https://157-245-71-188.sslip.io")!.replace(/\/+$/, "");
const BUY = arg("buy", "50")!;
const T22 = TOKEN_2022_PROGRAM;
const T0 = Date.now();
const log = (m: string) => console.log(`[trade-v2 +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const txs: { what: string; sig: string; fee: number | null }[] = [];
const note = (what: string, sig: string, fee: number | null | undefined) => {
  txs.push({ what, sig, fee: fee ?? null });
  devnetLog("trade box", what, { signature: sig, fee: fee ?? undefined, slot: 0, logs: [] });
};

const state = loadState();
const LINE = state.line_mint!;
const QD = 6;
const dep = deployer();
const treasury = key("tline-pump-treasury");
const wallet = loadOrCreateKeypair(join(homedir(), ".config", "lineage", "devnet", "launchpad-ui-test.json")).key;
log(`test wallet ${wallet.id}; site ${SITE}`);
const solNow = await rpc.getBalance(wallet.id);
if (solNow < 60_000_000n) {
  const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, wallet.id, 100_000_000n - solNow)]);
  note(`fund the trade test wallet ${wallet.id} with ${Number(100_000_000n - solNow) / 1e9} SOL from the deployer`, r.signature, r.fee);
}
const LINE_TOP = 1_000n * 10n ** BigInt(QD);
const lineNow = (await reader.tokenBalance(ata(wallet.id, LINE, T22))) ?? 0n;
if (lineNow < LINE_TOP / 2n) {
  const r = await sendAndConfirm(rpc, dep, [
    token.createAtaIdempotent(dep.id, wallet.id, LINE, T22),
    token.transferChecked(ata(treasury.id, LINE, T22), LINE, ata(wallet.id, LINE, T22), treasury.id, LINE_TOP - lineNow, QD, T22),
  ], { signers: [treasury] });
  note(`send ${units(LINE_TOP - lineNow, QD)} tLINE to the trade test wallet from the devnet treasury`, r.signature, r.fee);
}

const listed = ((await (await fetch(`${SITE}/market/tokens`)).json()).tokens ?? []) as any[];
const MINTS = arg("mints")?.split(",") ?? listed.filter((t) => t.venue === "pump").map((t) => t.mint).slice(0, 2);

const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await chromium.launch(existsSync(exe) ? { executablePath: exe, headless: true } : { headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: "light" });
const WALLET_NAME = "Lineage Test Wallet";
await ctx.exposeFunction("__lineageMockSign", (b64: string) => {
  const wire = new Uint8Array(Buffer.from(b64, "base64"));
  const { message } = parseWire(wire);
  return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, message))).toString("base64");
});
await ctx.addInitScript(({ address, pub, name }: { address: string; pub: number[]; name: string }) => {
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction"], label: "test" };
  const w = {
    version: "1.0.0", name,
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
    },
  };
  window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
}, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)), name: WALLET_NAME });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
const T = 120_000;

async function balances(mint: string) {
  const [l, a] = await Promise.all([reader.tokenBalance(ata(wallet.id, LINE, T22)), reader.tokenBalance(ata(wallet.id, mint, T22))]);
  return { line: l ?? 0n, tok: a ?? 0n };
}
async function indexed(mint: string, sig: string): Promise<any | null> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${SITE}/market/tokens/${mint}/trades?limit=50`).then((x) => x.json()).catch(() => null);
    const t = r?.trades?.find((x: any) => x.signature === sig);
    if (t) return t;
    await Bun.sleep(3000);
  }
  return null;
}
async function trade(mint: string, sym: string, decimals: number, side: "buy" | "sell", amount: string) {
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
  note(`${side} ${side === "buy" ? `${amount} tLINE of ${sym}` : `${amount} ${sym}`} on the pump.fun curve through ${SITE}/tokens/${mint} (headless, test wallet ${wallet.id.slice(0, 6)}...)`, sig, tx?.meta?.fee);
  const inBase = side === "buy" ? BigInt(Math.round(Number(amount) * 10 ** QD)) : BigInt(Math.round(Number(amount) * 10 ** decimals));
  const dIn = side === "buy" ? before.line - after.line : before.tok - after.tok;
  const dOut = side === "buy" ? after.tok - before.tok : after.line - before.line;
  check(`${sym} ${side}: confirmed, chain moved by the amount in and the simulated out`, dIn === inBase && dOut === out, `${sig.slice(0, 10)}..., in ${dIn}, out ${dOut}, quoted ${out}`);
  const ix = await indexed(mint, sig);
  check(`${sym} ${side}: the site's indexer reports it with the same amounts`, !!ix && ix.side === side && BigInt(ix.base_raw) === (side === "buy" ? dOut : dIn) && BigInt(ix.quote_raw) === (side === "buy" ? dIn : dOut),
    ix ? `${ix.side} base ${ix.base_raw} quote ${ix.quote_raw} venue ${ix.venue}` : "not indexed within 120 s");
  return { sig, dOut };
}

try {
  for (const mint of MINTS) {
    const t = await (await fetch(`${SITE}/market/tokens/${mint}`)).json();
    const sym = t.symbol ?? mint.slice(0, 6);
    await page.goto(`${SITE}/tokens/${mint}`);
    await page.evaluate((n: string) => localStorage.setItem("lineage-wallet", n), WALLET_NAME);
    await page.reload();
    await page.locator('[data-bal="line"]').waitFor({ timeout: T });
    const b0 = await balances(mint);
    const lineShown = (await page.locator('[data-bal="line"]').innerText()).trim();
    check(`${sym}: page shows the wallet's tLINE as chain does`, lineShown === units(b0.line, QD), `${lineShown} vs ${units(b0.line, QD)}`);
    const v = await page.locator(".mk-tb-venue").innerText();
    check(`${sym}: the trade box trades on the pump.fun curve`, /curve/i.test(v), v.replace(/\s+/g, " "));
    const buy = await trade(mint, sym, t.decimals ?? 6, "buy", BUY);
    const half = buy.dOut / 2n;
    await trade(mint, sym, t.decimals ?? 6, "sell", units(half, t.decimals ?? 6).replace(/,/g, ""));
  }
  check("no page errors during the trades", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("run completed", false, String((e as Error).stack ?? e));
} finally {
  await browser.close();
}
const pass = results.filter((r) => r.ok).length;
log(`${pass}/${results.length} checks passed`);
writeFileSync(join(import.meta.dir, "TRADE-V2-LAST.json"), JSON.stringify({ at: new Date().toISOString(), site: SITE, wallet: wallet.id, mints: MINTS, pass, total: results.length, results, transactions: txs }, null, 2) + "\n");
process.exit(pass === results.length ? 0 : 1);
void readFileSync;
