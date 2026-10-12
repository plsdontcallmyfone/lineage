import {
  ata, curveMigrated, poolRates, PUMP, pump, pumpAmm, pumpPdas, quoteCurveBuyExactIn, quotePoolBuyExactIn, system, SYSTEM_PROGRAM,
  seededAddress as chainSeededAddress, token, TOKEN_ACCOUNT_LEN as CHAIN_TOKEN_ACCOUNT_LEN, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, Writer, r, w,
  type Address, type BondingCurve, type Ix, type PumpFeeConfig, type PumpGlobal, type PumpPool,
} from "@units/chain";
import type { KeeperConfig } from "./config.ts";
import { budgetBeforeSlippage } from "./split.ts";
import type { Action } from "./state.ts";

// What the keeper reads from chain before each step, and the instructions of its four transactions.
// Pure: no RPC here. pump.fun's instructions come from packages/chain/src/pump.ts; this file adds the
// System and Token instructions those transactions need around them.
//
// A SOL-paired coin's creator fee (seen on the mainnet fork, scripts/mainnet/fee-keeper-fork.ts):
//   on the curve   it waits in the bonding curve (BondingCurve.creator_fee); Pump `sweep_creator_fee`
//                  moves it to the creator vault ["creator-vault", creator] as lamports and
//                  `collect_creator_fee` pays the creator what the vault holds above its rent-exempt
//                  minimum (the first sweep tops the vault up to that minimum from the payer);
//   in the pool    it waits in the pool (Pool.creator_fees) as wrapped SOL; PumpSwap
//                  `sweep_creator_fee` moves it to the token account of ["creator_vault", creator]
//                  (created on the first sweep, paid by the payer) and `collect_coin_creator_fee`
//                  moves it to a wrapped SOL account of the creator. The keeper gives it a temporary
//                  one (a seeded account made, filled and closed in the same transaction), so the
//                  fee arrives as plain SOL and the creator's own wrapped SOL is never touched.
// What a curve left unswept at migration stays sweepable, so both paths run after graduation.

export type Phase = "curve" | "awaiting_migration" | "pool";

export interface PoolSnapshot {
  address: Address;
  data: PumpPool;
  /** Base and quote vault balances. */
  base: bigint;
  quote: bigint;
  /** Wrapped SOL waiting in the PumpSwap creator vault's token account; null when that account does not exist yet. */
  vaultAta: bigint | null;
  feeConfig: PumpFeeConfig;
}

export interface Snapshot {
  genesis: string;
  /** The creator wallet's lamports. */
  wallet: bigint;
  mint: { program: Address; decimals: number; supply: bigint };
  curve: BondingCurve;
  phase: Phase;
  /** The curve's own $UNITS balance (prices a buy that runs past the curve). */
  curveBase: bigint;
  /** Lamports in the Pump creator vault. */
  vault: bigint;
  /** Rent-exempt minimum of an account without data, and of a token account. */
  rent0: bigint;
  rentToken: bigint;
  global: PumpGlobal;
  feeConfig: PumpFeeConfig;
  pool: PoolSnapshot | null;
  /** The creator wallet's own (associated) $UNITS token account: the owner's coins. Read, never named in a keeper transaction. */
  tokenAta: { address: Address; exists: boolean; amount: bigint };
  /** The keeper's burn account: the only account it buys into and burns from. */
  burnAccount: { address: Address; exists: boolean; amount: bigint };
  /** The compute funding address as it is on chain. */
  compute: { lamports: bigint; owner: Address | null; executable: boolean };
}

export const phaseOf = (c: BondingCurve): Phase => (!c.complete ? "curve" : curveMigrated(c) ? "pool" : "awaiting_migration");

/** The reasons this coin, wallet and config must not be acted on. Empty: go. */
export function refusals(cfg: KeeperConfig, s: Snapshot, o: { signer?: Address | null; mainnetUnitsMint?: Address | null; mainnet: boolean }): string[] {
  const out: string[] = [];
  if (s.curve.creator !== cfg.creator) out.push(`the coin's creator on chain is ${s.curve.creator}, not config.creator ${cfg.creator}`);
  if (s.curve.quoteMint !== SYSTEM_PROGRAM) out.push(`the coin is paired with ${s.curve.quoteMint}, not SOL: this keeper handles a SOL-paired coin only`);
  if (s.mint.program !== TOKEN_2022_PROGRAM && s.mint.program !== TOKEN_PROGRAM) out.push(`config.mint is owned by ${s.mint.program}, not a token program`);
  if (s.phase === "pool") {
    if (!s.pool) out.push("the curve has migrated and its PumpSwap pool could not be read");
    else {
      if (s.pool.data.baseMint !== cfg.mint || s.pool.data.quoteMint !== PUMP.wsol) out.push("the PumpSwap pool is not the config.mint / wrapped SOL pool");
      if (s.pool.data.coinCreator !== cfg.creator) out.push(`the pool's coin creator is ${s.pool.data.coinCreator}, not config.creator`);
    }
  }
  if (s.compute.executable) out.push("config.compute_address is a program");
  if (s.compute.owner !== null && s.compute.owner !== SYSTEM_PROGRAM) out.push(`config.compute_address is an account owned by ${s.compute.owner}, not a wallet: SOL sent there could not be spent`);
  if (o.signer !== undefined && o.signer !== null && o.signer !== cfg.creator) out.push(`the key at config.key_path is ${o.signer}, not config.creator`);
  if (s.tokenAta.amount < cfg.protected_units)
    out.push(`the wallet's own $UNITS token account ${s.tokenAta.address} holds ${s.tokenAta.amount} base units, under config.protected_units ${cfg.protected_units}: nothing is signed until the owner checks the wallet or changes protected_units`);
  if (o.mainnet && o.mainnetUnitsMint && cfg.mint !== o.mainnetUnitsMint) out.push(`on mainnet config.mint must be the $UNITS mint ${o.mainnetUnitsMint} (config/profile.json)`);
  return out;
}

// ---------- instructions pump.ts and spl.ts do not have ----------

export const TEMP_SEED = "units-fee-keeper";
/**
 * Seed of the keeper's burn account: a $UNITS token account owned by the creator wallet at
 * seededAddress(creator, BURN_SEED, the mint's token program), which is not the wallet's associated
 * token account. Every buy delivers there and every burn takes from there, so the coins in the
 * wallet's own account are never the source of a burn. Pump `buy_v3` and PumpSwap `buy_v2` take any
 * token account of the user at the base position (measured on mainnet's builds of 2026-10-10 in
 * LiteSVM; the fork proof scripts/mainnet/fee-keeper-fork.ts records it when rerun).
 */
export const BURN_SEED = "units-fee-keeper-burn";
export const TOKEN_ACCOUNT_LEN = CHAIN_TOKEN_ACCOUNT_LEN;
export const burnAccountAddress = (creator: Address, tokenProgram: Address): Address => seededAddress(creator, BURN_SEED, tokenProgram);
/** The address System `CreateAccountWithSeed` gives (base, seed, owner). One implementation, in packages/chain/src/spl.ts. */
export const seededAddress = chainSeededAddress;

export const extra = {
  /** System CreateAccountWithSeed, the payer being the base: no second signature. */
  createAccountWithSeed: system.createAccountWithSeed,
  /** Token InitializeAccount3. On the wrapped SOL mint the lamports above rent become the balance. */
  initializeAccount3: (account: Address, mint: Address, owner: Address, tokenProgram: Address): Ix => token.initializeAccount3(account, mint, owner, tokenProgram),
  /** Token CloseAccount: a wrapped SOL account pays out all its lamports. */
  closeAccount: (account: Address, dest: Address, owner: Address, tokenProgram: Address): Ix => token.closeAccount(account, dest, owner, tokenProgram),
  /** Token BurnChecked (SPL Token and Token-2022 share the layout). */
  burnChecked(account: Address, mint: Address, owner: Address, amount: bigint, decimals: number, tokenProgram: Address): Ix {
    return { programId: tokenProgram, keys: [w(account), w(mint), r(owner, true)], data: new Writer().u8(15).u64(amount).u8(decimals).done() };
  },
};

const tempWsol = (creator: Address) => seededAddress(creator, TEMP_SEED, TOKEN_PROGRAM);
/** Opens the temporary wrapped SOL account holding `lamports` of wrapped SOL (0 for an empty one). */
const openTemp = (creator: Address, s: Snapshot, lamports: bigint): Ix[] => [
  extra.createAccountWithSeed(creator, TEMP_SEED, s.rentToken + lamports, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM),
  extra.initializeAccount3(tempWsol(creator), PUMP.wsol, creator, TOKEN_PROGRAM),
];
const closeTemp = (creator: Address): Ix => extra.closeAccount(tempWsol(creator), creator, creator, TOKEN_PROGRAM);

// ---------- what waits, and the collection ----------

export interface Waiting {
  /** In the bonding curve, not swept. */
  curve: bigint;
  /** In the Pump creator vault above its rent-exempt minimum. */
  vault: bigint;
  /** In the PumpSwap pool, not swept. */
  pool: bigint;
  /** In the PumpSwap creator vault's token account. */
  poolVault: bigint;
  total: bigint;
}
/** Creator fees waiting for the wallet, by where they sit. What a collection brings is less by its fee and any rent it pays. */
export function waitingFees(s: Snapshot): Waiting {
  const curve = s.curve.creatorFee;
  const vault = s.vault > s.rent0 ? s.vault - s.rent0 : 0n;
  const pool = s.pool?.data.creatorFees ?? 0n;
  const poolVault = s.pool?.vaultAta ?? 0n;
  return { curve, vault, pool, poolVault, total: curve + vault + pool + poolVault };
}

/** The collection transaction, or null when nothing waits. Only the parts with something to move are included. */
export function collectIxs(cfg: KeeperConfig, s: Snapshot): Ix[] | null {
  const wt = waitingFees(s);
  const ixs: Ix[] = [];
  if (wt.curve > 0n) ixs.push(pump.sweepCreatorFee({ payer: cfg.creator, mint: cfg.mint, quoteMint: PUMP.wsol, creator: cfg.creator, quoteTokenProgram: TOKEN_PROGRAM }));
  if (s.vault + wt.curve > s.rent0) ixs.push(pump.collectCreatorFeeSol({ creator: cfg.creator }));
  if (s.pool && wt.pool + wt.poolVault > 0n) {
    ixs.push(...openTemp(cfg.creator, s, 0n));
    if (wt.pool > 0n) ixs.push(pumpAmm.sweepCreatorFee({ payer: cfg.creator, pool: s.pool.address, quoteMint: PUMP.wsol, coinCreator: cfg.creator, quoteTokenProgram: TOKEN_PROGRAM }));
    ixs.push(pumpAmm.collectCoinCreatorFee({ coinCreator: cfg.creator, quoteMint: PUMP.wsol, quoteTokenProgram: TOKEN_PROGRAM, dest: tempWsol(cfg.creator) }), closeTemp(cfg.creator));
  }
  return ixs.length ? ixs : null;
}

// ---------- the buyback ----------

export type BuyQuote = { ok: true; venue: "curve" | "pool"; tokens: bigint } | { ok: false; reason: string };

/**
 * How many $UNITS base units `budget` lamports buy at the reserves in `s`, sized so the buy still
 * fills when the price is `slippageBps` worse: the transaction asks for exactly this many and caps
 * what it pays at `budget`.
 */
export function quoteBuyback(s: Snapshot, budget: bigint, slippageBps: number): BuyQuote {
  const spend = budgetBeforeSlippage(budget, slippageBps);
  if (s.mint.program !== TOKEN_2022_PROGRAM) return { ok: false, reason: "the mint is not a Token-2022 mint: pump.ts builds trades for create_v2 coins only" };
  if (spend <= 0n) return { ok: false, reason: "the budget buys no whole base unit" };
  if (s.phase === "awaiting_migration") return { ok: false, reason: "the curve is complete and not migrated yet: pump.fun takes no trades until its pool exists" };
  if (s.phase === "curve") {
    const q = quoteCurveBuyExactIn(s.global, s.feeConfig, s.curve, spend, s.curveBase);
    if (q.completes) return { ok: false, reason: "this buy would complete the bonding curve: left to a trader, the buyback resumes on the pool" };
    return q.tokens > 0n ? { ok: true, venue: "curve", tokens: q.tokens } : { ok: false, reason: "the budget buys no whole base unit" };
  }
  const p = s.pool;
  if (!p) return { ok: false, reason: "the PumpSwap pool could not be read" };
  const eff = p.quote + p.data.virtualQuoteReserves;
  if (p.base <= 0n || eff <= 0n) return { ok: false, reason: "the PumpSwap pool holds no reserves" };
  const rates = poolRates({ creatorFeeConfigurable: s.global.creatorFeeConfigurable }, p.feeConfig, p.data, s.mint.supply, eff, p.base);
  const out = quotePoolBuyExactIn(rates, p.data, p.base, p.quote, spend).baseOut;
  return out > 0n ? { ok: true, venue: "pool", tokens: out } : { ok: false, reason: "the budget buys no whole base unit" };
}

/**
 * Buys exactly `tokens` for at most `maxLamports` into the keeper's burn account (created here, once,
 * when missing), and burns them from it in the same transaction when `burn`.
 */
export function buybackIxs(cfg: KeeperConfig, s: Snapshot, a: Extract<Action, { kind: "buyback" }>): Ix[] {
  const ixs: Ix[] = [];
  if (!s.burnAccount.exists) ixs.push(extra.createAccountWithSeed(cfg.creator, BURN_SEED, s.rentToken, TOKEN_ACCOUNT_LEN, s.mint.program),
    extra.initializeAccount3(s.burnAccount.address, cfg.mint, cfg.creator, s.mint.program));
  if (a.venue === "curve") {
    ixs.push(pump.buyV3({ mint: cfg.mint, quoteMint: PUMP.wsol, user: cfg.creator, userBase: s.burnAccount.address, amount: a.tokens, maxQuoteIn: a.maxLamports }));
    if (a.burn) ixs.push(burnIx(cfg, s, a.tokens));
    return ixs;
  }
  if (!s.pool) throw new Error("no pool to buy on");
  ixs.push(...openTemp(cfg.creator, s, a.maxLamports),
    pumpAmm.buyV2({ pool: s.pool.address, mint: cfg.mint, quoteMint: PUMP.wsol, user: cfg.creator, userBase: s.burnAccount.address, userQuote: tempWsol(cfg.creator),
      baseOut: a.tokens, maxQuoteIn: a.maxLamports }));
  if (a.burn) ixs.push(burnIx(cfg, s, a.tokens));
  ixs.push(closeTemp(cfg.creator));
  return ixs;
}

const burnIx = (cfg: KeeperConfig, s: Snapshot, tokens: bigint): Ix => extra.burnChecked(s.burnAccount.address, cfg.mint, cfg.creator, tokens, s.mint.decimals, s.mint.program);

export function actionIxs(cfg: KeeperConfig, s: Snapshot, a: Action): Ix[] {
  if (a.kind === "collect") {
    const ixs = collectIxs(cfg, s);
    if (!ixs) throw new Error("nothing to collect");
    return ixs;
  }
  if (a.kind === "compute") return [system.transfer(cfg.creator, cfg.compute_address, a.lamports)];
  if (a.kind === "buyback") return buybackIxs(cfg, s, a);
  return [burnIx(cfg, s, a.tokens)];
}

/** Accounts a transaction of this kind may create and pay rent for (read before and after to tell rent from spend). */
export function mayCreate(cfg: KeeperConfig, s: Snapshot, a: Action): Address[] {
  if (a.kind !== "buyback") return [];
  return [s.burnAccount.address, a.venue === "curve" ? pumpPdas.userVolume(cfg.creator) : pumpPdas.ammUserVolume(cfg.creator)];
}

export const creatorTokenAta = (cfg: KeeperConfig, tokenProgram: Address) => ata(cfg.creator, cfg.mint, tokenProgram);
