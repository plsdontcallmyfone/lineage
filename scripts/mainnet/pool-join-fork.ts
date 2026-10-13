#!/usr/bin/env bun
// Joining a pool from the Pools page for agents that are ALREADY launched, on a local fork of mainnet
// that holds the live launch program and the live accounts as they are (docs/plans/AGENT-POOLS.md 11).
// Nothing is sent to mainnet and no real key is read: mainnet is read, every transaction goes to
// 127.0.0.1:9690.
//
// What the fork holds: units_launch exactly as deployed (the pools-and-claims build, its ProgramData
// untouched), every account the launch, registry and message programs own, the agents' coins, curves,
// vaults and fee accounts, $UNITS with its PumpSwap pool, the launch lookup table, pump.fun.
// THREE fields are replaced by throwaway keys, because the real keys are not used here: the registry
// `owner` of the two agents that join (the two launchers' wallets on mainnet) and PoolConfig.keeper
// (Core's keeper key on the server). Every other byte is mainnet's.
//
//   D=<empty dir outside the repo>; mkdir -p $D/keys $D/ledger
//   MAINNET_FORK_KEYS=$D/keys bun scripts/mainnet/pool-join-fork.ts --prepare $D      # reads mainnet, writes $D/accounts and the validator arguments
//   scripts/mainnet/fork.sh $D/ledger $(cat $D/fork-args) &
//   MAINNET_FORK_KEYS=$D/keys POOL_JOIN_FORK_DIR=$D UNITS_NETWORK=mainnet bun scripts/mainnet/pool-join-fork.ts
//   kill <the validator's PID, after checking what it is>
//
// The run: 0 the fork is mainnet; 1 the two live agents of karpathy/minbpe join through the Pools page
// itself, headless (a dashboard built from this tree on 127.0.0.1:9666 over the fork, a Core of this
// tree in this process on 9667 serving the pool routes from the fork, a wallet that signs with the
// stand-in owner key): the first opens the pool at 1280 px, the second joins it at 390 px, one
// approval each; 2 trades, then the fee crank keeper script (scripts/mainnet/crank-fees.ts) on both
// members; 3 a settlement, then Core's own keeper step: the payout, the cross holdings; 4 the Pools
// page shows the pool. Writes scripts/mainnet/POOL-JOIN-FORK-LAST.json. Ports 9666, 9667 (POOL_JOIN_CORE_PORT; checked
// free first) and a stand-in for two Core routes on a free port.
import { spawn, spawnSync, type Subprocess } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, keyFromSolanaJson } from "@units/protocol";
import {
  addressBytes, ata, ChainReader, compileMessageV0, crankSplit, decodeAgent, decodeAgentLaunch, decodeBondingCurve, decodeConfig, decodeCrossHolding, decodeLookupTable, decodeMint, decodePool, decodePoolConfig, decodePoolMember,
  decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount, FEATURES, launch, launchPdas, launchTableAddresses, maxSolIn, poolPdas, poolRates, pools, programDataAddress, pump, PUMP, pumpCrankIxs,
  pumpPdas, pumpSolToLinePool, quotePoolBuyExactOut, registryPdas, rentLamports, settlementAllocation, signBytes, signMessageWith, token, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_LEN, type Ix, type LookupTable, type Signer,
} from "@units/chain";
import { parseWire, placeSignature } from "../../packages/chain/src/browser/index.ts";
import { systemClock } from "../../packages/core/src/clock.ts";
import { loadNetworkConfig } from "../../packages/core/src/config.ts";
import { Core } from "../../packages/core/src/core.ts";
import { serve } from "../../packages/core/src/http.ts";
import { poolsOf } from "../../packages/core/src/pools.ts";
import { wirePoolsAndClaims } from "../../packages/core/src/pools-wiring.ts";
import { programIdsNow, useActiveProfile } from "./steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STATE = JSON.parse(readFileSync(join(ROOT, "config/mainnet/state.json"), "utf8"));
const LINE = STATE.line_mint as string, POOL = STATE.line_pool as { pool: string; baseVault: string; quoteVault: string }, TABLE = STATE.launch_lookup_table as string;
const T22 = TOKEN_2022_PROGRAM, ONE = 1_000_000n;
const SITE = (JSON.parse(readFileSync(join(ROOT, "config/sites.json"), "utf8")).mainnet_site_url as string).replace(/\/+$/, "");
/** The two live agents of karpathy/minbpe (the second is a swarm). */
const AGENT_A = "HHxDgMPdYJ5SCXNdsvtaQnng3PAPXrPtZGY2xYc4eDtX", AGENT_B = "CuvvtxbrrWhsqM1uj6ahUvEPTJrb78zfrUr4NVqGUpAo";
useActiveProfile({ ...process.env, UNITS_NETWORK: "mainnet" });
const IDS = programIdsNow();
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const argv = process.argv.slice(2);

// ================================================================ --prepare: read mainnet, write the fork's accounts
if (argv[0] === "--prepare") {
  const DIR = argv[1];
  if (!DIR || !existsSync(DIR)) throw new Error("usage: --prepare <existing empty directory outside the repo>");
  const { mainnet, forkKey } = await import("./lib.ts");
  const ownerA = forkKey("owner-a-stand-in"), ownerB = forkKey("owner-b-stand-in"), keeper = forkKey("pool-keeper");
  const forkSh = readFileSync(join(import.meta.dir, "fork.sh"), "utf8");
  const k = () => generateAgentKey().id;
  // what a purchase of $UNITS on its pool names (the pool purchase lane's own list)
  const pl = spawnSync(["bun", join(import.meta.dir, "pool-launch-fork.ts"), "--fork-args"], { env: { ...process.env, UNITS_NETWORK: "mainnet" } });
  if (pl.exitCode !== 0) throw new Error(`pool-launch-fork.ts --fork-args failed: ${pl.stderr.toString().slice(-400)}`);
  const want = new Set(pl.stdout.toString().trim().split(/\s+/).filter((t) => t && !t.startsWith("--")));
  const owned = { launch: await mainnet.getProgramAccounts(IDS.launch), registry: await mainnet.getProgramAccounts(IDS.registry), msg: await mainnet.getProgramAccounts(IDS.msg) };
  for (const a of [...owned.launch, ...owned.registry, ...owned.msg]) want.add(a.address);
  const disc = (n: string) => createHash("sha256").update(`account:${n}`).digest().subarray(0, 8).toString("hex");
  const isType = (d: Uint8Array, n: string) => Buffer.from(d.subarray(0, 8)).toString("hex") === disc(n);
  const agents = owned.launch.filter((a) => isType(a.data, "AgentLaunch")).map((a) => decodeAgentLaunch(a.data));
  const two = [AGENT_A, AGENT_B].map((id) => agents.find((a) => a.agent === id));
  if (!two[0] || !two[1] || two[0].repoId !== two[1].repoId) throw new Error("the two agents are not both launched on one repository");
  // every account a trade, a crank, a join, a pool purchase of the two agents names
  const u = k();
  const ixs: Ix[] = [];
  for (const a of two as NonNullable<(typeof two)[number]>[]) {
    ixs.push(token.createAtaIdempotent(u, u, a.mint, T22), pump.buyExactQuoteInV3({ mint: a.mint, quoteMint: LINE, quoteTokenProgram: T22, user: u, spendableQuoteIn: 1n, minTokensOut: 1n }),
      pump.sellV3({ mint: a.mint, quoteMint: LINE, quoteTokenProgram: T22, user: u, amount: 1n, minQuoteOut: 1n }),
      ...pumpCrankIxs({ payer: u, agent: a.agent, agentMint: a.mint, lineMint: LINE, lineTokenProgram: T22 }), launch.refreshAwake({ agent: a.agent, agentMint: a.mint }),
      pools.joinPool({ signer: u, agent: a.agent, agentMint: a.mint, repoId: a.repoId, lineMint: LINE, members: [] }),
      pools.poolBuy({ keeper: u, repoId: a.repoId, target: a.agent, targetMint: a.mint, lineMint: LINE, kind: 1, venue: 0, tokenAmount: 1n, maxQuote: 1n }));
    want.add(ata(a.agent, a.mint, T22));
  }
  for (const ix of ixs) { want.add(ix.programId); for (const m of ix.keys) want.add(m.pubkey); }
  for (const a of [TABLE, LINE, POOL.pool, POOL.baseVault, POOL.quoteVault, ...launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22, linePool: POOL }), PUMP.ammFeeConfig, PUMP.ammGlobalConfig, PUMP.wsol,
    registryPdas.treasury(), IDS.launch, programDataAddress(IDS.launch), IDS.registry, IDS.msg, ata(PUMP.buybackRecipients[0]!, LINE, T22)]) want.add(a);
  const BUILTIN = /^(11111111111111111111111111111111|ComputeBudget111111111111111111111111111111|TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL|AddressLookupTab1e1111111111111111111111111|Ed25519SigVerify1111111111111111111111111111|Sysvar.*|BPFLoader.*|NativeLoader1111111111111111111111111111111)$/;
  const keys = [...want].filter((a) => a !== u && !forkSh.includes(a) && !BUILTIN.test(a));
  const infos: Awaited<ReturnType<typeof mainnet.getMultipleAccounts>> = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...(await mainnet.getMultipleAccounts(keys.slice(i, i + 100))));
  const slot = await mainnet.getSlot();
  const accDir = join(DIR, "accounts");
  rmSync(accDir, { recursive: true, force: true });
  mkdirSync(accDir, { recursive: true });
  const args: string[] = [], patched: Record<string, string> = {};
  const real: Record<string, string> = {};
  let written = 0;
  keys.forEach((address, i) => {
    const a = infos[i];
    if (!a) return;
    if (a.executable && a.owner === LOADER) { args.push("--clone-upgradeable-program", address); return; }
    if (a.executable) { args.push("--clone", address); return; }
    if (a.owner === LOADER) return; // a ProgramData account comes with its program
    let data = a.data;
    const standIn = address === registryPdas.agent(AGENT_A) ? ownerA : address === registryPdas.agent(AGENT_B) ? ownerB : null;
    if (standIn) {
      real[address] = decodeAgent(data).owner;
      data = new Uint8Array(data);
      data.set(addressBytes(standIn.id), 40);
      if (decodeAgent(data).owner !== standIn.id) throw new Error("the owner field is not where this script writes it");
      patched[address] = "registry Agent: owner (bytes 40 to 71) replaced by a stand-in key";
    }
    if (address === poolPdas.config()) {
      real[address] = decodePoolConfig(data).keeper;
      data = new Uint8Array(data);
      data.set(addressBytes(keeper.id), 8);
      if (decodePoolConfig(data).keeper !== keeper.id) throw new Error("the keeper field is not where this script writes it");
      patched[address] = "PoolConfig: keeper (bytes 8 to 39) replaced by a stand-in key";
    }
    writeFileSync(join(accDir, `${address}.json`), JSON.stringify({ pubkey: address, account: { lamports: Number(a.lamports), data: [Buffer.from(data).toString("base64"), "base64"], owner: a.owner, executable: a.executable,
      rentEpoch: "RENT_EPOCH", space: data.length } }).replace('"RENT_EPOCH"', "18446744073709551615"));
    written++;
  });
  if (Object.keys(patched).length !== 3) throw new Error(`expected three replaced fields, wrote ${Object.keys(patched).length}`);
  args.push("--account-dir", accDir, "--warp-slot", String(slot));
  writeFileSync(join(DIR, "fork-args"), args.join(" ") + "\n");
  const pd = infos[keys.indexOf(programDataAddress(IDS.launch))];
  writeFileSync(join(DIR, "prepare.json"), JSON.stringify({ at: new Date().toISOString(), mainnet_slot: slot, patched, replaced_real_values: real, program_data_sha256: pd ? sha(pd.data) : null, program_data_bytes: pd?.data.length ?? null,
    agents: (two as NonNullable<(typeof two)[number]>[]).map((a) => ({ agent: a.agent, mint: a.mint, launcher: a.launcher, repo_url: a.repoUrl, repo_id: a.repoId, routes: a.routes })) }, null, 1));
  console.log(`[prepare] ${written} accounts written to ${accDir} (${owned.launch.length} of the launch program, ${owned.registry.length} of the registry, ${owned.msg.length} of messages), mainnet slot ${slot}; validator arguments in ${join(DIR, "fork-args")}`);
  process.exit(0);
}

// ================================================================ the run
const DIR = process.env.POOL_JOIN_FORK_DIR ?? "";
if (!DIR || !existsSync(join(DIR, "prepare.json"))) throw new Error("set POOL_JOIN_FORK_DIR to the directory --prepare filled");
const PREP = JSON.parse(readFileSync(join(DIR, "prepare.json"), "utf8")) as { mainnet_slot: number; patched: Record<string, string>; replaced_real_values: Record<string, string>; program_data_sha256: string;
  agents: { agent: string; mint: string; launcher: string; repo_url: string; repo_id: string; routes: number }[] };
const { airdrop, assertFork, check: check0, checks, fork, FORK_URL, forkKey, KEYS, log, mainnet, mainnetRent, measure, rows, sendV0, sleep, sol } = await import("./lib.ts");
await assertFork();
const PORTS = { web: 9666, core: Number(process.env.POOL_JOIN_CORE_PORT ?? 9667) };
for (const p of Object.values(PORTS)) if (spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim()) throw new Error(`port ${p} is taken`);
const reader = new ChainReader(fork);
const OUT_FILE = join(import.meta.dir, "POOL-JOIN-FORK-LAST.json");
let section = "0 fork";
const sections: Record<string, { passed: number; total: number }> = {};
const check = (name: string, ok: boolean, detail = "") => {
  const s = (sections[section] ??= { passed: 0, total: 0 });
  s.total++;
  if (ok) s.passed++;
  try { check0(`${section}: ${name}`, ok, detail); } catch { /* recorded in `checks`, the run goes on */ }
};
const ownerA = forkKey("owner-a-stand-in"), ownerB = forkKey("owner-b-stand-in"), keeper = forkKey("pool-keeper"), trader = forkKey("trader"), cranker = forkKey("cranker");
const [A, B] = PREP.agents as [typeof PREP.agents[number], typeof PREP.agents[number]];
const REPO = A.repo_id;
const acct = async <T>(a: string, d: (b: Uint8Array) => T): Promise<T> => d((await fork.getAccountInfo(a))!.data);
const bal = async (a: string) => { const i = await fork.getAccountInfo(a); return i ? decodeTokenAccount(i.data).amount : 0n; };
const tableAcc = await fork.getAccountInfo(TABLE);
if (!tableAcc) throw new Error("the launch lookup table is not on the fork");
const table: LookupTable = { address: TABLE, addresses: decodeLookupTable(tableAcc.data).addresses };
const tx = (name: string, payer: Signer, ixs: Ix[], cu = 600_000) => sendV0(section, name, payer, ixs, [table], { computeUnits: cu });
const out: Record<string, any> = { started: new Date().toISOString(), fork: FORK_URL, program: IDS.launch, mainnet_slot_of_the_copy: PREP.mainnet_slot, replaced_on_the_fork: PREP.patched, repository: A.repo_url, repo_id: REPO,
  agents: { a: A, b: B } };
const procs: Subprocess[] = [];
let stopCore = () => {}, browser: any = null, tmp = "";
let outcome = "PASS";

try {
  for (const k of [ownerA, ownerB, keeper, cranker]) await airdrop(k.id, 5_000_000_000n);
  await airdrop(trader.id, 2_000_000_000_000n);

  // ---------------------------------------------------------------- 0 the fork is mainnet
  const pdFork = (await fork.getAccountInfo(programDataAddress(IDS.launch)))!, pdMain = (await mainnet.getAccountInfo(programDataAddress(IDS.launch)))!;
  // the validator writes its own deployment slot into the 45-byte header of a cloned ProgramData; the code after it is what runs
  check("the launch program on the fork is the code deployed on mainnet, byte for byte", pdFork.data.length === pdMain.data.length && sha(pdFork.data.subarray(45)) === sha(pdMain.data.subarray(45)),
    `${pdFork.data.length - 45} bytes of code, sha256 ${sha(pdFork.data.subarray(45)).slice(0, 16)}`);
  const lc = (await reader.launchConfig())!, pcMain = decodePoolConfig((await mainnet.getAccountInfo(poolPdas.config()))!.data), pc = await acct(poolPdas.config(), decodePoolConfig);
  const same = (x: object, y: object) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(y, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  check("PoolConfig is mainnet's except the keeper; the pools bit is on; auto join is off", same({ ...pc, keeper: "" }, { ...pcMain, keeper: "" }) && pc.keeper === keeper.id && !!(lc.features & FEATURES.pools) && !pc.autoJoin,
    `pool fee ${pc.poolFeeBps} bps, split ${pc.payoutBps}/${pc.buybackBps}/${pc.burnBps}, cross holding ${pc.crossHoldQuote / ONE} $UNITS, at most ${pc.maxMembers} members`);
  const recA = await acct(registryPdas.agent(A.agent), decodeAgent), recB = await acct(registryPdas.agent(B.agent), decodeAgent);
  check("both agents are live launches of one repository, hosted and bound (their signing key is the runtime's, not the agent key), with no route and no pool; their owners here are the stand-in keys",
    A.repo_id === B.repo_id && recA.hosted && recB.hosted && recA.signingKey !== A.agent && recB.signingKey !== B.agent && A.routes === 0 && B.routes === 0 && !(await fork.getAccountInfo(poolPdas.pool(REPO)))
    && recA.owner === ownerA.id && recB.owner === ownerB.id, `${A.repo_url}: ${A.agent.slice(0, 6)} and ${B.agent.slice(0, 6)}`);

  // ---------------------------------------------------------------- 1 the join, through the Pools page
  section = "1 page";
  tmp = mkdtempSync(join(tmpdir(), "units-pool-join-fork-"));
  const genesis = await fork.call<string>("getGenesisHash");
  writeFileSync(join(tmp, "state.json"), JSON.stringify(STATE));
  writeFileSync(join(tmp, "profile.local.json"), JSON.stringify({ profiles: { mainnet: { genesis, state_file: join(tmp, "state.json") } } }));
  // a Core of this tree, in this process, with no chain bridge and no Core authority key: it serves the pool routes from the fork and runs the keeper
  process.env.UNITS_FEATURE_AGENT_POOLS = "1";
  process.env.UNITS_POOL_KEEPER_KEY = join(KEYS, "pool-keeper.json");
  const admin = generateAgentKey();
  writeFileSync(join(tmp, "admin.json"), JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });
  mkdirSync(join(tmp, "data"), { recursive: true });
  const core = new Core({ dataDir: join(tmp, "data"), network: loadNetworkConfig(join(ROOT, "config/network.json")), adminId: keyFromSolanaJson(JSON.parse(readFileSync(join(tmp, "admin.json"), "utf8"))).id, clock: systemClock,
    trees: null, chainMode: true });
  await wirePoolsAndClaims(core, reader, { launch_lookup_table: TABLE } as any, "mainnet");
  const coreServer = serve(core, { port: PORTS.core });
  stopCore = () => { coreServer.stop(true); core.close(); };
  const web = spawn(["bun", "apps/web/server.ts", "--port", String(PORTS.web), "--core", `http://127.0.0.1:${PORTS.core}`, "--market", SITE], { cwd: ROOT, stdout: Bun.file(join(tmp, "web.log")), stderr: Bun.file(join(tmp, "web.log")),
    env: { ...process.env, UNITS_NETWORK: "mainnet", UNITS_PROFILE_LOCAL: join(tmp, "profile.local.json"), UNITS_MAINNET_RPC: FORK_URL } });
  procs.push(web);
  const WEB = `http://127.0.0.1:${PORTS.web}`;
  for (let i = 0; ; i++) {
    const c = await fetch(`${WEB}/chain/config`).then((r) => r.json()).catch(() => null) as any;
    if (c?.genesis === genesis) break;
    if (c?.genesis && c.genesis !== genesis) throw new Error("the dashboard is not on the fork");
    if (i > 120) throw new Error("the dashboard did not start");
    await sleep(500);
  }
  const pw = await import("@playwright/test");
  const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  browser = await pw.chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });

  /** Opens the Pools page with a wallet that signs with `owner`, presses the agent's one action, reads the review, approves once. */
  async function joinOnPage(owner: Signer, agent: string, width: number): Promise<{ width: number; rowsShown: number; state: string | null; line: string; members: string[]; label: string; facts: string[]; cost: bigint;
    costLines: (string | null)[][]; noHorizontalScroll: boolean; approvalsBefore: number; approvals: number[]; signature: string; lineAfter: string; spent: bigint; errors: string[] }> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light" });
    const requests: number[] = [];
    await ctx.exposeFunction("__forkSign", (b64s: string[]) => {
      requests.push(b64s.length);
      return b64s.map((b64) => {
        const wire = new Uint8Array(Buffer.from(b64, "base64"));
        return Buffer.from(placeSignature(wire, owner.id, signBytes(owner, parseWire(wire).message))).toString("base64");
      });
    });
    await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
      const b64 = (x: Uint8Array) => btoa(String.fromCharCode(...x));
      const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      try { localStorage.setItem("units-wallet", "units Test Wallet"); localStorage.setItem("lineage-wallet", "units Test Wallet"); } catch {}
      const chains = ["solana:mainnet"];
      const account = { address, publicKey: new Uint8Array(pub), chains, features: ["solana:signTransaction"], label: "fork" };
      const w = {
        version: "1.0.0", name: "units Test Wallet", chains, accounts: [] as unknown[],
        icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
          "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
            signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
              ((await (window as any).__forkSign(inputs.map((i) => b64(i.transaction)))) as string[]).map((s) => ({ signedTransaction: unb64(s) })) },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
    }, { address: owner.id, pub: Array.from(addressBytes(owner.id)) });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`${WEB}/pools`, { waitUntil: "domcontentloaded" });
    const row = page.locator(`[data-pool-join] [data-pj-agent="${agent}"]`);
    await row.waitFor({ timeout: 120_000 });
    const rowsShown = await page.locator("[data-pool-join] [data-pj-agent]").count();
    const state = await row.getAttribute("data-pj-state"), line = await row.locator("[data-pj-line]").innerText(), members = await row.locator("[data-pj-member]").allInnerTexts();
    const button = row.locator('[data-pj-act="review"]');
    const label = await button.innerText();
    await button.click();
    const review = page.locator(`[data-pj-review="${agent}"]`);
    await review.waitFor({ timeout: 120_000 });
    const facts = await review.locator("[data-pj-fact]").allInnerTexts();
    const cost = BigInt((await review.locator("[data-pj-cost]").getAttribute("data-pj-cost"))!);
    const costLines = await review.locator("[data-pj-cost-line]").evaluateAll((els: Element[]) => els.map((e) => [e.getAttribute("data-pj-cost-line"), e.getAttribute("data-lamports")]));
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const signedBefore = requests.length;
    const before = await fork.getBalance(owner.id);
    await review.locator('[data-pj-act="sign"]').click();
    const link = row.locator("[data-pj-tx]");
    await link.waitFor({ timeout: 180_000 });
    const signature = (await link.getAttribute("data-pj-tx"))!;
    await page.locator(`[data-pool-join] [data-pj-agent="${agent}"][data-pj-state="member"]`).waitFor({ timeout: 60_000 });
    const after = await row.locator("[data-pj-line]").innerText();
    const spent = BigInt(before) - BigInt(await fork.getBalance(owner.id));
    await ctx.close();
    return { width, rowsShown, state, line, members, label, facts, cost, costLines, noHorizontalScroll: scroll, approvalsBefore: signedBefore, approvals: requests, signature, lineAfter: after, spent, errors };
  }

  const ja = await joinOnPage(ownerA, A.agent, 1280);
  const ca = await measure(section, "join_pool from the Pools page (first member: Pool, its vault, PoolMember)", ja.signature);
  check("first agent, 1280 px: the page lists exactly the agent this wallet owns and offers to open its repository's pool, saying plainly that nothing is routed until a second agent joins",
    ja.rowsShown === 1 && ja.state === "open" && /^Open this repository's pool with /.test(ja.label) && ja.line.includes("A pool starts routing fees only when a second agent joins.") && ja.errors.length === 0, `"${ja.label}"`);
  check("its review states the chain's numbers and that joining cannot be undone", ja.facts.some((f) => f.startsWith(`${pc.poolFeeBps / 100}% of the creator fees`)) && ja.facts.some((f) => f.includes(`${pc.payoutBps / 100}% is paid to members`))
    && ja.facts.some((f) => f.includes("Your wallet does not pay for this")) && ja.facts.some((f) => f.startsWith("Joining cannot be undone.")) && ja.noHorizontalScroll, ja.facts[0]);
  check("ONE wallet approval of one transaction, nothing offered to the wallet before the review; it landed, and the wallet spent exactly what the review said (rent of three accounts and the fee)",
    ja.approvalsBefore === 0 && ja.approvals.length === 1 && ja.approvals[0] === 1 && ja.spent === ja.cost && ca.created.length === 3, `${ja.spent} lamports on the fork; ${sol(BigInt(ca.payerMainnet))} SOL at mainnet rent; ${ca.computeUnits} CU; ${ja.signature}`);
  {
    const p = await acct(poolPdas.pool(REPO), decodePool), l = (await reader.agentLaunch(A.mint))!;
    check("on chain: the pool of the repository exists with this agent as its only member, the agent's record carries the pool bit, and the agent's key signed nothing (one signature, the owner's)",
      p.members.length === 1 && p.members[0] === A.agent && l.routes === FEATURES.pools && ca.signatures === 1 && ca.payer === ownerA.id, `pool ${poolPdas.pool(REPO)}`);
    check("the page then shows the agent as a member, alone so far", ja.lineAfter.includes("alone so far"), ja.lineAfter);
  }
  const jb = await joinOnPage(ownerB, B.agent, 390);
  const cb = await measure(section, "join_pool from the Pools page (second member: PoolMember)", jb.signature);
  check("second agent, 390 px: the page offers to join the pool that exists and lists its member", jb.rowsShown === 1 && jb.state === "join" && /^Join the pool of karpathy\/minbpe$/.test(jb.label) && jb.members.length === 1
    && jb.noHorizontalScroll && jb.errors.length === 0, `"${jb.label}", member shown: ${jb.members.join(", ")}`);
  check("its review says routing starts for both and names the cross holding with its amount", jb.facts.some((f) => f.includes("With this agent the pool has two members, so routing starts for both."))
    && jb.facts.some((f) => f.includes(`(${Number(pc.crossHoldQuote / ONE).toLocaleString("en-US")} UNITS) of the other member's coin`)), jb.facts.find((f) => f.startsWith("Cross holding"))?.slice(0, 200) ?? "");
  check("ONE wallet approval; it landed; the wallet spent exactly what the review said (the rent of its membership and the fee)", jb.approvalsBefore === 0 && jb.approvals.length === 1 && jb.approvals[0] === 1 && jb.spent === jb.cost
    && cb.created.length === 1, `${jb.spent} lamports on the fork; ${sol(BigInt(cb.payerMainnet))} SOL at mainnet rent; ${cb.computeUnits} CU; ${jb.signature}`);
  {
    const p = await acct(poolPdas.pool(REPO), decodePool), ma = await acct(poolPdas.member(A.agent), decodePoolMember), mb = await acct(poolPdas.member(B.agent), decodePoolMember);
    check("on chain: two members in join order, both records carry the pool bit, each owes one cross holding purchase of the configured amount", p.members.join() === [A.agent, B.agent].join() && (await reader.agentLaunch(B.mint))!.routes === FEATURES.pools
      && ma.crossPairs === 1 && mb.crossPairs === 1 && ma.crossDue === pc.crossHoldQuote && mb.crossDue === pc.crossHoldQuote, `cross due ${ma.crossDue / ONE} and ${mb.crossDue / ONE} $UNITS`);
  }
  out.page = { first: { ...ja, cost: ja.cost.toString(), spent: ja.spent.toString(), mainnet_lamports: ca.payerMainnet, compute_units: ca.computeUnits, created_bytes: ca.created.map((c) => c.bytes) },
    second: { ...jb, cost: jb.cost.toString(), spent: jb.spent.toString(), mainnet_lamports: cb.payerMainnet, compute_units: cb.computeUnits, created_bytes: cb.created.map((c) => c.bytes) } };

  // ---------------------------------------------------------------- 2 routed cranks, by the keeper script
  section = "2 crank";
  const rent0 = BigInt(await fork.getMinimumBalanceForRentExemption(0)), rentToken = rentLamports(TOKEN_ACCOUNT_LEN, rent0);
  const poolNow = async () => {
    const [gA, ammFcA, pA, bA, qA, mA] = await fork.getMultipleAccounts([PUMP.global, PUMP.ammFeeConfig, POOL.pool, POOL.baseVault, POOL.quoteVault, LINE]);
    const g = decodePumpGlobal(gA!.data), pool = decodePumpPool(pA!.data), base = decodeTokenAccount(bA!.data).amount, quote = decodeTokenAccount(qA!.data).amount;
    const rates = poolRates({ creatorFeeConfigurable: g.creatorFeeConfigurable }, decodePumpFeeConfig(ammFcA!.data), pool, decodeMint(mA!.data).supply, quote + pool.virtualQuoteReserves, base);
    return (o: bigint) => quotePoolBuyExactOut(rates, pool, base, quote, o);
  };
  const buyUnits = async (amount: bigint) => {
    const q = (await poolNow())(amount);
    await tx(`trader buys ${amount / ONE} $UNITS on the pool`, trader, pumpSolToLinePool({ launcher: trader.id, lineMint: LINE, pool: POOL.pool, amountOut: amount, maxSolIn: maxSolIn(q.quoteIn, 500), rentToken, lineTokenProgram: T22 }), 300_000);
  };
  /** A round trip on an agent coin's curve: the trader buys with a fifth of the curve's virtual $UNITS and sells what it bought. The curve ends where it began; creator fees accrue on both legs. */
  const roundTrip = async (mint: string, tag: string) => {
    const c = await acct(pumpPdas.bondingCurve(mint), decodeBondingCurve), spend = c.virtualQuoteReserves / 5n;
    if ((await bal(ata(trader.id, LINE, T22))) < spend) await buyUnits(spend * 2n);
    const h0 = await bal(ata(trader.id, mint, T22));
    await tx(`trader buys ${tag}`, trader, [token.createAtaIdempotent(trader.id, trader.id, mint, T22), pump.buyExactQuoteInV3({ mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, spendableQuoteIn: spend, minTokensOut: 1n })], 400_000);
    const got = (await bal(ata(trader.id, mint, T22))) - h0;
    await tx(`trader sells ${tag}`, trader, [pump.sellV3({ mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, amount: got, minQuoteOut: 1n })], 400_000);
  };
  // a stand-in for the two Core routes the keeper script reads (the agent list and the coin's dollar price)
  let served: { agent_id: string; mint: string }[] = [];
  const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/v1/agents") return Response.json(served);
    if (p === "/market/quote-usd") return Response.json({ ok: true, usd: 0.001 });
    return new Response("not served by the stand-in", { status: 404 });
  } });
  const crankScript = join(import.meta.dir, "crank-fees.ts");
  const keeperRun = async (agentsServed: { agent_id: string; mint: string }[]) => {
    served = agentsServed;
    const p = spawn(["bun", crankScript, "--core", `http://127.0.0.1:${stub.port}`, "--key", join(KEYS, "cranker.json"), "--min-usd", "0", "--send"], { cwd: ROOT, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, UNITS_NETWORK: "mainnet", UNITS_MAINNET_RPC: FORK_URL } });
    const t = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    return t;
  };
  const four = async (agent: string) => [await bal(launchPdas.computeVault(agent)), await bal(registryPdas.treasury()), await bal(poolPdas.vault(REPO, LINE, T22))] as [bigint, bigint, bigint];
  check("the fee crank keeper script in this tree is the route-aware one", readFileSync(crankScript, "utf8").includes("crankRouteKeys"));
  await roundTrip(A.mint, `${A.agent.slice(0, 6)}'s coin (fees for the refused crank)`);
  {
    const eight = await fork.simulate(signMessageWith(compileMessageV0(cranker.id, pumpCrankIxs({ payer: cranker.id, agent: A.agent, agentMint: A.mint, lineMint: LINE, lineTokenProgram: T22 }),
      (await fork.getLatestBlockhash()).blockhash, [table]), [cranker]).wire);
    check("a crank without the route accounts is refused for a member that joined after its launch (MissingRouteAccounts): the fees wait, nothing is lost", !!eight.err && (eight.logs ?? []).some((l) => l.includes("MissingRouteAccounts")));
  }
  const cranks: Record<string, unknown>[] = [];
  const crankOnce = async (m: typeof A, tag: string) => {
    await roundTrip(m.mint, tag);
    const b0 = await four(m.agent), l0 = (await reader.agentLaunch(m.mint))!, m0 = await acct(poolPdas.member(m.agent), decodePoolMember), p0 = await acct(poolPdas.pool(REPO), decodePool);
    const t = await keeperRun([{ agent_id: m.agent, mint: m.mint }]);
    const b1 = await four(m.agent), fees = (await reader.agentLaunch(m.mint))!.feesClaimed - l0.feesClaimed, w = crankSplit(fees, lc.agentComputeBps, 0, pc.poolFeeBps);
    const m1 = await acct(poolPdas.member(m.agent), decodePoolMember), p1 = await acct(poolPdas.pool(REPO), decodePool);
    const cross = w.toPool < m0.crossDue ? w.toPool : m0.crossDue, rest = w.toPool - cross;
    const exact = fees > 0n && b1[0] - b0[0] === w.toCompute && b1[1] - b0[1] === w.toProtocol && b1[2] - b0[2] === w.toPool && m1.contributed - m0.contributed === w.toPool
      && m1.crossFunded - m0.crossFunded === cross && m0.crossDue - m1.crossDue === cross
      && p1.bucketPayout - p0.bucketPayout === (rest * BigInt(pc.payoutBps)) / 10_000n && p1.bucketBuyback - p0.bucketBuyback === (rest * BigInt(pc.buybackBps)) / 10_000n;
    cranks.push({ agent: m.agent, fees: fees.toString(), to_compute: w.toCompute.toString(), to_protocol: w.toProtocol.toString(), to_pool: w.toPool.toString(), to_its_cross_holding: cross.toString(), to_buckets: rest.toString(), exact,
      keeper_script: t.trim().split("\n").slice(-3).map((l) => l.slice(0, 220)) });
    return { exact, fees, w, cross, rest, sent: /cranked /.test(t) && /4 route accounts follow/.test(t), text: t };
  };
  const first = await crankOnce(A, `${A.agent.slice(0, 6)}'s coin`);
  check("routed crank of the first member, sent by the keeper script with the four route accounts it read from chain: compute, protocol and pool amounts exact; the pool share funds its cross holding first", first.exact && first.sent
    && first.w.toPool === (first.fees * BigInt(lc.agentComputeBps) / 10_000n) * BigInt(pc.poolFeeBps) / 10_000n, `fees ${first.fees}: compute ${first.w.toCompute}, protocol ${first.w.toProtocol}, pool ${first.w.toPool} (cross holding ${first.cross}, buckets ${first.rest})`);
  const second = await crankOnce(B, `${B.agent.slice(0, 6)}'s coin`);
  check("routed crank of the second member (joined second, a swarm): exact as well", second.exact && second.sent, `fees ${second.fees}: compute ${second.w.toCompute}, protocol ${second.w.toProtocol}, pool ${second.w.toPool} (cross holding ${second.cross}, buckets ${second.rest})`);
  // more volume until both members' cross holdings are covered and the buckets hold something to settle
  let rounds = 2, allExact = true;
  for (let i = 0; i < 40; i++) {
    const ma = await acct(poolPdas.member(A.agent), decodePoolMember), mb = await acct(poolPdas.member(B.agent), decodePoolMember), p = await acct(poolPdas.pool(REPO), decodePool);
    if (ma.crossDue === 0n && mb.crossDue === 0n && p.bucketPayout > 0n) break;
    const m = ma.crossDue > 0n || mb.crossDue === 0n ? A : B;
    const r = await crankOnce(m, `${m.agent.slice(0, 6)}'s coin`);
    allExact &&= r.exact && r.sent;
    rounds++;
  }
  const pAfter = await acct(poolPdas.pool(REPO), decodePool), mA1 = await acct(poolPdas.member(A.agent), decodePoolMember), mB1 = await acct(poolPdas.member(B.agent), decodePoolMember);
  check(`after ${rounds} routed cranks, every one exact: both members' cross holdings are covered from their own pool shares and what came after is in the three buckets by the configured split`, allExact && mA1.crossDue === 0n && mB1.crossDue === 0n
    && mA1.crossFunded === pc.crossHoldQuote && mB1.crossFunded === pc.crossHoldQuote && pAfter.bucketPayout > 0n
    && (await bal(poolPdas.vault(REPO, LINE, T22))) === pAfter.bucketPayout + pAfter.bucketBuyback + pAfter.bucketBurn + mA1.crossFunded + mB1.crossFunded,
    `vault ${(await bal(poolPdas.vault(REPO, LINE, T22)))} = payouts ${pAfter.bucketPayout} + buybacks ${pAfter.bucketBuyback} + burns ${pAfter.bucketBurn} + cross holdings ${mA1.crossFunded + mB1.crossFunded}`);
  out.cranks = cranks;
  stub.stop(true);

  // ---------------------------------------------------------------- 3 a settlement, then Core's own keeper
  section = "3 settle and pay";
  const rc = await acct(registryPdas.config(), decodeConfig), epoch = Number(rc.lastEpoch);
  // the fresh Core of this run holds no verified work, so its own settlement record would be empty and it would post none. The settlement is posted
  // here by the keeper key with TEST inputs (one generation credited to the first member) for the registry's last posted epoch; everything after it is Core's keeper.
  const settle = (by: string) => pools.poolSettle({ keeper: by, repoId: REPO, members: [A.agent, B.agent], epoch, gens: 1, weights: [10_000, 0], milestones: 0, evidence: "11".repeat(32) });
  {
    const bad = await fork.simulate(signMessageWith(compileMessageV0(ownerA.id, [settle(ownerA.id)], (await fork.getLatestBlockhash()).blockhash, [table]), [ownerA]).wire);
    check("refused: a settlement by a member's owner (only the keeper settles)", !!bad.err && (bad.logs ?? []).some((l) => l.includes("Unauthorized")));
  }
  await tx("pool_settle", keeper, [settle(keeper.id)]);
  const alloc = settlementAllocation(pc, { payout: pAfter.bucketPayout, buyback: pAfter.bucketBuyback, burn: pAfter.bucketBurn }, { gens: 1, weights: [10_000, 0], milestones: 0 });
  const ms = [await acct(poolPdas.member(A.agent), decodePoolMember), await acct(poolPdas.member(B.agent), decodePoolMember)];
  check(`a settlement for the registry's posted epoch ${epoch} (a live epoch of the copy; TEST inputs: one generation credited to the first member): each member's payout and buyback equal the offchain recomputation`,
    ms.every((s, i) => s.payoutDue === alloc[i]!.payout && s.buybackDue === alloc[i]!.buyback && s.burnDue === alloc[i]!.burn) && ms[0]!.payoutDue === pAfter.bucketPayout && ms[0]!.payoutDue > 0n,
    ms.map((s, i) => `${i === 0 ? "first" : "second"}: payout ${s.payoutDue}, buyback ${s.buybackDue}, burn ${s.burnDue}`).join("; "));
  const cv0 = await bal(launchPdas.computeVault(A.agent));
  const mirrored0 = poolsOf(core).members(REPO).length;
  const step = await poolsOf(core).keeperStep();
  out.core_keeper_step = step;
  const did = (kind: string) => step.actions.filter((a) => a.kind === kind && a.signature).length;
  check("Core's keeper, started before the pool existed and never restarted, finds the pool on its next step (it lists Pool accounts from chain) and mirrors its two members", step.pools === 1 && poolsOf(core).members(REPO).length === 2,
    `mirror before the step: ${mirrored0} members; actions: ${step.actions.map((a) => `${a.kind}${a.error ? " FAILED" : ""}`).join(", ")}`);
  check("Core's keeper paid the author's payout into its compute vault, exactly the settled amount", did("pay") === 1 && (await bal(launchPdas.computeVault(A.agent))) - cv0 === ms[0]!.payoutDue
    && (await acct(poolPdas.member(A.agent), decodePoolMember)).payoutDue === 0n, `${ms[0]!.payoutDue} base units of $UNITS (${Number(ms[0]!.payoutDue) / 1e6} $UNITS)`);
  {
    const ab = await fork.getAccountInfo(poolPdas.cross(A.agent, B.agent)), ba = await fork.getAccountInfo(poolPdas.cross(B.agent, A.agent));
    const hab = await bal(poolPdas.heldBy(A.agent, B.mint)), hba = await bal(poolPdas.heldBy(B.agent, A.mint));
    check("Core's keeper bought both cross holdings: each agent holds the other's coin in its own token account, bought for at most the configured amount from its own pool share, none left with the pool",
      did("cross_buy") === 2 && !!ab && !!ba && hab > 0n && hba > 0n && decodeCrossHolding(ab.data).quoteSpent <= pc.crossHoldQuote && decodeCrossHolding(ba.data).quoteSpent <= pc.crossHoldQuote
      && decodeCrossHolding(ab.data).tokens === hab && (await bal(poolPdas.holding(REPO, B.mint))) === (await acct(poolPdas.member(B.agent), decodePoolMember)).tokensHeld,
      ab && ba ? `first holds ${hab} base units of the second's coin for ${decodeCrossHolding(ab.data).quoteSpent} base units of $UNITS; second holds ${hba} of the first's for ${decodeCrossHolding(ba.data).quoteSpent}` : "a CrossHolding is missing");
  }
  check("no keeper action failed", step.actions.every((a) => !a.error), step.actions.filter((a) => a.error).map((a) => `${a.kind}: ${a.error}`).join(" | ").slice(0, 300));
  {
    const p = await acct(poolPdas.pool(REPO), decodePool), mm = [await acct(poolPdas.member(A.agent), decodePoolMember), await acct(poolPdas.member(B.agent), decodePoolMember)];
    const owed = p.bucketPayout + p.bucketBuyback + p.bucketBurn + mm.reduce((s, m) => s + m.crossFunded + m.payoutDue + m.buybackDue + m.burnDue, 0n);
    check("afterwards the vault holds exactly what the pool still owes (buckets and members' dues)", (await bal(poolPdas.vault(REPO, LINE, T22))) === owed, `${owed} base units`);
  }

  // ---------------------------------------------------------------- 4 the Pools page shows it
  section = "4 page after";
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    const page = await ctx.newPage();
    await page.goto(`${WEB}/pools`, { waitUntil: "domcontentloaded" });
    const card = page.locator(`article[data-pool="${REPO}"]`);
    await card.waitFor({ timeout: 120_000 });
    const vault = await card.locator("[data-pool-vault]").getAttribute("data-pool-vault"), members = await card.locator("[data-pool-member]").count();
    const launchHref = await card.locator("[data-pool-launch]").getAttribute("href").catch(() => null);
    await card.locator("details[data-pool-more] summary").click();
    await card.locator("[data-pool-actions] li").first().waitFor({ timeout: 60_000 });
    const sent = await card.locator("[data-pool-actions] li").count(), noSettle = await card.locator('[data-pool-none="settlements"]').count();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check("a visitor at 390 px sees the pool: two members, the vault balance the chain holds, the keeper's transactions folded under it, no horizontal scroll", members === 2 && BigInt(vault!) === (await bal(poolPdas.vault(REPO, LINE, T22)))
      && sent === step.actions.filter((a) => a.signature).length && scroll, `${sent} keeper transactions listed; vault ${vault}`);
    check("the settlement posted by hand is not in Core's own list, and the page says there is none from Core rather than inventing one", noSettle === 1);
    out.page_after = { members, vault, keeper_transactions_listed: sent, launch_link: launchHref };
    await ctx.close();
  }
} catch (e) {
  outcome = "FAIL";
  console.error(`[fork] stopped: ${(e as Error).stack ?? e}`);
  out.stopped = String((e as Error).message ?? e).slice(0, 600);
} finally {
  await browser?.close().catch(() => {});
  for (const p of procs) p.kill(); // each by its own handle, nothing by name
  stopCore();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
if (checks.some((c: { ok: boolean }) => !c.ok)) outcome = "FAIL";
out.sections = sections;
out.checks = checks;
out.transactions = rows.length;
out.costs = rows.filter((r: { what: string }) => /join_pool|pool_settle/.test(r.what)).map((r: any) => ({ what: r.what, payer_mainnet_lamports: r.payerMainnet, fee: r.fee, compute_units: r.computeUnits, created_bytes: r.created.map((c: any) => c.bytes) }));
out.mainnet_rent_checked = { pool_member_195_bytes: (await mainnetRent(195)).toString() };
out.outcome = outcome;
out.finished = new Date().toISOString();
writeFileSync(OUT_FILE, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
log(`${outcome} ${checks.filter((c: { ok: boolean }) => c.ok).length}/${checks.length}, ${rows.length} transactions on the fork; nothing was sent to mainnet`);
process.exit(outcome === "PASS" ? 0 : 1);
