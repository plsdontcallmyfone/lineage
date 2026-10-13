// Durable nonce accounts for the backup bind signature (docs/plans/SEAMLESS-BIND.md section 10). Every
// rule here was checked by running it on devnet (scripts/launch-e2e/nonce-devnet.ts):
//
//   - a nonce account is 80 bytes owned by the System program; its stored value is set when it is
//     initialized, so a transaction can be signed over it only once the account exists
//   - a transaction whose FIRST instruction is AdvanceNonceAccount, signed by the nonce authority, and
//     whose recent blockhash is the stored value lands at any later time, exactly once (it advances the
//     value); with anything before that instruction it is an ordinary, expired transaction
//   - the authority alone withdraws the balance; withdrawing all of it closes the account
//
// A runtime key's nonce account is derived from the platform's payer and the key (CreateAccountWithSeed
// with the payer as base: only the payer signs its creation), with the KEY as nonce authority. So the
// key that co-signs a rotation as its new key also authorizes the advance with the same signature, as
// a read-only signer that never pays.
import { addressBytes, toAddress, Writer, type Address } from "./codec.ts";
import { SYSTEM_PROGRAM } from "./pda.ts";
import { r, w, type Ix } from "./registry.ts";
import { seededAddress, system } from "./spl.ts";

export const NONCE_ACCOUNT_LEN = 80;
export const SYSVAR_RECENT_BLOCKHASHES = "SysvarRecentB1ockHashes11111111111111111111" as Address;
export const SYSVAR_RENT = "SysvarRent111111111111111111111111111111111" as Address;
/** System instruction indexes (u32 little endian). */
export const SYSTEM_IX = { advanceNonce: 4, withdrawNonce: 5, initializeNonce: 6 } as const;

/** The nonce account of runtime key `key` under payer `payer`: seed = the key's first 32 characters (a seed holds 32 bytes). */
export const nonceAccountFor = (payer: Address, key: Address): Address => seededAddress(payer, key.slice(0, 32), SYSTEM_PROGRAM);

export const nonce = {
  /** Creates and initializes `key`'s nonce account, paid by `payer` (its only signer), with `key` as authority. */
  create(payer: Address, key: Address, lamports: bigint): Ix[] {
    const account = nonceAccountFor(payer, key);
    return [
      system.createAccountWithSeed(payer, key.slice(0, 32), lamports, NONCE_ACCOUNT_LEN, SYSTEM_PROGRAM),
      { programId: SYSTEM_PROGRAM, keys: [w(account), r(SYSVAR_RECENT_BLOCKHASHES), r(SYSVAR_RENT)], data: new Writer().u32(SYSTEM_IX.initializeNonce).address(key).done() },
    ];
  },
  /** AdvanceNonceAccount: must be the first instruction of a transaction signed over the stored value. */
  advance(account: Address, authority: Address): Ix {
    return { programId: SYSTEM_PROGRAM, keys: [w(account), r(SYSVAR_RECENT_BLOCKHASHES), r(authority, true)], data: new Writer().u32(SYSTEM_IX.advanceNonce).done() };
  },
  /** WithdrawNonceAccount: the whole balance closes the account. */
  withdraw(account: Address, to: Address, authority: Address, lamports: bigint): Ix {
    return { programId: SYSTEM_PROGRAM, keys: [w(account), w(to), r(SYSVAR_RECENT_BLOCKHASHES), r(SYSVAR_RENT), r(authority, true)], data: new Writer().u32(SYSTEM_IX.withdrawNonce).u64(lamports).done() };
  },
};

export interface NonceState {
  authority: Address;
  /** the stored value: the "recent blockhash" of a transaction signed over this account */
  value: string;
}

/** An initialized nonce account's authority and stored value; null for anything else. */
export function decodeNonceAccount(data: Uint8Array, owner?: Address): NonceState | null {
  if (data.length !== NONCE_ACCOUNT_LEN || (owner !== undefined && owner !== SYSTEM_PROGRAM)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // version (u32), state (u32: 1 = initialized), authority, value, fee calculator
  if (v.getUint32(4, true) !== 1) return null;
  return { authority: toAddress(data.subarray(8, 40)), value: toAddress(data.subarray(40, 72)) };
}

type ParsedIx = { programId: string; accounts: { pubkey: string }[]; data: Uint8Array };
const same = (d: Uint8Array, n: number) => d.length === 4 && d[0] === n && d[1] === 0 && d[2] === 0 && d[3] === 0;

/** True when `ix` is exactly AdvanceNonceAccount of `account` with `authority` (three accounts, four bytes of data). */
export function isAdvanceOf(ix: ParsedIx, account: Address, authority: Address): boolean {
  return ix.programId === SYSTEM_PROGRAM && same(ix.data, SYSTEM_IX.advanceNonce) && ix.accounts.length === 3
    && ix.accounts[0]!.pubkey === account && ix.accounts[1]!.pubkey === SYSVAR_RECENT_BLOCKHASHES && ix.accounts[2]!.pubkey === authority;
}

/** The lamports of an exact WithdrawNonceAccount of `account` to `to` by `authority`; null for anything else. */
export function withdrawOf(ix: ParsedIx, account: Address, to: Address, authority: Address): bigint | null {
  if (ix.programId !== SYSTEM_PROGRAM || ix.data.length !== 12 || !same(ix.data.subarray(0, 4), SYSTEM_IX.withdrawNonce) || ix.accounts.length !== 5) return null;
  const a = ix.accounts.map((x) => x.pubkey);
  if (a[0] !== account || a[1] !== to || a[2] !== SYSVAR_RECENT_BLOCKHASHES || a[3] !== SYSVAR_RENT || a[4] !== authority) return null;
  return new DataView(ix.data.buffer, ix.data.byteOffset + 4, 8).getBigUint64(0, true);
}
void addressBytes;
