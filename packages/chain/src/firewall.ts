import { ixDisc, toAddress, type Address } from "./codec.ts";
import { ASSOCIATED_TOKEN_PROGRAM, BPF_LOADER_UPGRADEABLE, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda.ts";
import { msgPdas } from "./msg.ts";
import { MSG_PROGRAM_ID, LAUNCH_PROGRAM_ID, REGISTRY_PROGRAM_ID } from "./programs.ts";
import { PUMP } from "./pump.ts";
import { registryPdas } from "./registry.ts";
import { COMPUTE_BUDGET_PROGRAM } from "./tx.ts";
import { ALT_PROGRAM } from "./v0.ts";

// The transaction firewall's policy (docs/plans/AGENT-WALLET-SAFETY.md section 3.3): a pure function
// from the bytes an agent treasury key is asked to sign to allow or refuse. It never trusts the
// caller's description of the transaction: it parses the message itself (strictly: exact length,
// canonical lengths, no duplicate keys, every index in range, every lookup resolved). The allowlist
// is closed: anything it does not recognise is refused.
//
// Agents do not trade (owner decision 2026-10-12). An agent key signs no swap at all: the earlier
// allowance for pump.fun and PumpSwap swaps is gone, and with it every instruction in which the key
// paid or held anything. What is left moves nothing: the agent's own units_msg posts, its own bind
// (rotate_agent_key as the new key) and its own set_profile, each with the key as a read-only signer
// that is never the fee payer.

export interface FirewallContext {
  /** the guarded treasury key */
  key: Address;
  /** the agent this key signs for (null: the key belongs to no known agent, so nothing is allowed) */
  agent: Address | null;
  /** frozen, live lookup tables read from chain by the firewall: address -> its addresses */
  tables: Map<Address, Address[]>;
}

export type Verdict =
  | { ok: true; kind: "message" | "registry"; summary: string }
  | { ok: false; rule: string; detail: string };

const refuse = (rule: string, detail: string): Verdict => ({ ok: false, rule, detail });

export const MAX_CU_LIMIT = 1_400_000;

/** Names for the detail of a refusal; the policy itself is the allowlist, not this table. */
const KNOWN: Record<string, string> = {
  [SYSTEM_PROGRAM]: "System",
  [TOKEN_PROGRAM]: "SPL Token",
  [TOKEN_2022_PROGRAM]: "Token-2022",
  [ASSOCIATED_TOKEN_PROGRAM]: "Associated Token",
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

/** Programs that swap. Listed only to name the refusal: no instruction for them is ever allowed. */
const SWAP_PROGRAMS: Record<string, string> = { [PUMP.program]: "pump.fun", [PUMP.amm]: "PumpSwap", JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter" };

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

const starts = (d: Uint8Array, disc: Uint8Array) => d.length >= 8 && disc.every((x, i) => x === d[i]);
const u64 = (d: Uint8Array, o: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]!);
  return v;
};
const u32 = (d: Uint8Array, o: number): number => (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;

const DISC = {
  postBoard: ixDisc("post_board"),
  postDm: ixDisc("post_dm"),
  publishEncKey: ixDisc("publish_enc_key"),
  rotate: ixDisc("rotate_agent_key"),
  setProfile: ixDisc("set_profile"),
};

// ------------------------------------------------------------------------------------------------
// the policy

const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95" as Address;

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
  // no swap, whoever asks and whatever else the message carries
  for (const ix of m.instructions) {
    const venue = SWAP_PROGRAMS[ix.programId];
    if (venue) return refuse("swap_not_allowed", `instruction for ${venue} (${ix.programId}): agents do not trade, an agent key signs no swap`);
  }
  const at = m.keys.indexOf(c.key);
  if (at < 0 || at >= m.numSigners) return refuse("not_a_signer", "the key is not a signer of this message");
  const isPayer = at === 0;
  const readonlySigner = at >= m.numSigners - m.numReadonlySigned;
  if (!c.agent) return refuse("unknown_agent", "this key belongs to no agent the runtime knows");

  // every program must be on the list; nothing else is looked at before this holds
  const allowed = new Set<Address>([COMPUTE_BUDGET_PROGRAM, MSG_PROGRAM_ID, REGISTRY_PROGRAM_ID]);
  // A wallet's own guard (Phantom adds Lighthouse assertions to what its owner signs, as on the bind): passed
  // over when it does not name the guarded key. The key still has to be a read-only signer that pays nothing.
  const guard = (ix: ParsedIx) => ix.programId === LIGHTHOUSE_PROGRAM && ix.accounts.every((a) => a.pubkey !== c.key);
  for (const ix of m.instructions) if (!allowed.has(ix.programId) && !guard(ix)) return refuse("program_not_allowed", `instruction for ${nameOf(ix.programId)} (${ix.programId})`);

  // compute budget
  let cuLimit: number | null = null;
  let cuPrice: bigint | null = null;
  const rest: ParsedIx[] = [];
  for (const ix of m.instructions) {
    if (guard(ix)) continue;
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

  const kinds = new Set(rest.map((ix) => (ix.programId === MSG_PROGRAM_ID ? "message" : "registry")));
  if (kinds.size !== 1) return refuse("mixed_kinds", `one transaction is a message or a registry call, never ${[...kinds].join(" and ")}`);
  const kind = [...kinds][0]! as "message" | "registry";

  // the key never pays and never holds: someone else (the runtime authority or the owner's wallet) is the fee payer
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
  return { ok: true, kind, summary: `${kind}: ${rest.length} instruction(s), the key signs read-only and pays nothing` };
}
