import { addressBytes, ixDisc, PUMP, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Address, type Ix } from "@units/chain";
import { TOKEN_ACCOUNT_LEN } from "./plans.ts";
import type { Action } from "./state.ts";

// The last check before a key signs. It reads the instructions of the transaction that is about to
// be signed (not the plan that produced them) and refuses the transaction unless what those
// instructions can do to the wallet's $UNITS is exactly what the keeper is allowed to do:
//
//   the wallet's own token account (the owner's coins) is named by no instruction at all, and holds
//   at least config.protected_units;
//   the keeper's burn account is named only by the keeper's own instructions: its creation, one buy
//   delivering into it, one BurnChecked of it signed by the wallet. No transfer, sell, close,
//   approve or change of authority, and no second burn;
//   a burn in a buy's transaction burns exactly what that buy asks for (exact amount out);
//   a burn on its own burns no more than the account holds; a buy's credit counts only inside the
//   buy's own transaction.
//
// Pure: no RPC, no state. keeper.ts gives it the balances it read right before building.

export interface GuardInput {
  /** The instructions about to be compiled and signed, compute budget included. */
  ixs: Ix[];
  action: Action;
  creator: Address;
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  /** The wallet's own (associated) $UNITS token account and what it holds now. */
  own: { address: Address; amount: bigint };
  /** The keeper's burn account and what it holds now. */
  burn: { address: Address; amount: bigint };
  protectedUnits: bigint;
}

export class Refused extends Error {}

const BUY_V3 = ixDisc("buy_v3"), BUY_V2 = ixDisc("buy_v2");
/** Position of the buyer's base token account in Pump `buy_v3` and PumpSwap `buy_v2` (packages/chain/src/pump.ts). */
const CURVE_USER_BASE = 9, POOL_USER_BASE = 5;
const startsWith = (d: Uint8Array, p: Uint8Array) => d.length >= p.length && p.every((b, i) => d[i] === b);
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);
const u32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const positions = (ix: Ix, account: Address) => ix.keys.flatMap((k, i) => (k.pubkey === account ? [i] : []));

/** The reason this transaction must not be signed, or null. */
export function guardTransaction(g: GuardInput): string | null {
  const { action: a, own, burn } = g;
  const what = `refused before signing: the ${a.kind} transaction`;
  if (own.address === burn.address) return `${what}: the keeper's burn account is the wallet's own $UNITS token account`;
  if (own.amount < g.protectedUnits)
    return `${what}: the wallet's own $UNITS token account ${own.address} holds ${own.amount} base units, under config.protected_units ${g.protectedUnits}: nothing is signed until the owner checks the wallet or changes protected_units`;

  let bought: bigint | null = null, burned: bigint | null = null;
  for (const [n, ix] of g.ixs.entries()) {
    if (ix.programId === own.address || positions(ix, own.address).length)
      return `${what} names the wallet's own $UNITS token account ${own.address} (instruction ${n}, program ${ix.programId}): the keeper never touches it`;
    const at = positions(ix, burn.address);
    const token = ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM;
    if (!at.length) {
      // a token burn of anything else signed here is not the keeper's: its only burn is of its burn account
      if (token && (ix.data[0] === 8 || ix.data[0] === 15)) return `${what} burns from ${ix.keys[0]?.pubkey}, which is not the keeper's burn account ${burn.address} (instruction ${n})`;
      continue;
    }
    const not = `${what} contains an instruction that touches the keeper's burn account ${burn.address} and is not the keeper's own buy, burn or account creation (instruction ${n}, program ${ix.programId})`;
    if (at.length !== 1) return not;
    const d = ix.data;
    if (ix.programId === SYSTEM_PROGRAM) {
      // CreateAccountWithSeed of the burn account: a token account's size, owned by the mint's token program
      if (!(d.length >= 4 && u32(d, 0) === 3 && at[0] === 1 && d.length >= 48 + 32 && u64(d, d.length - 40) === BigInt(TOKEN_ACCOUNT_LEN) && same(d.subarray(d.length - 32), addressBytes(g.tokenProgram)))) return not;
    } else if (ix.programId === g.tokenProgram && d[0] === 18) {
      // InitializeAccount3: this mint, owned by the wallet
      if (!(at[0] === 0 && d.length === 33 && ix.keys[1]?.pubkey === g.mint && same(d.subarray(1), addressBytes(g.creator)))) return not;
    } else if (ix.programId === g.tokenProgram && d[0] === 15) {
      // BurnChecked of the burn account, of this mint, signed by the wallet
      if (!(at[0] === 0 && d.length === 10 && ix.keys.length === 3 && ix.keys[1]!.pubkey === g.mint && ix.keys[2]!.pubkey === g.creator && d[9] === g.decimals)) return not;
      if (burned !== null) return `${what} burns from the keeper's burn account twice`;
      burned = u64(d, 1);
      if (a.kind === "buyback" && bought === null) return `${what} burns before its buy`;
    } else if ((ix.programId === PUMP.program && startsWith(d, BUY_V3) && at[0] === CURVE_USER_BASE) || (ix.programId === PUMP.amm && startsWith(d, BUY_V2) && at[0] === POOL_USER_BASE)) {
      if (d.length < 16) return not;
      if (bought !== null) return `${what} buys twice`;
      bought = u64(d, 8);
    } else return not;
  }

  if (a.kind === "collect" || a.kind === "compute") {
    if (bought !== null || burned !== null) return `${what} buys or burns $UNITS, which a ${a.kind} transaction never does`;
    return null;
  }
  if (a.kind === "buyback") {
    if (bought === null) return `${what} holds no buy into the keeper's burn account ${burn.address}`;
    if (bought !== a.tokens) return `${what} buys ${bought} base units, not the ${a.tokens} of its plan`;
    if (!a.burn) return burned === null ? null : `${what} burns ${burned} base units and its plan burns nothing`;
    if (burned === null) return `${what} holds no burn and its plan burns what it buys`;
    if (burned !== bought) return `${what} burns ${burned} base units and buys ${bought}: a burn in a buy's transaction is of exactly what that buy delivers`;
    return null;
  }
  if (bought !== null) return `${what} buys $UNITS, which a burn transaction never does`;
  if (burned === null) return `${what} holds no burn of the keeper's burn account ${burn.address}`;
  if (burned !== a.tokens) return `${what} burns ${burned} base units, not the ${a.tokens} of its plan`;
  if (burned > burn.amount) return `${what} burns ${burned} base units and the keeper's burn account ${burn.address} holds ${burn.amount}`;
  return null;
}
