// Mainnet mode proof (M3, SPEC 14.10): the three "pay in SOL or USDC" send paths the wallet wires
// behind the mainnet profile, built the way the wallet builds them (packages/chain quoteForTarget +
// planSwapThen with the profile's fee cap, apps/web/wallet/swap.ts) and simulated on mainnet with
// sigVerify false and replaceRecentBlockhash true. Nothing is signed and nothing is sent: the taker is
// a public read-only address and every signature slot is zeros. Also reads the priority fee the
// profile's policy picks for each transaction (getRecentPrioritizationFees, capped by config).
//
//   bun scripts/mainnet-mode/simulate.ts [--taker <address>] [--record]
//
// RPC: LINEAGE_MAINNET_RPC when set (printed redacted, never the key), else the public mainnet
// endpoint (this script only reads). Flows:
//   A launch deposit   pay SOL: Jupiter swap to exactly the deposit of the quote token (the wallet
//                      sends this first, then the launch transaction, which needs lineage_launch on
//                      mainnet and is not simulated here: the program is not deployed there)
//   B trading alloc.   pay USDC: swap, then transferChecked of exactly the allocation to an escrow
//                      token account plus the allocation memo, one v0 transaction
//   C trade-box buy    pay SOL: swap to the pool's quote, then Meteora DBC swap2 (buy) on a live
//                      mainnet DBC pool, one v0 transaction; minOut from the simulated output less
//                      the slippage, recomposed and simulated again (the wallet's review step)
// The quote for A and B is the profile's (the PYUSD stand-in until $LINE exists). No Lineage agent
// pool exists on mainnet, so C uses a live USDC-quoted DBC pool found from recent DBC transactions
// (--pool to pick another); the composition, the Jupiter + DBC accounts and the size limits are the
// same as for an agent pool.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ata,
  compileMessageV0,
  dbc,
  decodeTokenAccount,
  METEORA,
  parsePrepayConfig,
  parseSwapConfig,
  planSwapThen,
  PAY_ASSETS,
  quoteForTarget,
  Rpc,
  sha256,
  token,
  TOKEN_PROGRAM,
  toAddress,
  usdToBase,
  USDC_MINT,
  type Ix,
  type SwapConfig,
} from "../../packages/chain/src/index.ts";
import { redactRpc } from "../../packages/chain/src/endpoint.ts";
import { priorityFee, writableAccounts } from "../../packages/chain/src/fees.ts";
import { checkSwapTarget } from "../../packages/chain/src/profile.ts";
import { loadNetworkProfile } from "../../packages/chain/src/profile-node.ts";

const ROOT = join(import.meta.dir, "../..");
const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
/** Binance's public hot wallet: holds SOL and USDC. Read-only, never signed for. */
const DEFAULT_TAKER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ALLOCATION_MEMO = "lineage-trade-alloc:";
const SAMPLE_AGENT = toAddress(sha256("lineage mainnet mode sample agent"));
const SAMPLE_ESCROW_OWNER = toAddress(sha256("lineage mainnet mode sample allocation escrow"));

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const taker = arg("taker", DEFAULT_TAKER);
const rpcUrl = process.env.LINEAGE_MAINNET_RPC || PUBLIC_MAINNET_RPC;
const rpc = Rpc.http(rpcUrl, "confirmed");
const profile = loadNetworkProfile({ env: { LINEAGE_NETWORK: "mainnet" } });
const swapCfg = parseSwapConfig(JSON.parse(readFileSync(join(ROOT, "config/swap.json"), "utf8")));
const prepay = parsePrepayConfig(JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8")).prepay);
const fees = profile.fees.mode === "recent" ? profile.fees : null;
const maxCuPrice = Math.min(swapCfg.max_cu_price_micro_lamports, fees?.cap_micro_lamports ?? Infinity);
const pause = () => new Promise<void>((r) => setTimeout(r, 2500)); // keyless Jupiter: 0.5 requests per second

const units = (v: bigint, d: number) => {
  const neg = v < 0n, a = neg ? -v : v, s = a.toString().padStart(d + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -d)}.${s.slice(-d)}`;
};
let checks = 0, passed = 0;
const results: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail = "") => {
  checks++;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

function unsignedWire(msg: { bytes: Uint8Array; numSigners: number }): Uint8Array {
  const out = new Uint8Array(1 + 64 * msg.numSigners + msg.bytes.length);
  out[0] = msg.numSigners;
  out.set(msg.bytes, 1 + 64 * msg.numSigners);
  return out;
}
const cuPrice = (ixs: Ix[]) => {
  const p = ixs.find((ix) => ix.programId === "ComputeBudget111111111111111111111111111111" && ix.data[0] === 3);
  return p ? new DataView(p.data.buffer, p.data.byteOffset).getBigUint64(1, true) : null;
};
const tokenAmt = (data: Uint8Array | null) => (data && data.length >= 165 ? decodeTokenAccount(data).amount : 0n);

/** Simulates one composed transaction and returns the token deltas of `watch` (token accounts). */
async function simulate(label: string, ixs: Ix[], tables: Parameters<typeof compileMessageV0>[3], watch: string[]) {
  const { blockhash } = await rpc.getLatestBlockhash();
  const msg = compileMessageV0(taker, ixs, blockhash, tables);
  const before = await rpc.getMultipleAccounts(watch);
  const sim = await rpc.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts: ({ data: [string, string] } | null)[] | null } }>("simulateTransaction", [
    Buffer.from(unsignedWire(msg)).toString("base64"),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: watch } },
  ]);
  const v = sim.value;
  const deltas = watch.map((_, i) => tokenAmt(v.accounts?.[i] ? new Uint8Array(Buffer.from(v.accounts[i]!.data[0], "base64")) : null) - tokenAmt(before[i]?.data ?? null));
  check(`${label}: simulation succeeds`, v.err === null, v.err === null ? `${v.unitsConsumed} compute units` : JSON.stringify(v.err));
  if (v.err !== null) console.log((v.logs ?? []).slice(-12).join("\n"));
  return { err: v.err, units: v.unitsConsumed ?? null, deltas };
}

/** The profile's priority fee for a transaction's writable accounts (what a non-swap mainnet send pays). */
async function feeFor(label: string, ixs: Ix[]) {
  const f = await priorityFee(rpc, writableAccounts(ixs, taker), profile.fees);
  const cap = fees!.cap_micro_lamports;
  check(`${label}: profile priority fee within [floor, cap]`, f.microLamports >= fees!.floor_micro_lamports && f.microLamports <= cap,
    `${f.microLamports} micro-lamports per CU (${f.source}, p${fees!.percentile} of ${f.samples} slots${f.cappedFrom !== undefined ? `, capped from ${f.cappedFrom}` : ""}; cap ${cap})`);
  return f;
}

async function findUsdcDbcPool(): Promise<{ config: string; pool: string; baseMint: string; baseProgram: string; quoteProgram: string } | null> {
  const want = arg("pool", "");
  let before: string | undefined;
  for (let page = 0; page < 6; page++) {
    const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [want || METEORA.dbcProgram, { limit: 100, before }]);
    before = sigs[sigs.length - 1]?.signature;
    for (const s of sigs) {
      if (s.err) continue;
      await new Promise((r) => setTimeout(r, 120));
      const tx = await rpc.call<any>("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
      if (!tx) continue;
      const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
      for (const ix of tx.transaction.message.instructions as { programIdIndex: number; accounts: number[] }[]) {
        if (keys[ix.programIdIndex] !== METEORA.dbcProgram || ix.accounts.length < 14) continue;
        const a = ix.accounts.map((i) => keys[i]!);
        if (a[8] === USDC_MINT && (!want || a[2] === want)) return { config: a[1]!, pool: a[2]!, baseMint: a[7]!, baseProgram: a[10]!, quoteProgram: a[11]! };
      }
    }
  }
  return null;
}

async function main() {
  console.log(`RPC ${redactRpc(rpcUrl)}; taker ${taker} (read-only, never signed for); nothing is signed or sent`);
  const genesis = await rpc.call<string>("getGenesisHash");
  check("RPC is mainnet-beta (the profile's genesis)", genesis === profile.genesis, genesis);
  if (genesis !== profile.genesis) process.exit(1);
  check("profile mainnet: no faucet, no TEST labels, quote from config, recent fees", !profile.faucet && !profile.test_labels && profile.quote.source === "config" && !!fees);
  check("config/swap.json targets the profile's quote mint", checkSwapTarget(profile, swapCfg) === null, `${profile.quote.symbol} ${profile.quote.mint} (${profile.quote.status}; $LINE ${profile.quote.line_mint ?? "TBA"})`);
  console.log(`swap budget: Jupiter's unit price, never above ${maxCuPrice} micro-lamports (min of config/swap.json and the profile cap)`);
  const q = profile.quote;
  const qd = q.decimals!, qm = q.mint!, qtp = q.token_program!;
  const deposit = usdToBase(prepay.default_usd, prepay.line_per_usd, qd);
  console.log(`deposit and allocation size: Core's prepay default ${prepay.default_usd} at its line_per_usd ${prepay.line_per_usd} = ${units(deposit, qd)} ${q.symbol} (${deposit} base units; config values, no price feed)`);

  // ---------------- A: launch deposit, pay SOL: swap first
  {
    console.log(`\n== A launch deposit, pay SOL (swap to exactly ${units(deposit, qd)} ${q.symbol}; the launch transaction follows once it lands)`);
    const quote = await quoteForTarget({ cfg: swapCfg, pay: "SOL", need: deposit, taker, pause, apiKey: process.env.JUPITER_API_KEY });
    const plan = planSwapThen({ payer: taker, build: quote.build, action: [], cuLimit: 400_000, maxCuPrice });
    const t = plan.txs[0]!;
    console.log(`route ${quote.route.path}; in ${units(quote.route.inAmount, 9)} SOL; minimum out ${units(quote.route.minOut, qd)} ${q.symbol}; impact ${quote.route.priceImpactPct.toFixed(4)}%; ${t.size} bytes`);
    check("A: the quote guarantees the deposit", quote.route.minOut >= deposit, `${quote.route.minOut} >= ${deposit}`);
    check("A: one v0 transaction within 1232 bytes", plan.mode === "one" && t.size <= 1232, `${t.size} bytes`);
    check("A: unit price within the cap", (cuPrice(t.ixs) ?? 0n) <= BigInt(maxCuPrice), `${cuPrice(t.ixs)} micro-lamports`);
    const takerQ = ata(taker, qm, qtp);
    const s = await simulate("A", t.ixs, t.tables, [takerQ]);
    if (s.err === null) check("A: the wallet receives at least the deposit", s.deltas[0]! >= deposit, `+${units(s.deltas[0]!, qd)} ${q.symbol}`);
    const f = await feeFor("A launch transaction (non-swap send)", [token.transferChecked(takerQ, qm, ata(SAMPLE_AGENT, qm, qtp), taker, deposit, qd, qtp)]);
    results.A = { route: quote.route.path, in_lamports: quote.route.inAmount.toString(), min_out: quote.route.minOut.toString(), need: deposit.toString(), size: t.size,
      cu_price: String(cuPrice(t.ixs)), units: s.units, received: s.deltas[0]?.toString(), launch_tx_priority_fee: f };
  }

  // ---------------- B: trading allocation, pay USDC: swap + transfer + memo in one transaction
  {
    console.log(`\n== B trading allocation, pay USDC (swap, then exactly ${units(deposit, qd)} ${q.symbol} to an escrow with the memo)`);
    const escrowAcc = ata(SAMPLE_ESCROW_OWNER, qm, qtp);
    const takerQ = ata(taker, qm, qtp);
    const action: Ix[] = [
      // the published escrow exists on a real network; the sample one is created idempotently for the simulation
      token.createAtaIdempotent(taker, SAMPLE_ESCROW_OWNER, qm, qtp),
      token.transferChecked(takerQ, qm, escrowAcc, taker, deposit, qd, qtp),
      { programId: MEMO_PROGRAM, keys: [], data: new TextEncoder().encode(`${ALLOCATION_MEMO}${SAMPLE_AGENT}`) },
    ];
    await pause();
    const quote = await quoteForTarget({ cfg: swapCfg, pay: "USDC", need: deposit, taker, pause, apiKey: process.env.JUPITER_API_KEY });
    const plan = planSwapThen({ payer: taker, build: quote.build, action, cuLimit: 400_000, maxCuPrice });
    const t = plan.txs[0]!;
    console.log(`route ${quote.route.path}; in ${units(quote.route.inAmount, 6)} USDC; minimum out ${units(quote.route.minOut, qd)}; ${plan.mode === "one" ? `one transaction, ${t.size} bytes` : "two transactions"}`);
    check("B: swap and allocation fit one transaction", plan.mode === "one" && t.size <= 1232, `${t.size} bytes`);
    const s = await simulate("B", t.ixs, t.tables, [escrowAcc, takerQ, ata(taker, USDC_MINT, TOKEN_PROGRAM)]);
    if (s.err === null) {
      check("B: the escrow receives exactly the allocation", s.deltas[0] === deposit, `+${units(s.deltas[0]!, qd)} ${q.symbol}`);
      check("B: the taker keeps the swap surplus (>= 0)", s.deltas[1]! >= 0n, `${units(s.deltas[1]!, qd)} ${q.symbol}`);
    }
    results.B = { route: quote.route.path, in_usdc: quote.route.inAmount.toString(), size: t.size, units: s.units, escrow_received: s.deltas[0]?.toString(), usdc_spent: s.deltas[2]?.toString() };
  }

  // ---------------- C: trade-box buy, pay SOL: swap to the pool's quote, then DBC swap2 (buy)
  {
    console.log("\n== C trade-box buy, pay SOL (swap to the pool's quote, then a Meteora DBC buy, one transaction)");
    const pool = await findUsdcDbcPool();
    check("C: a live USDC-quoted Meteora DBC pool on mainnet", !!pool, pool ? `pool ${pool.pool}, base ${pool.baseMint}` : "none in the recent DBC transactions");
    if (pool) {
      // the pool's quote is the swap target here (an agent pool's quote would be the profile's quote mint)
      const cCfg: SwapConfig = { ...swapCfg, target_mint: USDC_MINT, target_decimals: 6, target_token_program: TOKEN_PROGRAM, target_symbol: "USDC" };
      const amountIn = 2_000_000n; // 2 USDC into the curve
      const takerQuote = ata(taker, USDC_MINT, TOKEN_PROGRAM);
      const takerBase = ata(taker, pool.baseMint, pool.baseProgram);
      const buy = (minOut: bigint): Ix[] => [
        token.createAtaIdempotent(taker, taker, pool.baseMint, pool.baseProgram),
        dbc.swap({ config: pool.config, pool: pool.pool, agentMint: pool.baseMint, lineMint: USDC_MINT, trader: taker, lineAccount: takerQuote, agentAccount: takerBase,
          buy: true, amountIn, minOut, lineTokenProgram: pool.quoteProgram, baseTokenProgram: pool.baseProgram }),
      ];
      await pause();
      const quote = await quoteForTarget({ cfg: cCfg, pay: "SOL", need: amountIn, taker, pause, apiKey: process.env.JUPITER_API_KEY, maxAccounts: 30 });
      let plan = planSwapThen({ payer: taker, build: quote.build, action: buy(1n), cuLimit: 600_000, maxCuPrice });
      let t = plan.txs[0]!;
      console.log(`route ${quote.route.path}; in ${units(quote.route.inAmount, 9)} SOL; minimum out ${units(quote.route.minOut, 6)} USDC; ${plan.mode === "one" ? `one transaction, ${t.size} bytes` : "two transactions"}`);
      check("C: swap and buy fit one transaction", plan.mode === "one" && t.size <= 1232, `${t.size} bytes`);
      const s1 = await simulate("C review (minOut 1)", t.ixs, t.tables, [takerBase, takerQuote]);
      if (s1.err === null) {
        const out = s1.deltas[0]!;
        check("C: the buy returns tokens", out > 0n, `+${out} base units`);
        const minOut = (out * 9_900n) / 10_000n || 1n; // 100 bps, the trade box default
        plan = planSwapThen({ payer: taker, build: quote.build, action: buy(minOut), cuLimit: 600_000, maxCuPrice });
        t = plan.txs[0]!;
        const s2 = await simulate("C sign (minOut from the review less 100 bps)", t.ixs, t.tables, [takerBase, takerQuote]);
        if (s2.err === null) {
          check("C: the swap funds the buy (taker USDC net >= 0)", s2.deltas[1]! >= 0n, `${units(s2.deltas[1]!, 6)} USDC`);
          check("C: output at least the minimum", s2.deltas[0]! >= minOut, `${s2.deltas[0]} >= ${minOut}`);
        }
        results.C = { pool: pool.pool, base_mint: pool.baseMint, route: quote.route.path, in_lamports: quote.route.inAmount.toString(), size: t.size, units: s2.units, out: s2.deltas[0]?.toString(), min_out: minOut.toString(), usdc_net: s2.deltas[1]?.toString() };
      }
    }
  }

  const file = join(ROOT, "scripts/mainnet-mode/SIMULATE-LAST.json");
  mkdirSync(join(ROOT, "scripts/mainnet-mode"), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), rpc: redactRpc(rpcUrl), taker, quote: { symbol: q.symbol, mint: qm, status: q.status }, passed, checks, results, signed: 0, sent: 0 },
    (_, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
  console.log(`\n${passed}/${checks} checks passed; nothing was signed or sent (scripts/mainnet-mode/SIMULATE-LAST.json)`);
  process.exit(passed === checks ? 0 : 1);
}

await main();
