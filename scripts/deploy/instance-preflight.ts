#!/usr/bin/env bun
// A second site instance, before it is activated (remote-instance.sh activate): the endpoint in the
// environment is the instance's network, the three programs are deployed there at the profile's ids,
// the registry and the launch program are initialized, and the chain state file and the profile
// overlay agree with the chain about the quote mint. Read only. The RPC URL is never printed.
//
//   UNITS_NETWORK=mainnet UNITS_PROFILE_LOCAL=<overlay> UNITS_MAINNET_RPC=<url> bun scripts/deploy/instance-preflight.ts mainnet
import { ChainReader, Rpc } from "@units/chain";
import { applyNetworkProfile, rpcUrlFor, stateFor } from "../../packages/chain/src/profile-node.ts";
import { instanceLayout } from "./instance.ts";

const L = instanceLayout(process.argv[2]);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`[preflight ${L.name}] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
try {
  const profile = applyNetworkProfile();
  check(`the active profile is ${L.network}`, profile.network === L.network, profile.network);
  const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
  const genesis = await rpc.call<string>("getGenesisHash");
  check(`the endpoint's genesis is the ${L.network} profile's`, genesis === profile.genesis, `${genesis.slice(0, 8)}...`);
  for (const [name, id] of Object.entries(profile.programs)) {
    const a = await rpc.getAccountInfo(id);
    check(`units_${name} is deployed at ${id}`, !!a?.executable);
  }
  const state = stateFor(profile) as Record<string, unknown> | null;
  check("the chain state file is readable through the profile", !!state, profile.state_file);
  for (const k of ["registry", "launch", "msg"] as const)
    check(`state ${k}_program is the profile's id`, state?.[`${k}_program`] === profile.programs[k], String(state?.[`${k}_program`]));
  const reader = new ChainReader(rpc);
  const reg = await reader.registryConfig();
  check("units_registry is initialized", !!reg);
  check("the registry's mint is the profile's quote mint", !!reg && reg.mint === profile.quote.mint, `${reg?.mint} / ${profile.quote.mint}`);
  check("the registry's Core authority is the state file's", !!reg && reg.coreAuthority === state?.core_authority, String(reg?.coreAuthority));
  const lc = await reader.launchConfig();
  check("units_launch is initialized", !!lc);
  check("the launch program's runtime authority is the state file's", !!lc && lc.runtimeAuthority === state?.runtime_authority, String(lc?.runtimeAuthority));
  check("the quote mint exists with the profile's decimals", (await reader.mint(profile.quote.mint!))?.decimals === profile.quote.decimals);
} catch (e) {
  check("preflight ran", false, (e as Error).message.replace(/https?:\/\/\S+/g, "[url]"));
}
console.log(`[preflight ${L.name}] ${failed ? `NOT READY (${failed} failed)` : "READY"}`);
process.exit(failed ? 1 : 0);
