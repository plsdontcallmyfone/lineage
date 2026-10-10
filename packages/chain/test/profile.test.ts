// Network profile switch (M3, SPEC 14.10): config/profile.json parses, devnet stays the default and
// equals the behaviour before profiles, mainnet drops the faucet and TEST labels, takes the quote
// from config (the swap path's stand-in mint), and needs a keyed RPC from env with no public fallback.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSwapTarget,
  DEVNET_PUBLIC_PROFILE,
  explorerUrl,
  parseProfile,
  publicProfile,
  quoteOfState,
  selectProfile,
} from "../src/profile.ts";
import { loadNetworkProfile, MissingRpcError, PROFILE_FILE, rpcUrlFor, stateFor } from "../src/profile-node.ts";
import { parseSwapConfig } from "../src/swap.ts";

const raw = JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
const swap = parseSwapConfig(JSON.parse(readFileSync(join(import.meta.dir, "../../../config/swap.json"), "utf8")));

describe("profile switch", () => {
  test("the file says devnet and devnet is what every process gets without LINEAGE_NETWORK", () => {
    expect(raw.network).toBe("devnet");
    expect(loadNetworkProfile({ env: {} }).network).toBe("devnet");
    expect(loadNetworkProfile({ env: { LINEAGE_NETWORK: "mainnet" } }).network).toBe("mainnet");
    expect(() => loadNetworkProfile({ env: { LINEAGE_NETWORK: "testnet" } })).toThrow(/devnet or mainnet/);
  });

  test("devnet is unchanged: the browser fallback equals the configured devnet profile", () => {
    const d = selectProfile(raw, null);
    expect(publicProfile(d)).toEqual(DEVNET_PUBLIC_PROFILE);
    expect(d.faucet).toBe(true);
    expect(d.test_labels).toBe(true);
    expect(d.swap).toBe(false);
    expect(d.quote).toMatchObject({ source: "chain_state", symbol: "tLINE" });
    // the price every devnet transaction always used, and the devnet confirmation timing (900 ms poll, 2.5 s rebroadcast)
    expect(d.fees).toEqual({ mode: "fixed", cu_price_micro_lamports: 1 });
    expect(d.confirm).toEqual({ poll_ms: 900, resend_ms: 2500, rebuilds: 0 });
    expect(explorerUrl(publicProfile(d), "tx", "abc")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
  });

  test("devnet state is passed through untouched", () => {
    const d = selectProfile(raw, "devnet");
    const st = { line_mint: "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU", line_decimals: 6, line_token_program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", x: 1 };
    expect(quoteOfState(d, st)).toBe(st);
    const devState = stateFor(d);
    if (devState) expect(devState).toEqual(JSON.parse(readFileSync(join(import.meta.dir, "../../../scripts/devnet/devnet.json"), "utf8")));
  });

  test("mainnet: no faucet, no TEST labels, quote from config, recent fees with a cap", () => {
    const m = selectProfile(raw, "mainnet");
    expect(m.faucet).toBe(false);
    expect(m.test_labels).toBe(false);
    expect(m.swap).toBe(true);
    expect(m.quote.source).toBe("config");
    expect(m.quote.line_mint).toBeNull(); // $LINE is TBA
    expect(m.quote.status).toBe("stand-in");
    expect(m.fees.mode).toBe("recent");
    if (m.fees.mode === "recent") expect(m.fees.cap_micro_lamports).toBeGreaterThan(0);
    expect(explorerUrl(publicProfile(m), "address", "x")).toBe("https://explorer.solana.com/address/x");
  });

  test("the mainnet quote is the swap path's target (one mint, one decimals, one token program)", () => {
    const m = selectProfile(raw, "mainnet");
    expect(checkSwapTarget(m, swap)).toBeNull();
    expect(m.quote.mint).toBe(swap.target_mint);
    expect(checkSwapTarget(m, { ...swap, target_mint: "So11111111111111111111111111111111111111112" })).toMatch(/differs/);
    expect(checkSwapTarget(selectProfile(raw, "devnet"), null)).toBeNull();
  });

  test("mainnet quote overrides a state file, and a state file naming another mint is refused", () => {
    const m = selectProfile(raw, "mainnet");
    const st = quoteOfState(m, { registry_program: "R" })!;
    expect(st).toMatchObject({ registry_program: "R", line_mint: m.quote.mint, line_decimals: m.quote.decimals, line_token_program: m.quote.token_program });
    expect(() => quoteOfState(m, { line_mint: "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU" })).toThrow(/line_mint/);
    expect(quoteOfState(m, null)).toBeNull();
  });

  test("mainnet guards refuse a faucet, TEST labels, a test quote, a chain-state quote or a fixed fee", () => {
    const base = raw.profiles.mainnet;
    expect(() => parseProfile("mainnet", { ...base, faucet: true })).toThrow(/faucet/);
    expect(() => parseProfile("mainnet", { ...base, test_labels: true })).toThrow(/test_labels/);
    expect(() => parseProfile("mainnet", { ...base, quote: { ...base.quote, status: "test" } })).toThrow(/test/);
    expect(() => parseProfile("mainnet", { ...base, quote: { source: "chain_state", symbol: "X", status: "live" } })).toThrow(/config/);
    expect(() => parseProfile("mainnet", { ...base, fees: { mode: "fixed", cu_price_micro_lamports: 1 } })).toThrow(/recent/);
    expect(() => parseProfile("mainnet", { ...base, fees: { ...base.fees, floor_micro_lamports: 10, cap_micro_lamports: 5 } })).toThrow(/floor above cap/);
    expect(() => parseProfile("mainnet", { ...base, quote: { ...base.quote, decimals: 99 } })).toThrow(/decimals/);
    expect(() => parseProfile("mainnet", { ...base, quote: { ...base.quote, status: "live" } })).toThrow(/line_mint/);
  });

  test("the public view carries no RPC URL", () => {
    for (const n of ["devnet", "mainnet"] as const) {
      const s = JSON.stringify(publicProfile(selectProfile(raw, n)));
      expect(s).not.toMatch(/https?:/);
      expect(s).not.toMatch(/rpc/i);
    }
  });
});

describe("rpc resolution", () => {
  const home = mkdtempSync(join(tmpdir(), "lineage-profile-"));
  const m = selectProfile(raw, "mainnet");

  test("mainnet reads LINEAGE_MAINNET_RPC, then HELIUS_MAINNET_RPC in rpc.env", () => {
    expect(rpcUrlFor(m, { LINEAGE_MAINNET_RPC: "https://rpc.example/?api-key=k1" }, home)).toBe("https://rpc.example/?api-key=k1");
    const h2 = mkdtempSync(join(tmpdir(), "lineage-profile-"));
    const dir = join(h2, ".config/lineage");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rpc.env"), 'HELIUS_MAINNET_RPC="https://rpc.example/?api-key=k2"\n');
    expect(rpcUrlFor(m, {}, h2)).toBe("https://rpc.example/?api-key=k2");
  });

  test("mainnet has no public fallback", () => {
    expect(() => rpcUrlFor(m, {}, home)).toThrow(MissingRpcError);
  });
});
