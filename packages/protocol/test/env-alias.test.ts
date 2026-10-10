import { describe, expect, test } from "bun:test";
import { aliasBrandEnv } from "../src/env-alias.ts";

describe("rebrand env aliases", () => {
  test("either prefix fills the other; both set keep their own values; other names untouched", () => {
    const env: Record<string, string | undefined> = { UNITS_NETWORK: "devnet", LINEAGE_HOME: "/h", UNITS_SEED: "1", LINEAGE_SEED: "2", PATH: "/bin" };
    aliasBrandEnv(env);
    expect(env.LINEAGE_NETWORK).toBe("devnet");
    expect(env.UNITS_HOME).toBe("/h");
    expect(env.UNITS_SEED).toBe("1");
    expect(env.LINEAGE_SEED).toBe("2");
    expect(Object.keys(env).sort()).toEqual(["LINEAGE_HOME", "LINEAGE_NETWORK", "LINEAGE_SEED", "PATH", "UNITS_HOME", "UNITS_NETWORK", "UNITS_SEED"]);
  });
});
