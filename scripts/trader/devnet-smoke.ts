#!/usr/bin/env bun
// Devnet smoke check of the trader's chain paths (plan T), before the site runtime uses them:
//   venue:   ChainVenue quotes by simulation and fills a buy and a sell on a DBC curve token and on the
//            graduated DAMM v2 token; each fill must equal its quote (nobody else trades in between
//            within one slot is not guaranteed, so a difference is reported, not hidden), the impact
//            figure is computed, and the slippage floor is honoured;
//   funding: a local allocation escrow is created, a deposit with the memo `lineage-trade-alloc:<agent>`
//            is read back by ChainFunder.deposits and forwarded; a gas top-up lands.
// Keys: ~/.config/lineage/devnet/trading-smoke.json (TEST treasury) and trading-smoke-escrow.json, funded by
// the Lineage deployer (~/.config/lineage/devnet-deployer.json, passed explicitly; the global solana
// config is never read). Every transaction is logged in onchain/DEVNET.md (agent trading lane section).
// Usage: bun scripts/trader/devnet-smoke.ts [--market https://157-245-71-188.sslip.io] [--buy 2]
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, loadKeypair, loadOrCreateKeypair, Rpc, sendAndConfirm, system, token, TOKEN_2022_PROGRAM } from "@lineage/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { withBackoff } from "../../packages/runtime/src/backend.ts";
import { ALLOCATION_MEMO, ChainFunder, ChainVenue, marketTokens, memoIx } from "../../packages/trader/src/index.ts";
import { logTx } from "./devnet-log.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const MARKET = arg("market", "https://157-245-71-188.sslip.io")!;
const BUY = BigInt(Math.round(Number(arg("buy", "2")) * 1e6));
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const T0 = Date.now();
const log = (m: string) => console.log(`[smoke +${((Date.now() - T0) / 1000).toFixed(0).padStart(3)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const rpc = withBackoff(Rpc.http(devnetRpcUrl(), "confirmed"), log);
await assertDevnet(rpc);
const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
const me = loadOrCreateKeypair(join(KEYS, "trading-smoke.json")).key;
const escrow = loadOrCreateKeypair(join(KEYS, "trading-smoke-escrow.json")).key;
const venue = new ChainVenue(rpc, { log: (m) => log(`  ${m}`), onTx: (w, s, f) => logTx(`smoke: ${w}`, s, f) });
const funder = new ChainFunder(rpc, dep, { escrow, log: (m) => log(`  ${m}`), onTx: (w, s, f) => logTx(`smoke: ${w}`, s, f) });
const { lc, decimals } = await funder.config();
const LINE = lc.lineMint;
log(`treasury ${me.id}, escrow owner ${escrow.id}`);

// fund the TEST treasury
const sol = await rpc.getBalance(me.id);
if (sol < 50_000_000n) {
  const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, me.id, 100_000_000n - sol)]);
  logTx(`smoke: fund TEST treasury ${me.id} with ${Number(100_000_000n - sol) / 1e9} SOL from the deployer`, r.signature, r.fee);
}
const bal0 = await venue.balances(me.id, []);
if (bal0.line < 50n * 10n ** BigInt(decimals)) {
  const amt = 100n * 10n ** BigInt(decimals) - bal0.line;
  const r = await sendAndConfirm(rpc, dep, [token.createAtaIdempotent(dep.id, me.id, LINE, TOKEN_2022_PROGRAM), token.transferChecked(ata(dep.id, LINE, TOKEN_2022_PROGRAM), LINE, ata(me.id, LINE, TOKEN_2022_PROGRAM), dep.id, amt, decimals, TOKEN_2022_PROGRAM)]);
  logTx(`smoke: fund TEST treasury with ${amt} tLINE base units from the deployer`, r.signature, r.fee);
}

// ------------------------------------------------------------------ venue
const toks = await marketTokens(MARKET);
const curve = toks.filter((t) => t.venue === "dbc" && t.price).sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];
const grad = toks.find((t) => t.venue === "damm_v2");
for (const t of [curve, grad].filter(Boolean) as typeof toks) {
  const tv = { ...t, parties: [] };
  const route = await venue.route(t.mint);
  check(`${t.mint.slice(0, 6)}: venue read from chain matches the indexer's phase`, (route.kind === "damm_v2") === (t.venue === "damm_v2"), route.kind);
  const q = await venue.quote(me, tv, "buy", BUY);
  check(`${t.mint.slice(0, 6)}: buy quote by simulation`, q.out > 0n, `out ${q.out}, impact ${q.impact_bps} bps`);
  const min = (q.out * 9800n) / 10_000n;
  const f = await venue.execute(me, tv, "buy", BUY, min);
  check(`${t.mint.slice(0, 6)} buy on ${route.kind}: filled the amount in and at least the 2% floor`, f.amount_in === BUY && f.amount_out >= min, `in ${f.amount_in}, out ${f.amount_out}, quoted ${q.out}, sig ${f.signature.slice(0, 10)}...`);
  check(`${t.mint.slice(0, 6)} buy: fill equals the quote`, f.amount_out === q.out, `${f.amount_out} vs ${q.out}`);
  const half = f.amount_out / 2n;
  const qs = await venue.quote(me, tv, "sell", half);
  const fs = await venue.execute(me, tv, "sell", half, (qs.out * 9800n) / 10_000n);
  check(`${t.mint.slice(0, 6)} sell on ${route.kind}: filled`, fs.amount_in === half && fs.amount_out > 0n, `in ${fs.amount_in}, out ${fs.amount_out}, quoted ${qs.out}`);
  // a floor above what the pool pays is refused by the program, before anything moves
  const greedy = await venue.execute(me, tv, "sell", half / 2n, qs.out * 10n).then(() => "filled", (e) => String((e as Error).message).slice(0, 120));
  check(`${t.mint.slice(0, 6)}: a min-out above the pool's price is refused (simulation, nothing sent)`, greedy !== "filled", greedy);
}

// ------------------------------------------------------------------ funding
const escAcct = await funder.ensureEscrow();
check("escrow token account exists", !!escAcct && !!(await rpc.getAccountInfo(escAcct!)), escAcct ?? "");
const before = await funder.deposits(null);
const cursor = before.cursor;
const fakeAgent = me.id; // the memo names an agent id; the smoke uses the treasury's own id
const amt = 1n * 10n ** BigInt(decimals);
const dr = await sendAndConfirm(rpc, dep, [token.transferChecked(ata(dep.id, LINE, TOKEN_2022_PROGRAM), LINE, escAcct!, dep.id, amt, decimals, TOKEN_2022_PROGRAM), memoIx(`${ALLOCATION_MEMO}${fakeAgent}`)]);
logTx(`smoke: allocation deposit of ${amt} into escrow ${escAcct} with memo for ${fakeAgent}`, dr.signature, dr.fee);
let found: { sig: string; agent: string; amount: bigint } | undefined;
for (let i = 0; i < 10 && !found; i++) {
  await Bun.sleep(2000);
  found = (await funder.deposits(cursor)).deposits.find((d) => d.sig === dr.signature);
}
check("deposit read back from chain with its memo and amount", !!found && found.agent === fakeAgent && found.amount === amt, found ? `${found.amount} for ${found.agent.slice(0, 6)}` : "not found");
const lineBefore = (await venue.balances(me.id, [])).line;
const fwd = await funder.forwardAllocation(me.id, amt, dr.signature);
const lineAfter = (await venue.balances(me.id, [])).line;
check("allocation forwarded from the escrow to the treasury", lineAfter - lineBefore === amt, `${fwd.slice(0, 10)}..., +${lineAfter - lineBefore}`);
const solBefore = await rpc.getBalance(me.id);
const g = await funder.gas(me.id, 1_000_000n);
check("gas top-up lands", (await rpc.getBalance(me.id)) - solBefore === 1_000_000n, g.slice(0, 10));

const pass = results.filter((r) => r.ok).length;
log(`${pass}/${results.length} checks passed`);
writeFileSync(join(import.meta.dir, "SMOKE-LAST.json"), JSON.stringify({ at: new Date().toISOString(), treasury: me.id, pass, total: results.length, results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
