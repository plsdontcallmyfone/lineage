import { canonicalJson, hashJson, leafHash, verifyProof } from "@units/protocol";
import { addressBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { launchPdas } from "./launch.ts";
import { ata, BPF_LOADER_UPGRADEABLE, pda, SYSTEM_PROGRAM, TOKEN_PROGRAM, u64le } from "./pda.ts";
import { BOUNTY_PROGRAM_ID } from "./programs.ts";
import { r, registryPdas, w, type Ix } from "./registry.ts";

// Open bounties (docs/plans/OPEN-BOUNTIES.md option A), the `units_bounty` program: any wallet
// escrows $UNITS for one unit, one metric and a required improvement; the escrow is paid to the
// author of the earliest accepted generation that meets the terms, proven by Core's result leaf
// against the registry's Epoch.record_root, and returns to the funder at expiry. There is no cancel:
// a posted reward leaves its escrow only by `pay` or, after the refund time, by `refund`. Account order and
// encodings match onchain/programs/units-bounty/src/lib.rs (test/open-bounty.test.ts checks the
// leaf against onchain/tests/fixtures/merkle.json, which the program's own suite is run on).

const data = (name: string) => new Writer().bytes(ixDisc(name));
const ZERO32 = "0".repeat(64);
const NOBODY: Address = "11111111111111111111111111111111";

// Status byte 3 was written by a `cancel` instruction the program had on devnet until 2026-10-13
// (the escrow went back to its funder). The program has no such instruction now; an account that
// still carries the byte reads as refunded.
export const OPEN_BOUNTY_STATUS = ["open", "paid", "refunded"] as const;
const STATUS_BYTES: readonly OpenBountyStatus[] = [...OPEN_BOUNTY_STATUS, "refunded"];
export type OpenBountyStatus = (typeof OPEN_BOUNTY_STATUS)[number];

export const openBountyPdas = {
  config: () => pda(BOUNTY_PROGRAM_ID, "config"),
  authority: () => pda(BOUNTY_PROGRAM_ID, "authority"),
  feeVault: () => pda(BOUNTY_PROGRAM_ID, "fee_vault"),
  bounty: (funder: Address, id: bigint | number) => pda(BOUNTY_PROGRAM_ID, "bounty", addressBytes(funder), u64le(id)),
  vault: (bounty: Address) => pda(BOUNTY_PROGRAM_ID, "vault", addressBytes(bounty)),
  programData: () => pda(BPF_LOADER_UPGRADEABLE, addressBytes(BOUNTY_PROGRAM_ID)),
};

/** Every setting of the program (all admin editable with `setSettings`). */
export interface OpenBountySettings {
  /** smallest escrow, base units */
  minAmount: bigint;
  minTtlS: number;
  maxTtlS: number;
  /** after the deadline, how long a first claim is still taken before anyone may refund */
  refundGraceS: number;
  /** how long a claim stands open to a claim of a lower height before it is paid */
  contestS: number;
  /** fee taken from a payout, basis points; never from a refund */
  feeBps: number;
  paused: boolean;
}
export interface EscrowOpenArgs {
  bountyId: bigint | number;
  amount: bigint;
  termsDigest: Uint8Array | string;
  lineageId: Uint8Array | string;
  /** protocol `hashJson(target)` of the metric the bounty names */
  targetDigest: Uint8Array | string;
  minImprovementBps: number;
  deadline: bigint | number;
}
/** Core's result of an accepted generation (packages/core records.ts `BountyResult`). */
export interface BountyResult {
  accepted_at: number;
  author: Address;
  epoch: number;
  gen_id: string;
  height: number;
  improvement_bps: number;
  kind: "bounty_result";
  lineage_id: string;
  target: string | string[];
}

/** Core's result leaf: `leafHash(canonicalJson(result))`. */
export const resultLeaf = (x: BountyResult): string => leafHash(canonicalJson(x));
/** protocol `hashJson(target)`: what a bounty's `target_digest` holds. */
export const bountyTargetDigest = (target: string | string[]): string => hashJson(target);

const settings = (wr: Writer, s: OpenBountySettings) =>
  wr.u64(s.minAmount).u32(s.minTtlS).u32(s.maxTtlS).u32(s.refundGraceS).u32(s.contestS).u16(s.feeBps).bool(s.paused);

export const openBounty = {
  /** Once, by the program's upgrade authority. The quote mint and the launch program are the registry's. */
  initialize(a: { upgradeAuthority: Address; admin: Address; mint: Address; settings: OpenBountySettings; tokenProgram?: Address }): Ix {
    const p = openBountyPdas;
    return {
      programId: BOUNTY_PROGRAM_ID,
      keys: [w(p.config()), w(a.upgradeAuthority, true), r(p.programData()), r(registryPdas.config()), r(a.mint), r(p.authority()), w(p.feeVault()),
        r(a.tokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM)],
      data: settings(data("initialize").address(a.admin), a.settings).done(),
    };
  },
  setSettings(a: { admin: Address; settings: OpenBountySettings }): Ix {
    return { programId: BOUNTY_PROGRAM_ID, keys: [w(openBountyPdas.config()), r(a.admin, true)], data: settings(data("set_settings"), a.settings).done() };
  },
  proposeAdmin(a: { admin: Address; newAdmin: Address }): Ix {
    return { programId: BOUNTY_PROGRAM_ID, keys: [w(openBountyPdas.config()), r(a.admin, true)], data: data("propose_admin").address(a.newAdmin).done() };
  },
  acceptAdmin(a: { newAdmin: Address }): Ix {
    return { programId: BOUNTY_PROGRAM_ID, keys: [w(openBountyPdas.config()), r(a.newAdmin, true)], data: data("accept_admin").done() };
  },
  withdrawFees(a: { admin: Address; to: Address; mint: Address; amount: bigint; tokenProgram?: Address }): Ix {
    const p = openBountyPdas;
    return {
      programId: BOUNTY_PROGRAM_ID,
      keys: [r(p.config()), r(a.admin, true), r(p.authority()), w(p.feeVault()), w(a.to), r(a.mint), r(a.tokenProgram ?? TOKEN_PROGRAM)],
      data: data("withdraw_fees").u64(a.amount).done(),
    };
  },
  /** Any wallet: escrows `amount` from its own token account (its associated account unless `funderToken` names another). */
  open(a: { funder: Address; mint: Address; args: EscrowOpenArgs; funderToken?: Address; tokenProgram?: Address }): Ix {
    const p = openBountyPdas;
    const tp = a.tokenProgram ?? TOKEN_PROGRAM;
    const b = p.bounty(a.funder, a.args.bountyId);
    const x = a.args;
    return {
      programId: BOUNTY_PROGRAM_ID,
      keys: [w(p.config()), r(registryPdas.config()), w(a.funder, true), w(a.funderToken ?? ata(a.funder, a.mint, tp)), w(b), w(p.vault(b)), r(p.authority()),
        r(a.mint), r(tp), r(SYSTEM_PROGRAM)],
      data: data("open_bounty").u64(x.bountyId).u64(x.amount).fixed32(x.termsDigest).fixed32(x.lineageId).fixed32(x.targetDigest).u16(x.minImprovementBps)
        .i64(x.deadline).done(),
    };
  },
  /** Anyone: names the winning generation with its result leaf and proof. Needs no signature beyond the fee payer's. */
  claim(a: { bounty: Address; result: BountyResult; proof: (Uint8Array | string)[] }): Ix {
    const x = a.result;
    const list = Array.isArray(x.target);
    const target = list ? (x.target as string[]) : [x.target as string];
    const wr = data("claim").u64(x.epoch).fixed32(x.gen_id).u64(x.height).u64(x.improvement_bps).i64(x.accepted_at).address(x.author).u32(target.length);
    for (const t of target) wr.string(t);
    wr.bool(list).vec32(a.proof);
    return {
      programId: BOUNTY_PROGRAM_ID,
      keys: [r(openBountyPdas.config()), w(a.bounty), r(registryPdas.epoch(x.epoch)), r(registryPdas.challengeConfig()), r(registryPdas.challengeGate(x.epoch)),
        r(launchPdas.computeVault(x.author))],
      data: wr.done(),
    };
  },
  /** Anyone, once the standing claim's contest time has passed: the escrow to the winner's compute vault. */
  pay(a: { bounty: Address; funder: Address; winner: Address; mint: Address; tokenProgram?: Address }): Ix {
    const p = openBountyPdas;
    return {
      programId: BOUNTY_PROGRAM_ID,
      keys: [r(p.config()), w(a.bounty), w(p.vault(a.bounty)), r(p.authority()), w(a.funder), w(launchPdas.computeVault(a.winner)), w(p.feeVault()), r(a.mint),
        r(a.tokenProgram ?? TOKEN_PROGRAM)],
      data: data("pay").done(),
    };
  },
  /** Anyone, after the bounty's refund time with no claim standing: the escrow to a token account of the funder. */
  refund(a: { bounty: Address; funder: Address; mint: Address; funderToken?: Address; tokenProgram?: Address }): Ix {
    return { programId: BOUNTY_PROGRAM_ID, keys: refundKeys(a), data: data("refund").done() };
  },
};
function refundKeys(a: { bounty: Address; funder: Address; mint: Address; funderToken?: Address; tokenProgram?: Address }) {
  const p = openBountyPdas;
  const tp = a.tokenProgram ?? TOKEN_PROGRAM;
  return [r(p.config()), w(a.bounty), w(p.vault(a.bounty)), r(p.authority()), w(a.funder), w(a.funderToken ?? ata(a.funder, a.mint, tp)), r(a.mint), r(tp)];
}

/**
 * A result from Core (`GET /v1/open-bounties/:id/claim`) as claim fields: the leaf is recomputed and
 * the proof checked against `root` (the onchain record root), so a bad item fails here, not on chain.
 */
export function claimFromResult(result: BountyResult, proof: string[], root: string): { leaf: string; result: BountyResult; proof: string[] } {
  const leaf = resultLeaf(result);
  if (!verifyProof(leaf, proof, root)) throw new Error("result proof does not verify against the record root");
  return { leaf, result, proof };
}

// ---------- accounts ----------

export interface OpenBountyConfig {
  admin: Address;
  pendingAdmin: Address | null;
  mint: Address;
  tokenProgram: Address;
  launchProgram: Address;
  settings: OpenBountySettings;
  opened: bigint;
}
const orNull = (a: Address) => (a === NOBODY ? null : a);
export function decodeOpenBountyConfig(d: Uint8Array): OpenBountyConfig {
  const rd = new Reader(d).expect("Config");
  return { admin: rd.address(), pendingAdmin: orNull(rd.address()), mint: rd.address(), tokenProgram: rd.address(), launchProgram: rd.address(),
    settings: { minAmount: rd.u64(), minTtlS: rd.u32(), maxTtlS: rd.u32(), refundGraceS: rd.u32(), contestS: rd.u32(), feeBps: rd.u16(), paused: rd.bool() },
    opened: rd.u64() };
}

export interface OpenBountyAccount {
  funder: Address;
  bountyId: bigint;
  amount: bigint;
  /** the fee this bounty pays at payout, fixed at open */
  feeBps: number;
  termsDigest: string;
  lineageId: string;
  targetDigest: string;
  minImprovementBps: number;
  minEpoch: bigint;
  /** the registry's epochs_posted at open; a record only */
  epochsPostedAtOpen: bigint;
  deadline: bigint;
  createdAt: bigint;
  /** a first claim is taken until then; a refund after */
  refundAfter: bigint;
  contestS: number;
  status: OpenBountyStatus;
  /** the standing claim (null = none): the author to pay, its generation and leaf */
  winner: Address | null;
  winHeight: bigint;
  winEpoch: bigint;
  winGenId: string | null;
  winImprovementBps: bigint;
  winLeaf: string | null;
  claimedAt: bigint;
  contestUntil: bigint;
  paid: bigint;
  feePaid: bigint;
  closedAt: bigint;
}
export function decodeOpenBounty(d: Uint8Array): OpenBountyAccount {
  const rd = new Reader(d).expect("Bounty");
  const z = (h: string) => (h === ZERO32 ? null : h);
  return {
    funder: rd.address(), bountyId: rd.u64(), amount: rd.u64(), feeBps: rd.u16(), termsDigest: rd.hex32(), lineageId: rd.hex32(), targetDigest: rd.hex32(),
    minImprovementBps: rd.u16(), minEpoch: rd.u64(), epochsPostedAtOpen: rd.u64(), deadline: rd.i64(), createdAt: rd.i64(), refundAfter: rd.i64(),
    contestS: rd.u32(), status: STATUS_BYTES[rd.u8()] ?? "open", winner: orNull(rd.address()), winHeight: rd.u64(), winEpoch: rd.u64(),
    winGenId: z(rd.hex32()), winImprovementBps: rd.u64(), winLeaf: z(rd.hex32()), claimedAt: rd.i64(), contestUntil: rd.i64(), paid: rd.u64(),
    feePaid: rd.u64(), closedAt: rd.i64(),
  };
}
/** Bytes of a Bounty account (its rent is paid by the funder and stays with the record). */
export const OPEN_BOUNTY_ACCOUNT_LEN = 8 + 32 + 8 + 8 + 2 + 32 + 32 + 32 + 2 + 8 + 8 + 8 + 8 + 8 + 4 + 1 + 32 + 8 + 8 + 32 + 8 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1;
