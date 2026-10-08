// Agent-key co-signing for transactions a browser wallet built and signed first (wallet UI lane).
// `lineage_registry::register` needs both the owner wallet and the agent key; the agent key lives
// with the worker and never enters a page. The page builds the transaction, the wallet signs as
// owner and fee payer, and `lineage-worker cosign` checks what it is about to sign, adds the agent
// signature and sends it. Devnet only in this milestone. The same flow co-signs
// `rotate_agent_key` (identity plan I1): the owner's wallet signs on the Wallet page and the new key
// (a hosted runtime's or a worker's, which never leaves its machine) proves possession by co-signing.
import { createPublicKey, verify } from "node:crypto";
import { base58Decode, base58Encode } from "@lineage/protocol";
import { ixDisc, type Address } from "./codec.ts";
import { REGISTRY_PROGRAM_ID } from "./registry.ts";
import { Rpc } from "./rpc.ts";
import { COMPUTE_BUDGET_PROGRAM, signBytes, type Signer } from "./tx.ts";
import { assertDevnet, sendWire } from "./browser/client.ts";
import { decodeMessage, parseWire, placeSignature, type DecodedMessage } from "./browser/wire.ts";

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const verifyEd = (signer: Address, msg: Uint8Array, sig: Uint8Array) =>
  verify(null, msg, createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(base58Decode(signer))]), format: "der", type: "spki" }), sig);

/** Registry instructions a key may co-sign from a page, with the index of the account that must be that key. */
const COSIGNABLE: Record<string, number> = { register: 2, rotate_agent_key: 2 };

export interface CosignPlan {
  message: DecodedMessage;
  payer: Address;
  summary: string[];
}

/**
 * Refuses anything but a registry `register` naming this agent key, or a `rotate_agent_key` to this
 * key, already signed by every other signer.
 */
export function inspectForCosign(wire: Uint8Array, agent: Address): CosignPlan {
  const { signatures, message } = parseWire(wire);
  const m = decodeMessage(message);
  const signers = m.keys.slice(0, m.numSigners);
  if (!signers.includes(agent)) throw new Error(`agent ${agent} is not a signer of this transaction`);
  const summary: string[] = [];
  let found = false;
  for (const ix of m.instructions) {
    if (ix.programId === COMPUTE_BUDGET_PROGRAM) {
      summary.push("compute budget");
      continue;
    }
    if (ix.programId !== REGISTRY_PROGRAM_ID) throw new Error(`refusing to co-sign: instruction for program ${ix.programId} (only lineage_registry and compute budget)`);
    const name = Object.keys(COSIGNABLE).find((n) => ix.data.length >= 8 && ixDisc(n).every((x, i) => x === ix.data[i]));
    if (!name) throw new Error("refusing to co-sign: a lineage_registry instruction other than register or rotate_agent_key");
    const a = ix.accounts[COSIGNABLE[name]!]!.pubkey;
    if (a !== agent) throw new Error(`refusing to co-sign: ${name} names ${a}, not ${agent}`);
    summary.push(name === "rotate_agent_key"
      ? `lineage_registry::rotate_agent_key of agent record ${ix.accounts[3]!.pubkey} to new key ${a}, owner ${ix.accounts[1]!.pubkey}`
      : `lineage_registry::${name} agent ${a} owner ${ix.accounts[1]!.pubkey}`);
    found = true;
  }
  if (!found) throw new Error("no register or rotate_agent_key instruction for this key");
  signers.forEach((s, i) => {
    if (s === agent) return;
    const sig = signatures[i]!;
    if (sig.every((x) => x === 0)) throw new Error(`signer ${s} has not signed yet: sign with the wallet first`);
    if (!verifyEd(s, message, sig)) throw new Error(`signature of ${s} does not verify`);
  });
  return { message: m, payer: signers[0]!, summary };
}

export function cosign(wire: Uint8Array, key: Signer): Uint8Array {
  return placeSignature(wire, key.id, signBytes(key, parseWire(wire).message));
}

/** `lineage-worker cosign --key <file> --tx <base64> [--rpc <url>] [--dry-run]` */
export async function cosignCommand(o: { key: Signer; tx: string; rpcUrl: string; dryRun?: boolean; log?: (m: string) => void }) {
  const log = o.log ?? console.log;
  const rpc = Rpc.http(o.rpcUrl, "confirmed");
  await assertDevnet(rpc);
  const wire = new Uint8Array(Buffer.from(o.tx.trim(), "base64"));
  const plan = inspectForCosign(wire, o.key.id);
  for (const s of plan.summary) log(`  ${s}`);
  log(`  fee payer (wallet) ${plan.payer}`);
  const signed = cosign(wire, o.key);
  const sig = base58Encode(parseWire(signed).signatures[0]!);
  if (o.dryRun) {
    const sim = await rpc.simulate(signed);
    log(`dry run: simulation ${sim.err ? `failed ${JSON.stringify(sim.err)}` : "ok"}`);
    return { signature: sig, sent: false };
  }
  const sim = await rpc.simulate(signed);
  if (sim.err) throw new Error(`simulation failed: ${JSON.stringify(sim.err)}\n${(sim.logs ?? []).slice(-8).join("\n")}`);
  const { lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const r = await sendWire(rpc, signed, lastValidBlockHeight, (s) => log(`  ${s}`));
  if (r.err) throw new Error(`transaction ${r.signature} failed: ${JSON.stringify(r.err)}`);
  log(`${plan.summary.some((x) => x.includes("rotate_agent_key")) ? "rotated" : "registered"}: ${r.signature} (slot ${r.slot})`);
  log(`https://explorer.solana.com/tx/${r.signature}?cluster=devnet`);
  return { signature: r.signature, sent: true };
}
