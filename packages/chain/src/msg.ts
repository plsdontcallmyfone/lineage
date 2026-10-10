import { base58Decode, base58Encode } from "@lineage/protocol";
import { accountDisc, addressBytes, bytesToHex, hexToBytes, ixDisc, Reader, sha256, Writer, type Address } from "./codec.ts";
import { BPF_LOADER_UPGRADEABLE, pda, SYSTEM_PROGRAM } from "./pda.ts";
import { r, registryPdas, w, type Ix } from "./registry.ts";
import type { Rpc } from "./rpc.ts";
import { MSG_PROGRAM_ID } from "./programs.ts";

// units_msg (SPEC 12.5): onchain agent messages. Instruction builders, account decoders, the
// event decoder and a transaction parser. Every message is an Anchor event emitted by self-CPI, so it
// is read from a transaction's inner instructions (never from an account). Encodings match
// onchain/programs/units-msg; onchain/tests/fixtures/msg-events.json pins them.

/** The active network's id (devnet until a profile is applied; programs.ts). */
export { MSG_PROGRAM_ID };
/** Largest inline body the program accepts: the longest message transaction is exactly 1,232 bytes. */
export const MSG_MAX_INLINE = 568;
/** Sealed bytes: 32-byte ephemeral key + ciphertext + 16-byte tag (packages/core seal.ts). */
export const SEAL_OVERHEAD = 48;
/** Anchor's self-CPI event instruction tag (sha256("anchor:event")[..8], little endian). */
export const EVENT_IX_TAG = hexToBytes("e445a52e51cb9a1d");

export const msgPdas = {
  config: () => pda(MSG_PROGRAM_ID, "msg_config"),
  state: (agent: Address) => pda(MSG_PROGRAM_ID, "msg_state", addressBytes(agent)),
  eventAuthority: () => pda(MSG_PROGRAM_ID, "__event_authority"),
  programData: () => pda(BPF_LOADER_UPGRADEABLE, addressBytes(MSG_PROGRAM_ID)),
};

export const REF_KINDS = ["intent", "candidate", "generation", "finding", "bounty"] as const;
export type RefKind = (typeof REF_KINDS)[number];
const refCode = (k: string): number => {
  const i = REF_KINDS.indexOf(k as RefKind);
  if (i < 0) throw new Error(`unknown ref kind ${k}`);
  return i + 1;
};

/** A Core reference id as 32 bytes: a 64-char hex id, or a base58 address (bounties). */
export function refIdBytes(id: string): Uint8Array {
  if (/^[0-9a-f]{64}$/.test(id)) return hexToBytes(id);
  const b = base58Decode(id);
  if (b.length !== 32) throw new Error(`ref id ${id} is neither 32 hex bytes nor a 32-byte address`);
  return b;
}
/** The id string Core uses for a 32-byte onchain reference. */
export const refIdString = (kind: RefKind, id: Uint8Array): string => (kind === "bounty" ? base58Encode(id) : bytesToHex(id));

export interface MsgConfigArgs {
  admin: Address;
  paused: boolean;
  windowS: number;
  maxPerWindow: number;
  maxPerDay: number;
  maxInline: number;
  maxBlob: number;
}
export type MsgBody = { inline: Uint8Array } | { blob: { sha256: string; size: number } };
export interface MsgRefArg {
  kind: RefKind;
  id: string;
}
export interface BoardPostArgs {
  /** Core lineage id (64 hex). */
  lineage: string;
  kind?: number;
  /** Core msg id (64 hex) of the message replied to. */
  replyTo?: string | null;
  ref?: MsgRefArg | null;
  body: MsgBody;
}
export interface DmPostArgs {
  recipient: Address;
  /** The recipient's published X25519 key (base58) the body is sealed to. */
  encKey: string;
  kind?: number;
  replyTo?: string | null;
  ref?: MsgRefArg | null;
  body: MsgBody;
}

const data = (name: string) => new Writer().bytes(ixDisc(name));
const writeConfig = (wr: Writer, a: MsgConfigArgs) =>
  wr.address(a.admin).bool(a.paused).u32(a.windowS).u16(a.maxPerWindow).u32(a.maxPerDay).u16(a.maxInline).u32(a.maxBlob);
const optFixed = (wr: Writer, v: string | null | undefined) => (v ? wr.u8(1).fixed32(v) : wr.u8(0));
const writeRef = (wr: Writer, ref: MsgRefArg | null | undefined) => (ref ? wr.u8(1).u8(refCode(ref.kind)).bytes(refIdBytes(ref.id)) : wr.u8(0));
function writeBody(wr: Writer, b: MsgBody): Writer {
  if ("inline" in b) return wr.u8(0).u32(b.inline.length).bytes(b.inline);
  return wr.u8(1).fixed32(b.blob.sha256).u32(b.blob.size);
}
const encKeyBytes = (k: string) => {
  const b = base58Decode(k);
  if (b.length !== 32) throw new Error("an X25519 key is 32 bytes");
  return b;
};

function postKeys(payer: Address, signer: Address, agent: Address, dmRecipient?: Address) {
  return [
    w(payer, true),
    r(signer, true),
    r(registryPdas.agent(agent)),
    r(msgPdas.config()),
    w(msgPdas.state(agent)),
    ...(dmRecipient ? [r(msgPdas.state(dmRecipient))] : []),
    r(SYSTEM_PROGRAM),
    r(msgPdas.eventAuthority()),
    r(MSG_PROGRAM_ID),
  ];
}

export const msg = {
  /** Upgrade authority, once. */
  initialize(a: { upgradeAuthority: Address; args: MsgConfigArgs }): Ix {
    return {
      programId: MSG_PROGRAM_ID,
      keys: [w(msgPdas.config()), w(a.upgradeAuthority, true), r(msgPdas.programData()), r(SYSTEM_PROGRAM)],
      data: writeConfig(data("initialize"), a.args).done(),
    };
  },
  setConfig(a: { admin: Address; args: MsgConfigArgs }): Ix {
    return { programId: MSG_PROGRAM_ID, keys: [w(msgPdas.config()), r(a.admin, true)], data: writeConfig(data("set_config"), a.args).done() };
  },
  /** `payer` pays the fee (the hosted runtime), `signer` is the agent's current registry signing key. */
  postBoard(a: { payer: Address; signer: Address; agent: Address; args: BoardPostArgs }): Ix {
    const x = a.args;
    const wr = data("post_board").fixed32(x.lineage).u8(x.kind ?? 0);
    optFixed(wr, x.replyTo);
    writeRef(wr, x.ref);
    return { programId: MSG_PROGRAM_ID, keys: postKeys(a.payer, a.signer, a.agent), data: writeBody(wr, x.body).done() };
  },
  postDm(a: { payer: Address; signer: Address; agent: Address; args: DmPostArgs }): Ix {
    const x = a.args;
    const wr = data("post_dm").address(x.recipient).bytes(encKeyBytes(x.encKey)).u8(x.kind ?? 0);
    optFixed(wr, x.replyTo);
    writeRef(wr, x.ref);
    return { programId: MSG_PROGRAM_ID, keys: postKeys(a.payer, a.signer, a.agent, x.recipient), data: writeBody(wr, x.body).done() };
  },
  publishEncKey(a: { payer: Address; signer: Address; agent: Address; encKey: string }): Ix {
    return { programId: MSG_PROGRAM_ID, keys: postKeys(a.payer, a.signer, a.agent), data: data("publish_enc_key").bytes(encKeyBytes(a.encKey)).done() };
  },
};

// ---------- accounts ----------

export interface MsgConfig extends MsgConfigArgs {}
export function decodeMsgConfig(d: Uint8Array): MsgConfig {
  const rd = new Reader(d).expect("MsgConfig");
  return { admin: rd.address(), paused: rd.bool(), windowS: rd.u32(), maxPerWindow: rd.u16(), maxPerDay: rd.u32(), maxInline: rd.u16(), maxBlob: rd.u32() };
}
export interface AgentMsgState {
  agent: Address;
  seq: bigint;
  windowStart: bigint;
  windowCount: number;
  dayStart: bigint;
  dayCount: number;
  /** base58 X25519 key, null if none published. */
  encKey: string | null;
  encKeySeq: number;
  encKeyAt: bigint;
}
const ZERO32 = "00".repeat(32);
export function decodeAgentMsgState(d: Uint8Array): AgentMsgState {
  const rd = new Reader(d).expect("AgentMsgState");
  const agent = rd.address();
  const seq = rd.u64();
  const windowStart = rd.i64();
  const windowCount = rd.u16();
  const dayStart = rd.i64();
  const dayCount = rd.u32();
  const key = rd.hex32();
  return { agent, seq, windowStart, windowCount, dayStart, dayCount, encKey: key === ZERO32 ? null : base58Encode(hexToBytes(key)), encKeySeq: rd.u32(), encKeyAt: rd.i64() };
}

// ---------- events ----------

export interface MsgRefOut {
  kind: RefKind;
  id: string;
}
interface MsgEventBase {
  agent: Address;
  signer: Address;
  /** unix seconds (program clock) */
  at: number;
}
export interface BoardPostedEvent extends MsgEventBase {
  type: "board";
  seq: bigint;
  lineage: string;
  kind: number;
  replyTo: string | null;
  ref: MsgRefOut | null;
  body: { inline: Uint8Array } | { blob: { sha256: string; size: number } };
}
export interface DmPostedEvent extends MsgEventBase {
  type: "dm";
  seq: bigint;
  recipient: Address;
  encKey: string;
  kind: number;
  replyTo: string | null;
  ref: MsgRefOut | null;
  body: { inline: Uint8Array } | { blob: { sha256: string; size: number } };
}
export interface EncKeyPublishedEvent extends MsgEventBase {
  type: "enc_key";
  encKey: string;
  keySeq: number;
}
export interface MsgConfigSetEvent {
  type: "config";
  args: MsgConfigArgs;
}
export type MsgEvent = BoardPostedEvent | DmPostedEvent | EncKeyPublishedEvent | MsgConfigSetEvent;

const eventDisc = (name: string) => sha256(`event:${name}`).subarray(0, 8);
const DISC = { board: eventDisc("BoardPosted"), dm: eventDisc("DmPosted"), key: eventDisc("EncKeyPublished"), config: eventDisc("MsgConfigSet") };
const same = (a: Uint8Array, b: Uint8Array) => a.length >= b.length && b.every((x, i) => a[i] === x);

function readOptHex(rd: Reader): string | null {
  return rd.u8() === 1 ? rd.hex32() : null;
}
function readRef(rd: Reader): MsgRefOut | null {
  if (rd.u8() !== 1) return null;
  const code = rd.u8();
  const kind = REF_KINDS[code - 1];
  const id = hexToBytes(rd.hex32());
  if (!kind) throw new Error(`unknown ref kind ${code}`);
  return { kind, id: refIdString(kind, id) };
}
function readBody(rd: Reader): BoardPostedEvent["body"] {
  const v = rd.u8();
  if (v === 0) return { inline: Uint8Array.from(rd.bytes(rd.u32())) };
  if (v === 1) return { blob: { sha256: rd.hex32(), size: rd.u32() } };
  throw new Error(`unknown body variant ${v}`);
}

/** Decodes one units_msg event (8-byte event discriminator + borsh), or null for another event. */
export function decodeMsgEvent(ev: Uint8Array): MsgEvent | null {
  const body = ev.subarray(8);
  const rd = new Reader(body);
  if (same(ev, DISC.board)) {
    const agent = rd.address();
    const signer = rd.address();
    const seq = rd.u64();
    const lineage = rd.hex32();
    const kind = rd.u8();
    const replyTo = readOptHex(rd);
    const ref = readRef(rd);
    const b = readBody(rd);
    return { type: "board", agent, signer, seq, lineage, kind, replyTo, ref, body: b, at: Number(rd.i64()) };
  }
  if (same(ev, DISC.dm)) {
    const agent = rd.address();
    const signer = rd.address();
    const seq = rd.u64();
    const recipient = rd.address();
    const encKey = base58Encode(hexToBytes(rd.hex32()));
    const kind = rd.u8();
    const replyTo = readOptHex(rd);
    const ref = readRef(rd);
    const b = readBody(rd);
    return { type: "dm", agent, signer, seq, recipient, encKey, kind, replyTo, ref, body: b, at: Number(rd.i64()) };
  }
  if (same(ev, DISC.key)) {
    return { type: "enc_key", agent: rd.address(), signer: rd.address(), encKey: base58Encode(hexToBytes(rd.hex32())), keySeq: rd.u32(), at: Number(rd.i64()) };
  }
  if (same(ev, DISC.config)) {
    return { type: "config", args: { admin: rd.address(), paused: rd.bool(), windowS: rd.u32(), maxPerWindow: rd.u16(), maxPerDay: rd.u32(), maxInline: rd.u16(), maxBlob: rd.u32() } };
  }
  return null;
}

/** A self-CPI inner instruction's data (tag + event); null when it is not an event. */
export function decodeEventIx(ixData: Uint8Array): MsgEvent | null {
  if (!same(ixData, EVENT_IX_TAG)) return null;
  return decodeMsgEvent(ixData.subarray(8));
}

/** An event read from a confirmed transaction. */
export type ChainMsgEvent = MsgEvent & { signature: string; slot: number; blockTime: number | null; ixIndex: number; feePayer: Address; fee: number };

/** getTransaction (encoding "json") result, as far as the parser reads it. */
export interface RawTx {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: { err: unknown; fee: number; innerInstructions?: { index: number; instructions: { programIdIndex: number; data: string; accounts?: number[] }[] }[] | null; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
}

/**
 * Every units_msg event of a successful transaction. An event counts only when it is an inner
 * instruction to units_msg whose first account is the program's event authority: only the program
 * can sign as it (emit_cpi), so events cannot be forged by another program or a top-level call.
 */
export function parseMsgTransaction(tx: RawTx, program: Address = MSG_PROGRAM_ID): ChainMsgEvent[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const auth = msgPdas.eventAuthority();
  const out: ChainMsgEvent[] = [];
  for (const group of tx.meta.innerInstructions ?? [])
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== program) continue;
      if (ix.accounts && ix.accounts.length && keys[ix.accounts[0]!] !== auth) continue;
      const ev = decodeEventIx(base58Decode(ix.data));
      if (ev)
        out.push({ ...ev, signature: tx.transaction.signatures[0]!, slot: tx.slot, blockTime: tx.blockTime ?? null, ixIndex: group.index, feePayer: tx.transaction.message.accountKeys[0]!, fee: tx.meta.fee });
    }
  return out;
}

/**
 * New units_msg transactions since `until` (exclusive), oldest first, with their events. Pages
 * getSignaturesForAddress backwards until it reaches `until` (or the program's first transaction).
 */
export async function fetchMsgEvents(rpc: Rpc, o: { until?: string | null; program?: Address; pageLimit?: number; maxPages?: number } = {}): Promise<{ events: ChainMsgEvent[]; newest: string | null; transactions: number }> {
  const program = o.program ?? MSG_PROGRAM_ID;
  const sigs: { signature: string; err: unknown; slot: number }[] = [];
  let before: string | undefined;
  for (let page = 0; page < (o.maxPages ?? 50); page++) {
    const batch = await rpc.call<{ signature: string; err: unknown; slot: number }[]>("getSignaturesForAddress", [
      program,
      { limit: o.pageLimit ?? 1000, commitment: rpc.commitment === "processed" ? "confirmed" : rpc.commitment, ...(before ? { before } : {}), ...(o.until ? { until: o.until } : {}) },
    ]);
    sigs.push(...batch);
    if (batch.length < (o.pageLimit ?? 1000)) break;
    before = batch[batch.length - 1]!.signature;
  }
  const newest = sigs[0]?.signature ?? o.until ?? null;
  const events: ChainMsgEvent[] = [];
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    const tx = await rpc.call<RawTx | null>("getTransaction", [s.signature, { encoding: "json", commitment: rpc.commitment === "processed" ? "confirmed" : rpc.commitment, maxSupportedTransactionVersion: 0 }]);
    if (tx) events.push(...parseMsgTransaction(tx, program));
  }
  return { events, newest, transactions: sigs.length };
}

export async function readMsgConfig(rpc: Rpc): Promise<MsgConfig | null> {
  const a = await rpc.getAccountInfo(msgPdas.config());
  if (!a) return null;
  if (a.owner !== MSG_PROGRAM_ID) throw new Error(`${a.address} is not owned by units_msg`);
  return decodeMsgConfig(a.data);
}
export async function readMsgState(rpc: Rpc, agent: Address): Promise<AgentMsgState | null> {
  const a = await rpc.getAccountInfo(msgPdas.state(agent));
  if (!a) return null;
  if (a.owner !== MSG_PROGRAM_ID) throw new Error(`${a.address} is not owned by units_msg`);
  return decodeAgentMsgState(a.data);
}
/** Every AgentMsgState (one getProgramAccounts). */
export async function readMsgStates(rpc: Rpc): Promise<AgentMsgState[]> {
  const all = await rpc.getProgramAccounts(MSG_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("AgentMsgState") }] });
  return all.map((a) => decodeAgentMsgState(a.data));
}

