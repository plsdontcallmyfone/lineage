import { addressBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { ata, BPF_LOADER_UPGRADEABLE, pda, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, u64le } from "./pda.ts";
import { r, REGISTRY_PROGRAM_ID, registryPdas, w, type Ix } from "./registry.ts";

// lineage_launch (SPEC 14.2): addresses, instruction builders and account decoders.

export const LAUNCH_PROGRAM_ID: Address = "8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT";

export const METEORA = {
  dbcProgram: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  dammV2Program: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  dbcPoolAuthority: "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM",
  dbcEventAuthority: "8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF",
  dammPoolAuthority: "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC",
  dammEventAuthority: "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet",
  /** The DAMM v2 config DBC migrates Customizable-fee pools into (devnet and mainnet). */
  dammDynamicConfig: "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
} as const;

const P = LAUNCH_PROGRAM_ID;
export const IDENTITY_MODE = { token: 0, purchased: 1, app: 2 } as const;

const maxMin = (a: Address, b: Address): [Uint8Array, Uint8Array] => {
  const [x, y] = [addressBytes(a), addressBytes(b)];
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i]! > y[i]! ? [x, y] : [y, x];
  return [x, y];
};

export const launchPdas = {
  config: () => pda(P, "launch_config"),
  /** DBC pool creator, fee claimer, leftover receiver and position NFT holder. */
  authority: () => pda(P, "authority"),
  agentLaunch: (mint: Address) => pda(P, "agent_launch", addressBytes(mint)),
  computeVault: (agent: Address) => pda(P, "compute", addressBytes(agent)),
  usage: (epoch: bigint | number) => pda(P, "usage", u64le(epoch)),
  debitReceipt: (epoch: bigint | number, agent: Address) => pda(P, "debit", u64le(epoch), addressBytes(agent)),
  programData: () => pda(BPF_LOADER_UPGRADEABLE, addressBytes(P)),
  dbcPool: (dbcConfig: Address, mint: Address, lineMint: Address) => {
    const [hi, lo] = maxMin(mint, lineMint);
    return pda(METEORA.dbcProgram, "pool", addressBytes(dbcConfig), hi, lo);
  },
  dbcVault: (mint: Address, pool: Address) => pda(METEORA.dbcProgram, "token_vault", addressBytes(mint), addressBytes(pool)),
  dammPool: (mint: Address, lineMint: Address, config: Address = METEORA.dammDynamicConfig) => {
    const [hi, lo] = maxMin(mint, lineMint);
    return pda(METEORA.dammV2Program, "pool", addressBytes(config), hi, lo);
  },
  dammVault: (mint: Address, pool: Address) => pda(METEORA.dammV2Program, "token_vault", addressBytes(mint), addressBytes(pool)),
};

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
}
const configArgs = (wr: Writer, a: LaunchConfigArgs) =>
  wr.address(a.admin).address(a.runtimeAuthority).address(a.computeSink).u16(a.agentComputeBps).u16(a.protocolBps)
    .u64(a.sleepThreshold).u64(a.wakeThreshold).bool(a.paused).u64(a.maxDebitPerEpoch);
/** name + symbol + metadata URI + repository URL bytes launch_agent accepts (one transaction). */
export const MAX_LAUNCH_STRINGS = 227;
const data = (name: string) => new Writer().bytes(ixDisc(name));

export interface LaunchArgs {
  name: string;
  symbol: string;
  uri: string;
  /** Must already be protocol canonicalUrl() of an https URL. */
  repoUrl: string;
  identityMode: number;
  hosted: boolean;
}

export const launch = {
  initialize(a: { upgradeAuthority: Address; lineMint: Address; dbcConfig: Address; lineTokenProgram?: Address; args: LaunchConfigArgs }): Ix {
    return {
      programId: P,
      keys: [w(launchPdas.config()), w(a.upgradeAuthority, true), r(launchPdas.programData()), r(launchPdas.authority()), r(a.lineMint), r(a.dbcConfig),
        r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM)],
      data: configArgs(data("initialize_launch"), a.args).done(),
    };
  },
  setConfig(a: { admin: Address; dbcConfig: Address; args: LaunchConfigArgs }): Ix {
    return { programId: P, keys: [w(launchPdas.config()), r(a.admin, true), r(a.dbcConfig)], data: configArgs(data("set_launch_config"), a.args).done() };
  },
  /** Admin, once: grows a LaunchConfig written by the first deployed layout to the current one. */
  migrateConfig(a: { admin: Address; maxDebitPerEpoch: bigint }): Ix {
    return { programId: P, keys: [w(launchPdas.config()), w(a.admin, true), r(SYSTEM_PROGRAM)], data: data("migrate_launch_config").u64(a.maxDebitPerEpoch).done() };
  },
  /** Signers: launcher (payer), agent (the agent key) and agentMint (a fresh keypair). */
  launchAgent(a: { launcher: Address; agent: Address; agentMint: Address; lineMint: Address; dbcConfig: Address; args: LaunchArgs; lineTokenProgram?: Address }): Ix {
    const pool = launchPdas.dbcPool(a.dbcConfig, a.agentMint, a.lineMint);
    return {
      programId: P,
      keys: [
        r(launchPdas.config()), r(launchPdas.authority()), w(a.launcher, true), r(a.agent, true), w(a.agentMint, true), r(a.lineMint), r(a.dbcConfig),
        w(pool), w(launchPdas.dbcVault(a.agentMint, pool)), w(launchPdas.dbcVault(a.lineMint, pool)), w(launchPdas.agentLaunch(a.agentMint)),
        w(launchPdas.computeVault(a.agent)), r(registryPdas.config()), w(registryPdas.agent(a.agent)), r(REGISTRY_PROGRAM_ID),
        r(METEORA.dbcPoolAuthority), r(METEORA.dbcEventAuthority), r(METEORA.dbcProgram), r(a.lineTokenProgram ?? TOKEN_PROGRAM),
        r(TOKEN_2022_PROGRAM), r(SYSTEM_PROGRAM),
      ],
      data: data("launch_agent").string(a.args.name).string(a.args.symbol).string(a.args.uri).string(a.args.repoUrl).u8(a.args.identityMode)
        .bool(a.args.hosted).done(),
    };
  },
  /** Permissionless. Create the authority's agent-token ATA (Token-2022) idempotently first. */
  crankFees(a: { agent: Address; agentMint: Address; lineMint: Address; dbcConfig: Address; lineTokenProgram?: Address }): Ix {
    const pool = launchPdas.dbcPool(a.dbcConfig, a.agentMint, a.lineMint);
    return {
      programId: P,
      keys: [
        r(launchPdas.config()), r(launchPdas.authority()), w(launchPdas.agentLaunch(a.agentMint)), r(a.dbcConfig), w(pool),
        w(launchPdas.dbcVault(a.agentMint, pool)), w(launchPdas.dbcVault(a.lineMint, pool)), r(a.agentMint), r(a.lineMint),
        w(ata(launchPdas.authority(), a.agentMint, TOKEN_2022_PROGRAM)), w(launchPdas.computeVault(a.agent)), w(registryPdas.treasury()),
        r(METEORA.dbcPoolAuthority), r(METEORA.dbcEventAuthority), r(METEORA.dbcProgram), r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(TOKEN_2022_PROGRAM),
      ],
      data: data("crank_fees").done(),
    };
  },
  /**
   * Permissionless, after DBC's migration_damm_v2: `position` is DBC's migration position, whose NFT
   * our authority holds and which holds a strict majority of the pool's permanently locked liquidity.
   */
  graduate(a: { agentMint: Address; dbcPool: Address; dammPool: Address; position: Address; positionNftAccount: Address; dammConfig?: Address }): Ix {
    return {
      programId: P,
      keys: [r(launchPdas.config()), r(launchPdas.authority()), w(launchPdas.agentLaunch(a.agentMint)), r(a.dbcPool), r(a.dammPool), r(a.position),
        r(a.positionNftAccount), r(a.dammConfig ?? METEORA.dammDynamicConfig)],
      data: data("graduate").done(),
    };
  },
  /** Admin: graduate without the majority rule (a third party locked more and kept its NFT). */
  graduateByAdmin(a: { admin: Address; agentMint: Address; dbcPool: Address; dammPool: Address; position: Address; positionNftAccount: Address;
    dammConfig?: Address }): Ix {
    const g = launch.graduate(a);
    return { programId: P, keys: [...g.keys, r(a.admin, true)], data: data("graduate_by_admin").done() };
  },
  /** Permissionless: point crank_pool_fees at an authority-held, fully locked position with strictly more locked liquidity. */
  repointPosition(a: { agentMint: Address; currentPosition: Address; position: Address; positionNftAccount: Address }): Ix {
    return {
      programId: P,
      keys: [r(launchPdas.config()), r(launchPdas.authority()), w(launchPdas.agentLaunch(a.agentMint)), r(a.currentPosition), r(a.position),
        r(a.positionNftAccount)],
      data: data("repoint_position").done(),
    };
  },
  crankPoolFees(a: { agent: Address; agentMint: Address; lineMint: Address; dammPool: Address; position: Address; positionNftAccount: Address;
    lineTokenProgram?: Address }): Ix {
    return {
      programId: P,
      keys: [
        r(launchPdas.config()), r(launchPdas.authority()), w(launchPdas.agentLaunch(a.agentMint)), r(a.dammPool), w(a.position), r(a.positionNftAccount),
        w(launchPdas.dammVault(a.agentMint, a.dammPool)), w(launchPdas.dammVault(a.lineMint, a.dammPool)), w(a.agentMint), r(a.lineMint),
        w(ata(launchPdas.authority(), a.agentMint, TOKEN_2022_PROGRAM)), w(launchPdas.computeVault(a.agent)), w(registryPdas.treasury()),
        r(METEORA.dammPoolAuthority), r(METEORA.dammEventAuthority), r(METEORA.dammV2Program), r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(TOKEN_2022_PROGRAM),
      ],
      data: data("crank_pool_fees").done(),
    };
  },
  postUsage(a: { runtimeAuthority: Address; epoch: bigint | number; root: Uint8Array | string }): Ix {
    return {
      programId: P,
      keys: [w(launchPdas.config()), r(registryPdas.config()), w(a.runtimeAuthority, true), w(launchPdas.usage(a.epoch)), r(SYSTEM_PROGRAM)],
      data: data("post_usage").u64(a.epoch).fixed32(a.root).done(),
    };
  },
  debitCompute(a: { runtimeAuthority: Address; epoch: bigint | number; agent: Address; agentMint: Address; computeSink: Address; lineMint: Address;
    amount: bigint; modelTokens: bigint | number; sandboxS: bigint | number; proof: Uint8Array[]; lineTokenProgram?: Address }): Ix {
    return {
      programId: P,
      keys: [
        r(launchPdas.config()), w(a.runtimeAuthority, true), r(launchPdas.authority()), w(launchPdas.usage(a.epoch)), w(launchPdas.agentLaunch(a.agentMint)),
        w(launchPdas.debitReceipt(a.epoch, a.agent)), w(launchPdas.computeVault(a.agent)), w(a.computeSink), r(a.lineMint),
        r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(SYSTEM_PROGRAM),
      ],
      data: data("debit_compute").u64(a.amount).u64(a.modelTokens).u64(a.sandboxS).vec32(a.proof).done(),
    };
  },
  withdrawCompute(a: { launcher: Address; agent: Address; agentMint: Address; launcherToken: Address; lineMint: Address; amount: bigint;
    lineTokenProgram?: Address }): Ix {
    return {
      programId: P,
      keys: [r(launchPdas.config()), r(a.launcher, true), r(launchPdas.authority()), w(launchPdas.agentLaunch(a.agentMint)), w(launchPdas.computeVault(a.agent)),
        w(a.launcherToken), r(a.lineMint), r(a.lineTokenProgram ?? TOKEN_PROGRAM)],
      data: data("withdraw_compute").u64(a.amount).done(),
    };
  },
  refreshAwake(a: { agent: Address; agentMint: Address }): Ix {
    return {
      programId: P,
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
  dbcConfig: Address;
  agentComputeBps: number;
  protocolBps: number;
  sleepThreshold: bigint;
  wakeThreshold: bigint;
  migrationQuoteThreshold: bigint;
  sqrtStartPrice: bigint;
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
    computeSink: rd.address(), dbcConfig: rd.address(), agentComputeBps: rd.u16(), protocolBps: rd.u16(), sleepThreshold: rd.u64(),
    wakeThreshold: rd.u64(), migrationQuoteThreshold: rd.u64(), sqrtStartPrice: rd.u128(), paused: rd.bool(),
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
  dbcConfig: Address;
  dbcPool: Address;
  dammPool: Address;
  position: Address;
  positionNftAccount: Address;
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
    dbcConfig: rd.address(), dbcPool: rd.address(), dammPool: rd.address(), position: rd.address(), positionNftAccount: rd.address(),
    graduated: rd.bool(), awake: rd.bool(), createdAt: rd.i64(), feesClaimed: rd.u64(), toCompute: rd.u64(), toProtocol: rd.u64(), debited: rd.u64(),
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
