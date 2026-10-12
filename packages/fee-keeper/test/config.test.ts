import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MAX_SLIPPAGE_BPS, parseConfig, publicConfig } from "../src/index.ts";

const A = "7xZcN6nKzFxvfLFQ9MoiYDrZkhkf45QUtj8U4dKh6Hrm", B = "71SxYMfCLfX7p9nx1gQGscT1x5xCk72iDhdyJy7id6cB", C = "Fqg8RsYjozjc1x6Mko5PY64DazCbN73fpdNg8z1BNAF5";
const good = () => ({
  enabled: false, rpc_url: "http://127.0.0.1:9690", mint: A, creator: B, key_path: "/etc/units-fee-keeper/creator.json", compute_address: C, compute_bps: 5000, burn_bps: 5000,
  fee_reserve_lamports: "10000000", min_collect_lamports: 5000000, min_buyback_lamports: "1000000", max_buyback_lamports: "50000000", slippage_bps: 100,
  priority_fee: { percentile: 75, floor_micro_lamports: 0, cap_micro_lamports: 50000 }, confirm_timeout_s: 60, state_path: "/var/lib/x/state.json", log_path: "/var/lib/x/runs.jsonl",
}) as Record<string, unknown>;
const bad = (over: Record<string, unknown>, env: Record<string, string> = {}) => () => parseConfig({ ...good(), ...over }, env);

describe("fee keeper config", () => {
  test("a complete config parses; lamports are read from numbers or decimal strings", () => {
    const c = parseConfig(good());
    expect([c.compute_bps, c.burn_bps, c.fee_reserve_lamports, c.min_collect_lamports, c.max_buyback_lamports]).toEqual([5000, 5000, 10_000_000n, 5_000_000n, 50_000_000n]);
    expect(c.priority_fee).toEqual({ mode: "recent", percentile: 75, floor_micro_lamports: 0, cap_micro_lamports: 50000 });
  });
  test("the example in config/ parses once its placeholders are filled, is off, and names no creator, key or compute address", () => {
    const ex = JSON.parse(readFileSync(new URL("../../../config/fee-keeper.example.json", import.meta.url), "utf8"));
    expect([ex.enabled, ex.creator, ex.key_path, ex.compute_address]).toEqual([false, null, null, null]);
    expect(() => parseConfig(ex, { UNITS_FEE_KEEPER_RPC: "http://127.0.0.1:1" })).toThrow("config.creator must be a base58 address (there is no default)");
    const c = parseConfig({ ...ex, creator: B, compute_address: C }, { UNITS_FEE_KEEPER_RPC: "http://127.0.0.1:1" });
    expect([c.compute_bps, c.burn_bps, c.mint]).toEqual([5000, 5000, "GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump"]);
  });
  test("the split must sum to 10000", () => {
    expect(bad({ compute_bps: 5000, burn_bps: 4000 })).toThrow("must be 10000 (they are 5000 + 4000)");
    expect(bad({ compute_bps: 6000, burn_bps: 5000 })).toThrow("must be 10000");
    expect(bad({ compute_bps: 50.5 })).toThrow("config.compute_bps must be an integer");
    expect(parseConfig({ ...good(), compute_bps: 2500, burn_bps: 7500 }).burn_bps).toBe(7500);
  });
  test("there is no default: every missing field is named", () => {
    for (const k of Object.keys(good()).filter((k) => k !== "rpc_url" && k !== "key_path")) {
      const g = good();
      delete g[k];
      expect(() => parseConfig(g)).toThrow(k === "burn_bps" || k === "compute_bps" ? /_bps/ : k);
    }
  });
  test("addresses: base58 of 32 bytes, three different ones", () => {
    expect(bad({ creator: "not-an-address" })).toThrow("config.creator");
    expect(bad({ mint: "11111111111111111111" })).toThrow("config.mint");
    expect(bad({ compute_address: B })).toThrow("the creator wallet itself");
    expect(bad({ compute_address: A })).toThrow("cannot also be");
  });
  test("limits: the slippage ceiling, a buyback window that can be met, whole lamports, absolute paths", () => {
    expect(bad({ slippage_bps: MAX_SLIPPAGE_BPS + 1 })).toThrow("config.slippage_bps");
    expect(bad({ min_buyback_lamports: "60000000" })).toThrow("no buyback could ever be sent");
    expect(bad({ fee_reserve_lamports: "0.01" })).toThrow("whole number of lamports");
    expect(bad({ fee_reserve_lamports: -1 })).toThrow("whole number of lamports");
    expect(bad({ min_collect_lamports: 0 })).toThrow("at least 1");
    expect(bad({ state_path: "state.json" })).toThrow("absolute path");
    expect(bad({ log_path: "/var/lib/x/state.json" })).toThrow("two files");
    expect(bad({ priority_fee: { percentile: 75, floor_micro_lamports: 10, cap_micro_lamports: 5 } })).toThrow("above the cap");
    expect(bad({ priority_fee: { percentile: 0, floor_micro_lamports: 0, cap_micro_lamports: 5 } })).toThrow("percentile");
    expect(bad({ enabled: "yes" })).toThrow("config.enabled");
  });
  test("the RPC URL comes from the config or from UNITS_FEE_KEEPER_RPC, and is never in what is printed", () => {
    expect(bad({ rpc_url: null })).toThrow("no RPC endpoint");
    const c = parseConfig({ ...good(), rpc_url: null }, { UNITS_FEE_KEEPER_RPC: "https://rpc.example.invalid/?api-key=SECRET" });
    expect(c.rpc_url).toContain("SECRET");
    expect(JSON.stringify(publicConfig(c))).not.toContain("SECRET");
    expect(parseConfig(good(), { UNITS_FEE_KEEPER_RPC: "https://other.invalid" }).rpc_url).toBe("https://other.invalid");
    expect(bad({ key_path: "creator.json" })).toThrow("config.key_path");
    expect(parseConfig({ ...good(), key_path: null }).key_path).toBeNull();
  });
});
