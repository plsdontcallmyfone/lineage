// Swap path (SPEC 14.9): Jupiter Swap API V2 /build responses recorded on mainnet by
// scripts/swap/simulate.ts --record (fixtures/jupiter-build.json), parsed, checked, sized and composed
// with the app's action. No network: fetch replays the recording.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as c from "../src/index.ts";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/jupiter-build.json"), "utf8")) as {
  taker: string;
  need: string;
  target: string;
  responses: Record<string, { amount: string; body: Record<string, unknown> }[]>;
};
const cfgRaw = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/swap.json"), "utf8"));
const cfg = c.parseSwapConfig(cfgRaw);
const need = BigInt(fx.need);
const taker = fx.taker;
const sol = fx.responses[c.WSOL_MINT]!;
const usdc = fx.responses[c.USDC_MINT]!;
const sized = (r: typeof sol) => c.parseBuild(r[1]!.body);

/** Replays the recording by (inputMint, amount); records every URL asked. */
function replay() {
  const urls: URL[] = [];
  const f: c.Fetch = async (url) => {
    const u = new URL(url);
    urls.push(u);
    const hit = fx.responses[u.searchParams.get("inputMint")!]?.find((x) => x.amount === u.searchParams.get("amount"));
    if (!hit) return { ok: false, status: 400, json: async () => ({ error: "No routes found" }), text: async () => '{"error":"No routes found"}' };
    return { ok: true, status: 200, json: async () => structuredClone(hit.body), text: async () => JSON.stringify(hit.body) };
  };
  return { f, urls };
}

const vaultOwner = c.launchPdas.computeVault(c.toAddress(c.sha256("lineage swap path sample agent")));
const action = (amount: bigint) => [
  c.token.createAtaIdempotent(taker, vaultOwner, cfg.target_mint, cfg.target_token_program),
  c.token.transferChecked(c.ata(taker, cfg.target_mint, cfg.target_token_program), cfg.target_mint, c.ata(vaultOwner, cfg.target_mint, cfg.target_token_program), taker, amount, cfg.target_decimals, cfg.target_token_program),
];

describe("config and availability", () => {
  test("config/swap.json parses; the target is the configured stand-in", () => {
    expect(cfg.target_mint).toBe(fx.target);
    expect(cfg.target_status).toBe("stand-in");
    expect(cfg.api_base).toBe(c.JUPITER_SWAP_API);
  });
  test("bad configs are refused", () => {
    expect(() => c.parseSwapConfig({ ...cfgRaw, slippage_bps: 400 })).toThrow(/slippage/);
    expect(() => c.parseSwapConfig({ ...cfgRaw, target_token_program: c.SYSTEM_PROGRAM })).toThrow(/token_program/);
    expect(() => c.parseSwapConfig({ ...cfgRaw, api_base: "http://api.jup.ag/swap/v2" })).toThrow(/https/);
    expect(() => c.parseSwapConfig({ ...cfgRaw, target_status: "maybe" })).toThrow(/target_status/);
  });
  test("devnet shows the option as unavailable; mainnet allows it", () => {
    const d = c.swapAvailability(cfg, "devnet");
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toMatch(/mainnet only/);
    expect(c.swapAvailability(cfg, "mainnet-beta").ok).toBe(true);
    expect(c.swapAvailability(null, "mainnet-beta").ok).toBe(false);
  });
});

describe("parseBuild on recorded responses", () => {
  test("SOL: amounts, route, lookup tables, instructions", () => {
    const b = sized(sol);
    expect(b.inputMint).toBe(c.WSOL_MINT);
    expect(b.outputMint).toBe(fx.target);
    expect(b.inAmount).toBe(BigInt(sol[1]!.amount));
    expect(b.minOut >= need).toBe(true);
    expect(b.minOut < b.outAmount).toBe(true);
    expect(b.swapMode).toBe("ExactIn");
    expect(b.swapInstruction.programId).toBe(c.JUPITER_PROGRAM);
    expect(b.tables.length).toBeGreaterThan(0);
    expect(b.tables.every((t) => t.addresses.length > 0)).toBe(true);
    const v = c.routeView(b);
    expect(v.path.length).toBeGreaterThan(0);
    expect(v.hops.every((h) => h.label.length > 0)).toBe(true);
    expect(v.priceImpactPct).toBe(Number(sol[1]!.body.priceImpactPct) * 100);
  });
  test("USDC: parsed the same way", () => {
    const b = sized(usdc);
    expect(b.inputMint).toBe(c.USDC_MINT);
    expect(b.minOut >= need).toBe(true);
  });
  test("malformed bodies and API errors are refused", () => {
    expect(() => c.parseBuild({ error: "No routes found" })).toThrow(/No routes found/);
    expect(() => c.parseBuild({ ...sol[1]!.body, swapInstruction: null })).toThrow(/swapInstruction/);
    expect(() => c.parseBuild({ ...sol[1]!.body, otherAmountThreshold: "1.5" })).toThrow(/otherAmountThreshold/);
    expect(() => c.parseBuild({ ...sol[1]!.body, transactionVersion: 1 })).toThrow(/v0/);
  });
  test("jupIx decodes base64 data and keeps account flags", () => {
    const b = sized(sol);
    const ix = c.jupIx(b.swapInstruction);
    expect(ix.data).toEqual(new Uint8Array(Buffer.from(b.swapInstruction.data, "base64")));
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey)).toEqual([taker]);
  });
});

describe("checks", () => {
  const o = { inputMint: c.WSOL_MINT, outputMint: fx.target, taker, need, maxSlippageBps: cfg.max_slippage_bps, maxPriceImpactPct: cfg.max_price_impact_pct };
  test("the recorded quote passes", () => expect(() => c.checkQuote(sized(sol), o)).not.toThrow());
  test("a need above the guaranteed minimum is refused", () => expect(() => c.checkQuote(sized(sol), { ...o, need: sized(sol).minOut + 1n })).toThrow(/guarantees/));
  test("the wrong pair is refused", () => expect(() => c.checkQuote(sized(sol), { ...o, outputMint: c.USDC_MINT })).toThrow(/asked/));
  test("price impact over the limit is refused", () => expect(() => c.checkQuote({ ...sized(sol), priceImpactPct: 2.5 }, o)).toThrow(/price impact/));
  test("slippage over the limit is refused", () => expect(() => c.checkQuote({ ...sized(sol), slippageBps: 500 }, o)).toThrow(/slippage/));
  test("a second signer is refused", () => {
    const b = sized(sol);
    const other = c.toAddress(c.sha256("someone else"));
    const swapInstruction = { ...b.swapInstruction, accounts: [...b.swapInstruction.accounts, { pubkey: other, isSigner: true, isWritable: false }] };
    expect(() => c.checkQuote({ ...b, swapInstruction }, o)).toThrow(/another signer/);
  });
  test("compute unit price: read, and clamped to the configured maximum", () => {
    const b = sized(sol);
    const p = c.cuPriceOf(b)!;
    expect(p).toBeGreaterThan(0n);
    const [lim, price] = c.budgetFor(b, 2_000_000, Number(p) - 1);
    expect(new DataView(lim!.data.buffer).getUint32(1, true)).toBe(c.MAX_COMPUTE_UNITS);
    expect(new DataView(price!.data.buffer).getBigUint64(1, true)).toBe(p - 1n);
    expect(new DataView(c.budgetFor(b, 1000, 10 ** 9)[1]!.data.buffer).getBigUint64(1, true)).toBe(p);
  });
});

describe("sizing and quoting", () => {
  test("sizeInput covers the need after slippage at the probe's rate", () => {
    const probe = { inAmount: 1_000_000n, outAmount: 2_000_000n };
    const x = c.sizeInput(probe, 1_000_000n, 100, 50);
    expect(x).toBe(507_576n); // 500000 * 1.0101 * 1.005, rounded up
    expect((x * probe.outAmount) / probe.inAmount * 9_900n / 10_000n >= 1_000_000n).toBe(true);
  });
  test("quoteForTarget: probe, then a sized quote that guarantees the need (SOL and USDC)", async () => {
    for (const [pay, rec] of [["SOL", sol], ["USDC", usdc]] as const) {
      const { f, urls } = replay();
      const q = await c.quoteForTarget({ cfg, pay, need, taker, fetch: f });
      expect(urls.length).toBe(2);
      expect(urls[0]!.origin + urls[0]!.pathname).toBe(`${c.JUPITER_SWAP_API}/build`);
      expect(urls[0]!.searchParams.get("amount")).toBe(rec[0]!.amount);
      expect(urls[1]!.searchParams.get("amount")).toBe(rec[1]!.amount);
      for (const u of urls) {
        expect(u.searchParams.get("taker")).toBe(taker);
        expect(u.searchParams.get("slippageBps")).toBe(String(cfg.slippage_bps));
        expect(u.searchParams.get("outputMint")).toBe(cfg.target_mint);
      }
      expect(q.route.minOut >= need).toBe(true);
    }
  });
  test("quoteForTarget refuses slippage above the configured maximum before calling Jupiter", async () => {
    const { f, urls } = replay();
    await expect(c.quoteForTarget({ cfg, pay: "SOL", need, taker, fetch: f, slippageBps: cfg.max_slippage_bps + 1 })).rejects.toThrow(/slippage/);
    expect(urls.length).toBe(0);
  });
  test("an HTTP error carries Jupiter's message", async () => {
    const { f } = replay();
    await expect(c.jupiterBuild({ inputMint: c.WSOL_MINT, outputMint: fx.target, amount: 1n, taker, slippageBps: 50 }, { fetch: f })).rejects.toThrow(/400: No routes found/);
  });
});

describe("composition", () => {
  test("SOL: one v0 transaction; budget, Jupiter's setup, swap and cleanup, then the action", () => {
    const b = sized(sol);
    const act = action(need);
    const p = c.planSwapThen({ payer: taker, build: b, action: act, cuLimit: 600_000, maxCuPrice: cfg.max_cu_price_micro_lamports });
    expect(p.mode).toBe("one");
    const t = p.txs[0]!;
    expect(t.size).toBeLessThanOrEqual(c.SWAP_PACKET_LIMIT);
    expect(t.ixs.slice(0, 2).every((i) => i.programId === "ComputeBudget111111111111111111111111111111")).toBe(true);
    const swapAt = t.ixs.findIndex((i) => i.programId === c.JUPITER_PROGRAM);
    expect(swapAt).toBe(2 + b.setupInstructions.length);
    expect(t.ixs.slice(-2)).toEqual(act);
    expect(t.tables.map((x) => x.address)).toEqual(b.tables.map((x) => x.address));
    // the compiled message is v0, signed by the taker alone, and reads Jupiter's tables
    const m = c.compileMessageV0(taker, t.ixs, "11111111111111111111111111111111", t.tables);
    expect(m.bytes[0]).toBe(0x80);
    expect(m.numSigners).toBe(1);
    expect(m.keys[0]).toBe(taker);
    expect(m.loaded.writable.length + m.loaded.readonly.length).toBeGreaterThan(0);
  });
  test("over the packet limit: two transactions, the swap and then the action", () => {
    const b = sized(usdc);
    const memo = (n: number) => ({ programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", keys: [], data: new Uint8Array(n) });
    const p = c.planSwapThen({ payer: taker, build: b, action: [...action(need), memo(700)], cuLimit: 400_000, maxCuPrice: 1 });
    expect(p.mode).toBe("two");
    expect(p.txs[0]!.ixs.some((i) => i.programId === c.JUPITER_PROGRAM)).toBe(true);
    expect(p.txs[1]!.ixs.some((i) => i.programId === c.JUPITER_PROGRAM)).toBe(false);
    expect(p.txs.every((t) => t.size <= c.SWAP_PACKET_LIMIT)).toBe(true);
  });
});
