import type { Address } from "./codec.ts";

// Program ids per network (SPEC 14, "Program ids"). The programs pick theirs at build time: the
// default build declares the devnet ids, the cargo feature `mainnet` the mainnet ones (onchain/
// Anchor.toml [programs.mainnet]). The mainnet id keypairs live outside the repo, in
// ~/.config/lineage/mainnet/{registry,launch,msg}-program-keypair.json.
//
// The network profile (config/profile.json `programs`, SPEC 14.10) carries a row of this table and
// refuses any other id. Every instruction builder, PDA helper and reader in this package uses the
// ACTIVE ids below: devnet until a profile is applied (applyNetworkProfile in profile-node.ts on a
// service, useProfilePrograms with the page's /chain/config profile in a browser, or directly by a
// script). REGISTRY_PROGRAM_ID, LAUNCH_PROGRAM_ID and MSG_PROGRAM_ID are live bindings of the active
// ids, so importers follow the profile too.

export type ProgramNetwork = "devnet" | "mainnet";
export interface ProgramIds {
  registry: Address;
  launch: Address;
  msg: Address;
}

export const PROGRAM_IDS: Readonly<Record<ProgramNetwork, Readonly<ProgramIds>>> = Object.freeze({
  devnet: Object.freeze({
    registry: "CJk3kwUqSS4qoJD8iu7uhUzSBNySjn9HsqaExpaV9gM2",
    launch: "Axo38WX6TBAGGQ2nPpejn5tPsQogygA728baRaeJebGX",
    msg: "5uUyWAc9DQEWb3XF1aH8yG62sCjmrEjtAoRB1SD9JFqV",
  }),
  mainnet: Object.freeze({
    registry: "3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay",
    launch: "2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq",
    msg: "jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky",
  }),
});

/**
 * The first devnet deployment (2026-10-07 to 2026-10-10), bound at initialize to the earlier plain
 * Token-2022 tLINE (3PLqpw...): kept read-only as history after devnet moved to pump.fun with a fresh
 * deployment (owner decision 2026-10-10, onchain/DEVNET.md "Devnet v2"). Nothing builds against these
 * ids except tests over fixtures recorded at them.
 */
export const DEVNET_V1_PROGRAM_IDS: Readonly<ProgramIds> = Object.freeze({
  registry: "2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY",
  launch: "8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT",
  msg: "E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB",
});

/**
 * Tests over fixtures recorded at other ids (DEVNET_V1_PROGRAM_IDS): makes `ids` active and returns a
 * function that restores the previous ids. Never used by a service or the pages.
 */
export function useProgramIdsForTest(ids: ProgramIds): () => void {
  const prev = { registry: REGISTRY_PROGRAM_ID, launch: LAUNCH_PROGRAM_ID, msg: MSG_PROGRAM_ID };
  REGISTRY_PROGRAM_ID = ids.registry;
  LAUNCH_PROGRAM_ID = ids.launch;
  MSG_PROGRAM_ID = ids.msg;
  return () => {
    REGISTRY_PROGRAM_ID = prev.registry;
    LAUNCH_PROGRAM_ID = prev.launch;
    MSG_PROGRAM_ID = prev.msg;
  };
}

/** useProgramIdsForTest around one synchronous call. */
export function withProgramIdsForTest<T>(ids: ProgramIds, fn: () => T): T {
  const restore = useProgramIdsForTest(ids);
  try {
    return fn();
  } finally {
    restore();
  }
}

/** The program ids of `network`; throws on anything but devnet or mainnet. */
export function programIds(network: string): ProgramIds {
  if (network !== "devnet" && network !== "mainnet") throw new Error(`no program ids for network ${JSON.stringify(network)}`);
  return PROGRAM_IDS[network];
}

/** units_registry id of the active network (devnet until a profile is applied). */
export let REGISTRY_PROGRAM_ID: Address = PROGRAM_IDS.devnet.registry;
/** units_launch id of the active network (devnet until a profile is applied). */
export let LAUNCH_PROGRAM_ID: Address = PROGRAM_IDS.devnet.launch;
/** units_msg id of the active network (devnet until a profile is applied). */
export let MSG_PROGRAM_ID: Address = PROGRAM_IDS.devnet.msg;
let activeNetwork: ProgramNetwork = "devnet";

/**
 * Makes a network profile's program ids the ones every builder, PDA and reader uses. Takes the
 * profile (NetworkProfile or PublicProfile): its `programs` must be the table's row for its network
 * (profile.ts already refuses anything else; checked again here).
 */
export function useProfilePrograms(p: { network: string; programs: ProgramIds }): ProgramIds {
  const want = programIds(p.network);
  for (const k of ["registry", "launch", "msg"] as const)
    if (p.programs[k] !== want[k]) throw new Error(`profile ${p.network}: programs.${k} ${p.programs[k]} is not the id the ${p.network} build declares (${want[k]})`);
  REGISTRY_PROGRAM_ID = want.registry;
  LAUNCH_PROGRAM_ID = want.launch;
  MSG_PROGRAM_ID = want.msg;
  activeNetwork = p.network as ProgramNetwork;
  return activePrograms();
}

/** The ids the builders use now, and the network they belong to. */
export function activePrograms(): ProgramIds & { network: ProgramNetwork } {
  return { network: activeNetwork, registry: REGISTRY_PROGRAM_ID, launch: LAUNCH_PROGRAM_ID, msg: MSG_PROGRAM_ID };
}
