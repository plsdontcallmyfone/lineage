import type { Address } from "./codec.ts";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda.ts";
import type { Ix } from "./registry.ts";
import { compileMessageV0, wireSize, type LookupTable } from "./v0.ts";

// Pay in SOL or USDC wherever the app needs $LINE (mainnet only): a Jupiter quote with raw swap
// instructions, then the app's own action (launch deposit, trading allocation, a trade-box buy) in
// the same transaction. Browser-safe: no node imports, fetch is injectable.
//
// Jupiter Swap API V2, Router path (read 2026-10-10 at https://developers.jup.ag/docs/swap/build and
// the OpenAPI spec https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml):
//   GET https://api.jup.ag/swap/v2/build?inputMint&outputMint&amount&taker&slippageBps[&maxAccounts]
//   header x-api-key (optional: keyless access is 0.5 requests per second)
// It answers a quote (inAmount, outAmount, otherAmountThreshold = minimum out after slippage,
// priceImpactPct as a decimal ratio, routePlan) plus computeBudgetInstructions (the unit price only),
// setupInstructions, swapInstruction, cleanupInstruction, otherInstructions and
// addressesByLookupTableAddress for a v0 message. /build is ExactIn only, so an exact $LINE amount is
// reached by sizing the input from a probe quote and requiring otherAmountThreshold >= the need: the
// swap instruction itself fails below that, so the action never runs short.
// Jupiter does not run on devnet: there the option is unavailable and devnet uses tLINE directly.

export const JUPITER_SWAP_API = "https://api.jup.ag/swap/v2";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const MAX_COMPUTE_UNITS = 1_400_000;
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const SWAP_PACKET_LIMIT = 1232;

export type PayAsset = "LINE" | "SOL" | "USDC";
export const PAY_ASSETS: Record<Exclude<PayAsset, "LINE">, { mint: Address; decimals: number }> = {
  SOL: { mint: WSOL_MINT, decimals: 9 },
  USDC: { mint: USDC_MINT, decimals: 6 },
};

/** The `swap` block of the network config. Every limit is configuration. */
export interface SwapConfig {
  /** "mainnet" enables Jupiter; anything else shows the option as unavailable */
  cluster: string;
  /** the $LINE mint (a stand-in until $LINE exists on mainnet) */
  target_mint: Address;
  target_decimals: number;
  target_token_program: Address;
  /** shown next to amounts; "LINE" once real */
  target_symbol: string;
  /** "stand-in" until $LINE exists on mainnet and the owner sets the real mint */
  target_status: "stand-in" | "live";
  api_base: string;
  /** default and ceiling for the slippage tolerance, bps */
  slippage_bps: number;
  max_slippage_bps: number;
  /** refuse a quote whose price impact is above this, percent (decimal string) */
  max_price_impact_pct: string;
  /** clamp Jupiter's compute unit price to this, micro-lamports */
  max_cu_price_micro_lamports: number;
}

export function parseSwapConfig(raw: unknown): SwapConfig {
  if (!raw || typeof raw !== "object") throw new Error("swap config: object expected");
  const r = raw as Record<string, unknown>;
  for (const k of ["cluster", "target_mint", "target_token_program", "target_symbol", "api_base", "max_price_impact_pct"])
    if (typeof r[k] !== "string" || !r[k]) throw new Error(`swap config: ${k} must be a string`);
  for (const k of ["target_decimals", "slippage_bps", "max_slippage_bps", "max_cu_price_micro_lamports"])
    if (typeof r[k] !== "number" || !Number.isInteger(r[k]) || (r[k] as number) < 0) throw new Error(`swap config: ${k} must be a non-negative integer`);
  const c = r as unknown as SwapConfig;
  if (c.target_token_program !== TOKEN_PROGRAM && c.target_token_program !== TOKEN_2022_PROGRAM) throw new Error("swap config: target_token_program is SPL Token or Token-2022");
  if (c.max_slippage_bps > 5000 || c.slippage_bps > c.max_slippage_bps) throw new Error("swap config: slippage_bps <= max_slippage_bps <= 5000");
  if (!/^\d+(\.\d+)?$/.test(c.max_price_impact_pct)) throw new Error("swap config: max_price_impact_pct is a decimal string");
  if (c.target_status !== "stand-in" && c.target_status !== "live") throw new Error('swap config: target_status is "stand-in" or "live"');
  if (!/^https:\/\//.test(c.api_base)) throw new Error("swap config: api_base must be https");
  return { cluster: c.cluster, target_mint: c.target_mint, target_decimals: c.target_decimals, target_token_program: c.target_token_program,
    target_symbol: c.target_symbol, target_status: c.target_status, api_base: c.api_base.replace(/\/+$/, ""), slippage_bps: c.slippage_bps, max_slippage_bps: c.max_slippage_bps,
    max_price_impact_pct: c.max_price_impact_pct, max_cu_price_micro_lamports: c.max_cu_price_micro_lamports };
}

/** Whether paying in SOL or USDC can work here, and why not. */
export function swapAvailability(c: SwapConfig | null, cluster: string): { ok: true } | { ok: false; reason: string } {
  if (!c) return { ok: false, reason: "no swap config on this network" };
  if (cluster !== "mainnet" && cluster !== "mainnet-beta") return { ok: false, reason: `Jupiter runs on mainnet only; this is ${cluster}, which uses ${c.target_symbol} directly` };
  if (c.cluster !== "mainnet") return { ok: false, reason: "the swap config is not set for mainnet" };
  return { ok: true };
}

// ---------- Jupiter /build ----------

export interface JupIx {
  programId: Address;
  accounts: { pubkey: Address; isSigner: boolean; isWritable: boolean }[];
  data: string;
}
export interface JupRouteStep {
  percent: number;
  bps?: number;
  swapInfo: { ammKey: Address; label: string; inputMint: Address; outputMint: Address; inAmount: string; outAmount: string };
}
export interface JupBuild {
  inputMint: Address;
  outputMint: Address;
  inAmount: bigint;
  outAmount: bigint;
  /** minimum out after slippage: the swap instruction fails below it */
  minOut: bigint;
  swapMode: string;
  slippageBps: number;
  /** percent (the API's ratio times 100) */
  priceImpactPct: number;
  routePlan: JupRouteStep[];
  computeBudgetInstructions: JupIx[];
  setupInstructions: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction: JupIx | null;
  otherInstructions: JupIx[];
  tables: LookupTable[];
  lastValidBlockHeight: number | null;
}

const isIx = (x: unknown): x is JupIx =>
  !!x && typeof x === "object" && typeof (x as JupIx).programId === "string" && typeof (x as JupIx).data === "string" && Array.isArray((x as JupIx).accounts) &&
  (x as JupIx).accounts.every((a) => a && typeof a.pubkey === "string" && typeof a.isSigner === "boolean" && typeof a.isWritable === "boolean");
const int = (s: unknown, k: string): bigint => {
  if (typeof s !== "string" || !/^\d+$/.test(s)) throw new Error(`jupiter /build: ${k} is not an integer string`);
  return BigInt(s);
};

/** Validates a /build response body into typed amounts and instructions. */
export function parseBuild(raw: unknown): JupBuild {
  if (!raw || typeof raw !== "object") throw new Error("jupiter /build: object expected");
  const r = raw as Record<string, unknown>;
  if (typeof r.error === "string") throw new Error(`jupiter /build: ${r.error}`);
  if (!isIx(r.swapInstruction)) throw new Error("jupiter /build: no swapInstruction");
  const list = (k: string): JupIx[] => {
    const v = r[k] ?? [];
    if (!Array.isArray(v) || !v.every(isIx)) throw new Error(`jupiter /build: ${k} malformed`);
    return v;
  };
  if (r.cleanupInstruction != null && !isIx(r.cleanupInstruction)) throw new Error("jupiter /build: cleanupInstruction malformed");
  if (r.transactionVersion !== undefined && Number(r.transactionVersion) !== 0) throw new Error("jupiter /build: expected v0 instructions");
  const alts = (r.addressesByLookupTableAddress ?? {}) as Record<string, unknown>;
  const tables: LookupTable[] = Object.entries(alts).map(([address, addresses]) => {
    if (!Array.isArray(addresses) || !addresses.every((a) => typeof a === "string")) throw new Error("jupiter /build: lookup table malformed");
    return { address, addresses: addresses as string[] };
  });
  const routePlan = (r.routePlan ?? []) as JupRouteStep[];
  if (!Array.isArray(routePlan) || routePlan.some((s) => !s?.swapInfo || typeof s.swapInfo.label !== "string")) throw new Error("jupiter /build: routePlan malformed");
  const impact = Number(r.priceImpactPct ?? "0");
  if (!Number.isFinite(impact)) throw new Error("jupiter /build: priceImpactPct is not a number");
  const bh = r.blockhashWithMetadata as { lastValidBlockHeight?: number } | undefined;
  return {
    inputMint: String(r.inputMint),
    outputMint: String(r.outputMint),
    inAmount: int(r.inAmount, "inAmount"),
    outAmount: int(r.outAmount, "outAmount"),
    minOut: int(r.otherAmountThreshold, "otherAmountThreshold"),
    swapMode: String(r.swapMode ?? "ExactIn"),
    slippageBps: Number(r.slippageBps),
    priceImpactPct: impact * 100,
    routePlan,
    computeBudgetInstructions: list("computeBudgetInstructions"),
    setupInstructions: list("setupInstructions"),
    swapInstruction: r.swapInstruction,
    cleanupInstruction: (r.cleanupInstruction as JupIx | null) ?? null,
    otherInstructions: list("otherInstructions"),
    tables,
    lastValidBlockHeight: typeof bh?.lastValidBlockHeight === "number" ? bh.lastValidBlockHeight : null,
  };
}

export interface BuildParams {
  inputMint: Address;
  outputMint: Address;
  amount: bigint;
  taker: Address;
  slippageBps: number;
  maxAccounts?: number;
}
export function buildUrl(base: string, p: BuildParams): string {
  const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), taker: p.taker, slippageBps: String(p.slippageBps) });
  if (p.maxAccounts !== undefined) q.set("maxAccounts", String(p.maxAccounts));
  return `${base.replace(/\/+$/, "")}/build?${q}`;
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** GET /build; `apiKey` only from a server-side environment (never shipped to a page). */
export async function jupiterBuild(p: BuildParams, o: { base?: string; apiKey?: string; fetch?: Fetch } = {}): Promise<JupBuild> {
  const f = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const res = await f(buildUrl(o.base ?? JUPITER_SWAP_API, p), o.apiKey ? { headers: { "x-api-key": o.apiKey } } : undefined);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 200);
    try {
      msg = (JSON.parse(body) as { error?: string }).error ?? msg;
    } catch {}
    throw new Error(`jupiter /build: HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
  }
  return parseBuild(await res.json());
}

// ---------- instructions ----------

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const jupIx = (ix: JupIx): Ix => ({ programId: ix.programId, keys: ix.accounts.map((a) => ({ ...a })), data: b64(ix.data) });

/** The compute unit price Jupiter set (micro-lamports), or null. */
export function cuPriceOf(b: JupBuild): bigint | null {
  for (const ix of b.computeBudgetInstructions) {
    const d = b64(ix.data);
    if (ix.programId === COMPUTE_BUDGET_PROGRAM_ID && d[0] === 3 && d.length >= 9) return new DataView(d.buffer, d.byteOffset).getBigUint64(1, true);
  }
  return null;
}

/** Compute budget for the composed transaction: a limit, and Jupiter's unit price clamped to `maxPrice`. */
export function budgetFor(b: JupBuild, limit: number, maxPrice: number): Ix[] {
  const lim = new Uint8Array(5);
  lim[0] = 2;
  new DataView(lim.buffer).setUint32(1, Math.min(limit, MAX_COMPUTE_UNITS), true);
  const want = cuPriceOf(b) ?? 0n;
  const price = want > BigInt(maxPrice) ? BigInt(maxPrice) : want;
  const p = new Uint8Array(9);
  p[0] = 3;
  new DataView(p.buffer).setBigUint64(1, price, true);
  return [{ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: lim }, { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: p }];
}

// ---------- quote checks and display ----------

export interface RouteView {
  hops: { label: string; inputMint: Address; outputMint: Address; percent: number }[];
  /** e.g. "Kipseli > Manifest" */
  path: string;
  inAmount: bigint;
  outAmount: bigint;
  minOut: bigint;
  priceImpactPct: number;
  slippageBps: number;
}
export function routeView(b: JupBuild): RouteView {
  const hops = b.routePlan.map((s) => ({ label: s.swapInfo.label, inputMint: s.swapInfo.inputMint, outputMint: s.swapInfo.outputMint, percent: s.percent }));
  return { hops, path: hops.map((h) => (h.percent < 100 ? `${h.label} (${h.percent}%)` : h.label)).join(" > "), inAmount: b.inAmount, outAmount: b.outAmount,
    minOut: b.minOut, priceImpactPct: b.priceImpactPct, slippageBps: b.slippageBps };
}

/** Refuses a quote that is not the asked swap, does not guarantee `need`, or is over the configured limits. */
export function checkQuote(b: JupBuild, o: { inputMint: Address; outputMint: Address; taker: Address; need: bigint; maxSlippageBps: number; maxPriceImpactPct: string }) {
  if (b.inputMint !== o.inputMint || b.outputMint !== o.outputMint) throw new Error(`quote is ${b.inputMint} to ${b.outputMint}, asked ${o.inputMint} to ${o.outputMint}`);
  if (b.swapMode !== "ExactIn") throw new Error(`quote swapMode ${b.swapMode}, expected ExactIn`);
  if (b.slippageBps > o.maxSlippageBps) throw new Error(`slippage ${b.slippageBps} bps is above the ${o.maxSlippageBps} bps limit`);
  if (b.priceImpactPct > Number(o.maxPriceImpactPct)) throw new Error(`price impact ${b.priceImpactPct.toFixed(3)}% is above the ${o.maxPriceImpactPct}% limit`);
  if (b.minOut < o.need) throw new Error(`the quote guarantees ${b.minOut} after slippage, the action needs ${o.need}`);
  if (b.swapInstruction.programId !== JUPITER_PROGRAM) throw new Error(`swap instruction program ${b.swapInstruction.programId} is not Jupiter's`);
  const signers = [b.computeBudgetInstructions, b.setupInstructions, [b.swapInstruction], b.cleanupInstruction ? [b.cleanupInstruction] : [], b.otherInstructions]
    .flat().flatMap((ix) => ix.accounts.filter((a) => a.isSigner).map((a) => a.pubkey));
  const other = signers.find((s) => s !== o.taker);
  if (other) throw new Error(`the swap asks for another signer (${other})`);
}

/**
 * The input that buys at least `need` after slippage, from a probe quote's rate: need * in / out,
 * grown by the slippage tolerance and `marginBps` (price moves between the probe and the real quote),
 * rounded up.
 */
export function sizeInput(probe: { inAmount: bigint; outAmount: bigint }, need: bigint, slippageBps: number, marginBps = 50): bigint {
  if (probe.outAmount <= 0n) throw new Error("probe quote has no output");
  const den = probe.outAmount * 10_000n * 10_000n;
  const num = need * probe.inAmount * BigInt(10_000 + slippageBps + 1) * BigInt(10_000 + marginBps);
  return (num + den - 1n) / den;
}

export interface SwapQuote {
  build: JupBuild;
  route: RouteView;
  probes: number;
}

/**
 * Quotes `pay` (SOL or USDC) into exactly `need` of the target: a probe at `probeAmount` gives the rate,
 * the sized quote must guarantee `need` after slippage (retried once, larger, if the price moved).
 */
export async function quoteForTarget(o: {
  cfg: SwapConfig;
  pay: Exclude<PayAsset, "LINE">;
  need: bigint;
  taker: Address;
  slippageBps?: number;
  maxAccounts?: number;
  probeAmount?: bigint;
  apiKey?: string;
  fetch?: Fetch;
  /** pause between calls (keyless access allows 0.5 requests per second) */
  pause?: () => Promise<void>;
}): Promise<SwapQuote> {
  const slip = o.slippageBps ?? o.cfg.slippage_bps;
  if (slip > o.cfg.max_slippage_bps) throw new Error(`slippage ${slip} bps is above the ${o.cfg.max_slippage_bps} bps limit`);
  const inputMint = PAY_ASSETS[o.pay].mint;
  const base = { inputMint, outputMint: o.cfg.target_mint, taker: o.taker, slippageBps: slip, maxAccounts: o.maxAccounts };
  const call = (amount: bigint) => jupiterBuild({ ...base, amount }, { base: o.cfg.api_base, apiKey: o.apiKey, fetch: o.fetch });
  const probe = await call(o.probeAmount ?? (o.pay === "SOL" ? 100_000_000n : 10_000_000n));
  let amount = sizeInput(probe, o.need, slip);
  let probes = 1;
  for (let i = 0; i < 2; i++) {
    await o.pause?.();
    const b = await call(amount);
    probes++;
    if (b.minOut >= o.need) {
      checkQuote(b, { inputMint, outputMint: o.cfg.target_mint, taker: o.taker, need: o.need, maxSlippageBps: o.cfg.max_slippage_bps, maxPriceImpactPct: o.cfg.max_price_impact_pct });
      return { build: b, route: routeView(b), probes };
    }
    amount = sizeInput(b, o.need, slip, 200);
  }
  throw new Error("the price kept moving: no quote guaranteed the amount after two tries");
}

// ---------- composition ----------

export interface SwapThenPlan {
  /** "one": swap and action in one v0 transaction; "two": the swap, then the action (one signing request for both) */
  mode: "one" | "two";
  txs: { ixs: Ix[]; tables: LookupTable[]; size: number }[];
}

const FAKE_BLOCKHASH = "11111111111111111111111111111111";

/**
 * Swap first, then the app's action, in one v0 transaction reading Jupiter's lookup tables (and the
 * app's own `extraTables`). The action may spend at most `build.minOut` of the target, which the swap
 * guarantees or fails. Over the packet limit: two transactions for one signAllTransactions request,
 * the swap and then the action.
 */
export function planSwapThen(o: { payer: Address; build: JupBuild; action: Ix[]; cuLimit: number; maxCuPrice: number; extraTables?: LookupTable[] }): SwapThenPlan {
  const b = o.build;
  const swap = [...b.setupInstructions.map(jupIx), jupIx(b.swapInstruction), ...(b.cleanupInstruction ? [jupIx(b.cleanupInstruction)] : []), ...b.otherInstructions.map(jupIx)];
  const tables = [...b.tables, ...(o.extraTables ?? [])];
  const size = (ixs: Ix[], t: LookupTable[]) => wireSize(compileMessageV0(o.payer, ixs, FAKE_BLOCKHASH, t));
  const budget = budgetFor(b, o.cuLimit, o.maxCuPrice);
  const one = [...budget, ...swap, ...o.action];
  const s1 = size(one, tables);
  if (s1 <= SWAP_PACKET_LIMIT) return { mode: "one", txs: [{ ixs: one, tables, size: s1 }] };
  const a = [...budgetFor(b, 400_000, o.maxCuPrice), ...o.action];
  const sa = size(a, o.extraTables ?? []);
  const sw = [...budget, ...swap];
  const ss = size(sw, b.tables);
  if (ss > SWAP_PACKET_LIMIT) throw new Error(`the swap alone is ${ss} bytes; ask Jupiter for fewer accounts (maxAccounts)`);
  if (sa > SWAP_PACKET_LIMIT) throw new Error(`the action alone is ${sa} bytes`);
  return { mode: "two", txs: [{ ixs: sw, tables: b.tables, size: ss }, { ixs: a, tables: o.extraTables ?? [], size: sa }] };
}
