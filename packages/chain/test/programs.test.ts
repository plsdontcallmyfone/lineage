import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { activePrograms, ChainReader, LAUNCH_PROGRAM_ID, launch, launchPdas, MSG_PROGRAM_ID, msgPdas, PROGRAM_IDS, programIds, registry, registryPdas, REGISTRY_PROGRAM_ID, Rpc, toAddress, useProfilePrograms } from "../src/index.ts";
import { applyNetworkProfile } from "../src/profile-node.ts";
import { DEVNET_PUBLIC_PROFILE, publicProfile, selectProfile } from "../src/profile.ts";

// Program ids per network (SPEC 14): the builds declare them (declare_id! per cargo feature), the
// profile restates them and may not change them.
const anchorToml = readFileSync(new URL("../../../onchain/Anchor.toml", import.meta.url), "utf8");
const section = (name: string) => {
  const m = anchorToml.match(new RegExp(`\\[programs\\.${name}\\]\\n([^\\[]*)`));
  return Object.fromEntries([...(m?.[1] ?? "").matchAll(/units_(\w+) = "(\w+)"/g)].map((x) => [x[1], x[2]]));
};
const declared = (prog: string, feature: "devnet" | "mainnet") => {
  const src = readFileSync(new URL(`../../../onchain/programs/units-${prog}/src/lib.rs`, import.meta.url), "utf8");
  const cfg = feature === "mainnet" ? '#[cfg(feature = "mainnet")]' : '#[cfg(not(feature = "mainnet"))]';
  return src.split(cfg + "\ndeclare_id!(\"")[1]?.split('"')[0];
};
const profileJson = JSON.parse(readFileSync(new URL("../../../config/profile.json", import.meta.url), "utf8"));

describe("program ids per network", () => {
  test("devnet ids are the devnet v2 deployment's and are what the builders use", () => {
    expect(PROGRAM_IDS.devnet).toEqual({ registry: REGISTRY_PROGRAM_ID, launch: LAUNCH_PROGRAM_ID, msg: MSG_PROGRAM_ID });
    expect(REGISTRY_PROGRAM_ID).toBe("CJk3kwUqSS4qoJD8iu7uhUzSBNySjn9HsqaExpaV9gM2");
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

describe("builders and PDAs follow the active profile's ids", () => {
  const k = (n: number) => toAddress(new Uint8Array(32).fill(n));
  const sample = () => ({
    ids: [REGISTRY_PROGRAM_ID, LAUNCH_PROGRAM_ID, MSG_PROGRAM_ID],
    pdas: [registryPdas.config(), registryPdas.agent(k(2)), launchPdas.config(), launchPdas.computeVault(k(2)), msgPdas.config()],
    ix: [registry.pause({ admin: k(1), paused: true }), launch.crankPumpFees({ agent: k(2), agentMint: k(3), lineMint: k(5), lineTokenProgram: k(7) })]
      .map((x) => ({ p: x.programId, k: x.keys.map((m) => m.pubkey), d: Buffer.from(x.data).toString("hex") })),
  });
  const devnet = () => useProfilePrograms({ network: "devnet", programs: PROGRAM_IDS.devnet });

  test("mainnet profile switches every id and PDA; devnet again is byte-identical to the default", () => {
    const before = sample();
    expect(activePrograms()).toEqual({ network: "devnet", ...PROGRAM_IDS.devnet });
    try {
      useProfilePrograms(selectProfile(profileJson, "mainnet"));
      const m = sample();
      expect(m.ids).toEqual([PROGRAM_IDS.mainnet.registry, PROGRAM_IDS.mainnet.launch, PROGRAM_IDS.mainnet.msg]);
      expect(m.ix[0]!.p).toBe(PROGRAM_IDS.mainnet.registry);
      expect(m.ix[1]!.p).toBe(PROGRAM_IDS.mainnet.launch);
      for (let i = 0; i < before.pdas.length; i++) expect(m.pdas[i]).not.toBe(before.pdas[i]);
      expect(m.ix[0]!.d).toBe(before.ix[0]!.d); // same instruction data, other program
      expect(new ChainReader(Rpc.http("http://127.0.0.1:1")).registryProgram).toBe(PROGRAM_IDS.mainnet.registry);
    } finally {
      devnet();
    }
    expect(sample()).toEqual(before);
  });
  test("applyNetworkProfile applies the profile's ids (LINEAGE_NETWORK=mainnet), devnet leaves them unchanged", () => {
    const before = sample();
    try {
      applyNetworkProfile({ env: { LINEAGE_NETWORK: "mainnet" } });
      expect(activePrograms()).toEqual({ network: "mainnet", ...PROGRAM_IDS.mainnet });
      const reader = new ChainReader(Rpc.http("http://127.0.0.1:1"));
      devnet();
      expect(reader.launchProgram).toBe(PROGRAM_IDS.devnet.launch); // a reader built earlier follows too
      applyNetworkProfile({ env: { LINEAGE_NETWORK: "devnet" } });
      expect(sample()).toEqual(before);
    } finally {
      devnet();
      applyNetworkProfile({ env: { LINEAGE_NETWORK: "devnet" } });
    }
  });
  test("a profile whose ids are not its network's row is refused", () => {
    expect(() => useProfilePrograms({ network: "mainnet", programs: PROGRAM_IDS.devnet })).toThrow(/not the id the mainnet build declares/);
    expect(() => useProfilePrograms({ network: "testnet", programs: PROGRAM_IDS.devnet })).toThrow();
    expect(activePrograms().network).toBe("devnet");
  });
});
