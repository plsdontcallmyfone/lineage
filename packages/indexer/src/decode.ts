import { base58Decode } from "@lineage/protocol";
import { decodePumpEvent, ixDisc, LAUNCH_PROGRAM_ID, PUMP, pumpPdas, sha256, toAddress, type Address, type PumpEvent } from "@lineage/chain";

// Decodes one confirmed transaction (getTransaction, encoding "json") into the market records of one
// agent token on pump.fun (owner decisions 2026-10-10, docs/plans/PUMPFUN-LAUNCHES.md 6.6): trades on
// its bonding curve and on its canonical PumpSwap pool, creator fee income and sweeps, units_launch
// fee cranks, and lifecycle events (launch, completion, migration, graduation). Pure: no RPC, so tests
// replay transactions recorded on the mainnet fork.
//
// Trades come from pump.fun's own events (the event-CPI self invocation of Pump and PumpSwap, decoded
// by packages/chain decodePumpEvent): Pump TradeEvent (a completing v3 buy adds its
// PostCompleteBuyEvent), PumpSwap BuyEvent and SellEvent of the token's canonical pool. Only events of
// this token count, so the $LINE hop of a multi_hop_swap is ignored. TradeEvent.ix_name is not read:
// mainnet's build writes "buy" for buy_v3 (packages/chain/test/pump.test.ts).
//
// Amounts the trader paid (buy) or got (sell), in $LINE base units: curve trades quote_amount plus (buy)
// or minus (sell) the protocol and creator fee; a completing buy adds its pool leg's quote_in and fees;
// pool buys the larger of user_quote_amount_in (an exact-out buy: net plus every fee) and
// quote_amount_in (an exact-in buy such as a multi-hop leg: the whole budget); pool sells
// user_quote_amount_out. Each is checked against the trader's token balance deltas in
// test/decode.test.ts. Creator fee income is counted at the trade (creator_fee, coin_creator_fee);
// sweeps (bucket 1) are payouts, recorded apart and never added to income.

export { LAUNCH_PROGRAM_ID };

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** Anchor's emit_cpi tag: sha256("anchor:event")[..8], reversed. */
export const EVENT_IX_TAG = "e445a52e51cb9a1d";
const EV = {
  feesCranked: hex(sha256("event:FeesCranked").subarray(0, 8)),
  pumpGraduated: hex(sha256("event:PumpGraduated").subarray(0, 8)),
  pumpLaunched: hex(sha256("event:PumpLaunched").subarray(0, 8)),
};
const MIGRATE_V2 = hex(ixDisc("migrate_v2"));
const AMM_EVENT_AUTHORITY = pumpPdas.ammEventAuthority();

/** The subset of getTransaction (encoding "json") the decoder reads. */
export interface RawTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: { programIdIndex: number; accounts: number[]; data: string }[];
    };
  };
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] | null;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}
interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** What the decoder knows about one agent token. */
export interface TokenCtx {
  mint: Address;
  lineMint: Address;
  /** Pump bonding curve PDA of the mint. */
  curve: Address;
  /** The canonical PumpSwap pool PDA of the mint quoted in $LINE (whether or not it exists yet). */
  pool: Address;
  baseDecimals: number;
  quoteDecimals: number;
  /** units_launch's id (default: the active profile's). */
  launchProgram?: Address;
}

export type Venue = "curve" | "pool";
export interface Trade {
  sig: string;
  idx: number;
  slot: number;
  time: number | null;
  venue: Venue;
  side: "buy" | "sell";
  /** Agent token base units the trader got (buy) or gave (sell). */
  baseRaw: bigint;
  /** $LINE base units the trader paid (buy, fees included) or got (sell, net of fees). */
  quoteRaw: bigint;
  /** $LINE per agent token, from the two amounts. */
  price: number;
  /** Curve price after the trade from the event's virtual reserves (curve trades), else null. */
  spotAfter: number | null;
  /** Every fee the trade charged (protocol, creator, LP), $LINE base units. */
  feeRaw: bigint;
  /** The creator fee the trade charged (income of the agent's creator PDA). */
  creatorFeeRaw: bigint;
  trader: Address;
  /** Always "event": amounts come from pump.fun's own events. */
  source: "event";
  /** Set on a curve buy that crossed the curve's end (synthetic migration). */
  completing: boolean;
}
export interface FeeCrank {
  sig: string;
  idx: number;
  slot: number;
  time: number | null;
  feesRaw: bigint;
  toComputeRaw: bigint;
  toProtocolRaw: bigint;
  poolFees: boolean;
  balanceRaw: bigint;
  awake: boolean;
}
/** A pump.fun sweep of the creator fee bucket (a payout to the creator's vault, not income). */
export interface Sweep {
  sig: string;
  idx: number;
  slot: number;
  time: number | null;
  venue: Venue;
  amountRaw: bigint;
  recipient: Address;
}
export interface LifeEvent {
  sig: string;
  slot: number;
  time: number | null;
  kind: "launch" | "complete" | "migration" | "graduated";
  detail: Record<string, string>;
}
export interface Decoded {
  sig: string;
  slot: number;
  time: number | null;
  failed: boolean;
  trades: Trade[];
  fees: FeeCrank[];
  sweeps: Sweep[];
  events: LifeEvent[];
  /** Post-transaction balance of every token account of the agent mint the transaction touched. */
  balances: { account: Address; owner: Address; amountRaw: bigint }[];
}

interface FlatIx {
  program: Address;
  accounts: Address[];
  data: Uint8Array;
}

export function amountsToPrice(baseRaw: bigint, quoteRaw: bigint, baseDecimals: number, quoteDecimals: number): number {
  if (baseRaw === 0n) return 0;
  return (Number(quoteRaw) / 10 ** quoteDecimals) / (Number(baseRaw) / 10 ** baseDecimals);
}

const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(o, true);
const key = (d: Uint8Array, o: number) => toAddress(d.subarray(o, o + 32));

/** units_launch FeesCranked (onchain/programs/units-launch/src/lib.rs). */
export function decodeFeesCranked(b: Uint8Array) {
  return {
    agent: key(b, 0), mint: key(b, 32), fees: u64(b, 64), toCompute: u64(b, 72), toProtocol: u64(b, 80), poolFees: b[88] === 1,
    balance: u64(b, 89), awake: b[97] === 1,
  };
}

function flatten(tx: RawTx, keys: Address[]): FlatIx[] {
  const m = tx.transaction.message;
  const inner = new Map<number, { programIdIndex: number; accounts: number[]; data: string }[]>();
  for (const g of tx.meta?.innerInstructions ?? []) inner.set(g.index, g.instructions);
  const out: FlatIx[] = [];
  const add = (ix: { programIdIndex: number; accounts: number[]; data: string }) =>
    out.push({ program: keys[ix.programIdIndex]!, accounts: ix.accounts.map((i) => keys[i]!), data: base58Decode(ix.data) });
  m.instructions.forEach((ix, i) => {
    add(ix);
    for (const x of inner.get(i) ?? []) add(x);
  });
  return out;
}

export function accountKeys(tx: RawTx): Address[] {
  const la = tx.meta?.loadedAddresses;
  return [...tx.transaction.message.accountKeys, ...(la?.writable ?? []), ...(la?.readonly ?? [])];
}

/** Token balance delta (post minus pre, base units) of every token account in the transaction. */
export function tokenDeltas(tx: RawTx, keys: Address[]): Map<Address, { mint: string; owner?: string; delta: bigint }> {
  const out = new Map<Address, { mint: string; owner?: string; delta: bigint }>();
  for (const b of tx.meta?.preTokenBalances ?? []) {
    out.set(keys[b.accountIndex]!, { mint: b.mint, owner: b.owner, delta: -BigInt(b.uiTokenAmount.amount) });
  }
  for (const b of tx.meta?.postTokenBalances ?? []) {
    const k = keys[b.accountIndex]!;
    const cur = out.get(k);
    out.set(k, { mint: b.mint, owner: b.owner ?? cur?.owner, delta: (cur?.delta ?? 0n) + BigInt(b.uiTokenAmount.amount) });
  }
  return out;
}

/**
 * Every "Program data:" log line (Anchor emit!) logged by `program` itself, base64-decoded. The
 * invoke stack is tracked from the runtime's "Program X invoke [n]" / "success" / "failed" lines, so
 * a line some other program logged (any program can log any bytes, audit A2 OFF-I1) is ignored.
 */
export function programData(logs: string[], program: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const stack: string[] = [];
  for (const l of logs) {
    const inv = /^Program (\S+) invoke \[\d+\]$/.exec(l);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    if (/^Program \S+ (success|failed)/.test(l)) {
      stack.pop();
      continue;
    }
    if (!l.startsWith("Program data: ") || stack[stack.length - 1] !== program) continue;
    try {
      out.push(new Uint8Array(Buffer.from(l.slice(14).trim(), "base64")));
    } catch {
      /* not base64 */
    }
  }
  return out;
}

/**
 * pump.fun's events in instruction order. Only the event-CPI self invocation counts: the instruction
 * must be the emitting program calling itself with its own event authority as the only account, so
 * bytes another program passes cannot forge an event (the same rule as programData for logs).
 */
export function pumpEvents(ixs: FlatIx[]): { program: Address; e: PumpEvent }[] {
  const out: { program: Address; e: PumpEvent }[] = [];
  const authority: Record<string, string> = { [PUMP.program]: PUMP.eventAuthority, [PUMP.amm]: AMM_EVENT_AUTHORITY };
  for (const x of ixs) {
    if ((x.program !== PUMP.program && x.program !== PUMP.amm) || hex(x.data.subarray(0, 8)) !== EVENT_IX_TAG) continue;
    if (x.accounts[0] !== authority[x.program]) continue;
    const e = decodePumpEvent(x.data);
    if (e) out.push({ program: x.program, e });
  }
  return out;
}

const big = (v: unknown) => (typeof v === "bigint" ? v : 0n);

export function decodeTx(tx: RawTx, ctx: TokenCtx): Decoded {
  const sig = tx.transaction.signatures[0]!;
  const base: Decoded = { sig, slot: tx.slot, time: tx.blockTime ?? null, failed: tx.meta?.err != null, trades: [], fees: [], sweeps: [], events: [], balances: [] };
  if (!tx.meta || base.failed) return base;
  const keys = accountKeys(tx);
  const ixs = flatten(tx, keys);
  const price = (b: bigint, q: bigint) => amountsToPrice(b, q, ctx.baseDecimals, ctx.quoteDecimals);

  let idx = 0;
  let si = 0;
  let last: Trade | null = null;
  for (const { program, e } of pumpEvents(ixs)) {
    const f = e.fields;
    if (program === PUMP.program && e.name === "TradeEvent" && f.mint === ctx.mint) {
      const buy = f.is_buy === true;
      const q = big(f.quote_amount) || big(f.sol_amount);
      const fee = big(f.fee), cf = big(f.creator_fee);
      const baseRaw = big(f.token_amount);
      const quoteRaw = buy ? q + fee + cf : q - fee - cf;
      const vq = big(f.virtual_quote_reserves) || big(f.virtual_sol_reserves), vt = big(f.virtual_token_reserves);
      last = { sig, idx: idx++, slot: tx.slot, time: base.time, venue: "curve", side: buy ? "buy" : "sell", baseRaw, quoteRaw, price: price(baseRaw, quoteRaw),
        spotAfter: vt > 0n ? price(vt, vq) : null, feeRaw: fee + cf, creatorFeeRaw: cf, trader: f.user as string, source: "event", completing: false };
      base.trades.push(last);
    } else if (program === PUMP.program && e.name === "PostCompleteBuyEvent" && f.mint === ctx.mint && last && last.venue === "curve" && last.side === "buy") {
      const fee = big(f.fee), cf = big(f.creator_fee);
      last.baseRaw += big(f.base_out);
      last.quoteRaw += big(f.quote_in) + fee + cf;
      last.feeRaw += fee + cf;
      last.creatorFeeRaw += cf;
      last.price = price(last.baseRaw, last.quoteRaw);
      last.completing = true;
      const b = big(f.pool_base_reserves_after), q = big(f.pool_quote_reserves_after);
      last.spotAfter = b > 0n ? price(b, q) : last.spotAfter;
    } else if (program === PUMP.program && e.name === "CompleteEvent" && f.mint === ctx.mint) {
      base.events.push({ sig, slot: tx.slot, time: base.time, kind: "complete", detail: { user: String(f.user) } });
      if (last) last.completing = true;
    } else if (program === PUMP.amm && (e.name === "BuyEvent" || e.name === "SellEvent") && f.pool === ctx.pool) {
      const buy = e.name === "BuyEvent";
      const baseRaw = buy ? big(f.base_amount_out) : big(f.base_amount_in);
      const quoteRaw = buy ? (big(f.user_quote_amount_in) > big(f.quote_amount_in) ? big(f.user_quote_amount_in) : big(f.quote_amount_in)) : big(f.user_quote_amount_out);
      const cf = big(f.coin_creator_fee);
      last = { sig, idx: idx++, slot: tx.slot, time: base.time, venue: "pool", side: buy ? "buy" : "sell", baseRaw, quoteRaw, price: price(baseRaw, quoteRaw),
        spotAfter: null, feeRaw: big(f.lp_fee) + big(f.protocol_fee) + cf, creatorFeeRaw: cf, trader: f.user as string, source: "event", completing: false };
      base.trades.push(last);
    } else if (program === PUMP.program && e.name === "SweepBondingCurveFeeEvent" && f.mint === ctx.mint && f.bucket === 1) {
      base.sweeps.push({ sig, idx: si++, slot: tx.slot, time: base.time, venue: "curve", amountRaw: big(f.amount), recipient: f.recipient as string });
    } else if (program === PUMP.amm && e.name === "SweepPoolFeeEvent" && f.base_mint === ctx.mint && f.pool === ctx.pool && f.bucket === 1) {
      base.sweeps.push({ sig, idx: si++, slot: tx.slot, time: base.time, venue: "pool", amountRaw: big(f.amount), recipient: f.recipient as string });
    }
  }
  for (const t of base.trades) if (t.baseRaw === 0n) t.price = 0;
  base.trades = base.trades.filter((t) => t.baseRaw > 0n);

  // ---- pump.fun's migration of the curve into its PumpSwap pool (migrate_v2 names the mint third) ----
  for (const x of ixs) {
    if (x.program === PUMP.program && hex(x.data.subarray(0, 8)) === MIGRATE_V2 && x.accounts[2] === ctx.mint) {
      base.events.push({ sig, slot: tx.slot, time: base.time, kind: "migration", detail: { pool: ctx.pool } });
      break;
    }
  }

  // ---- units_launch events (Anchor emit! logs) ----
  let fi = 0;
  for (const b of programData(tx.meta.logMessages ?? [], ctx.launchProgram ?? LAUNCH_PROGRAM_ID)) {
    const d = hex(b.subarray(0, 8));
    const g = b.subarray(8);
    if (d === EV.feesCranked && g.length >= 98) {
      const f = decodeFeesCranked(g);
      if (f.mint !== ctx.mint) continue;
      base.fees.push({ sig, idx: fi++, slot: tx.slot, time: base.time, feesRaw: f.fees, toComputeRaw: f.toCompute, toProtocolRaw: f.toProtocol,
        poolFees: f.poolFees, balanceRaw: f.balance, awake: f.awake });
    } else if (d === EV.pumpGraduated && g.length >= 129) {
      if (key(g, 32) !== ctx.mint) continue;
      base.events.push({ sig, slot: tx.slot, time: base.time, kind: "graduated",
        detail: { pool: key(g, 64), coin_creator: key(g, 96), creator_is_ours: String(g[128] === 1) } });
    } else if (d === EV.pumpLaunched && g.length >= 160) {
      if (key(g, 32) !== ctx.mint) continue;
      base.events.push({ sig, slot: tx.slot, time: base.time, kind: "launch",
        detail: { agent: key(g, 0), launcher: key(g, 64), bonding_curve: key(g, 96), pump_creator: key(g, 128) } });
    }
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint === ctx.mint && b.owner) base.balances.push({ account: keys[b.accountIndex]!, owner: b.owner, amountRaw: BigInt(b.uiTokenAmount.amount) });
  }
  return base;
}
