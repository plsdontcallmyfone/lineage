import { accountDisc, addressBytes, bytesToHex, ixDisc, Reader, sha256, toAddress, Writer, type Address } from "./codec.ts";
import { ASSOCIATED_TOKEN_PROGRAM, ata, pda, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda.ts";
import { r, w, type Ix } from "./registry.ts";

// pump.fun (Pump bonding curve), PumpSwap (pump AMM) and Pump Fees: program and PDA addresses,
// instruction builders, account and event decoders, and quote math. Every layout, seed and account
// list follows pump.fun's official docs and IDLs at github.com/pump-fun/pump-public-docs commit
// 2293f9a (2026-10-08), read 2026-10-10 (docs/plans/PUMPFUN-LAUNCHES.md section 3). Builders take
// plain addresses and never fetch; the readers that need chain state take decoded accounts.
// No pump.fun SDK is used, so the browser bundle stays dependency free.

export const PUMP = {
  program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  amm: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  fees: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  mayhem: "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e",
  /** Pump PDA ["global"]. */
  global: "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
  /** Pump PDA ["quote-control"] (CREATE_WITH_PUMP_COIN_QUOTE.md). */
  quoteControl: "6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP",
  /** Pump Fees PDA ["fee_config", Pump]. */
  feeConfig: "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt",
  /** Pump Fees PDA ["fee_config", PumpSwap]. */
  ammFeeConfig: "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx",
  /** PumpSwap PDA ["global_config"]. */
  ammGlobalConfig: "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw",
  /** Pump PDA ["__event_authority"]. */
  eventAuthority: "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
  wsol: "So11111111111111111111111111111111111111112",
  /** The 8 buyback fee recipient wallets (FEE_RECIPIENTS.md), in Global.buyback_fee_recipients order. */
  buybackRecipients: [
    "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD", "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
    "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL", "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
    "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6", "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
    "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD", "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
  ],
} as const;

const enc = (s: string) => new TextEncoder().encode(s);
const u16le = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);

export const pumpPdas = {
  bondingCurve: (mint: Address) => pda(PUMP.program, "bonding-curve", addressBytes(mint)),
  mintAuthority: () => pda(PUMP.program, "mint-authority"),
  /** Pump creator vault: holds a creator's swept curve fees (SWEEP_FEES.md). */
  creatorVault: (creator: Address) => pda(PUMP.program, "creator-vault", addressBytes(creator)),
  /** Pump PDA ["pool-authority", mint]: the canonical pool's creator after migration. */
  poolAuthority: (mint: Address) => pda(PUMP.program, "pool-authority", addressBytes(mint)),
  userVolume: (user: Address) => pda(PUMP.program, "user_volume_accumulator", addressBytes(user)),
  eventAuthority: () => pda(PUMP.program, "__event_authority"),
  mayhemGlobalParams: () => pda(PUMP.mayhem, "global-params"),
  mayhemSolVault: () => pda(PUMP.mayhem, "sol-vault"),
  mayhemState: (mint: Address) => pda(PUMP.mayhem, "mayhem-state", addressBytes(mint)),
  /** The canonical PumpSwap pool of a pump coin: ["pool", 0u16, pool_authority, mint, quote] (quote = WSOL for a SOL coin). */
  pool: (mint: Address, quoteMint: Address) =>
    pda(PUMP.amm, "pool", u16le(0), addressBytes(pumpPdas.poolAuthority(mint)), addressBytes(mint), addressBytes(quoteMint)),
  lpMint: (pool: Address) => pda(PUMP.amm, "pool_lp_mint", addressBytes(pool)),
  /** PumpSwap ["creator_vault", coin_creator]: authority of the pool creator fee ATA. */
  ammCreatorVault: (creator: Address) => pda(PUMP.amm, "creator_vault", addressBytes(creator)),
  /** PumpSwap ["boost_vault", pool]: migrate_v2's trailing remaining accounts (pump-sdk 4.0.0). */
  boostVault: (pool: Address) => pda(PUMP.amm, "boost_vault", addressBytes(pool)),
  ammUserVolume: (user: Address) => pda(PUMP.amm, "user_volume_accumulator", addressBytes(user)),
  ammEventAuthority: () => pda(PUMP.amm, "__event_authority"),
};

// ---------- accounts ----------

export interface PumpGlobal {
  initialized: boolean;
  authority: Address;
  feeRecipient: Address;
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  feeBasisPoints: bigint;
  withdrawAuthority: Address;
  enableMigrate: boolean;
  poolMigrationFee: bigint;
  creatorFeeBasisPoints: bigint;
  setCreatorAuthority: Address;
  adminSetCreatorAuthority: Address;
  createV2Enabled: boolean;
  mayhemModeEnabled: boolean;
  buybackFeeRecipients: Address[];
  buybackBasisPoints: bigint;
  initialVirtualQuoteReserves: bigint;
  whitelistedQuoteMints: Address[];
  creatorFeeConfigurable: boolean;
  maxConfigurableCreatorFeeBps: bigint;
  maxCurveDepth: number;
}
/** Pump `Global` (idl/pump.json). Trailing fields an older, shorter account lacks read as 0. */
export function decodePumpGlobal(d: Uint8Array): PumpGlobal {
  const x = new Reader(d).expect("Global");
  const keys = (n: number) => Array.from({ length: n }, () => x.address());
  const opt = <T>(f: () => T, zero: T): T => { try { return f(); } catch { return zero; } };
  const g: Partial<PumpGlobal> = {};
  g.initialized = x.bool(); g.authority = x.address(); g.feeRecipient = x.address();
  g.initialVirtualTokenReserves = x.u64(); g.initialVirtualSolReserves = x.u64(); g.initialRealTokenReserves = x.u64();
  g.tokenTotalSupply = x.u64(); g.feeBasisPoints = x.u64(); g.withdrawAuthority = x.address(); g.enableMigrate = x.bool();
  g.poolMigrationFee = x.u64(); g.creatorFeeBasisPoints = x.u64(); keys(7); g.setCreatorAuthority = x.address();
  g.adminSetCreatorAuthority = x.address(); g.createV2Enabled = x.bool(); x.address(); x.address(); g.mayhemModeEnabled = x.bool(); keys(7);
  opt(() => x.bool(), false);
  g.buybackFeeRecipients = opt(() => keys(8), []);
  g.buybackBasisPoints = opt(() => x.u64(), 0n);
  g.initialVirtualQuoteReserves = opt(() => x.u64(), 0n);
  g.whitelistedQuoteMints = opt(() => keys(1), []);
  g.creatorFeeConfigurable = opt(() => x.bool(), false);
  g.maxConfigurableCreatorFeeBps = opt(() => x.u64(), 0n);
  opt(() => x.address(), "");
  opt(() => x.bool(), false);
  g.maxCurveDepth = opt(() => x.u8(), 0);
  return g as PumpGlobal;
}

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: Address;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** The zero key for a SOL-paired curve. */
  quoteMint: Address;
  creatorFeeBps: bigint;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  /** Creator fee waiting on the curve (v3 trades), paid out by sweep_creator_fee. */
  creatorFee: bigint;
  protocolFees: bigint;
  depth: number;
  initialVirtualQuoteReserves: bigint;
  postCompleteBaseOut: bigint;
  postCompleteQuoteIn: bigint;
}
/** Byte offsets (with the 8-byte discriminator) lineage_launch reads; checked against the fork's accounts. */
export const BONDING_CURVE_OFFSETS = {
  virtualTokenReserves: 8, virtualQuoteReserves: 16, realTokenReserves: 24, realQuoteReserves: 32, tokenTotalSupply: 40, complete: 48,
  creator: 49, isMayhemMode: 81, isCashbackCoin: 82, quoteMint: 83, creatorFeeBps: 115, canEditCreatorFee: 123, isHolderReward: 124,
  creatorFee: 125, protocolFees: 133, depth: 141, initialVirtualQuoteReserves: 142, postCompleteBaseOut: 150, postCompleteQuoteIn: 158,
  end: 166,
} as const;
export function decodeBondingCurve(d: Uint8Array): BondingCurve {
  const x = new Reader(d).expect("BondingCurve");
  const opt = <T>(f: () => T, zero: T): T => (x.remaining() > 0 ? f() : zero);
  return {
    virtualTokenReserves: x.u64(), virtualQuoteReserves: x.u64(), realTokenReserves: x.u64(), realQuoteReserves: x.u64(),
    tokenTotalSupply: x.u64(), complete: x.bool(), creator: x.address(), isMayhemMode: opt(x.bool, false), isCashbackCoin: opt(x.bool, false),
    quoteMint: opt(x.address, SYSTEM_PROGRAM), creatorFeeBps: opt(x.u64, 0n), canEditCreatorFee: opt(x.bool, false),
    isHolderReward: opt(x.bool, false), creatorFee: opt(x.u64, 0n), protocolFees: opt(x.u64, 0n), depth: opt(x.u8, 0),
    initialVirtualQuoteReserves: opt(x.u64, 0n), postCompleteBaseOut: opt(x.u64, 0n), postCompleteQuoteIn: opt(x.u64, 0n),
  };
}
/** pump `BondingCurve::is_migrated`: every reserve zeroed by the migration. */
export const curveMigrated = (c: BondingCurve) =>
  c.realQuoteReserves === 0n && c.virtualQuoteReserves === 0n && c.realTokenReserves === 0n && c.virtualTokenReserves === 0n;
/** The quote mint as trades name it: WSOL for a SOL curve (stored as the zero key). */
export const curveQuoteMint = (c: BondingCurve): Address => (c.quoteMint === SYSTEM_PROGRAM ? PUMP.wsol : c.quoteMint);

export interface PumpPool {
  poolBump: number;
  index: number;
  creator: Address;
  baseMint: Address;
  quoteMint: Address;
  lpMint: Address;
  poolBaseTokenAccount: Address;
  poolQuoteTokenAccount: Address;
  lpSupply: bigint;
  coinCreator: Address;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** Signed; effective quote reserves = quote vault balance + this. */
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  protocolFees: bigint;
  creatorFees: bigint;
}
export function decodePumpPool(d: Uint8Array): PumpPool {
  const x = new Reader(d).expect("Pool");
  const opt = <T>(f: () => T, zero: T): T => (x.remaining() > 0 ? f() : zero);
  return {
    poolBump: x.u8(), index: x.u16(), creator: x.address(), baseMint: x.address(), quoteMint: x.address(), lpMint: x.address(),
    poolBaseTokenAccount: x.address(), poolQuoteTokenAccount: x.address(), lpSupply: x.u64(), coinCreator: opt(x.address, SYSTEM_PROGRAM),
    isMayhemMode: opt(x.bool, false), isCashbackCoin: opt(x.bool, false), virtualQuoteReserves: opt(() => BigInt.asIntN(128, x.u128()), 0n),
    creatorFeeBps: opt(x.u64, 0n), canEditCreatorFee: opt(x.bool, false), isHolderReward: opt(x.bool, false), protocolFees: opt(x.u64, 0n),
    creatorFees: opt(x.u64, 0n),
  };
}

export interface PumpFees { lpFeeBps: bigint; protocolFeeBps: bigint; creatorFeeBps: bigint }
export interface PumpFeeConfig {
  admin: Address;
  flatFees: PumpFees;
  feeTiers: { marketCapThreshold: bigint; fees: PumpFees }[];
  stableFeeTiers: { marketCapThreshold: bigint; fees: PumpFees }[];
  exoticFlatFees: PumpFees;
}
/** Pump Fees `FeeConfig` (idl/pump_fees.json); one for Pump, one for PumpSwap. */
export function decodePumpFeeConfig(d: Uint8Array): PumpFeeConfig {
  const x = new Reader(d).expect("FeeConfig");
  const fees = (): PumpFees => ({ lpFeeBps: x.u64(), protocolFeeBps: x.u64(), creatorFeeBps: x.u64() });
  const tiers = () => Array.from({ length: x.u32() }, () => ({ marketCapThreshold: x.u128(), fees: fees() }));
  x.u8();
  const admin = x.address();
  const flatFees = fees();
  const feeTiers = tiers();
  const stableFeeTiers = x.remaining() >= 4 ? tiers() : [];
  const exoticFlatFees = x.remaining() >= 24 ? fees() : { lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n };
  return { admin, flatFees, feeTiers, stableFeeTiers, exoticFlatFees };
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const isSolLike = (q: Address) => q === SYSTEM_PROGRAM || q === PUMP.wsol || q === "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP";
/**
 * The fee schedule a canonical curve or pool pays, by quote mint, as pump-fees selects it: SOL-like
 * quotes the market-cap tier, USDC the stable tiers, any other quote (an agent coin quoted in $LINE)
 * `exotic_flat_fees` (or `flat_fees` while that is unset). `marketCap` in quote base units.
 */
export function pumpFeeSchedule(fc: PumpFeeConfig, quoteMint: Address, marketCap: bigint): PumpFees {
  const tier = (tiers: PumpFeeConfig["feeTiers"]) => {
    if (!tiers.length) throw new Error("fee tiers empty");
    if (marketCap < tiers[0]!.marketCapThreshold) return tiers[0]!.fees;
    for (const t of [...tiers].reverse()) if (marketCap >= t.marketCapThreshold) return t.fees;
    return tiers[0]!.fees;
  };
  if (isSolLike(quoteMint)) return tier(fc.feeTiers);
  if (quoteMint === USDC) return tier(fc.stableFeeTiers.length ? fc.stableFeeTiers : fc.feeTiers);
  const z = fc.exoticFlatFees;
  return z.lpFeeBps === 0n && z.protocolFeeBps === 0n && z.creatorFeeBps === 0n ? fc.flatFees : z;
}

// ---------- quote math (mirrors pump's arithmetic; simulation stays the authority) ----------

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, 10_000n);
const ONE_BILLION_SUPPLY = 1_000_000_000_000_000n;

/** The protocol and creator rates a curve trade pays (creator 0 on a curve without a creator). */
export function curveRates(g: PumpGlobal, fc: PumpFeeConfig, c: BondingCurve): { protocolBps: bigint; creatorBps: bigint } {
  const mcap = c.virtualTokenReserves === 0n ? 0n : (c.virtualQuoteReserves * ONE_BILLION_SUPPLY) / c.virtualTokenReserves;
  const s = pumpFeeSchedule(fc, c.quoteMint, mcap);
  const creatorBps = g.creatorFeeConfigurable && c.creatorFeeBps > 0n ? c.creatorFeeBps : s.creatorFeeBps;
  return { protocolBps: s.protocolFeeBps, creatorBps: c.creator === SYSTEM_PROGRAM ? 0n : creatorBps };
}

export interface CurveBuyQuote {
  /** Base tokens out (both legs of a synthetic migration). */
  tokens: bigint;
  /** Quote in, fees included. */
  quoteIn: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** True when the buy completes the curve. */
  completes: boolean;
}

/**
 * `buy_v3` for exactly `amount` tokens (the value to send as `max_sol_cost` before slippage). Past
 * the remaining supply the rest is priced on the pool-to-be (SYNTHETIC_MIGRATION.md);
 * `curveBaseBalance` is the curve's base token account balance.
 */
export function quoteCurveBuyExactOut(g: PumpGlobal, fc: PumpFeeConfig, c: BondingCurve, amount: bigint, curveBaseBalance: bigint): CurveBuyQuote {
  if (amount <= 0n || c.complete || c.virtualTokenReserves === 0n) throw new Error("curve takes no trades");
  const { protocolBps, creatorBps } = curveRates(g, fc, c);
  const remaining = c.realTokenReserves;
  const curveTokens = amount < remaining ? amount : remaining;
  const net = (curveTokens * c.virtualQuoteReserves) / (c.virtualTokenReserves - curveTokens) + 1n;
  let pf = feeOf(net, protocolBps), cf = feeOf(net, creatorBps), quoteIn = net + pf + cf;
  if (amount > remaining && !c.isMayhemMode) {
    const past = amount - remaining;
    const pool = poolToBe(g, c, curveBaseBalance, remaining, net);
    if (pool.base <= past) throw new Error("buy takes the whole pool-to-be (NotEnoughTokensToBuy)");
    const leg = ceilDiv(pool.quote * past, pool.base - past);
    const lpf = feeOf(leg, protocolBps), lcf = feeOf(leg, creatorBps);
    pf += lpf; cf += lcf; quoteIn += leg + lpf + lcf;
  }
  return { tokens: amount, quoteIn, protocolFee: pf, creatorFee: cf, completes: amount >= remaining };
}

/** `buy_exact_quote_in_v3` with a budget of `budget` quote, fees included. */
export function quoteCurveBuyExactIn(g: PumpGlobal, fc: PumpFeeConfig, c: BondingCurve, budget: bigint, curveBaseBalance: bigint): CurveBuyQuote {
  if (budget <= 0n || c.complete || c.virtualTokenReserves === 0n) throw new Error("curve takes no trades");
  const { protocolBps, creatorBps } = curveRates(g, fc, c);
  const netOf = (b: bigint) => {
    const tb = protocolBps + creatorBps;
    let n = tb === 0n ? b : (b * 10_000n) / (tb + 10_000n);
    const cost = n + feeOf(n, protocolBps) + feeOf(n, creatorBps);
    if (cost > b) n -= cost - b;
    return n;
  };
  const net = netOf(budget);
  const remaining = c.realTokenReserves;
  if (net <= 1n) return { tokens: 0n, quoteIn: 0n, protocolFee: 0n, creatorFee: 0n, completes: false };
  const tokens = ((net - 1n) * c.virtualTokenReserves) / (c.virtualQuoteReserves + net - 1n);
  if (tokens <= remaining || c.isMayhemMode) {
    const t = tokens < remaining ? tokens : remaining;
    return { tokens: t, quoteIn: budget, protocolFee: feeOf(net, protocolBps), creatorFee: feeOf(net, creatorBps), completes: t === remaining };
  }
  const curveNet = (remaining * c.virtualQuoteReserves) / (c.virtualTokenReserves - remaining) + 1n;
  const curveFees = [feeOf(curveNet, protocolBps), feeOf(curveNet, creatorBps)] as const;
  const left = budget - (curveNet + curveFees[0] + curveFees[1]);
  if (left <= 0n) return { tokens: remaining, quoteIn: curveNet + curveFees[0] + curveFees[1], protocolFee: curveFees[0], creatorFee: curveFees[1], completes: true };
  const leg = netOf(left);
  const pool = poolToBe(g, c, curveBaseBalance, remaining, curveNet);
  const legTokens = ((leg - 1n) * pool.base) / (pool.quote + leg - 1n);
  return { tokens: remaining + legTokens, quoteIn: budget, protocolFee: curveFees[0] + feeOf(leg, protocolBps),
    creatorFee: curveFees[1] + feeOf(leg, creatorBps), completes: true };
}

/** `sell_v3` of `amount` tokens: quote out after the protocol and creator fee. */
export function quoteCurveSell(g: PumpGlobal, fc: PumpFeeConfig, c: BondingCurve, amount: bigint): { quoteOut: bigint; protocolFee: bigint; creatorFee: bigint } {
  if (amount <= 0n || c.complete || c.virtualTokenReserves === 0n) throw new Error("curve takes no trades");
  const { protocolBps, creatorBps } = curveRates(g, fc, c);
  const gross = (amount * c.virtualQuoteReserves) / (c.virtualTokenReserves + amount);
  const pf = feeOf(gross, protocolBps), cf = feeOf(gross, creatorBps);
  return { quoteOut: gross - pf - cf, protocolFee: pf, creatorFee: cf };
}

function poolToBe(g: PumpGlobal, c: BondingCurve, curveBaseBalance: bigint, curveTokens: bigint, curveNet: bigint): { base: bigint; quote: bigint } {
  const raised = c.realQuoteReserves + curveNet;
  const base = curveBaseBalance - curveTokens;
  const quote = isSolLike(c.quoteMint) ? raised - g.poolMigrationFee : raised;
  if (base <= 0n || quote <= 0n) throw new Error("empty pool-to-be: check the curve's base balance");
  return { base, quote };
}

/** Spot price of one base unit in quote base units, as a [numerator, denominator] pair. */
export const curveSpot = (c: BondingCurve): [bigint, bigint] => [c.virtualQuoteReserves, c.virtualTokenReserves];

/** PumpSwap pool rates (pump pools pay the curve schedule's pool tier; exotic quotes the flat row). */
export function poolRates(gc: { creatorFeeConfigurable: boolean }, fc: PumpFeeConfig, p: PumpPool, baseSupply: bigint, effQuote: bigint, baseReserve: bigint): PumpFees {
  const mcap = baseReserve === 0n ? 0n : (effQuote * baseSupply) / baseReserve;
  const s = pumpFeeSchedule(fc, p.quoteMint, mcap);
  const creatorFeeBps = p.coinCreator === SYSTEM_PROGRAM ? 0n : gc.creatorFeeConfigurable && p.creatorFeeBps > 0n ? p.creatorFeeBps : s.creatorFeeBps;
  return { lpFeeBps: s.lpFeeBps, protocolFeeBps: s.protocolFeeBps, creatorFeeBps };
}
/** PumpSwap `buy_exact_quote_in_v2`: base out for `budget` quote (fees included). `quoteReserve` is the vault balance. */
export function quotePoolBuyExactIn(rates: PumpFees, p: PumpPool, baseReserve: bigint, quoteReserve: bigint, budget: bigint): { baseOut: bigint; creatorFee: bigint } {
  const tb = rates.lpFeeBps + rates.protocolFeeBps + rates.creatorFeeBps;
  let net = (budget * 10_000n) / (tb + 10_000n);
  const lp = feeOf(net, rates.lpFeeBps), pf = feeOf(net, rates.protocolFeeBps), cf = feeOf(net, rates.creatorFeeBps);
  const excess = net + lp + pf + cf - budget;
  if (excess > 0n) net -= excess;
  const eff = quoteReserve + p.virtualQuoteReserves;
  return { baseOut: ((net - 1n) * baseReserve) / (eff + net - 1n), creatorFee: cf };
}
/** PumpSwap `sell_v2`: quote out for `amount` base after the LP, protocol and creator fee. */
export function quotePoolSell(rates: PumpFees, p: PumpPool, baseReserve: bigint, quoteReserve: bigint, amount: bigint): { quoteOut: bigint; creatorFee: bigint } {
  const eff = quoteReserve + p.virtualQuoteReserves;
  const gross = (eff * amount) / (baseReserve + amount);
  const lp = feeOf(gross, rates.lpFeeBps), pf = feeOf(gross, rates.protocolFeeBps), cf = feeOf(gross, rates.creatorFeeBps);
  return { quoteOut: gross - lp - pf - cf, creatorFee: cf };
}

// ---------- instructions ----------

const tokenProgramOf = (quoteMint: Address, quoteTokenProgram?: Address) =>
  quoteTokenProgram ?? (quoteMint === PUMP.wsol || quoteMint === USDC ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM);
const optBool = (wr: Writer, b: boolean) => wr.u8(b ? 1 : 0);

/** The quote a new coin is paired with: SOL, or a pump coin on its curve, or a migrated pump coin. */
export type CreateQuote =
  | { kind: "sol" }
  | { kind: "pumpCoin"; mint: Address; tokenProgram?: Address; pool?: { pool: Address; baseVault: Address; quoteVault: Address } };

export interface CreateV2Args {
  mint: Address;
  user: Address;
  creator: Address;
  name: string;
  symbol: string;
  uri: string;
  quote: CreateQuote;
  /** Omitted or 0: the standard schedule (owner decision 2026-10-10: pump.fun's default). */
  creatorFeeBps?: bigint;
}
/** Pump `create_v2` (COIN_CREATION.md, CREATE_WITH_PUMP_COIN_QUOTE.md). Never mayhem, never holder rewards. Signers: mint, user. */
export function createV2(a: CreateV2Args): Ix {
  if (a.name.length > 32 || a.symbol.length > 13 || a.uri.length > 200) throw new Error("create_v2: name 32, symbol 13, uri 200 at most");
  const curve = pumpPdas.bondingCurve(a.mint);
  const keys = [
    w(a.mint, true), r(pumpPdas.mintAuthority()), w(curve), w(ata(curve, a.mint, TOKEN_2022_PROGRAM)), r(PUMP.global), w(a.user, true),
    r(SYSTEM_PROGRAM), r(TOKEN_2022_PROGRAM), r(ASSOCIATED_TOKEN_PROGRAM), w(PUMP.mayhem), r(pumpPdas.mayhemGlobalParams()),
    w(pumpPdas.mayhemSolVault()), w(pumpPdas.mayhemState(a.mint)), w(ata(pumpPdas.mayhemSolVault(), a.mint, TOKEN_2022_PROGRAM)),
    r(PUMP.eventAuthority), r(PUMP.program),
  ];
  if (a.quote.kind === "pumpCoin") {
    const q = a.quote, qtp = q.tokenProgram ?? TOKEN_2022_PROGRAM;
    keys.push(r(q.mint), w(ata(curve, q.mint, qtp)), r(qtp), r(PUMP.quoteControl), r(pumpPdas.bondingCurve(q.mint)));
    if (q.pool) keys.push(r(q.pool.pool), r(q.pool.baseVault), r(q.pool.quoteVault));
  }
  const data = new Writer().bytes(ixDisc("create_v2")).string(a.name).string(a.symbol).string(a.uri).address(a.creator).bool(false);
  optBool(data, false);
  data.u64(a.creatorFeeBps ?? 0n);
  optBool(data, false);
  return { programId: PUMP.program, keys, data: data.done() };
}

export interface CurveTradeAccounts {
  mint: Address;
  quoteMint: Address;
  user: Address;
  quoteTokenProgram?: Address;
  /** Defaults to the user's ATAs. */
  userBase?: Address;
  userQuote?: Address;
  /** Index into PUMP.buybackRecipients (default 0, the one SDKs use for token quotes). */
  buyback?: number;
}
function curveTradeKeys(a: CurveTradeAccounts) {
  const qtp = tokenProgramOf(a.quoteMint, a.quoteTokenProgram);
  const curve = pumpPdas.bondingCurve(a.mint);
  const bb = PUMP.buybackRecipients[a.buyback ?? 0]!;
  const buyback = a.quoteMint === PUMP.wsol ? bb : ata(bb, a.quoteMint, qtp);
  return [
    r(PUMP.global), r(a.mint), r(a.quoteMint), r(TOKEN_2022_PROGRAM), r(qtp), w(curve), w(ata(curve, a.mint, TOKEN_2022_PROGRAM)),
    w(ata(curve, a.quoteMint, qtp)), w(a.user, true), w(a.userBase ?? ata(a.user, a.mint, TOKEN_2022_PROGRAM)),
    w(a.userQuote ?? ata(a.user, a.quoteMint, qtp)), w(pumpPdas.userVolume(a.user)), r(PUMP.feeConfig), w(buyback), r(SYSTEM_PROGRAM),
    r(PUMP.eventAuthority), r(PUMP.program),
  ];
}
/** The buyback recipient account a trade pays: the wallet for a SOL quote, its quote ATA otherwise (must exist). */
export function buybackAccount(quoteMint: Address, quoteTokenProgram?: Address, index = 0): Address {
  const bb = PUMP.buybackRecipients[index]!;
  return quoteMint === PUMP.wsol ? bb : ata(bb, quoteMint, tokenProgramOf(quoteMint, quoteTokenProgram));
}

export const pump = {
  createV2,
  /** Exact base out; `maxQuoteIn` covers fees and both legs of a synthetic migration. The user's base ATA must exist. */
  buyV3(a: CurveTradeAccounts & { amount: bigint; maxQuoteIn: bigint }): Ix {
    return { programId: PUMP.program, keys: curveTradeKeys(a), data: new Writer().bytes(ixDisc("buy_v3")).u64(a.amount).u64(a.maxQuoteIn).u8(0).done() };
  },
  buyExactQuoteInV3(a: CurveTradeAccounts & { spendableQuoteIn: bigint; minTokensOut: bigint }): Ix {
    return { programId: PUMP.program, keys: curveTradeKeys(a),
      data: new Writer().bytes(ixDisc("buy_exact_quote_in_v3")).u64(a.spendableQuoteIn).u64(a.minTokensOut).u8(0).done() };
  },
  sellV3(a: CurveTradeAccounts & { amount: bigint; minQuoteOut: bigint }): Ix {
    return { programId: PUMP.program, keys: curveTradeKeys(a), data: new Writer().bytes(ixDisc("sell_v3")).u64(a.amount).u64(a.minQuoteOut).done() };
  },
  /** Permissionless: the curve's waiting creator fee to the creator vault (creates the vault's quote ATA, paid by `payer`). */
  sweepCreatorFee(a: { payer: Address; mint: Address; quoteMint: Address; creator: Address; quoteTokenProgram?: Address }): Ix {
    const qtp = tokenProgramOf(a.quoteMint, a.quoteTokenProgram);
    const curve = pumpPdas.bondingCurve(a.mint), vault = pumpPdas.creatorVault(a.creator);
    return {
      programId: PUMP.program,
      keys: [w(a.payer, true), r(PUMP.global), r(a.mint), r(a.quoteMint), r(qtp), r(ASSOCIATED_TOKEN_PROGRAM), r(SYSTEM_PROGRAM), w(curve),
        w(ata(curve, a.quoteMint, qtp)), w(vault), w(ata(vault, a.quoteMint, qtp)), r(PUMP.eventAuthority), r(PUMP.program)],
      data: ixDisc("sweep_creator_fee"),
    };
  },
  /** Permissionless: the creator vault's quote tokens to the creator's quote ATA (must exist). */
  collectCreatorFeeV2(a: { creator: Address; quoteMint: Address; quoteTokenProgram?: Address }): Ix {
    const qtp = tokenProgramOf(a.quoteMint, a.quoteTokenProgram), vault = pumpPdas.creatorVault(a.creator);
    return {
      programId: PUMP.program,
      keys: [w(a.creator), w(ata(a.creator, a.quoteMint, qtp)), w(vault), w(ata(vault, a.quoteMint, qtp)), r(a.quoteMint), r(qtp),
        r(ASSOCIATED_TOKEN_PROGRAM), r(SYSTEM_PROGRAM), r(PUMP.eventAuthority), r(PUMP.program)],
      data: ixDisc("collect_creator_fee_v2"),
    };
  },
  /** Permissionless once the curve is complete: creates the canonical PumpSwap pool (LP burnt). */
  migrateV2(a: { user: Address; mint: Address; quoteMint: Address; withdrawAuthority: Address; quoteTokenProgram?: Address }): Ix {
    const qtp = tokenProgramOf(a.quoteMint, a.quoteTokenProgram);
    const curve = pumpPdas.bondingCurve(a.mint), pa = pumpPdas.poolAuthority(a.mint), pool = pumpPdas.pool(a.mint, a.quoteMint);
    const lp = pumpPdas.lpMint(pool);
    return {
      programId: PUMP.program,
      keys: [r(PUMP.global), w(a.withdrawAuthority), r(a.mint), r(a.quoteMint), w(curve), w(ata(curve, a.mint, TOKEN_2022_PROGRAM)),
        w(ata(curve, a.quoteMint, qtp)), w(a.user, true), r(SYSTEM_PROGRAM), r(PUMP.amm), w(pool), w(pa), w(ata(pa, a.mint, TOKEN_2022_PROGRAM)),
        w(ata(pa, a.quoteMint, qtp)), r(PUMP.ammGlobalConfig), w(lp), w(ata(pa, lp, TOKEN_2022_PROGRAM)), w(ata(pool, a.mint, TOKEN_2022_PROGRAM)),
        w(ata(pool, a.quoteMint, qtp)), r(TOKEN_2022_PROGRAM), r(qtp), r(TOKEN_2022_PROGRAM), r(ASSOCIATED_TOKEN_PROGRAM),
        r(pumpPdas.ammEventAuthority()), r("SysvarRent111111111111111111111111111111111"), r(PUMP.eventAuthority), r(PUMP.program),
        // remaining: the pool's boost vault authority and its quote ATA (not in the docs; pump-sdk 4.0.0 migrateV2Instruction)
        r(pumpPdas.boostVault(pool)), w(ata(pumpPdas.boostVault(pool), a.quoteMint, qtp))],
      data: ixDisc("migrate_v2"),
    };
  },
};

export interface PoolTradeAccounts {
  pool: Address;
  mint: Address;
  quoteMint: Address;
  user: Address;
  quoteTokenProgram?: Address;
  userBase?: Address;
  userQuote?: Address;
  buyback?: number;
}
function poolTradeKeys(a: PoolTradeAccounts) {
  const qtp = tokenProgramOf(a.quoteMint, a.quoteTokenProgram);
  return [
    w(a.pool), w(a.user, true), r(PUMP.ammGlobalConfig), r(a.mint), r(a.quoteMint), w(a.userBase ?? ata(a.user, a.mint, TOKEN_2022_PROGRAM)),
    w(a.userQuote ?? ata(a.user, a.quoteMint, qtp)), w(ata(a.pool, a.mint, TOKEN_2022_PROGRAM)), w(ata(a.pool, a.quoteMint, qtp)),
    r(TOKEN_2022_PROGRAM), r(qtp), r(SYSTEM_PROGRAM), w(pumpPdas.ammUserVolume(a.user)), r(PUMP.ammFeeConfig),
    w(ata(PUMP.buybackRecipients[a.buyback ?? 0]!, a.quoteMint, qtp)), r(pumpPdas.ammEventAuthority()), r(PUMP.amm),
  ];
}

/** One hop of `multi_hop_swap`: a pump coin's curve, or its canonical pool. */
export type Hop = { kind: "curve"; mint: Address; quoteMint: Address; quoteTokenProgram?: Address } | { kind: "pool"; mint: Address; quoteMint: Address; pool: Address; quoteTokenProgram?: Address };
function hopKeys(h: Hop) {
  const qtp = tokenProgramOf(h.quoteMint, h.quoteTokenProgram);
  if (h.kind === "pool") return [r(h.mint), r(h.quoteMint), w(h.pool), w(ata(h.pool, h.mint, TOKEN_2022_PROGRAM)), w(ata(h.pool, h.quoteMint, qtp))];
  const curve = pumpPdas.bondingCurve(h.mint);
  return [r(h.mint), r(h.quoteMint), w(curve), w(ata(curve, h.mint, TOKEN_2022_PROGRAM)), w(ata(curve, h.quoteMint, qtp))];
}

export const pumpAmm = {
  buyV2(a: PoolTradeAccounts & { baseOut: bigint; maxQuoteIn: bigint }): Ix {
    return { programId: PUMP.amm, keys: poolTradeKeys(a), data: new Writer().bytes(ixDisc("buy_v2")).u64(a.baseOut).u64(a.maxQuoteIn).done() };
  },
  buyExactQuoteInV2(a: PoolTradeAccounts & { spendableQuoteIn: bigint; minBaseOut: bigint }): Ix {
    return { programId: PUMP.amm, keys: poolTradeKeys(a),
      data: new Writer().bytes(ixDisc("buy_exact_quote_in_v2")).u64(a.spendableQuoteIn).u64(a.minBaseOut).done() };
  },
  sellV2(a: PoolTradeAccounts & { baseIn: bigint; minQuoteOut: bigint }): Ix {
    return { programId: PUMP.amm, keys: poolTradeKeys(a), data: new Writer().bytes(ixDisc("sell_v2")).u64(a.baseIn).u64(a.minQuoteOut).done() };
  },
  /**
   * MULTI_HOP_SWAP.md: exact in, one direction. `buybackQuoteMint` is the quote of the hop that trades
   * the user's own currency (WSOL on a SOL route). Both user token accounts must exist.
   */
  multiHopSwap(a: { user: Address; userIn: Address; userOut: Address; hops: Hop[]; amountIn: bigint; minOut: bigint; buybackQuoteMint: Address;
    buybackQuoteTokenProgram?: Address; buyback?: number }): Ix {
    const bb = ata(PUMP.buybackRecipients[a.buyback ?? 0]!, a.buybackQuoteMint, tokenProgramOf(a.buybackQuoteMint, a.buybackQuoteTokenProgram));
    return {
      programId: PUMP.amm,
      keys: [w(a.user, true), w(a.userIn), w(a.userOut), r(PUMP.ammGlobalConfig), r(PUMP.ammFeeConfig), w(pumpPdas.ammUserVolume(a.user)), w(bb),
        r(TOKEN_PROGRAM), r(TOKEN_2022_PROGRAM), r(SYSTEM_PROGRAM), r(pumpPdas.ammEventAuthority()), r(PUMP.amm), r(PUMP.program), r(PUMP.global),
        r(PUMP.feeConfig), r(PUMP.eventAuthority), ...a.hops.flatMap(hopKeys)],
      data: new Writer().bytes(ixDisc("multi_hop_swap")).u64(a.amountIn).u64(a.minOut).done(),
    };
  },
  /** Permissionless: the pool's waiting creator fee to ["creator_vault", coin_creator]'s quote ATA (created if missing). */
  sweepCreatorFee(a: { payer: Address; pool: Address; quoteMint: Address; coinCreator: Address; quoteTokenProgram?: Address }): Ix {
    const qtp = tokenProgramOf(a.quoteMint, a.quoteTokenProgram), vault = pumpPdas.ammCreatorVault(a.coinCreator);
    return {
      programId: PUMP.amm,
      keys: [w(a.payer, true), r(PUMP.ammGlobalConfig), w(a.pool), r(a.quoteMint), r(qtp), w(ata(a.pool, a.quoteMint, qtp)), r(vault),
        w(ata(vault, a.quoteMint, qtp)), r(SYSTEM_PROGRAM), r(ASSOCIATED_TOKEN_PROGRAM), r(pumpPdas.ammEventAuthority()), r(PUMP.amm)],
      data: ixDisc("sweep_creator_fee"),
    };
  },
  /** Permissionless: the AMM creator vault's quote tokens to `dest`, a quote token account owned by `coinCreator` (default its ATA). */
  collectCoinCreatorFee(a: { coinCreator: Address; quoteMint: Address; quoteTokenProgram?: Address; dest?: Address }): Ix {
    const qtp = tokenProgramOf(a.quoteMint, a.quoteTokenProgram), vault = pumpPdas.ammCreatorVault(a.coinCreator);
    return {
      programId: PUMP.amm,
      keys: [r(a.quoteMint), r(qtp), r(a.coinCreator), r(vault), w(ata(vault, a.quoteMint, qtp)), w(a.dest ?? ata(a.coinCreator, a.quoteMint, qtp)),
        r(pumpPdas.ammEventAuthority()), r(PUMP.amm)],
      data: ixDisc("collect_coin_creator_fee"),
    };
  },
};

/** Every sweep and collect that moves an agent coin's creator fees into its creator's quote ATA, in order (SWEEP_FEES.md). */
export function creatorFeeHarvest(a: { payer: Address; mint: Address; creator: Address; quoteMint: Address; pool?: Address; quoteTokenProgram?: Address }): Ix[] {
  const out = [pump.sweepCreatorFee(a), pump.collectCreatorFeeV2(a)];
  if (a.pool) out.push(pumpAmm.sweepCreatorFee({ payer: a.payer, pool: a.pool, quoteMint: a.quoteMint, coinCreator: a.creator, quoteTokenProgram: a.quoteTokenProgram }),
    pumpAmm.collectCoinCreatorFee({ coinCreator: a.creator, quoteMint: a.quoteMint, quoteTokenProgram: a.quoteTokenProgram }));
  return out;
}

// ---------- events (emitted by self-CPI: 8-byte event-CPI tag, 8-byte event discriminator, borsh) ----------

const EVENT_IX_TAG = Uint8Array.of(0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d);
type F = "pubkey" | "u64" | "i64" | "bool" | "u8" | "string" | "i128" | "shareholders";
const EVENTS: Record<string, [string, F][]> = {
  TradeEvent: [["mint", "pubkey"], ["sol_amount", "u64"], ["token_amount", "u64"], ["is_buy", "bool"], ["user", "pubkey"], ["timestamp", "i64"],
    ["virtual_sol_reserves", "u64"], ["virtual_token_reserves", "u64"], ["real_sol_reserves", "u64"], ["real_token_reserves", "u64"],
    ["fee_recipient", "pubkey"], ["fee_basis_points", "u64"], ["fee", "u64"], ["creator", "pubkey"], ["creator_fee_basis_points", "u64"],
    ["creator_fee", "u64"], ["track_volume", "bool"], ["total_unclaimed_tokens", "u64"], ["total_claimed_tokens", "u64"], ["current_sol_volume", "u64"],
    ["last_update_timestamp", "i64"], ["ix_name", "string"], ["mayhem_mode", "bool"], ["cashback_fee_basis_points", "u64"], ["cashback", "u64"],
    ["buyback_fee_basis_points", "u64"], ["buyback_fee", "u64"], ["shareholders", "shareholders"], ["quote_mint", "pubkey"], ["quote_amount", "u64"],
    ["virtual_quote_reserves", "u64"], ["real_quote_reserves", "u64"], ["holder_rewards_bps", "u64"], ["holder_rewards", "u64"],
    ["creator_fee_unclaimed", "u64"]],
  CreateEvent: [["name", "string"], ["symbol", "string"], ["uri", "string"], ["mint", "pubkey"], ["bonding_curve", "pubkey"], ["user", "pubkey"],
    ["creator", "pubkey"], ["timestamp", "i64"], ["virtual_token_reserves", "u64"], ["virtual_sol_reserves", "u64"], ["real_token_reserves", "u64"],
    ["token_total_supply", "u64"], ["token_program", "pubkey"], ["is_mayhem_mode", "bool"], ["is_cashback_enabled", "bool"], ["quote_mint", "pubkey"],
    ["virtual_quote_reserves", "u64"], ["creator_fee_bps", "u64"], ["is_holder_reward", "bool"], ["depth", "u8"]],
  CompleteEvent: [["user", "pubkey"], ["mint", "pubkey"], ["bonding_curve", "pubkey"], ["timestamp", "i64"], ["quote_mint", "pubkey"]],
  PostCompleteBuyEvent: [["user", "pubkey"], ["mint", "pubkey"], ["bonding_curve", "pubkey"], ["quote_mint", "pubkey"], ["timestamp", "i64"],
    ["base_out", "u64"], ["quote_in", "u64"], ["fee_basis_points", "u64"], ["fee", "u64"], ["creator_fee_basis_points", "u64"], ["creator_fee", "u64"],
    ["buyback_fee", "u64"], ["pool_base_reserves_before", "u64"], ["pool_quote_reserves_before", "u64"], ["pool_base_reserves_after", "u64"],
    ["pool_quote_reserves_after", "u64"]],
  SweepBondingCurveFeeEvent: [["timestamp", "i64"], ["mint", "pubkey"], ["bonding_curve", "pubkey"], ["quote_mint", "pubkey"], ["recipient", "pubkey"],
    ["amount", "u64"], ["bucket", "u8"]],
  CollectCreatorFeeEvent: [["timestamp", "i64"], ["creator", "pubkey"], ["creator_fee", "u64"], ["quote_mint", "pubkey"]],
  BuyEvent: [["timestamp", "i64"], ["base_amount_out", "u64"], ["max_quote_amount_in", "u64"], ["user_base_token_reserves", "u64"],
    ["user_quote_token_reserves", "u64"], ["pool_base_token_reserves", "u64"], ["pool_quote_token_reserves", "u64"], ["quote_amount_in", "u64"],
    ["lp_fee_basis_points", "u64"], ["lp_fee", "u64"], ["protocol_fee_basis_points", "u64"], ["protocol_fee", "u64"], ["quote_amount_in_with_lp_fee", "u64"],
    ["user_quote_amount_in", "u64"], ["pool", "pubkey"], ["user", "pubkey"], ["user_base_token_account", "pubkey"], ["user_quote_token_account", "pubkey"],
    ["protocol_fee_recipient", "pubkey"], ["protocol_fee_recipient_token_account", "pubkey"], ["coin_creator", "pubkey"],
    ["coin_creator_fee_basis_points", "u64"], ["coin_creator_fee", "u64"], ["track_volume", "bool"], ["total_unclaimed_tokens", "u64"],
    ["total_claimed_tokens", "u64"], ["current_sol_volume", "u64"], ["last_update_timestamp", "i64"], ["min_base_amount_out", "u64"], ["ix_name", "string"],
    ["cashback_fee_basis_points", "u64"], ["cashback", "u64"], ["buyback_fee_basis_points", "u64"], ["buyback_fee", "u64"], ["virtual_quote_reserves", "i128"],
    ["can_boost", "bool"], ["base_supply", "u64"], ["holder_rewards_bps", "u64"], ["holder_rewards", "u64"], ["creator_fee_unclaimed", "u64"]],
  SellEvent: [["timestamp", "i64"], ["base_amount_in", "u64"], ["min_quote_amount_out", "u64"], ["user_base_token_reserves", "u64"],
    ["user_quote_token_reserves", "u64"], ["pool_base_token_reserves", "u64"], ["pool_quote_token_reserves", "u64"], ["quote_amount_out", "u64"],
    ["lp_fee_basis_points", "u64"], ["lp_fee", "u64"], ["protocol_fee_basis_points", "u64"], ["protocol_fee", "u64"],
    ["quote_amount_out_without_lp_fee", "u64"], ["user_quote_amount_out", "u64"], ["pool", "pubkey"], ["user", "pubkey"], ["user_base_token_account", "pubkey"],
    ["user_quote_token_account", "pubkey"], ["protocol_fee_recipient", "pubkey"], ["protocol_fee_recipient_token_account", "pubkey"], ["coin_creator", "pubkey"],
    ["coin_creator_fee_basis_points", "u64"], ["coin_creator_fee", "u64"], ["cashback_fee_basis_points", "u64"], ["cashback", "u64"],
    ["buyback_fee_basis_points", "u64"], ["buyback_fee", "u64"], ["virtual_quote_reserves", "i128"], ["can_boost", "bool"], ["base_supply", "u64"],
    ["holder_rewards_bps", "u64"], ["holder_rewards", "u64"], ["creator_fee_unclaimed", "u64"]],
  SweepPoolFeeEvent: [["timestamp", "i64"], ["pool", "pubkey"], ["base_mint", "pubkey"], ["quote_mint", "pubkey"], ["recipient", "pubkey"], ["payer", "pubkey"],
    ["amount", "u64"], ["bucket", "u8"]],
  CollectCoinCreatorFeeEvent: [["timestamp", "i64"], ["coin_creator", "pubkey"], ["coin_creator_fee", "u64"], ["coin_creator_vault_ata", "pubkey"],
    ["coin_creator_token_account", "pubkey"]],
};
const EVENT_DISC = new Map(Object.keys(EVENTS).map((n) => [bytesToHex(sha256(`event:${n}`).subarray(0, 8)), n]));

export type PumpEvent = { name: string; fields: Record<string, bigint | string | boolean | number> };
/**
 * Decodes one inner instruction's data as a Pump or PumpSwap event (the event-CPI self call), or
 * null. Fields keep their IDL names; integers are bigint. Trailing fields an older event lacks are
 * left out.
 */
export function decodePumpEvent(data: Uint8Array): PumpEvent | null {
  if (data.length < 16 || !EVENT_IX_TAG.every((b, i) => data[i] === b)) return null;
  const name = EVENT_DISC.get(bytesToHex(data.subarray(8, 16)));
  if (!name) return null;
  const x = new Reader(data.subarray(16));
  const fields: PumpEvent["fields"] = {};
  for (const [k, t] of EVENTS[name]!) {
    if (x.remaining() <= 0) break;
    if (t === "pubkey") fields[k] = x.address();
    else if (t === "u64") fields[k] = x.u64();
    else if (t === "i64") fields[k] = x.i64();
    else if (t === "bool") fields[k] = x.bool();
    else if (t === "u8") fields[k] = x.u8();
    else if (t === "string") fields[k] = x.string();
    else if (t === "i128") fields[k] = BigInt.asIntN(128, x.u128());
    else { const n = x.u32(); for (let i = 0; i < n; i++) { x.address(); x.u16(); } fields[k] = n; }
  }
  return { name, fields };
}

/** Whether an account's data starts with the Anchor discriminator of `name`. */
export const hasDisc = (d: Uint8Array, name: string) => accountDisc(name).every((b, i) => d[i] === b);
export const toAddr = toAddress;

/**
 * Accounts every agent-coin launch on pump.fun names that are neither signers nor fresh, for a v0
 * launch transaction's lookup table: Pump's fixed accounts, the $LINE quote accounts (its curve, and
 * its canonical pool and vaults once migrated) and the $LINE buyback recipient account.
 */
export function pumpLaunchTableAddresses(a: { lineMint: Address; linePool?: { pool: Address; baseVault: Address; quoteVault: Address } }): Address[] {
  return [...new Set([PUMP.program, PUMP.global, pumpPdas.mintAuthority(), PUMP.eventAuthority, PUMP.mayhem, pumpPdas.mayhemGlobalParams(), pumpPdas.mayhemSolVault(),
    PUMP.quoteControl, PUMP.feeConfig, a.lineMint, pumpPdas.bondingCurve(a.lineMint), buybackAccount(a.lineMint, TOKEN_2022_PROGRAM), SYSTEM_PROGRAM,
    TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, ...(a.linePool ? [a.linePool.pool, a.linePool.baseVault, a.linePool.quoteVault] : [])])];
}
