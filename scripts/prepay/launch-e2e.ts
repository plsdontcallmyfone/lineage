#!/usr/bin/env bun
// Plan C exit check: prepaid credits at launch through the REAL Wallet page on devnet. A mock Wallet
// Standard wallet signs with a local devnet test key (~/.config/lineage/devnet/prepay-test.json; the
// page only sees signatures), as in apps/web/scripts/wallet-e2e.ts. A local chain-mode Core reads
// devnet with NO Core authority key (it can never post an epoch or a slash), so the live site's Core
// is untouched; the page's server points at it.
//
// Runs, each a real devnet launch whose agent must be awake right after the launch transaction:
//   A  wallet signs v0, with a soul: one v0 transaction (lookup table) carrying launch_agent,
//      the deposit, refresh_awake and set_profile
//   B  wallet signs legacy only, with a soul: two signatures, (1) launch + deposit + wake, (2) soul
//   C  no soul, self-hosted, deposit typed upward (12.50 USD): one legacy transaction; then the
//      bounty form follows the registry owner (audit A1-03): listed for the wallet, gone after an
//      owner transfer to another key
// plus the form refusing a deposit below the minimum. For each run: AgentLaunch.awake and the vault
// balance on chain, the transaction's version and instructions, Core's prepay record (deposit, ok,
// refresh_awake in the launch tx) and Core's awake flag, and the page's own readout.
//
// playwright-core is not a repo dependency: pass its location.
// Usage: bun scripts/prepay/launch-e2e.ts --pw <dir with node_modules/playwright-core> [--port 9663] [--core-port 9664] [--shots <dir>] [--only A,B,C]
import { spawn, spawnSync, type Subprocess } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { ata, ChainReader, launchPdas, loadKeypair, loadOrCreateKeypair, registry, Rpc, sendAndConfirm, signBytes, system, token, TOKEN_2022_PROGRAM, usdToBase } from "@lineage/chain";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { decodeMessage, parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import { devnetRpcUrl, redactRpc } from "../../packages/chain/src/endpoint.ts";
import type { SoulDoc } from "../../packages/souls/src/doc.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const PORT = Number(arg("port", "9663"));
const CORE_PORT = Number(arg("core-port", "9664"));
const SHOTS = arg("shots");
const ONLY = new Set((arg("only", "A,B,C") ?? "").split(","));
const ROOT = join(import.meta.dir, "..", "..");
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const T0 = Date.now();
const log = (m: string) => console.log(`[prepay-e2e +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const txs: { run: string; what: string; signature: string; fee: number | null }[] = [];
for (const p of [PORT, CORE_PORT]) {
  const busy = spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim();
  if (busy) throw new Error(`port ${p} busy (pid ${busy}); pick others in 9662-9669`);
}

const state = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const RPC_URL = devnetRpcUrl();
const rpc = Rpc.http(RPC_URL, "confirmed");
await assertDevnet(rpc);
const reader = new ChainReader(rpc);
const T22 = TOKEN_2022_PROGRAM;
const mint = state.line_mint as string;
const DEC = Number(state.line_decimals);
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const PREPAY = net.prepay;
const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
const wallet = loadOrCreateKeypair(join(KEYS, "prepay-test.json")).key;
const owner2 = loadOrCreateKeypair(join(KEYS, "prepay-owner2.json")).key;
const depBefore = await rpc.getBalance(dep.id);
log(`rpc ${redactRpc(RPC_URL)}; test wallet ${wallet.id}; lookup table ${state.launch_lookup_table ?? "none"}`);

// ---------------------------------------------------------------- SOL and tLINE for the test wallet
async function topUp() {
  const solBal = await rpc.getBalance(wallet.id);
  if (solBal < 400_000_000n) {
    const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, wallet.id, 500_000_000n - solBal)]);
    txs.push({ run: "setup", what: `fund the test wallet with ${Number(500_000_000n - solBal) / 1e9} SOL from the deployer`, signature: r.signature, fee: r.fee ?? null });
  }
  if ((await rpc.getBalance(owner2.id)) < 10_000_000n) {
    const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, owner2.id, 20_000_000n)]);
    txs.push({ run: "setup", what: "fund the second owner key with 0.02 SOL from the deployer", signature: r.signature, fee: r.fee ?? null });
  }
  const want = 900n * 10n ** BigInt(DEC);
  const bal = (await reader.tokenBalance(ata(wallet.id, mint, T22))) ?? 0n;
  if (bal < want) {
    const fk = loadKeypair(join(KEYS, "faucet.json"));
    const r = await sendAndConfirm(rpc, fk, [token.createAtaIdempotent(fk.id, wallet.id, mint, T22),
      token.transferChecked(ata(fk.id, mint, T22), mint, ata(wallet.id, mint, T22), fk.id, want - bal, DEC, T22)]);
    txs.push({ run: "setup", what: `top up the test wallet with ${Number(want - bal) / 10 ** DEC} tLINE from the faucet key`, signature: r.signature, fee: r.fee ?? null });
  }
}
await topUp();

// ---------------------------------------------------------------- local read-only chain-mode Core
const tmp = mkdtempSync(join(tmpdir(), "lineage-prepay-e2e-"));
const admin = generateAgentKey();
writeFileSync(join(tmp, "admin.json"), JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });
// no core_authority_key: this Core only reads devnet
net.chain = { mode: "devnet", rpc_url: RPC_URL, registry_program: state.registry_program, launch_program: state.launch_program, line_mint: state.line_mint, poll_ms: 5_000 };
writeFileSync(join(tmp, "network.json"), JSON.stringify(net), { mode: 0o600 });
const procs: Subprocess[] = [];
const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(CORE_PORT), "--config", join(tmp, "network.json"),
  "--admin-key", join(tmp, "admin.json"), "--tick-ms", "1000"], { stdout: "ignore", stderr: "pipe", cwd: ROOT });
procs.push(core);
const CORE = `http://127.0.0.1:${CORE_PORT}`;
const web = spawn(["bun", join(ROOT, "apps/web/server.ts"), "--port", String(PORT), "--core", CORE], { stdout: "ignore", stderr: "pipe", cwd: ROOT });
procs.push(web);
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) {
  const ok = (await fetch(`${CORE}/v1/health`).then((r) => r.ok).catch(() => false)) && (await fetch(`${BASE}/chain/config`).then((r) => r.ok).catch(() => false));
  if (ok) break;
  await Bun.sleep(500);
}
const coreGet = (p: string) => fetch(`${CORE}${p}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;
const cfgSeen = await coreGet("/v1/config");
check("local Core serves the prepay config (min, default, TEST rate)", cfgSeen?.network?.prepay?.min_usd === PREPAY.min_usd && cfgSeen?.network?.prepay?.rate_status === "test",
  JSON.stringify({ min_usd: cfgSeen?.network?.prepay?.min_usd, line_per_usd: cfgSeen?.network?.prepay?.line_per_usd }));

// ---------------------------------------------------------------- browser with a mock Wallet Standard wallet
const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await chromium.launch(existsSync(exe) ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, colorScheme: "light" });
const signed: { versions: string; programs: string }[] = [];
await ctx.exposeFunction("__lineageMockSign", (b64: string) => {
  const wire = new Uint8Array(Buffer.from(b64, "base64"));
  const { message } = parseWire(wire);
  const d = decodeMessage(message);
  signed.push({ versions: String(d.version), programs: d.instructions.map((i) => i.programId.slice(0, 6)).join(",") });
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
        // the harness switches v0 support per run
        get supportedTransactionVersions() {
          return (window as any).__mockV0 ? ["legacy", 0] : ["legacy"];
        },
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
const proof = JSON.parse(readFileSync(join(ROOT, "scripts/souls/proof/soul-a.json"), "utf8")) as SoulDoc;
// soul drafts answered from the proof soul: no model spend in this check
await page.route("**/souls/draft", async (route: any) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc: { ...proof, agent: body.agent, seed: body.seed }, usd: 0, calls: 0, model: "claude-opus-5-5" }) });
});
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};
const T = 180_000;

async function openWallet(v0: boolean) {
  await page.goto(`${BASE}/wallet`);
  await page.evaluate((x: boolean) => ((window as any).__mockV0 = x), v0);
  await page.locator('[data-act="connect"][data-name="Lineage Test Wallet"]').click({ timeout: 30_000 });
  await page.locator(".wl-bal").waitFor({ timeout: T });
  await page.waitForFunction(() => !document.querySelector(".wl-bal")?.textContent?.includes("TBA"), null, { timeout: T });
  await page.waitForFunction(() => /tLINE/.test(document.querySelector("#w-prepay")?.textContent ?? ""), null, { timeout: T });
}

async function fillForm(o: { label: string; hosted: boolean; soul: boolean; deposit?: string }) {
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
  await page.fill('[name="l_name"]', `prepay ${o.label} ${stamp}`);
  await page.fill('[name="l_repo"]', "https://github.com/karpathy/minbpe");
  await page.selectOption('[name="l_class"]', "python");
  await page.check(`input[name="l_hosted"][value="${o.hosted ? "hosted" : "self"}"]`);
  await page.check('input[name="l_identity"][value="app"]');
  await page.locator("#w-repo >> text=public on GitHub").waitFor({ timeout: 30_000 });
  if (o.deposit !== undefined) await page.fill('[name="l_deposit"]', o.deposit);
  if (o.soul) {
    await page.fill('[name="s_vibe"]', "patient, precise, quietly funny");
    await page.fill('[name="s_specialty"]', "tokenizer hot paths: fewer allocations, same bytes out");
    await page.fill('[name="s_values"]', "measure twice, small diffs, credit the finder");
    await page.click('[data-act="soul-generate"]');
    await page.waitForSelector(".wl-soul .wl-hash", { timeout: 30_000 });
  }
}

interface RunOut { agent: string; mint: string; sigs: string[] }
async function launchRun(run: string, o: { v0: boolean; soul: boolean; hosted: boolean; deposit?: string; expectMode: "legacy" | "v0" | "split" }): Promise<RunOut | null> {
  log(`run ${run}: wallet ${o.v0 ? "signs v0" : "legacy only"}, ${o.soul ? "with" : "without"} a soul, ${o.hosted ? "hosted" : "self-hosted"}, deposit ${o.deposit ?? "default"}`);
  await openWallet(o.v0);
  await fillForm({ label: run, ...o });
  const usd = o.deposit ?? PREPAY.default_usd;
  const want = usdToBase(usd, PREPAY.line_per_usd, DEC);
  const help = await page.locator("#w-prepay").innerText();
  check(`${run}: form shows the deposit in tLINE, the TEST rate and the first-run budget`, help.includes(String(Number(want) / 10 ** DEC)) && /TEST rate/.test(help) && /First-run budget/.test(help) && /wakes at once/.test(help),
    help.replace(/\s+/g, " ").slice(0, 220));
  await page.click('[data-act="launch-review"]');
  await page.locator("text=simulation succeeded on devnet").waitFor({ timeout: T });
  const review = await page.locator("#w-launch-out").innerText();
  const modeOk = o.expectMode === "split" ? /2 signatures/.test(review) : o.expectMode === "v0" ? /one v0 transaction/.test(review) : /one transaction, \d+ of 1232 bytes/.test(review) && !/2 signatures/.test(review);
  check(`${run}: review shows the ${o.expectMode} path`, modeOk, (/Transaction\s*\n?([^\n]+)/.exec(review)?.[1] ?? "").slice(0, 200));
  await shot(`prepay-${run}-review`);
  const solBefore = await rpc.getBalance(wallet.id);
  const signs0 = signed.length;
  await page.click('[data-act="launch-sign"]');
  await page.locator("text=Launched.").waitFor({ timeout: T });
  const mine = (await reader.launches()).filter((l) => l.launcher === wallet.id).sort((a, b) => Number(b.createdAt - a.createdAt));
  const l = mine[0]!;
  const sigsAll = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [launchPdas.agentLaunch(l.mint), { limit: 20 }]);
  const launchSig = sigsAll[sigsAll.length - 1]!.signature;
  const tx = await rpc.call<any>("getTransaction", [launchSig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  txs.push({ run, what: `launch_agent + deposit ${Number(want) / 10 ** DEC} tLINE + refresh_awake${o.expectMode !== "split" && o.soul ? " + set_profile" : ""} (${tx.version === 0 ? "v0" : "legacy"})`, signature: launchSig, fee: tx.meta.fee });
  const logs: string[] = tx.meta.logMessages ?? [];
  const has = (n: string) => logs.some((x) => x.includes(`Instruction: ${n}`));
  check(`${run}: one transaction ran launch_agent, the deposit and refresh_awake${o.expectMode === "v0" ? " and set_profile" : ""} (${tx.version === 0 ? "v0" : "legacy"})`,
    has("LaunchAgent") && has("TransferChecked") && has("RefreshAwake") && (o.expectMode === "v0" ? has("SetProfile") && tx.version === 0 : tx.version === "legacy"), `${launchSig} version ${tx.version}`);
  if (o.expectMode === "v0") check(`${run}: the v0 transaction read the frozen lookup table`, tx.transaction.message.addressTableLookups?.[0]?.accountKey === state.launch_lookup_table, String(tx.transaction.message.addressTableLookups?.[0]?.accountKey));
  const la = (await reader.agentLaunch(l.mint))!;
  const vault = (await reader.tokenBalance(launchPdas.computeVault(l.agent))) ?? 0n;
  check(`${run}: AgentLaunch.awake on chain right after the launch transaction; vault holds the deposit`, la.awake && vault === want, `awake ${la.awake}, vault ${vault} base units (want ${want})`);
  const signsUsed = signed.length - signs0;
  check(`${run}: wallet signatures`, signsUsed === (o.expectMode === "split" ? 2 : 1), `${signsUsed} (${signed.slice(signs0).map((s) => s.versions).join(", ")})`);
  const sigs = [launchSig];
  if (o.soul) {
    const rec = (await reader.agent(l.agent))!;
    check(`${run}: soul digest on chain (set_profile seq 1)`, !!rec.profileDigest && rec.profileSeq === 1, `${rec.profileDigest?.slice(0, 16)}… seq ${rec.profileSeq}`);
    if (o.expectMode === "split") {
      const second = sigsAll.find((s) => s.signature !== launchSig) ?? null;
      const agentSigs = await rpc.call<{ signature: string }[]>("getSignaturesForAddress", [l.agent, { limit: 10 }]);
      const soulSig = agentSigs.find((s) => s.signature !== launchSig)?.signature ?? second?.signature ?? null;
      if (soulSig) {
        const t2 = await rpc.call<any>("getTransaction", [soulSig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
        txs.push({ run, what: "set_profile (soul), second signature", signature: soulSig, fee: t2?.meta?.fee ?? null });
        sigs.push(soulSig);
        check(`${run}: second transaction is set_profile only`, (t2?.meta?.logMessages ?? []).some((x: string) => x.includes("Instruction: SetProfile")) && !(t2?.meta?.logMessages ?? []).some((x: string) => x.includes("Instruction: LaunchAgent")), soulSig);
      } else check(`${run}: second transaction found`, false);
    }
  }
  // Core: prepay record and awake flag after its chain sync
  let pv: any = null, av: any = null;
  for (let i = 0; i < 60; i++) {
    pv = await coreGet(`/v1/agents/${l.agent}/prepay`);
    av = await coreGet(`/v1/agents/${l.agent}`);
    if (pv?.checked && av) break;
    await Bun.sleep(2000);
  }
  check(`${run}: Core read the launch transaction: deposit, minimum met, refresh_awake in it`, !!pv?.checked && pv.ok === true && pv.woke_in_launch_tx === true && pv.deposit === want.toString() && pv.signature === launchSig,
    JSON.stringify({ deposit: pv?.deposit, min: pv?.min, ok: pv?.ok, woke: pv?.woke_in_launch_tx }));
  check(`${run}: awake in Core`, av?.awake === true, `awake ${av?.awake}`);
  await page.waitForSelector('[data-prepay-core="ok"]', { timeout: 120_000 }).catch(() => null);
  const shown = await page.locator("#w-launch-out").innerText();
  check(`${run}: page shows awake, the deposit and Core's check`, /woken by the deposit in the launch transaction/.test(shown) && /meets the minimum/.test(shown) && (await page.locator('[data-core-awake="true"]').count()) === 1,
    (/Prepaid[^\n]*\n?[^\n]*/.exec(shown)?.[0] ?? "").replace(/\s+/g, " ").slice(0, 200));
  await shot(`prepay-${run}-launched`);
  log(`run ${run}: the wallet paid ${Number(solBefore - (await rpc.getBalance(wallet.id))) / 1e9} SOL (rent and fees)`);
  return { agent: l.agent, mint: l.mint, sigs };
}

let ok = true;
try {
  // below the minimum: refused by the form, nothing built
  await openWallet(true);
  await fillForm({ label: "min", hosted: true, soul: false, deposit: "5" });
  const help = await page.locator("#w-prepay").innerText();
  await page.click('[data-act="launch-review"]');
  await page.locator("#w-launch-out [data-err]").waitFor({ timeout: 30_000 });
  const err = await page.locator("#w-launch-out [data-err]").innerText();
  check("a deposit below the minimum is refused by the form", /at least 10 USD/.test(err) && /at least 10 USD/.test(help), err.replace(/\s+/g, " ").slice(0, 160));

  if (ONLY.has("A")) await launchRun("A", { v0: true, soul: true, hosted: true, expectMode: "v0" });
  if (ONLY.has("B")) await launchRun("B", { v0: false, soul: true, hosted: true, expectMode: "split" });
  if (ONLY.has("C")) {
    const c = await launchRun("C", { v0: true, soul: false, hosted: false, deposit: "12.50", expectMode: "legacy" });
    if (c) {
      // bounty powers follow the registry owner (audit A1-03)
      await page.click('[data-tab="bounties"]');
      await page.waitForSelector('[name="b_payer"]', { timeout: T });
      const listed = await page.locator(`[name="b_payer"] option[value="${c.agent}"]`).count();
      check("C: bounty form lists the self-hosted agent for its registry owner", listed === 1);
      const r1 = await sendAndConfirm(rpc, wallet, [registry.proposeOwner({ owner: wallet.id, agent: c.agent, newOwner: owner2.id })]);
      const r2 = await sendAndConfirm(rpc, owner2, [registry.acceptOwner({ newOwner: owner2.id, agent: c.agent })]);
      txs.push({ run: "C", what: "propose_owner to a second key (bounty owner check)", signature: r1.signature, fee: r1.fee ?? null });
      txs.push({ run: "C", what: "accept_owner by the second key", signature: r2.signature, fee: r2.fee ?? null });
      const rec = (await reader.agent(c.agent))!;
      await page.goto(`${BASE}/wallet`);
      await page.waitForFunction(() => /tLINE/.test(document.querySelector(".wl-bal")?.textContent ?? ""), null, { timeout: T }).catch(() => null);
      await page.click('[data-tab="bounties"]');
      await page.waitForFunction(() => !/Reading/.test(document.querySelector("#w-bopen")?.textContent ?? "Reading"), null, { timeout: T });
      const after = await page.locator(`[name="b_payer"] option[value="${c.agent}"]`).count();
      check("C: after an owner transfer the launcher no longer gets the bounty form for it (owner, not launcher)", rec.owner === owner2.id && after === 0, `owner ${rec.owner}`);
    }
  }
  check("no page errors", errors.length === 0, errors.join("; ").slice(0, 300));
} catch (e) {
  ok = false;
  check("run completed", false, (e as Error).message.split("\n")[0]!);
  await shot("prepay-failure");
} finally {
  await browser.close();
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
  rmSync(tmp, { recursive: true, force: true });
}
const depAfter = await rpc.getBalance(dep.id);
const walletSol = await rpc.getBalance(wallet.id);
const passed = results.filter((r) => r.ok).length;
const out = { at: new Date().toISOString(), passed, total: results.length, wallet: wallet.id, deployer_sol_spent: Number(depBefore - depAfter) / 1e9, wallet_sol_left: Number(walletSol) / 1e9, txs, results };
writeFileSync(join(import.meta.dir, "LAUNCH-E2E-LAST.json"), JSON.stringify(out, null, 2) + "\n");
log(`${passed}/${results.length} checks passed`);
if (!ok || passed !== results.length) process.exit(1);
