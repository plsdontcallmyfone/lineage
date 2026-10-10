// Fixtures for the indexer suites: the pump.fun proof's transactions and accounts recorded from the
// mainnet fork (scripts/record-fixtures.ts, test/fixtures/pump-fork-txs.json), the decoding context of
// the two agent coins (A1 on $LINE's curve, A2 after $LINE migrated), and helpers that add
// units_launch event logs to a recorded transaction (the proof ran before our program change).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addressBytes, LAUNCH_PROGRAM_ID, pumpPdas, sha256, type Address } from "@lineage/chain";
import type { RawTx, TokenCtx } from "../src/decode.ts";

export interface Fx {
  mints: { line: Address; a1: Address; a2: Address };
  creator_pdas: { a1: Address; a2: Address };
  pda_line_after_sweeps: { a1: string; a2: string };
  accounts: Record<string, string>;
  txs: { step: string; what: string; tx: RawTx }[];
}
export const FX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "pump-fork-txs.json"), "utf8")) as Fx;
export const { line: LINE, a1: A1, a2: A2 } = FX.mints;
export const ctxOf = (mint: Address): TokenCtx => ({ mint, lineMint: LINE, curve: pumpPdas.bondingCurve(mint), pool: pumpPdas.pool(mint, LINE), baseDecimals: 6,
  quoteDecimals: 6, launchProgram: LAUNCH_PROGRAM_ID });
export const tx = (step: string) => structuredClone(FX.txs.find((t) => t.step === step)!.tx);
export const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

const disc = (name: string) => sha256(`event:${name}`).subarray(0, 8);
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export const feesCranked = (agent: Address, mint: Address, fees: bigint, toCompute: bigint, poolFees: boolean, balance: bigint) =>
  cat(disc("FeesCranked"), addressBytes(agent), addressBytes(mint), u64(fees), u64(toCompute), u64(fees - toCompute), Uint8Array.of(poolFees ? 1 : 0), u64(balance),
    Uint8Array.of(1));
export const pumpGraduated = (agent: Address, mint: Address, pool: Address, coinCreator: Address, ours: boolean) =>
  cat(disc("PumpGraduated"), addressBytes(agent), addressBytes(mint), addressBytes(pool), addressBytes(coinCreator), Uint8Array.of(ours ? 1 : 0));
export const pumpLaunched = (agent: Address, mint: Address, launcher: Address, curve: Address, creator: Address) =>
  cat(disc("PumpLaunched"), addressBytes(agent), addressBytes(mint), addressBytes(launcher), addressBytes(curve), addressBytes(creator), new Uint8Array(32),
    Uint8Array.of(2, 1));

/** A recorded transaction with `data` emitted (Anchor emit!) inside a top-level frame of `program`. */
export function withLog(t: RawTx, data: Uint8Array, program: Address = LAUNCH_PROGRAM_ID): RawTx {
  const c = structuredClone(t);
  c.meta!.logMessages = [...(c.meta!.logMessages ?? []), `Program ${program} invoke [1]`, `Program data: ${Buffer.from(data).toString("base64")}`,
    `Program ${program} success`];
  return c;
}
