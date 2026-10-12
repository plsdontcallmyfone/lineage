import { base58Decode } from "@units/protocol";
import {
  ata, compileMessage, computeBudget, decodeBondingCurve, decodeMint, decodePumpEvent, decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount,
  PACKET_LIMIT, PUMP, pumpPdas, signMessageWith, SYSTEM_PROGRAM, TOKEN_PROGRAM, wireSize,
  type Address, type Ix, type Rpc, type Signer,
} from "@units/chain";
import { priorityFee, writableAccounts } from "../../chain/src/fees.ts";
import type { KeeperConfig } from "./config.ts";
import { actionIxs, mayCreate, phaseOf, type PoolSnapshot, type Snapshot } from "./plans.ts";
import type { Action } from "./state.ts";

// The keeper's view of the chain. `Chain` is everything keeper.ts needs, in the keeper's own terms
// (an Action, not instructions), so the state machine is tested against a model of the chain that can
// be stopped at any point; RpcChain is the real one, over JSON-RPC.

export const MAX_COMPUTE_UNITS = 400_000;
const BASE_FEE = 5_000n;
/** The most a one-signature transaction can cost in fees at this limit and price. */
export const feeBound = (cuLimit: number, microLamports: number): bigint => BASE_FEE + (BigInt(cuLimit) * BigInt(microLamports) + 999_999n) / 1_000_000n;

export interface Sim {
  ok: boolean;
  error: string | null;
  logs: string[];
  units: number;
  /** Change of the wallet's lamports the simulation ended with (the RPC may or may not have taken the fee). */
  walletDelta: bigint;
  /** Lamports that went into accounts this transaction creates. */
  createdRent: bigint;
  /** Wire size of the transaction with its compute budget instructions. */
  size: number;
}

export interface Prepared {
  wire: Uint8Array;
  signature: string;
  lastValidBlockHeight: number;
}

export interface Outcome {
  /** Null when the transaction succeeded. */
  err: string | null;
  slot: number;
  walletDelta: bigint;
  fee: bigint;
  /** Lamports in accounts that did not exist before the transaction and do after (rent the wallet paid). */
  createdRent: bigint;
  /** Creator fees paid out to the wallet (Pump CollectCreatorFeeEvent + PumpSwap CollectCoinCreatorFeeEvent). */
  collected: bigint;
  units: number | null;
}

export interface Chain {
  read(): Promise<Snapshot>;
  /** Micro-lamports per compute unit for this transaction, already under the configured cap. */
  price(a: Action, s: Snapshot): Promise<number>;
  simulate(a: Action, s: Snapshot): Promise<Sim>;
  /** Whether the action fits one transaction (a buy with its burn). */
  fits(a: Action, s: Snapshot): boolean;
  sign(a: Action, s: Snapshot, cuLimit: number, microLamports: number): Promise<Prepared>;
  submit(wire: Uint8Array): Promise<void>;
  /** "landed": confirmed, with or without a program error. "unknown": not seen (yet). */
  status(signature: string): Promise<"landed" | "unknown">;
  blockHeight(): Promise<number>;
  outcome(signature: string): Promise<Outcome>;
}

interface TxJson {
  slot: number;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; computeUnitsConsumed?: number; innerInstructions?: { instructions: { data: string }[] }[] };
  transaction: { message: { accountKeys: string[] } };
}

export class RpcChain implements Chain {
  constructor(
    readonly rpc: Rpc,
    readonly cfg: KeeperConfig,
    /** Null: reads and simulations only. */
    readonly signer: Signer | null,
  ) {}

  private genesis: string | null = null;
  private rents: [bigint, bigint] | null = null;

  async read(): Promise<Snapshot> {
    const { cfg, rpc } = this;
    this.genesis ??= await rpc.call<string>("getGenesisHash");
    this.rents ??= [await rpc.getMinimumBalanceForRentExemption(0), await rpc.getMinimumBalanceForRentExemption(165)];
    const curveAddr = pumpPdas.bondingCurve(cfg.mint), vaultAddr = pumpPdas.creatorVault(cfg.creator);
    const [mintA, curveA, walletA, vaultA, computeA, globalA, fcA] = await rpc.getMultipleAccounts([cfg.mint, curveAddr, cfg.creator, vaultAddr, cfg.compute_address, PUMP.global, PUMP.feeConfig]);
    if (!mintA) throw new Error(`config.mint ${cfg.mint} does not exist on this cluster`);
    if (!curveA || curveA.owner !== PUMP.program) throw new Error(`config.mint ${cfg.mint} has no pump.fun bonding curve on this cluster`);
    if (!globalA || !fcA) throw new Error("pump.fun's Global or fee config could not be read on this cluster");
    const mint = decodeMint(mintA.data), curve = decodeBondingCurve(curveA.data), phase = phaseOf(curve);
    const tokenAta = ata(cfg.creator, cfg.mint, mintA.owner);
    const poolAddr = pumpPdas.pool(cfg.mint, PUMP.wsol);
    const [curveBaseA, ataA, poolA, ammFcA, vaultAtaA] = await rpc.getMultipleAccounts([ata(curveAddr, cfg.mint, mintA.owner), tokenAta, poolAddr, PUMP.ammFeeConfig,
      ata(pumpPdas.ammCreatorVault(cfg.creator), PUMP.wsol, TOKEN_PROGRAM)]);
    let pool: PoolSnapshot | null = null;
    if (phase === "pool" && poolA && poolA.owner === PUMP.amm && ammFcA) {
      const data = decodePumpPool(poolA.data);
      const [baseA, quoteA] = await rpc.getMultipleAccounts([data.poolBaseTokenAccount, data.poolQuoteTokenAccount]);
      if (baseA && quoteA) pool = { address: poolAddr, data, base: decodeTokenAccount(baseA.data).amount, quote: decodeTokenAccount(quoteA.data).amount,
        vaultAta: vaultAtaA ? decodeTokenAccount(vaultAtaA.data).amount : null, feeConfig: decodePumpFeeConfig(ammFcA.data) };
    }
    return {
      genesis: this.genesis, wallet: walletA?.lamports ?? 0n, mint: { program: mintA.owner, decimals: mint.decimals, supply: mint.supply }, curve, phase,
      curveBase: curveBaseA ? decodeTokenAccount(curveBaseA.data).amount : 0n, vault: vaultA?.lamports ?? 0n, rent0: this.rents[0], rentToken: this.rents[1],
      global: decodePumpGlobal(globalA.data), feeConfig: decodePumpFeeConfig(fcA.data), pool,
      tokenAta: { address: tokenAta, exists: !!ataA, amount: ataA ? decodeTokenAccount(ataA.data).amount : 0n },
      compute: { lamports: computeA?.lamports ?? 0n, owner: computeA?.owner ?? null, executable: computeA?.executable ?? false },
    };
  }

  private ixs(a: Action, s: Snapshot, cuLimit: number, microLamports: number): Ix[] {
    return [computeBudget.limit(cuLimit), computeBudget.price(microLamports), ...actionIxs(this.cfg, s, a)];
  }

  async price(a: Action, s: Snapshot): Promise<number> {
    const f = await priorityFee(this.rpc, writableAccounts(actionIxs(this.cfg, s, a), this.cfg.creator), this.cfg.priority_fee);
    return Math.min(f.microLamports, this.cfg.priority_fee.cap_micro_lamports);
  }

  fits(a: Action, s: Snapshot): boolean {
    return wireSize(compileMessage(this.cfg.creator, this.ixs(a, s, MAX_COMPUTE_UNITS, 1), SYSTEM_PROGRAM)) <= PACKET_LIMIT;
  }

  async simulate(a: Action, s: Snapshot): Promise<Sim> {
    const { cfg, rpc } = this;
    const { blockhash } = await rpc.getLatestBlockhash();
    const msg = compileMessage(cfg.creator, this.ixs(a, s, MAX_COMPUTE_UNITS, 0), blockhash);
    const size = wireSize(msg);
    // unsigned: one empty signature slot per signer; the RPC is told not to verify them
    const wire = new Uint8Array(1 + 64 * msg.numSigners + msg.bytes.length);
    wire[0] = msg.numSigners;
    wire.set(msg.bytes, 1 + 64 * msg.numSigners);
    const watch = [cfg.creator, ...mayCreate(cfg, s, a)];
    const before = await rpc.getMultipleAccounts(watch);
    const res = (await rpc.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts: ({ lamports: number } | null)[] | null } }>("simulateTransaction", [
      Buffer.from(wire).toString("base64"),
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: rpc.commitment, accounts: { encoding: "base64", addresses: watch } },
    ])).value;
    const after = res.accounts ?? [];
    let createdRent = 0n;
    for (let i = 1; i < watch.length; i++) if (!before[i] && after[i]) createdRent += BigInt(after[i]!.lamports);
    return {
      ok: !res.err, error: res.err ? JSON.stringify(res.err) : null, logs: res.logs ?? [], units: res.unitsConsumed ?? 0,
      walletDelta: after[0] ? BigInt(after[0].lamports) - (before[0]?.lamports ?? 0n) : 0n, createdRent, size,
    };
  }

  async sign(a: Action, s: Snapshot, cuLimit: number, microLamports: number): Promise<Prepared> {
    if (!this.signer) throw new Error("no key loaded: config.key_path is needed to send");
    if (this.signer.id !== this.cfg.creator) throw new Error("the loaded key is not config.creator");
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash();
    const msg = compileMessage(this.cfg.creator, this.ixs(a, s, cuLimit, microLamports), blockhash);
    if (wireSize(msg) > PACKET_LIMIT) throw new Error(`the ${a.kind} transaction is ${wireSize(msg)} bytes, over the ${PACKET_LIMIT}-byte packet limit`);
    const tx = signMessageWith(msg, [this.signer]);
    return { wire: tx.wire, signature: tx.signature, lastValidBlockHeight };
  }

  async submit(wire: Uint8Array): Promise<void> {
    await this.rpc.sendRawTransaction(wire, true);
  }

  async status(signature: string): Promise<"landed" | "unknown"> {
    const [st] = await this.rpc.getSignatureStatuses([signature]);
    if (!st) return "unknown";
    return st.err || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" ? "landed" : "unknown";
  }

  blockHeight(): Promise<number> {
    return this.rpc.getBlockHeight();
  }

  async outcome(signature: string): Promise<Outcome> {
    let t: TxJson | null = null;
    for (let i = 0; i < 20 && !t; i++) {
      t = await this.rpc.call<TxJson | null>("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (!t) await new Promise((r) => setTimeout(r, 500));
    }
    if (!t) throw new Error(`transaction ${signature} is confirmed and the RPC does not return it yet: run again`);
    const keys = t.transaction.message.accountKeys;
    if (keys[0] !== this.cfg.creator) throw new Error(`transaction ${signature} was not paid by config.creator`);
    let createdRent = 0n;
    for (let i = 1; i < keys.length; i++) if (t.meta.preBalances[i] === 0 && t.meta.postBalances[i]! > 0) createdRent += BigInt(t.meta.postBalances[i]!);
    let collected = 0n;
    for (const g of t.meta.innerInstructions ?? []) for (const ix of g.instructions) {
      const e = decodePumpEvent(base58Decode(ix.data));
      if (e?.name === "CollectCreatorFeeEvent" && e.fields.creator === this.cfg.creator) collected += e.fields.creator_fee as bigint;
      if (e?.name === "CollectCoinCreatorFeeEvent" && e.fields.coin_creator === this.cfg.creator) collected += e.fields.coin_creator_fee as bigint;
    }
    return {
      err: t.meta.err ? JSON.stringify(t.meta.err) : null, slot: t.slot, walletDelta: BigInt(t.meta.postBalances[0]!) - BigInt(t.meta.preBalances[0]!), fee: BigInt(t.meta.fee),
      createdRent, collected, units: t.meta.computeUnitsConsumed ?? null,
    };
  }
}
