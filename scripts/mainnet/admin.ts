// M2: every admin action the Lineage programs have (docs/AUDIT.md "Powers"), built for a Squads v4
// vault, and the proposal path for it: build the instructions, wrap them in a vault transaction,
// propose, approve to the threshold, execute after the time lock. Used by rehearsal.ts on the fork
// and by propose.ts. Offchain Core admin routes (/v1/admin/*: hidden list, models, trading config,
// recipes, epochs/close) are signed HTTP requests with Core's admin key and move no funds; they are
// not onchain and are not wrapped here (docs/MAINNET-RUNBOOK.md, "Admin powers after the handover").
import {
  bounty,
  challenge,
  compileVaultMessage,
  decodeSquadsMultisig,
  decodeSquadsProposal,
  launch,
  loader,
  msg,
  programDataAddress,
  registry,
  squads,
  squadsPdas,
  type BountyConfigArgs,
  type ChallengeConfigArgs,
  type ConfigArgs,
  type Ix,
  type LaunchConfigArgs,
  type MsgConfigArgs,
  type Rpc,
  type SendResult,
  type Signer,
  type SquadsConfigAction,
} from "@lineage/chain";

/** One admin action as the vault would sign it. `vault` is the multisig's vault 0. */
export const adminActions = {
  // lineage_registry, Config.admin
  registrySetConfig: (vault: string, args: ConfigArgs): Ix[] => [registry.setConfig({ admin: vault, args })],
  registryPause: (vault: string, paused: boolean): Ix[] => [registry.pause({ admin: vault, paused })],
  registrySetEpochCursor: (vault: string, c: { epochsPosted: bigint; lastEpoch: bigint; anchor: bigint; anchorTs: bigint }): Ix[] =>
    [registry.setEpochCursor({ admin: vault, ...c })],
  /** Creates ChallengeConfig and its vault on first use: the vault pays that rent. */
  challengeSetConfig: (vault: string, mint: string, tokenProgram: string, args: ChallengeConfigArgs): Ix[] =>
    [challenge.setConfig({ admin: vault, mint, args, tokenProgram })],
  // lineage_launch, LaunchConfig.admin
  launchSetConfig: (vault: string, dbcConfig: string, args: LaunchConfigArgs): Ix[] => [launch.setConfig({ admin: vault, dbcConfig, args })],
  /** Creates BountyConfig on first use: the vault pays that rent. */
  bountySetConfig: (vault: string, args: BountyConfigArgs): Ix[] => [bounty.setConfig({ admin: vault, args })],
  graduateByAdmin: (vault: string, a: { agentMint: string; dbcPool: string; dammPool: string; position: string; positionNftAccount: string }): Ix[] =>
    [launch.graduateByAdmin({ admin: vault, ...a })],
  // lineage_msg, MsgConfig.admin
  msgSetConfig: (vault: string, args: MsgConfigArgs): Ix[] => [msg.setConfig({ admin: vault, args })],
  // the upgradeable loader: the vault as upgrade authority
  upgradeProgram: (vault: string, a: { program: string; buffer: string; spill: string }): Ix[] => [loader.upgrade({ ...a, authority: vault })],
  /** Moves the upgrade authority (or, with null, makes the program immutable). */
  setUpgradeAuthority: (vault: string, a: { program: string; newAuthority: string | null }): Ix[] =>
    [loader.setAuthority({ account: programDataAddress(a.program), authority: vault, newAuthority: a.newAuthority })],
};

export interface Ms {
  multisig: string;
  vault: string;
}

export async function multisigState(rpc: Rpc, multisig: string) {
  const a = await rpc.getAccountInfo(multisig);
  if (!a) throw new Error(`no multisig at ${multisig}`);
  return decodeSquadsMultisig(a.data);
}
export async function proposalState(rpc: Rpc, multisig: string, index: bigint) {
  const a = await rpc.getAccountInfo(squadsPdas.proposal(multisig, index));
  return a ? decodeSquadsProposal(a.data) : null;
}

type Sender = (what: string, payer: Signer, ixs: Ix[], o?: { computeUnits?: number }) => Promise<SendResult>;

/** Step 1: one member creates the vault transaction and its proposal (one transaction). Returns the index. */
export async function propose(rpc: Rpc, send: Sender, ms: Ms, creator: Signer, label: string, ixs: Ix[]): Promise<{ index: bigint; message: ReturnType<typeof compileVaultMessage> }> {
  const st = await multisigState(rpc, ms.multisig);
  const index = st.transactionIndex + 1n;
  const message = compileVaultMessage(ms.vault, ixs);
  await send(`squads: create vault transaction ${index} + proposal (${label})`, creator, [
    squads.vaultTransactionCreate({ multisig: ms.multisig, index, creator: creator.id, rentPayer: creator.id, message: message.bytes, memo: label.slice(0, 60) }),
    squads.proposalCreate({ multisig: ms.multisig, index, creator: creator.id, rentPayer: creator.id }),
  ]);
  return { index, message };
}

export async function approve(send: Sender, ms: Ms, member: Signer, index: bigint, label: string) {
  return send(`squads: approve ${index} (${label})`, member, [squads.proposalApprove({ multisig: ms.multisig, index, member: member.id })]);
}

export async function execute(send: Sender, ms: Ms, member: Signer, index: bigint, message: ReturnType<typeof compileVaultMessage>, label: string, computeUnits = 400_000) {
  return send(`squads: execute ${index} (${label})`, member, [squads.vaultTransactionExecute({ multisig: ms.multisig, index, member: member.id, message })],
    { computeUnits });
}

/** A config transaction (members, threshold, time lock) through the same propose, approve, execute path. */
export async function proposeConfig(rpc: Rpc, send: Sender, ms: Ms, creator: Signer, label: string, actions: SquadsConfigAction[]) {
  const st = await multisigState(rpc, ms.multisig);
  const index = st.transactionIndex + 1n;
  await send(`squads: create config transaction ${index} + proposal (${label})`, creator, [
    squads.configTransactionCreate({ multisig: ms.multisig, index, creator: creator.id, rentPayer: creator.id, actions }),
    squads.proposalCreate({ multisig: ms.multisig, index, creator: creator.id, rentPayer: creator.id }),
  ]);
  return index;
}

