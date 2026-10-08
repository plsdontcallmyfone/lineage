import { canonicalJson, hashJson, leafHash, verifyProof } from "@lineage/protocol";
import { addressBytes, hexToBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { LAUNCH_PROGRAM_ID, launchPdas } from "./launch.ts";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, u64le, pda } from "./pda.ts";
import { r, registryPdas, w, type Ix } from "./registry.ts";

// Bounties (identity plan C6, SPEC 14.7), in lineage_launch: escrow from a compute vault, released
// by Core's contribution leaf proven against the registry's Epoch.record_root, into the payee's
// compute vault. Account order and encodings match onchain/programs/lineage-launch/src/bounty.rs;
// onchain/tests/fixtures/client-vectors.json pins them.

const P = LAUNCH_PROGRAM_ID;
const data = (name: string) => new Writer().bytes(ixDisc(name));
const ZERO32 = "0".repeat(64);
export const DEFAULT_ADDRESS: Address = "11111111111111111111111111111111";

export const COND = { commitment: 0, target: 1 } as const;
export const BOUNTY_STATUS = ["open", "released", "refunded", "cancelled"] as const;
export type BountyStatus = (typeof BOUNTY_STATUS)[number];
export const BOUNTY_ROLES = ["author", "reviewer", "harness", "finder"] as const;

export const bountyPdas = {
  config: () => pda(P, "bounty_config"),
  bounty: (payer: Address, id: bigint | number) => pda(P, "bounty", addressBytes(payer), u64le(id)),
  vault: (bounty: Address) => pda(P, "bounty_vault", addressBytes(bounty)),
  ledger: (agent: Address) => pda(P, "bounty_ledger", addressBytes(agent)),
  receipt: (payer: Address, leaf: Uint8Array | string) => pda(P, "bounty_receipt", addressBytes(payer), typeof leaf === "string" ? hexToBytes(leaf) : leaf),
};

export interface BountyConfigArgs {
  /** Most an agent escrows per window, in bps of its compute vault at the window's first open (0 = none). */
  maxBountyOutBps: number;
  /** Most a self-hosted payee receives per window (0 = self-hosted payees are not paid). */
  selfHostedInCap: bigint;
  windowS: number;
  minTtlS: number;
  maxTtlS: number;
  refundGraceS: number;
  minAmount: bigint;
  paused: boolean;
}
export interface OpenBountyArgs {
  bountyId: bigint | number;
  /** Agent to pay, or null for any agent credited as author. */
  payee: Address | null;
  amount: bigint;
  termsDigest: Uint8Array | string;
  conditionKind: number;
  lineageId: Uint8Array | string;
  /** Commitment (kind 0) or `hashJson(target)` (kind 1; null = any target). */
  conditionValue: Uint8Array | string | null;
  deadline: bigint | number;
}
/** A contribution as Core stores it (packages/core records.ts `Contribution`). */
export interface Contribution {
  epoch: number;
  gen_id: string;
  lineage_id: string;
  target: string | string[];
  candidate_commitment: string;
  members: { agent: Address; role: string; share_bps: number }[];
  finder: Address | null;
}

/** Core's contribution leaf: `leafHash(canonicalJson(contribution))`. */
export const contributionLeaf = (c: Contribution): string => leafHash(canonicalJson(c));
/** protocol `hashJson(target)`: the condition value of a target bounty. */
export const targetDigest = (target: string | string[]): string => hashJson(target);
/** sha256 of the canonical terms JSON (what `terms_digest` holds and Core checks). */
export const termsDigest = (terms: unknown): string => hashJson(terms);

const fixed = (b: Uint8Array | string | null) => (b === null ? ZERO32 : b);

export const bounty = {
  setConfig(a: { admin: Address; args: BountyConfigArgs }): Ix {
    const x = a.args;
    return {
      programId: P,
      keys: [r(launchPdas.config()), w(bountyPdas.config()), w(a.admin, true), r(SYSTEM_PROGRAM)],
      data: data("set_bounty_config").u16(x.maxBountyOutBps).u64(x.selfHostedInCap).u32(x.windowS).u32(x.minTtlS).u32(x.maxTtlS).u32(x.refundGraceS)
        .u64(x.minAmount).bool(x.paused).done(),
    };
  },
  /** Opener: the payer's launcher (self-hosted) or the runtime authority (hosted); pays the rent. */
  open(a: { opener: Address; payer: Address; payerMint: Address; lineMint: Address; args: OpenBountyArgs; lineTokenProgram?: Address }): Ix {
    const b = bountyPdas.bounty(a.payer, a.args.bountyId);
    const x = a.args;
    return {
      programId: P,
      keys: [
        r(launchPdas.config()), r(bountyPdas.config()), r(registryPdas.config()), w(a.opener, true), r(launchPdas.authority()),
        w(launchPdas.agentLaunch(a.payerMint)), w(launchPdas.computeVault(a.payer)), w(bountyPdas.ledger(a.payer)), w(b), w(bountyPdas.vault(b)),
        r(a.lineMint), r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM),
      ],
      data: data("open_bounty").u64(x.bountyId).address(x.payee ?? DEFAULT_ADDRESS).u64(x.amount).fixed32(x.termsDigest).u8(x.conditionKind)
        .fixed32(x.lineageId).fixed32(fixed(x.conditionValue)).i64(x.deadline).done(),
    };
  },
  /** Anyone. `opener` is the bounty's opener (vault rent returns there). */
  release(a: { caller: Address; payer: Address; bountyId: bigint | number; opener: Address; payee: Address; payeeMint: Address; lineMint: Address;
    contribution: Contribution; proof: (Uint8Array | string)[]; lineTokenProgram?: Address }): Ix {
    const b = bountyPdas.bounty(a.payer, a.bountyId);
    const c = a.contribution;
    const leaf = contributionLeaf(c);
    const list = Array.isArray(c.target);
    const target = list ? (c.target as string[]) : [c.target as string];
    const wr = data("release_bounty").fixed32(leaf).u64(c.epoch).fixed32(c.gen_id).fixed32(c.lineage_id).fixed32(c.candidate_commitment).u32(target.length);
    for (const t of target) wr.string(t);
    wr.bool(list).u32(c.members.length);
    for (const m of c.members) {
      const role = BOUNTY_ROLES.indexOf(m.role as (typeof BOUNTY_ROLES)[number]);
      if (role < 0) throw new Error(`role ${m.role} cannot be proven on chain`);
      wr.address(m.agent).u8(role).u16(m.share_bps);
    }
    if (c.finder) wr.u8(1).address(c.finder);
    else wr.u8(0);
    wr.vec32(a.proof);
    return {
      programId: P,
      keys: [
        r(launchPdas.config()), r(bountyPdas.config()), w(a.caller, true), r(launchPdas.authority()), w(b), w(bountyPdas.vault(b)), w(a.opener),
        r(registryPdas.epoch(c.epoch)), w(launchPdas.agentLaunch(a.payeeMint)), w(launchPdas.computeVault(a.payee)), w(bountyPdas.ledger(a.payee)),
        w(bountyPdas.receipt(a.payer, leaf)), r(a.lineMint), r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM),
      ],
      data: wr.done(),
    };
  },
  /** Anyone, after deadline + refund_grace_s. */
  refund(a: { payer: Address; payerMint: Address; bountyId: bigint | number; opener: Address; lineMint: Address; lineTokenProgram?: Address }): Ix {
    return { programId: P, keys: refundKeys(a), data: data("refund_bounty").done() };
  },
  /** The opener's authority, only before the registry posts another epoch. */
  cancel(a: { signer: Address; payer: Address; payerMint: Address; bountyId: bigint | number; opener: Address; lineMint: Address; lineTokenProgram?: Address }): Ix {
    return { programId: P, keys: [...refundKeys(a), r(registryPdas.config()), r(a.signer, true)], data: data("cancel_bounty").done() };
  },
};
function refundKeys(a: { payer: Address; payerMint: Address; bountyId: bigint | number; opener: Address; lineMint: Address; lineTokenProgram?: Address }) {
  const b = bountyPdas.bounty(a.payer, a.bountyId);
  return [
    r(launchPdas.config()), r(bountyPdas.config()), r(launchPdas.authority()), w(b), w(bountyPdas.vault(b)), w(a.opener),
    w(launchPdas.agentLaunch(a.payerMint)), w(launchPdas.computeVault(a.payer)), r(a.lineMint), r(a.lineTokenProgram ?? TOKEN_PROGRAM),
  ];
}

/**
 * A contribution leaf from Core (`GET /v1/agents/:id/records` or `/v1/bounties/:pda/release`) as
 * release fields; the leaf is recomputed and the proof checked against `root` (the onchain record
 * root), so a bad item fails here rather than on chain.
 */
export function releaseFromContribution(c: Contribution, proof: string[], root: string): { leaf: string; contribution: Contribution; proof: string[] } {
  const leaf = contributionLeaf(c);
  if (!verifyProof(leaf, proof, root)) throw new Error("contribution proof does not verify against the record root");
  return { leaf, contribution: c, proof };
}

// ---------- accounts ----------

export interface BountyConfig extends BountyConfigArgs {}
export function decodeBountyConfig(d: Uint8Array): BountyConfig {
  const rd = new Reader(d).expect("BountyConfig");
  return { maxBountyOutBps: rd.u16(), selfHostedInCap: rd.u64(), windowS: rd.u32(), minTtlS: rd.u32(), maxTtlS: rd.u32(), refundGraceS: rd.u32(),
    minAmount: rd.u64(), paused: rd.bool() };
}

export interface BountyAccount {
  payer: Address;
  bountyId: bigint;
  /** null = any agent credited as author. */
  payee: Address | null;
  opener: Address;
  amount: bigint;
  termsDigest: string;
  conditionKind: number;
  lineageId: string;
  /** null = any target (kind 1). */
  conditionValue: string | null;
  minEpoch: bigint;
  epochsPostedAtOpen: bigint;
  deadline: bigint;
  createdAt: bigint;
  status: BountyStatus;
  releasedTo: Address | null;
  releasedEpoch: bigint;
  leaf: string | null;
  closedAt: bigint;
}
const orNull = (a: Address) => (a === DEFAULT_ADDRESS ? null : a);
export function decodeBounty(d: Uint8Array): BountyAccount {
  const rd = new Reader(d).expect("Bounty");
  const b = {
    payer: rd.address(), bountyId: rd.u64(), payee: orNull(rd.address()), opener: rd.address(), amount: rd.u64(), termsDigest: rd.hex32(),
    conditionKind: rd.u8(), lineageId: rd.hex32(), conditionValue: rd.hex32() as string | null, minEpoch: rd.u64(), epochsPostedAtOpen: rd.u64(),
    deadline: rd.i64(), createdAt: rd.i64(), status: BOUNTY_STATUS[rd.u8()] ?? "open", releasedTo: orNull(rd.address()), releasedEpoch: rd.u64(),
    leaf: rd.hex32() as string | null, closedAt: rd.i64(),
  };
  if (b.conditionValue === ZERO32) b.conditionValue = null;
  if (b.leaf === ZERO32) b.leaf = null;
  return b;
}

export interface BountyLedger {
  agent: Address;
  outWindow: bigint;
  outBase: bigint;
  outAmount: bigint;
  inWindow: bigint;
  inAmount: bigint;
  openedTotal: bigint;
  receivedTotal: bigint;
}
export function decodeBountyLedger(d: Uint8Array): BountyLedger {
  const rd = new Reader(d).expect("BountyLedger");
  return { agent: rd.address(), outWindow: rd.u64(), outBase: rd.u64(), outAmount: rd.u64(), inWindow: rd.u64(), inAmount: rd.u64(), openedTotal: rd.u64(),
    receivedTotal: rd.u64() };
}

export interface BountyReceipt {
  bounty: Address;
  payer: Address;
  leaf: string;
  epoch: bigint;
  genId: string;
  payee: Address;
  amount: bigint;
  releasedAt: bigint;
}
export function decodeBountyReceipt(d: Uint8Array): BountyReceipt {
  const rd = new Reader(d).expect("BountyReceipt");
  return { bounty: rd.address(), payer: rd.address(), leaf: rd.hex32(), epoch: rd.u64(), genId: rd.hex32(), payee: rd.address(), amount: rd.u64(),
    releasedAt: rd.i64() };
}
