#!/usr/bin/env bun
// On a capacity host: adds the verifier key's signature to a register transaction the owner signed
// (scripts/deploy/capacity-host/verifier-chain.ts --register) and prints the fully signed transaction.
// Nothing is sent from here and no RPC is used, so the host needs no keyed endpoint; the caller sends
// it (verifier-chain.ts --send). The worker CLI's `cosign` checks for devnet and cannot do this on mainnet.
//
//   bun scripts/deploy/capacity-host/cosign-register.ts --key <verifier key> --tx <base64>
//
// Refused unless the transaction is exactly one units_registry register (plus compute budget) for this
// key's own agent id under the active network profile (UNITS_NETWORK, UNITS_PROFILE_LOCAL), with this
// key neither paying nor writable (inspectForCosign). The summary goes to stderr, the result to stdout.
import { readFileSync } from "node:fs";
import { keyFromSolanaJson } from "@units/protocol";
import { cosign, inspectForCosign } from "../../../packages/chain/src/cosign.ts";
import { ixDisc } from "../../../packages/chain/src/codec.ts";
import { applyNetworkProfile } from "../../../packages/chain/src/profile-node.ts";
import { REGISTRY_PROGRAM_ID } from "../../../packages/chain/src/programs.ts";
import { COMPUTE_BUDGET_PROGRAM } from "../../../packages/chain/src/tx.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const keyFile = opt("key");
const tx = opt("tx");
if (!keyFile || !tx || !/^[A-Za-z0-9+/=]{100,4000}$/.test(tx)) throw new Error("usage: cosign-register.ts --key <file> --tx <base64>");
const profile = applyNetworkProfile();
const key = keyFromSolanaJson(JSON.parse(readFileSync(keyFile, "utf8")));
const wire = new Uint8Array(Buffer.from(tx, "base64"));
const plan = inspectForCosign(wire, key.id, { expectAgent: key.id });
const REGISTER = ixDisc("register");
let registers = 0;
for (const ix of plan.message.instructions) {
  if (ix.programId === COMPUTE_BUDGET_PROGRAM) continue;
  if (ix.programId !== REGISTRY_PROGRAM_ID || ix.data.length < 8 || !REGISTER.every((b, i) => b === ix.data[i])) throw new Error("refusing to co-sign: only units_registry register is signed here");
  registers++;
}
if (registers !== 1) throw new Error(`refusing to co-sign: expected one register, got ${registers}`);
console.error(`[cosign-register] ${profile.network}, registry ${REGISTRY_PROGRAM_ID}, agent ${key.id}`);
for (const s of plan.summary) console.error(`[cosign-register]   ${s}`);
console.error(`[cosign-register]   fee payer (owner) ${plan.payer}`);
console.log(Buffer.from(cosign(wire, key)).toString("base64"));
