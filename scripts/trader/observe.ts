#!/usr/bin/env bun
// The devnet trading observation (plan T exit): watches the live site's public API for a window (default
// 60 minutes), then checks every trade the hosted agents placed in it:
//   - visible and attributed: in GET /v1/trades and on GET /v1/agents/:id/trades, with score, rule and
//     reason; the transaction is on chain, succeeded, and was signed by the agent's treasury key, which
//     is the agent's current signing key in the registry (bound to the runtime);
//   - within the limits as published at GET /v1/trading/config: per-trade and per-position size,
//     slippage floor, price impact, cooldown, minimum hold, open positions, global rate per epoch;
//   - integrity: never its own token, never a token of an agent sharing a launcher, owner or operator;
//     nothing after a halt until it ends or is reset.
// Reports trade counts, P&L (realized from the records, and equity first to last per agent from the
// published treasury snapshots, net of funding), halts and limit refusals (the runtime's counters,
// read over ssh when --host is given). Writes scripts/trader/OBSERVE-LAST.json.
// Usage: bun scripts/trader/observe.ts [--site https://157-245-71-188.sslip.io] [--minutes 60] [--since <ms>] [--host 157.245.71.188]
import { spawnSync } from "bun";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChainReader, Rpc } from "@lineage/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const SITE = arg("site", "https://157-245-71-188.sslip.io")!.replace(/\/+$/, "");
const MIN = Number(arg("minutes", "60"));
const HOST = arg("host");
const since = Number(arg("since", String(Date.now())));
const T0 = Date.now();
const log = (m: string) => console.log(`[observe +${((Date.now() - T0) / 60000).toFixed(1).padStart(5)} min] ${m}`);
const api = async (p: string) => {
  for (let i = 0; ; i++) {
    const r = await fetch(`${SITE}/api/${p}`).catch(() => null);
    if (r?.ok) return r.json();
    if (i >= 5) throw new Error(`${p}: HTTP ${r?.status ?? "unreachable"}`);
    await Bun.sleep(5000);
  }
};
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const runtimeHits = () => {
  if (!HOST) return null;
  const r = spawnSync(["ssh", "-i", join(homedir(), ".ssh/lineage_site"), "-o", "BatchMode=yes", `root@${HOST}`, "cat /var/lib/lineage/runtime/trader/trader.json"]);
  if (r.exitCode !== 0) return null;
  const s = JSON.parse(r.stdout.toString());
  return { trades: s.trades as number, limit_hits: s.limit_hits as Record<string, number>, outbox: (s.outbox as unknown[]).length };
};

const hits0 = runtimeHits();
log(`watching ${SITE} for ${MIN} min from ${new Date(since).toISOString()}${hits0 ? `; runtime trades so far ${hits0.trades}` : ""}`);
const end = since + MIN * 60_000;
while (Date.now() < end) {
  const f = await api("trades?limit=20&kind=trade").catch(() => ({ records: [] }));
  const n = (f.records as any[]).filter((r) => r.at >= since).length;
  log(`${n} of the last 20 trades are inside the window; ${Math.ceil((end - Date.now()) / 60000)} min left`);
  await Bun.sleep(Math.min(300_000, Math.max(1000, end - Date.now())));
}

// ------------------------------------------------------------------ collect
const all: any[] = [];
let before: number | undefined;
for (;;) {
  const r = await api(`trades?limit=500${before ? `&before=${before}` : ""}`);
  all.push(...r.records);
  if (r.records.length < 500 || r.records[r.records.length - 1].at < since - 86_400_000) break;
  before = r.records[r.records.length - 1].id;
}
all.reverse();
const window = all.filter((r) => r.at >= since && r.at <= end);
const trades = window.filter((r) => r.kind === "trade");
const cfg = await api("trading/config");
const agents = (await api("agents")) as any[];
const byId = new Map(agents.map((a) => [a.agent_id, a]));
const byMint = new Map(agents.filter((a) => a.mint).map((a) => [a.mint, a]));
const parties = (a: any) => new Set([a?.launcher, a?.operator, a?.identity?.owner].filter(Boolean));
const traders = [...new Set(trades.map((t) => t.agent))];
log(`${trades.length} trades by ${traders.length} agents in the window; ${window.length - trades.length} other records`);

check("hosted agents traded in the window", trades.length > 0 && traders.length >= 2, `${trades.length} trades, ${traders.length} agents`);
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
const reader = new ChainReader(rpc);
const signing = new Map<string, string | null>();
for (const a of traders) signing.set(a, (await reader.agent(a))?.signingKey ?? null);

let onChain = 0;
const problems: string[] = [];
const lastIn = new Map<string, any>();
const perEpoch = new Map<number, number>();
for (const t of trades) {
  const tag = `${t.agent.slice(0, 6)} ${t.side} ${t.mint.slice(0, 6)} ${t.signature.slice(0, 8)}`;
  if (!t.rule || !t.reason || typeof t.score?.composite !== "number") problems.push(`${tag}: missing rule, reason or score`);
  // on chain, succeeded, signed by the treasury key = the agent's signing key
  const tx = await rpc.call<any>("getTransaction", [t.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
  const signer = tx?.transaction?.message?.accountKeys?.[0];
  if (!tx || tx.meta?.err) problems.push(`${tag}: not found or failed on chain`);
  else if (signer !== t.treasury?.key || signer !== signing.get(t.agent)) problems.push(`${tag}: signed by ${signer}, treasury ${t.treasury?.key}, agent's signing key ${signing.get(t.agent)}`);
  else onChain++;
  // integrity
  const owner = byMint.get(t.mint);
  if (!owner) problems.push(`${tag}: token of no known agent`);
  else {
    if (owner.agent_id === t.agent) problems.push(`${tag}: own token`);
    const mine = parties(byId.get(t.agent));
    if ([...parties(owner)].some((p) => mine.has(p))) problems.push(`${tag}: same launcher, owner or operator`);
  }
  // limits
  const eq = BigInt(t.equity_before ?? "0");
  if (t.side === "buy") {
    if (BigInt(t.amount_in) * 10_000n > eq * BigInt(cfg.max_trade_bps)) problems.push(`${tag}: above max per trade`);
    if ((BigInt(t.position_before ?? "0") + BigInt(t.amount_in)) * 10_000n > eq * BigInt(cfg.max_position_bps) + 10_000n) problems.push(`${tag}: above max position`);
  }
  if (BigInt(t.amount_out) < BigInt(t.min_out)) problems.push(`${tag}: filled below its minimum out`);
  if (BigInt(t.min_out) * 10_000n < BigInt(t.quote_out) * BigInt(10_000 - cfg.max_slippage_bps) - 10_000n) problems.push(`${tag}: slippage floor looser than the limit`);
  if (t.impact_bps > cfg.max_impact_bps) problems.push(`${tag}: price impact ${t.impact_bps} bps`);
  if (t.treasury?.positions > cfg.max_open_positions) problems.push(`${tag}: ${t.treasury.positions} open positions`);
  const k = `${t.agent}:${t.mint}`;
  const prev = lastIn.get(k) ?? all.filter((r) => r.kind === "trade" && r.agent === t.agent && r.mint === t.mint && r.at < t.at).pop();
  if (prev) {
    if (t.at - prev.at < cfg.cooldown_s * 1000) problems.push(`${tag}: inside the cooldown`);
    if (prev.side !== t.side && t.at - prev.at < cfg.min_hold_s * 1000) problems.push(`${tag}: opposite side inside the minimum hold`);
  }
  lastIn.set(k, t);
  const ep = Math.floor(t.at / (cfg.trade_epoch_s * 1000));
  perEpoch.set(ep, (perEpoch.get(ep) ?? 0) + 1);
}
for (const h of window.filter((r) => r.kind === "halt")) {
  const until = h.rule === "daily_loss" ? Math.floor(h.at / 86_400_000) * 86_400_000 + 86_400_000 : (all.find((r) => r.kind === "reset" && r.agent === h.agent && r.at > h.at)?.at ?? Infinity);
  if (trades.some((t) => t.agent === h.agent && t.at > h.at && t.at < until)) problems.push(`${h.agent.slice(0, 6)}: traded while halted by ${h.rule}`);
}
for (const [ep, n] of perEpoch) if (n > cfg.global_trades_per_epoch) problems.push(`epoch ${ep}: ${n} trades over the global rate`);
check("every trade is on chain, succeeded, and was signed by the agent's treasury (its registry signing key)", onChain === trades.length, `${onChain}/${trades.length}`);
check("every trade within the published limits and integrity rules", problems.length === 0, problems.slice(0, 8).join("; "));
// visible on each agent's page
for (const a of traders) {
  const page = await api(`agents/${a}/trades?limit=500`);
  const sigs = new Set((page.records as any[]).map((r) => r.signature));
  const mine = trades.filter((t) => t.agent === a);
  check(`${a.slice(0, 6)}: every trade on its page`, mine.every((t) => sigs.has(t.signature)), `${mine.length} trades, temperament ${page.temperament.temperament}, halt ${page.halt?.rule ?? "none"}`);
}

// ------------------------------------------------------------------ P&L
const pnl = traders.map((a) => {
  const recs = all.filter((r) => r.agent === a && (r.kind === "trade" || r.kind === "halt") && r.treasury?.equity);
  const inWin = recs.filter((r) => r.at >= since && r.at <= end);
  const first = all.filter((r) => r.agent === a && r.kind === "trade" && r.at < since && r.treasury?.equity).pop() ?? inWin[0];
  const last = inWin[inWin.length - 1];
  const funded = window.filter((r) => r.agent === a && r.kind === "funding" && r.source !== "gas" && (!first || r.at > first.at)).reduce((x, r) => x + BigInt(r.amount), 0n);
  const realized = trades.filter((t) => t.agent === a && typeof t.realized_pnl === "string").reduce((x, t) => x + BigInt(t.realized_pnl), 0n);
  const mine = trades.filter((t) => t.agent === a);
  const fees = mine.reduce((x, t) => x + (t.fee_lamports ?? 0), 0);
  return {
    agent: a,
    trades: mine.length,
    buys: mine.filter((t) => t.side === "buy").length,
    sells: mine.filter((t) => t.side === "sell").length,
    rules: Object.fromEntries([...new Set(mine.map((t) => t.rule))].map((r) => [r, mine.filter((t) => t.rule === r).length])),
    venues: Object.fromEntries([...new Set(mine.map((t) => t.venue))].map((v) => [v, mine.filter((t) => t.venue === v).length])),
    equity_first: first?.treasury?.equity ?? null,
    equity_last: last?.treasury?.equity ?? null,
    funded_between: funded.toString(),
    equity_change_net_of_funding: first && last ? (BigInt(last.treasury.equity) - BigInt(first.treasury.equity) - funded).toString() : null,
    realized_pnl: realized.toString(),
    fee_lamports: fees,
  };
});
for (const p of pnl) log(`${p.agent.slice(0, 6)}: ${p.trades} trades (${p.buys} buys, ${p.sells} sells) ${JSON.stringify(p.rules)}; equity ${p.equity_first} -> ${p.equity_last}, change net of funding ${p.equity_change_net_of_funding}, realized ${p.realized_pnl} base units`);
const hits1 = runtimeHits();
const halts = window.filter((r) => r.kind === "halt").map((h) => ({ agent: h.agent, rule: h.rule, reason: h.reason, at: h.at }));
log(`halts in the window: ${halts.length}; runtime limit refusals ${hits1 ? JSON.stringify(hits1.limit_hits) : "not read"}`);
const pass = results.filter((r) => r.ok).length;
log(`${pass}/${results.length} checks passed`);
writeFileSync(
  join(import.meta.dir, "OBSERVE-LAST.json"),
  JSON.stringify({ site: SITE, window: { from: new Date(since).toISOString(), to: new Date(end).toISOString(), minutes: MIN }, config: cfg, pass, total: results.length, results, trades: trades.length, agents: traders.length, pnl, halts,
    fundings: window.filter((r) => r.kind === "funding").map((f) => ({ agent: f.agent, source: f.source, amount: f.amount, signature: f.signature })),
    runtime_limit_hits_before: hits0?.limit_hits ?? null, runtime_limit_hits_after: hits1?.limit_hits ?? null, problems }, null, 2),
);
process.exit(pass === results.length ? 0 : 1);
