// The mainnet TEST's steps (docs/MAINNET-RUNBOOK.md "Mainnet test (single key, throwaway quote coin)",
// owner decisions 2026-10-11): one key (the deployer) is admin and upgrade authority of all three
// programs so they can be closed afterwards, and the quote is a throwaway pump.fun coin created for
// the test. Shared by the operator CLI (test.ts) and the fork rehearsal (test-rehearsal.ts), so the
// commands the coordinator runs are the code the fork proved. Every step reads chain state first and
// skips what exists. Nothing here prints a key or an endpoint.
import {
  ata,
  ChainReader,
  createV2,
  decodeBondingCurve,
  decodeLoaderAuthority,
  decodeLookupTable,
  decodePumpFeeConfig,
  decodePumpGlobal,
  launchTableAddresses,
  MAINNET_TEST_PROGRAM_IDS,
  programDataAddress,
  pump,
  PUMP,
  pumpPdas,
  quoteCurveBuyExactIn,
  quoteCurveSell,
  readMsgConfig,
  system,
  token,
  TOKEN_2022_PROGRAM,
  type Ix,
  type Rpc,
  type SendResult,
  type Signer,
  useProfilePrograms,
} from "@units/chain";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NetworkProfile } from "../../packages/chain/src/profile.ts";
import { adminActions } from "./admin.ts";
import { computeSink, initializeAll, programIdsNow, useActiveProfile, type Loaded } from "./steps.ts";

export type Send = (what: string, payer: Signer, ixs: Ix[], o?: { signers?: Signer[]; computeUnits?: number }) => Promise<SendResult>;
export type Check = (name: string, ok: boolean, detail?: string) => void;

const T22 = TOKEN_2022_PROGRAM;
/** Written into the key directory by preflight.ts when every check passes; test.ts needs it (24 hours) before it sends on mainnet. */
export const READY_FILE = "preflight-ready.json";
const SOL_QUOTE = "11111111111111111111111111111111";

/** Where the test deployment's builds and id keypairs live (cargo feature `mainnet-test`; never the mainnet ids' directory). */
export const TEST_BUILD_DIR = join(import.meta.dir, "..", "..", "onchain", "target", "mainnet-test");
export const TEST_PROGRAM_KEYS = join(homedir(), ".config", "units", "mainnet-test");

/**
 * The mainnet profile with the mainnet TEST deployment's program ids active (packages/chain
 * MAINNET_TEST_PROGRAM_IDS): every builder, PDA and reader of this process then uses the throwaway ids,
 * and the mainnet ids of the launch are never touched by the test scripts.
 */
export function useTestProfile(): NetworkProfile {
  const p = useActiveProfile();
  if (p.network !== "mainnet") throw new Error("run with UNITS_NETWORK=mainnet: the test uses the mainnet profile with the test program ids");
  const programs = { ...MAINNET_TEST_PROGRAM_IDS };
  useProfilePrograms({ network: "mainnet", programs });
  return { ...p, programs };
}

export interface CoinMeta {
  name: string;
  symbol: string;
  uri: string;
}

/**
 * The throwaway quote coin: pump.fun create_v2 paired with SOL, never mayhem, creator = the deployer,
 * then one small buy on its own curve (`buyLamports`, fees included; 0 skips it). Token-2022, 6
 * decimals, supply and curve are pump.fun's. Idempotent: an existing curve is not created again and
 * a deployer that already holds the coin does not buy again.
 */
export async function createTestCoin(rpc: Rpc, send: Send, check: Check, deployer: Signer, mintKey: Signer, meta: CoinMeta, buyLamports: bigint) {
  const reader = new ChainReader(rpc);
  const mint = mintKey.id, curveAddr = pumpPdas.bondingCurve(mint);
  if (!(await rpc.getAccountInfo(curveAddr)))
    await send(`test coin ${meta.symbol}: pump.fun create_v2 paired with SOL, not mayhem`, deployer,
      [createV2({ mint, user: deployer.id, creator: deployer.id, name: meta.name, symbol: meta.symbol, uri: meta.uri, quote: { kind: "sol" } })],
      { signers: [mintKey], computeUnits: 400_000 });
  const held = (await reader.tokenBalance(ata(deployer.id, mint, T22))) ?? 0n;
  if (buyLamports > 0n && held === 0n) {
    const [gA, fcA, cA] = await rpc.getMultipleAccounts([PUMP.global, PUMP.feeConfig, curveAddr]);
    const g = decodePumpGlobal(gA!.data), fc = decodePumpFeeConfig(fcA!.data), c = decodeBondingCurve(cA!.data);
    const base = (await reader.tokenBalance(ata(curveAddr, mint, T22)))!;
    const q = quoteCurveBuyExactIn(g, fc, c, buyLamports, base);
    if (q.completes || q.tokens <= 0n) throw new Error("the test coin buy must be small: it would complete the curve or buy nothing");
    await send(`test coin ${meta.symbol}: buy ${q.tokens} base units on its own curve for at most ${buyLamports} lamports (buy_v3)`, deployer,
      [token.createAtaIdempotent(deployer.id, deployer.id, mint, T22), pump.buyV3({ mint, quoteMint: PUMP.wsol, user: deployer.id, amount: q.tokens, maxQuoteIn: buyLamports })],
      { computeUnits: 300_000 });
  }
  const c = decodeBondingCurve((await rpc.getAccountInfo(curveAddr))!.data);
  const m = (await reader.mint(mint))!;
  check("test coin: a pump.fun coin (Token-2022, no mint or freeze authority), paired with SOL, depth 0, not mayhem, curve not complete",
    m.tokenProgram === T22 && m.mintAuthority === null && m.freezeAuthority === null && c.quoteMint === SOL_QUOTE && c.depth === 0 && !c.isMayhemMode && !c.complete, mint);
  return { mint, decimals: m.decimals, held: (await reader.tokenBalance(ata(deployer.id, mint, T22))) ?? 0n };
}

/**
 * Initializes the three programs with the deployer as every admin (test mode: no multisig), the
 * compute sink = the deployer's quote account, the launch lookup table, then the bounty and challenge
 * configs the runbook's first proposals set, sent directly by the deployer.
 */
export async function initializeTest(rpc: Rpc, send: Send, check: Check, deployer: Signer, p: Loaded, existingTable?: string) {
  const reader = new ChainReader(rpc);
  const r = await initializeAll(rpc, send, check, deployer, p, deployer.id, existingTable);
  const bc = await reader.bountyConfig();
  if (!bc) await send("set_bounty_config (admin = the deployer)", deployer, adminActions.bountySetConfig(deployer.id, p.bounty));
  const bc1 = await reader.bountyConfig();
  check("BountyConfig set", !!bc1 && bc1.maxBountyOutBps === p.bounty.maxBountyOutBps && bc1.minAmount === p.bounty.minAmount);
  const cc = await reader.challengeConfig();
  if (!cc) await send("set_challenge_config (admin = the deployer)", deployer, adminActions.challengeSetConfig(deployer.id, p.line_mint, p.line_token_program, p.challenge));
  const cc1 = await reader.challengeConfig();
  check("ChallengeConfig set", !!cc1 && Number(cc1.windowS) === Number(p.challenge.windowS) && cc1.bond === p.challenge.bond);
  return r;
}

/** Reads the test deployment back: every admin and every upgrade authority is the deployer, the quote is the test coin. */
export async function checkTest(rpc: Rpc, check: Check, deployer: string, p: Loaded, table?: string) {
  const reader = new ChainReader(rpc);
  const c = await reader.registryConfig(), lc = await reader.launchConfig(), mc = await readMsgConfig(rpc);
  check("registry: admin = the deployer, Core authority, quote mint", c?.admin === deployer && c?.coreAuthority === p.core_authority && c?.mint === p.line_mint, `${c?.admin}`);
  check("launch: admin = the deployer, runtime authority, venue pump.fun, sink = the deployer's quote account",
    lc?.admin === deployer && lc?.runtimeAuthority === p.runtime_authority && lc?.venue === PUMP.program && lc?.computeSink === computeSink(p, deployer), `${lc?.admin}`);
  check("messages: admin = the deployer", mc?.admin === deployer, `${mc?.admin}`);
  for (const [name, id] of Object.entries(programIdsNow())) {
    const pd = await rpc.getAccountInfo(programDataAddress(id));
    check(`${name}: upgrade authority = the deployer (it can close the program)`, !!pd && decodeLoaderAuthority(pd.data) === deployer, pd ? `${decodeLoaderAuthority(pd.data)}` : "no ProgramData");
  }
  const curve = await rpc.getAccountInfo(pumpPdas.bondingCurve(p.line_mint));
  const lc0 = curve && curve.owner === PUMP.program ? decodeBondingCurve(curve.data) : null;
  check("quote: a pump.fun coin paired with SOL (depth 0), not mayhem, curve not complete", !!lc0 && lc0.depth === 0 && !lc0.isMayhemMode && lc0.quoteMint === SOL_QUOTE && !lc0.complete);
  const g = decodePumpGlobal((await rpc.getAccountInfo(PUMP.global))!.data);
  check("pump.fun Global.max_curve_depth is 1 or more (pump-coin quotes enabled)", g.maxCurveDepth >= 1, `${g.maxCurveDepth}`);
  if (table) {
    const t = await rpc.getAccountInfo(table);
    const want = launchTableAddresses({ lineMint: p.line_mint, lineTokenProgram: p.line_token_program, linePool: p.line_pool });
    check("launch lookup table frozen with the expected addresses", !!t && decodeLookupTable(t.data).authority === null && decodeLookupTable(t.data).addresses.join() === want.join(), table);
  }
}

/** Sends everything a hot key holds above the fee back to `to` (the key pays its own fee). Returns the lamports moved. */
export async function sweepKey(rpc: Rpc, send: Send, key: Signer, to: string, label: string): Promise<bigint> {
  const bal = await rpc.getBalance(key.id);
  const fee = 5_000n;
  if (bal <= fee) return 0n;
  await send(`sweep ${label}: ${bal - fee} lamports back to the deployer`, key, [system.transfer(key.id, to, bal - fee)]);
  return bal - fee;
}

/** Sells every test coin `owner` holds back on its SOL curve (sell_v3), at least `quote x (10,000 - slippageBps) / 10,000` lamports. Returns the quoted lamports. */
export async function sellTestCoin(rpc: Rpc, send: Send, owner: Signer, mint: string, slippageBps: number, label: string): Promise<bigint> {
  const reader = new ChainReader(rpc);
  const held = (await reader.tokenBalance(ata(owner.id, mint, T22))) ?? 0n;
  if (held === 0n) return 0n;
  const [gA, fcA, cA] = await rpc.getMultipleAccounts([PUMP.global, PUMP.feeConfig, pumpPdas.bondingCurve(mint)]);
  const c = decodeBondingCurve(cA!.data);
  if (c.complete) throw new Error("the test coin's curve is complete: sell it on its PumpSwap pool instead (not wired here)");
  const q = quoteCurveSell(decodePumpGlobal(gA!.data), decodePumpFeeConfig(fcA!.data), c, held);
  await send(`${label}: sell ${held} base units of the test coin on its curve (sell_v3), quote ${q.quoteOut} lamports`, owner,
    [pump.sellV3({ mint, quoteMint: PUMP.wsol, user: owner.id, amount: held, minQuoteOut: (q.quoteOut * BigInt(10_000 - slippageBps)) / 10_000n })], { computeUnits: 300_000 });
  return q.quoteOut;
}
