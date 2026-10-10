#!/usr/bin/env bun
// Independent recount from chain, compared with a running indexer's API; writes VERIFY-LAST.json.
//
//   bun packages/indexer/scripts/recount.ts [--api http://127.0.0.1:9668] [--rpc <url>] --mint <mint> [--mint <mint> ...]
//
// It shares no ingest or decoding code with the indexer: it lists every signature of each token's
// pump.fun bonding curve and canonical PumpSwap pool with getSignaturesForAddress, fetches each
// transaction, and reads pump.fun's events by fixed offsets here (Pump TradeEvent: mint, then
// token_amount; PumpSwap BuyEvent and SellEvent: the pool at byte 112 after the event discriminator),
// reads the price straight from the curve (virtual reserves) or the pool (vault balances plus its
// signed virtual quote reserves), counts units_launch FeesCranked logs, and reads the compute vault
// with getTokenAccountBalance. The RPC URL is never printed. Without --rpc it uses the devnet resolver.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { base58Decode, base58Encode } from "@lineage/protocol";
import { devnetRpcUrl, redactRpc } from "@lineage/chain/src/endpoint.ts";

const argv = process.argv.slice(2);
const api = argv.includes("--api") ? argv[argv.indexOf("--api") + 1]! : "http://127.0.0.1:9668";
const mints = argv.flatMap((a, i) => (argv[i - 1] === "--mint" ? [a] : []));
if (!mints.length) throw new Error("name at least one --mint");
const url = argv.includes("--rpc") ? argv[argv.indexOf("--rpc") + 1]! : devnetRpcUrl();

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const d8 = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8).toString("hex");
const TAG = "e445a52e51cb9a1d";
const TRADE = d8("event:TradeEvent");
const BUY = d8("event:BuyEvent");
const SELL = d8("event:SellEvent");
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

interface Swap { sig: string; slot: number; pos: number; venue: string; buy: boolean; base: bigint }

async function recount(mint: string) {
  const tok = await getJson(`/market/tokens/${mint}`);
  const curve = tok.pools.bonding_curve as string;
  const pool = tok.pools.pump_pool as string | null;
  const sources = [curve, ...(pool ? [pool] : [])];
  const swaps: Swap[] = [];
  const cranks = new Map<string, { toCompute: bigint }>();
  const seen = new Set<string>();
  let sigCount = 0;
  for (const src of sources) {
    const sigs = (await allSigs(src)).filter((s) => s.err == null);
    sigCount += sigs.length;
    for (const s of sigs) {
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      const tx = await rpc<any>("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      let pos = 0;
      for (const g of tx.meta.innerInstructions ?? []) {
        for (const ix of g.instructions) {
          pos++;
          const program = keys[ix.programIdIndex];
          if (program !== PUMP && program !== AMM) continue;
          const d = Buffer.from(base58Decode(ix.data));
          if (d.subarray(0, 8).toString("hex") !== TAG) continue;
          const kind = d.subarray(8, 16).toString("hex");
          const e = d.subarray(16);
          // TradeEvent: mint (32), sol_amount (8), token_amount (8), is_buy (1)
          if (program === PUMP && kind === TRADE && base58Encode(e.subarray(0, 32)) === mint)
            swaps.push({ sig: s.signature, slot: tx.slot, pos, venue: "curve", buy: e[48] === 1, base: le64(e, 40) });
          // BuyEvent / SellEvent: timestamp (8), 13 u64 fields, pool (32); the base amount is the second field
          if (program === AMM && (kind === BUY || kind === SELL) && pool && base58Encode(e.subarray(112, 144)) === pool)
            swaps.push({ sig: s.signature, slot: tx.slot, pos, venue: "pool", buy: kind === BUY, base: le64(e, 8) });
        }
      }
      for (const l of tx.meta.logMessages ?? []) {
        if (!l.startsWith("Program data: ")) continue;
        const b = Buffer.from(l.slice(14), "base64");
        if (b.subarray(0, 8).toString("hex") !== FEES_CRANKED || base58Encode(b.subarray(40, 72)) !== mint) continue;
        cranks.set(s.signature, { toCompute: le64(b, 80) });
      }
    }
  }
  const uniq = swaps.sort((a, b) => a.slot - b.slot || a.pos - b.pos);
  const lastSwap = uniq.at(-1) ?? null;
  // live price: the pool's vaults and signed virtual quote reserves once migrated, else the curve's virtual reserves
  const acct = async (a: string) => Buffer.from((await rpc<{ value: { data: [string, string] } }>("getAccountInfo", [a, { encoding: "base64", commitment: "confirmed" }])).value.data[0], "base64");
  let chainPrice: number;
  if (tok.migrated && pool) {
    const p = await acct(pool);
    const vb = le64(await acct(base58Encode(p.subarray(139, 171))), 64), vq = le64(await acct(base58Encode(p.subarray(171, 203))), 64);
    const vqr = p.length >= 261 ? BigInt.asIntN(128, le64(p, 245) | (le64(p, 253) << 64n)) : 0n;
    chainPrice = Number(vq + vqr) / Number(vb) * 10 ** (tok.decimals - tok.quote_decimals);
  } else {
    const c = await acct(curve);
    chainPrice = Number(le64(c, 16)) / Number(le64(c, 8)) * 10 ** (tok.decimals - tok.quote_decimals);
  }
  const vault = await rpc<{ value: { amount: string } }>("getTokenAccountBalance", [tok.compute_vault.address, { commitment: "confirmed" }]);

  const idx = await getJson(`/market/tokens/${mint}/trades?limit=500`);
  const fees = await getJson(`/market/tokens/${mint}/fees`);
  const fresh = await getJson(`/market/tokens/${mint}`);
  const it0 = idx.trades[0];
  const checks = {
    trade_count: { chain: uniq.length, indexer: fresh.trades, pass: uniq.length === fresh.trades },
    trades_by_venue: {
      chain: { curve: uniq.filter((s) => s.venue === "curve").length, pool: uniq.filter((s) => s.venue === "pool").length },
      indexer: { curve: idx.trades.filter((t: any) => t.venue === "curve").length, pool: idx.trades.filter((t: any) => t.venue === "pool").length },
    },
    last_trade: {
      chain: lastSwap && { signature: lastSwap.sig, venue: lastSwap.venue, side: lastSwap.buy ? "buy" : "sell" },
      indexer: it0 && { signature: it0.signature, venue: it0.venue, side: it0.side },
      pass: !!lastSwap && !!it0 && lastSwap.sig === it0.signature && lastSwap.venue === it0.venue && (lastSwap.buy ? "buy" : "sell") === it0.side,
    },
    price: { chain: chainPrice, indexer: fresh.price, pass: Math.abs(chainPrice - fresh.price) <= 1e-9 * Math.max(1e-12, chainPrice) },
    fee_cranks: {
      chain: { count: cranks.size, to_compute_raw: [...cranks.values()].reduce((a, c) => a + c.toCompute, 0n).toString() },
      indexer: { count: fees.cranks.length, to_compute_raw: fees.cranks.reduce((a: bigint, c: any) => a + BigInt(c.to_vault_raw), 0n).toString() },
      pass: false,
    },
    compute_vault_raw: { chain: vault.value.amount, indexer: fresh.compute_vault.balance_raw, pass: vault.value.amount === fresh.compute_vault.balance_raw },
  };
  checks.fee_cranks.pass = checks.fee_cranks.chain.count === checks.fee_cranks.indexer.count
    && checks.fee_cranks.chain.to_compute_raw === checks.fee_cranks.indexer.to_compute_raw;
  const pass = checks.trade_count.pass && checks.last_trade.pass && checks.price.pass && checks.fee_cranks.pass && checks.compute_vault_raw.pass
    && JSON.stringify(checks.trades_by_venue.chain) === JSON.stringify(checks.trades_by_venue.indexer);
  return { mint, symbol: tok.symbol, phase: tok.phase, signatures_listed: sigCount, pass, checks };
}

const status = await getJson("/market/status");
const results = [];
for (const m of mints) {
  const r = await recount(m);
  console.log(`${m} ${r.phase}: trades ${r.checks.trade_count.chain}/${r.checks.trade_count.indexer}, last ${r.checks.last_trade.pass}, price ${r.checks.price.pass}, fee cranks ${r.checks.fee_cranks.pass}, vault ${r.checks.compute_vault_raw.pass} => ${r.pass ? "PASS" : "FAIL"}`);
  results.push(r);
}
const out = {
  at: new Date().toISOString(),
  rpc: redactRpc(url),
  indexer: { api, tokens: status.tokens, trades: status.trades, fee_cranks: status.fee_cranks, transactions: status.transactions, head_slot: status.head_slot },
  method: "independent recount: getSignaturesForAddress on the bonding curve and the PumpSwap pool, getTransaction, pump.fun TradeEvent/BuyEvent/SellEvent read by fixed offsets, curve virtual reserves or pool vaults + virtual quote reserves, FeesCranked logs, getTokenAccountBalance",
  pass: results.every((r) => r.pass),
  tokens: results,
};
writeFileSync(join(import.meta.dir, "../VERIFY-LAST.json"), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
console.log(out.pass ? "PASS" : "FAIL");
process.exit(out.pass ? 0 : 1);
