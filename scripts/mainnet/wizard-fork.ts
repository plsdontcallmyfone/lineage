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
import { ata, ChainReader, decodeBondingCurve, JITO_BLOCK_ENGINE, launchPdas, loadKeypair, pumpPdas, Rpc, sendAndConfirm, signBytes, system, TOKEN_2022_PROGRAM } from "@units/chain";
import { decodeMessage, parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
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

useTestProfile();
const rpc = Rpc.http(FORK, "confirmed");
const genesis = await rpc.call<string>("getGenesisHash");
if (genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("refusing: the endpoint is mainnet, this check runs on a local fork only");
for (const p of Object.values(PORTS)) if (spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim()) throw new Error(`port ${p} is taken`);
const reader = new ChainReader(rpc);
const state = JSON.parse(readFileSync(join(KEYS, "out", "mainnet.json"), "utf8"));
const overlay = JSON.parse(readFileSync(join(KEYS, "out", "profile.local.json"), "utf8"));
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

const env = { ...process.env, UNITS_NETWORK: "mainnet", UNITS_PROFILE_LOCAL: join(tmp, "profile.local.json"), UNITS_MAINNET_RPC: FORK, UNITS_JITO_URL: `http://127.0.0.1:${PORTS.jito}`,
  UNITS_HOME: join(tmp, "home"), UNITS_PORT_BLOCK: "9690-9699" };
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

  // ---------------------------------------------------------------- a browser wallet with SOL only
  const wallet = generateAgentKey();
  await sendAndConfirm(rpc, dep, [system.transfer(dep.id, wallet.id, 400_000_000n)]);
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
    await page.waitForFunction(() => /Total\s*[\d.]+\s*SOL/.test((document.querySelector('[data-step="4"]') as HTMLElement | null)?.innerText ?? ""), null, { timeout: 120_000 });
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
    await shot("6-review");
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
    const spent = s0 - (await rpc.getBalance(wallet.id));
    check("launch: the wallet paid in SOL only and holds no more than the slippage remainder of the test coin", spent > 0n && ((await reader.tokenBalance(ata(wallet.id, coin, T22))) ?? 0n) < 100_000n * 1_000_000n, `${(Number(spent) / 1e9).toFixed(9)} SOL at the fork's rent`);
    out.launch = { agent: l.agent, mint: l.mint, wallet_sol_spent_fork_lamports: spent.toString(), approvals: requests.slice(n0), bundle_sizes: bundles };

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
  writeFileSync(join(import.meta.dir, "WIZARD-FORK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), outcome, passed: results.length - failed, total: results.length, ...out, results }, null, 2) + "\n");
  log(`${outcome}: ${results.length - failed}/${results.length}`);
  process.exit(outcome === "PASS" ? 0 : 1);
}
