#!/usr/bin/env bun
// Lineage market indexer (docs/plans/LAUNCHPAD-AND-LIVE.md L2).
//
//   bun packages/indexer/src/main.ts [--port 9668] [--host 127.0.0.1] [--db <file>] [--interval 15]
//     [--min-gap-ms 250] [--holders-every 600] [--max-idle 300] [--no-ws] [--once]
//
// --interval: seconds between passes and the poll interval of an active source; a source with nothing
// new is polled less often (doubling up to --max-idle seconds) unless logsSubscribe reports activity.
//
// RPC: packages/chain's resolver (LINEAGE_DEVNET_RPC, ~/.config/lineage/rpc.env, else public devnet).
// The URL is never printed (redactRpc). --once runs one full pass and exits (no HTTP server).
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Rpc } from "@lineage/chain";
import { devnetRpcUrl, redactRpc } from "@lineage/chain/src/endpoint.ts";
import { marketApi } from "./api.ts";
import { openDb } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { throttledTransport } from "./rpc.ts";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const flag = (k: string) => argv.includes(`--${k}`);

const port = Number(arg("port", "9668"));
const host = arg("host", "127.0.0.1");
const dbPath = arg("db", join(process.env.LINEAGE_HOME ?? join(homedir(), ".lineage"), "indexer", "market.db"));
const intervalS = Number(arg("interval", "15"));
const url = devnetRpcUrl();
const rpcShown = redactRpc(url);
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const { transport, stats } = throttledTransport(url, { minGapMs: Number(arg("min-gap-ms", "250")) });
const rpc = new Rpc(transport, "confirmed");
const ix = new Indexer(db, rpc, { holdersEveryS: Number(arg("holders-every", "600")), pollEveryS: Number(arg("interval", "15")),
  maxIdleS: Number(arg("max-idle", "300")), log });
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
    rpc_stats: { calls: stats.calls, errors: stats.errors, http_429: stats.http429, last_error: stats.lastError, last_error_at: stats.lastErrorAt },
    logs_subscribe: ws,
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
      const msg = JSON.parse(String(m.data)) as { id?: number; method?: string; result?: unknown; params?: { subscription?: number } };
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
    for (const { address } of db.query("SELECT address FROM sources").all() as { address: string }[]) {
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
  console.log(JSON.stringify({ ...status(), sources: undefined }, null, 1));
  process.exit(r.errors ? 1 : 0);
}
const handle = marketApi(db, status);
Bun.serve({ port, hostname: host, fetch: (req) => handle(req) });
log(`listening on http://${host}:${port}/market/tokens`);
if (!flag("no-ws")) subscribeLogs();
await loop();
