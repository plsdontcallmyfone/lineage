import { addressBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { pda, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, u64le } from "./pda.ts";
import { r, registryPdas, w, type AccountMeta, type Ix } from "./registry.ts";
import { LAUNCH_PROGRAM_ID } from "./programs.ts";
import { launchPdas, SYSVAR_INSTRUCTIONS } from "./launch.ts";

// GitHub fee routes and claims of units_launch (docs/plans/GITHUB-FEE-CLAIMS.md, program
// src/claim.rs): PDAs, builders, decoders, the attestation message Core's attestor signs and the
// Ed25519 precompile instruction that carries it. No node imports: the claim page uses this file.

/** `LaunchConfig.features` bits, and the same bits in `AgentLaunch.routes`. */
export const FEATURES = { pools: 1, githubFees: 2 } as const;
export const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";
export const CLAIM_DOMAIN = "units-github-claim-v1";
/** The program's own ceiling for a route, whatever the admin's bounds are. */
export const MAX_ROUTE_BPS = 5000;

export const claimPdas = {
  config: () => pda(LAUNCH_PROGRAM_ID, "claim_config"),
  feeRoute: (agent: Address) => pda(LAUNCH_PROGRAM_ID, "fee_route", addressBytes(agent)),
  escrow: (githubId: bigint | number) => pda(LAUNCH_PROGRAM_ID, "gh_escrow", u64le(githubId)),
  vault: (githubId: bigint | number) => pda(LAUNCH_PROGRAM_ID, "gh_vault", u64le(githubId)),
};

export interface ClaimConfigArgs {
  attestor: Address;
  minBps: number;
  maxBps: number;
  changeDelayS: bigint | number;
  rebindDelayS: bigint | number;
  maxAttestationTtlS: bigint | number;
  paused: boolean;
}

/** The bytes the attestor signs for one claim (claim.rs `claim_message`). */
export function claimMessage(a: { githubId: bigint | number; wallet: Address; ceiling: bigint; claimSeq: bigint | number; expiresAt: bigint | number; program?: Address }): Uint8Array {
  return new Writer().bytes(new TextEncoder().encode(CLAIM_DOMAIN)).address(a.program ?? LAUNCH_PROGRAM_ID).u64(a.githubId).address(a.wallet).u64(a.ceiling)
    .u64(a.claimSeq).i64(a.expiresAt).done();
}

/** The Ed25519 precompile instruction for one signature, with key, signature and message inside its own data. */
export function ed25519Ix(publicKey: Address | Uint8Array, signature: Uint8Array, message: Uint8Array): Ix {
  const key = typeof publicKey === "string" ? addressBytes(publicKey) : publicKey;
  if (key.length !== 32 || signature.length !== 64) throw new Error("ed25519Ix: a 32-byte key and a 64-byte signature");
  const self = 0xffff;
  const data = new Writer().u8(1).u8(0).u16(48).u16(self).u16(16).u16(self).u16(112).u16(message.length).u16(self).bytes(key).bytes(signature).bytes(message).done();
  return { programId: ED25519_PROGRAM, keys: [], data };
}

const data = (name: string) => new Writer().bytes(ixDisc(name));

export const claims = {
  /** Launch admin: the feature bits (FEATURES). */
  setFeatures(a: { admin: Address; features: number }): Ix {
    return { programId: LAUNCH_PROGRAM_ID, keys: [w(launchPdas.config()), r(a.admin, true)], data: data("set_features").u8(a.features).done() };
  },
  setClaimConfig(a: { admin: Address; args: ClaimConfigArgs }): Ix {
    const c = a.args;
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), w(a.admin, true), w(claimPdas.config()), r(SYSTEM_PROGRAM)],
      data: data("set_claim_config").address(c.attestor).u16(c.minBps).u16(c.maxBps).i64(c.changeDelayS).i64(c.rebindDelayS).i64(c.maxAttestationTtlS).bool(c.paused).done(),
    };
  },
  /** The agent's registry owner: immediate the first time, pending for `change_delay_s` afterwards. */
  setFeeRoute(a: { owner: Address; agent: Address; agentMint: Address; lineMint: Address; githubId: bigint | number; bps: number; lineTokenProgram?: Address }): Ix {
    const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM;
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), r(claimPdas.config()), w(a.owner, true), w(launchPdas.agentLaunch(a.agentMint)), r(registryPdas.agent(a.agent)),
        w(claimPdas.feeRoute(a.agent)), w(claimPdas.escrow(a.githubId)), w(claimPdas.vault(a.githubId)), r(launchPdas.authority()), r(a.lineMint), r(tp),
        r(SYSTEM_PROGRAM)],
      data: data("set_fee_route").u64(a.githubId).u16(a.bps).done(),
    };
  },
  applyFeeRoute(a: { agent: Address }): Ix {
    return { programId: LAUNCH_PROGRAM_ID, keys: [r(claimPdas.config()), w(claimPdas.feeRoute(a.agent))], data: data("apply_fee_route").done() };
  },
  /** Must follow, in the same transaction, the Ed25519 instruction over `claimMessage` with the same fields. */
  claimGithubFees(a: { wallet: Address; walletToken: Address; githubId: bigint | number; lineMint: Address; ceiling: bigint; expiresAt: bigint | number;
    lineTokenProgram?: Address }): Ix {
    const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM;
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), r(claimPdas.config()), r(a.wallet, true), w(claimPdas.escrow(a.githubId)), w(claimPdas.vault(a.githubId)), w(a.walletToken),
        r(launchPdas.authority()), r(a.lineMint), r(tp), r(SYSVAR_INSTRUCTIONS)],
      data: data("claim_github_fees").u64(a.ceiling).i64(a.expiresAt).done(),
    };
  },
  /** The crank's trailing accounts for an agent whose route names `githubId`. */
  crankRouteKeys(agent: Address, githubId: bigint | number): AccountMeta[] {
    return [w(claimPdas.feeRoute(agent)), w(claimPdas.escrow(githubId)), w(claimPdas.vault(githubId))];
  },
};

export interface ClaimConfig extends Omit<ClaimConfigArgs, "changeDelayS" | "rebindDelayS" | "maxAttestationTtlS"> {
  changeDelayS: bigint;
  rebindDelayS: bigint;
  maxAttestationTtlS: bigint;
}
export function decodeClaimConfig(d: Uint8Array): ClaimConfig {
  const rd = new Reader(d).expect("ClaimConfig");
  return { attestor: rd.address(), minBps: rd.u16(), maxBps: rd.u16(), changeDelayS: rd.i64(), rebindDelayS: rd.i64(), maxAttestationTtlS: rd.i64(), paused: rd.bool() };
}

export interface FeeRoute {
  agent: Address;
  githubId: bigint;
  bps: number;
  setAt: bigint;
  pendingGithubId: bigint;
  pendingBps: number;
  /** 0 = nothing pending. */
  pendingEffectiveAt: bigint;
  accrued: bigint;
  accruedTotal: bigint;
  changes: number;
}
export function decodeFeeRoute(d: Uint8Array): FeeRoute {
  const rd = new Reader(d).expect("FeeRoute");
  return { agent: rd.address(), githubId: rd.u64(), bps: rd.u16(), setAt: rd.i64(), pendingGithubId: rd.u64(), pendingBps: rd.u16(), pendingEffectiveAt: rd.i64(),
    accrued: rd.u64(), accruedTotal: rd.u64(), changes: rd.u32() };
}

export interface ClaimEscrow {
  githubId: bigint;
  /** The pinned wallet; the default key before the first claim. */
  wallet: Address;
  pendingWallet: Address;
  pendingEffectiveAt: bigint;
  accrued: bigint;
  claimed: bigint;
  claimSeq: bigint;
}
export function decodeClaimEscrow(d: Uint8Array): ClaimEscrow {
  const rd = new Reader(d).expect("ClaimEscrow");
  return { githubId: rd.u64(), wallet: rd.address(), pendingWallet: rd.address(), pendingEffectiveAt: rd.i64(), accrued: rd.u64(), claimed: rd.u64(), claimSeq: rd.u64() };
}

/** The split one crank makes (AGENT-POOLS.md D3); `routeBps` and `poolFeeBps` are 0 when they do not apply. */
export function crankSplit(fees: bigint, agentComputeBps: number, routeBps = 0, poolFeeBps = 0) {
  const agentShare = (fees * BigInt(agentComputeBps)) / 10_000n;
  const toGithub = (agentShare * BigInt(routeBps)) / 10_000n, toPool = (agentShare * BigInt(poolFeeBps)) / 10_000n;
  return { toProtocol: fees - agentShare, toGithub, toPool, toCompute: agentShare - toGithub - toPool };
}
