import { accountDisc, type Address } from "./codec.ts";
import { decodeAgentLaunch, decodeLaunchConfig, LAUNCH_PROGRAM_ID, launchPdas, type AgentLaunch, type LaunchConfig } from "./launch.ts";
import { decodeAgent, decodeClaimReceipt, decodeConfig, decodeEpoch, decodeSlashReceipt, REGISTRY_PROGRAM_ID, registryPdas, type AgentRecord,
  type ClaimReceipt, type EpochRecord, type RegistryConfig, type SlashReceipt } from "./registry.ts";
import type { AccountInfo, Rpc } from "./rpc.ts";
import { decodeMint, decodeTokenAccount, type MintInfo } from "./spl.ts";

// RPC readers over the decoders: one call per question, every figure read from chain.

function owned(a: AccountInfo | null, program: Address): AccountInfo | null {
  if (!a) return null;
  if (a.owner !== program) throw new Error(`${a.address} is owned by ${a.owner}, not ${program}`);
  return a;
}

export class ChainReader {
  constructor(
    readonly rpc: Rpc,
    readonly registryProgram: Address = REGISTRY_PROGRAM_ID,
    readonly launchProgram: Address = LAUNCH_PROGRAM_ID,
  ) {
    if (registryProgram !== REGISTRY_PROGRAM_ID || launchProgram !== LAUNCH_PROGRAM_ID)
      throw new Error("packages/chain derives PDAs for the deployed program ids only");
  }

  async registryConfig(): Promise<RegistryConfig | null> {
    const a = owned(await this.rpc.getAccountInfo(registryPdas.config()), this.registryProgram);
    return a ? decodeConfig(a.data) : null;
  }
  async launchConfig(): Promise<LaunchConfig | null> {
    const a = owned(await this.rpc.getAccountInfo(launchPdas.config()), this.launchProgram);
    return a ? decodeLaunchConfig(a.data) : null;
  }
  async agent(agent: Address): Promise<AgentRecord | null> {
    const a = owned(await this.rpc.getAccountInfo(registryPdas.agent(agent)), this.registryProgram);
    return a ? decodeAgent(a.data) : null;
  }
  /** Every `Agent` record of the registry (getProgramAccounts on the account discriminator). */
  async agents(): Promise<AgentRecord[]> {
    const all = await this.rpc.getProgramAccounts(this.registryProgram, { memcmp: [{ offset: 0, bytes: accountDisc("Agent") }] });
    return all.map((a) => decodeAgent(a.data));
  }
  /** Every `AgentLaunch` of the launch program. */
  async launches(): Promise<AgentLaunch[]> {
    const all = await this.rpc.getProgramAccounts(this.launchProgram, { memcmp: [{ offset: 0, bytes: accountDisc("AgentLaunch") }] });
    return all.map((a) => decodeAgentLaunch(a.data));
  }
  async agentLaunch(mint: Address): Promise<AgentLaunch | null> {
    const a = owned(await this.rpc.getAccountInfo(launchPdas.agentLaunch(mint)), this.launchProgram);
    return a ? decodeAgentLaunch(a.data) : null;
  }
  async epoch(n: bigint | number): Promise<EpochRecord | null> {
    const a = owned(await this.rpc.getAccountInfo(registryPdas.epoch(n)), this.registryProgram);
    return a ? decodeEpoch(a.data) : null;
  }
  /** The receipt of a slash Core sent (null if that slash id never landed). */
  async slashReceipt(slashId: Uint8Array | string): Promise<SlashReceipt | null> {
    const a = owned(await this.rpc.getAccountInfo(registryPdas.slashReceipt(slashId)), this.registryProgram);
    return a ? decodeSlashReceipt(a.data) : null;
  }
  async claimReceipts(epoch: bigint | number, leaves: Uint8Array[]): Promise<(ClaimReceipt | null)[]> {
    const accts = await this.rpc.getMultipleAccounts(leaves.map((l) => registryPdas.claimReceipt(epoch, l)));
    return accts.map((a) => (owned(a, this.registryProgram) ? decodeClaimReceipt(a!.data) : null));
  }
  /** Token balances of the given accounts; a missing account reads as null. */
  async tokenBalances(accounts: Address[]): Promise<(bigint | null)[]> {
    const accts = await this.rpc.getMultipleAccounts(accounts);
    return accts.map((a) => (a ? decodeTokenAccount(a.data).amount : null));
  }
  async tokenBalance(account: Address): Promise<bigint | null> {
    return (await this.tokenBalances([account]))[0]!;
  }
  async mint(mint: Address): Promise<(MintInfo & { tokenProgram: Address }) | null> {
    const a = await this.rpc.getAccountInfo(mint);
    return a ? { ...decodeMint(a.data), tokenProgram: a.owner } : null;
  }

  /** The registry vaults and, when given, compute vaults: one getMultipleAccounts. */
  async vaults(computeAgents: Address[] = []): Promise<{ slot: number; treasury: bigint | null; reserve: bigint | null; pool: bigint | null;
    payable: bigint | null; bondVault: bigint | null; compute: Record<Address, bigint | null> }> {
    const fixed = [registryPdas.treasury(), registryPdas.reserve(), registryPdas.pool(), registryPdas.payable(), registryPdas.bondVault()];
    const compute = computeAgents.map((a) => launchPdas.computeVault(a));
    const slot = await this.rpc.getSlot();
    const b = await this.tokenBalances([...fixed, ...compute]);
    return {
      slot,
      treasury: b[0]!, reserve: b[1]!, pool: b[2]!, payable: b[3]!, bondVault: b[4]!,
      compute: Object.fromEntries(computeAgents.map((a, i) => [a, b[5 + i]!])),
    };
  }
}
