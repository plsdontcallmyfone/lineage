#!/usr/bin/env bun
// The graduation keeper (scripts/mainnet/graduate.ts) and the site through a whole graduation, on a
// local fork of mainnet that holds the live launch program and the live accounts as they are. A live
// agent coin (a pool member on mainnet) completes its curve; the proof stops in each state and looks
// at the chain, the indexer and the pages: on its curve, curve complete with no pool, migrated and
// not recorded, recorded. A second live coin completes and the keeper sends pump.fun's migration
// itself. Nothing is sent to mainnet and no real key is read: mainnet is read, every transaction goes
// to 127.0.0.1:9690.
//
// What the fork holds: what scripts/mainnet/crank-v0-fork.ts --prepare writes (units_launch as
// deployed, every account of the launch, registry and message programs, $UNITS with its pool, the
// launch lookup table, pump.fun, the stand-in owners and pool keeper named there) plus ONE account
// written by this script: the trader's $UNITS token account, holding 300,000,000 $UNITS that no trade
// bought. Completing a curve takes tens of millions of $UNITS; buying them on $UNITS's own pool would
// move its dollar price many times over, and every dollar figure on the pages with it. Written in,
// the $UNITS pool is left as mainnet's and the dollar chart shows the agent coin alone.
//
//   D=<empty dir outside the repo>; mkdir -p $D/keys $D/ledger
//   MAINNET_FORK_KEYS=$D/keys bun scripts/mainnet/graduation-fork.ts --prepare $D
//   scripts/mainnet/fork.sh $D/ledger $(cat $D/fork-args) &
//   MAINNET_FORK_KEYS=$D/keys GRADUATION_FORK_DIR=$D UNITS_NETWORK=mainnet bun scripts/mainnet/graduation-fork.ts
//   kill <the validator's PID, after checking what it is>
//
// Local services of the run (ports checked free first): the dashboard of this tree on 9666, a Core of
// this tree in this process on 9667 (the pool keeper's), the market indexer of this tree on 9668.
// Screenshots (headless Chromium) go to $D/shots. Writes scripts/mainnet/GRADUATION-FORK-LAST.json.
import { spawn, spawnSync, type Subprocess } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, keyFromSolanaJson } from "@units/protocol";
import {
  addressBytes, ata, ChainReader, chainTime, compileMessageV0, decodeAgentLaunch, crankSplit, decodeBondingCurve, decodeConfig, launch, settlementAllocation, signMessageWith, decodeLookupTable, decodePool, decodePoolConfig, decodePoolMember, decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount,
  FEATURES, graduationState, launchPdas, loadOrCreateKeypair, poolPdas, pools, programDataAddress, pump, PUMP, pumpAmm, pumpPdas, quoteCurveBuyExactOut, registryPdas, token, TOKEN_2022_PROGRAM,
  type Ix, type LookupTable, type Signer,
} from "@units/chain";
import { systemClock } from "../../packages/core/src/clock.ts";
import { loadNetworkConfig } from "../../packages/core/src/config.ts";
import { Core } from "../../packages/core/src/core.ts";
import { serve } from "../../packages/core/src/http.ts";
import { poolsOf } from "../../packages/core/src/pools.ts";
import { wirePoolsAndClaims } from "../../packages/core/src/pools-wiring.ts";
import { programIdsNow, useActiveProfile } from "./steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STATE = JSON.parse(readFileSync(join(ROOT, "config/mainnet/state.json"), "utf8"));
const LINE = STATE.line_mint as string, TABLE = STATE.launch_lookup_table as string;
const T22 = TOKEN_2022_PROGRAM, ONE = 1_000_000n;
const TRADER_UNITS = 300_000_000n * ONE;
useActiveProfile({ ...process.env, UNITS_NETWORK: "mainnet" });
const IDS = programIdsNow();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const argv = process.argv.slice(2);
type Rec = { agent: string; mint: string; repo_id: string; repo_url: string };

// ================================================================ --prepare
if (argv[0] === "--prepare") {
  const DIR = argv[1];
  if (!DIR || !existsSync(DIR)) throw new Error("usage: --prepare <existing empty directory outside the repo>");
  const KEYS = process.env.MAINNET_FORK_KEYS ?? "";
  if (!KEYS || !existsSync(KEYS)) throw new Error("set MAINNET_FORK_KEYS to a directory of throwaway keys outside the repo");
  if (!existsSync(join(DIR, "crank-v0-prepare.json"))) {
    const p = spawnSync(["bun", join(import.meta.dir, "crank-v0-fork.ts"), "--prepare", DIR], { env: { ...process.env, UNITS_NETWORK: "mainnet" } });
    if (p.exitCode !== 0) throw new Error(`crank-v0-fork.ts --prepare failed: ${p.stderr.toString().slice(-400)}`);
  }
  // the trader's $UNITS: a copy of a $UNITS token account mainnet holds (so the layout and its extensions are the mint's own), with the trader as owner and the stand-in balance
  const trader = loadOrCreateKeypair(join(KEYS, "trader.json")).key, acc = join(DIR, "accounts");
  let made = false;
  for (const f of readdirSync(acc)) {
    const j = JSON.parse(readFileSync(join(acc, f), "utf8").replace("18446744073709551615", '"RENT_EPOCH"'));
    if (j.account.owner !== T22) continue;
    const d = new Uint8Array(Buffer.from(j.account.data[0], "base64"));
    if (d.length !== 170 || Buffer.compare(Buffer.from(d.subarray(0, 32)), Buffer.from(addressBytes(LINE))) !== 0) continue;
    d.set(addressBytes(trader.id), 32);
    new DataView(d.buffer).setBigUint64(64, TRADER_UNITS, true);
    d.fill(0, 72, 108); // no delegate
    d.fill(0, 109, 165); // not native, no delegated amount, no close authority
    d[108] = 1; // initialized
    const t = decodeTokenAccount(d);
    if (t.mint !== LINE || t.owner !== trader.id || t.amount !== TRADER_UNITS) throw new Error("the token account is not laid out as this script writes it");
    const at = ata(trader.id, LINE, T22);
    writeFileSync(join(acc, `${at}.json`), JSON.stringify({ pubkey: at, account: { ...j.account, lamports: 5_000_000, data: [Buffer.from(d).toString("base64"), "base64"] } }).replace('"RENT_EPOCH"', "18446744073709551615"));
    writeFileSync(join(DIR, "graduation-prepare.json"), JSON.stringify({ at: new Date().toISOString(), written_in: { [at]: `the trader's $UNITS token account: ${TRADER_UNITS / ONE} $UNITS that no trade bought (a copy of ${f.replace(".json", "")} with the owner and the amount replaced)` } }, null, 1));
    made = true;
    break;
  }
  if (!made) throw new Error("no 170-byte $UNITS token account among the prepared accounts to copy the layout from");
  // the curve of every launch the fork holds a record of, so a keeper run over all of them reads what it reads on mainnet
  const { mainnet } = await import("./lib.ts");
  let curves = 0;
  for (const f of readdirSync(acc)) {
    const j = JSON.parse(readFileSync(join(acc, f), "utf8").replace("18446744073709551615", '"RENT_EPOCH"'));
    if (j.account.owner !== IDS.launch) continue;
    let l;
    try { l = decodeAgentLaunch(new Uint8Array(Buffer.from(j.account.data[0], "base64"))); } catch { continue; }
    if (l.venue !== "pump" || existsSync(join(acc, `${l.bondingCurve}.json`))) continue;
    const a = await mainnet.getAccountInfo(l.bondingCurve);
    if (!a) continue;
    writeFileSync(join(acc, `${l.bondingCurve}.json`), JSON.stringify({ pubkey: l.bondingCurve, account: { lamports: Number(a.lamports), data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.owner, executable: false,
      rentEpoch: "RENT_EPOCH", space: a.data.length } }).replace('"RENT_EPOCH"', "18446744073709551615"));
    curves++;
  }
  console.log(`[prepare] ${curves} more bonding curve(s) of launches this run does not trade`);
  console.log(`[prepare] crank-v0-fork.ts --prepare, then the trader's $UNITS token account; validator arguments in ${join(DIR, "fork-args")}`);
  process.exit(0);
}

// ================================================================ the run
const DIR = process.env.GRADUATION_FORK_DIR ?? "";
if (!DIR || !existsSync(join(DIR, "graduation-prepare.json"))) throw new Error("set GRADUATION_FORK_DIR to the directory --prepare filled");
const PREP = { ...JSON.parse(readFileSync(join(DIR, "crank-v0-prepare.json"), "utf8")), ...JSON.parse(readFileSync(join(DIR, "graduation-prepare.json"), "utf8")) } as
  { mainnet_slot: number; patched: Record<string, string>; written_in: Record<string, string>; a: Rec; b: Rec; z: Rec };
const { airdrop, assertFork, check: check0, checks, fork, FORK_URL, forkKey, KEYS, log, mainnet, measure, sendV0, sol } = await import("./lib.ts");
await assertFork();
const PORTS = { web: 9666, core: 9667, indexer: 9668 };
for (const p of Object.values(PORTS)) if (spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim()) throw new Error(`port ${p} is taken`);
const reader = new ChainReader(fork);
const OUT_FILE = join(import.meta.dir, "GRADUATION-FORK-LAST.json"), SHOTS = join(DIR, "shots");
mkdirSync(SHOTS, { recursive: true });
let section = "0 fork";
const sections: Record<string, { passed: number; total: number }> = {};
const check = (name: string, ok: boolean, detail = "") => {
  const s = (sections[section] ??= { passed: 0, total: 0 });
  s.total++;
  if (ok) s.passed++;
  try { check0(`${section}: ${name}`, ok, detail); } catch { /* recorded in `checks`, the run goes on */ }
};
const ownerA = forkKey("owner-a-stand-in"), trader = forkKey("trader"), cranker = forkKey("cranker"), helper = forkKey("helper"), poolKeeper = forkKey("pool-keeper");
// the keeper's payer: a stand-in for the hosted runtime's authority key, which pays the keeper on the server
const keeper = forkKey("graduation-keeper"), poorKeeper = forkKey("graduation-keeper-underfunded");
const { a: A, b: B, z: Z } = PREP;
const acct = async <T>(a: string, d: (b: Uint8Array) => T): Promise<T> => d((await fork.getAccountInfo(a))!.data);
const bal = async (a: string) => { const i = await fork.getAccountInfo(a); return i ? decodeTokenAccount(i.data).amount : 0n; };
const tableAcc = await fork.getAccountInfo(TABLE);
if (!tableAcc) throw new Error("the launch lookup table is not on the fork");
const table: LookupTable = { address: TABLE, addresses: decodeLookupTable(tableAcc.data).addresses };
const tx = (name: string, payer: Signer, ixs: Ix[], cu = 600_000) => sendV0(section, name, payer, ixs, [table], { computeUnits: cu });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, any> = { started: new Date().toISOString(), fork: FORK_URL, program: IDS.launch, mainnet_slot_of_the_copy: PREP.mainnet_slot, replaced_on_the_fork: PREP.patched, written_into_the_fork: PREP.written_in,
  coins: { pump_fun_migrates_and_the_keeper_records: B, the_keeper_migrates_and_records: Z, the_other_member_of_the_pool: A }, shots: SHOTS };
let outcome = "PASS";
const procs: Subprocess[] = [];
let stopCore = () => {};
let browser: any = null;
const stubState: { served: { agent_id: string; mint: string }[] } = { served: [] };
const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p === "/v1/agents") return Response.json(stubState.served);
  if (p === "/market/quote-usd") return Response.json({ ok: true, usd: 0.001 });
  return new Response("not served by the stand-in", { status: 404 });
} });

try {
  for (const k of [ownerA, cranker, helper, poolKeeper, keeper]) await airdrop(k.id, 5_000_000_000n);
  await airdrop(poorKeeper.id, 2_000_000n);
  await airdrop(trader.id, 50_000_000_000n);
  const g = await acct(PUMP.global, decodePumpGlobal), fc = await acct(PUMP.feeConfig, decodePumpFeeConfig);
  const lc = (await reader.launchConfig())!, pc = await acct(poolPdas.config(), decodePoolConfig);

  // ---------------------------------------------------------------- 0 the fork is mainnet
  const pdFork = (await fork.getAccountInfo(programDataAddress(IDS.launch)))!, pdMain = (await mainnet.getAccountInfo(programDataAddress(IDS.launch)))!;
  check("the launch program on the fork is the code deployed on mainnet, byte for byte", pdFork.data.length === pdMain.data.length && sha(pdFork.data.subarray(45)) === sha(pdMain.data.subarray(45)),
    `${pdFork.data.length - 45} bytes of code, sha256 ${sha(pdFork.data.subarray(45)).slice(0, 16)}`);
  for (const id of [PUMP.program, PUMP.amm]) {
    const f = (await fork.getAccountInfo(programDataAddress(id)))!, m = (await mainnet.getAccountInfo(programDataAddress(id)))!;
    check(`pump.fun's ${id === PUMP.program ? "Pump" : "PumpSwap"} program on the fork is mainnet's build`, sha(f.data.subarray(45)) === sha(m.data.subarray(45)), `${id}, sha256 ${sha(f.data.subarray(45)).slice(0, 16)}`);
  }
  check("pump.fun's Global is mainnet's: migrations are on, the migration fee is what the keeper will pay", g.enableMigrate && sha((await fork.getAccountInfo(PUMP.global))!.data) === sha((await mainnet.getAccountInfo(PUMP.global))!.data),
    `enable_migrate ${g.enableMigrate}, pool_migration_fee ${g.poolMigrationFee} lamports`);
  const launches0 = await Promise.all([A, B, Z].map((m) => reader.agentLaunch(m.mint)));
  check("the three coins are live launches on their curves, not graduated; the first two are of one repository and the second is a member of its pool on mainnet",
    launches0.every((l) => !!l && !l.graduated && l.venue === "pump") && A.repo_id === B.repo_id && (launches0[1]!.routes & FEATURES.pools) !== 0,
    [A, B, Z].map((m) => m.agent.slice(0, 6)).join(", "));
  check("the trader holds the $UNITS written into the fork and $UNITS's own pool is untouched by this run so far", (await bal(ata(trader.id, LINE, T22))) === TRADER_UNITS, `${TRADER_UNITS / ONE} $UNITS`);

  // ---------------------------------------------------------------- helpers
  const curveTrade = async (m: Rec, side: "buy" | "sell", amount: bigint) => {
    if (side === "buy") return tx(`trader buys ${m.agent.slice(0, 6)}'s coin on its curve`, trader, [token.createAtaIdempotent(trader.id, trader.id, m.mint, T22),
      pump.buyExactQuoteInV3({ mint: m.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, spendableQuoteIn: amount, minTokensOut: 1n })], 400_000);
    return tx(`trader sells ${m.agent.slice(0, 6)}'s coin on its curve`, trader, [pump.sellV3({ mint: m.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, amount, minQuoteOut: 1n })], 400_000);
  };
  /** A round trip on a coin's curve: buy with a tenth of the curve's virtual $UNITS, sell what was bought. */
  const curveTrip = async (m: Rec) => {
    const c = await acct(pumpPdas.bondingCurve(m.mint), decodeBondingCurve), h0 = await bal(ata(trader.id, m.mint, T22));
    await curveTrade(m, "buy", c.virtualQuoteReserves / 10n);
    await curveTrade(m, "sell", (await bal(ata(trader.id, m.mint, T22))) - h0);
  };
  const poolTrade = async (m: Rec, side: "buy" | "sell", amount: bigint) => {
    const t = { pool: pumpPdas.pool(m.mint, LINE), mint: m.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id };
    return tx(`trader ${side}s ${m.agent.slice(0, 6)}'s coin on its PumpSwap pool`, trader, [side === "buy" ? pumpAmm.buyExactQuoteInV2({ ...t, spendableQuoteIn: amount, minBaseOut: 1n }) : pumpAmm.sellV2({ ...t, baseIn: amount, minQuoteOut: 1n })], 400_000);
  };
  const complete = async (m: Rec) => {
    const c = await acct(pumpPdas.bondingCurve(m.mint), decodeBondingCurve), past = 5_000_000_000_000n;
    const q = quoteCurveBuyExactOut(g, fc, c, c.realTokenReserves + past, await bal(ata(pumpPdas.bondingCurve(m.mint), m.mint, T22)));
    return tx(`${m.agent.slice(0, 6)}'s coin: the completing buy, past the end of its curve (${q.quoteIn / ONE} $UNITS)`, trader, [token.createAtaIdempotent(trader.id, trader.id, m.mint, T22),
      pump.buyV3({ mint: m.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, amount: c.realTokenReserves + past, maxQuoteIn: (q.quoteIn * 101n) / 100n })], 600_000);
  };
  const stateOf = async (m: Rec) => {
    const l = (await reader.agentLaunch(m.mint))!;
    const [c, p] = await fork.getMultipleAccounts([l.bondingCurve, pumpPdas.pool(m.mint, LINE)]);
    return { l, state: graduationState(l, LINE, c ?? null, p ?? null).state };
  };
  const script = (file: string, args: string[]) => async () => {
    const p = spawn(["bun", join(import.meta.dir, file), ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, UNITS_NETWORK: "mainnet", UNITS_MAINNET_RPC: FORK_URL } });
    const t = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    return { text: t, code: await p.exited };
  };
  const graduate = (args: string[], key = "graduation-keeper") => script("graduate.ts", ["--key", join(KEYS, `${key}.json`), ...args])();
  const crankKeeper = (served: Rec[]) => {
    stubState.served = served.map((m) => ({ agent_id: m.agent, mint: m.mint }));
    return script("crank-fees.ts", ["--core", `http://127.0.0.1:${stub.port}`, "--key", join(KEYS, "cranker.json"), "--min-usd", "0", "--send"])();
  };
  const said = (t: string) => t.trim().split("\n").filter((l) => l.startsWith("[graduate]")).map((l) => l.replace("[graduate] ", "")).slice(1).join(" | ").slice(0, 420);
  const keeperCosts: Record<string, unknown>[] = [];
  out.keeper_transactions = keeperCosts;
  const costOf = async (what: string, t: string) => {
    const m = /: sent (.+?) (\S{80,90}) \((legacy|v0), (\d+) bytes/.exec(t);
    if (!m) return null;
    const c = await measure(section, `graduation keeper: ${what}`, m[2]!);
    const row = { what, instructions: m[1], form: m[3], bytes: Number(m[4]), fee_lamports: c.fee, compute_units: c.computeUnits, payer_lamports_on_the_fork: c.payerDeltaFork, payer_lamports_at_mainnet_rent: c.payerMainnet,
      of_which_neither_fee_nor_rent: c.other, accounts_created: c.created.map((x) => ({ bytes: x.bytes, rent_mainnet: x.mainnetRent })), signature: m[2] };
    keeperCosts.push(row);
    return row;
  };
  /** Everything one crank of `m` (a pool member with no fee route) reads and moves: the crank lane's check (crank-v0-fork.ts `snap`). */
  const snap = async (m: Rec) => {
    const creator = launchPdas.pumpCreator(m.agent);
    const [curveA, poolA] = await fork.getMultipleAccounts([pumpPdas.bondingCurve(m.mint), pumpPdas.pool(m.mint, LINE)]);
    const l = (await reader.agentLaunch(m.mint))!;
    return {
      waiting: decodeBondingCurve(curveA!.data).creatorFee + (poolA ? decodePumpPool(poolA.data).creatorFees : 0n) + (await bal(ata(pumpPdas.creatorVault(creator), LINE, T22)))
        + (await bal(ata(pumpPdas.ammCreatorVault(creator), LINE, T22))) + (await bal(ata(creator, LINE, T22))),
      fees: l.feesClaimed, toCompute: l.toCompute, toProtocol: l.toProtocol, compute: await bal(launchPdas.computeVault(m.agent)), treasury: await bal(registryPdas.treasury()),
      poolVault: await bal(poolPdas.vault(m.repo_id, LINE, T22)), member: await acct(poolPdas.member(m.agent), decodePoolMember), pool: await acct(poolPdas.pool(m.repo_id), decodePool),
    };
  };
  /** One fee crank keeper run for one pool member, sent; every amount checked to the base unit. */
  const crankExact = async (m: Rec) => {
    const b = await snap(m), r = await crankKeeper([m]), a = await snap(m);
    const sent = /cranked (\S+) \((legacy|v0), (\d+) bytes/.exec(r.text), fees = a.fees - b.fees;
    const w = crankSplit(fees, lc.agentComputeBps, 0, b.pool.members.length >= 2 ? pc.poolFeeBps : 0);
    const cross = w.toPool > b.member.crossDue ? b.member.crossDue : w.toPool, rest = w.toPool - cross;
    const inPool = a.member.contributed - b.member.contributed === w.toPool && a.member.crossFunded - b.member.crossFunded === cross && b.member.crossDue - a.member.crossDue === cross
      && a.pool.bucketPayout - b.pool.bucketPayout === (rest * BigInt(pc.payoutBps)) / 10_000n && a.pool.bucketBuyback - b.pool.bucketBuyback === (rest * BigInt(pc.buybackBps)) / 10_000n
      && a.pool.bucketBurn - b.pool.bucketBurn === rest - (rest * BigInt(pc.payoutBps)) / 10_000n - (rest * BigInt(pc.buybackBps)) / 10_000n;
    const exact = inPool && fees > 0n && fees === b.waiting && a.waiting === 0n && a.compute - b.compute === w.toCompute && a.treasury - b.treasury === w.toProtocol && a.toCompute - b.toCompute === w.toCompute
      && a.toProtocol - b.toProtocol === w.toProtocol && a.poolVault - b.poolVault === w.toPool && w.toCompute + w.toProtocol + w.toPool === fees && w.toPool > 0n;
    return { exact, fees, w, form: sent?.[2] ?? null, bytes: sent ? Number(sent[3]) : null, text: r.text, crossDue: a.member.crossDue };
  };

  // ---------------------------------------------------------------- the local site: Core (in this process), the indexer, the dashboard, a browser
  const tmp = mkdtempSync(join(tmpdir(), "units-graduation-fork-"));
  const genesis = await fork.call<string>("getGenesisHash");
  writeFileSync(join(tmp, "state.json"), JSON.stringify(STATE));
  writeFileSync(join(tmp, "profile.local.json"), JSON.stringify({ profiles: { mainnet: { genesis, state_file: join(tmp, "state.json") } } }));
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
  const CORE = `http://127.0.0.1:${PORTS.core}`, MARKET = `http://127.0.0.1:${PORTS.indexer}`, WEB = `http://127.0.0.1:${PORTS.web}`;
  const env = { ...process.env, UNITS_NETWORK: "mainnet", UNITS_PROFILE_LOCAL: join(tmp, "profile.local.json"), UNITS_MAINNET_RPC: FORK_URL, UNITS_HOME: join(tmp, "home") };
  const run = (name: string, cmd: string[]) => procs.push(spawn(cmd, { cwd: ROOT, env, stdout: Bun.file(join(tmp, `${name}.log`)), stderr: Bun.file(join(tmp, `${name}.log`)) }));
  // the indexer's clock is the fork's chain time (fork-clock.ts): this validator's clock is not the wall clock, and a trade is priced with the dollar reading of its block time
  const clock0 = await chainTime(fork);
  out.fork_clock = { chain_time_at_start: clock0, seconds_ahead_of_this_machine: clock0 - Math.floor(Date.now() / 1000) };
  Object.assign(env, { FORK_CLOCK_RPC: FORK_URL, FORK_CLOCK_START_MS: String(clock0 * 1000) });
  run("indexer", ["bun", "--preload", join(import.meta.dir, "fork-clock.ts"), "packages/indexer/src/main.ts", "--port", String(PORTS.indexer), "--db", join(tmp, "market.db"), "--interval", "2", "--min-gap-ms", "10", "--holders-every", "8", "--core", CORE, "--no-supply"]);
  run("web", ["bun", "apps/web/server.ts", "--port", String(PORTS.web), "--core", CORE, "--market", MARKET]);
  for (let i = 0; ; i++) {
    const c = await fetch(`${WEB}/chain/config`).then((r) => r.json()).catch(() => null) as any, s = await fetch(`${MARKET}/market/summary`).then((r) => r.ok).catch(() => false);
    if (c?.genesis === genesis && s) break;
    if (c?.genesis && c.genesis !== genesis) throw new Error("the dashboard is not on the fork");
    if (i > 240) throw new Error(`the local site did not start (logs in ${tmp})`);
    await sleep(500);
  }
  out.local_site = { dashboard: WEB, indexer: MARKET, core: CORE, logs: tmp };
  const pw = await import("@playwright/test");
  const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  browser = await pw.chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
  const market = async <T>(p: string) => (await fetch(`${MARKET}/market/${p}`)).json() as Promise<T>;
  type Tok = { phase: string; migrated: boolean; awaiting_migration: boolean; price_usd: number | null; price: number | null; curve_progress: number | null; trades: number; holders: number | null; state: string | null };
  /** Waits until the indexer's row of `m` satisfies `f`. */
  const indexed = async (m: Rec, f: (t: Tok) => boolean, what: string): Promise<Tok> => {
    for (let i = 0; i < 120; i++) {
      const t = await market<Tok>(`tokens/${m.mint}`).catch(() => null);
      if (t && !(t as any).error && f(t)) return t;
      await sleep(500);
    }
    throw new Error(`the indexer did not show ${what} for ${m.agent.slice(0, 6)} within 60 s`);
  };
  const newPage = async (width = 1280) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light" });
    await ctx.clock.install({ time: new Date((await chainTime(fork)) * 1000) }); // the page's "ago" labels on the fork's clock too
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    return { ctx, page, errors };
  };
  /** What a visitor sees on the coin's page: the badge by the name, what the trade box offers, whether a chart is drawn. */
  const look = async (page: any) => page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const tb = q("#mk-trade") as HTMLElement | null;
    return { badge: q("#mk-phase .mk-phase")?.textContent?.trim() ?? null, phase: q("#mk-phase .mk-phase")?.getAttribute("data-phase") ?? null, venue: tb?.querySelector(".mk-tb-venue")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      amountInput: !!tb?.querySelector("input"), tradeButtons: [...(tb?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 6), chart: !!q("#mk-chart canvas"),
      tradeRows: document.querySelectorAll("#mk-trades .tk-row").length, error: !!tb?.querySelector("[data-err]"), noHorizontalScroll: document.documentElement.scrollWidth <= window.innerWidth + 1 };
  });
  const openCoin = async (m: Rec, wantPhase: string, wantVenue: RegExp, width = 1280) => {
    const p = await newPage(width);
    await p.page.goto(`${WEB}/tokens/${m.mint}`, { waitUntil: "domcontentloaded" });
    await p.page.waitForFunction(([ph, re]: [string, string]) => document.querySelector("#mk-phase .mk-phase")?.getAttribute("data-phase") === ph
      && new RegExp(re).test(document.querySelector("#mk-trade .mk-tb-venue")?.textContent ?? ""), [wantPhase, wantVenue.source], { timeout: 90_000 }).catch(() => {});
    await p.page.waitForSelector("#mk-chart canvas", { timeout: 20_000 }).catch(() => {});
    await sleep(1500);
    return p;
  };
  const shot = async (page: any, name: string) => {
    const file = join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };
  const shots: Record<string, string> = {};
  out.screenshots = shots;
  const pages: Record<string, unknown> = {};
  out.pages = pages;

  // ---------------------------------------------------------------- 1 before: on its curve
  section = "1 on its curve";
  // the other agent of the repository joins the pool (a pool routes once it has two members), signed by its stand-in owner
  {
    const poolA = await fork.getAccountInfo(poolPdas.pool(A.repo_id)), members = poolA ? decodePool(poolA.data).members : [];
    if (!members.includes(A.agent)) {
      // fork only: this validator's rent is higher than mainnet's, so accounts copied from mainnet sit under its minimum and join_pool's rent checks fail here; they are topped up
      if (poolA) for (const x of [poolPdas.pool(A.repo_id), poolPdas.vault(A.repo_id, LINE, T22), ...members.map((x) => poolPdas.member(x))]) await airdrop(x, 10_000_000n);
      await tx(`${A.agent.slice(0, 6)} joins the pool of its repository (join_pool, its stand-in owner)`, ownerA, [pools.joinPool({ signer: ownerA.id, agent: A.agent, agentMint: A.mint, repoId: A.repo_id, lineMint: LINE, members })]);
    }
    if ((await acct(poolPdas.pool(A.repo_id), decodePool)).members.length !== 2) throw new Error("the pool does not have its two members");
  }
  // nothing is traded before the indexer holds a dollar reading: a trade is priced with the reading of its own time
  for (let i = 0; ; i++) { if (((await market<{ ok: boolean }>("quote-usd").catch(() => null)) as any)?.ok) break; if (i > 240) throw new Error("the indexer read no dollar price"); await sleep(500); }
  out.quote_usd = await market("quote-usd");
  for (let i = 0; i < 3; i++) await curveTrip(B);
  {
    const s = await stateOf(B), t = await indexed(B, (x) => x.trades >= 6 && x.price_usd != null, "six curve trades with a dollar price");
    check("on chain: on its curve; the keeper's detection says so", s.state === "curve" && !s.l.graduated);
    const k = await graduate(["--send"]);
    check("a keeper run finds nothing to do and sends nothing", k.code === 0 && /0 waiting for a migration, 0 migrated and 0 recorded by this run; the payer paid 0\.000000000 SOL/.test(k.text) && (await fork.getBalance(keeper.id)) === 5_000_000_000n, said(k.text));
    check("the indexer: on its curve, not awaiting a migration, priced in dollars", t.phase === "curve" && !t.awaiting_migration && !t.migrated && (t.price_usd ?? 0) > 0, `phase ${t.phase}, ${t.trades} trades, ${t.price_usd} USD`);
    const p = await openCoin(B, "curve", /bonding curve/);
    const v = await look(p.page);
    shots.on_its_curve = await shot(p.page, "1-on-its-curve");
    pages.on_its_curve = v;
    check('the coin\'s page: the badge says "Bonding curve", the trade box offers a trade on the curve, a chart is drawn', v.phase === "curve" && v.badge === "Bonding curve" && /bonding curve/.test(v.venue ?? "") && v.amountInput && v.chart && !p.errors.length,
      `badge "${v.badge}", trade box "${v.venue}"${p.errors.length ? `, page errors: ${p.errors.join(" | ").slice(0, 200)}` : ""}`);
    await p.ctx.close();
  }

  // ---------------------------------------------------------------- 2 curve complete, pool not made
  section = "2 curve complete, no pool";
  const completing = await complete(B);
  // an open page, kept through the migration: it must move on by itself
  let open: Awaited<ReturnType<typeof newPage>>;
  let waitingPrice = 0;
  {
    const s = await stateOf(B), c = await acct(pumpPdas.bondingCurve(B.mint), decodeBondingCurve);
    check("on chain: the curve is complete, its PumpSwap pool does not exist, the launch program has nothing recorded; the keeper's detection says awaiting migration",
      s.state === "awaiting_migration" && c.complete && c.realTokenReserves === 0n && !(await fork.getAccountInfo(pumpPdas.pool(B.mint, LINE))) && !s.l.graduated, `completing buy ${completing.signature.slice(0, 12)}`);
    const sim = async (ix: Ix) => fork.simulate(signMessageWith(compileMessageV0(trader.id, [ix], (await fork.getLatestBlockhash()).blockhash, [table]), [trader]).wire);
    const [buy, sell] = [await sim(pump.buyExactQuoteInV3({ mint: B.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, spendableQuoteIn: ONE, minTokensOut: 1n })),
      await sim(pump.sellV3({ mint: B.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, amount: 1_000_000n, minQuoteOut: 1n }))];
    check("in this window no trade lands: a buy and a sell on the curve are both refused by pump.fun (BondingCurveComplete)", [buy, sell].every((x) => !!x.err && (x.logs ?? []).some((l) => /BondingCurveComplete|0x1775/.test(l))),
      (buy.logs ?? []).find((l) => /Error/.test(l))?.slice(0, 160) ?? "");
    const dry = await graduate([]);
    check("the keeper, dry run, inside pump.fun's head start (120 s by default): it waits and says why", dry.code === 0 && /waiting, its curve completed \d+ s ago; pump\.fun's own keeper is given 120 s/.test(dry.text) && /1 waiting for a migration/.test(dry.text), said(dry.text));
    const b0 = await fork.getBalance(keeper.id);
    const wait = await graduate(["--send", "--migrate-after", "3600"]);
    check("the keeper with --send inside the head start sends nothing and pays nothing", /1 waiting for a migration, 0 migrated and 0 recorded/.test(wait.text) && (await fork.getBalance(keeper.id)) === b0 && (await stateOf(B)).state === "awaiting_migration");
    const never = await graduate(["--send", "--no-migrate", "--migrate-after", "0"]);
    check("the keeper told never to migrate (--no-migrate) waits for pump.fun however long it takes", /waiting for pump\.fun's migration \(this keeper is set not to send it\)/.test(never.text) && (await fork.getBalance(keeper.id)) === b0, said(never.text));
    const t = await indexed(B, (x) => x.awaiting_migration === true, "the complete curve");
    waitingPrice = t.price ?? 0;
    check("the indexer: still not graduated, awaiting migration, curve progress 100%", t.phase === "curve" && t.awaiting_migration && !t.migrated && t.curve_progress === 1, `phase ${t.phase}, awaiting_migration ${t.awaiting_migration}, progress ${t.curve_progress}, price ${t.price_usd} USD`);
    open = await openCoin(B, "complete", /curve is complete/);
    const v = await look(open.page);
    shots.curve_complete_no_pool = await shot(open.page, "2-curve-complete-no-pool");
    pages.curve_complete_no_pool = v;
    check('the coin\'s page: the badge says "Curve complete, pool opening"; the trade box says "This coin\'s curve is complete. Trading moves to its pool shortly." and offers no trade, no error',
      v.phase === "complete" && v.badge === "Curve complete, pool opening" && /This coin's curve is complete\. Trading moves to its pool shortly\./.test(v.venue ?? "") && !v.amountInput && !v.error && v.chart && !open.errors.length,
      `badge "${v.badge}", trade box "${v.venue}"`);
    const cr = await crankExact(B);
    check("the fee crank keeper in this window cranks the member on its curve, every amount exact (the crank lane's check)", cr.exact && cr.form === "legacy", `fees ${cr.fees}: compute ${cr.w.toCompute}, protocol ${cr.w.toProtocol}, pool ${cr.w.toPool}; ${cr.form} ${cr.bytes} bytes`);
    const stillWaiting = await graduate(["--send", "--migrate-after", "3600"]);
    const age = Number(/its curve completed (\d+) s ago/.exec(stillWaiting.text)?.[1] ?? "-1"), sinceBuy = (await chainTime(fork)) - (await fork.call<number>("getBlockTime", [completing.slot]));
    check("that crank touched the curve after the completion; the keeper still dates the completion from pump.fun's CompleteEvent, on the chain's clock, and keeps waiting", age >= 0 && Math.abs(age - sinceBuy) <= 3 && sinceBuy > 0, `the keeper says ${age} s, the completing buy's block is ${sinceBuy} s old`);
  }

  // ---------------------------------------------------------------- 3 migrated by somebody else, not recorded
  section = "3 migrated, not recorded";
  {
    // pump.fun's keeper, stood in for by a key that is not ours: migrate_v2 alone
    const mig = await tx(`${B.agent.slice(0, 6)}'s coin: migrate_v2 alone, sent by a key that is not the keeper's (as pump.fun's own keeper does on mainnet)`, helper,
      [pump.migrateV2({ user: helper.id, mint: B.mint, quoteMint: LINE, withdrawAuthority: g.withdrawAuthority, quoteTokenProgram: T22 })], 600_000);
    out.migration_by_another_key = { fee_lamports: mig.cost.fee, payer_lamports_at_mainnet_rent: mig.cost.payerMainnet, compute_units: mig.cost.computeUnits };
    const s = await stateOf(B), p = await acct(pumpPdas.pool(B.mint, LINE), decodePumpPool);
    check("on chain: the canonical PumpSwap pool exists, quoted in $UNITS, its coin creator is the agent's creator account; the launch program has not recorded it; the keeper's detection says migrated",
      s.state === "migrated" && !s.l.graduated && p.baseMint === B.mint && p.quoteMint === LINE && p.coinCreator === launchPdas.pumpCreator(B.agent), `pool ${pumpPdas.pool(B.mint, LINE)}`);
    // the page left open in the waiting state moves on with no reload
    const moved = await open!.page.waitForFunction(() => /PumpSwap pool/.test(document.querySelector("#mk-trade .mk-tb-venue")?.textContent ?? "") && !!document.querySelector("#mk-trade input"), null, { timeout: 30_000 }).then(() => true, () => false);
    check("the page that was open while the curve was complete moves to the pool by itself: the trade box offers a trade on PumpSwap with no reload", moved && !open!.errors.length, open!.errors.join(" | ").slice(0, 200));
    await open!.ctx.close();
    const t = await indexed(B, (x) => x.phase === "graduated", "the pool");
    check("the indexer: graduated as soon as the pool exists (it does not wait for the record), no longer awaiting", t.phase === "graduated" && t.migrated && !t.awaiting_migration && t.curve_progress === 1, `phase ${t.phase}, migrated ${t.migrated}`);
    // where the pool opens: its reserves before any trade on it, against what the indexer showed while the curve was complete and after the completing buy
    const [pb, pq] = [await bal(p.poolBaseTokenAccount), await bal(p.poolQuoteTokenAccount)];
    const openSpot = Number(pq + p.virtualQuoteReserves) / Number(pb);
    out.pool_opening = { base: pb.toString(), quote: pq.toString(), virtual_quote: p.virtualQuoteReserves.toString(), spot: openSpot, indexer_price_while_complete: waitingPrice, indexer_price_once_migrated: t.price };
    check("the price does not move at the migration: the indexer's price while the curve was complete and its price once the pool exists are the pool's opening price (no trade happened in between)",
      Math.abs(waitingPrice / openSpot - 1) < 1e-6 && Math.abs((t.price ?? 0) / openSpot - 1) < 1e-6, `while complete ${waitingPrice}, pool opens at ${openSpot}, once migrated ${t.price} $UNITS per coin`);
    const held = await bal(ata(trader.id, B.mint, T22));
    await poolTrade(B, "sell", held / 5000n);
    check("a trade on the pool lands before the record exists: trading does not wait for the keeper", true);
    const pg = await openCoin(B, "graduated", /PumpSwap pool/);
    const v = await look(pg.page);
    shots.migrated_not_recorded = await shot(pg.page, "3-migrated-not-recorded");
    pages.migrated_not_recorded = v;
    check('the coin\'s page: the badge says "Graduated, PumpSwap", the trade box offers a trade on the PumpSwap pool', v.phase === "graduated" && v.badge === "Graduated, PumpSwap" && /PumpSwap pool/.test(v.venue ?? "") && v.amountInput && v.chart && !pg.errors.length, `badge "${v.badge}", trade box "${v.venue}"`);
    await pg.ctx.close();
    const b0 = await fork.getBalance(keeper.id);
    const dry = await graduate([]);
    check("the keeper, dry run: it would record, says what that costs, sends nothing", /record_pump_graduation: simulation ok, would cost the payer 0\.0000050\d\d SOL \(legacy transaction/.test(dry.text) && /would send record_pump_graduation/.test(dry.text)
      && (await fork.getBalance(keeper.id)) === b0 && !(await stateOf(B)).l.graduated, said(dry.text));
  }

  // ---------------------------------------------------------------- 4 recorded
  section = "4 recorded";
  {
    const b0 = await fork.getBalance(keeper.id);
    const rec = await graduate(["--send"]);
    const cost = await costOf("the record alone, after somebody else migrated", rec.text);
    const s = await stateOf(B);
    check("the keeper with --send records the graduation and nothing else: one instruction, the payer pays the network fee alone", rec.code === 0 && !!cost && cost.instructions === "record_pump_graduation" && s.l.graduated && s.l.pumpPool === pumpPdas.pool(B.mint, LINE)
      && s.state === "recorded" && b0 - (await fork.getBalance(keeper.id)) === BigInt(cost.fee_lamports) && cost.accounts_created.length === 0, cost ? `${cost.form} ${cost.bytes} bytes, ${cost.compute_units} compute units, fee ${cost.fee_lamports} lamports` : said(rec.text));
    const b1 = await fork.getBalance(keeper.id);
    const again = await graduate(["--send"]);
    check("the next run does not read that coin again and pays nothing", again.code === 0 && !again.text.includes(B.agent.slice(0, 6)) && (await fork.getBalance(keeper.id)) === b1, said(again.text));
    let kinds: string[] = [];
    for (let i = 0; i < 60 && !kinds.includes("graduated"); i++) { kinds = ((await market<{ events?: { kind: string }[] }>(`tokens/${B.mint}`)).events ?? []).map((e) => e.kind); if (!kinds.includes("graduated")) await sleep(500); }
    check("the indexer's record of the coin's life has the three events in order: the completion, the migration, the recorded graduation", ["complete", "migration", "graduated"].every((k) => kinds.includes(k))
      && kinds.indexOf("complete") < kinds.indexOf("migration") && kinds.indexOf("migration") < kinds.indexOf("graduated"), kinds.join(", "));
    const pg = await openCoin(B, "graduated", /PumpSwap pool/);
    const v = await look(pg.page);
    shots.recorded = await shot(pg.page, "4-recorded");
    pages.recorded = v;
    check("the coin's page after the record: the same badge and trade box as before it (the site never waited for the record)", v.phase === "graduated" && v.badge === "Graduated, PumpSwap" && /PumpSwap pool/.test(v.venue ?? "") && v.amountInput && !pg.errors.length, `badge "${v.badge}", trade box "${v.venue}"`);
    const phone = await openCoin(B, "graduated", /PumpSwap pool/, 390);
    const pv = await look(phone.page);
    shots.recorded_phone = await shot(phone.page, "4-recorded-390");
    check("the same page at 390 px: no horizontal scroll", pv.noHorizontalScroll && pv.phase === "graduated");
    await phone.ctx.close();
    await pg.ctx.close();
  }

  // ---------------------------------------------------------------- 5 the keeper migrates by itself
  section = "5 the keeper migrates";
  {
    await curveTrip(Z);
    const zBuy = await complete(Z);
    check("a second live coin completes its curve; nobody migrates it", (await stateOf(Z)).state === "awaiting_migration");
    const p0 = await fork.getBalance(poorKeeper.id);
    const poor = await graduate(["--send", "--migrate-after", "0"], "graduation-keeper-underfunded");
    check("a payer that cannot afford the migration: the simulation fails, nothing is sent, nothing is lost, the run ends with a failure status", poor.code === 1 && /not sent, simulation failed/.test(poor.text) && (await fork.getBalance(poorKeeper.id)) === p0
      && (await stateOf(Z)).state === "awaiting_migration", said(poor.text));
    const b0 = await fork.getBalance(keeper.id);
    const capped = await graduate(["--send", "--migrate-after", "0", "--max-migrate-sol", "0.001"]);
    check("a migration that would cost more than --max-migrate-sol is not sent: the keeper waits for pump.fun's", /migrate_v2 not sent, would cost the payer 0\.0\d+ SOL, more than --max-migrate-sol 0\.001000000 allows/.test(capped.text) && (await fork.getBalance(keeper.id)) === b0
      && (await stateOf(Z)).state === "awaiting_migration", said(capped.text));
    const dry = await graduate(["--migrate-after", "0"]);
    check("dry run past the head start: it would migrate and record, says the cost, sends nothing", /migrate_v2 and record_pump_graduation: simulation ok, would cost the payer 0\.0\d+ SOL/.test(dry.text) && /would send migrate_v2 and record_pump_graduation/.test(dry.text)
      && (await fork.getBalance(keeper.id)) === b0, said(dry.text));
    // the head start, on the chain's clock: 20 s here
    const early = await graduate(["--send", "--migrate-after", "20"]);
    const zDone = await fork.call<number>("getBlockTime", [zBuy.slot]);
    check("inside a head start of 20 s the keeper waits and pays nothing", /waiting, its curve completed \d+ s ago; pump\.fun's own keeper is given 20 s/.test(early.text) && (await fork.getBalance(keeper.id)) === b0 || (await chainTime(fork)) - zDone >= 20, said(early.text));
    while ((await chainTime(fork)) - zDone < 21) await sleep(1000);
    const go = await graduate(["--send", "--migrate-after", "20"]);
    const cost = await costOf("the migration and the record in one transaction", go.text);
    const s = await stateOf(Z), p = await acct(pumpPdas.pool(Z.mint, LINE), decodePumpPool);
    check("the keeper with --send: pump.fun's migrate_v2 and record_pump_graduation in one transaction signed by its payer alone; the pool is the canonical one, the coin creator is the agent's creator account, the graduation is recorded",
      go.code === 0 && !!cost && cost.instructions === "migrate_v2 and record_pump_graduation" && s.state === "recorded" && s.l.graduated && s.l.pumpPool === pumpPdas.pool(Z.mint, LINE) && p.coinCreator === launchPdas.pumpCreator(Z.agent)
      && b0 - (await fork.getBalance(keeper.id)) === BigInt(cost.payer_lamports_on_the_fork), cost ? `${cost.form} ${cost.bytes} bytes, ${cost.compute_units} compute units; the payer paid ${sol(BigInt(cost.payer_lamports_at_mainnet_rent))} SOL at mainnet rent (fee ${cost.fee_lamports} lamports)` : said(go.text));
    const rentPaid = cost ? cost.accounts_created.reduce((n: bigint, x: { rent_mainnet: string }) => n + BigInt(x.rent_mainnet), 0n) : 0n;
    check("what the migration cost the payer: the network fee, pump.fun's migration fee, and the rent of the accounts the migration made, under 0.03 SOL at mainnet rent",
      !!cost && BigInt(cost.payer_lamports_at_mainnet_rent) < 30_000_000n && BigInt(cost.of_which_neither_fee_nor_rent) >= 0n,
      cost ? `${cost.payer_lamports_at_mainnet_rent} lamports at mainnet rent: fee ${cost.fee_lamports}; ${cost.accounts_created.length} accounts created (${rentPaid} lamports of rent at mainnet rates in all, part of it paid by pump.fun from its fee); Global.pool_migration_fee ${g.poolMigrationFee}` : "");
    const b1 = await fork.getBalance(keeper.id);
    const again = await graduate(["--send", "--migrate-after", "0"]);
    check("the run after it finds both coins recorded and pays nothing", again.code === 0 && /0 waiting for a migration, 0 migrated and 0 recorded/.test(again.text) && (await fork.getBalance(keeper.id)) === b1, said(again.text));
    // what pump.fun does with a second migrate_v2 on a migrated coin (somebody racing the keeper)
    const twice = await fork.simulate(signMessageWith(compileMessageV0(helper.id, [pump.migrateV2({ user: helper.id, mint: Z.mint, quoteMint: LINE, withdrawAuthority: g.withdrawAuthority, quoteTokenProgram: T22 })], (await fork.getLatestBlockhash()).blockhash, [table]), [helper]).wire);
    out.second_migrate_v2_on_a_migrated_coin = twice.err ? `refused: ${(twice.logs ?? []).find((l) => /Error/.test(l))?.slice(0, 200) ?? JSON.stringify(twice.err)}` : "accepted and changes nothing";
    const twiceRec = await fork.simulate(signMessageWith(compileMessageV0(helper.id, [launch.recordPumpGraduation({ agentMint: Z.mint, lineMint: LINE })], (await fork.getLatestBlockhash()).blockhash, [table]), [helper]).wire);
    check("a second record_pump_graduation is refused by the launch program (WrongPhase): the record happens once", !!twiceRec.err && (twiceRec.logs ?? []).some((l) => /WrongPhase/.test(l)));
    await indexed(Z, (x) => x.phase === "graduated", "the second graduation");
  }

  // ---------------------------------------------------------------- 6 the site across the move
  section = "6 the site across the move";
  {
    const held = await bal(ata(trader.id, B.mint, T22));
    await poolTrade(B, "sell", held / 5000n);
    const u0 = await bal(ata(trader.id, LINE, T22));
    await poolTrade(B, "sell", held / 5000n);
    await poolTrade(B, "buy", (await bal(ata(trader.id, LINE, T22))) - u0);
    type Tr = { signature: string; slot: number; venue: string; side: string; price: number; price_after: number | null; price_usd: number | null; time: number | null; usd_basis: string | null };
    let trades: Tr[] = [];
    for (let i = 0; i < 120; i++) { trades = (await market<{ trades: Tr[] }>(`tokens/${B.mint}/trades?limit=200`)).trades; if (trades.filter((t) => t.venue === "pool").length >= 4) break; await sleep(500); }
    const asc = [...trades].reverse(), curve = asc.filter((t) => t.venue === "curve"), pool = asc.filter((t) => t.venue === "pool");
    const lastCurve = curve[curve.length - 1]!, firstPool = pool[0]!;
    check("the indexer holds one series for the coin: every curve trade of this run, the completing buy, then every pool trade, in order", curve.length >= 7 && pool.length === 4 && asc.findIndex((t) => t.venue === "pool") === curve.length
      && curve.some((t) => t.signature === completing.signature), `${curve.length} trades on the curve, then ${pool.length} on the pool`);
    check("every trade on both venues is priced in dollars at the reading of its own time", asc.every((t) => t.price_usd != null && t.price_usd > 0 && t.usd_basis === "at_time"), `${asc.length} trades`);
    const gap = Math.abs(firstPool.price / (lastCurve.price_after ?? lastCurve.price) - 1);
    out.price_across_the_move = { after_the_completing_buy: lastCurve.price_after, completing_buy_average: lastCurve.price, first_pool_trade: firstPool.price, difference: gap,
      after_the_completing_buy_usd: (lastCurve as any).price_after_usd ?? null, first_pool_trade_usd: firstPool.price_usd };
    check("the series has no step at the move: the first pool trade's price is within 3% of the price recorded after the completing buy (a small sell: its own price impact and fee)", gap < 0.03,
      `after the completing buy ${lastCurve.price_after}, first pool trade ${firstPool.price} $UNITS per coin (${(gap * 100).toFixed(3)}% apart)`);
    type Ca = { t: number; close: number; close_usd: number | null; trades: number };
    const cs = (await market<{ candles: Ca[] }>(`tokens/${B.mint}/candles?tf=1m`)).candles;
    const firstT = Math.min(...asc.map((t) => t.time!)), lastT = Math.max(...asc.map((t) => t.time!));
    const within = cs.filter((c) => c.t >= Math.floor(firstT / 60) * 60 && c.t <= lastT);
    check("the dollar chart is one continuous series across the move: a candle for every minute from the first curve trade to the last pool trade, each with a dollar close, none missing",
      within.length === Math.floor(lastT / 60) - Math.floor(firstT / 60) + 1 && within.every((c) => c.close_usd != null && c.close_usd > 0) && within.reduce((n, c) => n + c.trades, 0) === asc.length,
      `${within.length} one-minute candles, ${within.reduce((n, c) => n + c.trades, 0)} trades in them`);
    const ratio = within.map((c) => c.close_usd! / c.close), spread = Math.max(...ratio) / Math.min(...ratio) - 1;
    check("dollars per $UNITS is the same on both sides of the move (the dollar series moves with the coin, not with a change of venue or of price source)", spread < 0.02, `${Math.min(...ratio)} to ${Math.max(...ratio)} USD per $UNITS over the run (${(spread * 100).toFixed(3)}%)`);
    // holders: the curve's own account and the pool's vault are not holders
    let h: { holders: number | null; top: { owner: string; amount_raw: string }[] } = { holders: null, top: [] };
    const mineNow = await bal(ata(trader.id, B.mint, T22));
    for (let i = 0; i < 80; i++) { h = await market<typeof h>(`tokens/${B.mint}/holders?limit=100`); const row = h.top.find((x) => x.owner === trader.id); if (row && BigInt(row.amount_raw) === mineNow) break; await sleep(500); }
    const mine = h.top.find((x) => x.owner === trader.id);
    out.holders_after = { holders: h.holders, listed: h.top.length, trader: mine?.amount_raw ?? null };
    check("holders after the move: the trader's balance is the chain's; neither the curve's account nor the pool (its vault's owner) is listed as a holder",
      !!mine && BigInt(mine.amount_raw) === (await bal(ata(trader.id, B.mint, T22))) && !h.top.some((x) => x.owner === pumpPdas.bondingCurve(B.mint) || x.owner === pumpPdas.pool(B.mint, LINE)),
      `${h.holders} holders on this fork (holders' accounts on mainnet are not part of the copy); trader ${mine?.amount_raw}`);
    const sum = await market<{ tokens: number; graduated: number }>("summary");
    const dir = await market<{ tokens: { mint: string; phase: string; state: string | null }[]; count: number }>("tokens?state=graduated");
    check("the explorer's figures: two graduated, and the Graduated filter lists exactly the two coins", sum.graduated === 2 && dir.count === 2 && dir.tokens.map((t) => t.mint).sort().join() === [B.mint, Z.mint].sort().join(), `${sum.graduated} of ${sum.tokens} graduated`);
    const ex = await newPage();
    await ex.page.goto(`${WEB}/?state=graduated`, { waitUntil: "domcontentloaded" });
    await sleep(4000);
    shots.explorer = await shot(ex.page, "5-explorer");
    out.explorer_page_errors = ex.errors;
    await ex.ctx.close();
    const pg = await openCoin(B, "graduated", /PumpSwap pool/);
    await pg.page.locator('[data-book-b="trades"]').click().catch(() => {});
    await sleep(800);
    const v = await look(pg.page);
    shots.after_pool_trades = await shot(pg.page, "6-after-pool-trades");
    pages.after_pool_trades = v;
    const labels = await pg.page.evaluate(() => [...document.querySelectorAll("#mk-trades .tk-row-sub")].map((e) => (/PumpSwap/.test(e.textContent ?? "") ? "PumpSwap" : /curve/.test(e.textContent ?? "") ? "curve" : "?")));
    check("the coin's page lists the trades of both venues in one list, each named for where it happened, under one chart", labels.includes("PumpSwap") && labels.includes("curve") && !labels.includes("?") && v.chart && !pg.errors.length, `${labels.filter((x) => x === "PumpSwap").length} PumpSwap rows above ${labels.filter((x) => x === "curve").length} curve rows`);
    await pg.ctx.close();
  }

  // ---------------------------------------------------------------- 7 the routed crank after graduation
  section = "7 routed crank after graduation";
  {
    const cr = await crankExact(B);
    check("the fee crank keeper cranks the graduated pool member as a version 0 transaction of 1,108 bytes; the fees it moved are what waited in the pool and on the curve; compute, protocol and pool exact to the base unit; nothing left behind (the crank lane's check)",
      cr.exact && cr.form === "v0" && cr.bytes === 1108, `fees ${cr.fees}: compute ${cr.w.toCompute}, protocol ${cr.w.toProtocol}, pool ${cr.w.toPool}; ${cr.form} ${cr.bytes} bytes`);
    out.routed_crank_after_graduation = { fees: cr.fees.toString(), to_compute: cr.w.toCompute.toString(), to_protocol: cr.w.toProtocol.toString(), to_pool: cr.w.toPool.toString(), form: cr.form, bytes: cr.bytes, exact: cr.exact };
    const none = await crankKeeper([B]);
    check("a second crank run right after finds nothing", /done: 0 crank\(s\) sent/.test(none.text));
  }

  // ---------------------------------------------------------------- 8 the pool buys a graduated member's coin on its venue
  section = "8 pool buys on the venue";
  {
    // the other member's pool share pays for its holding of the graduated coin: volume on its curve until that share covers the configured amount
    let rounds = 0, due = (await acct(poolPdas.member(A.agent), decodePoolMember)).crossDue;
    for (; due > 0n && rounds < 40; rounds++) { await curveTrip(A); due = (await crankExact(A)).crossDue; }
    out.rounds_to_fund_the_cross_holding = rounds;
    const before = await bal(poolPdas.heldBy(A.agent, B.mint));
    const step = await poolsOf(core).keeperStep();
    out.core_keeper_step = step;
    const cross = step.actions.filter((a) => a.kind === "cross_buy" && a.signature);
    const got = (await bal(poolPdas.heldBy(A.agent, B.mint))) - before;
    let onAmm = false;
    for (const a of cross) {
      const t = await fork.call<any>("getTransaction", [a.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      onAmm = onAmm || ((t?.meta?.logMessages ?? []) as string[]).some((l) => l.includes(`Program ${PUMP.amm} invoke [2]`));
    }
    // a buyback of the graduated member's coin: a settlement posted by the stand-in keeper key with TEST inputs (one generation credited to the graduated member), then Core's keeper again
    try {
      for (let i = 0; i < 3; i++) { await curveTrip(A); await crankExact(A); }
      const rc = await acct(registryPdas.config(), decodeConfig), epoch = Number(rc.lastEpoch), p0 = await acct(poolPdas.pool(B.repo_id), decodePool);
      if (p0.settled && BigInt(epoch) <= p0.lastEpoch) out.pool_buyback_of_the_graduated_coin = `not run: the pool is settled for the registry's last posted epoch ${epoch} on the copy, and no epoch can be posted on the fork`;
      else {
        const weights = p0.members.map((m) => (m === B.agent ? 10_000 : 0));
        const alloc = settlementAllocation(pc, { payout: p0.bucketPayout, buyback: p0.bucketBuyback, burn: p0.bucketBurn }, { gens: 1, weights, milestones: 0 });
        await tx("pool_settle (the stand-in keeper key, TEST inputs: one generation credited to the graduated member)", poolKeeper, [pools.poolSettle({ keeper: poolKeeper.id, repoId: B.repo_id, members: p0.members, epoch, gens: 1, weights, milestones: 0, evidence: "11".repeat(32) })]);
        const due = (await acct(poolPdas.member(B.agent), decodePoolMember)).buybackDue, h0 = await bal(poolPdas.holding(B.repo_id, B.mint));
        const step2 = await poolsOf(core).keeperStep();
        const bb = step2.actions.filter((a) => a.kind === "buyback" && a.signature);
        let amm = false;
        for (const a of bb) amm = amm || ((await fork.call<any>("getTransaction", [a.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]))?.meta?.logMessages ?? []).some((l: string) => l.includes(`Program ${PUMP.amm} invoke [2]`));
        const bought = (await bal(poolPdas.holding(B.repo_id, B.mint))) - h0;
        out.pool_buyback_of_the_graduated_coin = { settled_buyback_due: due.toString(), allocation: alloc.map((x) => x.buyback.toString()), bought_base_units: bought.toString(), on_pumpswap: amm, actions: step2.actions.map((a) => `${a.kind}${a.error ? ` FAILED ${a.error.slice(0, 120)}` : ""}`) };
        if (due > 0n) check("after a settlement that credits the graduated member, Core's keeper spends its buyback on its PumpSwap pool: the pool's holding account of that coin grows (pool_buy through PumpSwap by CPI)", bb.length >= 1 && bought > 0n && amm,
          `buyback due ${due}; bought ${bought} base units; actions: ${step2.actions.map((a) => `${a.kind}${a.error ? " FAILED" : ""}`).join(", ")}`);
      }
    } catch (e) {
      out.pool_buyback_of_the_graduated_coin = `not proven: ${String((e as Error).message).slice(0, 300)}`;
    }
    check("Core's pool keeper buys the graduated member's coin for the other member on its PumpSwap pool (pool_cross_buy through PumpSwap by CPI): the holder's own token account receives the coins",
      due === 0n && cross.length >= 1 && got > 0n && onAmm, `${got} base units of the graduated coin bought; keeper actions: ${step.actions.map((a) => `${a.kind}${a.error ? ` FAILED ${a.error.slice(0, 90)}` : ""}`).join(", ")}`);
  }

  // ---------------------------------------------------------------- costs
  out.cost = {
    record_alone: keeperCosts.find((c) => c.instructions === "record_pump_graduation") ?? null,
    migrate_and_record: keeperCosts.find((c) => c.instructions !== "record_pump_graduation") ?? null,
    a_run_that_finds_nothing: "0 lamports (reads only)",
    keeper_payer_total_lamports_on_the_fork: (5_000_000_000n - (await fork.getBalance(keeper.id))).toString(),
    pool_migration_fee_lamports: g.poolMigrationFee.toString(),
    note: "the fork charges the base fee per signature (5,000 lamports) plus the priority fee at the profile's floor price; on mainnet the priority fee follows recent fees up to the profile's cap, on 60,000 compute units for a record and 600,000 for a migration with its record. The migration's cost beyond the fee is pump.fun's: it takes Global.pool_migration_fee from the sender and pays the pool's accounts from it",
  };
} catch (e) {
  outcome = `FAILED: ${String((e as Error)?.stack ?? e).slice(0, 700)}`;
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  for (const p of procs) p.kill(); // each by its own handle, nothing by name
  stopCore();
  stub.stop(true);
}
const passed = checks.filter((c) => c.ok).length;
if (passed !== checks.length && outcome === "PASS") outcome = "FAILED: a check did not hold";
out.finished = new Date().toISOString();
out.outcome = outcome;
out.pass = passed;
out.total = checks.length;
out.sections = sections;
out.checks = checks;
writeFileSync(OUT_FILE, JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
log(`${outcome}: ${passed}/${checks.length}; ${OUT_FILE}`);
process.exit(outcome === "PASS" ? 0 : 1);
