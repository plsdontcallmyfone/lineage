import { hexToBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, u64le } from "./pda.ts";
import { r, REGISTRY_PROGRAM_ID, registryPdas, w, type Ix } from "./registry.ts";

// Bonded challenges (SPEC 10.8), in lineage_registry (onchain/programs/lineage-registry/src/challenge.rs):
// a registered agent contests a final verdict, a slash or an epoch root by bonding `$LINE`; Core
// records its resolution with the Core authority. Account order and encodings match the program;
// onchain/tests/fixtures/client-vectors.json pins them.

const P = REGISTRY_PROGRAM_ID;
const data = (name: string) => new Writer().bytes(ixDisc(name));

export const CHALLENGE_KIND = { verdict: 0, slash: 1, epoch: 2 } as const;
export const CHALLENGE_KINDS = ["verdict", "slash", "epoch"] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];
export const CHALLENGE_OUTCOME = { upheld: 1, failed: 2, void: 3 } as const;
export const CHALLENGE_STATUS = ["open", "upheld", "failed", "void", "expired"] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUS)[number];

/** The 32-byte subject of an epoch challenge: the epoch number little-endian, zero padded. */
export function epochSubject(n: bigint | number): Uint8Array {
  const s = new Uint8Array(32);
  s.set(u64le(n), 0);
  return s;
}

export interface ChallengeConfigArgs {
  windowS: bigint | number;
  bond: bigint;
  reward: bigint;
  resolveTimeoutS: bigint | number;
  paused: boolean;
}
export interface CorrectedRoots {
  payoutRoot: Uint8Array | string;
  lineageRoot: Uint8Array | string;
  recordRoot: Uint8Array | string;
  totalUnitsMicro: bigint;
}
const subjectBytes = (s: Uint8Array | string) => (typeof s === "string" ? hexToBytes(s) : s);

export const challenge = {
  /** Admin: creates or updates the ChallengeConfig and the challenge bond vault. */
  setConfig(a: { admin: Address; mint: Address; args: ChallengeConfigArgs; tokenProgram?: Address }): Ix {
    const pd = registryPdas;
    return {
      programId: P,
      keys: [r(pd.config()), w(a.admin, true), w(pd.challengeConfig()), r(a.mint), r(pd.vaultAuthority()), w(pd.challengeVault()),
        r(a.tokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM)],
      data: data("set_challenge_config").i64(a.args.windowS).u64(a.args.bond).u64(a.args.reward).i64(a.args.resolveTimeoutS).bool(a.args.paused).done(),
    };
  },
  /**
   * A registered agent (`signingKey` is its current registry signing key) opens a challenge; `payer`
   * bonds from `payerToken` and pays the rent. `epoch`: the epoch the challenge holds (verdict: the
   * epoch its units land in; slash: the slash's epoch; epoch: the epoch itself).
   */
  open(a: { challenger: Address; signingKey: Address; payer: Address; payerToken: Address; mint: Address; kind: number; subject: Uint8Array | string;
    epoch: bigint | number; claim: Uint8Array | string; tokenProgram?: Address }): Ix {
    const pd = registryPdas;
    const subject = subjectBytes(a.subject);
    return {
      programId: P,
      keys: [r(pd.config()), w(pd.challengeConfig()), r(pd.agent(a.challenger)), r(a.signingKey, true), w(a.payer, true), w(a.payerToken),
        w(pd.challenge(a.kind, subject)), w(pd.challengeGate(a.epoch)), r(pd.epoch(a.epoch)),
        r(a.kind === CHALLENGE_KIND.slash ? pd.slashReceipt(subject) : P), r(a.mint), w(pd.challengeVault()), r(a.tokenProgram ?? TOKEN_PROGRAM),
        r(SYSTEM_PROGRAM)],
      data: data("open_challenge").u8(a.kind).fixed32(subject).u64(a.epoch).fixed32(a.claim).done(),
    };
  },
  /**
   * Core authority: records the outcome. An upheld slash challenge names the slashed agent
   * (`slashedAgent`) so the slash is reversed; `corrected` replaces a posted epoch's roots.
   */
  resolve(a: { coreAuthority: Address; mint: Address; kind: number; subject: Uint8Array | string; epoch: bigint | number; refundToken: Address;
    outcome: number; evidence: Uint8Array | string; corrected?: CorrectedRoots | null; slashedAgent?: Address | null; tokenProgram?: Address }): Ix {
    const pd = registryPdas;
    const subject = subjectBytes(a.subject);
    const isSlash = a.kind === CHALLENGE_KIND.slash;
    const wr = data("resolve_challenge").u8(a.outcome).fixed32(a.evidence);
    if (a.corrected) wr.u8(1).fixed32(a.corrected.payoutRoot).fixed32(a.corrected.lineageRoot).fixed32(a.corrected.recordRoot).u64(a.corrected.totalUnitsMicro);
    else wr.u8(0);
    return {
      programId: P,
      keys: [r(pd.config()), w(pd.challengeConfig()), r(a.coreAuthority, true), w(pd.challenge(a.kind, subject)), w(pd.challengeGate(a.epoch)),
        w(a.refundToken), r(a.mint), r(pd.vaultAuthority()), w(pd.challengeVault()), w(pd.reserve()),
        a.corrected ? w(pd.epoch(a.epoch)) : r(P),
        isSlash ? r(pd.slashReceipt(subject)) : r(P),
        a.slashedAgent ? w(pd.agent(a.slashedAgent)) : r(P),
        isSlash ? w(pd.bondVault()) : r(P),
        r(a.tokenProgram ?? TOKEN_PROGRAM)],
      data: wr.done(),
    };
  },
  /** Anyone, after resolve_timeout_s: returns an unresolved challenge's bond and ends its hold. */
  expire(a: { kind: number; subject: Uint8Array | string; epoch: bigint | number; refundToken: Address; mint: Address; tokenProgram?: Address }): Ix {
    const pd = registryPdas;
    return {
      programId: P,
      keys: [r(pd.config()), w(pd.challengeConfig()), w(pd.challenge(a.kind, subjectBytes(a.subject))), w(pd.challengeGate(a.epoch)), w(a.refundToken),
        r(a.mint), r(pd.vaultAuthority()), w(pd.challengeVault()), r(a.tokenProgram ?? TOKEN_PROGRAM)],
      data: data("expire_challenge").done(),
    };
  },
};

// ---------- accounts ----------

export interface ChallengeConfig {
  windowS: bigint;
  bond: bigint;
  reward: bigint;
  resolveTimeoutS: bigint;
  paused: boolean;
  open: number;
}
export function decodeChallengeConfig(d: Uint8Array): ChallengeConfig {
  const rd = new Reader(d).expect("ChallengeConfig");
  return { windowS: rd.i64(), bond: rd.u64(), reward: rd.u64(), resolveTimeoutS: rd.i64(), paused: rd.bool(), open: rd.u32() };
}

export interface ChallengeAccount {
  kind: ChallengeKind;
  subject: string;
  epoch: bigint;
  challenger: Address;
  payer: Address;
  refundToken: Address;
  bond: bigint;
  claim: string;
  openedAt: bigint;
  status: ChallengeStatus;
  resolvedAt: bigint;
  evidence: string;
  reward: bigint;
  reversed: bigint;
  corrected: boolean;
}
export function decodeChallenge(d: Uint8Array): ChallengeAccount {
  const rd = new Reader(d).expect("Challenge");
  return {
    kind: CHALLENGE_KINDS[rd.u8()] ?? ("verdict" as ChallengeKind), subject: rd.hex32(), epoch: rd.u64(), challenger: rd.address(), payer: rd.address(),
    refundToken: rd.address(), bond: rd.u64(), claim: rd.hex32(), openedAt: rd.i64(), status: CHALLENGE_STATUS[rd.u8()] ?? "open", resolvedAt: rd.i64(),
    evidence: rd.hex32(), reward: rd.u64(), reversed: rd.u64(), corrected: rd.bool(),
  };
}

export interface ChallengeGate {
  epoch: bigint;
  open: number;
  opened: number;
  upheld: number;
  corrected: boolean;
}
export function decodeChallengeGate(d: Uint8Array): ChallengeGate {
  const rd = new Reader(d).expect("ChallengeGate");
  return { epoch: rd.u64(), open: rd.u32(), opened: rd.u32(), upheld: rd.u32(), corrected: rd.bool() };
}
