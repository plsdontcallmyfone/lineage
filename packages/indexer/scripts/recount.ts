#!/usr/bin/env bun
// Independent recount from chain, compared with a running indexer's API; writes VERIFY-LAST.json.
//
//   bun packages/indexer/scripts/recount.ts [--api http://127.0.0.1:9668] [--mint <mint> ...]
//
// It shares no ingest or decoding code with the indexer: it lists every signature of each pool with
// getSignaturesForAddress, fetches each transaction, and counts trades from Meteora's own swap
// events only (EvtSwap2 in the emit_cpi inner instructions; the indexer takes amounts from vault
// balance deltas), takes the last trade's price from the event amounts, reads the pool price
// straight from the pool account, counts lineage_launch FeesCranked logs, and reads the compute
// vault with getTokenAccountBalance. The RPC URL is never printed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { base58Decode, base58Encode } from "@lineage/protocol";
import { devnetRpcUrl, redactRpc } from "@lineage/chain/src/endpoint.ts";

const argv = process.argv.slice(2);
const api = argv.includes("--api") ? argv[argv.indexOf("--api") + 1]! : "http://127.0.0.1:9668";
const mints = argv.flatMap((a, i) => (argv[i - 1] === "--mint" ? [a] : []));
if (!mints.length) mints.push("3AvZ77ZdVPx7yxtqA4UP11DoaPdjdgP3AUbkSnidsmY4", "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz");
const url = devnetRpcUrl();

const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const DAMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const d8 = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8).toString("hex");
const TAG = "e445a52e51cb9a1d";
const EVT_SWAP2 = d8("event:EvtSwap2");
const FEES_CRANKED = d8("event:FeesCranked");

let last = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0; ; i++) {
    const wait = last + 250 - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    last = Date.now();
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429 || r.status >= 500) {
      if (i > 8) throw new Error(`${method}: HTTP ${r.status}`);
      await Bun.sleep(1000 * 2 ** Math.min(i, 4));
      continue;
    }
    const b = (await r.json()) as { result: T; error?: { message: string } };
    if (b.error) throw new Error(`${method}: ${b.error.message}`);
    return b.result;
  }
}
const getJson = async (p: string) => (await (await fetch(`${api}${p}`)).json()) as any;
const le64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const le128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
const sqrtToPrice = (s: bigint) => (Number(s) / 2 ** 64) ** 2;

async function allSigs(address: string) {
  const out: { signature: string; slot: number; err: unknown }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    out.push(...page);
    if (page.length < 1000) return out;
    before = page.at(-1)!.signature;
  }
}

interface Swap { sig: string; slot: number; pos: number; venue: string; buy: boolean; base: bigint; quote: bigint }

async function recount(mint: string) {
  const tok = await getJson(`/market/tokens/${mint}`);
  const pools: [string, string, string][] = [[tok.pools.dbc_pool, DBC, "dbc"]];
  if (tok.pools.damm_pool) pools.push([tok.pools.damm_pool, DAMM, "damm"]);
  const swaps: Swap[] = [];
  const cranks = new Map<string, { toCompute: bigint }>();
  const seen = new Set<string>();
  let sigCount = 0;
  for (const [pool, program, venue] of pools) {
    const sigs = (await allSigs(pool)).filter((s) => s.err == null);
    sigCount += sigs.length;
    for (const s of sigs) {
      const tx = await rpc<any>("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      let pos = 0;
      for (const g of tx.meta.innerInstructions ?? []) {
        for (const ix of g.instructions) {
          pos++;
          if (keys[ix.programIdIndex] !== program) continue;
          const d = Buffer.from(base58Decode(ix.data));
          if (d.subarray(0, 8).toString("hex") !== TAG || d.subarray(8, 16).toString("hex") !== EVT_SWAP2) continue;
          const e = d.subarray(16);
          if (base58Encode(e.subarray(0, 32)) !== pool) continue;
          // DBC EvtSwap2: pool, config, trade_direction (1 = QuoteToBase), has_referral, SwapParameters2 (17), SwapResult2.
          // DAMM v2 EvtSwap2: pool, trade_direction (1 = BtoA, B = tLINE), collect_fee_mode, has_referral, SwapParameters2, SwapResult2.
          const [dir, res] = venue === "dbc" ? [e[64], 83] : [e[32], 52];
          const input = le64(e, res);
          const output = le64(e, res + 24);
          const buy = dir === 1;
          swaps.push({ sig: s.signature, slot: tx.slot, pos, venue, buy, base: buy ? output : input, quote: buy ? input : output });
        }
      }
      if (!seen.has(s.signature)) {
        seen.add(s.signature);
        for (const l of tx.meta.logMessages ?? []) {
          if (!l.startsWith("Program data: ")) continue;
          const b = Buffer.from(l.slice(14), "base64");
          if (b.subarray(0, 8).toString("hex") !== FEES_CRANKED || base58Encode(b.subarray(40, 72)) !== mint) continue;
          cranks.set(s.signature, { toCompute: le64(b, 80) });
        }
      }
    }
  }
  // a transaction touching both pools is listed under both: one swap per (signature, position)
  const uniq = [...new Map(swaps.map((s) => [`${s.sig}:${s.pos}`, s])).values()].sort((a, b) => a.slot - b.slot || a.pos - b.pos);
  const lastSwap = uniq.at(-1) ?? null;
  const livePool = tok.phase === "graduated" ? tok.pools.damm_pool : tok.pools.dbc_pool;
  const acc = await rpc<{ value: { data: [string, string] } }>("getAccountInfo", [livePool, { encoding: "base64", commitment: "confirmed" }]);
  const pd = Buffer.from(acc.value.data[0], "base64");
  const poolPrice = sqrtToPrice(le128(pd, tok.phase === "graduated" ? 456 : 280)) * 10 ** (tok.decimals - tok.quote_decimals);
  const vault = await rpc<{ value: { amount: string } }>("getTokenAccountBalance", [tok.compute_vault.address, { commitment: "confirmed" }]);

  const idx = await getJson(`/market/tokens/${mint}/trades?limit=500`);
  const fees = await getJson(`/market/tokens/${mint}/fees`);
  const fresh = await getJson(`/market/tokens/${mint}`);
  const it0 = idx.trades[0];
  const chainLast = lastSwap ? Number(lastSwap.quote) / Number(lastSwap.base) * 10 ** (tok.decimals - tok.quote_decimals) : null;
  const checks = {
    trade_count: { chain: uniq.length, indexer: fresh.trades, pass: uniq.length === fresh.trades },
    trades_by_venue: {
      chain: { dbc: uniq.filter((s) => s.venue === "dbc").length, damm: uniq.filter((s) => s.venue === "damm").length },
      indexer: { dbc: idx.trades.filter((t: any) => t.venue === "dbc").length, damm: idx.trades.filter((t: any) => t.venue === "damm").length },
    },
    last_trade: {
      chain: lastSwap && { signature: lastSwap.sig, venue: lastSwap.venue, side: lastSwap.buy ? "buy" : "sell", base_raw: lastSwap.base.toString(),
        quote_raw: lastSwap.quote.toString(), price: chainLast },
      indexer: it0 && { signature: it0.signature, venue: it0.venue, side: it0.side, base_raw: it0.base_raw, quote_raw: it0.quote_raw, price: it0.price },
      pass: !!lastSwap && !!it0 && lastSwap.sig === it0.signature && lastSwap.base.toString() === it0.base_raw && lastSwap.quote.toString() === it0.quote_raw
        && chainLast != null && Math.abs(chainLast - it0.price) <= 1e-12 * chainLast,
    },
    pool_price: { chain: poolPrice, indexer: fresh.price, pass: Math.abs(poolPrice - fresh.price) <= 1e-12 * Math.max(1, poolPrice) },
    fee_cranks: {
      chain: { count: cranks.size, to_compute_raw: [...cranks.values()].reduce((a, c) => a + c.toCompute, 0n).toString() },
      indexer: { count: fees.cranks.length, to_compute_raw: fees.cranks.reduce((a: bigint, c: any) => a + BigInt(c.to_vault_raw), 0n).toString() },
      pass: false,
    },
    compute_vault_raw: { chain: vault.value.amount, indexer: fresh.compute_vault.balance_raw, pass: vault.value.amount === fresh.compute_vault.balance_raw },
  };
  checks.fee_cranks.pass = checks.fee_cranks.chain.count === checks.fee_cranks.indexer.count
    && checks.fee_cranks.chain.to_compute_raw === checks.fee_cranks.indexer.to_compute_raw;
  const pass = checks.trade_count.pass && checks.last_trade.pass && checks.pool_price.pass && checks.fee_cranks.pass && checks.compute_vault_raw.pass
    && JSON.stringify(checks.trades_by_venue.chain) === JSON.stringify(checks.trades_by_venue.indexer);
  return { mint, symbol: tok.symbol, phase: tok.phase, signatures_listed: sigCount, pass, checks };
}

const status = await getJson("/market/status");
const results = [];
for (const m of mints) {
  const r = await recount(m);
  console.log(`${m} ${r.phase}: trades ${r.checks.trade_count.chain}/${r.checks.trade_count.indexer}, last ${r.checks.last_trade.pass}, pool price ${r.checks.pool_price.pass}, fee cranks ${r.checks.fee_cranks.pass}, vault ${r.checks.compute_vault_raw.pass} => ${r.pass ? "PASS" : "FAIL"}`);
  results.push(r);
}
const out = {
  at: new Date().toISOString(),
  rpc: redactRpc(url),
  indexer: { api, tokens: status.tokens, trades: status.trades, fee_cranks: status.fee_cranks, transactions: status.transactions, head_slot: status.head_slot },
  method: "independent recount: getSignaturesForAddress on each pool, getTransaction, Meteora EvtSwap2 events only, pool account sqrt_price, FeesCranked logs, getTokenAccountBalance",
  pass: results.every((r) => r.pass),
  tokens: results,
};
writeFileSync(join(import.meta.dir, "../VERIFY-LAST.json"), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
console.log(out.pass ? "PASS" : "FAIL");
process.exit(out.pass ? 0 : 1);
