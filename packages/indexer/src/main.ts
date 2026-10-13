#!/usr/bin/env bun
// units market indexer (docs/plans/LAUNCHPAD-AND-LIVE.md L2).
//
//   bun packages/indexer/src/main.ts [--port 9668] [--host 127.0.0.1] [--db <file>] [--interval 15]
//     [--min-gap-ms 250] [--holders-every 600] [--max-idle 300] [--no-ws] [--once] [--core http://127.0.0.1:9660] [--core-every 60]
//     [--supply-every 300] [--dev-wallet <address>] [--no-supply]
//
// --interval: seconds between passes and the poll interval of an active source; a source with nothing
// new is polled less often (doubling up to --max-idle seconds) unless logsSubscribe reports activity.
//
// RPC: the network profile's (config/profile.json, UNITS_NETWORK; SPEC 14.10). devnet: packages/chain's
// resolver (UNITS_DEVNET_RPC, ~/.config/lineage/rpc.env, else public devnet); mainnet: the keyed
// UNITS_MAINNET_RPC, no public fallback.
// --supply-every: seconds between supply passes (supply.ts: the quote coin's supply, burns, holders and the developer
// wallet's own coins); --dev-wallet: that wallet, by default the `admin` of the profile's state file.
// The URL is never printed (redactRpc). --once runs one full pass and exits (no HTTP server).
import "../../protocol/src/env-alias.ts"; // first: UNITS_* and LINEAGE_* env names both readable (docs/plans/REBRAND-UNITS.md 3.3)
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Rpc, type Address } from "@units/chain";
import { redactRpc } from "@units/chain/src/endpoint.ts";
import { applyNetworkProfile, rpcUrlFor, stateFor } from "@units/chain/src/profile-node.ts";
import { marketApi } from "./api.ts";
import { syncCore } from "./core-sync.ts";
import { openDb } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { throttledTransport } from "./rpc.ts";
import { SupplyIndexer } from "./supply.ts";
import { chainQuoteUsd, REFRESH_S } from "./usd.ts";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const flag = (k: string) => argv.includes(`--${k}`);

const port = Number(arg("port", "9668"));
const host = arg("host", "127.0.0.1");
const dbPath = arg("db", join((process.env.UNITS_HOME ?? process.env.LINEAGE_HOME) ?? join(homedir(), ".lineage"), "indexer", "market.db"));
const intervalS = Number(arg("interval", "15"));
const profile = applyNetworkProfile();
const url = rpcUrlFor(profile);
const rpcShown = redactRpc(url);
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const { transport, stats } = throttledTransport(url, { minGapMs: Number(arg("min-gap-ms", "250")) });
const rpc = new Rpc(transport, "confirmed");
const ix = new Indexer(db, rpc, { holdersEveryS: Number(arg("holders-every", "600")), pollEveryS: Number(arg("interval", "15")),
  maxIdleS: Number(arg("max-idle", "300")), log });
// supply.ts: its own loop on the same throttled transport; the developer wallet is public (the programs' admin)
const devWallet = arg("dev-wallet", String((stateFor(profile) as { admin?: unknown } | null)?.admin ?? "")) || null;
const supply = new SupplyIndexer(db, rpc, (sig) => ix.getTx(sig), () => (ix.lineMint ? { mint: ix.lineMint, decimals: ix.lineDecimals, tokenProgram: ix.lineTokenProgram } : null),
  { devWallet: devWallet as Address | null, log });
const startedAt = Math.floor(Date.now() / 1000);
let ws: { connected: boolean; subscriptions: number; notifications: number } = { connected: false, subscriptions: 0, notifications: 0 };

function status() {
  const now = Math.floor(Date.now() / 1000);
  const sources = (db.query("SELECT * FROM sources ORDER BY kind, mint").all() as
    { address: string; mint: string; kind: string; newest_sig: string | null; newest_slot: number | null; txs: number; last_poll_at: number | null;
      last_ok_at: number | null; last_error: string | null }[]).map((s) => ({
    address: s.address, mint: s.mint, kind: s.kind, last_indexed_slot: s.newest_slot, last_signature: s.newest_sig, signatures: s.txs,
    last_poll_at: s.last_poll_at, last_ok_at: s.last_ok_at, lag_s: s.last_ok_at ? now - s.last_ok_at : null,
    slot_lag: s.newest_slot != null && ix.headSlot != null ? ix.headSlot - s.newest_slot : null, last_error: s.last_error,
  }));
  const count = (q: string) => (db.query(q).get() as { n: number }).n;
  return {
    ok: ix.lastCycleAt != null && now - ix.lastCycleAt < Math.max(120, intervalS * 6),
    rpc: rpcShown,
    head_slot: ix.headSlot,
    started_at: startedAt,
    last_cycle_at: ix.lastCycleAt,
    last_cycle_ms: ix.lastCycleMs,
    interval_s: intervalS,
    tokens: count("SELECT COUNT(*) AS n FROM tokens"),
    trades: count("SELECT COUNT(*) AS n FROM trades"),
    fee_cranks: count("SELECT COUNT(*) AS n FROM fee_cranks"),
    transactions: count("SELECT COUNT(*) AS n FROM seen"),
    // sources whose last pass failed and that have not completed one for 15 minutes: their coin's trades are behind the chain
    stuck_sources: sources.filter((s) => s.last_error && !/^skipped /.test(s.last_error) && (s.last_ok_at == null || now - s.last_ok_at > 900)).length,
    tx_version_max: ix.txVersion,
    rpc_stats: { calls: stats.calls, errors: stats.errors, http_429: stats.http429, last_error: stats.lastError, last_error_at: stats.lastErrorAt },
    logs_subscribe: ws,
    supply: flag("no-supply") ? null : supply.status(),
    sources,
  };
}

let wake: (() => void) | null = null;
const sleepOrWake = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(() => { wake = null; r(); }, ms);
  wake = () => { clearTimeout(t); wake = null; r(); };
});

/** logsSubscribe on every source: a notification makes that token's sources due and wakes the poll loop (polling stays the source of truth). */
function subscribeLogs() {
  let wsUrl: string;
  try {
    const u = new URL(url);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    wsUrl = u.toString();
  } catch {
    return;
  }
  const subscribed = new Set<string>();
  const byRequest = new Map<number, string>();
  const bySub = new Map<number, string>();
  let sock: WebSocket | null = null;
  let id = 0;
  const open = () => {
    sock = new WebSocket(wsUrl);
    sock.onopen = () => { ws.connected = true; subscribed.clear(); bySub.clear(); sync(); };
    sock.onmessage = (m) => {
      let msg: { id?: number; method?: string; result?: unknown; params?: { subscription?: number } };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return; // a malformed frame from the RPC is ignored (audit A2 OFF-I3); polling still covers it
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.method === "logsNotification") {
        ws.notifications++;
        const address = bySub.get(msg.params?.subscription ?? -1);
        if (address) ix.markDue(address);
        setTimeout(() => wake?.(), 1500);
      } else if (typeof msg.result === "number") {
        ws.subscriptions++;
        const a = byRequest.get(msg.id ?? -1);
        if (a) bySub.set(msg.result, a);
      }
    };
    sock.onclose = () => { ws.connected = false; ws.subscriptions = 0; setTimeout(open, 30_000); };
    sock.onerror = () => {};
  };
  const sync = () => {
    if (!sock || sock.readyState !== 1) return;
    const sources = db.query("SELECT address FROM sources").all() as { address: string }[];
    // a source that left the database (a purged coin, purged.ts): its subscription ends and its address is forgotten
    const live = new Set(sources.map((s) => s.address));
    for (const a of subscribed) if (!live.has(a)) subscribed.delete(a);
    for (const [req, a] of byRequest) if (!live.has(a)) byRequest.delete(req);
    for (const [sub, a] of bySub) {
      if (live.has(a)) continue;
      bySub.delete(sub);
      ws.subscriptions = Math.max(0, ws.subscriptions - 1);
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "logsUnsubscribe", params: [sub] }));
    }
    for (const { address } of sources) {
      if (subscribed.has(address)) continue;
      subscribed.add(address);
      byRequest.set(++id, address);
      sock.send(JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [address] }, { commitment: "confirmed" }] }));
    }
  };
  open();
  setInterval(sync, 60_000);
}

async function loop() {
  for (;;) {
    try {
      const r = await ix.cycle();
      if (r.txs || r.errors) log(`cycle: ${r.txs} new transaction(s), ${r.errors} error(s), ${ix.lastCycleMs} ms`);
    } catch (e) {
      log(`cycle failed: ${(e as Error).message}`);
    }
    await sleepOrWake(intervalS * 1000);
  }
}

log(`indexer: rpc ${rpcShown}, db ${dbPath}`);
if (flag("once")) {
  const r = await ix.cycle();
  log(`once: ${r.txs} new transaction(s), ${r.errors} error(s), ${ix.lastCycleMs} ms`);
  if (!flag("no-supply")) await supply.pass();
  console.log(JSON.stringify({ ...status(), sources: undefined }, null, 1));
  process.exit(r.errors ? 1 : 0);
}
// the quote coin's USD price (usd.ts): read on its own timer, never on a request
const usd = chainQuoteUsd(db, rpc, () => (ix.lineMint ? { mint: ix.lineMint, decimals: ix.lineDecimals } : null));
let usdFailed: string | null = null;
async function usdLoop() {
  for (;;) {
    const r = await usd.refresh();
    const why = r.ok ? null : r.reason;
    if (why !== usdFailed) log(why ? `quote coin USD price: unavailable (${why})` : `quote coin USD price: read (${r.ok ? r.venue : ""}, Jupiter)`);
    usdFailed = why;
    await new Promise((res) => setTimeout(res, (ix.lineMint ? REFRESH_S : 5) * 1000));
  }
}
void usdLoop();
// supply, burns and the developer wallet (supply.ts): a pass about every --supply-every seconds; a history read that
// stopped at its budget goes on at once
let supplyFailed: string | null = null;
async function supplyLoop() {
  const every = Number(arg("supply-every", "300"));
  for (;;) {
    let more = false;
    try {
      more = (await supply.pass()).more;
      if (supplyFailed) log("supply: reading again");
      supplyFailed = null;
    } catch (e) {
      const why = (e as Error).message;
      if (why !== supplyFailed) log(`supply pass failed: ${why}`);
      supplyFailed = why;
    }
    await new Promise((res) => setTimeout(res, (more ? 1 : ix.lineMint ? every : 5) * 1000));
  }
}
if (!flag("no-supply")) void supplyLoop();
const handle = marketApi(db, status, { quote: profile.quote.symbol, usd: () => usd.current() });
// Core: target class, verified generations, latest session and model per agent for the token directory
const core = arg("core", (process.env.UNITS_CORE ?? process.env.LINEAGE_CORE) ?? "http://127.0.0.1:9660").replace(/\/+$/, "");
const coreEvery = Number(arg("core-every", "60"));
const modelCache = new Map<string, { model: string | null; at: number }>();
const coreGet = async (p: string) => {
  const r = await fetch(`${core}${p}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${p.split("?")[0]}: HTTP ${r.status}`);
  return r.json();
};
// a launch Core purged (purged.ts): its rows are gone, so is what this process held of it; counts only, never an id
const onPurge = (p: { mints: number; agents: number; rows: number }) => {
  ix.forgetMissing();
  log(`purge: ${p.rows} row(s) of ${p.mints} coin(s) Core purged were deleted`);
};
let coreFailed = false;
async function coreLoop() {
  for (;;) {
    try {
      const n = await syncCore(db, coreGet, Math.floor(Date.now() / 1000), { modelCache, onPurge });
      if (coreFailed) log(`core sync: ${n} agent(s)`);
      coreFailed = false;
    } catch (e) {
      if (!coreFailed) log(`core sync failed (${core}): ${(e as Error).message}`);
      coreFailed = true;
    }
    await new Promise((r) => setTimeout(r, coreEvery * 1000));
  }
}
if (coreEvery > 0) void coreLoop();
Bun.serve({ port, hostname: host, fetch: (req) => handle(req) });
log(`listening on http://${host}:${port}/market/tokens`);
if (!flag("no-ws")) subscribeLogs();
await loop();
