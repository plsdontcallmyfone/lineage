import { base58Decode } from "@lineage/protocol";
import { sha256, toAddress, type Address } from "@lineage/chain";

// Decodes one confirmed transaction (getTransaction, encoding "json") into the market records of one
// agent token: trades on its DBC curve or its DAMM v2 pool, lineage_launch fee cranks, and lifecycle
// events (launch, Meteora migration, graduation). Pure: no RPC, so tests replay recorded devnet
// transactions.
//
// Trade amounts come from the pool vaults' token balance deltas (what the trader actually paid and
// got; Meteora keeps its fees in the vaults until claimed). The swap instruction gives the trader
// and the venue, and Meteora's own swap event (emit_cpi, official IDLs: DBC EvtSwap2, DAMM v2
// EvtSwap2) gives the direction and the pool price after the trade. A transaction with several
// swaps on the same pool takes amounts from the events instead.

export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const LAUNCH_PROGRAM = "8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT";

const disc = (prefix: string, name: string) => sha256(`${prefix}:${name}`).subarray(0, 8);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** Anchor's emit_cpi tag: sha256("anchor:event")[..8], reversed. */
export const EVENT_IX_TAG = "e445a52e51cb9a1d";
const IX = {
  swap: hex(disc("global", "swap")),
  swap2: hex(disc("global", "swap2")),
  swap2Hook: hex(disc("global", "swap2_with_transfer_hook")),
  migrationDammV2: hex(disc("global", "migration_damm_v2")),
  launchAgent: hex(disc("global", "launch_agent")),
  crankFees: hex(disc("global", "crank_fees")),
  crankPoolFees: hex(disc("global", "crank_pool_fees")),
  repointPosition: hex(disc("global", "repoint_position")),
};
const EV = {
  dbcSwap: hex(disc("event", "EvtSwap")),
  swap2: hex(disc("event", "EvtSwap2")), // same name in DBC and DAMM v2
  dbcSwap2Hook: hex(disc("event", "EvtSwap2WithTransferHook")),
  feesCranked: hex(disc("event", "FeesCranked")),
  graduated: hex(disc("event", "Graduated")),
  agentLaunched: hex(disc("event", "AgentLaunched")),
};

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
  dbcPool: Address;
  dbcBaseVault: Address;
  dbcQuoteVault: Address;
  dammPool?: Address | null;
  dammBaseVault?: Address | null;
  dammQuoteVault?: Address | null;
  baseDecimals: number;
  quoteDecimals: number;
}

export type Venue = "dbc" | "damm";
export interface Trade {
  sig: string;
  idx: number;
  slot: number;
  time: number | null;
  venue: Venue;
  side: "buy" | "sell";
  /** Agent token base units the trader got (buy) or gave (sell). */
  baseRaw: bigint;
  /** tLINE base units the trader paid (buy, fee included) or got (sell, net of fee). */
  quoteRaw: bigint;
  /** tLINE per agent token, from the two amounts. */
  price: number;
  /** Pool price after the trade (tLINE per token) from the event's next_sqrt_price, when present. */
  spotAfter: number | null;
  /** Meteora's trading fee on this trade (event), in the fee token's base units, when present. */
  feeRaw: bigint | null;
  trader: Address;
  /** "deltas" (vault balance deltas) or "event" (several swaps in one transaction). */
  source: "deltas" | "event";
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
export interface LifeEvent {
  sig: string;
  slot: number;
  time: number | null;
  kind: "launch" | "migration" | "graduated" | "repointed";
  detail: Record<string, string>;
}
export interface Decoded {
  sig: string;
  slot: number;
  time: number | null;
  failed: boolean;
  trades: Trade[];
  fees: FeeCrank[];
  events: LifeEvent[];
  /** Post-transaction balance of every token account of the agent mint the transaction touched. */
  balances: { account: Address; owner: Address; amountRaw: bigint }[];
}

interface FlatIx {
  program: Address;
  accounts: Address[];
  data: Uint8Array;
}

/** Price of a Q64.64 sqrt price as tokens of quote per token of base, decimals applied. */
export function sqrtPriceToPrice(sqrt: bigint, baseDecimals: number, quoteDecimals: number): number {
  const s = Number(sqrt) / 2 ** 64;
  return s * s * 10 ** (baseDecimals - quoteDecimals);
}
export function amountsToPrice(baseRaw: bigint, quoteRaw: bigint, baseDecimals: number, quoteDecimals: number): number {
  if (baseRaw === 0n) return 0;
  return (Number(quoteRaw) / 10 ** quoteDecimals) / (Number(baseRaw) / 10 ** baseDecimals);
}

const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number) => u64(d, o) | (u64(d, o + 8) << 64n);
const key = (d: Uint8Array, o: number) => toAddress(d.subarray(o, o + 32));

interface SwapEvent {
  program: Address;
  /** "v2" for EvtSwap2 kinds, "v1" for DBC's older EvtSwap (emitted alongside EvtSwap2). */
  kind: "v1" | "v2";
  pool: Address;
  /** true when the trader bought the agent token (quote in). */
  buy: boolean;
  inputRaw: bigint;
  outputRaw: bigint;
  nextSqrtPrice: bigint;
  feeRaw: bigint;
}

/**
 * Meteora swap events (the data of an emit_cpi self-invocation, after the 8-byte tag). Layouts from
 * the official IDLs: DBC 0.2.x EvtSwap2 (pool, config, trade_direction, has_referral,
 * SwapParameters2, SwapResult2, ...) where trade_direction 1 = QuoteToBase; DBC EvtSwap (older);
 * DAMM v2 0.2.5 EvtSwap2 (pool, trade_direction, collect_fee_mode, has_referral, SwapParameters2,
 * SwapResult2, ...) where trade_direction 1 = BtoA and token B is tLINE for every agent pool.
 */
export function decodeSwapEvent(program: Address, ev: Uint8Array): SwapEvent | null {
  const d = hex(ev.subarray(0, 8));
  const b = ev.subarray(8);
  try {
    if (program === DBC_PROGRAM && (d === EV.swap2 || d === EV.dbcSwap2Hook)) {
      const r = 32 + 32 + 1 + 1 + 17;
      return { program, kind: "v2", pool: key(b, 0), buy: b[64] === 1, inputRaw: u64(b, r), outputRaw: u64(b, r + 24), nextSqrtPrice: u128(b, r + 32),
        feeRaw: u64(b, r + 48) };
    }
    if (program === DBC_PROGRAM && d === EV.dbcSwap) {
      const r = 32 + 32 + 1 + 1 + 16;
      return { program, kind: "v1", pool: key(b, 0), buy: b[64] === 1, inputRaw: u64(b, r), outputRaw: u64(b, r + 8), nextSqrtPrice: u128(b, r + 16),
        feeRaw: u64(b, r + 32) };
    }
    if (program === DAMM_V2_PROGRAM && d === EV.swap2) {
      const r = 32 + 1 + 1 + 1 + 17;
      return { program, kind: "v2", pool: key(b, 0), buy: b[32] === 1, inputRaw: u64(b, r), outputRaw: u64(b, r + 24), nextSqrtPrice: u128(b, r + 32),
        feeRaw: u64(b, r + 48) };
    }
  } catch {
    return null;
  }
  return null;
}

/** lineage_launch FeesCranked (onchain/programs/lineage-launch/src/lib.rs). */
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

const isSwapIx = (data: Uint8Array) => {
  const d = hex(data.subarray(0, 8));
  return d === IX.swap || d === IX.swap2 || d === IX.swap2Hook;
};

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

export function decodeTx(tx: RawTx, ctx: TokenCtx): Decoded {
  const sig = tx.transaction.signatures[0]!;
  const base: Decoded = { sig, slot: tx.slot, time: tx.blockTime ?? null, failed: tx.meta?.err != null, trades: [], fees: [], events: [], balances: [] };
  if (!tx.meta || base.failed) return base;
  const keys = accountKeys(tx);
  const ixs = flatten(tx, keys);
  const deltas = tokenDeltas(tx, keys);

  // ---- trades, per venue ----
  const venues: { venue: Venue; program: Address; pool: Address; baseVault: Address; quoteVault: Address; poolIdx: number; payerIdx: number }[] = [
    { venue: "dbc", program: DBC_PROGRAM, pool: ctx.dbcPool, baseVault: ctx.dbcBaseVault, quoteVault: ctx.dbcQuoteVault, poolIdx: 2, payerIdx: 9 },
  ];
  if (ctx.dammPool && ctx.dammBaseVault && ctx.dammQuoteVault) {
    venues.push({ venue: "damm", program: DAMM_V2_PROGRAM, pool: ctx.dammPool, baseVault: ctx.dammBaseVault, quoteVault: ctx.dammQuoteVault, poolIdx: 1,
      payerIdx: 8 });
  }
  let idx = 0;
  for (const v of venues) {
    const swaps = ixs.filter((x) => x.program === v.program && isSwapIx(x.data) && x.accounts[v.poolIdx] === v.pool);
    const events: SwapEvent[] = [];
    for (const x of ixs) {
      if (x.program !== v.program || hex(x.data.subarray(0, 8)) !== EVENT_IX_TAG) continue;
      const e = decodeSwapEvent(v.program, x.data.subarray(8));
      if (e && e.pool === v.pool) events.push(e);
    }
    // DBC emits both EvtSwap and EvtSwap2 for one swap: keep one event per swap, the newer kind first.
    const evs = events.some((e) => e.kind === "v2") ? events.filter((e) => e.kind === "v2") : events;
    if (swaps.length === 0 && evs.length === 0) continue;
    const n = Math.max(swaps.length, evs.length);
    const dBase = deltas.get(v.baseVault)?.delta ?? 0n;
    const dQuote = deltas.get(v.quoteVault)?.delta ?? 0n;
    for (let i = 0; i < n; i++) {
      const ev = evs[i] ?? null;
      const trader = swaps[i]?.accounts[v.payerIdx] ?? keys[0]!;
      let side: "buy" | "sell";
      let baseRaw: bigint;
      let quoteRaw: bigint;
      let source: Trade["source"];
      const oppositeSigns = (dBase < 0n && dQuote > 0n) || (dBase > 0n && dQuote < 0n);
      // Meteora's own swap event first: vault deltas also count any plain transfer into a vault in
      // the same transaction, which inflated amount, price and volume (audit A2 OFF-I2).
      if (ev) {
        side = ev.buy ? "buy" : "sell";
        baseRaw = ev.buy ? ev.outputRaw : ev.inputRaw;
        quoteRaw = ev.buy ? ev.inputRaw : ev.outputRaw;
        source = "event";
      } else if (n === 1 && oppositeSigns) {
        side = dBase < 0n ? "buy" : "sell";
        baseRaw = dBase < 0n ? -dBase : dBase;
        quoteRaw = dQuote < 0n ? -dQuote : dQuote;
        source = "deltas";
      } else continue;
      if (baseRaw === 0n) continue;
      base.trades.push({
        sig, idx: idx++, slot: tx.slot, time: base.time, venue: v.venue, side, baseRaw, quoteRaw,
        price: amountsToPrice(baseRaw, quoteRaw, ctx.baseDecimals, ctx.quoteDecimals),
        spotAfter: ev ? sqrtPriceToPrice(ev.nextSqrtPrice, ctx.baseDecimals, ctx.quoteDecimals) : null,
        feeRaw: ev ? ev.feeRaw : null, trader, source,
      });
    }
  }

  // ---- lineage_launch events (Anchor emit! logs) ----
  let fi = 0;
  for (const b of programData(tx.meta.logMessages ?? [], LAUNCH_PROGRAM)) {
    const d = hex(b.subarray(0, 8));
    if (d === EV.feesCranked && b.length >= 8 + 98) {
      const f = decodeFeesCranked(b.subarray(8));
      if (f.mint !== ctx.mint) continue;
      base.fees.push({ sig, idx: fi++, slot: tx.slot, time: base.time, feesRaw: f.fees, toComputeRaw: f.toCompute, toProtocolRaw: f.toProtocol,
        poolFees: f.poolFees, balanceRaw: f.balance, awake: f.awake });
    } else if (d === EV.graduated && b.length >= 8 + 128) {
      const g = b.subarray(8);
      if (key(g, 32) !== ctx.mint) continue;
      // repoint_position emits Graduated too: it moves crank_pool_fees to a bigger locked position.
      const repoint = ixs.some((x) => x.program === LAUNCH_PROGRAM && hex(x.data.subarray(0, 8)) === IX.repointPosition);
      base.events.push({ sig, slot: tx.slot, time: base.time, kind: repoint ? "repointed" : "graduated",
        detail: { damm_pool: key(g, 64), position: key(g, 96) } });
    } else if (d === EV.agentLaunched && b.length >= 8 + 96) {
      const g = b.subarray(8);
      if (key(g, 32) !== ctx.mint) continue;
      base.events.push({ sig, slot: tx.slot, time: base.time, kind: "launch", detail: { agent: key(g, 0), launcher: key(g, 64) } });
    }
  }
  // ---- Meteora's migration of the curve into DAMM v2 ----
  for (const x of ixs) {
    if (x.program === DBC_PROGRAM && hex(x.data.subarray(0, 8)) === IX.migrationDammV2 && x.accounts.includes(ctx.dbcPool)) {
      const damm = x.accounts.find((a, i) => i > 0 && a !== ctx.dbcPool && a === (ctx.dammPool ?? "")) ?? "";
      base.events.push({ sig, slot: tx.slot, time: base.time, kind: "migration", detail: damm ? { damm_pool: damm } : {} });
      break;
    }
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint === ctx.mint && b.owner) base.balances.push({ account: keys[b.accountIndex]!, owner: b.owner, amountRaw: BigInt(b.uiTokenAmount.amount) });
  }
  return base;
}
