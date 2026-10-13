#!/usr/bin/env bun
// A read-only stand-in for Core, for looking at the Talk page with live mainnet data before the build
// is deployed: every Core read is passed to the live site, except the Talk routes, which run this
// tree's code: the eligibility rule over the site's own reports, and the transactions list read from
// mainnet (the agent's wallet and compute vault, at most BACKFILL transactions each, classified by
// wallet-activity.ts). Nothing is signed or sent; the RPC is the network profile's (never printed).
//   bun scripts/conversations/live-preview.ts [--port 9667] [--site https://...]
//   bun apps/web/server.ts --port 9666 --site <site> --core http://127.0.0.1:9667 --market <site> --upstream <site>
import { Database } from "bun:sqlite";
import { LAUNCH_PROGRAM_ID, launchPdas, MSG_PROGRAM_ID, PUMP, REGISTRY_PROGRAM_ID, Rpc } from "@units/chain";
import { applyNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { BACKFILL, MEMO_PROGRAMS } from "../../packages/core/src/talk.ts";
import { WalletActivity, type ActivityTx } from "../../packages/core/src/wallet-activity.ts";

const arg = (k: string, d: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(arg("port", "9667"));
const SITE = arg("site", "https://main-157-245-71-188.sslip.io");
const profile = applyNetworkProfile();
if (profile.network !== "mainnet") throw new Error("the active profile is not mainnet");
const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
const ids = { msg: MSG_PROGRAM_ID, registry: REGISTRY_PROGRAM_ID, launch: LAUNCH_PROGRAM_ID, pump: [PUMP.program, PUMP.amm], memo: MEMO_PROGRAMS };
const activity = new WalletActivity(new Database(":memory:"), () => Date.now());
const site = async (path: string) => (await fetch(`${SITE}/api/${path}`)).json() as Promise<any>;
const read = new Map<string, Promise<{ calls: number; transactions: number }>>();

/** The agent's wallet and vault, read once: one getSignaturesForAddress and at most BACKFILL getTransaction per address. */
function load(agent: string, wallet: string): Promise<{ calls: number; transactions: number }> {
  if (!read.has(agent))
    read.set(agent, (async () => {
      let calls = 0, transactions = 0;
      for (const [address, scope] of [[wallet, "wallet"], [launchPdas.computeVault(agent), "vault"]] as const) {
        const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [address, { limit: BACKFILL, commitment: "confirmed" }]);
        calls++;
        const txs: ActivityTx[] = [];
        for (const s of sigs.reverse()) {
          if (s.err) continue;
          const tx = await rpc.call<ActivityTx | null>("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
          calls++;
          if (tx) txs.push(tx);
        }
        transactions += activity.store(agent, address, scope, txs, ids, null); // a backfill: no reading of their own time, so no dollar figure
      }
      console.log(`read ${agent.slice(0, 8)}: ${calls} RPC calls, ${transactions} transactions stored`);
      return { calls, transactions };
    })());
  return read.get(agent)!;
}

let board: { at: number; body: any } | null = null;
async function talkBoard() {
  if (board && Date.now() - board.at < 30_000) return board.body;
  const b = await site("talk");
  // this tree's rule: an agent the runtime reports as not bound is not running
  const keep = [];
  for (const a of b.agents as { agent: string }[]) {
    const s = await site(`agents/${a.agent}/spend`).catch(() => null);
    if (s?.spend?.bound !== false) keep.push(a);
  }
  board = { at: Date.now(), body: { ...b, agents: keep } };
  return board.body;
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method !== "GET") return Response.json({ error: "read_only" }, { status: 405 });
    try {
      if (u.pathname === "/v1/talk") return Response.json(await talkBoard());
      const m = /^\/v1\/talk\/([1-9A-HJ-NP-Za-km-z]{32,44})\/transactions$/.exec(u.pathname);
      if (m) {
        const a = ((await talkBoard()).agents as { agent: string; wallet: string | null; name: string | null }[]).find((x) => x.agent === m[1]);
        if (!a?.wallet) return Response.json({ error: "not_found" }, { status: 404 });
        await load(a.agent, a.wallet);
        const page = activity.list(a.agent, { filter: u.searchParams.get("filter") ?? undefined, before: u.searchParams.get("before") ?? undefined, limit: Number(u.searchParams.get("limit") ?? 20) });
        const names = new Map(((await talkBoard()).agents as { wallet: string | null; name: string | null }[]).filter((x) => x.wallet && x.wallet !== a.wallet).map((x) => [x.wallet!, x.name]));
        const label = (addr: string) => (addr === a.wallet ? "the agent's wallet" : addr === launchPdas.computeVault(a.agent) ? "its compute vault" : (names.get(addr) ?? null));
        return Response.json({ agent: a.agent, wallet: a.wallet, vault: launchPdas.computeVault(a.agent), synced_at: Date.now(), next: page.next,
          rows: page.rows.map((r) => ({ ...r, note: undefined, counterparty: r.counterparty ? { address: r.counterparty, label: label(r.counterparty) } : null, message: null, message_hidden: false })) });
      }
      const res = await fetch(`${SITE}/api/${u.pathname.replace(/^\/v1\//, "")}${u.search}`, { headers: { accept: req.headers.get("accept") ?? "*/*" } });
      return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
    } catch (e) {
      return Response.json({ error: "preview", message: String((e as Error).message).replace(/https?:\/\/\S+/g, "[url]") }, { status: 502 });
    }
  },
});
console.log(`live preview of Core on http://127.0.0.1:${PORT} (reads from ${SITE}; Talk routes from this tree)`);
