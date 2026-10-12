import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROGRAM_IDS } from "@units/chain";
import { parseProfile } from "../../packages/chain/src/profile.ts";
import {
  checkOfficialParams, feeKeeperConfig, loadOfficialParams, nextPostNotBefore, officialOverlay, officialState, resolveOfficial, rolledBackProfileJson, switchedProfileJson, usdToUnits, verifierNeed,
  type UnitsPrice,
} from "./golive-steps.ts";
import { parseLaunchParams } from "./steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const P = loadOfficialParams(join(import.meta.dir, "official-params.json"));
const price: UnitsPrice = { usd_per_units: 0.000003, sol_usd: 100, sol_per_units: 3e-8, venue: "curve", read_at: "2026-10-12T00:00:00.000Z" };
const A = "8MPJ3hiYZrWhZPHJPxcy6nxnFqDsTMrBMY1HbK4VsNGj";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("official-params.json is valid, names the dev wallet everywhere a wallet is configurable, and carries the owner's confirmation", () => {
  expect(P.admin).toBe("6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3");
  expect(P.fee_split).toEqual({ agent_compute_bps: 7000, protocol_bps: 3000 });
  // confirmed by the owner on 2026-10-12 ("yes! settings are all correct."); init --send refuses while this is false
  expect(P.owner_confirmed).toBe(true);
  expect(P.site.extra_verifiers.map((e) => e.agent)).toEqual(["kdhdDrZ8x1dCKCVBZUNYAUufSfQegKMEXW3MVbK1LRL", "HNaVHuqadsRMPmaEsn3WYUgZ1gCkVTkcMpqcyusjc3tZ"]);
  expect(readFileSync(join(import.meta.dir, "official-params.json"), "utf8")).not.toContain(String.fromCharCode(0x2014));
});

test("a bad parameter file is refused with the reason", () => {
  const bad = (f: (p: any) => void) => { const p = clone(P) as any; f(p); return () => checkOfficialParams(p); };
  expect(bad((p) => { p.fee_split.protocol_bps = 2000; })).toThrow(/fee_split/);
  expect(bad((p) => { p.owner_decision.unbond_cooldown_s = 500; })).toThrow(/unbond_cooldown_s/);
  expect(bad((p) => { p.owner_decision.challenge.reward_units = "999999999"; })).toThrow(/max_rebate_per_epoch/);
  expect(bad((p) => { p.owner_decision.core_epoch_length_s = 200; })).toThrow(/core_epoch_length_s/);
  expect(bad((p) => { p.owner_decision.max_slash_bps_per_epoch = 2000; })).toThrow(/max_slash_bps_per_epoch/);
  expect(bad((p) => { p.owner_decision.min_bond_units = "TBA"; })).toThrow(/TBA/);
  expect(bad((p) => { p.owner_decision.wake_threshold_usd = "0.1"; })).toThrow(/wake_threshold_usd/);
  expect(bad((p) => { p.owner_decision.price_band.min_usd = 2; })).toThrow(/price_band/);
  expect(bad((p) => { p.site.extra_verifiers[1].agent = p.site.extra_verifiers[0].agent; })).toThrow(/twice/);
});

test("dollars become whole coins at the price, three significant digits, never zero", () => {
  expect(usdToUnits("1", 0.000003)).toBe(333_000n);
  expect(usdToUnits("0.50", 0.000003)).toBe(167_000n);
  expect(usdToUnits("200", 0.000003)).toBe(66_700_000n);
  expect(usdToUnits("10", 2.5)).toBe(4n);
  expect(usdToUnits("0.01", 5)).toBe(1n);
  expect(() => usdToUnits("1", 0)).toThrow();
});

test("the resolved values are what the programs take, in base units, and the registry accepts them", () => {
  const r = resolveOfficial(P, A, price, join(ROOT, "config/network.json"));
  expect(r.network.token_decimals).toBe(6);
  expect(r.network.min_bond).toBe("1000000000000");
  expect(r.network.register_burn).toBe("200000000000");
  expect(r.network.sleep_threshold).toBe("167000000000");
  expect((r.launch_params as any).max_debit_per_epoch).toBe("100000000000000n");
  expect((r.launch_params as any).challenge.reward).toBe("100000000000n");
  // through the same parser init uses, from a file holding the resolved network
  const f = join(require("node:os").tmpdir(), `golive-test-network-${process.pid}.json`);
  require("node:fs").writeFileSync(f, JSON.stringify(r.network));
  const L = parseLaunchParams({ ...r.launch_params, network_file: f });
  expect(L.params.minBond).toBe(1_000_000_000_000n);
  expect(L.params.epochLengthS).toBe(300);
  expect(L.params.unbondCooldownS).toBe(86_400n);
  expect(L.max_rebate_per_epoch).toBe(500_000_000_000n);
  require("node:fs").rmSync(f);
});

test("the mint is a parameter: nothing else in the resolution, the state file or the overlay depends on which coin it is", () => {
  const swap = (x: unknown) => JSON.stringify(x).split(A).join(P.units_mint);
  expect(swap(resolveOfficial(P, A, price, "x"))).toBe(JSON.stringify(resolveOfficial(P, P.units_mint, price, "x")));
  const facts = (mint: string) => ({ mint, line_token_program: P.line_token_program, line_decimals: 6, admin: P.admin, core_authority: P.core_authority, runtime_authority: P.runtime_authority,
    launch_lookup_table: "T".repeat(43), compute_sink: "S".repeat(43), agent_compute_bps: 7000, protocol_bps: 3000 });
  const ids = PROGRAM_IDS.mainnet;
  expect(swap(officialState(P, ids, facts(A), price, { identity: true, indexerPort: 9768 }))).toBe(JSON.stringify(officialState(P, ids, facts(P.units_mint), price, { identity: true, indexerPort: 9768 })));
  expect(swap(officialOverlay(ids, facts(A)))).toBe(JSON.stringify(officialOverlay(ids, facts(P.units_mint))));
});

test("the state file: the dev wallet receives the units account payment, credits at the live rate, billing from the instance's indexer inside the band", () => {
  const facts = { mint: A, line_token_program: P.line_token_program, line_decimals: 6, admin: P.admin, core_authority: P.core_authority, runtime_authority: P.runtime_authority,
    launch_lookup_table: "T".repeat(43), compute_sink: "S".repeat(43), agent_compute_bps: 7000, protocol_bps: 3000 };
  const s = officialState(P, PROGRAM_IDS.mainnet, facts, price, { identity: true, indexerPort: 9768 });
  expect(s.registry_program).toBe("3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay");
  expect(s.network_overrides.prepay).toMatchObject({ identity_account_recipient: P.admin, identity_account_price_lamports: "30000000", line_per_usd: "333000", rate_status: "live", rate_source: "market", rate_max_age_s: 120, rate_min_usd: 3e-7, rate_max_usd: 1, rate_tolerance_bps: 1000, rate_window_s: 300, min_usd: "10", compute_price_line_per_usd: "333000", compute_price_line_per_sandbox_s: "33.3" });
  expect(s.runtime_price).toEqual({ source: "jupiter", api: "http://127.0.0.1:9768/market/price/v3", min_usd: 3e-7, max_usd: 1, max_age_s: 120, refresh_s: 30 });
  expect(officialState(P, PROGRAM_IDS.mainnet, facts, price, { identity: false, indexerPort: 9768 }).network_overrides.prepay.identity_account_recipient).toBeNull();
});

test("config/profile.json: the switch is the one edit plus the real quote, parses as a profile, and rolls back", () => {
  const text = readFileSync(join(ROOT, "config/profile.json"), "utf8");
  const c = { mint: P.units_mint, line_decimals: 6, line_token_program: P.line_token_program };
  const next = switchedProfileJson(text, c, "config/mainnet/state.json");
  const a = JSON.parse(text), b = JSON.parse(next);
  expect(b.mainnet_deployment).toBe("official");
  expect(b.profiles.mainnet.quote).toMatchObject({ mint: P.units_mint, status: "live", units_mint: P.units_mint, units_mint_status: "live", symbol: "UNITS" });
  expect(b.profiles.mainnet.swap).toBe(false);
  expect(b.profiles.mainnet.programs).toEqual(a.profiles.mainnet.programs);
  expect(b.profiles.devnet).toEqual(a.profiles.devnet);
  const prof = parseProfile("mainnet", b.profiles.mainnet);
  expect(prof.quote.mint).toBe(P.units_mint);
  expect(prof.programs.registry).toBe("3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay");
  const back = JSON.parse(rolledBackProfileJson(next));
  expect(back.mainnet_deployment).toBe("test");
  expect(back.mainnet_deployments).toEqual(a.mainnet_deployments);
});

test("what the verifiers need: 5 burns and 4 bonds at first, less as they register, nothing when done", () => {
  const base = { registerBurn: 200_000_000_000n, minBond: 1_000_000_000_000n, site: P.site.site_verifiers, extra: P.site.extra_verifiers.length };
  expect(verifierNeed({ ...base, registered: { burnOnly: 0, bonded: 0, extra: 0 } })).toEqual({ burns: 5, bonds: 4, units: 5_000_000_000_000n });
  expect(verifierNeed({ ...base, registered: { burnOnly: 1, bonded: 2, extra: 0 } })).toEqual({ burns: 2, bonds: 2, units: 2_400_000_000_000n });
  expect(verifierNeed({ ...base, registered: { burnOnly: 1, bonded: 2, extra: 2 } })).toEqual({ burns: 0, bonds: 0, units: 0n });
  expect(verifierNeed({ ...base, registered: { burnOnly: 1, bonded: 2, extra: 2 }, bondShortfall: 5n }).units).toBe(5n);
});

test("the fee keeper config: creator = the dev wallet, the owner's compute funding address, off until the key is placed", () => {
  const ex = JSON.parse(readFileSync(join(ROOT, "config/fee-keeper.example.json"), "utf8"));
  const c = feeKeeperConfig(ex, P.units_mint, P.admin, P.fee_keeper_compute_address);
  expect(c).toMatchObject({ enabled: false, mint: P.units_mint, creator: P.admin, compute_address: "BBR99DmQbViLg54YHf8ZsS56eZSy5qCeMfCo7WzGtNW9", compute_bps: 5000, burn_bps: 5000 });
  expect(() => feeKeeperConfig(ex, P.units_mint, P.admin, P.admin)).toThrow(/other than the creator/);
  const tracked = JSON.parse(readFileSync(join(ROOT, "config/fee-keeper.official.json"), "utf8"));
  expect(tracked).toMatchObject({ enabled: false, mint: P.units_mint, creator: P.admin, compute_address: P.fee_keeper_compute_address, key_path: null });
});

test("the chain accepts the next epoch post from the anchor: none before the first post, then anchor time plus whole epochs", () => {
  expect(nextPostNotBefore({ epochsPosted: 0n, lastEpoch: 0n, epochAnchor: 0n, epochAnchorTs: 0n, epochLengthS: 300 })).toBeNull();
  expect(nextPostNotBefore({ epochsPosted: 1n, lastEpoch: 7n, epochAnchor: 7n, epochAnchorTs: 1_000n, epochLengthS: 300 })).toBe(1_000);
  expect(nextPostNotBefore({ epochsPosted: 3n, lastEpoch: 9n, epochAnchor: 7n, epochAnchorTs: 1_000n, epochLengthS: 300 })).toBe(1_600);
});

// ---------------------------------------------------------------- the dev wallet's own coins (owner: "ONLY TAKE 5M tokens")
import { ata, pump, PUMP, system, token, TOKEN_2022_PROGRAM } from "@units/chain";
import { assertDevWalletUnits, DEV_WALLET_UNITS_CEILING_WHOLE, devTransferDecision } from "./golive-steps.ts";

const T22 = TOKEN_2022_PROGRAM, DEV = P.admin, OWNER = P.site.verifier_owner, M = P.units_mint;
const G = { devWallet: DEV, devUnitsAccount: ata(DEV, M, T22), mint: M, decimals: 6, destination: ata(OWNER, M, T22) };
const FIVE_M = 5_000_000n * 1_000_000n;
const xfer = (amount: bigint, o: { dest?: string; mint?: string; src?: string; decimals?: number } = {}) => token.transferChecked(o.src ?? G.devUnitsAccount, o.mint ?? M, o.dest ?? G.destination, DEV, amount, o.decimals ?? 6, T22);

test("the ceiling is a constant: 5,000,000 coins", () => {
  expect(DEV_WALLET_UNITS_CEILING_WHOLE).toBe(5_000_000n);
});

test("the one allowed transaction: 5,000,000 coins from the dev wallet to the verifier owner key, with its token account and SOL", () => {
  expect(assertDevWalletUnits([token.createAtaIdempotent(DEV, OWNER, M, T22), xfer(FIVE_M), system.transfer(DEV, OWNER, 50_000_000n)], G)).toBe(FIVE_M);
  // creating the dev wallet's own token account (the compute sink) names the account and debits nothing
  expect(assertDevWalletUnits([token.createAtaIdempotent(DEV, DEV, M, T22)], G)).toBe(0n);
});

test("refused before signing: one base unit over the ceiling, another destination, another mint, wrong decimals, two transfers", () => {
  expect(() => assertDevWalletUnits([xfer(FIVE_M + 1n)], G)).toThrow(/over the ceiling/);
  expect(() => assertDevWalletUnits([xfer(1n, { dest: ata(P.core_authority, M, T22) })], G)).toThrow(/only go to the verifier owner key/);
  expect(() => assertDevWalletUnits([xfer(1n, { mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" })], G)).toThrow(/official mint/);
  expect(() => assertDevWalletUnits([xfer(1n, { decimals: 9 })], G)).toThrow(/decimals/);
  expect(() => assertDevWalletUnits([xfer(2_000_000n * 1_000_000n), xfer(2_000_000n * 1_000_000n)], G)).toThrow(/more than one transfer/);
  expect(() => assertDevWalletUnits([xfer(0n)], G)).toThrow(/over the ceiling|refused/);
});

test("refused before signing: any other instruction that names the dev wallet's coin account, and any pump.fun trade by the dev wallet", () => {
  // a plain Transfer (no mint check), a burn, an approve and a close all name the account with another layout
  for (const tag of [3, 8, 4, 9, 15]) {
    const ix = { programId: T22, keys: [{ pubkey: G.devUnitsAccount, isSigner: false, isWritable: true }, { pubkey: M, isSigner: false, isWritable: true }, { pubkey: DEV, isSigner: true, isWritable: false }], data: Uint8Array.of(tag, 1, 0, 0, 0, 0, 0, 0, 0) };
    expect(() => assertDevWalletUnits([ix], G)).toThrow(/other than the one allowed transfer/);
  }
  // a transfer INTO the dev wallet's account from elsewhere is not the allowed shape either
  expect(() => assertDevWalletUnits([xfer(1n, { src: ata(OWNER, M, T22), dest: G.devUnitsAccount })], G)).toThrow(/does not start from it/);
  expect(() => assertDevWalletUnits([pump.buyV3({ mint: M, quoteMint: PUMP.wsol, user: DEV, amount: 1n, maxQuoteIn: 1n })], G)).toThrow(/never buys or sells/);
  expect(() => assertDevWalletUnits([pump.sellV3({ mint: M, quoteMint: PUMP.wsol, user: DEV, amount: 1n, minQuoteOut: 0n })], G)).toThrow(/never buys or sells/);
});

test("one transfer, ever: the decision from the marker and the chain", () => {
  const mk = { mint: M, amount: FIVE_M.toString(), destination: G.destination, signature: "s", last_valid_block_height: 1, at: "t" };
  const d = (o: Partial<Parameters<typeof devTransferDecision>[0]>) => devTransferDecision({ need: FIVE_M, received: 0n, decimals: 6, marker: null, markerState: "none", ...o });
  expect(d({})).toMatchObject({ action: "send", amount: FIVE_M });
  expect(d({ received: FIVE_M })).toMatchObject({ action: "done", amount: 0n });
  expect(d({ marker: mk, markerState: "pending" })).toMatchObject({ action: "wait", amount: 0n });
  // landed and the owner key still short (the file was changed to ask for more): never a second transfer
  expect(d({ need: FIVE_M + 1n, received: FIVE_M, marker: mk, markerState: "landed" })).toMatchObject({ action: "refuse", amount: 0n });
  expect(d({ marker: mk, markerState: "landed" })).toMatchObject({ action: "refuse", amount: 0n });
  // an attempt whose blockhash expired unlanded can never land: the whole amount may be sent, once
  expect(d({ marker: mk, markerState: "expired" })).toMatchObject({ action: "send", amount: FIVE_M });
  // coins that arrived by another path, or a need above the ceiling: nothing is sent
  expect(d({ received: 1n })).toMatchObject({ action: "refuse" });
  expect(d({ need: FIVE_M + 1n })).toMatchObject({ action: "refuse" });
});
