import { base58Decode } from "@units/protocol";
import { PUMP, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Address } from "@units/chain";
import { accountKeys, type RawTx } from "./decode.ts";

// Burns and wallet movements read from one confirmed transaction (getTransaction, encoding "json").
// Pure: no RPC, so the tests replay hand-built and recorded transactions.
//
// A burn is the token program's own instruction, top level or inner (a program burning through a CPI):
//
//   Burn         tag 8,  data [8, amount u64 LE],              accounts [token account, mint, authority, ...]
//   BurnChecked  tag 15, data [15, amount u64 LE, decimals u8], accounts [token account, mint, authority, ...]
//
// of SPL Token or Token-2022 (the two share the layout). Both name the mint, so a burn of a mint is always
// in that mint's own signature list. Only a transaction that succeeded counts: a failed one burned nothing.
// Nothing else lowers a mint's supply, so the sum of these instructions is what the mint's supply lost.

export interface Burn {
  sig: string;
  /** position among the transaction's instructions, inner ones included, in execution order: (sig, idx) is the key */
  idx: number;
  slot: number;
  time: number | null;
  mint: Address;
  /** the token account the coins were burned from */
  account: Address;
  /** who authorised it: the account's owner or delegate (a program's PDA when a program burned) */
  authority: Address;
  amountRaw: bigint;
  checked: boolean;
  /** the program of the top-level instruction the burn ran inside; null when the burn is itself top level */
  via: Address | null;
  /** the transaction's fee payer */
  payer: Address;
}

const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(o, true);
const TOKEN_PROGRAMS = new Set<string>([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

interface Ix { programIdIndex: number; accounts: number[]; data: string }

/** Every instruction in execution order with the program of the top-level instruction it ran inside (null for a top-level one). */
function walk(tx: RawTx, keys: Address[]): { program: Address; accounts: Address[]; data: string; via: Address | null }[] {
  const inner = new Map<number, Ix[]>();
  for (const g of tx.meta?.innerInstructions ?? []) inner.set(g.index, g.instructions);
  const out: { program: Address; accounts: Address[]; data: string; via: Address | null }[] = [];
  tx.transaction.message.instructions.forEach((ix, i) => {
    const top = keys[ix.programIdIndex]!;
    out.push({ program: top, accounts: ix.accounts.map((a) => keys[a]!), data: ix.data, via: null });
    for (const x of inner.get(i) ?? []) out.push({ program: keys[x.programIdIndex]!, accounts: x.accounts.map((a) => keys[a]!), data: x.data, via: top });
  });
  return out;
}

/** One instruction's burn, or null: the token program, tag 8 or 15, the amount and the three accounts all there. */
export function burnOf(program: string, accounts: string[], data: Uint8Array): { account: Address; mint: Address; authority: Address; amountRaw: bigint; checked: boolean } | null {
  if (!TOKEN_PROGRAMS.has(program) || accounts.length < 3) return null;
  const checked = data[0] === 15;
  if (!(data[0] === 8 && data.length >= 9) && !(checked && data.length >= 10)) return null;
  if (!accounts[0] || !accounts[1] || !accounts[2]) return null;
  return { account: accounts[0] as Address, mint: accounts[1] as Address, authority: accounts[2] as Address, amountRaw: u64(data, 1), checked };
}

/** Every burn of the transaction, of the mints in `mints` (all mints when null). A failed transaction has none. */
export function decodeBurns(tx: RawTx, mints: ReadonlySet<string> | null = null): Burn[] {
  if (!tx.meta || tx.meta.err != null) return [];
  const keys = accountKeys(tx);
  const sig = tx.transaction.signatures[0]!;
  const out: Burn[] = [];
  walk(tx, keys).forEach((x, idx) => {
    if (!TOKEN_PROGRAMS.has(x.program)) return;
    let data: Uint8Array;
    try {
      data = base58Decode(x.data);
    } catch {
      return;
    }
    const b = burnOf(x.program, x.accounts, data);
    if (!b || (mints && !mints.has(b.mint))) return;
    out.push({ sig, idx, slot: tx.slot, time: tx.blockTime ?? null, ...b, via: x.via, payer: keys[0]! });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------
// what one transaction did to one token account of a watched wallet

export type MoveKind = "bought" | "sold" | "sent" | "received" | "burned";
export interface Move {
  sig: string;
  slot: number;
  time: number | null;
  account: Address;
  kind: MoveKind;
  amountRaw: bigint;
  /** the token account's balance after the transaction */
  balanceAfterRaw: bigint;
}

/**
 * What a successful transaction did to `account` (a token account of `mint`), from the chain's own
 * balance records: its balance before and after, and the burns taken from it.
 *
 *   burned    the sum of the burn instructions on the account
 *   the rest of the change (after minus before, plus what was burned):
 *     bought / sold       the transaction ran pump.fun or PumpSwap (a swap): coins in, or coins out
 *     received / sent     any other transaction: coins in, or coins out
 *
 * `balanceAfterRaw` is null when the transaction did not list the account's balance (it only named it).
 */
export function walletMoves(tx: RawTx, account: Address, mint: Address): { moves: Move[]; balanceAfterRaw: bigint | null } {
  if (!tx.meta || tx.meta.err != null) return { moves: [], balanceAfterRaw: null };
  const keys = accountKeys(tx);
  const i = keys.indexOf(account);
  const pre = (tx.meta.preTokenBalances ?? []).find((b) => b.accountIndex === i && b.mint === mint);
  const post = (tx.meta.postTokenBalances ?? []).find((b) => b.accountIndex === i && b.mint === mint);
  if (i < 0 || (!pre && !post)) return { moves: [], balanceAfterRaw: null };
  const before = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
  // an account the transaction closed has no balance after it: it holds nothing
  const after = post ? BigInt(post.uiTokenAmount.amount) : 0n;
  const burned = decodeBurns(tx, new Set([mint])).filter((b) => b.account === account).reduce((n, b) => n + b.amountRaw, 0n);
  const rest = after - before + burned;
  const swap = walk(tx, keys).some((x) => x.program === PUMP.program || x.program === PUMP.amm);
  const base = { sig: tx.transaction.signatures[0]!, slot: tx.slot, time: tx.blockTime ?? null, account, balanceAfterRaw: after };
  const moves: Move[] = [];
  if (burned > 0n) moves.push({ ...base, kind: "burned", amountRaw: burned });
  if (rest > 0n) moves.push({ ...base, kind: swap ? "bought" : "received", amountRaw: rest });
  if (rest < 0n) moves.push({ ...base, kind: swap ? "sold" : "sent", amountRaw: -rest });
  return { moves, balanceAfterRaw: after };
}
