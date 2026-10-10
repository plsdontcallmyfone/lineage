import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LAUNCH_PROGRAM_ID, MSG_PROGRAM_ID, PROGRAM_IDS, programIds, REGISTRY_PROGRAM_ID } from "../src/index.ts";
import { DEVNET_PUBLIC_PROFILE, publicProfile, selectProfile } from "../src/profile.ts";

// Program ids per network (SPEC 14): the builds declare them (declare_id! per cargo feature), the
// profile restates them and may not change them.
const anchorToml = readFileSync(new URL("../../../onchain/Anchor.toml", import.meta.url), "utf8");
const section = (name: string) => {
  const m = anchorToml.match(new RegExp(`\\[programs\\.${name}\\]\\n([^\\[]*)`));
  return Object.fromEntries([...(m?.[1] ?? "").matchAll(/lineage_(\w+) = "(\w+)"/g)].map((x) => [x[1], x[2]]));
};
const declared = (prog: string, feature: "devnet" | "mainnet") => {
  const src = readFileSync(new URL(`../../../onchain/programs/lineage-${prog}/src/lib.rs`, import.meta.url), "utf8");
  const cfg = feature === "mainnet" ? '#[cfg(feature = "mainnet")]' : '#[cfg(not(feature = "mainnet"))]';
  return src.split(cfg + "\ndeclare_id!(\"")[1]?.split('"')[0];
};
const profileJson = JSON.parse(readFileSync(new URL("../../../config/profile.json", import.meta.url), "utf8"));

describe("program ids per network", () => {
  test("devnet ids are unchanged and are what the builders use", () => {
    expect(PROGRAM_IDS.devnet).toEqual({ registry: REGISTRY_PROGRAM_ID, launch: LAUNCH_PROGRAM_ID, msg: MSG_PROGRAM_ID });
    expect(REGISTRY_PROGRAM_ID).toBe("2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY");
  });
  test("each network's ids equal the program sources' declare_id! and Anchor.toml", () => {
    for (const net of ["devnet", "mainnet"] as const) {
      expect(section(net)).toEqual(PROGRAM_IDS[net]);
      for (const p of ["registry", "launch", "msg"] as const) expect(declared(p, net)).toBe(PROGRAM_IDS[net][p]);
    }
    expect(new Set([...Object.values(PROGRAM_IDS.devnet), ...Object.values(PROGRAM_IDS.mainnet)]).size).toBe(6);
  });
  test("the profile carries its network's ids and refuses others", () => {
    for (const net of ["devnet", "mainnet"] as const) {
      const p = selectProfile(profileJson, net);
      expect(p.programs).toEqual(PROGRAM_IDS[net]);
      expect(publicProfile(p).programs).toEqual(PROGRAM_IDS[net]);
      expect(programIds(net)).toEqual(PROGRAM_IDS[net]);
    }
    expect(DEVNET_PUBLIC_PROFILE.programs).toEqual(PROGRAM_IDS.devnet);
    const swapped = structuredClone(profileJson);
    swapped.profiles.mainnet.programs = { ...PROGRAM_IDS.devnet };
    expect(() => selectProfile(swapped, "mainnet")).toThrow(/programs.registry must be 3GeaTs/);
    const absent = structuredClone(profileJson);
    delete absent.profiles.devnet.programs;
    expect(selectProfile(absent, "devnet").programs).toEqual(PROGRAM_IDS.devnet);
    expect(() => programIds("testnet")).toThrow();
  });
});
