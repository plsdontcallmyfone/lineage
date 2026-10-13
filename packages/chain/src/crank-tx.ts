import type { Address } from "./codec.ts";
import { authorizeSigners } from "./guard.ts";
import type { Ix } from "./registry.ts";
import type { AccountInfo, Rpc } from "./rpc.ts";
import { TxError, withBudget, withProfileFees, type SendOptions, type SendResult } from "./sender.ts";
import { compileMessage, PACKET_LIMIT, signMessageWith, type CompiledMessage, type SignedTx, type Signer } from "./tx.ts";
import { ALT_PROGRAM, compileMessageV0, decodeLookupTable, wireSize, type LookupTable } from "./v0.ts";

// One send path for a transaction that may or may not fit a legacy message (the agent fee crank:
// scripts/mainnet/crank-fees.ts). The form is chosen from the size of the exact message that is
// signed, compute budget instructions included: legacy when it fits the packet, version 0 with the
// given address lookup tables when legacy does not fit and version 0 does, and a refusal that
// states both sizes otherwise. Nothing here creates or changes a table.

export type TxForm = "legacy" | "v0";

export interface FittedMessage {
  form: TxForm;
  msg: CompiledMessage;
  /** Wire size of the chosen form, signatures included. */
  size: number;
  legacySize: number;
  /** null when no table was given or legacy fits (version 0 is not compiled then). */
  v0Size: number | null;
  /** Accounts the chosen message loads from tables (0 for legacy). */
  loaded: number;
}

export class TxTooLargeError extends Error {
  constructor(readonly legacySize: number, readonly v0Size: number | null) {
    super(`transaction does not fit the ${PACKET_LIMIT}-byte packet: ${legacySize} bytes as a legacy transaction, ${v0Size === null ? "no usable lookup table for a version 0 one" : `${v0Size} bytes as a version 0 transaction with the lookup table`}`);
  }
}

/** Legacy when it fits the packet, version 0 with `tables` when only that fits, TxTooLargeError otherwise. Pure. */
export function fitMessage(payer: Address, ixs: Ix[], recentBlockhash: string, tables: LookupTable[] = []): FittedMessage {
  const legacy = compileMessage(payer, ixs, recentBlockhash), legacySize = wireSize(legacy);
  if (legacySize <= PACKET_LIMIT) return { form: "legacy", msg: legacy, size: legacySize, legacySize, v0Size: null, loaded: 0 };
  if (!tables.length) throw new TxTooLargeError(legacySize, null);
  const v0 = compileMessageV0(payer, ixs, recentBlockhash, tables), v0Size = wireSize(v0);
  if (v0Size > PACKET_LIMIT) throw new TxTooLargeError(legacySize, v0Size);
  return { form: "v0", msg: v0, size: v0Size, legacySize, v0Size, loaded: v0.loaded.writable.length + v0.loaded.readonly.length };
}

const NEVER_DEACTIVATED = 0xffff_ffff_ffff_ffffn;

/**
 * Whether the account at `address` is a lookup table a transaction built at `slot` can load from:
 * owned by the lookup table program, not deactivated, holding addresses, and not extended in the
 * current slot (addresses appended in a slot are loadable from the next one). Pure.
 */
export function usableLookupTable(address: Address, account: Pick<AccountInfo, "owner" | "data"> | null, slot: number): { table: LookupTable | null; reason: string } {
  if (!account) return { table: null, reason: "no account at that address" };
  if (account.owner !== ALT_PROGRAM) return { table: null, reason: "not owned by the address lookup table program" };
  let t;
  try {
    t = decodeLookupTable(account.data);
  } catch (e) {
    return { table: null, reason: (e as Error).message };
  }
  if (t.deactivationSlot !== NEVER_DEACTIVATED) return { table: null, reason: `deactivated at slot ${t.deactivationSlot}` };
  if (!t.addresses.length) return { table: null, reason: "holds no addresses" };
  if (t.lastExtendedSlot >= BigInt(slot)) return { table: null, reason: `extended at slot ${t.lastExtendedSlot}, loadable from the next slot` };
  return { table: { address, addresses: t.addresses }, reason: t.authority === null ? "frozen" : `authority ${t.authority}` };
}

/** Reads a lookup table and says whether it is usable now (usableLookupTable). */
export async function loadLookupTable(rpc: Rpc, address: Address): Promise<{ table: LookupTable | null; reason: string }> {
  const [account, slot] = await Promise.all([rpc.getAccountInfo(address), rpc.getSlot()]);
  return usableLookupTable(address, account, slot);
}

export type FittedOptions = Omit<SendOptions, "signers"> & { tables?: LookupTable[] };

export interface BuiltFitted {
  tx: SignedTx;
  fit: FittedMessage;
  lastValidBlockHeight: number;
  /** The options after the profile's fee policy: pass them back to sendFitted so the same price is used. */
  options: FittedOptions;
}

/** The signed transaction a send would broadcast now: fee policy and budget applied, form chosen by size. Sends nothing. */
export async function buildFitted(rpc: Rpc, payer: Signer, ixs: Ix[], opts: FittedOptions = {}): Promise<BuiltFitted> {
  const options: FittedOptions = { ...(await withProfileFees(rpc, payer.id, ixs, opts)), tables: opts.tables };
  const all = withBudget(ixs, options);
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const fit = fitMessage(payer.id, all, blockhash, options.tables ?? []);
  await authorizeSigners(fit.msg.bytes, [payer.id]);
  return { tx: signMessageWith(fit.msg, [payer]), fit, lastValidBlockHeight, options };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** sendAndConfirm for one signer, with the form chosen by size (buildFitted): simulated, sent, rebroadcast, rebuilt on an expired blockhash. */
export async function sendFitted(rpc: Rpc, payer: Signer, ixs: Ix[], opts: FittedOptions = {}): Promise<SendResult & { form: TxForm; size: number }> {
  const attempts = opts.attempts ?? 3;
  let o = opts;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const b = await buildFitted(rpc, payer, ixs, o);
    o = b.options;
    const { tx, fit } = b;
    if (!o.skipSimulation) {
      const sim = await rpc.simulate(tx.wire);
      if (sim.err) throw new TxError(`simulation failed: ${JSON.stringify(sim.err)}`, sim.logs ?? []);
    }
    await rpc.sendRawTransaction(tx.wire, true);
    o.log?.(`sent ${tx.signature} (${fit.form}, ${fit.size} bytes, attempt ${attempt})`);
    let lastSend = Date.now();
    for (;;) {
      await sleep(800);
      const [st] = await rpc.getSignatureStatuses([tx.signature]);
      if (st?.err) {
        const t = await rpc.getTransaction(tx.signature).catch(() => null);
        throw new TxError(`transaction failed: ${JSON.stringify(st.err)}`, t?.meta?.logMessages ?? [], tx.signature);
      }
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        const t = await rpc.getTransaction(tx.signature).catch(() => null);
        return { signature: tx.signature, slot: st.slot, fee: t?.meta?.fee, computeUnits: t?.meta?.computeUnitsConsumed, logs: t?.meta?.logMessages ?? [], form: fit.form, size: fit.size };
      }
      if ((await rpc.getBlockHeight()) > b.lastValidBlockHeight) {
        const [late] = await rpc.getSignatureStatuses([tx.signature]);
        if (late && !late.err) continue;
        o.log?.(`blockhash expired for ${tx.signature}; rebuilding`);
        break;
      }
      if (Date.now() - lastSend > (o.rebroadcastMs ?? 2500)) {
        await rpc.sendRawTransaction(tx.wire, true).catch(() => undefined);
        lastSend = Date.now();
      }
    }
  }
  throw new TxError(`not confirmed after ${attempts} blockhashes`);
}
