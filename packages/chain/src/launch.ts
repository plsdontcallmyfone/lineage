import { addressBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { ata, BPF_LOADER_UPGRADEABLE, pda, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, u64le } from "./pda.ts";
import { r, REGISTRY_PROGRAM_ID, registryPdas, w, type Ix } from "./registry.ts";
import { token } from "./spl.ts";
import { LAUNCH_PROGRAM_ID } from "./programs.ts";
import { PUMP, pumpPdas } from "./pump.ts";

// units_launch (SPEC 14.2): addresses, instruction builders and account decoders. Agent tokens
// launch on pump.fun only (owner decisions 2026-10-10, docs/plans/PUMPFUN-LAUNCHES.md); the
// Meteora builders were removed with the program's Meteora paths.

/** The active network's id (devnet until a profile is applied; programs.ts). */
export { LAUNCH_PROGRAM_ID };

export const IDENTITY_MODE = { token: 0, purchased: 1, app: 2 } as const;

export const launchPdas = {
  config: () => pda(LAUNCH_PROGRAM_ID, "launch_config"),
  /** Signer of the registry's register_launched; authority of every compute vault. */
  authority: () => pda(LAUNCH_PROGRAM_ID, "authority"),
  /** ["pump_creator", agent]: the agent coin's pump.fun creator; its $LINE ATA receives the swept creator fees. */
  pumpCreator: (agent: Address) => pda(LAUNCH_PROGRAM_ID, "pump_creator", addressBytes(agent)),
  agentLaunch: (mint: Address) => pda(LAUNCH_PROGRAM_ID, "agent_launch", addressBytes(mint)),
  computeVault: (agent: Address) => pda(LAUNCH_PROGRAM_ID, "compute", addressBytes(agent)),
  usage: (epoch: bigint | number) => pda(LAUNCH_PROGRAM_ID, "usage", u64le(epoch)),
  debitReceipt: (epoch: bigint | number, agent: Address) => pda(LAUNCH_PROGRAM_ID, "debit", u64le(epoch), addressBytes(agent)),
  programData: () => pda(BPF_LOADER_UPGRADEABLE, addressBytes(LAUNCH_PROGRAM_ID)),
};

/**
 * The accounts every pump.fun launch transaction names that are neither signers nor fresh: the
 * content of a launch lookup table (pump.fun's fixed accounts and $LINE's quote accounts, plus ours).
 */
export function launchTableAddresses(a: { lineMint: Address; lineTokenProgram?: Address; linePool?: { pool: Address; baseVault: Address; quoteVault: Address } }): Address[] {
  return [...new Set([launchPdas.config(), launchPdas.authority(), a.lineMint, registryPdas.config(), REGISTRY_PROGRAM_ID, LAUNCH_PROGRAM_ID, SYSVAR_INSTRUCTIONS,
    PUMP.program, PUMP.global, pumpPdas.mintAuthority(), PUMP.eventAuthority, PUMP.mayhem, pumpPdas.mayhemGlobalParams(), pumpPdas.mayhemSolVault(),
    PUMP.quoteControl, PUMP.feeConfig, pumpPdas.bondingCurve(a.lineMint), ata(PUMP.buybackRecipients[0], a.lineMint, a.lineTokenProgram ?? TOKEN_2022_PROGRAM),
    a.lineTokenProgram ?? TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", SYSTEM_PROGRAM,
    ...(a.linePool ? [a.linePool.pool, a.linePool.baseVault, a.linePool.quoteVault] : [])])];
}
export const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";

export interface LaunchConfigArgs {
  admin: Address;
  runtimeAuthority: Address;
  computeSink: Address;
  agentComputeBps: number;
  protocolBps: number;
  sleepThreshold: bigint;
  wakeThreshold: bigint;
  paused: boolean;
  /** Most the runtime may debit across all compute vaults for one usage epoch; 0 = no cap. */
  maxDebitPerEpoch: bigint;
  /** creator_fee_bps every pump.fun launch must be created with (0 = pump.fun's standard schedule; owner decision 2026-10-10). */
  pumpCreatorFeeBps: bigint;
}
const configArgs = (wr: Writer, a: LaunchConfigArgs) =>
  wr.address(a.admin).address(a.runtimeAuthority).address(a.computeSink).u16(a.agentComputeBps).u16(a.protocolBps)
    .u64(a.sleepThreshold).u64(a.wakeThreshold).bool(a.paused).u64(a.maxDebitPerEpoch).u64(a.pumpCreatorFeeBps);
/** Longest repository URL register_pump_launch accepts. */
export const MAX_URL = 200;
const data = (name: string) => new Writer().bytes(ixDisc(name));

export interface PumpLaunchArgs {
  /** Must already be protocol canonicalUrl() of an https URL. */
  repoUrl: string;
  identityMode: number;
  hosted: boolean;
}

export const launch = {
  initialize(a: { upgradeAuthority: Address; lineMint: Address; lineTokenProgram?: Address; args: LaunchConfigArgs }): Ix {
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [w(launchPdas.config()), w(a.upgradeAuthority, true), r(launchPdas.programData()), r(launchPdas.authority()), r(a.lineMint),
        r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM)],
      data: configArgs(data("initialize_launch"), a.args).done(),
    };
  },
  setConfig(a: { admin: Address; args: LaunchConfigArgs }): Ix {
    return { programId: LAUNCH_PROGRAM_ID, keys: [w(launchPdas.config()), r(a.admin, true)], data: configArgs(data("set_launch_config"), a.args).done() };
  },
  /** Admin, once: grows a LaunchConfig written by the first deployed layout to the current one. */
  migrateConfig(a: { admin: Address; maxDebitPerEpoch: bigint }): Ix {
    return { programId: LAUNCH_PROGRAM_ID, keys: [w(launchPdas.config()), w(a.admin, true), r(SYSTEM_PROGRAM)], data: data("migrate_launch_config").u64(a.maxDebitPerEpoch).done() };
  },
  /**
   * After pump.fun's `create_v2` for `agentMint` (with creator = launchPdas.pumpCreator(agent)) in
   * the same transaction. Signers: launcher (payer) and agent.
   */
  registerPumpLaunch(a: { launcher: Address; agent: Address; agentMint: Address; lineMint: Address; args: PumpLaunchArgs; lineTokenProgram?: Address }): Ix {
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [
        r(launchPdas.config()), r(launchPdas.authority()), w(a.launcher, true), r(a.agent, true), r(a.agentMint), r(a.lineMint),
        r(pumpPdas.bondingCurve(a.agentMint)), r(PUMP.global), r(launchPdas.pumpCreator(a.agent)), w(launchPdas.agentLaunch(a.agentMint)),
        w(launchPdas.computeVault(a.agent)), r(registryPdas.config()), w(registryPdas.agent(a.agent)), r(REGISTRY_PROGRAM_ID), r(SYSVAR_INSTRUCTIONS),
        r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM),
      ],
      data: data("register_pump_launch").string(a.args.repoUrl).u8(a.args.identityMode).bool(a.args.hosted).done(),
    };
  },
  /**
   * Permissionless: splits the creator PDA's $LINE ATA. Put pump.fun's sweeps and collects before it
   * (pump.ts creatorFeeHarvest) and create that ATA idempotently first.
   */
  crankPumpFees(a: { agent: Address; agentMint: Address; lineMint: Address; lineTokenProgram?: Address }): Ix {
    const tp = a.lineTokenProgram ?? TOKEN_PROGRAM, pc = launchPdas.pumpCreator(a.agent);
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), w(launchPdas.agentLaunch(a.agentMint)), r(pc), w(ata(pc, a.lineMint, tp)), w(launchPdas.computeVault(a.agent)),
        w(registryPdas.treasury()), r(a.lineMint), r(tp)],
      data: data("crank_pump_fees").done(),
    };
  },
  /** Permissionless, once, after pump.fun's migrate_v2: records the canonical PumpSwap pool. */
  recordPumpGraduation(a: { agentMint: Address; lineMint: Address }): Ix {
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), w(launchPdas.agentLaunch(a.agentMint)), r(pumpPdas.bondingCurve(a.agentMint)), r(pumpPdas.pool(a.agentMint, a.lineMint))],
      data: data("record_pump_graduation").done(),
    };
  },
  postUsage(a: { runtimeAuthority: Address; epoch: bigint | number; root: Uint8Array | string }): Ix {
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [w(launchPdas.config()), r(registryPdas.config()), w(a.runtimeAuthority, true), w(launchPdas.usage(a.epoch)), r(SYSTEM_PROGRAM)],
      data: data("post_usage").u64(a.epoch).fixed32(a.root).done(),
    };
  },
  debitCompute(a: { runtimeAuthority: Address; epoch: bigint | number; agent: Address; agentMint: Address; computeSink: Address; lineMint: Address;
    amount: bigint; modelTokens: bigint | number; sandboxS: bigint | number; proof: Uint8Array[]; lineTokenProgram?: Address }): Ix {
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [
        r(launchPdas.config()), w(a.runtimeAuthority, true), r(launchPdas.authority()), w(launchPdas.usage(a.epoch)), w(launchPdas.agentLaunch(a.agentMint)),
        w(launchPdas.debitReceipt(a.epoch, a.agent)), w(launchPdas.computeVault(a.agent)), w(a.computeSink), r(a.lineMint),
        r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM),
      ],
      data: data("debit_compute").u64(a.amount).u64(a.modelTokens).u64(a.sandboxS).vec32(a.proof).done(),
    };
  },
  /** `launcher`: the agent's current registry owner (the launcher until an owner transfer; audit A1-03), who signs and owns `launcherToken`. */
  withdrawCompute(a: { launcher: Address; agent: Address; agentMint: Address; launcherToken: Address; lineMint: Address; amount: bigint;
    lineTokenProgram?: Address }): Ix {
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), r(a.launcher, true), r(launchPdas.authority()), w(launchPdas.agentLaunch(a.agentMint)), w(launchPdas.computeVault(a.agent)),
        w(a.launcherToken), r(a.lineMint), r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(registryPdas.agent(a.agent))],
      data: data("withdraw_compute").u64(a.amount).done(),
    };
  },
  /**
   * Prepaid credits at launch (plan C): the launcher's tLINE into the new agent's compute vault, then
   * the permissionless refresh_awake, placed after register_pump_launch in the same transaction so the agent
   * wakes at once when `amount` reaches wake_threshold.
   */
  prepay(a: { launcher: Address; agent: Address; agentMint: Address; lineMint: Address; amount: bigint; decimals: number; lineTokenProgram?: Address }): Ix[] {
    const tp = a.lineTokenProgram ?? TOKEN_PROGRAM;
    return [
      token.transferChecked(ata(a.launcher, a.lineMint, tp), a.lineMint, launchPdas.computeVault(a.agent), a.launcher, a.amount, a.decimals, tp),
      launch.refreshAwake({ agent: a.agent, agentMint: a.agentMint }),
    ];
  },
  refreshAwake(a: { agent: Address; agentMint: Address }): Ix {
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), w(launchPdas.agentLaunch(a.agentMint)), r(launchPdas.computeVault(a.agent))],
      data: data("refresh_awake").done(),
    };
  },
};

// ---------- accounts ----------

export interface LaunchConfig {
  admin: Address;
  runtimeAuthority: Address;
  registryProgram: Address;
  lineMint: Address;
  lineTokenProgram: Address;
  computeSink: Address;
  /** Pump's program id on this build (a Meteora-era config held its DBC config here). */
  venue: Address;
  agentComputeBps: number;
  protocolBps: number;
  sleepThreshold: bigint;
  wakeThreshold: bigint;
  /** creator_fee_bps every pump.fun launch must carry. */
  pumpCreatorFeeBps: bigint;
  paused: boolean;
  /** Null on a LaunchConfig the first layout wrote (before `migrate_launch_config`). */
  maxDebitPerEpoch: bigint | null;
  usageEpochsPosted: bigint | null;
  lastUsageEpoch: bigint | null;
  usageAnchor: bigint | null;
  usageAnchorTs: bigint | null;
}
export function decodeLaunchConfig(d: Uint8Array): LaunchConfig {
  const rd = new Reader(d).expect("LaunchConfig");
  const head = {
    admin: rd.address(), runtimeAuthority: rd.address(), registryProgram: rd.address(), lineMint: rd.address(), lineTokenProgram: rd.address(),
    computeSink: rd.address(), venue: rd.address(), agentComputeBps: rd.u16(), protocolBps: rd.u16(), sleepThreshold: rd.u64(),
    wakeThreshold: rd.u64(), pumpCreatorFeeBps: rd.u64(), paused: (rd.u128(), rd.bool()),
  };
  rd.u8(); // bump
  rd.u8(); // authority_bump
  const v2 = rd.remaining() >= 40;
  return {
    ...head, maxDebitPerEpoch: v2 ? rd.u64() : null, usageEpochsPosted: v2 ? rd.u64() : null, lastUsageEpoch: v2 ? rd.u64() : null,
    usageAnchor: v2 ? rd.u64() : null, usageAnchorTs: v2 ? rd.i64() : null,
  };
}

export interface AgentLaunch {
  agent: Address;
  mint: Address;
  launcher: Address;
  repoId: string;
  repoUrl: string;
  identityMode: number;
  hosted: boolean;
  /** "pump" for a pump.fun launch; "meteora" for a record the Meteora venue wrote (devnet history, read-only in clients). */
  venue: "pump" | "meteora";
  /** The pump.fun bonding curve (a Meteora-era record: its DBC pool). */
  bondingCurve: Address;
  /** The canonical PumpSwap pool once graduation is recorded (a Meteora-era record: its DAMM v2 pool). */
  pumpPool: Address;
  /** PDA ["pump_creator", agent] (Meteora-era: its position). */
  pumpCreator: Address;
  graduated: boolean;
  awake: boolean;
  createdAt: bigint;
  feesClaimed: bigint;
  toCompute: bigint;
  toProtocol: bigint;
  debited: bigint;
  withdrawn: bigint;
}
export function decodeAgentLaunch(d: Uint8Array): AgentLaunch {
  const rd = new Reader(d).expect("AgentLaunch");
  return {
    agent: rd.address(), mint: rd.address(), launcher: rd.address(), repoId: rd.hex32(), repoUrl: rd.string(), identityMode: rd.u8(), hosted: rd.bool(),
    venue: rd.address() === PUMP.program ? "pump" : "meteora", bondingCurve: rd.address(), pumpPool: rd.address(), pumpCreator: rd.address(),
    graduated: (rd.address(), rd.bool()), awake: rd.bool(), createdAt: rd.i64(), feesClaimed: rd.u64(), toCompute: rd.u64(), toProtocol: rd.u64(), debited: rd.u64(),
    withdrawn: rd.u64(),
  };
}

export interface UsageEpoch {
  epoch: bigint;
  root: string;
  postedAt: bigint;
  debited: bigint;
}
export function decodeUsageEpoch(d: Uint8Array): UsageEpoch {
  const rd = new Reader(d).expect("UsageEpoch");
  return { epoch: rd.u64(), root: rd.hex32(), postedAt: rd.i64(), debited: rd.u64() };
}

export interface DebitReceipt {
  epoch: bigint;
  agent: Address;
  amount: bigint;
  modelTokens: bigint;
  sandboxS: bigint;
}
export function decodeDebitReceipt(d: Uint8Array): DebitReceipt {
  const rd = new Reader(d).expect("DebitReceipt");
  return { epoch: rd.u64(), agent: rd.address(), amount: rd.u64(), modelTokens: rd.u64(), sandboxS: rd.u64() };
}
