// The mainnet setup steps the runbook runs (docs/MAINNET-RUNBOOK.md), shared by the fork rehearsal
// (rehearsal.ts) and the operator CLI (initialize.ts), so the commands the owner runs are the code the
// fork proved. Every step is idempotent: it reads chain state first and skips what exists.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ata,
  ChainReader,
  dbc,
  decodeLoaderAuthority,
  decodeLookupTable,
  decodeSquadsMultisig,
  decodeSquadsProgramConfig,
  launch,
  launchPdas,
  launchTableAddresses,
  lookupTable,
  METEORA,
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
  type DbcParams,
  type Ix,
  type MsgConfigArgs,
  type Params,
  type Rpc,
  type SendResult,
  type Signer,
} from "@lineage/chain";

export const PROGRAM_IDS = {
  registry: "2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY",
  launch: "8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT",
  msg: "E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB",
} as const;

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
  msg: Omit<MsgConfigArgs, "admin">;
  dbc: DbcParams;
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
  if (p.dbc && Array.isArray(p.dbc.curve)) p.dbc.curve = [p.dbc.curve[0], p.dbc.curve[1]];
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
  ({ admin: vault, coreAuthority: p.core_authority, launchProgram: PROGRAM_IDS.launch, params: p.params, maxRebatePerEpoch: p.max_rebate_per_epoch });
export const computeSink = (p: LaunchParams, vault: string) => ata(vault, p.line_mint, p.line_token_program);
export const launchArgs = (p: Loaded, vault: string) => {
  const one = 10n ** BigInt(p.line_decimals), from = 10n ** BigInt(p.net.token_decimals);
  return {
    admin: vault, runtimeAuthority: p.runtime_authority, computeSink: computeSink(p, vault), agentComputeBps: Number(p.net.agent_compute_bps),
    protocolBps: Number(p.net.protocol_bps), sleepThreshold: (BigInt(p.net.sleep_threshold) * one) / from, wakeThreshold: (BigInt(p.net.wake_threshold) * one) / from,
    paused: false, maxDebitPerEpoch: p.max_debit_per_epoch,
  };
};

/**
 * Initializes the three programs with every admin role = the vault (the deployer only signs as the
 * current upgrade authority and pays), the DBC config, the compute sink and the launch lookup table.
 */
export async function initializeAll(rpc: Rpc, send: Send, check: Check, deployer: Signer, dbcConfigKey: Signer, p: Loaded, vault: string, existingTable?: string) {
  const reader = new ChainReader(rpc);
  const T = p.line_token_program;
  for (const [name, id] of Object.entries(PROGRAM_IDS)) {
    const a = decodeLoaderAuthority((await rpc.getAccountInfo(programDataAddress(id)))!.data);
    check(`${name}: upgrade authority is the deployer (initialize needs it) or the registry is already initialized`, a === deployer.id || (await reader.registryConfig()) !== null, `${a}`);
  }
  if (!(await reader.registryConfig()))
    await send("lineage_registry::initialize (admin = vault)", deployer, [registry.initialize({ upgradeAuthority: deployer.id, mint: p.line_mint, tokenProgram: T, args: registryArgs(p, vault) })]);
  const c = (await reader.registryConfig())!;
  check("registry: admin = vault, Core authority, mint", c.admin === vault && c.coreAuthority === p.core_authority && c.mint === p.line_mint && c.maxRebatePerEpoch === p.max_rebate_per_epoch);
  if (!(await rpc.getAccountInfo(dbcConfigKey.id)))
    await send("Meteora DBC create_config (fee claimer and leftover receiver = launch authority PDA)", deployer, [
      dbc.createConfig({ config: dbcConfigKey.id, feeClaimer: launchPdas.authority(), quoteMint: p.line_mint, payer: deployer.id, params: p.dbc })], { signers: [dbcConfigKey] });
  check("DBC config owned by Meteora DBC", (await rpc.getAccountInfo(dbcConfigKey.id))!.owner === METEORA.dbcProgram);
  if (!(await rpc.getAccountInfo(computeSink(p, vault))))
    await send("compute sink: the vault's $LINE token account", deployer, [token.createAtaIdempotent(deployer.id, vault, p.line_mint, T)]);
  if (!(await reader.launchConfig()))
    await send("lineage_launch::initialize_launch (admin = vault, sink = vault's account)", deployer, [
      launch.initialize({ upgradeAuthority: deployer.id, lineMint: p.line_mint, dbcConfig: dbcConfigKey.id, lineTokenProgram: T, args: launchArgs(p, vault) })]);
  const lc = (await reader.launchConfig())!;
  check("launch: admin = vault, sink = vault's account, runtime authority, debit cap", lc.admin === vault && lc.computeSink === computeSink(p, vault) &&
    lc.runtimeAuthority === p.runtime_authority && lc.maxDebitPerEpoch === p.max_debit_per_epoch && lc.dbcConfig === dbcConfigKey.id);
  if (!(await rpc.getAccountInfo(msgPdas.config())))
    await send("lineage_msg::initialize (admin = vault)", deployer, [msg.initialize({ upgradeAuthority: deployer.id, args: { admin: vault, ...p.msg } })]);
  const mc = await readMsgConfig(rpc);
  check("messages: admin = vault", mc?.admin === vault, `${mc?.admin}`);
  const want = launchTableAddresses({ lineMint: p.line_mint, dbcConfig: dbcConfigKey.id, lineTokenProgram: T });
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
  for (const [name, id] of Object.entries(PROGRAM_IDS)) {
    const a = decodeLoaderAuthority((await rpc.getAccountInfo(programDataAddress(id)))!.data);
    check(`${name} upgrade authority = vault`, a === vault, `${a}`);
  }
}
