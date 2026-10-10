#!/usr/bin/env bun
// Records the pump.fun proof's transactions (scripts/mainnet/pump-fork-proof.ts, a local fork of
// mainnet running mainnet's own Pump and PumpSwap builds) as the indexer's unit-test fixtures:
//   bun packages/indexer/scripts/record-fixtures.ts [--rpc http://127.0.0.1:9690]
// Run once while the fork is up; the tests never touch the network. Reads the fork only.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUMP, pumpPdas } from "@lineage/chain";

const argv = process.argv.slice(2);
const url = argv.includes("--rpc") ? argv[argv.indexOf("--rpc") + 1]! : "http://127.0.0.1:9690";
if (!url.startsWith("http://127.0.0.1:")) throw new Error("records from a local fork only");
const proof = JSON.parse(readFileSync(join(import.meta.dir, "../../../scripts/mainnet/PUMP-FORK-LAST.json"), "utf8"));
const call = async (method: string, params: unknown[]) => {
  const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const acct = async (a: string) => (await call("getAccountInfo", [a, { encoding: "base64" }]))?.value?.data?.[0] ?? null;
const { line, a1, a2 } = proof.mints;
// the transactions that touch an agent coin (A1 on $LINE's curve, A2 after $LINE migrated)
const STEPS = ["2", "3a", "3b", "3c", "3d", "4", "7a", "7b", "8b", "8c", "9a", "9b", "9c", "9d"];
const txs = [];
for (const step of STEPS) {
  const row = proof.rows.find((r: { step: string }) => r.step === step);
  const tx = await call("getTransaction", [row.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!tx) throw new Error(`${step}: not found`);
  txs.push({ step, what: row.what, tx });
}
const out = {
  _note: "Recorded from the mainnet fork run of scripts/mainnet/pump-fork-proof.ts (mainnet's pump.fun programs and Global, 2026-10-10).",
  recorded_at: new Date().toISOString(), mints: proof.mints, creator_pdas: proof.creator_pdas,
  // measured by the proof: the creator PDA's $LINE balance after the sweeps and collects
  pda_line_after_sweeps: { a1: "103289391468", a2: (295195554190n + 425712173n).toString() },
  accounts: {
    global: await acct(PUMP.global), fee_config: await acct(PUMP.feeConfig), amm_fee_config: await acct(PUMP.ammFeeConfig),
    a1_curve: await acct(pumpPdas.bondingCurve(a1)), a2_curve: await acct(pumpPdas.bondingCurve(a2)), a2_pool: await acct(pumpPdas.pool(a2, line)),
  },
  txs,
};
writeFileSync(join(import.meta.dir, "../test/fixtures/pump-fork-txs.json"), JSON.stringify(out) + "\n");
console.log(`recorded ${txs.length} transactions`);
