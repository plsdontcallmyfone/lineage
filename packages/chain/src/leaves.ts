import { canonicalJson, leafHash, verifyProof } from "@lineage/protocol";
import { hexToBytes, type Address } from "./codec.ts";
import { DEST_KIND, registryPdas } from "./registry.ts";

// The leaves the programs verify, built with the protocol's own hashing (no second encoding).

/** Core's payout leaf (SPEC 13.3): `leafHash(canonicalJson({ epoch, agent, dest, amount }))`, amount a decimal string. */
export const payoutLeaf = (epoch: number, agent: Address, dest: string, amount: bigint | string): string =>
  leafHash(canonicalJson({ epoch, agent, dest, amount: String(amount) }));

/** The hosted runtime's usage leaf (SPEC 13.7), verified by `lineage_launch::debit_compute`. */
export const usageLeaf = (u: { epoch: number; agent: Address; amount: bigint | string; model_tokens: number; sandbox_s: number }): string =>
  leafHash(canonicalJson({ epoch: u.epoch, agent: u.agent, amount: String(u.amount), model_tokens: u.model_tokens, sandbox_s: u.sandbox_s }));

/** A Core destination (`agent:<id>:wallet`, `agent:<id>:compute`, `wallet:<address>`) as the claim instruction's fields. */
export function parseDest(agent: Address, dest: string): { destKind: number; wallet?: Address } {
  if (dest === `agent:${agent}:wallet`) return { destKind: DEST_KIND.agentWallet };
  if (dest === `agent:${agent}:compute`) return { destKind: DEST_KIND.agentCompute };
  if (dest.startsWith("wallet:")) return { destKind: DEST_KIND.wallet, wallet: dest.slice("wallet:".length) };
  throw new Error(`destination ${dest} cannot be claimed on chain for ${agent}`);
}

/**
 * One item of Core's `GET /v1/epochs/:n/proofs/:agent` as claim fields. The leaf is recomputed and
 * the proof checked, so a malformed item fails here rather than on chain.
 */
export function claimFromCoreProof(p: { epoch: number; agent: Address; dest: string; amount: string; leaf: string; proof: string[]; root: string }) {
  const leaf = payoutLeaf(p.epoch, p.agent, p.dest, p.amount);
  if (leaf !== p.leaf) throw new Error("leaf does not match its fields");
  if (!verifyProof(leaf, p.proof, p.root)) throw new Error("proof does not verify against the root");
  const d = parseDest(p.agent, p.dest);
  return {
    epoch: BigInt(p.epoch),
    agent: p.agent,
    destKind: d.destKind,
    wallet: d.wallet,
    amount: BigInt(p.amount),
    leaf: hexToBytes(leaf),
    proof: p.proof.map(hexToBytes),
    /** Pass as `agentRecord` for agent-wallet leaves. */
    agentRecord: d.destKind === DEST_KIND.agentWallet ? registryPdas.agent(p.agent) : undefined,
  };
}
