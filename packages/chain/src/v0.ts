import { addressBytes, toAddress, Writer, type Address } from "./codec.ts";
import { findProgramAddress, SYSTEM_PROGRAM, u64le } from "./pda.ts";
import type { Ix } from "./registry.ts";

// Version 0 messages with address lookup tables (https://solana.com/docs/advanced/lookup-tables),
// browser-safe (no node imports). Used only when a legacy transaction does not fit the 1,232-byte
// packet: the static accounts of a launch (program PDAs, Meteora fixed addresses) move into a
// frozen lookup table and cost one byte each instead of 32.

export const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
/** LookupTableMeta is 56 bytes; addresses follow. */
export const ALT_META_LEN = 56;

export interface LookupTable {
  address: Address;
  addresses: Address[];
}

export interface CompiledMessageV0 {
  bytes: Uint8Array;
  /** Static keys in message order; the first `numSigners` sign. */
  keys: Address[];
  numSigners: number;
  /** Accounts loaded from tables: writable ones first, then read-only, in index order after the static keys. */
  loaded: { writable: Address[]; readonly: Address[] };
}

const compact = (w: Writer, n: number) => {
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      w.u8(b);
      return;
    }
    w.u8(b | 0x80);
  }
};

/**
 * Compiles a v0 message. Signers and invoked program ids always stay static (the runtime requires
 * it); any other account found in a table is loaded from it.
 */
export function compileMessageV0(payer: Address, ixs: Ix[], recentBlockhash: string, tables: LookupTable[]): CompiledMessageV0 {
  const metas = new Map<Address, { signer: boolean; writable: boolean; program: boolean; order: number }>();
  let order = 0;
  const add = (k: Address, signer: boolean, writable: boolean, program = false) => {
    const cur = metas.get(k);
    if (cur) {
      cur.signer ||= signer;
      cur.writable ||= writable;
      cur.program ||= program;
    } else metas.set(k, { signer, writable, program, order: order++ });
  };
  add(payer, true, true);
  for (const ix of ixs) {
    for (const k of ix.keys) add(k.pubkey, k.isSigner, k.isWritable);
    add(ix.programId, false, false, true);
  }
  const where = new Map<Address, [number, number]>();
  tables.forEach((t, ti) => t.addresses.forEach((a, ai) => where.has(a) || where.set(a, [ti, ai])));
  const all = [...metas.entries()].sort((a, b) => a[1].order - b[1].order);
  const isLoaded = ([k, m]: (typeof all)[number]) => !m.signer && !m.program && k !== payer && where.has(k);
  const stat = all.filter((e) => !isLoaded(e));
  const group = (s: boolean, wr: boolean) => stat.filter(([k, m]) => m.signer === s && m.writable === wr && k !== payer).map(([k]) => k);
  const ws = [payer, ...group(true, true)];
  const rs = group(true, false);
  const wu = group(false, true);
  const ru = group(false, false);
  const keys = [...ws, ...rs, ...wu, ...ru];
  // per table: writable then read-only indexes; overall order: every table's writable, then every table's read-only
  const used = tables.map(() => ({ w: [] as number[], r: [] as number[], wa: [] as Address[], ra: [] as Address[] }));
  for (const e of all.filter(isLoaded)) {
    const [ti, ai] = where.get(e[0])!;
    if (e[1].writable) {
      used[ti]!.w.push(ai);
      used[ti]!.wa.push(e[0]);
    } else {
      used[ti]!.r.push(ai);
      used[ti]!.ra.push(e[0]);
    }
  }
  const loaded = { writable: used.flatMap((u) => u.wa), readonly: used.flatMap((u) => u.ra) };
  const full = [...keys, ...loaded.writable, ...loaded.readonly];
  const index = new Map(full.map((k, i) => [k, i]));
  const w = new Writer();
  w.u8(0x80);
  w.u8(ws.length + rs.length).u8(rs.length).u8(ru.length);
  compact(w, keys.length);
  for (const k of keys) w.address(k);
  w.bytes(addressBytes(recentBlockhash));
  compact(w, ixs.length);
  for (const ix of ixs) {
    w.u8(index.get(ix.programId)!);
    compact(w, ix.keys.length);
    for (const k of ix.keys) w.u8(index.get(k.pubkey)!);
    compact(w, ix.data.length);
    w.bytes(ix.data);
  }
  const lookups = tables.map((t, i) => ({ t, u: used[i]! })).filter((x) => x.u.w.length + x.u.r.length > 0);
  compact(w, lookups.length);
  for (const { t, u } of lookups) {
    w.address(t.address);
    compact(w, u.w.length);
    for (const i of u.w) w.u8(i);
    compact(w, u.r.length);
    for (const i of u.r) w.u8(i);
  }
  return { bytes: w.done(), keys, numSigners: ws.length + rs.length, loaded };
}

/** Wire size of a message with `numSigners` signatures. */
export const wireSize = (msg: { bytes: Uint8Array; numSigners: number }) => (msg.numSigners < 128 ? 1 : 2) + 64 * msg.numSigners + msg.bytes.length;

// ---------- the lookup table program ----------

export const lookupTable = {
  address: (authority: Address, recentSlot: bigint | number): [Address, number] =>
    findProgramAddress([addressBytes(authority), u64le(recentSlot)], ALT_PROGRAM),
  create(a: { authority: Address; payer: Address; recentSlot: bigint | number }): { ix: Ix; address: Address } {
    const [address, bump] = lookupTable.address(a.authority, a.recentSlot);
    return {
      address,
      ix: {
        programId: ALT_PROGRAM,
        keys: [{ pubkey: address, isSigner: false, isWritable: true }, { pubkey: a.authority, isSigner: true, isWritable: false },
          { pubkey: a.payer, isSigner: true, isWritable: true }, { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }],
        data: new Writer().u32(0).u64(a.recentSlot).u8(bump).done(),
      },
    };
  },
  extend(a: { table: Address; authority: Address; payer: Address; addresses: Address[] }): Ix {
    const w = new Writer().u32(2).u64(a.addresses.length);
    for (const x of a.addresses) w.address(x);
    return {
      programId: ALT_PROGRAM,
      keys: [{ pubkey: a.table, isSigner: false, isWritable: true }, { pubkey: a.authority, isSigner: true, isWritable: false },
        { pubkey: a.payer, isSigner: true, isWritable: true }, { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }],
      data: w.done(),
    };
  },
  /** After this the table can never change again (authority None). */
  freeze(a: { table: Address; authority: Address }): Ix {
    return {
      programId: ALT_PROGRAM,
      keys: [{ pubkey: a.table, isSigner: false, isWritable: true }, { pubkey: a.authority, isSigner: true, isWritable: false }],
      data: new Writer().u32(1).done(),
    };
  },
};

export interface LookupTableAccount {
  addresses: Address[];
  /** null once frozen */
  authority: Address | null;
  deactivationSlot: bigint;
  lastExtendedSlot: bigint;
}

export function decodeLookupTable(d: Uint8Array): LookupTableAccount {
  if (d.length < ALT_META_LEN || (d.length - ALT_META_LEN) % 32 !== 0) throw new Error("not an address lookup table");
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (dv.getUint32(0, true) !== 1) throw new Error("not an initialized address lookup table");
  const addresses: Address[] = [];
  for (let o = ALT_META_LEN; o < d.length; o += 32) addresses.push(toAddress(d.subarray(o, o + 32)));
  return {
    addresses,
    authority: d[21] === 1 ? toAddress(d.subarray(22, 54)) : null,
    deactivationSlot: dv.getBigUint64(4, true),
    lastExtendedSlot: dv.getBigUint64(12, true),
  };
}
