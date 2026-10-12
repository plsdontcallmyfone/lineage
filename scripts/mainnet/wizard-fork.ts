#!/usr/bin/env bun
// The mainnet-mode browser path, end to end, on the mainnet fork (docs/MAINNET-RUNBOOK.md "Mainnet
// test"): a local Core, market indexer, dashboard and site gate run under the mainnet profile with the
// test deployment's overlay and the fork as their RPC, and headless Chromium drives the real Launch
// wizard and the trade box with a mock Wallet Standard wallet. What it exercises that the instruction
// level rehearsal (test-rehearsal.ts) cannot: the page's own plan (SOL only, the quote coin bought on
// its pump.fun curve), one approval for every transaction (one signTransaction request), the mainnet
// send path through /chain/rpc, the fallback to ordered sends when Jito does not take the bundle, and
// the trade box paying in SOL through pump.fun's multi_hop_swap.
//
// Fork testing only: the profile overlay written here names the FORK's genesis, so every genesis
// check (services, /chain/rpc, the page's cluster gate) matches the fork. An overlay with a wrong
// genesis on a real endpoint makes all of them refuse, so the field cannot weaken a real deployment.
// Jito is a local stub (UNITS_JITO_URL): it answers getTipAccounts and refuses sendBundle, so no fork
// transaction is ever sent to Jito's block engine; a real bundle (all or nothing) stays unproven off
// mainnet. Nothing is sent to mainnet; the soul draft is answered from a recorded soul (no model spend).
//
// Needs the fork with the test deployment up to `fund` (scripts/mainnet/test.ts keys, coin, deploy,
// init, fund with --rpc http://127.0.0.1:9690 --keys <dir> --out <dir>/out).
//
//   UNITS_NETWORK=mainnet bun scripts/mainnet/wizard-fork.ts --keys <fork key dir> [--shots <dir>]
//
// Ports (checked free first): Core 9694, dashboard 9695, gate 9696, Jito stub 9697, indexer 9698.
import { spawn, spawnSync, type Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { bytesToHex, checkMetadataUri, coinImageId, coinMetadataUri, sha256 } from "@units/chain";
import { readMint } from "../../packages/indexer/src/accounts.ts";
import { ata, ChainReader, decodeBondingCurve, JITO_BLOCK_ENGINE, launchPdas, loadKeypair, pumpPdas, Rpc, sendAndConfirm, signBytes, system, TOKEN_2022_PROGRAM } from "@units/chain";
import { creditsAtPrice, usdToBase, decodePumpFeeConfig, decodePumpGlobal, pump, PUMP, quoteCurveBuyExactIn, token } from "@units/chain";
import { decodeMessage, parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import { useActiveProfile } from "./steps.ts";
import { useTestProfile } from "./test-steps.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const ROOT = join(import.meta.dir, "..", "..");
const KEYS = arg("keys") ?? (() => { throw new Error("--keys <fork key dir> required"); })();
const SHOTS = arg("shots");
const FORK = "http://127.0.0.1:9690";
const PORTS = { core: 9694, web: 9695, gate: 9696, jito: 9697, indexer: 9698 };
const T22 = TOKEN_2022_PROGRAM;
const T0 = Date.now();
const log = (m: string) => console.log(`[wizard-fork +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail: detail.slice(0, 400) });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  return ok;
};
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// --official: the launch's own program ids (the go-live proof, golive-fork.ts) with --state-dir <dir holding state.json and
// profile.local.json, as `golive.ts switch --no-identity` writes them>, --record <file>, --wallet-sol <SOL>
// --move-price-sol <SOL> (official only): before the wizard is opened the funder key buys that much of the quote coin on its
// pump.fun curve, so the coin's price is no longer the one in the state file and the launch credits (prepay rate_source
// "market") must come from the indexer's live reading. The record's launch.credits holds the deposit and the prices.
const OFFICIAL = process.argv.includes("--official");
if (OFFICIAL) useActiveProfile();
else useTestProfile();
const STATE_DIR = arg("state-dir") ?? join(KEYS, "out");
const RECORD = arg("record") ?? join(import.meta.dir, "WIZARD-FORK-LAST.json");
const WALLET_LAMPORTS = BigInt(Math.round(Number(arg("wallet-sol") ?? "0.4") * 1e9));
const MOVE_PRICE_LAMPORTS = OFFICIAL && arg("move-price-sol") ? BigInt(Math.round(Number(arg("move-price-sol")) * 1e9)) : 0n;
if (!OFFICIAL && arg("move-price-sol")) throw new Error("--move-price-sol needs --official");
const rpc = Rpc.http(FORK, "confirmed");
const genesis = await rpc.call<string>("getGenesisHash");
if (genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("refusing: the endpoint is mainnet, this check runs on a local fork only");
for (const p of Object.values(PORTS)) if (spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim()) throw new Error(`port ${p} is taken`);
const reader = new ChainReader(rpc);
const state = JSON.parse(readFileSync(join(STATE_DIR, OFFICIAL ? "state.json" : "mainnet.json"), "utf8"));
const overlay = JSON.parse(readFileSync(join(STATE_DIR, "profile.local.json"), "utf8"));
const coin = state.line_mint as string;
const dep = loadKeypair(join(KEYS, "deployer.json"));

// ---------------------------------------------------------------- the local instance on the fork
const tmp = mkdtempSync(join(tmpdir(), "units-wizard-fork-"));
writeFileSync(join(tmp, "state.json"), JSON.stringify(state));
// FORK TEST overlay: the test deployment's overlay plus the fork's genesis and this run's state file
overlay.profiles.mainnet.genesis = genesis;
overlay.profiles.mainnet.state_file = join(tmp, "state.json");
writeFileSync(join(tmp, "profile.local.json"), JSON.stringify(overlay));
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const { prepay: prepayOver, ...restOver } = (state.network_overrides ?? {}) as Record<string, any>;
Object.assign(net, restOver, { prepay: { ...net.prepay, ...(prepayOver ?? {}) } });
net.chain = { mode: "mainnet", rpc_url: "from-environment:UNITS_MAINNET_RPC", registry_program: state.registry_program, launch_program: state.launch_program, line_mint: coin, poll_ms: 3_000 };
writeFileSync(join(tmp, "network.json"), JSON.stringify(net), { mode: 0o600 });
const admin = generateAgentKey();
writeFileSync(join(tmp, "admin.json"), JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });

// Jito stand-in: the real tip accounts (read from Jito, they exist on mainnet; on the fork each is given
// lamports so a small tip is rent-exempt) and a refusal for every bundle
const tipAccounts = ((await fetch(JITO_BLOCK_ENGINE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }) })
  .then((r) => r.json()).catch(() => null)) as { result?: string[] } | null)?.result ?? [];
if (!tipAccounts.length) throw new Error("Jito gave no tip accounts (needed to build the tip as the wizard does)");
for (const a of tipAccounts) if ((await rpc.getBalance(a)) === 0n) await rpc.call("requestAirdrop", [a, 1_000_000_000]);
const bundles: number[] = [];
const jito = Bun.serve({ port: PORTS.jito, hostname: "127.0.0.1", fetch: async (req) => {
  const b = (await req.json().catch(() => ({}))) as { method?: string; params?: unknown[]; id?: unknown };
  if (b.method === "getTipAccounts") return Response.json({ jsonrpc: "2.0", id: b.id, result: tipAccounts });
  if (b.method === "sendBundle") {
    bundles.push(Array.isArray(b.params?.[0]) ? (b.params![0] as unknown[]).length : 0);
    return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "bundle refused by the fork stand-in for Jito" } });
  }
  return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "not served by the fork stand-in" } });
} });

const env: Record<string, string | undefined> = { ...process.env, UNITS_NETWORK: "mainnet", UNITS_PROFILE_LOCAL: join(tmp, "profile.local.json"), UNITS_MAINNET_RPC: FORK, UNITS_JITO_URL: `http://127.0.0.1:${PORTS.jito}`,
  UNITS_HOME: join(tmp, "home"), UNITS_PORT_BLOCK: "9690-9699" };
// official: Core copies the indexer's price reading once a minute (revenue.ts), which the market rate of the launch credits needs
if (OFFICIAL) env.UNITS_INDEXER_URL = `http://127.0.0.1:${PORTS.indexer}`;
const procs: Subprocess[] = [];
const logs = (name: string) => Bun.file(join(tmp, `${name}.log`));
const run = (name: string, cmd: string[]) => procs.push(spawn(cmd, { cwd: ROOT, env, stdout: logs(name), stderr: logs(name) }));
const CORE = `http://127.0.0.1:${PORTS.core}`, WEB = `http://127.0.0.1:${PORTS.web}`, BASE = `http://127.0.0.1:${PORTS.gate}`, MARKET = `http://127.0.0.1:${PORTS.indexer}`;
run("core", ["bun", "packages/core/src/main.ts", "--data", join(tmp, "data"), "--port", String(PORTS.core), "--config", join(tmp, "network.json"), "--admin-key", join(tmp, "admin.json"), "--tick-ms", "1000"]);
run("indexer", ["bun", "packages/indexer/src/main.ts", "--port", String(PORTS.indexer), "--db", join(tmp, "market.db"), "--interval", "3", "--min-gap-ms", "20", "--core", CORE]);
run("web", ["bun", "apps/web/server.ts", "--port", String(PORTS.web), "--core", CORE, "--market", MARKET]);
run("gate", ["bun", "scripts/deploy/gate.ts", "--port", String(PORTS.gate), "--web", WEB, "--core", CORE, "--indexer", MARKET, "--origin", BASE]);
const stop = () => {
  for (const p of procs) p.kill(); // each by its own handle (its PID), nothing by name
  jito.stop(true);
};
process.on("exit", stop);
const up = async (u: string) => fetch(u).then((r) => r.ok).catch(() => false);
let started = false;
for (let i = 0; i < 240 && !started; i++) {
  started = (await up(`${CORE}/v1/health`)) && (await up(`${WEB}/chain/config`)) && (await up(`${BASE}/gate/health`)) && (await up(`${MARKET}/market/summary`));
  if (!started) await Bun.sleep(500);
}
if (!started) {
  for (const n of ["core", "web", "gate", "indexer"]) console.error(`--- ${n} log tail\n${(await logs(n).text().catch(() => "")).split("\n").slice(-5).join("\n")}`);
  stop();
  throw new Error("the local instance did not start");
}

let outcome = "PASS";
const out: Record<string, unknown> = { fork_genesis: genesis, test_coin: coin };
try {
  const cc = (await fetch(`${BASE}/chain/config`).then((r) => r.json())) as any;
  check("the instance runs the mainnet profile on the fork: test program ids, the test coin as quote, Jupiter off, no faucet, no TEST labels",
    cc.profile?.network === "mainnet" && cc.profile.programs.registry === state.registry_program && cc.profile.quote.mint === coin && cc.profile.swap === false && cc.profile.faucet === false && cc.profile.test_labels === false &&
    cc.genesis === genesis, `quote ${cc.profile?.quote?.symbol}, programs ${cc.profile?.programs?.registry?.slice(0, 6)}..., genesis ${String(cc.genesis).slice(0, 8)}...`);
  const cfg = (await fetch(`${BASE}/v1/config`).then((r) => r.json())) as any;
  check("Core names no units account recipient (the option is not offered on the test instance)", cfg?.network?.prepay?.identity_account_recipient === null, `identity_account_recipient ${JSON.stringify(cfg?.network?.prepay?.identity_account_recipient)}`);

  // ---------------------------------------------------------------- official: the launch credits at the live price
  const prepayCfg = (cfg?.network?.prepay ?? {}) as Record<string, any>;
  const MARKET_RATE = OFFICIAL && prepayCfg.rate_source === "market";
  const DEC = Number(state.line_decimals ?? 6);
  const quoteUsd = async () => (await fetch(`${MARKET}/market/quote-usd`).then((r) => r.json()).catch(() => null)) as { ok?: boolean; usd?: number; read_at?: number; reason?: string } | null;
  let priceBefore: { usd: number; read_at: number } | null = null;
  let moved: Record<string, unknown> | null = null;
  if (OFFICIAL) {
    check("official: Core's prepay block prices the launch credits at the market (rate_source market, with the band, tolerance and window)",
      MARKET_RATE && typeof prepayCfg.rate_min_usd === "number" && typeof prepayCfg.rate_max_usd === "number" && Number.isInteger(prepayCfg.rate_tolerance_bps) && Number.isInteger(prepayCfg.rate_window_s),
      `rate_source ${prepayCfg.rate_source}, band ${prepayCfg.rate_min_usd} to ${prepayCfg.rate_max_usd} USD, max age ${prepayCfg.rate_max_age_s} s, tolerance ${prepayCfg.rate_tolerance_bps} bps, window ${prepayCfg.rate_window_s} s`);
    for (let i = 0; i < 120 && !priceBefore; i++) {
      const q = await quoteUsd();
      if (q?.ok && typeof q.usd === "number" && typeof q.read_at === "number") priceBefore = { usd: q.usd, read_at: q.read_at };
      else await Bun.sleep(1000);
    }
    check("official: the local indexer reads the quote coin's USD price from the fork (GET /market/quote-usd)", !!priceBefore, priceBefore ? `${priceBefore.usd} USD, read_at ${priceBefore.read_at}` : `${(await quoteUsd())?.reason ?? "no answer"}`);
  }
  if (MOVE_PRICE_LAMPORTS > 0n) {
    if (!priceBefore) throw new Error("--move-price-sol: the indexer gave no price to move from");
    // a buy on the quote coin's own pump.fun curve, as createTestCoin does (scripts/mainnet/test-steps.ts)
    const curveAddr = pumpPdas.bondingCurve(coin);
    const [gA, fcA, cA] = await rpc.getMultipleAccounts([PUMP.global, PUMP.feeConfig, curveAddr]);
    if (!gA || !fcA || !cA) throw new Error("--move-price-sol: pump.fun's Global, FeeConfig or the quote coin's curve is not on the fork");
    const c0 = decodeBondingCurve(cA.data);
    if (c0.complete) throw new Error("--move-price-sol: the quote coin's curve is complete (it trades on PumpSwap); this option buys on the curve only");
    const base = (await reader.tokenBalance(ata(curveAddr, coin, T22)))!;
    const q = quoteCurveBuyExactIn(decodePumpGlobal(gA.data), decodePumpFeeConfig(fcA.data), c0, MOVE_PRICE_LAMPORTS, base);
    if (q.completes || q.tokens <= 0n) throw new Error("--move-price-sol: that buy would complete the curve or buy nothing; use a smaller amount");
    const sent = await sendAndConfirm(rpc, dep, [token.createAtaIdempotent(dep.id, dep.id, coin, T22), pump.buyV3({ mint: coin, quoteMint: PUMP.wsol, user: dep.id, amount: q.tokens, maxQuoteIn: MOVE_PRICE_LAMPORTS })], { computeUnits: 300_000 });
    const boughtAt = Math.floor(Date.now() / 1000);
    let after: { usd: number; read_at: number } | null = null;
    for (let i = 0; i < 180 && !after; i++) {
      const r = await quoteUsd();
      if (r?.ok && typeof r.usd === "number" && typeof r.read_at === "number" && r.read_at > boughtAt) after = { usd: r.usd, read_at: r.read_at };
      else await Bun.sleep(1000);
    }
    const statePrice = typeof state.price_at_switch?.usd_per_units === "number" ? (state.price_at_switch.usd_per_units as number) : null;
    check("price move: the funder's curve buy landed and the indexer's next reading, taken after it, is higher than the one before and is not the state file's price",
      !!after && after.usd > priceBefore.usd && after.usd !== statePrice, `${priceBefore.usd} USD before, ${after?.usd ?? "no reading"} USD after ${Number(MOVE_PRICE_LAMPORTS) / 1e9} SOL; state file ${statePrice ?? "none"}`);
    moved = { sol: Number(MOVE_PRICE_LAMPORTS) / 1e9, signature: sent.signature, quote_coin_base_units: q.tokens.toString(),
      usd_before: priceBefore.usd, usd_after: after?.usd ?? null, read_at_after: after?.read_at ?? null, state_file_usd: statePrice };
  }

  // ---------------------------------------------------------------- a browser wallet with SOL only
  const wallet = generateAgentKey();
  await sendAndConfirm(rpc, dep, [system.transfer(dep.id, wallet.id, WALLET_LAMPORTS)]);
  const { chromium } = await import(join(ROOT, "node_modules/.bun/playwright-core@1.63.0/node_modules/playwright-core/index.mjs"));
  const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  const browser = await chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const requests: number[] = []; // how many transactions each wallet approval carried
  await ctx.exposeFunction("__mockSignAll", (b64s: string[]) => {
    requests.push(b64s.length);
    return b64s.map((b64) => {
      const wire = new Uint8Array(Buffer.from(b64, "base64"));
      const { message } = parseWire(wire);
      decodeMessage(message);
      return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, message))).toString("base64");
    });
  });
  await ctx.exposeFunction("__mockSignMsg", (b64: string) => Buffer.from(signBytes(wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64"));
  await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    // a returning visitor: the site reconnects the remembered wallet silently (the header's Connect opens the sign-in modal otherwise)
    try { localStorage.setItem("units-wallet", "units Test Wallet"); } catch {}
    const chains = ["solana:mainnet"];
    const account = { address, publicKey: new Uint8Array(pub), chains, features: ["solana:signTransaction", "solana:signMessage"], label: "test" };
    const w = {
      version: "1.0.0", name: "units Test Wallet", chains, accounts: [] as unknown[],
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
          // one call with several inputs is one approval for all of them
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
            ((await (window as any).__mockSignAll(inputs.map((i) => b64(i.transaction)))) as string[]).map((s) => ({ signedTransaction: unb64(s) })) },
        "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: { message: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__mockSignMsg(b64(i.message))) }))) },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
  }, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  // this instance has no identity service: the page must not ask for one
  const identityCalls: string[] = [];
  page.on("request", (r: any) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/identity/")) identityCalls.push(`${r.method()} ${u.pathname}`);
  });
  // the coin image the launcher picks (any PNG under 256 KB: the app's own icon file)
  const IMAGE = new Uint8Array(readFileSync(join(ROOT, "apps/web/public/favicon.png")));
  const IMAGE_SHA = bytesToHex(sha256(IMAGE));
  const proof = JSON.parse(readFileSync(join(ROOT, "scripts/souls/proof/soul-a.json"), "utf8"));
  await page.route("**/souls/draft", async (route: any) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc: { ...proof, agent: body.agent, seed: body.seed }, usd: 0, calls: 0, model: "claude-opus-5-5" }) });
  });
  // the hosted runtime reports which models can run; no runtime runs here, so the registry's default model is marked
  // pickable in the page's view (the launch itself does not depend on it: the choice is recorded in the soul)
  await page.route("**/api/models", async (route: any) => {
    const r = await route.fetch();
    const j = await r.json().catch(() => null);
    if (j?.registry && Array.isArray(j.models)) for (const m of j.models) if (m.provider === j.registry.default.provider && m.id === j.registry.default.id) Object.assign(m, { pickable: true, available: true });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  const shot = async (n: string) => SHOTS && page.screenshot({ path: join(SHOTS, `${n}.png`), fullPage: true });
  const text = async (sel: string) => (await page.locator(sel).innerText().catch(() => "")).replace(/\s+/g, " ");

  try {
    // ---------------------------------------------------------------- the Launch wizard
    await page.goto(`${BASE}/launch`);
    await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
    await page.fill('[name="l_name"]', "Fork Lamp");
    await page.fill('[name="l_symbol"]', "FLAMP");
    await page.fill('[name="l_desc"]', "A launch on a local fork of mainnet, through the real wizard. Nothing here is on mainnet.");
    await page.locator('[name="l_image"]').setInputFiles({ name: "coin.png", mimeType: "image/png", buffer: Buffer.from(IMAGE) });
    await page.click('[data-act="lz-next"]');
    await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
    await page.locator("#w-work .lz-rec, #w-work .banner").first().waitFor({ timeout: 90_000 });
    await page.click('[data-act="lz-next"]');
    await page.fill('[name="s_vibe"]', "plain, careful, quietly pleased by a smaller number");
    await page.fill('[name="s_specialty"]', "base58 encode and decode hot paths");
    await page.fill('[name="s_values"]', "measure before claiming, small reviewable diffs");
    await page.click('[data-act="soul-generate"]');
    await page.waitForSelector(".wl-soul .wl-hash, #w-soul [data-err]", { timeout: 120_000 });
    await page.click('[data-act="lz-next"]');
    await page.locator("#w-id-price").waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => /not offered/.test(document.querySelector("#w-id-price")?.textContent ?? ""), null, { timeout: 60_000 });
    check("wizard, Identity: \"A units account\" is not offered and cannot be picked; \"Your own token\" is selected",
      (await page.locator('input[name="l_identity"][value="purchased"]').isDisabled()) && (await page.locator('input[name="l_identity"][value="token"]').isChecked()), await text("#w-id-price"));
    await shot("4-identity");
    await page.click('[data-act="lz-next"]');
    await page.waitForFunction(() => /Total[\s\S]{0,40}?[\d.]+\s*SOL/.test((document.querySelector('[data-step="4"]') as HTMLElement | null)?.innerText ?? ""), null, { timeout: 120_000 });
    const funding = await text('[data-step="4"]');
    check("wizard, Funding: everything in SOL, no faucet and no Jupiter wording, no TEST label", /SOL/.test(funding) && !/faucet|Jupiter|TEST/.test(funding), funding.slice(0, 200));
    const whole = await text("#w-root, main");
    check("wizard: no devnet or TEST wording anywhere on the page under the mainnet profile", !/devnet|TEST tokens/i.test(whole), (whole.match(/.{0,60}(devnet|TEST tokens).{0,40}/i) ?? [""])[0]!);
    await shot("5-funding");
    await page.click('[data-act="lz-next"]');
    await page.locator("#w-launch-out .mark.good, #w-launch-out [data-err]").first().waitFor({ timeout: 180_000 });
    // textContent: the transaction list sits in a folded details element
    const review = ((await page.locator("#w-launch-out").evaluate((e: HTMLElement) => e.textContent ?? "").catch(() => "")) as string).replace(/\s+/g, " ");
    check("wizard, Review: the launch simulated on the mainnet profile; transactions planned as launch + soul, then SOL to the quote coin + initial buy + credits + tip",
      /simulation succeeded on mainnet/i.test(review) && /launch \+ soul/.test(review) && /sol-to-units \+ initial-buy \+ credits \+ tip/.test(review) && !/units-account/.test(review) && !/Jupiter swap/.test(review), (review.match(/Transactions.{0,200}/) ?? [review.slice(0, 300)])[0]!);
    check("wizard, Review: says one signature and one Jito bundle", /one signature/i.test(review) && /Jito bundle/i.test(review));
    // whether the permanent origin itself answers is the server's reading (GET /coin/origin); the page must say the same
    const originAnswers = ((await fetch(`${BASE}/coin/origin`).then((r) => r.json()).catch(() => null)) as { answers?: boolean } | null)?.answers === true;
    check(`wizard, Review: the coin's metadata URI names the permanent origin and the chosen image by its hash, read back before the review; the page says that origin ${originAnswers ? "answers" : "does not answer yet"}, as the server reads it`,
      review.includes(`https://app.units.gg/coin/`) && review.includes(`.json?i=${coinImageId(IMAGE_SHA)}`) &&
        (originAnswers ? /read back before this review: document and image answer/.test(review) && !/does not answer yet/.test(review) : /read back on this host; app\.units\.gg itself does not answer yet/.test(review) && /app\.units\.gg does not answer yet/.test(review)),
      (review.match(/Metadata URI.{0,220}/) ?? [""])[0]!);
    await shot("6-review");
    // market rate: the reading behind the amount in the built transactions, as the Review step carries it (wallet/prepay.ts builtRateNote)
    const built = MARKET_RATE ? await page.locator("#w-launch-out [data-credits-built]").first().evaluate((e: HTMLElement) => ({ usd: Number(e.dataset.usd), read_at: Number(e.dataset.readAt), base: e.dataset.base ?? "", text: e.textContent ?? "" })).catch(() => null) : null;
    const fundingRate = MARKET_RATE ? /of credits = [\d,.]+ \S+ at \$[\d.]+, read \d+ s ago/.test(funding) : false;
    const s0 = await rpc.getBalance(wallet.id);
    const n0 = requests.length;
    await page.locator('[data-act="launch-sign"]').click();
    await page.locator('[data-track="confirmed"][data-state="ok"], #w-launch-status [data-err], #w-launch-out [data-err]').first().waitFor({ timeout: 240_000 });
    const status = await text("#w-launch-status");
    await shot("7-launched");
    const mine = (await reader.launches()).filter((l) => l.launcher === wallet.id);
    check("launch: one approval carried every transaction of the launch (one signTransaction request)", requests.length - n0 === 1 && requests[n0]! >= 2, `requests ${JSON.stringify(requests.slice(n0))}`);
    check("launch: the bundle went to the Jito endpoint first, once, with the same transactions", bundles.length === 1 && bundles[0] === requests[n0], `bundles ${JSON.stringify(bundles)}`);
    check("launch: one AgentLaunch for the wallet on the fork (the ordered sends landed after Jito refused the bundle)", mine.length === 1, status.slice(0, 200));
    const l = mine[0];
    if (!l) throw new Error(`the launch did not land: ${status || (await text("#w-launch-out")).slice(-300)}`);
    const la = (await reader.agentLaunch(l.mint))!;
    const curve = decodeBondingCurve((await rpc.getAccountInfo(pumpPdas.bondingCurve(l.mint)))!.data);
    const bought = (await reader.tokenBalance(ata(l.agent, l.mint, T22))) ?? 0n;
    const vault = (await reader.tokenBalance(launchPdas.computeVault(l.agent))) ?? 0n;
    check("launch: the coin is quoted in the test coin, its creator is the agent's PDA, the 1% initial buy is in the agent key's account, the credits are in the vault and the agent is awake",
      curve.quoteMint === coin && curve.creator === launchPdas.pumpCreator(l.agent) && bought === curve.tokenTotalSupply / 100n && vault > 0n && la.awake === true, `bought ${bought}, vault ${vault}`);
    check("launch: the soul digest is on chain", !!(await reader.agent(l.agent))?.profileDigest);
    // the coin's metadata: the URI on chain, and what it resolves to on this instance (the permanent origin has no DNS record here)
    const onChain = readMint((await rpc.getAccountInfo(l.mint))!.data);
    const wantUri = coinMetadataUri("https://app.units.gg", l.mint, coinImageId(IMAGE_SHA));
    check("metadata: the URI on chain is <metadata origin>/coin/<mint>.json?i=<the chosen image's hash>", onChain.uri === wantUri, `${onChain.uri}`);
    const walked = await checkMetadataUri(onChain.uri ?? "", { via: (u) => u.replace("https://app.units.gg", BASE), expect: { name: onChain.name ?? "", symbol: onChain.symbol ?? "" } });
    check("metadata: the URI (as on chain, no preview query) resolves through the gate to the coin's document, built from chain, and its image is the chosen file byte for byte",
      walked.ok && walked.image?.sha256 === IMAGE_SHA && walked.metadata?.name === "Fork Lamp" && walked.metadata?.symbol === "FLAMP" && walked.metadata?.image === `https://app.units.gg/coin/image/${coinImageId(IMAGE_SHA)}`,
      walked.ok ? JSON.stringify(walked.metadata) : `${walked.problem}`);
    const again = await fetch(`${BASE}/social/media/${l.agent}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ statement: { v: 1, kind: "units-media", agent: l.agent, slot: "coin", sha256: IMAGE_SHA, type: "image/png", size: IMAGE.length, signer: l.agent, created_at: Math.floor(Date.now() / 1000), nonce: "wizardfork01" }, sig: "1".repeat(88), data: Buffer.from(IMAGE).toString("base64") }) });
    check("metadata: a later coin image upload for the launched agent is refused", again.status >= 400, `HTTP ${again.status}`);
    let avatar: any = null;
    for (let i = 0; i < 40 && !avatar; i++) {
      avatar = ((await fetch(`${BASE}/v1/agents/${l.agent}/profile`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as any)?.media?.avatar ?? null;
      if (!avatar) await Bun.sleep(1500);
    }
    check("metadata: the agent's avatar in Core is the same image", avatar?.sha256 === IMAGE_SHA, JSON.stringify(avatar));
    check("no identity service on this instance: no GitHub account row after the launch and no request to /identity/*",
      (await page.locator('[data-track="github"]').count()) === 0 && (await page.locator("#w-gh-launch").count()) === 0 && identityCalls.length === 0 && !/identity service/i.test(await text("#w-launch-out")), identityCalls.slice(0, 3).join(", "));
    const spent = s0 - (await rpc.getBalance(wallet.id));
    check("launch: the wallet paid in SOL only and holds no more than the slippage remainder of the test coin", spent > 0n && (OFFICIAL || ((await reader.tokenBalance(ata(wallet.id, coin, T22))) ?? 0n) < 100_000n * 1_000_000n), `${(Number(spent) / 1e9).toFixed(9)} SOL at the fork's rent`);
    out.launch = { agent: l.agent, mint: l.mint, wallet_sol_spent_fork_lamports: spent.toString(), approvals: requests.slice(n0), bundle_sizes: bundles };
    if (MARKET_RATE) {
      // the credits at the live price: what went into the vault, at which reading, and Core's own check of it
      const minUsd = String(prepayCfg.min_usd), tol = Number(prepayCfg.rate_tolerance_bps), lo = Number(minUsd) * (1 - tol / 10_000), hi = Number(minUsd) * (1 + tol / 10_000);
      const usdOf = (price: number | null | undefined) => (typeof price === "number" ? (Number(vault) / 10 ** DEC) * price : null);
      check("credits: Funding and Review show the rate and the reading's age, and Review carries the reading the built amount used", fundingRate && !!built && built.usd > 0 && built.read_at > 0, built?.text ?? funding.slice(0, 200));
      check("credits: the vault holds exactly the amount the page built, which is the minimum at the page's reading (ceil(min_usd / price))",
        !!built && vault.toString() === built.base && vault === creditsAtPrice(minUsd, built.usd, DEC), `vault ${vault}, built ${built?.base}, ${minUsd} USD at ${built?.usd}`);
      const pageUsd = usdOf(built?.usd);
      check(`credits: the deposit is worth ${minUsd} USD at the reading the page used (never less, and under a millionth more)`, pageUsd !== null && pageUsd >= Number(minUsd) - 1e-9 && pageUsd <= Number(minUsd) * 1.000001, `${pageUsd} USD`);
      const launchTime = Number(l.createdAt);
      const atTime = (await fetch(`${MARKET}/market/quote-usd?at=${launchTime}`).then((r) => r.json()).catch(() => null)) as { ok?: boolean; usd?: number; read_at?: number } | null;
      const nowQ = await quoteUsd();
      const judged = atTime?.ok && typeof atTime.usd === "number" ? { usd: atTime.usd, read_at: atTime.read_at ?? null, which: "the indexer's stored sample for the launch's time" }
        : nowQ?.ok && typeof nowQ.usd === "number" ? { usd: nowQ.usd, read_at: nowQ.read_at ?? null, which: "the indexer's current reading" } : null;
      const depositUsd = usdOf(judged?.usd);
      check(`credits: at ${judged?.which ?? "the indexer's reading"} the deposit is within ${tol} bps of ${minUsd} USD`, depositUsd !== null && depositUsd >= lo && depositUsd <= hi, `${depositUsd} USD at ${judged?.usd} (read_at ${judged?.read_at})`);
      if (moved) {
        const statePrice = moved.state_file_usd as number | null;
        const staticBase = usdToBase(minUsd, String(state.network_overrides?.prepay?.line_per_usd ?? prepayCfg.line_per_usd_config), DEC);
        check("credits: after the price move the deposit is not the state file's static amount (min_usd x line_per_usd) and was priced above the state file's price",
          vault !== staticBase && !!built && (statePrice === null || built.usd > statePrice) && built.usd >= (moved.usd_after as number) * 0.999, `vault ${vault}, static ${staticBase}; page price ${built?.usd}, state file ${statePrice}, after the move ${moved.usd_after}`);
      }
      // Core reads the launch on its chain sync and judges the deposit at the readings it held around the launch's time (pending until it has one)
      let cp: any = null;
      for (let i = 0; i < 100; i++) {
        cp = await fetch(`${CORE}/v1/agents/${l.agent}/prepay`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (cp?.checked && cp.pending === false) break;
        await Bun.sleep(2000);
      }
      const coreUsd = cp?.rate?.usd_per_token as number | null | undefined;
      check("credits: Core's check of the deposit (GET /v1/agents/<agent>/prepay) says ok, judged at a stored price inside the band, with the minimum at that price",
        cp?.checked === true && cp.ok === true && cp.pending === false && cp.deposit === vault.toString() && cp.rate?.state === "market" && typeof coreUsd === "number" && coreUsd >= prepayCfg.rate_min_usd && coreUsd <= prepayCfg.rate_max_usd &&
          BigInt(cp.min ?? "0") <= vault && cp.rate.tolerance_bps === tol,
        JSON.stringify({ ok: cp?.ok, pending: cp?.pending, deposit: cp?.deposit, min: cp?.min, rate: cp?.rate }));
      (out.launch as Record<string, unknown>).credits = {
        min_usd: minUsd, tolerance_bps: tol, window_s: prepayCfg.rate_window_s, band_usd: [prepayCfg.rate_min_usd, prepayCfg.rate_max_usd], price_move: moved,
        vault_deposit_base_units: vault.toString(), decimals: DEC, launch_time: launchTime,
        page_reading: built ? { usd: built.usd, read_at: built.read_at, built_base_units: built.base, deposit_usd: pageUsd } : null,
        indexer_reading: judged, deposit_usd: depositUsd,
        core: cp ? { ok: cp.ok, pending: cp.pending ?? null, deposit: cp.deposit, min: cp.min, rate: cp.rate ?? null } : null,
      };
    }

    // ---------------------------------------------------------------- the trade box, paid in SOL
    for (let i = 0; i < 60; i++) {
      const t = (await fetch(`${MARKET}/market/tokens/${l.mint}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as any;
      if (t && (t.mint || t.token)) break;
      await Bun.sleep(1000);
    }
    await page.goto(`${BASE}/tokens/${l.mint}`);
    await page.locator(".mk-tb2").waitFor({ timeout: 90_000 });
    await page.locator('[data-tb="gear"]').click();
    const opts = await page.locator('select[name="tb_pay"] option').evaluateAll((els: HTMLOptionElement[]) => els.map((e) => `${e.value}${e.disabled ? " (disabled)" : ""}`));
    check("trade box: Pay with offers the quote coin and SOL through it on pump.fun (no Jupiter options)", opts.join() === "LINE,SOL", opts.join(", "));
    await page.selectOption('select[name="tb_pay"]', "SOL");
    await page.fill('[name="tb_amount"]', "0.02");
    const t0 = (await reader.tokenBalance(ata(wallet.id, l.mint, T22))) ?? 0n, b0 = await rpc.getBalance(wallet.id);
    await page.locator('[data-tb="review"]').click();
    await page.locator("[data-quote-out], .mk-tb [data-err]").first().waitFor({ timeout: 120_000 });
    const quoted = BigInt((await page.locator("[data-quote-out]").getAttribute("data-quote-out").catch(() => null)) ?? "0");
    check("trade box: a 0.02 SOL buy is simulated and quoted in the agent's coin", quoted > 0n, (await text(".mk-tb")).slice(0, 240));
    await shot("8-trade-quote");
    const r0 = requests.length;
    await page.locator('[data-tb="sign"]').click();
    await page.locator(".mk-tb-done, .mk-tb [data-err]").first().waitFor({ timeout: 180_000 });
    const got = ((await reader.tokenBalance(ata(wallet.id, l.mint, T22))) ?? 0n) - t0;
    const sig = await page.locator(".mk-tb-done").getAttribute("data-sig").catch(() => null);
    const tx = sig ? await rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]) : null;
    const hops = ((tx?.meta?.logMessages ?? []) as string[]).filter((m) => /Instruction: (BuyExactQuoteInV3|BuyV3|Buy)/.test(m)).length;
    check("trade box: the SOL buy landed through pump.fun's multi_hop_swap and delivered exactly the simulated amount", got === quoted && got > 0n && ((tx?.meta?.logMessages ?? []) as string[]).some((m) => /MultiHopSwap/.test(m)),
      `${got} base units for ${(Number(b0 - (await rpc.getBalance(wallet.id))) / 1e9).toFixed(9)} SOL, ${hops} curve buys, 1 approval of ${requests.slice(r0).join()}`);
    await shot("9-trade-done");
    out.trade = { signature: sig, agent_coin_base_units: got.toString() };
    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" ; "));
  } catch (e) {
    await shot("failure");
    console.error(`page at failure: ${(await text("main, #app, body")).slice(0, 1500)}`);
    console.error(`page errors: ${errors.slice(0, 5).join(" ; ")}`);
    throw e;
  } finally {
    await browser.close();
  }
} catch (e) {
  outcome = `FAIL: ${(e as Error).message}`;
  console.error(e);
  for (const n of ["core", "web", "gate", "indexer"]) console.error(`--- ${n} log tail\n${(await logs(n).text().catch(() => "")).split("\n").slice(-6).join("\n")}`);
} finally {
  stop();
  const failed = results.filter((r) => !r.ok).length;
  if (failed && outcome === "PASS") outcome = `FAIL: ${failed} checks`;
  writeFileSync(RECORD, JSON.stringify({ at: new Date().toISOString(), outcome, passed: results.length - failed, total: results.length, ...out, results }, null, 2) + "\n");
  log(`${outcome}: ${results.length - failed}/${results.length}`);
  process.exit(outcome === "PASS" ? 0 : 1);
}
