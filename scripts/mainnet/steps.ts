// The mainnet setup steps the runbook runs (docs/MAINNET-RUNBOOK.md), shared by the fork rehearsal
// (rehearsal.ts) and the operator CLI (initialize.ts), so the commands the owner runs are the code the
// fork proved. Every step is idempotent: it reads chain state first and skips what exists.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ata,
  ChainReader,
  decodeLoaderAuthority,
  decodeLookupTable,
  decodeSquadsMultisig,
  decodeSquadsProgramConfig,
  launch,
  decodeBondingCurve,
  launchPdas,
  launchTableAddresses,
  pumpPdas,
  lookupTable,
  PUMP,
  msg,
  msgPdas,
  paramsFromNetworkJson,
  readMsgConfig,
  programDataAddress,
  registry,
  SQUADS_PERM,
  squads,
  squadsPdas,
  token,
  type BountyConfigArgs,
  type ChallengeConfigArgs,
  type Ix,
  type MsgConfigArgs,
  type Params,
  type Rpc,
  type SendResult,
  type Signer,
  activePrograms,
  useProfilePrograms,
  type ProgramIds,
} from "@lineage/chain";
import { loadNetworkProfile } from "../../packages/chain/src/profile-node.ts";
import type { NetworkProfile } from "../../packages/chain/src/profile.ts";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * The active network profile (config/profile.json `network`, LINEAGE_NETWORK overrides), with its
 * program ids applied to every builder, PDA and reader (packages/chain programs.ts). The mainnet
 * scripts run under LINEAGE_NETWORK=mainnet (docs/MAINNET-RUNBOOK.md); nothing here names an id.
 */
export function useActiveProfile(env: Record<string, string | undefined> = process.env): NetworkProfile {
  const p = loadNetworkProfile({ env });
  useProfilePrograms(p);
  return p;
}

/** The three program ids the builders use now (the active profile's). */
export const programIdsNow = (): ProgramIds => {
  const { registry, launch, msg } = activePrograms();
  return { registry, launch, msg };
};

/**
 * Refuses an endpoint the active profile does not fit: mainnet's genesis needs the mainnet profile,
 * and the profile's genesis must be the endpoint's unless it is a local fork. With `deployed`, each
 * program must already be an executable account at the profile's id (a devnet profile against a
 * mainnet fork stops here instead of building for absent programs).
 */
export async function checkEndpoint(rpc: Rpc, p: NetworkProfile, o: { deployed: boolean; local?: boolean }): Promise<string> {
  const genesis = await rpc.call<string>("getGenesisHash");
  if (genesis === MAINNET_GENESIS && p.network !== "mainnet") throw new Error(`mainnet endpoint under the ${p.network} profile: run with LINEAGE_NETWORK=mainnet`);
  if (genesis !== p.genesis && !o.local) throw new Error(`the endpoint's genesis ${genesis} is not the ${p.network} profile's ${p.genesis}`);
  if (o.deployed)
    for (const [name, id] of Object.entries(programIdsNow())) {
      const a = await rpc.getAccountInfo(id);
      if (!a || !a.executable) throw new Error(`${name}: no program at ${id}, the ${p.network} profile's id (LINEAGE_NETWORK=${process.env.LINEAGE_NETWORK ?? ""})`);
    }
  return genesis;
}

/** The owner's launch values (scripts/mainnet/launch-params.example.json); no field may be "TBA". */
export interface LaunchParams {
  multisig: { members: string[]; threshold: number; time_lock_s: number };
  core_authority: string;
  runtime_authority: string;
  line_mint: string;
  line_decimals: number;
  line_token_program: string;
  /** config/network.json-shaped file with the launch values (relative to the repo root). */
  network_file: string;
  max_rebate_per_epoch: bigint;
  max_debit_per_epoch: bigint;
  /** creator_fee_bps every pump.fun launch carries (owner decision 2026-10-10: 0, pump.fun's default); admin-editable later. */
  pump_creator_fee_bps: bigint;
  /** $LINE's canonical PumpSwap pool and vaults once $LINE has migrated (the launch table then names them). */
  line_pool?: { pool: string; baseVault: string; quoteVault: string };
  msg: Omit<MsgConfigArgs, "admin">;
  bounty: BountyConfigArgs;
  challenge: ChallengeConfigArgs;
}

const ROOT = join(import.meta.dir, "..", "..");

export type Loaded = LaunchParams & { params: Params; net: Record<string, any> };

/** Reads the owner's launch parameter file; refuses any value still "TBA". */
export function loadLaunchParams(path: string): Loaded {
  const text = readFileSync(path, "utf8");
  const tba = [...text.matchAll(/"([a-z_A-Z0-9]+)":\s*"TBA"/g)].map((m) => m[1]);
  if (tba.length || text.includes('"TBA"')) throw new Error(`launch parameters still TBA: ${tba.join(", ") || "(list entries)"}`);
  return parseLaunchParams(JSON.parse(text));
}

/** "123n" strings become bigints; the network file is read and converted to onchain units. */
export function parseLaunchParams(raw: unknown): Loaded {
  const big = (v: unknown): unknown =>
    typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : Array.isArray(v) ? v.map(big) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, big(x)])) : v;
  const p = big(raw) as LaunchParams;
  if (p.pump_creator_fee_bps === undefined) throw new Error("pump_creator_fee_bps is required (0n: pump.fun's default)");
  const net = JSON.parse(readFileSync(isAbsolute(p.network_file) ? p.network_file : join(ROOT, p.network_file), "utf8"));
  const params = paramsFromNetworkJson(net, p.line_decimals);
  if (params.unbondCooldownS < 2n * BigInt(params.epochLengthS)) throw new Error("unbond_cooldown_s must be at least 2 x epoch_length_s (the registry refuses less)");
  return { ...p, params, net };
}

type Send = (what: string, payer: Signer, ixs: Ix[], o?: { signers?: Signer[]; computeUnits?: number }) => Promise<SendResult>;
type Check = (name: string, ok: boolean, detail?: string) => void;

export function multisigOf(createKey: string) {
  const multisig = squadsPdas.multisig(createKey);
  return { multisig, vault: squadsPdas.vault(multisig, 0) };
}

/** Squads v4 multisig_create_v2: autonomous (no config authority), rent collector = its vault. */
export async function createMultisig(rpc: Rpc, send: Send, check: Check, payer: Signer, createKey: Signer, p: LaunchParams) {
  const { multisig, vault } = multisigOf(createKey.id);
  if (!(await rpc.getAccountInfo(multisig))) {
    const pc = decodeSquadsProgramConfig((await rpc.getAccountInfo(squadsPdas.programConfig()))!.data);
    await send(`Squads multisig_create_v2: ${p.multisig.threshold} of ${p.multisig.members.length}, time lock ${p.multisig.time_lock_s} s, autonomous, rent collector = vault (creation fee ${pc.multisigCreationFee} lamports)`, payer, [
      squads.multisigCreateV2({ createKey: createKey.id, creator: payer.id, treasury: pc.treasury, members: p.multisig.members.map((key) => ({ key, permissions: SQUADS_PERM.all })),
        threshold: p.multisig.threshold, timeLockS: p.multisig.time_lock_s, configAuthority: null, rentCollector: vault, memo: "lineage" }),
    ], { signers: [createKey] });
  }
  const st = decodeSquadsMultisig((await rpc.getAccountInfo(multisig))!.data);
  check("multisig: members, threshold, time lock, no config authority", st.threshold === p.multisig.threshold && st.timeLock === p.multisig.time_lock_s &&
    st.members.map((m) => m.key).sort().join() === [...p.multisig.members].sort().join() && st.configAuthority === "11111111111111111111111111111111",
    `multisig ${multisig}, vault ${vault}`);
  return { multisig, vault };
}

export const registryArgs = (p: Loaded, vault: string) =>
  ({ admin: vault, coreAuthority: p.core_authority, launchProgram: programIdsNow().launch, params: p.params, maxRebatePerEpoch: p.max_rebate_per_epoch });
export const computeSink = (p: LaunchParams, vault: string) => ata(vault, p.line_mint, p.line_token_program);
export const launchArgs = (p: Loaded, vault: string) => {
  const one = 10n ** BigInt(p.line_decimals), from = 10n ** BigInt(p.net.token_decimals);
  return {
    admin: vault, runtimeAuthority: p.runtime_authority, computeSink: computeSink(p, vault), agentComputeBps: Number(p.net.agent_compute_bps),
    protocolBps: Number(p.net.protocol_bps), sleepThreshold: (BigInt(p.net.sleep_threshold) * one) / from, wakeThreshold: (BigInt(p.net.wake_threshold) * one) / from,
    paused: false, maxDebitPerEpoch: p.max_debit_per_epoch, pumpCreatorFeeBps: p.pump_creator_fee_bps,
  };
};

/**
 * Initializes the three programs with every admin role = the vault (the deployer only signs as the
 * current upgrade authority and pays), the compute sink and the launch lookup table. $LINE must be a
 * pump.fun coin, SOL- or USDC-paired and never mayhem mode (docs/MAINNET-RUNBOOK.md, hard requirement):
 * checked here from its bonding curve.
 */
export async function initializeAll(rpc: Rpc, send: Send, check: Check, deployer: Signer, p: Loaded, vault: string, existingTable?: string) {
  const reader = new ChainReader(rpc);
  const T = p.line_token_program;
  for (const [name, id] of Object.entries(programIdsNow())) {
    const a = decodeLoaderAuthority((await rpc.getAccountInfo(programDataAddress(id)))!.data);
    check(`${name}: upgrade authority is the deployer (initialize needs it) or the registry is already initialized`, a === deployer.id || (await reader.registryConfig()) !== null, `${a}`);
  }
  if (!(await reader.registryConfig()))
    await send("units_registry::initialize (admin = vault)", deployer, [registry.initialize({ upgradeAuthority: deployer.id, mint: p.line_mint, tokenProgram: T, args: registryArgs(p, vault) })]);
  const c = (await reader.registryConfig())!;
  check("registry: admin = vault, Core authority, mint", c.admin === vault && c.coreAuthority === p.core_authority && c.mint === p.line_mint && c.maxRebatePerEpoch === p.max_rebate_per_epoch);
  const lineCurve = await rpc.getAccountInfo(pumpPdas.bondingCurve(p.line_mint));
  const lc0 = lineCurve && lineCurve.owner === PUMP.program ? decodeBondingCurve(lineCurve.data) : null;
  check("$LINE is a pump.fun coin paired with SOL or USDC (depth 0), not mayhem mode", !!lc0 && lc0.depth === 0 && !lc0.isMayhemMode &&
    (lc0.quoteMint === "11111111111111111111111111111111" || lc0.quoteMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), lc0 ? `quote ${lc0.quoteMint}` : "no pump.fun curve");
  if (!(await rpc.getAccountInfo(computeSink(p, vault))))
    await send("compute sink: the vault's $LINE token account", deployer, [token.createAtaIdempotent(deployer.id, vault, p.line_mint, T)]);
  if (!(await reader.launchConfig()))
    await send("units_launch::initialize_launch (admin = vault, sink = vault's account)", deployer, [
      launch.initialize({ upgradeAuthority: deployer.id, lineMint: p.line_mint, lineTokenProgram: T, args: launchArgs(p, vault) })]);
  const lc = (await reader.launchConfig())!;
  check("launch: admin = vault, sink = vault's account, runtime authority, debit cap", lc.admin === vault && lc.computeSink === computeSink(p, vault) &&
    lc.runtimeAuthority === p.runtime_authority && lc.maxDebitPerEpoch === p.max_debit_per_epoch && lc.venue === PUMP.program && lc.pumpCreatorFeeBps === p.pump_creator_fee_bps);
  if (!(await rpc.getAccountInfo(msgPdas.config())))
    await send("units_msg::initialize (admin = vault)", deployer, [msg.initialize({ upgradeAuthority: deployer.id, args: { admin: vault, ...p.msg } })]);
  const mc = await readMsgConfig(rpc);
  check("messages: admin = vault", mc?.admin === vault, `${mc?.admin}`);
  const want = launchTableAddresses({ lineMint: p.line_mint, lineTokenProgram: T, linePool: p.line_pool });
  const prior = existingTable ? await rpc.getAccountInfo(existingTable) : null;
  let address = existingTable ?? "";
  if (!prior) {
    const slot = await rpc.getSlot();
    const c = lookupTable.create({ authority: deployer.id, payer: deployer.id, recentSlot: slot - 1 });
    address = c.address;
    await send(`launch lookup table ${address}: create + extend (${want.length} addresses)`, deployer, [c.ix, lookupTable.extend({ table: address, authority: deployer.id, payer: deployer.id, addresses: want })]);
    await send("launch lookup table: freeze", deployer, [lookupTable.freeze({ table: address, authority: deployer.id })]);
  }
  const t = decodeLookupTable((await rpc.getAccountInfo(address))!.data);
  check("launch lookup table frozen with the expected addresses", t.authority === null && t.addresses.join() === want.join(), address);
  return { lookupTable: address };
}

/** Reads back the handover: every admin field and every upgrade authority is the vault. */
export async function checkHandover(rpc: Rpc, check: Check, vault: string, p: LaunchParams) {
  const reader = new ChainReader(rpc);
  const c = await reader.registryConfig(), lc = await reader.launchConfig();
  check("registry admin = vault", c?.admin === vault, `${c?.admin}`);
  check("launch admin = vault", lc?.admin === vault, `${lc?.admin}`);
  check("compute sink = the vault's account", lc?.computeSink === computeSink(p, vault), `${lc?.computeSink}`);
  const mc = await readMsgConfig(rpc);
  check("messages admin = vault", mc?.admin === vault, `${mc?.admin}`);
  for (const [name, id] of Object.entries(programIdsNow())) {
    const a = decodeLoaderAuthority((await rpc.getAccountInfo(programDataAddress(id)))!.data);
    check(`${name} upgrade authority = vault`, a === vault, `${a}`);
  }
}
