// The OFFICIAL go-live's pure pieces (docs/MAINNET-RUNBOOK.md "Go-live (single key, today)"): reading
// scripts/mainnet/official-params.json, turning its values into the on-chain arguments at a price,
// what the verifiers need, and the files the site switch writes. Shared by the operator CLI
// (golive.ts), its tests and the fork proof (golive-fork.ts), so the commands the owner runs are the
// code the fork proved. Nothing here sends, signs or prints a key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProgramIds } from "@units/chain";

const ROOT = join(import.meta.dir, "..", "..");
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEC = /^\d+(\.\d+)?$/;

export interface OfficialParams {
  owner_confirmed: boolean;
  admin: string;
  core_authority: string;
  runtime_authority: string;
  units_mint: string;
  line_decimals: number;
  line_token_program: string;
  fee_split: { agent_compute_bps: number; protocol_bps: number };
  site: {
    host: string;
    app_url: string;
    docs_url: string;
    verifier_owner: string;
    site_verifiers: { burn_only: number; burn_and_bond: number };
    extra_verifiers: { agent: string; cosign_host: string; cosign_key: string }[];
    extra_capabilities_digest: string;
    sizing: Record<string, number>;
  };
  owner_decision: {
    register_burn_units: string;
    min_bond_units: string;
    bond_cap_units: string;
    rebate_per_class_units: string;
    max_rebate_per_epoch_units: string;
    unbond_cooldown_s: number;
    onchain_epoch_length_s: number;
    /** Core's own epoch: how often accepted work is posted on chain and paid (not the registry's minimum spacing above) */
    core_epoch_length_s: number;
    /** the Core authority hot key pays every post: `status` warns below this many days of posts */
    core_authority_low_days: number;
    /** `pre` tops the Core authority hot key up to this many SOL from the dev wallet */
    core_authority_target_sol: string;
    max_slash_bps_per_epoch: number;
    canary_slash_bps: number;
    minority_slash_bps: number;
    reveal_slash_bps: number;
    strike_limit: number;
    reserve_bps: number;
    pool_bps: number;
    challenge: { windowS: number; bond_units: string; reward_units: string; resolveTimeoutS: number; paused: boolean };
    bounty: { maxBountyOutBps: number; selfHostedInCap_units: string; windowS: number; minTtlS: number; maxTtlS: number; refundGraceS: number; minAmount_units: string; paused: boolean };
    msg: { paused: boolean; windowS: number; maxPerWindow: number; maxPerDay: number; maxInline: number; maxBlob: number };
    sleep_threshold_usd: string;
    wake_threshold_usd: string;
    max_debit_per_epoch_usd: string;
    pump_creator_fee_bps: string;
    credits_min_usd: string;
    sandbox_usd_per_s: string;
    price_band: { min_usd: number; max_usd: number; max_age_s: number; refresh_s: number };
    credits_rate_tolerance_bps: number;
    credits_rate_window_s: number;
    guard_max_regression: number;
    identity_account_price_lamports: string;
  };
  bond: { slippage_bps: number; owner_sol: string };
  /** where the $UNITS fee keeper sends the compute share; a wallet other than the creator */
  fee_keeper_compute_address: string | null;
}

/** Reads and checks the official parameter file. Throws with every problem named at once. */
export function loadOfficialParams(path: string): OfficialParams {
  return checkOfficialParams(JSON.parse(readFileSync(path, "utf8")));
}

export function checkOfficialParams(raw: unknown): OfficialParams {
  const p = raw as OfficialParams;
  const bad: string[] = [];
  const addr = (k: string, v: unknown) => { if (typeof v !== "string" || !ADDR.test(v)) bad.push(`${k} is not a base58 address`); };
  const dec = (k: string, v: unknown) => { if (typeof v !== "string" || !DEC.test(v) || Number(v) <= 0) bad.push(`${k} is not a positive decimal string`); };
  const whole = (k: string, v: unknown) => { if (typeof v !== "string" || !/^\d+$/.test(v) || BigInt(v) <= 0n) bad.push(`${k} is not a positive whole number of $UNITS as a string`); };
  const int = (k: string, v: unknown, lo: number, hi: number) => { if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) bad.push(`${k} must be a whole number from ${lo} to ${hi}`); };
  if (JSON.stringify(raw).includes('"TBA"')) bad.push("a value is still TBA");
  for (const k of ["admin", "core_authority", "runtime_authority", "units_mint", "line_token_program"] as const) addr(k, p?.[k]);
  if (p?.line_decimals !== 6) bad.push("line_decimals must be 6 (a pump.fun coin)");
  const f = p?.fee_split;
  if (!f || !Number.isInteger(f.agent_compute_bps) || !Number.isInteger(f.protocol_bps) || f.agent_compute_bps + f.protocol_bps !== 10_000) bad.push("fee_split must sum to 10000 bps");
  const s = p?.site;
  addr("site.verifier_owner", s?.verifier_owner);
  for (const [i, e] of (s?.extra_verifiers ?? []).entries()) addr(`site.extra_verifiers[${i}].agent`, e?.agent);
  if (new Set((s?.extra_verifiers ?? []).map((e) => e.agent)).size !== (s?.extra_verifiers ?? []).length) bad.push("site.extra_verifiers names an agent twice");
  if ((s?.extra_verifiers ?? []).length && !/^[0-9a-f]{64}$/.test(s?.extra_capabilities_digest ?? "")) bad.push("site.extra_capabilities_digest must be 64 hex characters");
  int("site.site_verifiers.burn_only", s?.site_verifiers?.burn_only, 0, 16);
  int("site.site_verifiers.burn_and_bond", s?.site_verifiers?.burn_and_bond, 0, 16);
  const o = p?.owner_decision;
  if (!o) bad.push("owner_decision is missing");
  else {
    for (const k of ["register_burn_units", "min_bond_units", "bond_cap_units", "rebate_per_class_units", "max_rebate_per_epoch_units"] as const) whole(k, o[k]);
    whole("challenge.bond_units", o.challenge?.bond_units);
    whole("challenge.reward_units", o.challenge?.reward_units);
    whole("bounty.selfHostedInCap_units", o.bounty?.selfHostedInCap_units);
    whole("bounty.minAmount_units", o.bounty?.minAmount_units);
    for (const k of ["sleep_threshold_usd", "wake_threshold_usd", "max_debit_per_epoch_usd", "credits_min_usd", "sandbox_usd_per_s"] as const) dec(k, o[k]);
    int("onchain_epoch_length_s", o.onchain_epoch_length_s, 1, 86_400 * 30);
    int("unbond_cooldown_s", o.unbond_cooldown_s, 1, 86_400 * 365);
    int("core_epoch_length_s", o.core_epoch_length_s, 300, 86_400 * 7);
    int("core_authority_low_days", o.core_authority_low_days, 1, 365);
    dec("core_authority_target_sol", o.core_authority_target_sol);
    if (DEC.test(`${o.core_authority_target_sol}`) && Number(o.core_authority_target_sol) > 5) bad.push("core_authority_target_sol is above 5 SOL: a hot key should not hold that much");
    if (Number.isInteger(o.core_epoch_length_s) && Number.isInteger(o.onchain_epoch_length_s) && o.core_epoch_length_s < o.onchain_epoch_length_s) bad.push("core_epoch_length_s is below onchain_epoch_length_s (the registry would refuse posts as too early)");
    if (Number.isInteger(o.onchain_epoch_length_s) && Number.isInteger(o.unbond_cooldown_s) && o.unbond_cooldown_s < 2 * o.onchain_epoch_length_s) bad.push("unbond_cooldown_s must be at least 2 x onchain_epoch_length_s (the registry refuses less)");
    for (const k of ["canary_slash_bps", "minority_slash_bps", "reveal_slash_bps", "max_slash_bps_per_epoch", "reserve_bps", "pool_bps"] as const) int(k, o[k], 0, 10_000);
    if (o.reserve_bps + o.pool_bps !== 10_000) bad.push("reserve_bps + pool_bps must be 10000");
    if (o.max_slash_bps_per_epoch < Math.max(o.canary_slash_bps, o.minority_slash_bps, o.reveal_slash_bps)) bad.push("max_slash_bps_per_epoch must be at least every single slash share");
    if (typeof o.min_bond_units === "string" && typeof o.bond_cap_units === "string" && /^\d+$/.test(o.min_bond_units + o.bond_cap_units) && BigInt(o.bond_cap_units) < BigInt(o.min_bond_units)) bad.push("bond_cap_units is below min_bond_units");
    if (/^\d+$/.test(`${o.challenge?.reward_units}${o.max_rebate_per_epoch_units}`) && BigInt(o.challenge.reward_units) > BigInt(o.max_rebate_per_epoch_units)) bad.push("challenge.reward_units is above max_rebate_per_epoch_units (an upheld challenge could never be paid)");
    if (DEC.test(`${o.sleep_threshold_usd}`) && DEC.test(`${o.wake_threshold_usd}`) && Number(o.wake_threshold_usd) < Number(o.sleep_threshold_usd)) bad.push("wake_threshold_usd is below sleep_threshold_usd");
    if (typeof o.pump_creator_fee_bps !== "string" || !/^\d+n$/.test(o.pump_creator_fee_bps)) bad.push('pump_creator_fee_bps is a string such as "0n"');
    const b = o.price_band;
    if (!b || !(b.min_usd > 0 && b.max_usd > b.min_usd) || !Number.isInteger(b.max_age_s) || b.max_age_s < 30 || !Number.isInteger(b.refresh_s) || b.refresh_s < 5) bad.push("price_band needs 0 < min_usd < max_usd, max_age_s >= 30 and refresh_s >= 5");
    int("credits_rate_tolerance_bps", o.credits_rate_tolerance_bps, 0, 5_000);
    int("credits_rate_window_s", o.credits_rate_window_s, 30, 3_600);
    if (typeof o.identity_account_price_lamports !== "string" || !/^\d+$/.test(o.identity_account_price_lamports)) bad.push("identity_account_price_lamports is a whole number of lamports as a string");
  }
  if (p?.fee_keeper_compute_address != null) { addr("fee_keeper_compute_address", p.fee_keeper_compute_address); if (p.fee_keeper_compute_address === p.admin) bad.push("fee_keeper_compute_address must differ from the creator (the dev wallet)"); }
  int("bond.slippage_bps", p?.bond?.slippage_bps, 0, 2_000);
  dec("bond.owner_sol", p?.bond?.owner_sol);
  if (bad.length) throw new Error(`official-params.json: ${bad.join("; ")}`);
  return p;
}

/** The price a resolution used: US dollars per whole $UNITS, and where it came from. */
export interface UnitsPrice {
  usd_per_units: number;
  sol_usd: number;
  sol_per_units: number;
  venue: "curve" | "pool";
  read_at: string;
}

/** Whole $UNITS for a dollar amount at `usd_per_units`, rounded to three significant digits (at least 1). */
export function usdToUnits(usd: string, usdPerUnits: number): bigint {
  if (!DEC.test(usd)) throw new Error(`${usd} is not a dollar amount`);
  if (!(usdPerUnits > 0) || !Number.isFinite(usdPerUnits)) throw new Error("no positive $UNITS price");
  const x = Number(usd) / usdPerUnits;
  if (!Number.isFinite(x) || x <= 0) throw new Error(`${usd} USD is not a positive $UNITS amount at this price`);
  if (x < 1) return 1n;
  const mag = 10 ** (Math.floor(Math.log10(x)) - 2);
  const r = Math.round(x / mag) * mag;
  return BigInt(Math.round(r));
}

/** A decimal string of whole tokens per dollar at `usd_per_units` (three significant digits), for Core's prepay block. */
export const unitsPerUsd = (usdPerUnits: number): string => usdToUnits("1", usdPerUnits).toString();

export interface Resolved {
  mint: string;
  price: UnitsPrice;
  /** the file parseLaunchParams reads (scripts/mainnet/steps.ts): u64 amounts as "<n>n" strings in base units */
  launch_params: Record<string, unknown>;
  /** config/network.json with the official on-chain values in base units of the mint (token_decimals = line_decimals) */
  network: Record<string, unknown>;
  /** what each dollar value became, for the owner's review */
  resolved_usd: { key: string; usd: string; units: string }[];
}

/**
 * The official values as the on-chain arguments: token amounts from the file, dollar amounts at
 * `price`. `mint` is a parameter: nothing else in the result depends on which coin it is.
 * `networkFile` is where the caller will write `network` (parseLaunchParams reads it from disk).
 */
export function resolveOfficial(p: OfficialParams, mint: string, price: UnitsPrice, networkFile: string, baseNetwork?: Record<string, unknown>): Resolved {
  if (!ADDR.test(mint)) throw new Error("the mint is not a base58 address");
  const o = p.owner_decision;
  const one = 10n ** BigInt(p.line_decimals);
  const base = (units: string | bigint) => (BigInt(units) * one).toString();
  const n = (units: string | bigint) => `${base(units)}n`;
  const usd = (key: string, v: string) => {
    const units = usdToUnits(v, price.usd_per_units);
    resolved_usd.push({ key, usd: v, units: units.toString() });
    return units;
  };
  const resolved_usd: Resolved["resolved_usd"] = [];
  const sleep = usd("sleep_threshold_usd", o.sleep_threshold_usd), wake = usd("wake_threshold_usd", o.wake_threshold_usd), debit = usd("max_debit_per_epoch_usd", o.max_debit_per_epoch_usd);
  const net = baseNetwork ?? (JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8")) as Record<string, unknown>);
  const network = {
    ...net,
    _note: "OFFICIAL on-chain values, written by scripts/mainnet/golive.ts from scripts/mainnet/official-params.json. Amounts are base units of $UNITS (token_decimals 6).",
    token_decimals: p.line_decimals,
    register_burn: base(o.register_burn_units), min_bond: base(o.min_bond_units), bond_cap: base(o.bond_cap_units), rebate_per_class: base(o.rebate_per_class_units),
    unbond_cooldown_s: o.unbond_cooldown_s, reserve_bps: o.reserve_bps, pool_bps: o.pool_bps,
    canary_slash_bps: o.canary_slash_bps, minority_slash_bps: o.minority_slash_bps, reveal_slash_bps: o.reveal_slash_bps, strike_limit: o.strike_limit,
    agent_compute_bps: p.fee_split.agent_compute_bps, protocol_bps: p.fee_split.protocol_bps,
    sleep_threshold: base(sleep), wake_threshold: base(wake), guard_max_regression: o.guard_max_regression,
  };
  const launch_params = {
    core_authority: p.core_authority, runtime_authority: p.runtime_authority, line_mint: mint, line_decimals: p.line_decimals, line_token_program: p.line_token_program,
    network_file: networkFile, onchain_epoch_length_s: o.onchain_epoch_length_s,
    max_rebate_per_epoch: n(o.max_rebate_per_epoch_units), max_debit_per_epoch: n(debit), pump_creator_fee_bps: o.pump_creator_fee_bps,
    msg: o.msg,
    bounty: { maxBountyOutBps: o.bounty.maxBountyOutBps, selfHostedInCap: n(o.bounty.selfHostedInCap_units), windowS: o.bounty.windowS, minTtlS: o.bounty.minTtlS, maxTtlS: o.bounty.maxTtlS,
      refundGraceS: o.bounty.refundGraceS, minAmount: n(o.bounty.minAmount_units), paused: o.bounty.paused },
    challenge: { windowS: o.challenge.windowS, bond: n(o.challenge.bond_units), reward: n(o.challenge.reward_units), resolveTimeoutS: o.challenge.resolveTimeoutS, paused: o.challenge.paused },
  };
  return { mint, price, launch_params, network, resolved_usd };
}

/** What the verifiers still need from the owner key, given what the chain already holds. */
export interface VerifierNeed {
  burns: number;
  bonds: number;
  /** base units of $UNITS the owner key must hold to finish */
  units: bigint;
}
export function verifierNeed(a: { registerBurn: bigint; minBond: bigint; site: { burn_only: number; burn_and_bond: number }; extra: number; registered: { burnOnly: number; bonded: number; extra: number }; bondShortfall?: bigint }): VerifierNeed {
  const burns = Math.max(0, a.site.burn_only - a.registered.burnOnly) + Math.max(0, a.site.burn_and_bond - a.registered.bonded) + Math.max(0, a.extra - a.registered.extra);
  const bonds = Math.max(0, a.site.burn_and_bond - a.registered.bonded) + Math.max(0, a.extra - a.registered.extra);
  return { burns, bonds, units: BigInt(burns) * a.registerBurn + BigInt(bonds) * a.minBond + (a.bondShortfall ?? 0n) };
}

export interface ChainFacts {
  mint: string;
  line_token_program: string;
  line_decimals: number;
  admin: string;
  core_authority: string;
  runtime_authority: string;
  launch_lookup_table: string;
  compute_sink: string;
  agent_compute_bps: number;
  protocol_bps: number;
}

/**
 * The instance's chain state file for the official deployment (/etc/units-main/state.json): the chain
 * facts, Core's prepay overrides at the live price, and the hosted runtime's price source. With
 * `identity` the units account is offered (recipient = the admin wallet); without it the recipient is
 * null and the wizard hides the option, as on the test deployment.
 */
export function officialState(p: OfficialParams, ids: ProgramIds, c: ChainFacts, price: UnitsPrice, o: { identity: boolean; indexerPort: number }) {
  const perUsd = unitsPerUsd(price.usd_per_units);
  const perSandboxS = trimDec((Number(perUsd) * Number(p.owner_decision.sandbox_usd_per_s)).toFixed(6));
  return {
    mode: "mainnet", test: false,
    deployment: "official (single key: the dev wallet is admin and upgrade authority; $UNITS is the quote)",
    registry_program: ids.registry, launch_program: ids.launch, msg_program: ids.msg,
    line_mint: c.mint, line_token_program: c.line_token_program, line_decimals: c.line_decimals, line_venue: "pump.fun",
    admin: c.admin, core_authority: c.core_authority, runtime_authority: c.runtime_authority,
    launch_lookup_table: c.launch_lookup_table, compute_sink: c.compute_sink, agent_compute_bps: c.agent_compute_bps, protocol_bps: c.protocol_bps,
    price_at_switch: price,
    // scripts/deploy/site-config.ts: Core's own epoch on this instance
    core_epoch_length_s: p.owner_decision.core_epoch_length_s,
    network_overrides: {
      guard_max_regression: p.owner_decision.guard_max_regression,
      prepay: {
        _note: "Official deployment. rate_source market: the launch deposit is min_usd at the coin's live market price at the moment of the launch. line_per_usd is the price read when `golive.ts switch` ran, used only where a static figure is still needed (the runtime's published price check). The hosted runtime bills at the same live reading (runtime_price below).",
        min_usd: p.owner_decision.credits_min_usd, default_usd: p.owner_decision.credits_min_usd,
        line_per_usd: perUsd, rate_status: "live",
        // the launch deposit follows the coin's live market price (packages/chain prepay.ts rate_source market): the same reading as
        // GET /market/quote-usd, refused when stale or outside the band, accepted by Core within the tolerance around the transaction's time
        rate_source: "market", rate_max_age_s: p.owner_decision.price_band.max_age_s, rate_min_usd: p.owner_decision.price_band.min_usd, rate_max_usd: p.owner_decision.price_band.max_usd,
        rate_tolerance_bps: p.owner_decision.credits_rate_tolerance_bps, rate_window_s: p.owner_decision.credits_rate_window_s,
        compute_price_line_per_usd: perUsd, compute_price_line_per_sandbox_s: perSandboxS,
        identity_account_price_lamports: p.owner_decision.identity_account_price_lamports,
        identity_account_recipient: o.identity ? c.admin : null,
      },
    },
    // scripts/deploy/site-config.ts copies this into the hosted runtime's config: the instance's own market indexer in
    // Jupiter's shape (packages/indexer api.ts /market/price/v3), so billing uses the number every page shows
    runtime_price: { source: "jupiter", api: `http://127.0.0.1:${o.indexerPort}/market/price/v3`, min_usd: p.owner_decision.price_band.min_usd, max_usd: p.owner_decision.price_band.max_usd,
      max_age_s: p.owner_decision.price_band.max_age_s, refresh_s: p.owner_decision.price_band.refresh_s },
  };
}
const trimDec = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s) || "0";

/** The quote block of the official deployment: the real coin, live. */
export const officialQuote = (c: { mint: string; line_decimals: number; line_token_program: string }) => ({
  source: "config", symbol: "UNITS", display: "UNITS", mint: c.mint, decimals: c.line_decimals, token_program: c.line_token_program,
  status: "live", units_mint: c.mint, units_mint_status: "live",
});

/** The instance's profile overlay (UNITS_PROFILE_LOCAL): the only overlay a server instance reads. */
export function officialOverlay(ids: ProgramIds, c: { mint: string; line_decimals: number; line_token_program: string }, extra: Record<string, unknown> = {}) {
  return {
    _note: "Profile overlay of the OFFICIAL mainnet deployment for the site instance (UNITS_PROFILE_LOCAL), written by scripts/mainnet/golive.ts switch. $UNITS is a pump.fun coin: SOL is turned into it on its own market, not through Jupiter (swap false), exactly as the test deployment did.",
    profiles: { mainnet: { quote: officialQuote(c), swap: false, programs: { registry: ids.registry, launch: ids.launch, msg: ids.msg }, ...extra } },
  };
}

/**
 * config/profile.json moved to the official deployment: `mainnet_deployment` official, the quote
 * block with the real mint, swap off (a pump.fun quote), the tracked public state file. Returns the
 * new text; every other byte of the file is kept.
 */
export function switchedProfileJson(text: string, c: { mint: string; line_decimals: number; line_token_program: string }, stateFile: string): string {
  const j = JSON.parse(text);
  if (!j?.profiles?.mainnet || !("mainnet_deployment" in j)) throw new Error("config/profile.json: no mainnet profile or no mainnet_deployment");
  j.mainnet_deployment = "official";
  j.profiles.mainnet.quote = officialQuote(c);
  j.profiles.mainnet.swap = false;
  j.profiles.mainnet.state_file = stateFile;
  return JSON.stringify(j, null, 2) + "\n";
}

/** The same file moved back to the test deployment (the rollback): only `mainnet_deployment` changes. */
export function rolledBackProfileJson(text: string): string {
  const j = JSON.parse(text);
  j.mainnet_deployment = "test";
  return JSON.stringify(j, null, 2) + "\n";
}

/** config/fee-keeper.official.json for a mint: creator = the dev wallet; the compute funding address is the owner's (official-params.json fee_keeper_compute_address). */
export function feeKeeperConfig(example: Record<string, unknown>, mint: string, creator: string, computeAddress: string | null): Record<string, unknown> {
  if (computeAddress !== null && (!ADDR.test(computeAddress) || computeAddress === creator)) throw new Error("the fee keeper's compute address must be a wallet other than the creator");
  return { ...example, enabled: false, mint, creator, compute_address: computeAddress };
}

/** The next time Core may post on chain: epoch `anchor + k` (k >= 2) not before `anchor_ts + (k - 1) x length` (units_registry post_epoch). */
export function nextPostNotBefore(c: { epochsPosted: bigint; lastEpoch: bigint; epochAnchor: bigint | null; epochAnchorTs: bigint | null; epochLengthS: number }): number | null {
  if (c.epochsPosted === 0n || c.epochAnchor === null || c.epochAnchorTs === null) return null;
  const next = c.lastEpoch + 1n;
  const ahead = next - c.epochAnchor;
  return Number(c.epochAnchorTs + (ahead - 1n > 0n ? ahead - 1n : 0n) * BigInt(c.epochLengthS));
}

// ---------------------------------------------------------------- the dev wallet's own $UNITS (owner 2026-10-12)
// "the dev wallet will have 3% so 30m tokens. ONLY TAKE 5M tokens." The go-live tooling may move exactly
// one transfer of at most 5,000,000 $UNITS out of the dev wallet, to the site's verifier owner key, and
// nothing else of its $UNITS, ever. It never buys or sells $UNITS. The ceiling is a constant of the code,
// not a parameter, and it is checked on the instructions of every transaction before anything is signed.

/** The most whole $UNITS the go-live tooling may ever take from the dev wallet. A constant, on purpose. */
export const DEV_WALLET_UNITS_CEILING_WHOLE = 5_000_000n;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const PUMP_PROGRAMS = new Set(["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"]);

export interface GuardIx { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array }
export interface DevUnitsGuard {
  devWallet: string;
  /** the dev wallet's $UNITS token account */
  devUnitsAccount: string;
  mint: string;
  decimals: number;
  /** the verifier owner key's $UNITS token account: the only destination allowed */
  destination: string;
}

/**
 * Checks the instructions of one transaction against the owner's rule and returns the base units of
 * $UNITS it moves out of the dev wallet (0 for most transactions). Throws, before anything is signed,
 * when the transaction: names the dev wallet's $UNITS account in any instruction other than creating
 * it (idempotent) or ONE TransferChecked from it; transfers to another destination, another mint, a
 * wrong decimals value or more than the ceiling; or calls pump.fun (Pump or PumpSwap) with the dev
 * wallet as a signer (a buy or a sell).
 */
export function assertDevWalletUnits(ixs: GuardIx[], g: DevUnitsGuard): bigint {
  const ceiling = DEV_WALLET_UNITS_CEILING_WHOLE * 10n ** BigInt(g.decimals);
  let moved = 0n, transfers = 0;
  for (const ix of ixs) {
    if (PUMP_PROGRAMS.has(ix.programId) && ix.keys.some((k) => k.pubkey === g.devWallet && k.isSigner)) throw new Error("refused: the dev wallet never buys or sells on pump.fun in the go-live tooling");
    if (!ix.keys.some((k) => k.pubkey === g.devUnitsAccount)) continue;
    if (ix.programId === ATA_PROGRAM && ix.data.length === 1 && ix.data[0] === 1 && ix.keys[1]?.pubkey === g.devUnitsAccount) continue; // create idempotent: no debit
    const isTransfer = TOKEN_PROGRAMS.has(ix.programId) && ix.data.length === 10 && ix.data[0] === 12 && ix.keys.length === 4;
    if (!isTransfer) throw new Error("refused: an instruction other than the one allowed transfer names the dev wallet's $UNITS account");
    const [src, mint, dst, auth] = ix.keys.map((k) => k.pubkey);
    const amount = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(1, true);
    if (src !== g.devUnitsAccount) throw new Error("refused: the dev wallet's $UNITS account is named by a transfer that does not start from it");
    if (mint !== g.mint) throw new Error("refused: the transfer is not of the official mint");
    if (dst !== g.destination) throw new Error("refused: the dev wallet's $UNITS may only go to the verifier owner key's token account");
    if (auth !== g.devWallet) throw new Error("refused: the transfer is not signed by the dev wallet");
    if (ix.data[9] !== g.decimals) throw new Error("refused: the transfer names the wrong decimals");
    if (amount <= 0n || amount > ceiling) throw new Error(`refused: the transfer of ${amount} base units is over the ceiling of ${ceiling} (5,000,000 $UNITS), which is a constant of the code`);
    if (++transfers > 1) throw new Error("refused: more than one transfer from the dev wallet's $UNITS account in one transaction");
    moved += amount;
  }
  return moved;
}

/** What the marker file holds: the one transfer, written before it is sent. */
export interface DevTransferMarker { mint: string; amount: string; destination: string; signature: string; last_valid_block_height: number; at: string; confirmed?: boolean }

/**
 * Whether the one transfer may be built now. `received` is everything the verifier owner key ever got
 * for its verifiers (its balance plus what its verifiers burned and bonded); `markerState` what the
 * chain says about the marker's signature. Never a second transfer: only "send" allows building one.
 */
export function devTransferDecision(a: { need: bigint; received: bigint; decimals: number; marker: DevTransferMarker | null; markerState: "none" | "landed" | "pending" | "expired" }): { action: "send" | "done" | "wait" | "refuse"; why: string; amount: bigint } {
  const ceiling = DEV_WALLET_UNITS_CEILING_WHOLE * 10n ** BigInt(a.decimals);
  if (a.received >= a.need) return { action: "done", why: "the verifier owner key already received the coins", amount: 0n };
  if (a.marker && a.markerState === "landed") return { action: "refuse", why: "the one transfer landed and the verifier owner key still lacks coins: the tooling never sends a second one; look by hand", amount: 0n };
  if (a.marker && a.markerState === "pending") return { action: "wait", why: "the one transfer was sent and is not confirmed or expired yet", amount: 0n };
  if (a.received > 0n) return { action: "refuse", why: "the verifier owner key received part of the coins by another path: the tooling sends the whole amount once or nothing; look by hand", amount: 0n };
  if (a.need > ceiling) return { action: "refuse", why: `the verifiers need ${a.need} base units, over the ceiling of 5,000,000 $UNITS the owner allows from the dev wallet`, amount: 0n };
  return { action: "send", why: a.marker ? "the earlier attempt expired without landing (its signature can no longer land)" : "nothing was sent yet", amount: a.need };
}
