import type { Address } from "./codec.ts";
import { LAUNCH_PROGRAM_ID } from "./launch.ts";
import { MSG_PROGRAM_ID } from "./msg.ts";
import { REGISTRY_PROGRAM_ID } from "./registry.ts";

// Program ids per network (SPEC 14, "Program ids"). The programs pick theirs at build time: the
// default build declares the devnet ids, the cargo feature `mainnet` the mainnet ones (onchain/
// Anchor.toml [programs.mainnet]). The mainnet id keypairs live outside the repo, in
// ~/.config/lineage/mainnet/{registry,launch,msg}-program-keypair.json.
//
// The network profile (config/profile.json `programs`, SPEC 14.10) carries a row of this table and
// refuses any other id. The instruction builders still use the devnet constants
// (REGISTRY_PROGRAM_ID and friends); a mainnet sender must take the ids from the profile.

export type ProgramNetwork = "devnet" | "mainnet";
export interface ProgramIds {
  registry: Address;
  launch: Address;
  msg: Address;
}

export const PROGRAM_IDS: Readonly<Record<ProgramNetwork, Readonly<ProgramIds>>> = Object.freeze({
  devnet: Object.freeze({ registry: REGISTRY_PROGRAM_ID, launch: LAUNCH_PROGRAM_ID, msg: MSG_PROGRAM_ID }),
  mainnet: Object.freeze({
    registry: "3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay",
    launch: "2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq",
    msg: "jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky",
  }),
});

/** The program ids of `network`; throws on anything but devnet or mainnet. */
export function programIds(network: string): ProgramIds {
  if (network !== "devnet" && network !== "mainnet") throw new Error(`no program ids for network ${JSON.stringify(network)}`);
  return PROGRAM_IDS[network];
}
