import { accountDisc, addressBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { BPF_LOADER_UPGRADEABLE, pda, SYSTEM_PROGRAM, u64le } from "./pda.ts";
import { r, w, type AccountMeta, type Ix } from "./registry.ts";

// Squads v4 multisig plumbing (M2, docs/MAINNET-RUNBOOK.md): every admin instruction of the Lineage
// programs is built here as a vault transaction, proposed, approved by the threshold, and executed
// after the multisig's time lock. No SDK: the encodings follow the program's own IDL
// (@sqds/multisig 2.1.4, idl/squads_multisig_program.json, Anchor 0.29) and its TypeScript
// `transactionMessageBeet` and `accountsForTransactionExecute`, read 2026-10-10.
// Program id: the same on mainnet and devnet (github.com/Squads-Protocol/v4 README); on mainnet its
// upgrade authority is none (immutable, read with `solana program show` 2026-10-10).

export const SQUADS_PROGRAM_ID: Address = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const P = SQUADS_PROGRAM_ID;

/** Member permission bits (Permission::Initiate, Vote, Execute). */
export const SQUADS_PERM = { initiate: 1, vote: 2, execute: 4, all: 7 } as const;

const enc = (s: string) => new TextEncoder().encode(s);
const u8b = (n: number) => Uint8Array.of(n);

export const squadsPdas = {
  programConfig: (): Address => pda(P, "multisig", "program_config"),
  multisig: (createKey: Address): Address => pda(P, "multisig", "multisig", addressBytes(createKey)),
  vault: (multisig: Address, index = 0): Address => pda(P, "multisig", addressBytes(multisig), "vault", u8b(index)),
  transaction: (multisig: Address, index: bigint | number): Address => pda(P, "multisig", addressBytes(multisig), "transaction", u64le(index)),
  proposal: (multisig: Address, index: bigint | number): Address =>
    pda(P, "multisig", addressBytes(multisig), "transaction", u64le(index), "proposal"),
  ephemeralSigner: (transaction: Address, index: number): Address => pda(P, "multisig", addressBytes(transaction), "ephemeral_signer", u8b(index)),
};

export interface SquadsMember {
  key: Address;
  /** SQUADS_PERM bits. */
  permissions: number;
}

const optAddress = (wr: Writer, a: Address | null | undefined) => (a ? wr.u8(1).address(a) : wr.u8(0));
const optString = (wr: Writer, s: string | null | undefined) => (s ? wr.u8(1).string(s) : wr.u8(0));
const bytesVec = (wr: Writer, b: Uint8Array) => wr.u32(b.length).bytes(b);

// ---------------------------------------------------------------- the wrapped message

/** A vault transaction's inner message: the vault pays and signs, keys ordered as a legacy message. */
export interface VaultMessage {
  bytes: Uint8Array;
  keys: Address[];
  numSigners: number;
  numWritableSigners: number;
  numWritableNonSigners: number;
}

/** Compiles instructions into Squads' `TransactionMessage` (u8 lengths, u16 data length, no lookup tables). */
export function compileVaultMessage(vault: Address, ixs: Ix[]): VaultMessage {
  const metas = new Map<Address, { signer: boolean; writable: boolean; order: number }>();
  let order = 0;
  const add = (m: AccountMeta) => {
    const cur = metas.get(m.pubkey);
    if (cur) {
      cur.signer ||= m.isSigner;
      cur.writable ||= m.isWritable;
    } else metas.set(m.pubkey, { signer: m.isSigner, writable: m.isWritable, order: order++ });
  };
  add({ pubkey: vault, isSigner: true, isWritable: true });
  for (const ix of ixs) {
    for (const k of ix.keys) add(k);
    add({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  const all = [...metas.entries()];
  const group = (s: boolean, wr: boolean) =>
    all.filter(([k, m]) => m.signer === s && m.writable === wr && k !== vault).sort((a, b) => a[1].order - b[1].order).map(([k]) => k);
  const ws = [vault, ...group(true, true)];
  const rs = group(true, false);
  const wu = group(false, true);
  const ru = group(false, false);
  const keys = [...ws, ...rs, ...wu, ...ru];
  if (keys.length > 255) throw new Error("too many accounts for one vault transaction");
  const index = new Map(keys.map((k, i) => [k, i]));
  const wr = new Writer();
  wr.u8(ws.length + rs.length).u8(ws.length).u8(wu.length);
  wr.u8(keys.length);
  for (const k of keys) wr.address(k);
  wr.u8(ixs.length);
  for (const ix of ixs) {
    wr.u8(index.get(ix.programId)!);
    wr.u8(ix.keys.length);
    for (const k of ix.keys) wr.u8(index.get(k.pubkey)!);
    wr.u16(ix.data.length).bytes(ix.data);
  }
  wr.u8(0); // address table lookups
  return { bytes: wr.done(), keys, numSigners: ws.length + rs.length, numWritableSigners: ws.length, numWritableNonSigners: wu.length };
}

/**
 * The remaining accounts `vault_transaction_execute` needs, in message order: the vault (and any
 * ephemeral signer PDA) never marked as a signer, any other message signer is (it must sign the
 * execute transaction itself).
 */
export function executeAccounts(m: VaultMessage, vault: Address, ephemeral: Address[] = []): AccountMeta[] {
  return m.keys.map((k, i) => ({
    pubkey: k,
    isWritable: i < m.numWritableSigners || (i >= m.numSigners && i - m.numSigners < m.numWritableNonSigners),
    isSigner: i < m.numSigners && k !== vault && !ephemeral.includes(k),
  }));
}

// ---------------------------------------------------------------- instructions

export type SquadsConfigAction =
  | { kind: "addMember"; member: SquadsMember }
  | { kind: "removeMember"; member: Address }
  | { kind: "changeThreshold"; threshold: number }
  | { kind: "setTimeLock"; seconds: number }
  | { kind: "setRentCollector"; collector: Address | null };

function writeAction(wr: Writer, a: SquadsConfigAction) {
  switch (a.kind) {
    case "addMember":
      return wr.u8(0).address(a.member.key).u8(a.member.permissions);
    case "removeMember":
      return wr.u8(1).address(a.member);
    case "changeThreshold":
      return wr.u8(2).u16(a.threshold);
    case "setTimeLock":
      return wr.u8(3).u32(a.seconds);
    case "setRentCollector":
      return optAddress(wr.u8(6), a.collector);
  }
}

export const squads = {
  /** `multisig_create_v2`: an autonomous multisig (no config authority) unless `configAuthority` is given. */
  multisigCreateV2(a: {
    createKey: Address;
    creator: Address;
    treasury: Address;
    members: SquadsMember[];
    threshold: number;
    timeLockS: number;
    configAuthority?: Address | null;
    rentCollector?: Address | null;
    memo?: string | null;
  }): Ix {
    const wr = new Writer().bytes(ixDisc("multisig_create_v2"));
    optAddress(wr, a.configAuthority);
    wr.u16(a.threshold).u32(a.members.length);
    for (const m of a.members) wr.address(m.key).u8(m.permissions);
    wr.u32(a.timeLockS);
    optAddress(wr, a.rentCollector);
    optString(wr, a.memo);
    return {
      programId: P,
      keys: [r(squadsPdas.programConfig()), w(a.treasury), w(squadsPdas.multisig(a.createKey)), r(a.createKey, true), w(a.creator, true), r(SYSTEM_PROGRAM)],
      data: wr.done(),
    };
  },
  vaultTransactionCreate(a: { multisig: Address; index: bigint | number; creator: Address; rentPayer: Address; message: Uint8Array; vaultIndex?: number;
    ephemeralSigners?: number; memo?: string | null }): Ix {
    const wr = new Writer().bytes(ixDisc("vault_transaction_create")).u8(a.vaultIndex ?? 0).u8(a.ephemeralSigners ?? 0);
    bytesVec(wr, a.message);
    optString(wr, a.memo);
    return {
      programId: P,
      keys: [w(a.multisig), w(squadsPdas.transaction(a.multisig, a.index)), r(a.creator, true), w(a.rentPayer, true), r(SYSTEM_PROGRAM)],
      data: wr.done(),
    };
  },
  configTransactionCreate(a: { multisig: Address; index: bigint | number; creator: Address; rentPayer: Address; actions: SquadsConfigAction[]; memo?: string | null }): Ix {
    const wr = new Writer().bytes(ixDisc("config_transaction_create")).u32(a.actions.length);
    for (const x of a.actions) writeAction(wr, x);
    optString(wr, a.memo);
    return {
      programId: P,
      keys: [w(a.multisig), w(squadsPdas.transaction(a.multisig, a.index)), r(a.creator, true), w(a.rentPayer, true), r(SYSTEM_PROGRAM)],
      data: wr.done(),
    };
  },
  proposalCreate(a: { multisig: Address; index: bigint | number; creator: Address; rentPayer: Address; draft?: boolean }): Ix {
    return {
      programId: P,
      keys: [r(a.multisig), w(squadsPdas.proposal(a.multisig, a.index)), r(a.creator, true), w(a.rentPayer, true), r(SYSTEM_PROGRAM)],
      data: new Writer().bytes(ixDisc("proposal_create")).u64(a.index).bool(a.draft ?? false).done(),
    };
  },
  proposalApprove(a: { multisig: Address; index: bigint | number; member: Address; memo?: string | null }): Ix {
    const wr = new Writer().bytes(ixDisc("proposal_approve"));
    optString(wr, a.memo);
    return { programId: P, keys: [r(a.multisig), w(a.member, true), w(squadsPdas.proposal(a.multisig, a.index))], data: wr.done() };
  },
  proposalReject(a: { multisig: Address; index: bigint | number; member: Address; memo?: string | null }): Ix {
    const wr = new Writer().bytes(ixDisc("proposal_reject"));
    optString(wr, a.memo);
    return { programId: P, keys: [r(a.multisig), w(a.member, true), w(squadsPdas.proposal(a.multisig, a.index))], data: wr.done() };
  },
  vaultTransactionExecute(a: { multisig: Address; index: bigint | number; member: Address; message: VaultMessage; vaultIndex?: number }): Ix {
    const vault = squadsPdas.vault(a.multisig, a.vaultIndex ?? 0);
    return {
      programId: P,
      keys: [r(a.multisig), w(squadsPdas.proposal(a.multisig, a.index)), r(squadsPdas.transaction(a.multisig, a.index)), r(a.member, true),
        ...executeAccounts(a.message, vault)],
      data: ixDisc("vault_transaction_execute"),
    };
  },
  configTransactionExecute(a: { multisig: Address; index: bigint | number; member: Address; rentPayer?: Address }): Ix {
    const keys = [w(a.multisig), r(a.member, true), w(squadsPdas.proposal(a.multisig, a.index)), r(squadsPdas.transaction(a.multisig, a.index))];
    // Anchor 0.29 optional accounts: the program id stands in for an absent one.
    keys.push(a.rentPayer ? w(a.rentPayer, true) : r(P), a.rentPayer ? r(SYSTEM_PROGRAM) : r(P));
    return { programId: P, keys, data: ixDisc("config_transaction_execute") };
  },
};

// ---------------------------------------------------------------- the upgradeable loader

export const programDataAddress = (program: Address): Address => pda(BPF_LOADER_UPGRADEABLE, addressBytes(program));
const SYSVAR_RENT = "SysvarRent111111111111111111111111111111111";
const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

export const loader = {
  /** `Upgrade`: replaces `program`'s code with `buffer` (whose authority must be `authority`); buffer lamports go to `spill`. */
  upgrade(a: { program: Address; buffer: Address; spill: Address; authority: Address }): Ix {
    return {
      programId: BPF_LOADER_UPGRADEABLE,
      keys: [w(programDataAddress(a.program)), w(a.program), w(a.buffer), w(a.spill), r(SYSVAR_RENT), r(SYSVAR_CLOCK), r(a.authority, true)],
      data: Uint8Array.of(3, 0, 0, 0),
    };
  },
  /** `SetAuthority` on a program's ProgramData (or a buffer); `newAuthority` null makes the program immutable. */
  setAuthority(a: { account: Address; authority: Address; newAuthority: Address | null }): Ix {
    const keys = [w(a.account), r(a.authority, true)];
    if (a.newAuthority) keys.push(r(a.newAuthority));
    return { programId: BPF_LOADER_UPGRADEABLE, keys, data: Uint8Array.of(4, 0, 0, 0) };
  },
};

/** The upgrade authority recorded in a ProgramData or Buffer account, or null when none. */
export function decodeLoaderAuthority(d: Uint8Array): Address | null {
  const kind = d[0];
  const at = kind === 3 ? 12 : kind === 1 ? 4 : -1; // ProgramData: tag u32, slot u64, Option; Buffer: tag u32, Option
  if (at < 0) throw new Error("not a ProgramData or Buffer account");
  return d[at] === 1 ? new Reader(d.subarray(at + 1, at + 33)).address() : null;
}

// ---------------------------------------------------------------- accounts

export interface SquadsProgramConfig {
  authority: Address;
  multisigCreationFee: bigint;
  treasury: Address;
}
export function decodeSquadsProgramConfig(d: Uint8Array): SquadsProgramConfig {
  const rd = new Reader(d).expect("ProgramConfig");
  return { authority: rd.address(), multisigCreationFee: rd.u64(), treasury: rd.address() };
}

export interface SquadsMultisig {
  createKey: Address;
  configAuthority: Address;
  threshold: number;
  timeLock: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  rentCollector: Address | null;
  members: SquadsMember[];
}
export function decodeSquadsMultisig(d: Uint8Array): SquadsMultisig {
  const rd = new Reader(d).expect("Multisig");
  const createKey = rd.address(), configAuthority = rd.address(), threshold = rd.u16(), timeLock = rd.u32();
  const transactionIndex = rd.u64(), staleTransactionIndex = rd.u64();
  const rentCollector = rd.u8() === 1 ? rd.address() : null;
  rd.u8(); // bump
  const n = rd.u32();
  const members: SquadsMember[] = [];
  for (let i = 0; i < n; i++) members.push({ key: rd.address(), permissions: rd.u8() });
  return { createKey, configAuthority, threshold, timeLock, transactionIndex, staleTransactionIndex, rentCollector, members };
}

export const PROPOSAL_STATUS = ["Draft", "Active", "Rejected", "Approved", "Executing", "Executed", "Cancelled"] as const;
export interface SquadsProposal {
  multisig: Address;
  transactionIndex: bigint;
  status: (typeof PROPOSAL_STATUS)[number];
  /** Unix seconds of the last status change (none for Executing). */
  statusTs: bigint | null;
  approved: Address[];
  rejected: Address[];
}
export function decodeSquadsProposal(d: Uint8Array): SquadsProposal {
  const rd = new Reader(d).expect("Proposal");
  const multisig = rd.address(), transactionIndex = rd.u64();
  const tag = rd.u8();
  const statusTs = tag === 4 ? null : rd.i64();
  rd.u8(); // bump
  const list = () => Array.from({ length: rd.u32() }, () => rd.address());
  return { multisig, transactionIndex, status: PROPOSAL_STATUS[tag]!, statusTs, approved: list(), rejected: list() };
}

export const SQUADS_ACCOUNT_DISC = { multisig: accountDisc("Multisig"), proposal: accountDisc("Proposal") };

export interface SquadsVaultTransaction {
  multisig: Address;
  creator: Address;
  index: bigint;
  vaultIndex: number;
  /** The stored message, in the shape `vaultTransactionExecute` takes (`bytes` is empty). */
  message: VaultMessage;
  instructions: { programId: Address; accounts: Address[]; data: Uint8Array }[];
}
/** A stored vault transaction (borsh: u32 vector lengths), so a member can execute what was proposed without rebuilding it. */
export function decodeSquadsVaultTransaction(d: Uint8Array): SquadsVaultTransaction {
  const rd = new Reader(d).expect("VaultTransaction");
  const multisig = rd.address(), creator = rd.address(), index = rd.u64();
  rd.u8(); // bump
  const vaultIndex = rd.u8();
  rd.u8(); // vault bump
  rd.bytes(rd.u32()); // ephemeral signer bumps
  const numSigners = rd.u8(), numWritableSigners = rd.u8(), numWritableNonSigners = rd.u8();
  const keys = Array.from({ length: rd.u32() }, () => rd.address());
  const instructions = Array.from({ length: rd.u32() }, () => {
    const programId = keys[rd.u8()]!;
    const accounts = Array.from(rd.bytes(rd.u32())).map((i) => keys[i]!);
    return { programId, accounts, data: Uint8Array.from(rd.bytes(rd.u32())) };
  });
  if (rd.u32() !== 0) throw new Error("vault transactions with lookup tables are not supported here");
  return { multisig, creator, index, vaultIndex, message: { bytes: new Uint8Array(), keys, numSigners, numWritableSigners, numWritableNonSigners }, instructions };
}
