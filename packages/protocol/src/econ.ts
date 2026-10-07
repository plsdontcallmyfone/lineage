import { H } from "./hash.ts";
import { Rng } from "./rng.ts";
import type { Hex, MetricEffect } from "./types.ts";

// Work units, payouts and assignment, SPEC sections 10.3 and 13. Every parameter comes from the
// network config; nothing here is a launch value.

export interface EconConfig {
  u_replay: number;
  u_author: number;
  finder_share: number;
  value_cap: number;
  bond_cap: number;
}

export function costClass(median_eval_seconds: number): number {
  return Math.min(30, Math.max(1, Math.round(median_eval_seconds / 60)));
}

export function effectValue(effect: MetricEffect | { fixed: string[] }, min_effect: number, cap: number): number {
  if ("fixed" in effect) return Math.min(cap, 1 + 0.5 * (effect.fixed.length - 1));
  // conservative edge: the worst replay's upper CI bound
  const gain = Math.max(0, 1 - effect.ci_high);
  return Math.min(cap, Math.log2(1 + gain / min_effect));
}

/** Largest-remainder split of an integer pool by units; sums exactly to the pool. */
export function proportionalSplit(pool: bigint, units: Map<string, number>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const entries = [...units.entries()].filter(([, u]) => u > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = entries.reduce((a, [, u]) => a + u, 0);
  if (total === 0 || pool === 0n) return out;
  // integer units at 1e6 resolution keep this exact and platform independent
  const scaled = entries.map(([k, u]) => [k, BigInt(Math.round((u / total) * 1e9))] as const);
  const denom = scaled.reduce((a, [, s]) => a + s, 0n);
  let given = 0n;
  const rema: { k: string; r: bigint }[] = [];
  for (const [k, s] of scaled) {
    const amt = (pool * s) / denom;
    out.set(k, amt);
    given += amt;
    rema.push({ k, r: (pool * s) % denom });
  }
  rema.sort((a, b) => (a.r === b.r ? (a.k < b.k ? -1 : 1) : a.r > b.r ? -1 : 1));
  for (let i = 0; given < pool; i++, given++) {
    const k = rema[i % rema.length]!.k;
    out.set(k, out.get(k)! + 1n);
  }
  return out;
}

export interface Eligible {
  agent: string;
  bond: bigint;
  operator?: string;
}

/**
 * Weighted sampling without replacement, weight min(bond, bond_cap). Deterministic from the seed,
 * so anyone can check an assignment once the beacon is public.
 */
export function assignReplayers(
  seed: Hex,
  pool: Eligible[],
  count: number,
  exclude: { agents: string[]; operator?: string },
  bond_cap: bigint,
): string[] {
  const ex = new Set(exclude.agents);
  let cands = pool
    .filter((p) => !ex.has(p.agent) && !(exclude.operator && p.operator === exclude.operator) && p.bond > 0n)
    .sort((a, b) => (a.agent < b.agent ? -1 : 1))
    .map((p) => ({ agent: p.agent, operator: p.operator, w: p.bond < bond_cap ? p.bond : bond_cap }));
  const rng = new Rng(H("assign-rng", seed));
  const chosen: string[] = [];
  while (chosen.length < count && cands.length) {
    const total = cands.reduce((a, c) => a + c.w, 0n);
    // 53-bit draw scaled to the bigint total
    const draw = (BigInt(rng.nextU32()) * 2097152n + BigInt(rng.nextU32() >>> 11)) % total;
    let acc = 0n;
    let idx = 0;
    for (; idx < cands.length; idx++) {
      acc += cands[idx]!.w;
      if (draw < acc) break;
    }
    const pick = cands[idx]!;
    chosen.push(pick.agent);
    // two replays of one candidate never share a declared operator
    cands = cands.filter((c) => c.agent !== pick.agent && !(pick.operator && c.operator === pick.operator));
  }
  return chosen;
}

// Merkle tree with domain-separated leaves and sorted pairs (order-independent proofs).

export const leafHash = (data: string): Hex => H("leaf", data);
const nodeHash = (a: Hex, b: Hex): Hex => (a < b ? H("node", a, b) : H("node", b, a));

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return H("empty");
  let level = [...leaves];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i]!, level[i + 1]!) : level[i]!);
    level = next;
  }
  return level[0]!;
}

export function merkleProof(leaves: Hex[], index: number): Hex[] {
  const proof: Hex[] = [];
  let level = [...leaves];
  let i = index;
  while (level.length > 1) {
    const sib = i ^ 1;
    if (sib < level.length) proof.push(level[sib]!);
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(j + 1 < level.length ? nodeHash(level[j]!, level[j + 1]!) : level[j]!);
    level = next;
    i >>= 1;
  }
  return proof;
}

export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  return proof.reduce((acc, p) => nodeHash(acc, p), leaf) === root;
}
