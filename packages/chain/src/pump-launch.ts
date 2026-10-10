import type { Address } from "./codec.ts";
import { ata, TOKEN_2022_PROGRAM } from "./pda.ts";
import { launch, launchPdas, type PumpLaunchArgs } from "./launch.ts";
import {
  buybackAccount,
  createV2,
  creatorFeeHarvest,
  curveMigrated,
  pump,
  PUMP,
  pumpPdas,
  quoteCurveBuyExactOut,
  type BondingCurve,
  type PumpFeeConfig,
  type PumpGlobal,
  type PumpPool,
} from "./pump.ts";
import type { Ix } from "./registry.ts";
import { token } from "./spl.ts";

// An agent launch on pump.fun (owner decisions 2026-10-10, docs/plans/PUMPFUN-LAUNCHES.md): Pump
// create_v2 at the top level (creator = the agent's lineage_launch PDA, quoted in $LINE, never
// mayhem), then lineage_launch register_pump_launch in the same transaction, then the launcher's
// initial buy (launch fronting, docs/plans/LAUNCH-FRONTING.md section 6 option B) delivered to the
// agent key. The fee crank's harvest + crank_pump_fees, and the graduation record.

/** $LINE's quote accounts create_v2 names: its curve, and its canonical pool and vaults once migrated. */
export interface LineQuote {
  mint: Address;
  /** Token-2022 for a create_v2 coin. */
  tokenProgram?: Address;
  pool?: { pool: Address; baseVault: Address; quoteVault: Address };
}

/**
 * Most bytes of name + symbol + metadata URI + repository URL together so that create_v2 +
 * register_pump_launch (with both compute budget instructions) fit one v0 transaction with the launch
 * lookup table: measured by packages/chain/test/prepay.test.ts (exactly 1,232 bytes at the cap). The
 * wizard refuses longer strings; the deposit, the soul and, when they do not fit, the initial buy go
 * in a second transaction (planLaunch).
 */
export const MAX_LAUNCH_STRINGS = 327;

/** create_v2 + register_pump_launch: the venue's create and our record. Signers: launcher, agent, agentMint. */
export function pumpLaunchMain(a: { launcher: Address; agent: Address; agentMint: Address; line: LineQuote; name: string; symbol: string; uri: string;
  args: PumpLaunchArgs; creatorFeeBps?: bigint }): Ix[] {
  const tp = a.line.tokenProgram ?? TOKEN_2022_PROGRAM;
  return [
    createV2({ mint: a.agentMint, user: a.launcher, creator: launchPdas.pumpCreator(a.agent), name: a.name, symbol: a.symbol, uri: a.uri,
      creatorFeeBps: a.creatorFeeBps ?? 0n, quote: { kind: "pumpCoin", mint: a.line.mint, tokenProgram: tp, pool: a.line.pool } }),
    launch.registerPumpLaunch({ launcher: a.launcher, agent: a.agent, agentMint: a.agentMint, lineMint: a.line.mint, args: a.args, lineTokenProgram: tp }),
  ];
}

/**
 * The launcher's initial buy of exactly `amountOut` agent tokens (buy_v3, at most `maxIn` $LINE from
 * the launcher), delivered straight into the agent key's token account (buy_v3 pays the base tokens to
 * the account it is given; proven on the mainnet fork). Goes after register_pump_launch: the program
 * records the curve only before any trade. $LINE's buyback recipient account must exist (the trade
 * never creates it); pass `createBuyback` when it does not yet (anyone may create it).
 */
export function pumpInitialBuy(a: { launcher: Address; agent: Address; agentMint: Address; lineMint: Address; amountOut: bigint; maxIn: bigint; lineTokenProgram?: Address;
  createBuyback?: boolean }): Ix[] {
  const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM, T22 = TOKEN_2022_PROGRAM;
  return [
    ...(a.createBuyback ? [token.createAtaIdempotent(a.launcher, PUMP.buybackRecipients[0], a.lineMint, tp)] : []),
    token.createAtaIdempotent(a.launcher, a.agent, a.agentMint, T22),
    pump.buyV3({ mint: a.agentMint, quoteMint: a.lineMint, quoteTokenProgram: tp, user: a.launcher, userBase: ata(a.agent, a.agentMint, T22), amount: a.amountOut,
      maxQuoteIn: a.maxIn }),
  ];
}

/**
 * The curve create_v2 will write for a coin quoted in $LINE (CREATE_WITH_PUMP_COIN_QUOTE.md "Starting
 * price"): the reference raise (Global's SOL seed scaled to its graduation raise) bought on $LINE's
 * own curve, or its pool once migrated, with no fees, scaled back to a seed. Mirrors pump-sdk 4.0.0
 * `pumpQuoteReserves`; the launch simulation stays the authority.
 */
export function pumpQuotedCurve(g: PumpGlobal, line: { curve: BondingCurve; pool?: { pool: PumpPool; baseReserve: bigint; quoteReserve: bigint } }, creator: Address,
  lineMint: Address, creatorFeeBps = 0n): BondingCurve {
  const c = line.curve;
  if (c.isMayhemMode || c.depth > 0) throw new Error("$LINE cannot be a quote: mayhem or depth > 0");
  let base: bigint, quote: bigint;
  if (curveMigrated(c)) {
    if (!line.pool) throw new Error("$LINE has migrated: its pool reserves are required");
    base = line.pool.baseReserve;
    quote = line.pool.quoteReserve + line.pool.pool.virtualQuoteReserves;
  } else {
    if (c.complete) throw new Error("$LINE's curve is complete and awaits migration (QuoteCurveAwaitingMigration): retry after migrate_v2");
    base = c.virtualTokenReserves;
    quote = c.virtualQuoteReserves;
  }
  const target = c.quoteMint === "11111111111111111111111111111111" ? g.initialVirtualSolReserves : g.initialVirtualQuoteReserves;
  const tradable = g.initialVirtualTokenReserves - g.initialRealTokenReserves;
  const input = (target * g.initialRealTokenReserves) / tradable;
  const raise = (input * base) / (quote + input);
  const seed = (raise * tradable) / g.initialRealTokenReserves;
  if (seed < 1n) throw new Error("QuoteReservesOutOfRange: $LINE is priced so high the seed rounds to zero");
  return {
    virtualTokenReserves: g.initialVirtualTokenReserves, virtualQuoteReserves: seed, realTokenReserves: g.initialRealTokenReserves, realQuoteReserves: 0n,
    tokenTotalSupply: g.tokenTotalSupply, complete: false, creator, isMayhemMode: false, isCashbackCoin: false, quoteMint: lineMint, creatorFeeBps,
    canEditCreatorFee: false, isHolderReward: false, creatorFee: 0n, protocolFees: 0n, depth: 1, initialVirtualQuoteReserves: seed, postCompleteBaseOut: 0n,
    postCompleteQuoteIn: 0n,
  };
}

/** The initial buy's curve quote on the curve create_v2 is about to write (fees included). */
export function quoteInitialBuy(g: PumpGlobal, fc: PumpFeeConfig, fresh: BondingCurve, amountOut: bigint): bigint {
  return quoteCurveBuyExactOut(g, fc, fresh, amountOut, g.tokenTotalSupply).quoteIn;
}

/**
 * The keeper's crank of one agent: create the creator PDA's $LINE ATA when missing, pump.fun's sweep
 * and collect on the curve (and the pool's once `pool` is given), then crank_pump_fees. Permissionless.
 */
export function pumpCrankIxs(a: { payer: Address; agent: Address; agentMint: Address; lineMint: Address; lineTokenProgram?: Address; pool?: Address }): Ix[] {
  const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM, creator = launchPdas.pumpCreator(a.agent);
  return [
    token.createAtaIdempotent(a.payer, creator, a.lineMint, tp),
    ...creatorFeeHarvest({ payer: a.payer, mint: a.agentMint, creator, quoteMint: a.lineMint, pool: a.pool, quoteTokenProgram: tp }),
    launch.crankPumpFees({ agent: a.agent, agentMint: a.agentMint, lineMint: a.lineMint, lineTokenProgram: tp }),
  ];
}

/** Anyone after completion: pump.fun's migrate_v2 (when the pool is not there yet) and our graduation record. */
export function pumpGraduateIxs(a: { payer: Address; agentMint: Address; lineMint: Address; withdrawAuthority: Address; migrated: boolean; lineTokenProgram?: Address }): Ix[] {
  const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM;
  return [
    ...(a.migrated ? [] : [pump.migrateV2({ user: a.payer, mint: a.agentMint, quoteMint: a.lineMint, withdrawAuthority: a.withdrawAuthority, quoteTokenProgram: tp })]),
    launch.recordPumpGraduation({ agentMint: a.agentMint, lineMint: a.lineMint }),
  ];
}

