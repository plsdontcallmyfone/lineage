import { ixDisc, toAddress, type Address } from "./codec.ts";
import { ASSOCIATED_TOKEN_PROGRAM, ata, BPF_LOADER_UPGRADEABLE, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda.ts";
import { msgPdas } from "./msg.ts";
import { MSG_PROGRAM_ID, LAUNCH_PROGRAM_ID, REGISTRY_PROGRAM_ID } from "./programs.ts";
import { pump, PUMP, pumpAmm, pumpPdas } from "./pump.ts";
import { r, registryPdas, w, type Ix } from "./registry.ts";
import { COMPUTE_BUDGET_PROGRAM } from "./tx.ts";
import { ALT_PROGRAM } from "./v0.ts";

// The transaction firewall's policy (docs/plans/AGENT-WALLET-SAFETY.md section 3.3): a pure function
// from the bytes an agent treasury key is asked to sign, and facts read from chain, to allow or
// refuse. It never trusts the caller's description of the transaction: it parses the message itself
// (strictly: exact length, canonical lengths, no duplicate keys, every index in range, every lookup
// resolved) and, for a swap, rebuilds the instruction from (mint, quote mint, key) with this
// package's own builders and requires the message's instruction to equal it account for account and
// byte for byte. The allowlist is closed: anything it does not recognise is refused.

export interface FirewallLimits {
  /** the trading config's `enabled`: while false no swap is signed */
  trading_enabled: boolean;
  /** most quote value one swap may carry, quote base units */
  max_tx_quote: bigint;
  /** most quote value the key may sign per UTC day, quote base units */
  max_day_quote: bigint;
  /** least share of the spot output a swap must demand, bps */
  min_out_bps: number;
  /** most priority fee one transaction may bid, lamports */
  max_fee_lamports: bigint;
  /** a buy needs a token launched at least this long ago (the AgentLaunch record's own time), seconds */
  min_launch_age_s: number;
  /** a buy needs at least this much real quote in the curve or pool, quote base units */
  min_liquidity_quote: bigint;
  /** most a trade may move the price it trades at: size against the reserve it trades into, bps */
  max_impact_bps: number;
  /** the engine's percentage limits, re-checked against what the key holds on chain */
  max_trade_bps: number;
  max_position_bps: number;
  max_deployed_bps: number;
  /** all hosted agents together may hold this share of a token's supply, bps */
  network_max_exposure_bps: number;
  /** the kill switch as the trading config carries it: no buy is signed while true (Core's check says the same; either is enough) */
  reduce_only: boolean;
}

/**
 * Core's answer for this swap (GET /v1/trading/check): the rules only Core can see (accepted work,
 * hidden list, the kill switch, halts, trades per day, herding, the wash guard) and how much of the
 * token hosted agents already hold. null: Core could not be asked.
 */
export type CoreCheck = { ok: true; network_held: bigint } | { ok: false; rule: string; detail: string };

/** What the chain says about a mint a transaction names. Spot is quote base units per `base` token base units. */
export interface MintFacts {
  /** an AgentLaunch account owned by units_launch exists for this mint, on the pump.fun venue */
  registered: boolean;
  /** the agent whose token it is */
  agent: Address | null;
  /** when the AgentLaunch record was created, unix seconds, as the chain recorded it */
  createdAt: bigint | null;
  /** the mint's supply, base units */
  supply: bigint | null;
  /** real quote in the curve (its real reserves) or in the pool's quote vault, quote base units */
  liquidity: bigint | null;
  /** the bonding curve's virtual reserves while the curve takes trades */
  curve: { quote: bigint; base: bigint } | null;
  /** the canonical PumpSwap pool's effective reserves once it exists */
  pool: { quote: bigint; base: bigint } | null;
}

export interface FirewallContext {
  /** the guarded treasury key */
  key: Address;
  /** the agent this key signs for (null: the key belongs to no known agent, so only nothing is allowed) */
  agent: Address | null;
  /** that agent's own token */
  ownMint: Address | null;
  /** the launch config's quote mint ($UNITS) and its token program */
  quoteMint: Address;
  quoteTokenProgram: Address;
  /** facts for every mint the message names, read from chain by the firewall */
  mints: Map<Address, MintFacts>;
  /** frozen, live lookup tables read from chain by the firewall: address -> its addresses */
  tables: Map<Address, Address[]>;
  /** null: the limits could not be read, so no swap is signed */
  limits: FirewallLimits | null;
  /** quote value already authorized for this key in the current UTC day */
  daySpent: bigint;
  /** Core's answer for this swap; null: unreachable (a buy is then refused, a sell is not) */
  core: CoreCheck | null;
  /** what the key holds on chain: its quote balance, and its balance of the swapped mint; null: unreadable */
  cash: bigint | null;
  held: bigint | null;
  /** now, unix seconds */
  now: number;
}

export interface SwapSummary {
  side: "buy" | "sell";
  venue: "pump_curve" | "pump_pool";
  mint: Address;
  amountIn: bigint;
  minOut: bigint;
  /** quote base units: quote in for a buy, the tokens' spot value for a sell */
  value: bigint;
}

export type Verdict =
  | { ok: true; kind: "swap"; value: bigint; swap: SwapSummary; summary: string }
  | { ok: true; kind: "message" | "registry"; value: 0n; summary: string }
  | { ok: false; rule: string; detail: string };

const refuse = (rule: string, detail: string): Verdict => ({ ok: false, rule, detail });

export const MAX_CU_LIMIT = 1_400_000;
export const MAX_ATA_CREATES = 3;
const U64_MAX = (1n << 64n) - 1n;

/** Names for the detail of a refusal; the policy itself is the allowlist, not this table. */
const KNOWN: Record<string, string> = {
  [SYSTEM_PROGRAM]: "System",
  [TOKEN_PROGRAM]: "SPL Token",
  [TOKEN_2022_PROGRAM]: "Token-2022",
  [BPF_LOADER_UPGRADEABLE]: "BPF upgradeable loader",
  [ALT_PROGRAM]: "address lookup table",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo v1",
  Stake11111111111111111111111111111111111111: "Stake",
  Vote111111111111111111111111111111111111111: "Vote",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb: "Wormhole token bridge",
};
const nameOf = (p: Address) => (p === LAUNCH_PROGRAM_ID ? "units_launch" : (KNOWN[p] ?? "an unknown program"));

// ------------------------------------------------------------------------------------------------
// strict message parser

export interface ParsedIx {
  programId: Address;
  accounts: { pubkey: Address; index: number; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
}
export interface ParsedMessage {
  version: "legacy" | 0;
  numSigners: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  staticKeys: Address[];
  /** static keys, then the accounts loaded from tables (writable, then read-only) */
  keys: Address[];
  writable: boolean[];
  lookups: { table: Address; writable: number[]; readonly: number[] }[];
  instructions: ParsedIx[];
}

class ParseError extends Error {}

/**
 * Parses a legacy or version 0 message and nothing looser: the whole buffer is consumed, lengths are
 * canonical compact-u16, the header is consistent, keys are unique, and every index points at a key.
 * A version 0 message's loaded accounts are resolved from `tables`; a table that is not there throws.
 * With `tables` null the loaded accounts are left as "<table>#<index>" placeholders (only to list the
 * tables a message reads; the policy never evaluates such a parse).
 */
export function parseMessageStrict(m: Uint8Array, tables: Map<Address, Address[]> | null = new Map()): ParsedMessage {
  let o = 0;
  const need = (n: number) => {
    if (o + n > m.length) throw new ParseError("the message ends early");
  };
  const u8 = () => (need(1), m[o++]!);
  const compact = (): number => {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const b = u8();
      v |= (b & 0x7f) << (7 * i);
      if (!(b & 0x80)) {
        if (i > 0 && b === 0) throw new ParseError("a length is not in its shortest encoding");
        if (v > 0xffff) throw new ParseError("a length is above 65535");
        return v;
      }
    }
    throw new ParseError("a length runs past three bytes");
  };
  const key = (): Address => {
    need(32);
    const a = toAddress(m.subarray(o, o + 32));
    o += 32;
    return a;
  };
  if (m.length === 0) throw new ParseError("empty message");
  let version: "legacy" | 0 = "legacy";
  if (m[0]! & 0x80) {
    if ((m[0]! & 0x7f) !== 0) throw new ParseError(`message version ${m[0]! & 0x7f} is not supported`);
    version = 0;
    o = 1;
  }
  const numSigners = u8(), numReadonlySigned = u8(), numReadonlyUnsigned = u8();
  const nk = compact();
  if (numSigners < 1) throw new ParseError("no signer");
  if (numReadonlySigned >= numSigners) throw new ParseError("the fee payer is not writable");
  if (numSigners > nk || numReadonlyUnsigned > nk - numSigners) throw new ParseError("the header counts more keys than the message holds");
  const staticKeys: Address[] = [];
  for (let i = 0; i < nk; i++) staticKeys.push(key());
  key(); // recent blockhash
  const ni = compact();
  const raw: { p: number; a: number[]; data: Uint8Array }[] = [];
  for (let k = 0; k < ni; k++) {
    const p = u8();
    const na = compact();
    const a: number[] = [];
    for (let j = 0; j < na; j++) a.push(u8());
    const nd = compact();
    need(nd);
    raw.push({ p, a, data: m.slice(o, o + nd) });
    o += nd;
  }
  const keys = [...staticKeys];
  const writable = staticKeys.map((_, i) => (i < numSigners ? i < numSigners - numReadonlySigned : i < nk - numReadonlyUnsigned));
  const lookups: ParsedMessage["lookups"] = [];
  if (version === 0) {
    const nl = compact();
    for (let t = 0; t < nl; t++) {
      const table = key();
      const idx = (): number[] => {
        const n = compact();
        const out: number[] = [];
        for (let j = 0; j < n; j++) out.push(u8());
        return out;
      };
      const w = idx();
      const r = idx();
      if (w.length + r.length === 0) throw new ParseError("a lookup that loads nothing");
      lookups.push({ table, writable: w, readonly: r });
    }
    const resolve = (table: Address, i: number): Address => {
      if (tables === null) return `${table}#${i}`;
      const t = tables.get(table);
      if (!t) throw new ParseError(`lookup table ${table} is not resolved`);
      const a = t[i];
      if (!a) throw new ParseError(`lookup table ${table} has no index ${i}`);
      return a;
    };
    for (const l of lookups) for (const i of l.writable) (keys.push(resolve(l.table, i)), writable.push(true));
    for (const l of lookups) for (const i of l.readonly) (keys.push(resolve(l.table, i)), writable.push(false));
  }
  if (o !== m.length) throw new ParseError(`${m.length - o} trailing byte(s) after the message`);
  if (new Set(keys).size !== keys.length) throw new ParseError("an account key appears twice");
  if (keys.length > 256) throw new ParseError("more than 256 accounts");
  const instructions: ParsedIx[] = raw.map((x) => {
    // the runtime requires program ids to be static keys, and never the fee payer
    if (x.p >= staticKeys.length || x.p === 0) throw new ParseError("an instruction's program index is not a static, non-payer key");
    return {
      programId: keys[x.p]!,
      accounts: x.a.map((index) => {
        if (index >= keys.length) throw new ParseError("an instruction names an account index past the key list");
        return { pubkey: keys[index]!, index, isSigner: index < numSigners, isWritable: writable[index]! };
      }),
      data: x.data,
    };
  });
  return { version, numSigners, numReadonlySigned, numReadonlyUnsigned, staticKeys, keys, writable, lookups, instructions };
}

/** The lookup tables a message reads, without resolving them (for the caller that fetches them from chain). */
export function lookupTablesOf(m: Uint8Array): Address[] {
  return parseMessageStrict(m, null).lookups.map((l) => l.table);
}

// ------------------------------------------------------------------------------------------------
// instruction readers

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const starts = (d: Uint8Array, disc: Uint8Array) => d.length >= 8 && disc.every((x, i) => x === d[i]);
const u64 = (d: Uint8Array, o: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]!);
  return v;
};
const u32 = (d: Uint8Array, o: number): number => (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;

const DISC = {
  pumpBuy: ixDisc("buy_exact_quote_in_v3"),
  pumpSell: ixDisc("sell_v3"),
  ammBuy: ixDisc("buy_exact_quote_in_v2"),
  ammSell: ixDisc("sell_v2"),
  postBoard: ixDisc("post_board"),
  postDm: ixDisc("post_dm"),
  publishEncKey: ixDisc("publish_enc_key"),
  rotate: ixDisc("rotate_agent_key"),
  setProfile: ixDisc("set_profile"),
};

/** Whether `ix` names exactly the accounts of `want`, in order, with the same data. Flags are the message's and are checked separately. */
const sameIx = (ix: ParsedIx, want: Ix) =>
  ix.programId === want.programId && sameBytes(ix.data, want.data) && ix.accounts.length === want.keys.length && ix.accounts.every((a, i) => a.pubkey === want.keys[i]!.pubkey);

interface SwapRead {
  side: "buy" | "sell";
  venue: "pump_curve" | "pump_pool";
  mint: Address;
  quote: Address;
  amountIn: bigint;
  minOut: bigint;
  /** the buyback recipient account the instruction pays (one of pump.fun's eight) */
  buyback: Address;
  /** the instruction as this package's builder makes it (the message's instruction equals it) */
  built: Ix;
}

/** Reads a swap instruction and proves it is the canonical one for (mint, quote, key); a string is the refusal detail. */
function readSwap(ix: ParsedIx, c: FirewallContext): SwapRead | { rule: string; detail: string } {
  const no = (rule: string, detail: string) => ({ rule, detail });
  const isPump = ix.programId === PUMP.program;
  const d = ix.data;
  let side: "buy" | "sell";
  if (isPump && starts(d, DISC.pumpBuy) && d.length === 25) side = "buy";
  else if (isPump && starts(d, DISC.pumpSell) && d.length === 24) side = "sell";
  else if (!isPump && starts(d, DISC.ammBuy) && d.length === 24) side = "buy";
  else if (!isPump && starts(d, DISC.ammSell) && d.length === 24) side = "sell";
  else return no("instruction_not_allowed", `${isPump ? "Pump" : "PumpSwap"} instruction other than ${isPump ? "buy_exact_quote_in_v3 or sell_v3" : "buy_exact_quote_in_v2 or sell_v2"}`);
  const at = isPump ? [1, 2] : [3, 4];
  const mint = ix.accounts[at[0]!]?.pubkey;
  const quote = ix.accounts[at[1]!]?.pubkey;
  if (!mint || !quote) return no("swap_accounts", "the swap names too few accounts");
  const amountIn = u64(d, 8), minOut = u64(d, 16);
  const base = { mint, quoteMint: quote, quoteTokenProgram: c.quoteTokenProgram, user: c.key };
  for (let i = 0; i < PUMP.buybackRecipients.length; i++) {
    const want = isPump
      ? side === "buy"
        ? pump.buyExactQuoteInV3({ ...base, buyback: i, spendableQuoteIn: amountIn, minTokensOut: minOut })
        : pump.sellV3({ ...base, buyback: i, amount: amountIn, minQuoteOut: minOut })
      : side === "buy"
        ? pumpAmm.buyExactQuoteInV2({ ...base, buyback: i, pool: pumpPdas.pool(mint, quote), spendableQuoteIn: amountIn, minBaseOut: minOut })
        : pumpAmm.sellV2({ ...base, buyback: i, pool: pumpPdas.pool(mint, quote), baseIn: amountIn, minQuoteOut: minOut });
    if (sameIx(ix, want)) return { side, venue: isPump ? "pump_curve" : "pump_pool", mint, quote, amountIn, minOut, buyback: ata(PUMP.buybackRecipients[i]!, quote, c.quoteTokenProgram), built: want };
  }
  return no("swap_accounts", "the swap's accounts are not the canonical ones for this mint and this key (a token account, pool, vault or fee recipient differs, or accounts were added)");
}

// ------------------------------------------------------------------------------------------------
// the policy

/**
 * Allow or refuse `message` for the guarded key of `c`. Pure: same bytes and context, same verdict.
 * The caller (firewall-chain.ts) builds the context from chain and applies the verdict.
 */
export function evaluate(message: Uint8Array, c: FirewallContext): Verdict {
  let m: ParsedMessage;
  try {
    m = parseMessageStrict(message, c.tables);
  } catch (e) {
    const msg = (e as Error).message;
    return refuse(/lookup table/.test(msg) ? "lookup_table" : "malformed", msg);
  }
  const at = m.keys.indexOf(c.key);
  if (at < 0 || at >= m.numSigners) return refuse("not_a_signer", "the key is not a signer of this message");
  const isPayer = at === 0;
  const readonlySigner = at >= m.numSigners - m.numReadonlySigned;
  if (!c.agent) return refuse("unknown_agent", "this key belongs to no agent the runtime knows");

  // every program must be on the list; nothing else is looked at before this holds
  const allowed = new Set<Address>([COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, PUMP.program, PUMP.amm, MSG_PROGRAM_ID, REGISTRY_PROGRAM_ID]);
  for (const ix of m.instructions) if (!allowed.has(ix.programId)) return refuse("program_not_allowed", `instruction for ${nameOf(ix.programId)} (${ix.programId})`);

  // compute budget
  let cuLimit: number | null = null;
  let cuPrice: bigint | null = null;
  const rest: ParsedIx[] = [];
  for (const ix of m.instructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM) {
      rest.push(ix);
      continue;
    }
    const d = ix.data;
    if (ix.accounts.length) return refuse("compute_budget", "a compute budget instruction with accounts");
    if (d[0] === 2 && d.length === 5 && cuLimit === null) cuLimit = u32(d, 1);
    else if (d[0] === 3 && d.length === 9 && cuPrice === null) cuPrice = u64(d, 1);
    else return refuse("compute_budget", "only one SetComputeUnitLimit and one SetComputeUnitPrice are allowed");
  }
  if (cuLimit !== null && cuLimit > MAX_CU_LIMIT) return refuse("compute_budget", `compute unit limit ${cuLimit} above ${MAX_CU_LIMIT}`);
  if (!rest.length) return refuse("nothing_to_sign", "no instruction besides compute budget");

  const kinds = new Set(rest.map((ix) => (ix.programId === MSG_PROGRAM_ID ? "message" : ix.programId === REGISTRY_PROGRAM_ID ? "registry" : "swap")));
  if (kinds.size !== 1) return refuse("mixed_kinds", `one transaction is a swap, a message or a registry call, never ${[...kinds].join(" and ")}`);
  const kind = [...kinds][0]! as "swap" | "message" | "registry";

  if (kind !== "swap") {
    if (isPayer) return refuse("key_pays", `the key is the fee payer of a ${kind} transaction (the runtime authority or the owner's wallet pays)`);
    if (!readonlySigner) return refuse("key_writable", `the key is a writable account of a ${kind} transaction`);
    const record = registryPdas.agent(c.agent);
    for (const ix of rest) {
      const acc = (i: number) => ix.accounts[i]?.pubkey;
      // the key may appear only in the one signer slot the instruction defines
      const slots = ix.accounts.map((a, i) => (a.pubkey === c.key ? i : -1)).filter((i) => i >= 0);
      if (kind === "message") {
        const name = starts(ix.data, DISC.postBoard) ? "post_board" : starts(ix.data, DISC.postDm) ? "post_dm" : starts(ix.data, DISC.publishEncKey) ? "publish_enc_key" : null;
        if (!name) return refuse("instruction_not_allowed", "units_msg instruction other than post_board, post_dm or publish_enc_key");
        if (slots.length !== 1 || slots[0] !== 1) return refuse("message_accounts", `${name}: the key must be the signer account and nothing else`);
        if (acc(2) !== record || acc(4) !== msgPdas.state(c.agent)) return refuse("message_accounts", `${name}: the agent record or message state is not this key's agent's`);
      } else {
        if (starts(ix.data, DISC.rotate) && ix.data.length === 8) {
          if (ix.accounts.length !== 4 || slots.length !== 1 || slots[0] !== 2) return refuse("registry_accounts", "rotate_agent_key: the key must be the new key and nothing else");
          if (acc(3) !== record) return refuse("registry_accounts", "rotate_agent_key targets another agent's record");
        } else if (starts(ix.data, DISC.setProfile) && ix.data.length === 8 + 32 + 4) {
          if (ix.accounts.length !== 3 || slots.length !== 1 || slots[0] !== 1) return refuse("registry_accounts", "set_profile: the key must be the signing key and nothing else");
          if (acc(2) !== record) return refuse("registry_accounts", "set_profile targets another agent's record");
        } else return refuse("instruction_not_allowed", "units_registry instruction other than rotate_agent_key (as the new key) or set_profile");
      }
    }
    return { ok: true, kind, value: 0n, summary: `${kind}: ${rest.length} instruction(s), the key signs read-only and pays nothing` };
  }

  // ---- swap: the only kind in which the key pays or holds anything
  if (!c.limits) return refuse("no_limits", "the trading config could not be read; no swap is signed without its limits");
  if (!c.limits.trading_enabled) return refuse("trading_off", "trading is off in the trading config");
  if (!isPayer || m.numSigners !== 1) return refuse("swap_signers", "a swap is paid and signed by the treasury key alone");
  const fee = cuPrice === null ? 0n : (BigInt(cuLimit ?? MAX_CU_LIMIT) * cuPrice + 999_999n) / 1_000_000n;
  if (fee > c.limits.max_fee_lamports) return refuse("max_fee", `priority fee ${fee} lamports above ${c.limits.max_fee_lamports}`);

  const swaps = rest.filter((ix) => ix.programId === PUMP.program || ix.programId === PUMP.amm);
  const creates = rest.filter((ix) => ix.programId === ASSOCIATED_TOKEN_PROGRAM);
  if (swaps.length !== 1) return refuse("one_swap", `${swaps.length} swap instructions; a transaction carries exactly one`);
  if (creates.length > MAX_ATA_CREATES) return refuse("ata_creates", `${creates.length} token account creations, at most ${MAX_ATA_CREATES}`);
  const s = readSwap(swaps[0]!, c);
  if ("rule" in s) return refuse(s.rule, s.detail);
  if (s.quote !== c.quoteMint) return refuse("quote_mint", `the swap is quoted in ${s.quote}, not the launch config's quote mint`);
  if (s.mint === c.quoteMint) return refuse("mint_not_registered", "the quote token is not an agent token");
  const facts = c.mints.get(s.mint);
  if (!facts?.registered) return refuse("mint_not_registered", `${s.mint} has no pump.fun AgentLaunch in units_launch`);
  if (s.mint === c.ownMint || (facts.agent !== null && facts.agent === c.agent)) return refuse("own_token", "an agent never trades its own token");
  // Core's rules first, for a buy: the kill switch, halts, accepted work, hidden list, trades per day, herding, the wash guard.
  // A sell is never held back by Core being unreachable or by buy-side rules: reducing risk must stay possible.
  if (s.side === "buy") {
    if (c.limits.reduce_only) return refuse("reduce_only", "reduce only: no buys are signed");
    if (!c.core) return refuse("core_unavailable", "Core could not be asked about this buy; no buy is signed without its answer");
    if (!c.core.ok) return refuse(c.core.rule, c.core.detail);
    const age = facts.createdAt === null ? null : BigInt(c.now) - facts.createdAt;
    if (c.limits.min_launch_age_s > 0 && (age === null || age < BigInt(c.limits.min_launch_age_s)))
      return refuse("ineligible_age", `the token launched ${age === null ? "at an unknown time" : `${age < 0n ? 0n : age} s ago`}; a buy needs at least ${c.limits.min_launch_age_s} s`);
    if (facts.liquidity === null || facts.liquidity < c.limits.min_liquidity_quote) return refuse("ineligible_liquidity", `quote reserves ${facts.liquidity ?? "unreadable"} below the minimum ${c.limits.min_liquidity_quote}`);
  }
  if (s.amountIn <= 0n || s.minOut <= 0n) return refuse("zero_amount", "amount in and minimum out must both be above zero");
  const spot = s.venue === "pump_curve" ? facts.curve : facts.pool;
  if (!spot || spot.quote <= 0n || spot.base <= 0n) return refuse("no_reference_price", `no ${s.venue === "pump_curve" ? "live curve" : "canonical pool"} on chain to price this swap against`);
  const expected = s.side === "buy" ? (s.amountIn * spot.base) / spot.quote : (s.amountIn * spot.quote) / spot.base;
  const value = s.side === "buy" ? s.amountIn : expected;
  if (value > U64_MAX) return refuse("malformed", "value overflows");
  if (s.minOut * 10_000n < expected * BigInt(c.limits.min_out_bps)) return refuse("min_out_too_low", `minimum out ${s.minOut} is below ${c.limits.min_out_bps} bps of the spot output ${expected}`);
  // price impact: the size against the reserve it trades into (exact for a constant product)
  const [x, r0] = s.side === "buy" ? [s.amountIn, spot.quote] : [s.amountIn, spot.base];
  if (x * 10_000n > BigInt(c.limits.max_impact_bps) * (r0 + x)) return refuse("max_impact", `the trade is ${(x * 10_000n) / (r0 + x)} bps of the reserve it trades into (max ${c.limits.max_impact_bps})`);
  if (s.side === "buy") {
    // the engine's percentage limits against the key's own balances on chain. Equity is not readable here, but it is
    // at most cash / (1 - max deployed share) while the deployed cap holds, so these bounds never refuse what the engine allows.
    if (c.cash === null || c.held === null) return refuse("balances_unreadable", "the key's balances could not be read from chain");
    if (c.limits.max_deployed_bps >= 10_000) return refuse("no_limits", "max_deployed_bps leaves no bound on equity");
    const equityMax = (c.cash * 10_000n) / BigInt(10_000 - c.limits.max_deployed_bps);
    if (value * 10_000n > equityMax * BigInt(c.limits.max_trade_bps)) return refuse("max_trade", `value ${value} above ${c.limits.max_trade_bps} bps of the most the equity can be (${equityMax})`);
    const position = ((c.held + expected) * spot.quote) / spot.base;
    if (position * 10_000n > equityMax * BigInt(c.limits.max_position_bps)) return refuse("max_position", `the position would be worth ${position}, above ${c.limits.max_position_bps} bps of the most the equity can be (${equityMax})`);
    // every hosted agent together: a share of the token's supply
    if (facts.supply === null || facts.supply <= 0n) return refuse("network_exposure", "the token's supply could not be read");
    if ((c.core!.ok ? c.core!.network_held + expected : 0n) * 10_000n > facts.supply * BigInt(c.limits.network_max_exposure_bps))
      return refuse("network_exposure", `hosted agents would hold more than ${c.limits.network_max_exposure_bps} bps of the token's supply`);
  }
  if (value > c.limits.max_tx_quote) return refuse("max_tx_value", `value ${value} above the per-transaction limit ${c.limits.max_tx_quote}`);
  if (c.daySpent + value > c.limits.max_day_quote) return refuse("max_day_value", `value ${value} with ${c.daySpent} already authorized today is above the daily limit ${c.limits.max_day_quote}`);

  // token account creation: the key's own quote account, its own account for the mint being swapped, the swap's buyback account
  const ownQuote = ata(c.key, c.quoteMint, c.quoteTokenProgram);
  const ownBase = ata(c.key, s.mint, TOKEN_2022_PROGRAM);
  const built: Ix[] = [s.built];
  for (const ix of creates) {
    const d = ix.data;
    if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) return refuse("instruction_not_allowed", "associated token program instruction other than Create or CreateIdempotent");
    const a = ix.accounts.map((x) => x.pubkey);
    if (a.length !== 6 || a[0] !== c.key || a[4] !== SYSTEM_PROGRAM) return refuse("ata_not_own", "token account creation must be funded by the key with the standard six accounts");
    const [, account, owner, mint, , tp] = a as [Address, Address, Address, Address, Address, Address];
    if (tp !== TOKEN_PROGRAM && tp !== TOKEN_2022_PROGRAM) return refuse("ata_not_own", "token account creation under an unknown token program");
    if (account !== ata(owner, mint, tp)) return refuse("ata_not_own", "the created account is not the owner's associated token account");
    const ok = account === ownQuote || account === ownBase || account === s.buyback;
    if (!ok) return refuse("ata_not_own", `token account ${account} for owner ${owner} is not the key's own account for this swap, nor the swap's buyback account`);
    built.push({ programId: ASSOCIATED_TOKEN_PROGRAM, data: d, keys: [w(c.key, true), w(account), r(owner), r(mint), r(SYSTEM_PROGRAM), r(tp)] });
  }
  // the message locks exactly what those instructions need: no account the instructions do not name,
  // none made writable or a signer by the header beyond what the builders ask for
  const want = new Map<Address, { signer: boolean; writable: boolean }>([[c.key, { signer: true, writable: true }]]);
  const need = (k: Address, signer: boolean, writable: boolean) => {
    const cur = want.get(k);
    if (cur) (cur.signer ||= signer), (cur.writable ||= writable);
    else want.set(k, { signer, writable });
  };
  for (const ix of built) {
    need(ix.programId, false, false);
    for (const k of ix.keys) need(k.pubkey, k.isSigner, k.isWritable);
  }
  if (cuLimit !== null || cuPrice !== null) need(COMPUTE_BUDGET_PROGRAM, false, false);
  for (let i = 0; i < m.keys.length; i++) {
    const e = want.get(m.keys[i]!);
    if (!e) return refuse("unused_account", `the message lists ${m.keys[i]}, which no allowed instruction names`);
    if (m.writable[i] !== e.writable || i < m.numSigners !== e.signer) return refuse("account_flags", `the message locks ${m.keys[i]} ${m.writable[i] ? "writable" : "read-only"}${i < m.numSigners ? " as a signer" : ""}, not as the swap needs it`);
  }
  // the key's lamports move only as the fee and as rent for those accounts: no other program is present to move them
  return {
    ok: true,
    kind: "swap",
    value,
    swap: { side: s.side, venue: s.venue, mint: s.mint, amountIn: s.amountIn, minOut: s.minOut, value },
    summary: `swap: ${s.side} ${s.mint} on ${s.venue}, in ${s.amountIn}, min out ${s.minOut}, value ${value}, ${creates.length} token account creation(s)`,
  };
}

/** The swap a message carries (base mint and side), read loosely for the context builder; the policy proves it. */
export function swapNamed(m: ParsedMessage): { mint: Address; side: "buy" | "sell" } | null {
  for (const ix of m.instructions) {
    const pumpIx = ix.programId === PUMP.program;
    if (!pumpIx && ix.programId !== PUMP.amm) continue;
    const mint = ix.accounts[pumpIx ? 1 : 3]?.pubkey;
    if (!mint) return null;
    if (starts(ix.data, pumpIx ? DISC.pumpBuy : DISC.ammBuy)) return { mint, side: "buy" };
    if (starts(ix.data, pumpIx ? DISC.pumpSell : DISC.ammSell)) return { mint, side: "sell" };
    return null;
  }
  return null;
}

/** The mints a message names in the places the policy reads them (swap base and quote, created accounts' mints), for the context builder. */
export function mintsNamed(m: ParsedMessage): Address[] {
  const out = new Set<Address>();
  for (const ix of m.instructions) {
    if (ix.programId === PUMP.program && ix.accounts[1]) out.add(ix.accounts[1].pubkey);
    else if (ix.programId === PUMP.amm && ix.accounts[3]) out.add(ix.accounts[3].pubkey);
  }
  return [...out];
}
