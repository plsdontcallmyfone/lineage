import { addressBytes, hexToBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { BPF_LOADER_UPGRADEABLE, pda, SYSTEM_PROGRAM, TOKEN_PROGRAM, u64le } from "./pda.ts";
import { REGISTRY_PROGRAM_ID } from "./programs.ts";

// units_registry (SPEC 14.1): addresses, instruction builders and account decoders. Account
// order and encodings match the Anchor program; onchain/tests/fixtures/client-vectors.json pins them.

/** The active network's id (devnet until a profile is applied; programs.ts). */
export { REGISTRY_PROGRAM_ID };

export interface AccountMeta {
  pubkey: Address;
  isSigner: boolean;
  isWritable: boolean;
}
/** Same shape as @solana/web3.js TransactionInstruction's constructor argument. */
export interface Ix {
  programId: Address;
  keys: AccountMeta[];
  data: Uint8Array;
}
export const w = (pubkey: Address, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
export const r = (pubkey: Address, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

export const registryPdas = {
  config: () => pda(REGISTRY_PROGRAM_ID, "config"),
  vaultAuthority: () => pda(REGISTRY_PROGRAM_ID, "vault_authority"),
  bondVault: () => pda(REGISTRY_PROGRAM_ID, "bond_vault"),
  treasury: () => pda(REGISTRY_PROGRAM_ID, "treasury"),
  reserve: () => pda(REGISTRY_PROGRAM_ID, "reserve"),
  pool: () => pda(REGISTRY_PROGRAM_ID, "pool"),
  payable: () => pda(REGISTRY_PROGRAM_ID, "payable"),
  agent: (agent: Address) => pda(REGISTRY_PROGRAM_ID, "agent", addressBytes(agent)),
  epoch: (n: bigint | number) => pda(REGISTRY_PROGRAM_ID, "epoch", u64le(n)),
  claimReceipt: (n: bigint | number, leaf: Uint8Array) => pda(REGISTRY_PROGRAM_ID, "claim", u64le(n), leaf),
  /** One per slash Core sent, keyed by Core's 32-byte slash id: a retried slash lands once. */
  slashReceipt: (slashId: Uint8Array | string) => pda(REGISTRY_PROGRAM_ID, "slash", typeof slashId === "string" ? hexToBytes(slashId) : slashId),
  programData: (program: Address = REGISTRY_PROGRAM_ID) => pda(BPF_LOADER_UPGRADEABLE, addressBytes(program)),
  // bonded challenges (SPEC 10.8, src/challenge.ts)
  challengeConfig: () => pda(REGISTRY_PROGRAM_ID, "challenge_config"),
  challengeVault: () => pda(REGISTRY_PROGRAM_ID, "challenge_vault"),
  /** One per epoch any challenge named; claims of the epoch wait while its `open` count is above zero. */
  challengeGate: (n: bigint | number) => pda(REGISTRY_PROGRAM_ID, "challenge_gate", u64le(n)),
  /** One per subject: kind 0 verdict (candidate id), 1 slash (slash id), 2 epoch (epoch number, little-endian, zero padded). */
  challenge: (kind: number, subject: Uint8Array | string) => pda(REGISTRY_PROGRAM_ID, "challenge", Uint8Array.of(kind), typeof subject === "string" ? hexToBytes(subject) : subject),
};

export const OFFENCE = { canary: 0, minority: 1, reveal: 2, abandon: 3 } as const;
export const DEST_KIND = { agentWallet: 0, agentCompute: 1, wallet: 2 } as const;

export interface Params {
  registerBurn: bigint;
  minBond: bigint;
  bondCap: bigint;
  unbondCooldownS: bigint;
  epochLengthS: number;
  reserveBps: number;
  poolBps: number;
  canarySlashBps: number;
  minoritySlashBps: number;
  revealSlashBps: number;
  strikeLimit: number;
  uReplay: number;
  uAuthor: number;
  finderShareBps: number;
  valueCap: number;
  rebatePerClass: bigint;
  maxOpenCandidatesPerAgent: number;
  /** 0 compute vault, 1 launcher. */
  authorRewardTo: number;
  quorum: number;
}
export interface ConfigArgs {
  admin: Address;
  coreAuthority: Address;
  launchProgram: Address;
  params: Params;
  /** Most `rebate_amount` one post_epoch may move from the reserve. */
  maxRebatePerEpoch: bigint;
}

function writeParams(wr: Writer, p: Params): Writer {
  return wr
    .u64(p.registerBurn).u64(p.minBond).u64(p.bondCap).i64(p.unbondCooldownS).u32(p.epochLengthS)
    .u16(p.reserveBps).u16(p.poolBps).u16(p.canarySlashBps).u16(p.minoritySlashBps).u16(p.revealSlashBps).u16(p.strikeLimit)
    .u32(p.uReplay).u32(p.uAuthor).u16(p.finderShareBps).u32(p.valueCap).u64(p.rebatePerClass).u16(p.maxOpenCandidatesPerAgent)
    .u8(p.authorRewardTo).u8(p.quorum);
}
function readParams(rd: Reader): Params {
  return {
    registerBurn: rd.u64(), minBond: rd.u64(), bondCap: rd.u64(), unbondCooldownS: rd.i64(), epochLengthS: rd.u32(),
    reserveBps: rd.u16(), poolBps: rd.u16(), canarySlashBps: rd.u16(), minoritySlashBps: rd.u16(), revealSlashBps: rd.u16(), strikeLimit: rd.u16(),
    uReplay: rd.u32(), uAuthor: rd.u32(), finderShareBps: rd.u16(), valueCap: rd.u32(), rebatePerClass: rd.u64(), maxOpenCandidatesPerAgent: rd.u16(),
    authorRewardTo: rd.u8(), quorum: rd.u8(),
  };
}
const configArgs = (wr: Writer, a: ConfigArgs) =>
  writeParams(wr.address(a.admin).address(a.coreAuthority).address(a.launchProgram), a.params).u64(a.maxRebatePerEpoch);
const data = (name: string) => new Writer().bytes(ixDisc(name));

/**
 * Params from a config/network.json object (SPEC 13). Amounts there are base units of a
 * `token_decimals`-decimal token; `decimals` rescales them to the onchain mint's decimals.
 */
export function paramsFromNetworkJson(n: Record<string, unknown>, decimals = Number(n.token_decimals ?? 0)): Params {
  const from = Number(n.token_decimals ?? decimals);
  const big = (k: string) => (BigInt(String(n[k])) * 10n ** BigInt(decimals)) / 10n ** BigInt(from);
  return {
    registerBurn: big("register_burn"), minBond: big("min_bond"), bondCap: big("bond_cap"), unbondCooldownS: BigInt(Number(n.unbond_cooldown_s)),
    epochLengthS: Number(n.epoch_length_s), reserveBps: Number(n.reserve_bps), poolBps: Number(n.pool_bps), canarySlashBps: Number(n.canary_slash_bps),
    minoritySlashBps: Number(n.minority_slash_bps), revealSlashBps: Number(n.reveal_slash_bps), strikeLimit: Number(n.strike_limit),
    uReplay: Number(n.u_replay), uAuthor: Number(n.u_author), finderShareBps: Math.round(Number(n.finder_share) * 10_000), valueCap: Number(n.value_cap),
    rebatePerClass: big("rebate_per_class"), maxOpenCandidatesPerAgent: Number(n.max_open_candidates_per_agent),
    authorRewardTo: n.author_reward_to === "launcher" ? 1 : 0, quorum: Number(n.quorum),
  };
}

export const registry = {
  initialize(a: { upgradeAuthority: Address; mint: Address; tokenProgram?: Address; args: ConfigArgs }): Ix {
    const pd = registryPdas;
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [w(pd.config()), w(a.upgradeAuthority, true), r(pd.programData()), r(a.mint), r(pd.vaultAuthority()), w(pd.bondVault()),
        w(pd.treasury()), w(pd.reserve()), w(pd.pool()), w(pd.payable()), r(a.tokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM)],
      data: configArgs(data("initialize"), a.args).done(),
    };
  },
  setConfig(a: { admin: Address; args: ConfigArgs }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [w(registryPdas.config()), r(a.admin, true)], data: configArgs(data("set_config"), a.args).done() };
  },
  pause(a: { admin: Address; paused: boolean }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [w(registryPdas.config()), r(a.admin, true)], data: data("pause").bool(a.paused).done() };
  },
  /** Admin escape hatch for post_epoch's sequence and clock anchor. */
  setEpochCursor(a: { admin: Address; epochsPosted: bigint | number; lastEpoch: bigint | number; anchor: bigint | number; anchorTs: bigint | number }): Ix {
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [w(registryPdas.config()), r(a.admin, true)],
      data: data("set_epoch_cursor").u64(a.epochsPosted).u64(a.lastEpoch).u64(a.anchor).i64(a.anchorTs).done(),
    };
  },
  /**
   * Admin (audit A1-08): the most one agent may lose to slashes within one chain epoch, in basis
   * points of its bond at stake in that epoch; at least every single slash share, at most 10,000.
   */
  setSlashCap(a: { admin: Address; maxSlashBpsPerEpoch: number }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [w(registryPdas.config()), r(a.admin, true)], data: data("set_slash_cap").u16(a.maxSlashBpsPerEpoch).done() };
  },
  /** Admin, once: grows a Config written before the slash cap by its two bytes and sets the cap. */
  migrateConfigSlashCap(a: { admin: Address; maxSlashBpsPerEpoch: number }): Ix {
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [w(registryPdas.config()), w(a.admin, true), r(SYSTEM_PROGRAM)],
      data: data("migrate_config_slash_cap").u16(a.maxSlashBpsPerEpoch).done(),
    };
  },
  /** Admin, once: grows a Config written by the first deployed layout to the current one. */
  migrateConfig(a: { admin: Address; maxRebatePerEpoch: bigint }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [w(registryPdas.config()), w(a.admin, true), r(SYSTEM_PROGRAM)], data: data("migrate_config").u64(a.maxRebatePerEpoch).done() };
  },
  /** Tokenless verifier: `owner` burns register_burn from `ownerToken`; `agent` co-signs. */
  register(a: { owner: Address; agent: Address; mint: Address; ownerToken: Address; operator: Uint8Array | string; capabilities: Uint8Array | string;
    tokenProgram?: Address }): Ix {
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [r(registryPdas.config()), w(a.owner, true), r(a.agent, true), w(registryPdas.agent(a.agent)), w(a.mint), w(a.ownerToken),
        r(a.tokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM)],
      data: data("register").fixed32(a.operator).fixed32(a.capabilities).done(),
    };
  },
  updateAgent(a: { owner: Address; agent: Address; operator: Uint8Array | string; capabilities: Uint8Array | string }): Ix {
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [r(registryPdas.config()), r(a.owner, true), w(registryPdas.agent(a.agent))],
      data: data("update_agent").fixed32(a.operator).fixed32(a.capabilities).done(),
    };
  },
  bond(a: { owner: Address; agent: Address; mint: Address; ownerToken: Address; amount: bigint; tokenProgram?: Address }): Ix {
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [r(registryPdas.config()), r(a.owner, true), w(registryPdas.agent(a.agent)), r(a.mint), w(a.ownerToken), w(registryPdas.bondVault()),
        r(a.tokenProgram ?? TOKEN_PROGRAM)],
      data: data("bond").u64(a.amount).done(),
    };
  },
  requestUnbond(a: { owner: Address; agent: Address; amount: bigint }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [r(registryPdas.config()), r(a.owner, true), w(registryPdas.agent(a.agent))], data: data("request_unbond").u64(a.amount).done() };
  },
  withdrawUnbonded(a: { owner: Address; agent: Address; mint: Address; ownerToken: Address; tokenProgram?: Address }): Ix {
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [r(registryPdas.config()), r(a.owner, true), w(registryPdas.agent(a.agent)), r(a.mint), w(a.ownerToken), r(registryPdas.vaultAuthority()),
        w(registryPdas.bondVault()), r(a.tokenProgram ?? TOKEN_PROGRAM)],
      data: data("withdraw_unbonded").done(),
    };
  },
  /** `slashId` (32 bytes) is Core's id for the slash; its receipt PDA makes a retry land at most once. */
  slash(a: { coreAuthority: Address; agent: Address; mint: Address; offence: number; epoch: bigint | number; slashId: Uint8Array | string;
    tokenProgram?: Address }): Ix {
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [r(registryPdas.config()), w(a.coreAuthority, true), w(registryPdas.slashReceipt(a.slashId)), w(registryPdas.agent(a.agent)), r(a.mint),
        r(registryPdas.vaultAuthority()), w(registryPdas.bondVault()), w(registryPdas.reserve()), r(a.tokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM)],
      data: data("slash").u8(a.offence).u64(a.epoch).fixed32(a.slashId).done(),
    };
  },
  split(a: { mint: Address; tokenProgram?: Address }): Ix {
    const pd = registryPdas;
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [r(pd.config()), r(a.mint), r(pd.vaultAuthority()), w(pd.treasury()), w(pd.reserve()), w(pd.pool()), r(a.tokenProgram ?? TOKEN_PROGRAM)],
      data: data("split").done(),
    };
  },
  /** `recordRoot`: the epoch's reputation and contribution records root (identity plan 2.4); zero bytes when omitted. */
  postEpoch(a: { coreAuthority: Address; mint: Address; epoch: bigint | number; payoutRoot: Uint8Array | string; lineageRoot: Uint8Array | string;
    recordRoot?: Uint8Array | string; totalUnitsMicro: bigint; poolAmount: bigint; rebateAmount: bigint; tokenProgram?: Address }): Ix {
    const pd = registryPdas;
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [w(pd.config()), w(a.coreAuthority, true), w(pd.epoch(a.epoch)), r(a.mint), r(pd.vaultAuthority()), w(pd.pool()), w(pd.reserve()),
        w(pd.payable()), r(a.tokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM)],
      data: data("post_epoch").u64(a.epoch).fixed32(a.payoutRoot).fixed32(a.lineageRoot).u64(a.totalUnitsMicro).u64(a.poolAmount).u64(a.rebateAmount)
        .fixed32(a.recordRoot ?? new Uint8Array(32)).done(),
    };
  },
  /** Owner and the new key both sign (Agent v2): `newKey` becomes the agent's signing key. */
  rotateAgentKey(a: { owner: Address; agent: Address; newKey: Address }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [r(registryPdas.config()), r(a.owner, true), r(a.newKey, true), w(registryPdas.agent(a.agent))], data: data("rotate_agent_key").done() };
  },
  /** Owner: the signing key becomes the default key (revoked) until a rotation. */
  revokeAgentKey(a: { owner: Address; agent: Address }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [r(registryPdas.config()), r(a.owner, true), w(registryPdas.agent(a.agent))], data: data("revoke_agent_key").done() };
  },
  /** The agent's current signing key: sha256 of its profile document, with a strictly increasing seq. */
  setProfile(a: { signingKey: Address; agent: Address; digest: Uint8Array | string; seq: number }): Ix {
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [r(registryPdas.config()), r(a.signingKey, true), w(registryPdas.agent(a.agent))],
      data: data("set_profile").fixed32(a.digest).u32(a.seq).done(),
    };
  },
  /** Owner: proposes a new owner (the default address cancels). Nothing changes until it accepts. */
  proposeOwner(a: { owner: Address; agent: Address; newOwner: Address }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [r(registryPdas.config()), r(a.owner, true), w(registryPdas.agent(a.agent))], data: data("propose_owner").address(a.newOwner).done() };
  },
  /** The proposed owner completes the transfer; `ownerSince` restarts. */
  acceptOwner(a: { newOwner: Address; agent: Address }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [r(registryPdas.config()), r(a.newOwner, true), w(registryPdas.agent(a.agent))], data: data("accept_owner").done() };
  },
  /** Anyone (payer adds the rent): grows a v1 Agent record to Agent v2. */
  migrateAgent(a: { payer: Address; agent: Address }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [w(registryPdas.agent(a.agent)), w(a.payer, true), r(SYSTEM_PROGRAM)], data: data("migrate_agent").done() };
  },
  /** Anyone (payer adds the rent): grows an Epoch posted before `record_root` existed. */
  migrateEpoch(a: { payer: Address; epoch: bigint | number }): Ix {
    return { programId: REGISTRY_PROGRAM_ID, keys: [w(registryPdas.epoch(a.epoch)), w(a.payer, true), r(SYSTEM_PROGRAM)], data: data("migrate_epoch").done() };
  },
  /**
   * Anyone may send a claim; tokens go only to the leaf's destination. `agentRecord` is required for
   * `agent:<id>:wallet` leaves (pass registryPdas.agent(agent)) and omitted otherwise. The last two
   * accounts are the challenge config and the epoch's challenge gate: the program holds the claim
   * during the epoch's challenge window and while a challenge on it is open (SPEC 10.8).
   */
  claim(a: { payer: Address; mint: Address; epoch: bigint | number; agent: Address; destKind: number; wallet?: Address; amount: bigint;
    leaf: Uint8Array; proof: Uint8Array[]; destToken: Address; agentRecord?: Address; tokenProgram?: Address }): Ix {
    const pd = registryPdas;
    return {
      programId: REGISTRY_PROGRAM_ID,
      keys: [r(pd.config()), w(a.payer, true), w(pd.epoch(a.epoch)), w(pd.claimReceipt(a.epoch, a.leaf)), r(a.agentRecord ?? REGISTRY_PROGRAM_ID), r(a.mint),
        r(pd.vaultAuthority()), w(pd.payable()), w(a.destToken), r(a.tokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM), r(pd.challengeConfig()),
        r(pd.challengeGate(a.epoch))],
      data: data("claim").address(a.agent).u8(a.destKind).address(a.wallet ?? SYSTEM_PROGRAM).u64(a.amount).fixed32(a.leaf).vec32(a.proof).done(),
    };
  },
};

// ---------- accounts ----------

export interface RegistryConfig {
  admin: Address;
  coreAuthority: Address;
  launchProgram: Address;
  mint: Address;
  tokenProgram: Address;
  params: Params;
  paused: boolean;
  epochsPosted: bigint;
  lastEpoch: bigint;
  /** Null on a Config the first layout wrote (before `migrate_config`). */
  maxRebatePerEpoch: bigint | null;
  /** post_epoch's clock anchor: epoch `epochAnchor` was posted at `epochAnchorTs`. */
  epochAnchor: bigint | null;
  epochAnchorTs: bigint | null;
  /** Audit A1-08: the per agent, per epoch slash cap in bps; null on a Config written before it (`migrate_config_slash_cap`). */
  maxSlashBpsPerEpoch: number | null;
}
export function decodeConfig(d: Uint8Array): RegistryConfig {
  const rd = new Reader(d).expect("Config");
  const head = {
    admin: rd.address(), coreAuthority: rd.address(), launchProgram: rd.address(), mint: rd.address(), tokenProgram: rd.address(),
    params: readParams(rd), paused: rd.bool(), epochsPosted: rd.u64(), lastEpoch: rd.u64(),
  };
  rd.u8(); // bump
  rd.u8(); // vault_authority_bump
  const v2 = rd.remaining() >= 24;
  const tail = { maxRebatePerEpoch: v2 ? rd.u64() : null, epochAnchor: v2 ? rd.u64() : null, epochAnchorTs: v2 ? rd.i64() : null };
  return { ...head, ...tail, maxSlashBpsPerEpoch: v2 && rd.remaining() >= 2 ? rd.u16() : null };
}

export interface SlashReceipt {
  slashId: string;
  agent: Address;
  offence: number;
  epoch: bigint;
  amount: bigint;
  slashedAt: bigint;
}
export function decodeSlashReceipt(d: Uint8Array): SlashReceipt {
  const rd = new Reader(d).expect("SlashReceipt");
  return { slashId: rd.hex32(), agent: rd.address(), offence: rd.u8(), epoch: rd.u64(), amount: rd.u64(), slashedAt: rd.i64() };
}

export interface AgentRecord {
  agent: Address;
  owner: Address;
  kind: "verifier" | "launched";
  mint: Address;
  hosted: boolean;
  burned: bigint;
  bond: bigint;
  unbondAmount: bigint;
  unbondRequestedAt: bigint;
  unbondReadyAt: bigint;
  strikesTotal: number;
  strikesEpoch: bigint;
  strikesInEpoch: number;
  suspendedThroughEpoch: bigint;
  slashedTotal: bigint;
  operator: string;
  capabilities: string;
  registeredAt: bigint;
  /** 1 for a record the first layout wrote (needs `migrate_agent`), 2 for Agent v2. */
  version: 1 | 2;
  /**
   * Agent v2 (identity plan I1). On a v1 record these read as they will after `migrate_agent`:
   * signing key = the agent key, no rotation, no profile, no pending owner, owner since registration.
   * `signingKey` is null when the owner revoked it.
   */
  signingKey: Address | null;
  keySeq: number;
  keyChangedAt: bigint;
  profileDigest: string | null;
  profileSeq: number;
  pendingOwner: Address | null;
  ownerSince: bigint;
  /** Audit A1-08: the chain epoch window (`Config.epochs_posted`) of `slashedInWindow`, and what was slashed in it. */
  slashWindow: bigint;
  slashedInWindow: bigint;
}
/** Bytes Agent v2 appended to the first layout. */
export const AGENT_V2_TAIL = 32 + 4 + 8 + 32 + 4 + 32 + 8 + 32;
const DEFAULT_ADDRESS = "11111111111111111111111111111111";
const ZERO_HEX = "00".repeat(32);
export function decodeAgent(d: Uint8Array): AgentRecord {
  const rd = new Reader(d).expect("Agent");
  const v1 = {
    agent: rd.address(), owner: rd.address(), kind: (rd.u8() === 1 ? "launched" : "verifier") as AgentRecord["kind"], mint: rd.address(), hosted: rd.bool(),
    burned: rd.u64(), bond: rd.u64(), unbondAmount: rd.u64(), unbondRequestedAt: rd.i64(), unbondReadyAt: rd.i64(), strikesTotal: rd.u32(),
    strikesEpoch: rd.u64(), strikesInEpoch: rd.u16(), suspendedThroughEpoch: rd.u64(), slashedTotal: rd.u64(), operator: rd.hex32(),
    capabilities: rd.hex32(), registeredAt: rd.i64(),
  };
  rd.u8(); // bump
  if (rd.remaining() < AGENT_V2_TAIL)
    return { ...v1, version: 1, signingKey: v1.agent, keySeq: 0, keyChangedAt: 0n, profileDigest: null, profileSeq: 0, pendingOwner: null, ownerSince: v1.registeredAt,
      slashWindow: 0n, slashedInWindow: 0n };
  const signingKey = rd.address();
  const keySeq = rd.u32();
  const keyChangedAt = rd.i64();
  const profileDigest = rd.hex32();
  const profileSeq = rd.u32();
  const pendingOwner = rd.address();
  const ownerSince = rd.i64();
  const slashWindow = rd.u64();
  const slashedInWindow = rd.u64();
  return {
    ...v1, version: 2, slashWindow, slashedInWindow, signingKey: signingKey === DEFAULT_ADDRESS ? null : signingKey, keySeq, keyChangedAt,
    profileDigest: profileDigest === ZERO_HEX ? null : profileDigest, profileSeq, pendingOwner: pendingOwner === DEFAULT_ADDRESS ? null : pendingOwner, ownerSince,
  };
}

export interface EpochRecord {
  epoch: bigint;
  payoutRoot: string;
  lineageRoot: string;
  totalUnitsMicro: bigint;
  poolAmount: bigint;
  rebateAmount: bigint;
  totalPayable: bigint;
  claimedAmount: bigint;
  claims: number;
  postedAt: bigint;
  /** Reputation and contribution records root (identity plan 2.4); null on epochs posted before it existed (zero or absent). */
  recordRoot: string | null;
  /** 1 for an Epoch the first layout wrote (needs `migrate_epoch`), 2 otherwise. */
  version: 1 | 2;
}
export function decodeEpoch(d: Uint8Array): EpochRecord {
  const rd = new Reader(d).expect("Epoch");
  const head = {
    epoch: rd.u64(), payoutRoot: rd.hex32(), lineageRoot: rd.hex32(), totalUnitsMicro: rd.u64(), poolAmount: rd.u64(), rebateAmount: rd.u64(),
    totalPayable: rd.u64(), claimedAmount: rd.u64(), claims: rd.u32(), postedAt: rd.i64(),
  };
  rd.u8(); // bump
  if (rd.remaining() < 32) return { ...head, recordRoot: null, version: 1 };
  const root = rd.hex32();
  return { ...head, recordRoot: root === ZERO_HEX ? null : root, version: 2 };
}

export interface ClaimReceipt {
  epoch: bigint;
  leaf: string;
  agent: Address;
  destToken: Address;
  amount: bigint;
  claimedAt: bigint;
}
export function decodeClaimReceipt(d: Uint8Array): ClaimReceipt {
  const rd = new Reader(d).expect("ClaimReceipt");
  return { epoch: rd.u64(), leaf: rd.hex32(), agent: rd.address(), destToken: rd.address(), amount: rd.u64(), claimedAt: rd.i64() };
}
