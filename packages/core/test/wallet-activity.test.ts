import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { base58Encode } from "@units/protocol";
import type { Rpc } from "@units/chain";
import { conversationsOf } from "../src/conversations.ts";
import { generateAgentKey } from "../src/protocol.ts";
import { BACKFILL, formatMemo, talkOf } from "../src/talk.ts";
import { classifyTx, USD_REACH_MS, WalletActivity, type ActivityTx, type ProgramIds } from "../src/wallet-activity.ts";
import { withSoul } from "./conv-scene.ts";
import { expectOk, setup, type Env } from "./helpers.ts";

// The transactions panel of the Talk page (docs/plans/AGENT-CONVERSATIONS.md 12): In and Out, what a
// transaction was, the dollar rule, paging, and the reader that feeds it from the same reads as messages.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const k = () => generateAgentKey().id;
const IDS: ProgramIds = { msg: k(), registry: k(), launch: k(), pump: [k(), k()], memo: ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"] };
const SYS = "11111111111111111111111111111111";
let n = 0;
/** A transaction: `keys`, SOL balances before and after per key, optional token balances, the programs it calls. */
function tx(keys: string[], pre: number[], post: number[], o: { fee?: number; programs?: string[]; inner?: string[]; tokens?: [number, string, string | null, string, string][]; err?: unknown; time?: number; memo?: string } = {}): ActivityTx {
  const all = [...keys, ...(o.programs ?? []), ...(o.inner ?? [])];
  const tok = (i: 3 | 4) => (o.tokens ?? []).map(([accountIndex, mint, owner, a, b]) => ({ accountIndex, mint, ...(owner ? { owner } : {}), uiTokenAmount: { amount: i === 3 ? a : b, decimals: 6 } }));
  return {
    slot: ++n, blockTime: o.time ?? 1_790_000_000 + n,
    transaction: { signatures: [`sig${String(n).padStart(4, "0")}${keys[0]!.slice(0, 40)}`], message: { accountKeys: all, instructions: [
      ...(o.programs ?? []).map((p) => ({ programIdIndex: all.indexOf(p), accounts: p === IDS.memo[0] ? [0] : [0, 1], data: p === IDS.memo[0] ? base58Encode(new TextEncoder().encode(o.memo ?? "")) : "1" })),
    ] } },
    meta: { err: o.err ?? null, fee: o.fee ?? 5000, preBalances: [...pre, ...all.slice(keys.length).map(() => 1)], postBalances: [...post, ...all.slice(keys.length).map(() => 1)], preTokenBalances: tok(3), postTokenBalances: tok(4),
      innerInstructions: o.inner?.length ? [{ index: 0, instructions: o.inner.map((p) => ({ programIdIndex: all.indexOf(p) })) }] : [] },
  };
}

describe("In, Out and what it was", () => {
  const W = k(), P = k(), V = k(), X = k();
  const c = (t: ActivityTx, address = W, scope: "wallet" | "vault" = "wallet") => classifyTx(t, address, scope, IDS);

  test("SOL: a payment in names its sender, a payment out its receiver; the wallet's own fee alone is no payment", () => {
    expect(c(tx([P, W], [9_000_000, 100], [7_995_000, 1_000_100], { programs: [SYS] }))).toMatchObject({ dir: "in", kind: "transfer", lamports: 1_000_000, token: null, counterparty: P });
    expect(c(tx([W, X], [5_000_000, 0], [2_995_000, 2_000_000], { programs: [SYS] }))).toMatchObject({ dir: "out", lamports: -2_005_000, counterparty: X });
    // the wallet signs a post and pays its fee: Out by the fee, a post, with nobody on the other side
    expect(c(tx([W, X], [50_000, 7], [45_000, 7], { programs: [IDS.msg] }))).toMatchObject({ dir: "out", kind: "post", lamports: -5000, counterparty: null });
    // the runtime pays the fee and the wallet only signs: nothing moved for the wallet
    expect(c(tx([P, W], [50_000, 7], [45_000, 7], { programs: [IDS.msg] }))).toMatchObject({ dir: "none", kind: "post", lamports: 0, counterparty: P });
  });

  test("what it was: from the programs called, inner calls included; a failed transaction is nothing", () => {
    const base = (programs: string[], inner: string[] = []) => c(tx([P, W], [9, 1], [8, 2], { programs, inner }))!.kind;
    expect(base([IDS.msg])).toBe("post");
    expect(base([IDS.pump[1]!])).toBe("trade");
    expect(base([IDS.launch])).toBe("launch");
    expect(base([IDS.registry])).toBe("registry");
    expect(base([SYS])).toBe("transfer");
    expect(base([SYS], [IDS.pump[0]!])).toBe("trade");
    expect(c(tx([P, W], [9, 1], [8, 2], { err: { InstructionError: [0, "x"] } }))).toBeNull();
    expect(c(tx([P, X], [9, 1], [8, 2]))).toBeNull(); // does not name the address
  });

  test("the coin: the vault's own balance for the vault, a token account the wallet owns for the wallet", () => {
    const mint = k();
    // fees arrive in the vault from another token account (index 3, owned by X)
    const crank = tx([P, V, W, k()], [9, 2, 2, 2], [8, 2, 2, 2], { programs: [IDS.launch], tokens: [[1, mint, null, "1000000", "3500000"], [3, mint, X, "9000000", "6500000"]] });
    expect(c(crank, V, "vault")).toMatchObject({ dir: "in", kind: "launch", token: { mint, delta: "2500000", decimals: 6 }, counterparty: X });
    const debit = tx([P, V, k()], [9, 2, 2], [8, 2, 2], { programs: [IDS.launch], tokens: [[1, mint, null, "3500000", "500000"], [2, mint, X, "0", "3000000"]] });
    expect(c(debit, V, "vault")).toMatchObject({ dir: "out", token: { delta: "-3000000" }, counterparty: X });
    // a trade: the wallet's SOL goes down and a token account it owns goes up: the SOL is what it paid
    const buy = tx([W, k(), k()], [9_000_000, 0, 0], [7_995_000, 1_000_000, 0], { programs: [IDS.pump[0]!], tokens: [[2, mint, W, "0", "777"]] });
    expect(c(buy)).toMatchObject({ dir: "out", kind: "trade", lamports: -1_005_000, token: null });
    // a token arrives while the wallet's SOL does not move
    const gift = tx([P, W, k(), k()], [9, 2, 2, 2], [8, 2, 2, 2], { tokens: [[2, mint, W, "0", "50"], [3, mint, P, "50", "0"]] });
    expect(c(gift)).toMatchObject({ dir: "in", token: { mint, delta: "50" }, counterparty: P });
  });
});

describe("the store", () => {
  test("dollars only at the transaction's own time; filters; pages that neither repeat nor skip", () => {
    let now = 1_790_000_000_000;
    const a = new WalletActivity(new Database(":memory:"), () => now);
    const [agent, W, V, P] = [k(), k(), k(), k()];
    const mint = k();
    const t0 = Math.floor(now / 1000);
    const fresh = tx([P, W], [9e9, 0], [8e9, 1e9], { time: t0 - 60 });
    const old = tx([P, W], [9e9, 0], [8e9, 1e9], { time: t0 - USD_REACH_MS / 1000 - 60 });
    const out = tx([W, P], [5e9, 0], [3e9, 2e9 - 5000], { time: t0 - 30 });
    const usd = { sol_usd: 100, quote_usd: 0.0002, quote_mint: mint };
    expect(a.store(agent, W, "wallet", [old, fresh, out], IDS, usd, (s) => (s === fresh.transaction.signatures[0] ? "m".repeat(64) : null))).toBe(3);
    expect(a.store(agent, W, "wallet", [old, fresh, out], IDS, usd)).toBe(0); // read again: nothing twice
    const vault = tx([P, V], [9, 2], [8, 2], { time: t0 - 10, programs: [IDS.launch], tokens: [[1, mint, null, "0", "5000000000"]] });
    a.store(agent, V, "vault", [vault], IDS, usd);
    const all = a.list(agent, {}).rows;
    expect(all.map((r) => [r.scope, r.dir, r.kind, r.usd])).toEqual([["vault", "in", "launch", 1], ["wallet", "out", "transfer", 200], ["wallet", "in", "message", 100], ["wallet", "in", "transfer", null]]);
    expect(a.list(agent, { filter: "in" }).rows.length).toBe(3);
    expect(a.list(agent, { filter: "out" }).rows.length).toBe(1);
    expect(a.list(agent, { filter: "messages" }).rows.map((r) => r.note)).toEqual(["m".repeat(64)]);
    expect(a.list(agent, { filter: "vault" }).rows.map((r) => r.token?.delta)).toEqual(["5000000000"]);
    // no reading held: no dollar figure, whatever the time
    a.store(agent, W, "wallet", [tx([P, W], [9e9, 0], [8e9, 1e9], { time: t0 })], IDS, null);
    expect(a.list(agent, { limit: 1 }).rows[0]!.usd).toBeNull();
    const p1 = a.list(agent, { limit: 2 });
    const p2 = a.list(agent, { limit: 2, before: p1.next! });
    const p3 = a.list(agent, { limit: 2, before: p2.next! });
    expect([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.signature)).toEqual(a.list(agent, { limit: 50 }).rows.map((r) => r.signature));
    expect(p3.next).toBeNull();
    expect(a.quoteMint()).toBe(mint);
    void now;
  });
});

describe("the reader and the endpoint", () => {
  test("one read of the wallet serves messages and the list; cursors hold; the first read is bounded; labels and hidden messages", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await withSoul(e, "Wren Halvard");
    const b = await withSoul(e, "Ilse Marrow");
    const person = k();
    const t0 = Math.floor(e.clock.now() / 1000);
    // the chain as the RPC serves it: newest first per address
    const msg = tx([person, a.id], [9e9, 0], [9e9 - 1_005_000, 1_000_000], { time: t0 - 20, programs: [SYS, IDS.memo[0]!], memo: formatMemo(a.id, "What are you working on right now?") });
    (msg.transaction.message as any).header = { numRequiredSignatures: 1 };
    // the transfer instruction of the message, as talk.ts reads it
    const d = new Uint8Array(12);
    new DataView(d.buffer).setUint32(0, 2, true);
    new DataView(d.buffer).setBigUint64(4, 1_000_000n, true);
    msg.transaction.message.instructions[0] = { programIdIndex: msg.transaction.message.accountKeys.indexOf(SYS), accounts: [0, 1], data: base58Encode(d) };
    const fromIlse = tx([b.id, a.id], [9e9, 1_000_000], [8e9, 1e9], { time: t0 - 10, programs: [SYS] });
    const many = Array.from({ length: 60 }, (_, i) => tx([person, a.id], [9e9, 0], [8e9, 5], { time: t0 - 5000 - i }));
    const chain: Record<string, ActivityTx[]> = { [a.id]: [fromIlse, msg, ...many] };
    const calls: string[] = [];
    const rpc = { commitment: "confirmed", call: async (method: string, params: any[]) => {
      calls.push(method);
      if (method === "getSignaturesForAddress") {
        const list = (chain[params[0]] ?? []).map((t) => ({ signature: t.transaction.signatures[0]!, err: null }));
        const until = params[1].until ? list.findIndex((s) => s.signature === params[1].until) : -1;
        return (until >= 0 ? list.slice(0, until) : list).slice(0, params[1].limit);
      }
      return Object.values(chain).flat().find((t) => t.transaction.signatures[0] === params[0]) ?? null;
    } } as unknown as Rpc;
    const t = talkOf(e.core);
    conversationsOf(e.core).setConfig({ people_min_lamports: 1_000_000 });
    // the reader walks the running agents in turn: two passes cover both; only a.id has transactions here
    let r = await t.sync(rpc, 2);
    expect(r.messages).toBe(1);
    // bounded backfill: BACKFILL transactions of the wallet at most, one getTransaction each; 4 signature lists (2 agents, wallet and vault)
    expect(calls.filter((c) => c === "getTransaction").length).toBe(BACKFILL);
    expect(calls.filter((c) => c === "getSignaturesForAddress").length).toBe(4);
    expect(r.rpc_calls).toBe(BACKFILL + 4);
    // a later pass with nothing new: the signature lists only
    calls.length = 0;
    r = await t.sync(rpc, 2);
    expect([r.transactions, r.messages, calls.filter((c) => c === "getTransaction").length]).toEqual([0, 0, 0]);
    // a new transaction: one more read
    chain[a.id]!.unshift(tx([a.id, person], [5e9, 0], [3e9, 2e9 - 5000], { time: t0, programs: [SYS] }));
    calls.length = 0;
    r = await t.sync(rpc, 2);
    expect(calls.filter((c) => c === "getTransaction").length).toBe(1);
    const v = await expectOk<any>(e.anon.get(`/v1/talk/${a.id}/transactions?limit=3`));
    expect(v.wallet).toBe(a.id);
    expect(v.rows.map((x: any) => [x.dir, x.kind, x.counterparty?.address, x.counterparty?.label, x.message?.text ?? null])).toEqual([
      ["out", "transfer", person, null, null],
      ["in", "transfer", b.id, "Ilse Marrow", null],
      ["in", "message", person, null, "What are you working on right now?"],
    ]);
    expect(typeof v.next).toBe("string");
    expect((await expectOk<any>(e.anon.get(`/v1/talk/${a.id}/transactions?filter=messages`))).rows.length).toBe(1);
    expect((await expectOk<any>(e.anon.get(`/v1/talk/${a.id}/transactions?before=${encodeURIComponent(v.next)}&limit=100`))).rows.length).toBe(BACKFILL - 2);
    expect((await e.anon.get(`/v1/talk/${a.id}/transactions?filter=nope`)).status).toBe(400);
    expect((await e.anon.get(`/v1/talk/${k()}/transactions`)).status).toBe(404);
    expect((await expectOk<any>(e.anon.get(`/v1/talk/${b.id}/transactions`))).rows).toEqual([]);
    // a hidden message keeps its row (the transaction is public) without its text
    const id = v.rows[2].message.id;
    await expectOk(e.admin.c.post("/v1/admin/social/hide", { kind: "talk", id, hidden: true, reason: "test" }));
    const h = (await expectOk<any>(e.anon.get(`/v1/talk/${a.id}/transactions?filter=messages`))).rows[0];
    expect([h.message, h.message_hidden]).toEqual([null, true]);
    // switched off: no read at all
    conversationsOf(e.core).setConfig({ people_activity: false });
    calls.length = 0;
    await t.sync(rpc, 2);
    expect(calls.length).toBe(0);
  });
});
