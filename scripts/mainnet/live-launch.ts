#!/usr/bin/env bun
// One agent launched on the LIVE mainnet TEST site through the real Launch wizard (docs/MAINNET-RUNBOOK.md
// "Mainnet test", step 6), headless, then read-only checks of everything the launch should have started.
// Built from scripts/mainnet/wizard-fork.ts (the wizard in mainnet mode, a mock Wallet Standard wallet
// that signs with a real key, one signTransaction request for every transaction of the launch) and
// scripts/launch-e2e/live.ts (the devnet launch through the deployed site and its checks after).
//
// THIS SPENDS REAL SOL when run with --send. Without --send the wallet refuses every transaction (a dry
// run): Launch is pressed, the wallet is asked once and refuses, and the run checks that the page made
// no simulateTransaction request up to that prompt (owner 2026-10-12: the launch simulates nothing),
// how long the total took to appear, and the page's cost lines against simulations THIS script makes of
// the transactions the page handed the wallet (the first transaction whole; the SOL purchase on its own).
//
//   bun scripts/mainnet/live-launch.ts --key <launcher keypair.json> [--send] [--max-sol 0.15]
//        [--name "Test Basalt"] [--symbol TBASALT] [--site https://main-157-245-71-188.sslip.io]
//   bun scripts/mainnet/live-launch.ts --phase watch        # read only, repeatable
//
// The launcher key is a throwaway file outside the repository (mode 600); it never leaves this process
// and is never printed. The page only ever sees signatures. Before Launch is pressed the plan the page
// shows (transaction count, sizes, total SOL) is checked against --max-sol and the packet limit; a plan
// outside them is not signed. The wallet connects through the returning-visitor restore path (the site
// remembers the wallet's name), as tests/ui does; Privy's modal is never opened. Headless Chromium only.
//
// Records (public data only): work/mainnet-test-launch/LIVE-LAUNCH.json and the screenshots beside it.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
export const PACKET_MAX = 1232;

// ---------------------------------------------------------------- the plan the page shows, and its guard
export interface PlanTx { groups: string[]; bytes: number; v0: boolean }
export interface Plan {
  txs: PlanTx[];
  /** cost rows of the Review step: label, the dollar figure, the SOL text beside it */
  rows: { label: string; usd: string; sol: string }[];
  total_sol: number | null;
  total_usd: number | null;
  must_hold_sol: number | null;
  /** the Review step shows a built launch (its cost lines) */
  built: boolean;
}
const num = (s: string | undefined | null) => (s ? Number(s.replace(/,/g, "")) : null);

/** Reads the Review step: `transactions` is the folded "Transactions" row, `rows` the cost lines. */
export function parsePlan(transactions: string, rows: { label: string; usd: string; sol: string }[], reviewText: string): Plan {
  const txs: PlanTx[] = [];
  for (const m of transactions.replace(/^.*?Transactions/, "").matchAll(/([a-z0-9-]+(?: \+ [a-z0-9-]+)*) \((\d+) bytes(, v0)?\)/g)) txs.push({ groups: m[1]!.split(" + "), bytes: Number(m[2]), v0: !!m[3] });
  const total = rows.find((r) => r.label === "Total");
  return {
    txs,
    rows,
    total_sol: num(/([\d.,]+)\s*SOL/.exec(total?.sol ?? "")?.[1]),
    total_usd: num(/\$\s*([\d.,]+)/.exec(total?.usd ?? "")?.[1]),
    must_hold_sol: num(/must hold ([\d.,]+) SOL/.exec(total?.sol ?? "")?.[1]),
    built: /What you pay/i.test(reviewText) && !/simulat/i.test(reviewText.replace(/Transaction details.*$/s, "")),
  };
}

/** Why this plan must not be signed, or null. */
export function planProblem(p: Plan, o: { maxSol: number; balanceSol: number }): string | null {
  if (!p.built) return "the page shows no built launch (or still speaks of a simulation)";
  if (p.txs.length !== 2) return `the plan has ${p.txs.length} transactions, expected 2 (launch + soul, then the purchase, initial buy, credits and tip)`;
  if (!p.txs[0]!.groups.includes("launch")) return "the first transaction does not carry the launch";
  if (!p.txs[1]!.groups.includes("credits") || !p.txs[1]!.groups.includes("initial-buy")) return "the second transaction does not carry the credits and the initial buy";
  if (p.txs.some((t) => t.groups.includes("units-account"))) return "the plan pays for a units account, which this instance does not offer";
  const big = p.txs.find((t) => t.bytes > PACKET_MAX);
  if (big) return `a transaction is ${big.bytes} bytes, over the ${PACKET_MAX} byte packet`;
  if (p.total_sol === null || !(p.total_sol > 0)) return "the page shows no SOL total";
  const need = p.must_hold_sol ?? p.total_sol;
  if (need > o.maxSol) return `the page asks for ${need} SOL, over the limit of ${o.maxSol}`;
  if (need > o.balanceSol) return `the page asks for ${need} SOL and the wallet holds ${o.balanceSol}`;
  return null;
}

if (import.meta.main) await main();

async function main() {
  const { ata, ChainReader, decodeBondingCurve, launchPdas, loadKeypair, pumpPdas, registryPdas, Rpc, signBytes, TOKEN_2022_PROGRAM } = await import("@units/chain");
  const { decodeMessage, parseWire, placeSignature } = await import("../../packages/chain/src/browser/wire.ts");
  const { applyNetworkProfile, rpcUrlFor, stateFor } = await import("../../packages/chain/src/profile-node.ts");

  const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
  const PHASE = arg("phase", "launch")!;
  const SEND = process.argv.includes("--send");
  const BASE = arg("site", "https://main-157-245-71-188.sslip.io")!.replace(/\/+$/, "");
  const OUT = arg("out", join(ROOT, "work", "mainnet-test-launch"))!;
  const MAX_SOL = Number(arg("max-sol", "0.15"));
  const SEED = {
    name: arg("name", "Test Basalt")!,
    symbol: arg("symbol", "TBASALT")!,
    desc: "A test launch on the units mainnet TEST deployment: it proves the launch flow end to end. The coin has no value and is not $UNITS.",
    repo: "https://github.com/keis/base58",
    vibe: "dry, exact, cheerful about small wins; says plainly it is a test agent",
    specialty: "keis/base58 encode and decode hot paths: fewer big-int steps, same bytes out",
    values: "measure before claiming, small reviewable diffs, say plainly it is a test",
  };
  mkdirSync(OUT, { recursive: true });
  const STATE_FILE = join(OUT, "LIVE-LAUNCH.json");
  const T0 = Date.now();
  const log = (m: string) => console.log(`[live-launch ${PHASE} +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
  type State = Record<string, any> & { results: { phase: string; check: string; ok: boolean; detail: string; at: string }[] };
  const S: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { results: [] };
  const save = () => writeFileSync(STATE_FILE, JSON.stringify(S, null, 2) + "\n");
  const check = (name: string, ok: boolean, detail = "") => {
    S.results = S.results.filter((r) => !(r.phase === PHASE && r.check === name));
    S.results.push({ phase: PHASE, check: name, ok, detail: detail.slice(0, 900), at: new Date().toISOString() });
    save();
    log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
    return ok;
  };

  // ---------------------------------------------------------------- chain (keyed RPC, never printed)
  const profile = applyNetworkProfile();
  if (profile.network !== "mainnet") throw new Error("this script is for the mainnet TEST deployment (the repository's default profile); UNITS_NETWORK is set to something else");
  const state = stateFor(profile) as Record<string, any> | null;
  if (!state?.test) throw new Error("the active mainnet profile is not the TEST deployment (config/profile.json mainnet_deployment): refusing");
  const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
  if ((await rpc.call<string>("getGenesisHash")) !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("the RPC endpoint is not mainnet");
  const reader = new ChainReader(rpc);
  const COIN = state.line_mint as string, DEC = Number(state.line_decimals);
  const T22 = TOKEN_2022_PROGRAM;
  const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
  const getTx = (sig: string) => rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
  const j = async (p: string) => {
    const r = await fetch(`${BASE}${p}`, { headers: { accept: "application/json" } }).catch(() => null);
    if (!r) return { status: 0, body: null as any };
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const chromium = async () => {
    const pw = await import(join(ROOT, "node_modules/.bun/playwright-core@1.63.0/node_modules/playwright-core/index.mjs"));
    const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
    // headless only: chromium-headless-shell, a fresh profile (never the owner's browser)
    return pw.chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
  };

  // ---------------------------------------------------------------- the page's figures against simulations made HERE
  // The page computes its cost lines and compute limits without simulating. This script simulates what the page
  // handed the wallet (read only, signatures not verified) and compares: the first transaction whole, and the SOL
  // purchase alone (the rest of the second transaction needs the coin the first one creates).
  async function verifyCosts(page: any, b64s: string[], launcher: string) {
    const { compileMessage } = await import("@units/chain");
    const { unsignedWire } = await import("../../packages/chain/src/browser/wire.ts");
    const rows = (await page.locator("#w-launch-out .lz-tech tr[data-tx]").evaluateAll((els: HTMLElement[]) => els.map((e) => ({ units: Number(e.dataset.units), fee: e.dataset.fee!, groups: (e.querySelector("td")?.textContent ?? "").replace(/\s*v0\s*$/, "").trim().split(" + ") })))) as { units: number; fee: string; groups: string[] }[];
    const rents = (await page.locator("#w-launch-out .lz-tech tr[data-rent-group]").evaluateAll((els: HTMLElement[]) => els.map((e) => ({ group: e.dataset.rentGroup!, lamports: e.dataset.lamports!, what: e.querySelector("td")?.textContent ?? "" })))) as { group: string; lamports: string; what: string }[];
    const head = (await page.locator("#w-launch-out .lz-tech").evaluate((e: HTMLElement) => ({ total: e.dataset.launchTotal, purchase: e.dataset.launchPurchase }))) as { total: string; purchase: string };
    const sim = async (b64: string) => (await rpc.call<any>("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [launcher] } }])).value;
    const before = await rpc.getBalance(launcher);
    // 1. the first transaction, exactly as the page built it
    const one = await sim(b64s[0]!);
    const spent1 = one.accounts?.[0] ? before - BigInt(one.accounts[0].lamports) : null;
    const want1 = BigInt(rows[0]!.fee) + rents.filter((r) => rows[0]!.groups.includes(r.group)).reduce((n, r) => n + BigInt(r.lamports), 0n);
    S.verify = { tx1: { err: one.err, units_consumed: one.unitsConsumed, units_limit: rows[0]!.units, wallet_spent_simulated: spent1?.toString() ?? null, page_fee_plus_rent: want1.toString() } };
    check("costs: the first transaction, simulated by this script, succeeds and spends exactly the fee and rent the page shows for it", !one.err && spent1 === want1, `simulated ${spent1} lamports, the page's fee + rent ${want1}${one.err ? `; error ${JSON.stringify(one.err)} ${(one.logs ?? []).slice(-3).join(" | ")}` : ""}`);
    check("limits: the first transaction uses at most two thirds of its fixed compute limit", !!one.unitsConsumed && one.unitsConsumed * 3 <= rows[0]!.units * 2, `${one.unitsConsumed} of ${rows[0]!.units}`);
    // 2. the SOL purchase of the second transaction, alone (its first group)
    const two = parseWire(new Uint8Array(Buffer.from(b64s[1]!, "base64")));
    const raw = decodeMessage(two.message);
    const tables = new Map<string, string[]>();
    for (const l of raw.lookups) tables.set(l.table, (await rpc.call<any>("getAccountInfo", [l.table, { encoding: "jsonParsed" }])).value.data.parsed.info.addresses);
    const d = decodeMessage(two.message, tables);
    const body = d.instructions.filter((ix: any) => !String(ix.programId).startsWith("ComputeBudget"));
    const budget = d.instructions.filter((ix: any) => String(ix.programId).startsWith("ComputeBudget"));
    if (rows[1]?.groups[0] !== "sol-to-units") return check("costs: the SOL purchase could be isolated", false, `the second transaction starts with ${rows[1]?.groups[0]}`);
    // sol-to-units is the first two instructions after the budget: create the launcher's $UNITS account if missing, then buy_v3
    const ixs = [...budget, ...body.slice(0, 2)].map((ix: any) => ({ programId: ix.programId, keys: ix.accounts, data: ix.data }));
    const { blockhash } = await rpc.getLatestBlockhash();
    const alone = await sim(Buffer.from(unsignedWire(compileMessage(launcher, ixs, blockhash))).toString("base64"));
    const spent2 = alone.accounts?.[0] ? before - BigInt(alone.accounts[0].lamports) : null;
    // what this lone transaction pays beside the purchase: its own fee (same limit and price as the page's second transaction, one signature) and the rent of the wallet's accounts it creates
    const fee2 = BigInt(rows[1]!.fee);
    const rent2 = rents.filter((r) => r.group === "sol-to-units").reduce((n, r) => n + BigInt(r.lamports), 0n);
    const trade = spent2 === null ? null : spent2 - fee2 - rent2;
    S.verify.purchase = { err: alone.err, units_consumed: alone.unitsConsumed, wallet_spent_simulated: spent2?.toString() ?? null, fee: fee2.toString(), rent: rent2.toString(), trade_simulated: trade?.toString() ?? null, page_credits_plus_buy: head.purchase };
    save();
    // the curve moves with every trade on it: equal when nobody traded between the page's read and this simulation, else within the slippage bound
    const page2 = BigInt(head.purchase);
    const off = trade === null ? null : trade > page2 ? trade - page2 : page2 - trade;
    check("costs: the SOL purchase, simulated alone by this script, costs what the page shows for credits + initial buy (to the lamport, or within 1% if the curve traded in between)",
      !alone.err && off !== null && off * 100n <= page2, `simulated ${trade} lamports, the page ${page2}, difference ${off}${alone.err ? `; error ${JSON.stringify(alone.err)} ${(alone.logs ?? []).slice(-3).join(" | ")}` : ""}`);
    log(`page total ${head.total} lamports; rents ${rents.map((r) => `${r.what} ${r.lamports}`).join(", ")}`);
  }

  // ---------------------------------------------------------------- launch
  async function phaseLaunch() {
    const KEY = arg("key") ?? (() => { throw new Error("--key <launcher keypair.json> is required (a throwaway key outside the repository)"); })();
    if (S.launch?.signatures?.length && SEND) throw new Error(`a launch was already sent (agent ${S.agent}); this script sends one launch per state file`);
    const wallet = loadKeypair(KEY);
    S.site = BASE;
    S.launcher = wallet.id;
    S.name = SEED.name;
    S.symbol = SEED.symbol;
    const bal0 = await rpc.getBalance(wallet.id);
    S.launcher_sol_before = sol(bal0);
    S.attempts = (S.attempts ?? 0) + (SEND ? 1 : 0);
    save();
    log(`site ${BASE}; launcher ${wallet.id} holds ${sol(bal0)} SOL; ${SEND ? "SENDING: the wallet signs" : "dry run: the wallet refuses every transaction"}`);

    const cc = (await j("/chain/config")).body;
    check("site: the mainnet TEST deployment (mainnet genesis, test program ids, the test coin as quote, no faucet)",
      cc?.genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" && cc?.profile?.network === "mainnet" && cc.profile.programs.registry === state!.registry_program && cc.profile.programs.launch === state!.launch_program &&
      cc.profile.quote.mint === COIN && cc.state?.test === true && !cc.profile.faucet, `registry ${cc?.profile?.programs?.registry}, quote ${cc?.profile?.quote?.mint}`);
    if (!S.results.at(-1)!.ok) throw new Error("the site is not the mainnet TEST deployment; nothing was signed");

    const browser = await chromium();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light", acceptDownloads: true });
    const signed: { txs: { version: string; bytes: number; programs: string[]; signers: number }[]; at: string }[] = [];
    await ctx.exposeFunction("__liveSignAll", (b64s: string[]) => {
      const txs = b64s.map((b64) => {
        const wire = new Uint8Array(Buffer.from(b64, "base64"));
        const d = decodeMessage(parseWire(wire).message);
        return { version: String(d.version), bytes: wire.length, programs: [...new Set(d.instructions.map((i: any) => i.programId as string))], signers: parseWire(wire).signatures.length };
      });
      signed.push({ txs, at: new Date().toISOString() });
      wires.push(b64s);
      S.signing_requests = signed;
      save();
      if (!SEND) throw new Error("dry run: the wallet refuses every transaction (run with --send to sign)");
      return b64s.map((b64) => {
        const wire = new Uint8Array(Buffer.from(b64, "base64"));
        const { message } = parseWire(wire);
        return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, message))).toString("base64");
      });
    });
    await ctx.exposeFunction("__liveSignMsg", (b64: string) => Buffer.from(signBytes(wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64"));
    const statusLines: { at: string; text: string }[] = [];
    await ctx.exposeFunction("__liveStatus", (text: string) => {
      if (statusLines.at(-1)?.text !== text) statusLines.push({ at: new Date().toISOString(), text: text.slice(0, 600) });
    });
    await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
      const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
      const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      // a returning visitor: the site reconnects the remembered wallet silently (Connect opens Privy's modal otherwise)
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
              ((await (window as any).__liveSignAll(inputs.map((i) => b64(i.transaction)))) as string[]).map((s) => ({ signedTransaction: unb64(s) })) },
          "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: { message: Uint8Array }[]) =>
            Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__liveSignMsg(b64(i.message))) }))) },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
      // every status line the wizard shows while it sends (they replace each other on the page)
      setInterval(() => {
        const t = (document.querySelector("#w-launch-status") as HTMLElement | null)?.innerText?.replace(/\s+/g, " ").trim();
        if (t) void (window as any).__liveStatus(t);
      }, 250);
    }, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("console", (m: any) => { if (m.type() === "error") errors.push(`console: ${String(m.text()).slice(0, 300)}`); });
    // what the page asked the chain proxy to send (public JSON-RPC through the site; no key is in it)
    const sends: { at: string; method: string; status: number; result: string }[] = [];
    // every JSON-RPC method the page called through the site, counted (the launch must make no simulateTransaction)
    const rpcCounts: Record<string, number> = {};
    const wires: string[][] = [];
    page.on("response", async (r: any) => {
      try {
        if (!r.url().endsWith("/chain/rpc") || r.request().method() !== "POST") return;
        const body = JSON.parse(r.request().postData() ?? "{}");
        rpcCounts[body.method] = (rpcCounts[body.method] ?? 0) + 1;
        if (!["sendBundle", "getInflightBundleStatuses", "getBundleStatuses", "sendTransaction", "getTipAccounts"].includes(body.method)) return;
        const text = await r.text().catch(() => "");
        sends.push({ at: new Date().toISOString(), method: body.method, status: r.status(), result: body.method === "getTipAccounts" ? `${text.length} bytes` : text.slice(0, 500) });
        S.rpc_sends = sends;
        save();
      } catch {}
    });
    const shot = (n: string) => page.screenshot({ path: join(OUT, `${n}.png`), fullPage: true }).catch(() => {});
    const text = async (sel: string) => ((await page.locator(sel).first().innerText().catch(() => "")) as string).replace(/\s+/g, " ");

    try {
      await page.goto(`${BASE}/launch`);
      await page.locator("#cn-btn.on").waitFor({ timeout: 60_000 });
      check("wizard: the mock wallet connected through the returning-visitor restore path (Privy's modal not opened)", true, await text("#cn-btn"));
      await page.fill('[name="l_name"]', SEED.name);
      await page.fill('[name="l_symbol"]', SEED.symbol);
      await page.fill('[name="l_desc"]', SEED.desc);
      await shot("1-coin");
      await page.click('[data-act="lz-next"]');
      await page.fill('[name="l_repo"]', SEED.repo);
      await page.locator("#w-work .lz-rec, #w-work .banner").first().waitFor({ timeout: 90_000 });
      // the optional extras (fee share, repository pool) are unticked when an instance shows them: a plain launch
      await page.locator('[name="l_fee_on"], [name="l_pool_join"]').first().waitFor({ timeout: 6_000 }).catch(() => {});
      for (const n of ["l_fee_on", "l_pool_join"]) {
        const box = page.locator(`[name="${n}"]`);
        if ((await box.count()) && (await box.isChecked())) await box.uncheck();
      }
      S.work_step = (await text("#w-work")).slice(0, 1500);
      const recipes = await page.locator("#w-work .lz-rec .lz-rec-h a").allInnerTexts();
      check("wizard, Work: the repository is recognised and a recipe is offered", recipes.length > 0, `recipes ${recipes.join(", ")}`);
      await shot("2-work");
      await page.click('[data-act="lz-next"]');
      await page.fill('[name="s_vibe"]', SEED.vibe);
      await page.fill('[name="s_specialty"]', SEED.specialty);
      await page.fill('[name="s_values"]', SEED.values);
      const souls0 = (await j("/souls/config")).body;
      await page.click('[data-act="soul-generate"]');
      await page.waitForSelector(".wl-soul .wl-hash, #w-soul [data-err]", { timeout: 300_000 });
      const soulText = await text("#w-soul");
      const souls1 = (await j("/souls/config")).body;
      S.soul_view = soulText.slice(0, 1500);
      check("wizard, Agent: the soul was drafted by the site's model (a real model call)", (await page.locator(".wl-soul .wl-hash").count()) > 0, `${soulText.slice(0, 160)}; souls spend today ${souls0?.spent_today_usd} -> ${souls1?.spent_today_usd} USD`);
      S.model_choice = await page.locator('[name="l_model"]:checked, select[name="l_model"]').first().inputValue().catch(() => "the default (nothing picked)");
      S.runtime_choice = await page.locator('input[name="l_hosted"]:checked').inputValue().catch(() => null);
      check("wizard, Agent: the default model and the hosted runtime are selected", S.runtime_choice === "hosted", `model ${S.model_choice}, runtime ${S.runtime_choice}`);
      await shot("3-agent");
      await page.click('[data-act="lz-next"]');
      await page.locator("#w-id-price").waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => !/^$|price from Core/.test(document.querySelector("#w-id-price")?.textContent ?? ""), null, { timeout: 60_000 });
      const offered = !(await page.locator('input[name="l_identity"][value="purchased"]').isDisabled());
      if (offered) await page.check('input[name="l_identity"][value="token"]');
      check("wizard, Identity: \"Your own token\" is selected (the units account is not offered on this instance)", !offered && (await page.locator('input[name="l_identity"][value="token"]').isChecked()), await text("#w-id-price"));
      await shot("4-identity");
      const tFunding = Date.now();
      await page.click('[data-act="lz-next"]');
      const dep = page.locator('[name="l_deposit"]');
      S.credits_usd = await dep.inputValue().catch(() => null);
      if (S.credits_usd !== "10") await dep.fill("10");
      await page.waitForFunction(() => /SOL/.test((document.querySelector("[data-fronting-sol]") as HTMLElement | null)?.innerText ?? ""), null, { timeout: 180_000 });
      S.funding_total_ms = Date.now() - tFunding;
      S.funding_view = (await text('[data-step="4"]')).slice(0, 1500);
      check("wizard, Funding: the total is there within 3 s of opening the step, with no simulation wording", S.funding_total_ms < 3_000 && !/simulat/i.test(S.funding_view), `${S.funding_total_ms} ms`);
      check("wizard, Funding: 10 USD of credits (the minimum), a total in US dollars with the SOL beside it", (await dep.inputValue()) === "10" && /\$/.test(await text("[data-fronting-total]")), `${await text("[data-fronting-total]")} / ${await text("[data-fronting-sol]")}`);
      await shot("5-funding");
      await page.click('[data-act="lz-next"]');
      await page.locator('#w-launch-out [data-act="launch-sign"], #w-launch-out [data-err]').first().waitFor({ timeout: 90_000 });
      // textContent: the transaction list sits in a folded details element
      const review = ((await page.locator("#w-launch-out").evaluate((e: HTMLElement) => e.textContent ?? "").catch(() => "")) as string).replace(/\s+/g, " ");
      const rows = (await page.locator("#w-launch-out .lz-fronting [data-fronting]").evaluateAll((els: HTMLElement[]) =>
        els.map((e) => ({ label: e.getAttribute("data-fronting") ?? "", usd: e.querySelector("b")?.textContent ?? "", sol: e.querySelector(".dim")?.textContent ?? "" })))) as Plan["rows"];
      const plan = parsePlan((/Transactions(.{0,400}?)(Launch \(one signature\)|$)/.exec(review) ?? ["", review])[1]!, rows, review);
      const ids = await page.locator("#w-launch-out .lz-tech").evaluate((e: HTMLElement) => {
        const row = (k: string) => Array.from(e.querySelectorAll("dt, th, .k, span.eyebrow, td")).find((x) => x.textContent?.trim() === k)?.nextElementSibling;
        const a = (k: string) => (row(k)?.querySelector("[title], a, [data-addr]") as HTMLElement | null)?.getAttribute("title") ?? row(k)?.querySelector("a")?.getAttribute("href") ?? row(k)?.textContent ?? null;
        return { agent: a("Agent key"), mint: a("Agent mint") };
      }).catch(() => ({ agent: null, mint: null }));
      S.plan = { ...plan, at: new Date().toISOString(), sol_usd: (await j("/chain/sol-price")).body ?? null, agent_key_shown: ids.agent, agent_mint_shown: ids.mint };
      S.review_view = review.slice(0, 3000);
      save();
      await page.locator("#w-launch-out details.lz-tech").evaluate((e: HTMLDetailsElement) => (e.open = true)).catch(() => {});
      await shot("6-review");
      log(`plan: ${plan.txs.map((t) => `${t.groups.join(" + ")} (${t.bytes} bytes${t.v0 ? ", v0" : ""})`).join("; ")}; total ${plan.total_sol} SOL (${plan.total_usd} USD); must hold ${plan.must_hold_sol ?? "no more"}`);
      for (const r of rows) log(`  ${r.label}: ${r.usd} ${r.sol}`);
      const fork = JSON.parse(readFileSync(join(import.meta.dir, "WIZARD-FORK-LAST.json"), "utf8"));
      const forkSpent = Number(fork.launch?.wallet_sol_spent_fork_lamports ?? 0) / 1e9;
      log(`fork figures: the wizard on the fork spent ${forkSpent.toFixed(9)} SOL at the fork's rent; the instruction rehearsal measured 0.097173597 SOL at mainnet rent (docs/MAINNET-COSTS.md), 1,082 and 1,101 bytes`);
      const problem = planProblem(plan, { maxSol: MAX_SOL, balanceSol: Number(bal0) / 1e9 });
      check("wizard, Review: the launch is built with its cost lines (nothing simulated) and the plan is within the limits (2 transactions, each within a packet, total under --max-sol)", !problem, problem ?? `${plan.txs.length} transactions of ${plan.txs.map((t) => t.bytes).join(" and ")} bytes; total ${plan.total_sol} SOL = ${plan.total_usd} USD; limit ${MAX_SOL} SOL`);
      const disabled = await page.locator('[data-act="launch-sign"]').isDisabled();
      check("wizard, Review: Launch is enabled (the wallet covers the total)", !disabled, await text("#w-launch-out [data-fronting-short], #w-launch-out .lz-fronting .wl-fine"));
      if (!SEND) {
        if (problem || disabled) return log("dry run: the plan is not signable, so Launch was not pressed; nothing was signed or sent");
        // the wallet refuses, so nothing is signed: this only proves the page reaches the signing prompt without simulating
        await page.locator('[data-act="launch-sign"]').click();
        await page.waitForFunction(() => /dry run/.test(document.querySelector("#w-launch-status")?.textContent ?? ""), null, { timeout: 90_000 }).catch(() => {});
        S.rpc_methods_to_prompt = { ...rpcCounts };
        check("dry: Launch asked the wallet once for every transaction, and the page made no simulateTransaction request up to that prompt",
          signed.length === 1 && signed[0]!.txs.length === plan.txs.length && (rpcCounts.simulateTransaction ?? 0) === 0, `signing requests ${JSON.stringify(signed.map((r) => r.txs.length))}; rpc methods ${JSON.stringify(rpcCounts)}`);
        await shot("7-dry-prompt");
        if (wires[0]) await verifyCosts(page, wires[0], wallet.id);
        return log("dry run: the wallet refused; nothing was signed or sent");
      }
      if (problem || disabled) throw new Error(`not signing: ${problem ?? "Launch is disabled"}`);

      // ---------------------------------------------------------------- the launch itself
      const n0 = signed.length;
      await page.locator('[data-act="launch-sign"]').click();
      await page.locator('[data-track="confirmed"][data-state="ok"], #w-launch-status [data-err], #w-launch-out [data-err]').first().waitFor({ timeout: 300_000 });
      await shot("7-after-send");
      const confirmed = (await page.locator('[data-track="confirmed"][data-state="ok"]').count()) > 0;
      const sigs = confirmed ? ((await page.locator('[data-track="confirmed"] a').evaluateAll((els: HTMLAnchorElement[]) => els.map((e) => (/tx\/([1-9A-HJ-NP-Za-km-z]{60,})/.exec(e.href) ?? [])[1]).filter(Boolean))) as string[]) : [];
      S.launch = { confirmed, signatures: sigs, approvals: signed.slice(n0).map((r) => r.txs.length), status_lines: statusLines, error: confirmed ? null : (await text("#w-launch-status, #w-launch-out [data-err]")).slice(0, 1500), at: new Date().toISOString() };
      save();
      check("launch: one approval carried every transaction of the launch (one signTransaction request)", signed.length - n0 >= 1 && signed[n0]!.txs.length === plan.txs.length, `requests ${JSON.stringify(signed.slice(n0).map((r) => r.txs.length))}`);
      if (!confirmed) throw new Error(`the launch did not confirm: ${S.launch.error}`);
      log(`LANDED: ${sigs.join(", ")}`);
      const mine = (await reader.launches()).filter((l) => l.launcher === wallet.id).sort((a, b) => Number(b.createdAt - a.createdAt));
      if (mine[0]) {
        S.agent = mine[0].agent;
        S.mint = mine[0].mint;
        save();
        log(`agent ${S.agent}, mint ${S.mint}`);
      }
      check("launch: one AgentLaunch for the launcher on mainnet", mine.length === 1, `agent ${S.agent}, mint ${S.mint}`);

      // the agent key exists only in this tab: keep it beside the launcher key (mode 600, never printed)
      const dl = page.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
      await page.locator('[data-act="download-agent-key"]').click({ timeout: 60_000 }).catch(() => {});
      const d = await dl;
      if (d) {
        const to = join(dirname(KEY), `agent-key-${String(S.agent).slice(0, 8)}.json`);
        await d.saveAs(to);
        chmodSync(to, 0o600);
        S.agent_key_saved = true;
        save();
      }
      // the hosted runtime binding the page asks for next (one more approval), then the launch holding moves to the runtime key
      await page.locator("#w-rt-bind").waitFor({ timeout: 120_000 }).catch(() => {});
      const bound = await page.waitForFunction(() => /bound|only the owner|connect the launcher|\bError\b|refus|failed|has not seen/i.test(document.querySelector("#w-rt-bind")?.textContent ?? ""), null, { timeout: 300_000 }).then(() => true, () => false);
      await page.waitForFunction(() => {
        const b = document.querySelector("#w-rt-bind")?.textContent ?? "", h = document.querySelector("#w-rt-holding")?.textContent ?? "";
        return !/\bbound\b/.test(b) || /moved|Error|failed|connect/i.test(h);
      }, null, { timeout: 180_000 }).catch(() => {});
      S.bind_view = (await text("#w-rt-bind")).slice(0, 1200);
      S.signing_requests = signed;
      save();
      check("page: the hosted runtime binding was asked for, signed and co-signed, and the launch holding moved to the agent's treasury", bound && /\bbound\b/.test(S.bind_view) && !/Error|refus|failed/i.test(S.bind_view), S.bind_view.slice(0, 400));
      await shot("8-launched");
      // the page's own tracker, for a few minutes: vault, runtime, first session
      const until = Date.now() + Number(arg("linger", "240")) * 1000;
      let track: Record<string, string> = {};
      while (Date.now() < until) {
        track = Object.fromEntries((await page.locator("[data-track]").evaluateAll((els: HTMLElement[]) => els.map((e) => [e.dataset.track!, `${e.dataset.state}: ${(e.textContent ?? "").replace(/\s+/g, " ").slice(0, 200)}`]))) as [string, string][]);
        if (track.session?.startsWith("ok") || track.session?.startsWith("bad")) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      S.track = track;
      S.launched_view = (await text("#w-launch-out")).slice(0, 4000);
      save();
      await shot("9-track");
      check("no page errors during the launch", errors.length === 0, errors.slice(0, 4).join(" ; "));
    } catch (e) {
      await shot("failure");
      S.failure = { message: (e as Error).message.slice(0, 1500), page: (await text("main, #app, body")).slice(0, 2500), errors: errors.slice(0, 8), status_lines: statusLines, at: new Date().toISOString() };
      save();
      throw e;
    } finally {
      S.signing_requests = signed;
      S.page_errors = errors.slice(0, 20);
      await browser.close();
      S.launcher_sol_after = sol(await rpc.getBalance(wallet.id));
      save();
    }
  }

  // ---------------------------------------------------------------- watch (read only)
  async function phaseWatch() {
    if (!S.mint || !S.agent) throw new Error("no launched agent in the state file; run the launch first");
    const agent = S.agent as string, mint = S.mint as string, launcher = S.launcher as string;
    const sigs = (S.launch?.signatures ?? []) as string[];
    const txs = await Promise.all(sigs.map(getTx));
    const logs = (t: any) => (t?.meta?.logMessages ?? []) as string[];
    const has = (t: any, n: string) => logs(t).some((x) => x.includes(`Instruction: ${n}`));
    const bundleSent = ((S.rpc_sends ?? []) as any[]).filter((s) => s.method === "sendBundle");
    const bundleLanded = ((S.rpc_sends ?? []) as any[]).some((s) => s.method === "getInflightBundleStatuses" && /"Landed"/.test(s.result));
    const ordered = ((S.rpc_sends ?? []) as any[]).filter((s) => s.method === "sendTransaction").length;
    S.launch_txs = txs.map((t, i) => ({ signature: sigs[i], slot: t?.slot ?? null, err: t?.meta?.err ?? null, fee_lamports: t?.meta?.fee ?? null, compute_units: t?.meta?.computeUnitsConsumed ?? null, block_time: t?.blockTime ?? null,
      payer_delta_lamports: t ? Number(t.meta.postBalances[0]) - Number(t.meta.preBalances[0]) : null, bytes: null as number | null }));
    S.send_path = bundleLanded ? "Jito bundle landed" : bundleSent.length ? `Jito was asked (${bundleSent.length} sendBundle) and did not report Landed; ${ordered} ordered sendTransaction calls` : `no sendBundle seen; ${ordered} sendTransaction calls`;
    save();
    check("chain: both launch transactions landed without error", txs.length === 2 && txs.every((t) => t && !t.meta.err), S.launch_txs.map((t: any) => `${t.signature} slot ${t.slot} fee ${sol(t.fee_lamports ?? 0)} SOL, ${t.compute_units} CU, payer ${sol(t.payer_delta_lamports ?? 0)} SOL`).join(" | "));
    check("chain: the path taken (Jito bundle or ordered sends) is recorded", true, `${S.send_path}; slots ${txs.map((t) => t?.slot).join(", ")}${txs.length === 2 && txs[0]?.slot === txs[1]?.slot ? " (the same slot)" : ""}`);
    check("chain: the first transaction carries pump.fun create_v2, register_pump_launch and the soul; the second the purchase, the initial buy, the deposit and refresh_awake",
      !!txs[0] && has(txs[0], "CreateV2") && has(txs[0], "RegisterPumpLaunch") && has(txs[0], "SetProfile") && !!txs[1] && has(txs[1], "RefreshAwake"),
      `tx1: ${logs(txs[0]).filter((x) => x.includes("Instruction:")).map((x) => x.split("Instruction: ")[1]).join(",")} | tx2: ${logs(txs[1]).filter((x) => x.includes("Instruction:")).map((x) => x.split("Instruction: ")[1]).join(",")}`.slice(0, 800));
    const la = await reader.agentLaunch(mint);
    const curveAcc = await rpc.getAccountInfo(pumpPdas.bondingCurve(mint));
    const curve = curveAcc ? decodeBondingCurve(curveAcc.data) : null;
    check("chain: the pump.fun coin exists, quoted in the quote coin, its creator the agent's creator PDA", !!curve && curve.quoteMint === COIN && curve.creator === launchPdas.pumpCreator(agent), `curve ${pumpPdas.bondingCurve(mint)}, quote ${curve?.quoteMint}, creator ${curve?.creator}, complete ${curve?.complete}`);
    check("chain: register_pump_launch recorded the AgentLaunch (launcher, repository, hosted, awake)", !!la && la.launcher === launcher && la.agent === agent, la ? `AgentLaunch ${launchPdas.agentLaunch(mint)}: repo ${la.repoUrl}, hosted ${la.hosted}, identity mode ${la.identityMode}, awake ${la.awake}` : "not found");
    const vault = (await reader.tokenBalance(launchPdas.computeVault(agent))) ?? 0n;
    const prepay = (await j("/v1/config")).body?.network?.prepay;
    const wantVault = prepay ? BigInt(Math.round(Number(prepay.min_usd) * Number(prepay.line_per_usd))) * 10n ** BigInt(DEC) : null;
    S.vault_first ??= vault.toString();
    S.vault_now = vault.toString();
    check("chain: the compute vault holds the credits", vault > 0n && (wantVault === null || BigInt(S.vault_first) <= wantVault), `vault ${launchPdas.computeVault(agent)}: ${Number(vault) / 10 ** DEC} UNITS now, ${Number(BigInt(S.vault_first)) / 10 ** DEC} at the first read; 10 USD at ${prepay?.line_per_usd} per USD = ${wantVault === null ? "?" : Number(wantVault) / 10 ** DEC}`);
    const rec = await reader.agent(agent);
    const bind = (await j(`/runtime/bind/${agent}`));
    const onePct = curve ? curve.tokenTotalSupply / 100n : null;
    const atKey = (await reader.tokenBalance(ata(agent, mint, T22))) ?? 0n;
    const atTreasury = rec?.signingKey && rec.signingKey !== agent ? ((await reader.tokenBalance(ata(rec.signingKey, mint, T22))) ?? 0n) : 0n;
    check("chain: the 1% initial buy is held for the agent (its key's account, or its treasury once bound)", onePct !== null && atKey + atTreasury === onePct, `1% of supply ${onePct}; agent key account ${atKey}; treasury (${rec?.signingKey}) ${atTreasury}`);
    check("chain: the soul digest is on chain", !!rec?.profileDigest, `${rec?.profileDigest} seq ${rec?.profileSeq}`);
    check("runtime: bound (the registry signing key is the hosted runtime's key for the agent)", !!rec && bind.body?.status === "bound" && rec.signingKey === bind.body?.new_key, `signing key ${rec?.signingKey}, runtime key ${bind.body?.new_key}, status ${bind.body?.status ?? `HTTP ${bind.status}`}, key changes ${rec?.keySeq}`);
    // every transaction that touched the agent's records, with payer and fee
    const seen = new Map<string, any>();
    for (const a of [registryPdas.agent(agent), launchPdas.agentLaunch(mint), launchPdas.computeVault(agent)])
      for (const s of await rpc.call<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [a, { limit: 100 }]).catch(() => [])) seen.set(s.signature, s);
    const hot: Record<string, string> = { [state!.core_authority]: "Core authority", [state!.runtime_authority]: "runtime authority", [launcher]: "launcher" };
    for (const [a] of Object.entries(hot).slice(0, 2))
      for (const s of await rpc.call<{ signature: string; slot: number; err: unknown; blockTime: number }[]>("getSignaturesForAddress", [a, { limit: 100 }]).catch(() => []))
        if ((s.blockTime ?? 0) >= (txs[0]?.blockTime ?? Math.floor(Date.parse(S.launch?.at ?? new Date().toISOString()) / 1000) - 600)) seen.set(s.signature, s);
    const all = [];
    for (const s of [...seen.values()].sort((a, b) => a.slot - b.slot)) {
      const t = await getTx(s.signature);
      const keys = (t?.transaction?.message?.accountKeys ?? []) as string[];
      all.push({ signature: s.signature, slot: s.slot, err: s.err ?? null, payer: keys[0] ?? null, payer_is: hot[keys[0] ?? ""] ?? (keys[0] === bind.body?.new_key ? "the agent's runtime key" : "other"), fee_lamports: t?.meta?.fee ?? null,
        payer_delta_lamports: t ? Number(t.meta.postBalances[0]) - Number(t.meta.preBalances[0]) : null, instructions: logs(t).filter((x) => x.includes("Instruction:")).map((x) => x.split("Instruction: ")[1]).join(",") });
    }
    S.chain_writes = all;
    S.balances = { deployer: sol(await rpc.getBalance(state!.admin)), core_authority: sol(await rpc.getBalance(state!.core_authority)), runtime_authority: sol(await rpc.getBalance(state!.runtime_authority)), launcher: sol(await rpc.getBalance(launcher)),
      runtime_key: bind.body?.new_key ? sol(await rpc.getBalance(bind.body.new_key)) : null, at: new Date().toISOString() };
    save();
    for (const w of all) log(`  write ${w.signature.slice(0, 12)}… slot ${w.slot} by ${w.payer_is} (${String(w.payer).slice(0, 6)}…): ${w.instructions || "?"}; fee ${sol(w.fee_lamports ?? 0)}, payer ${sol(w.payer_delta_lamports ?? 0)} SOL${w.err ? ` ERR ${JSON.stringify(w.err)}` : ""}`);
    log(`  balances ${JSON.stringify(S.balances)}`);

    // Core, indexer, pages
    const ca = await j(`/v1/agents/${agent}`);
    const cp = await j(`/v1/agents/${agent}/prepay`);
    check("Core: the agent is known, awake, with the prepaid deposit checked", ca.status === 200 && ca.body?.awake === true && cp.body?.ok === true, `HTTP ${ca.status} awake ${ca.body?.awake} lifecycle ${ca.body?.lifecycle}; prepay ${JSON.stringify(cp.body).slice(0, 300)}`);
    const mt = await j(`/market/tokens/${mint}`);
    const row = mt.body?.token ?? mt.body;
    check("indexer: the coin is listed with dollar figures", mt.status === 200 && Number(row?.price_usd ?? row?.market_cap_usd ?? 0) > 0, `HTTP ${mt.status} price_usd ${row?.price_usd} market_cap_usd ${row?.market_cap_usd} volume_24h_usd ${row?.volume_24h_usd}`);
    const browser = await chromium();
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.goto(`${BASE}/`);
      const card = await page.waitForFunction((sym: string) => Array.from(document.querySelectorAll("a, article, li, div")).some((e) => (e as HTMLElement).innerText?.includes(sym) && /\$\s?[\d.,]+/.test((e as HTMLElement).innerText) && (e as HTMLElement).innerText.length < 600), S.symbol ?? SEED.symbol, { timeout: 60_000 }).then(() => true, () => false);
      const cardText = ((await page.locator(`a[href*="${mint}"]`).first().innerText().catch(() => "")) as string).replace(/\s+/g, " ");
      await page.screenshot({ path: join(OUT, "10-explorer.png"), fullPage: true }).catch(() => {});
      check("page: the agent appears on the Explorer with dollar figures", card && /\$/.test(cardText), cardText.slice(0, 300) || "no card linking to the mint");
      await page.goto(`${BASE}/tokens/${mint}`);
      const tok = await page.waitForFunction(() => (document.querySelector("main")?.textContent ?? "").length > 300, null, { timeout: 90_000 }).then(() => true, () => false);
      await new Promise((r) => setTimeout(r, 6000));
      const tokText = ((await page.locator("main").innerText().catch(() => "")) as string).replace(/\s+/g, " ");
      await page.screenshot({ path: join(OUT, "11-token.png"), fullPage: true }).catch(() => {});
      check("page: the agent's token page loads", tok && /\$/.test(tokText), `${tokText.slice(0, 300)}; ${errors.length} page errors ${errors.slice(0, 2).join(" ; ")}`);
    } finally {
      await browser.close();
    }
    // the work
    const ss = await j(`/v1/sessions?agent=${agent}&limit=50`);
    const sessions = (Array.isArray(ss.body) ? ss.body : (ss.body?.sessions ?? [])) as any[];
    S.sessions = sessions.map((s) => ({ id: s.session_id, state: s.state, events: s.events, proposer: s.proposer, recipe: s.recipe_name, desktop: s.desktop ?? s.desktop_kind ?? null, started_at: s.started_at, ended_at: s.ended_at, outcome: s.outcome ?? null }));
    check("runtime: the agent started a session (its first attempt)", sessions.length > 0, sessions.length ? `${sessions.length} sessions; newest ${sessions[0].session_id?.slice(0, 12)} ${sessions[0].state}, ${sessions[0].events} events, proposer ${sessions[0].proposer}, ${sessions[0].recipe_name}` : `HTTP ${ss.status}, none yet`);
    const sp = await j(`/v1/agents/${agent}/spend`);
    S.spend = sp.body;
    const usd = Number(sp.body?.model_usd ?? sp.body?.total_usd ?? sp.body?.spent_usd ?? 0);
    check("runtime: a model call succeeded (model spend recorded for the agent)", usd > 0, `HTTP ${sp.status} ${JSON.stringify(sp.body).slice(0, 500)}`);
    const cs = await j(`/v1/candidates?author=${agent}&limit=50`);
    const cands = (Array.isArray(cs.body) ? cs.body : []) as any[];
    S.candidates = cands.map((c) => ({ id: c.candidate_id, status: c.status, verdict: c.verdict, target: c.target, gen: c.gen_id, reason: c.reason, replays: c.replays?.length ?? c.replay_count ?? null }));
    check("verification: the agent produced a candidate", cands.length > 0, cands.length ? cands.map((c) => `${String(c.candidate_id).slice(0, 12)} ${c.status}`).join(", ") : "none yet");
    const fin = cands.find((c) => c.verdict || ["accepted", "rejected", "final"].includes(String(c.status)));
    check("verification: a verifier replayed a candidate to a verdict", !!fin, fin ? `${String(fin.candidate_id).slice(0, 12)} ${fin.status} ${JSON.stringify(fin.verdict ?? fin.reason).slice(0, 300)}` : "no verdict yet");
    const corePosts = all.filter((w) => w.payer_is === "Core authority" && !w.err);
    check("chain: Core posted on chain since the launch", corePosts.length > 0, corePosts.length ? corePosts.map((w) => `${w.signature.slice(0, 12)}… ${w.instructions}`).join(" | ").slice(0, 600) : "no transaction paid by the Core authority since the launch");
  }

  try {
    if (PHASE === "launch") await phaseLaunch();
    else if (PHASE === "watch") await phaseWatch();
    else throw new Error(`unknown phase ${PHASE}`);
  } catch (e) {
    check(`${PHASE}: completed`, false, (e as Error).message.split("\n")[0]!.slice(0, 600));
    process.exitCode = 1;
  } finally {
    const mine = S.results.filter((r) => r.phase === PHASE);
    log(`${mine.filter((r) => r.ok).length}/${mine.length} checks pass; state in ${STATE_FILE}`);
  }
}
