import type { Database } from "bun:sqlite";
import { base58Decode } from "@units/protocol";

// The transactions of an agent's wallet and of its compute vault, as the Talk page lists them
// (docs/plans/AGENT-CONVERSATIONS.md 12). Nothing is scanned for this list alone: the reader of
// messages from people (talk.ts) already fetches every transaction of the agent's wallet since its
// cursor, and each one is classified here from the transaction itself and stored. The compute vault
// (where fees and credits arrive and compute is debited) is read the same way with its own cursor.
//
//   direction  In when the address ends the transaction with more than it began with, Out when with
//              less: of the coin for the vault (a token account), of SOL for the wallet, or of a token
//              the wallet owns when its SOL did not move beyond the fee
//   what       from the programs the transaction calls: a message to the agent (the memo of talk.ts),
//              a post through units_msg, a trade (pump.fun), the launch program (fees and credits in,
//              compute paid out), the registry (a binding or key change), otherwise a transfer
//   dollars    the reading Core held when the transaction happened, and only then: a transaction read
//              later than 15 minutes after its own time (the first backfill) has no dollar figure
//
// This class needs only a database and a clock, so a preview server can run it without a Core.

export type Scope = "wallet" | "vault";
export type Dir = "in" | "out" | "none";
export type TxKind = "message" | "post" | "trade" | "launch" | "registry" | "transfer";

export interface ProgramIds {
  msg: string;
  registry: string;
  launch: string;
  /** pump.fun programs (curve, AMM) */
  pump: string[];
  memo: string[];
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}
/** getTransaction (encoding "json"), as far as the classifier reads it. */
export interface ActivityTx {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
  meta: {
    err: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    innerInstructions?: { index: number; instructions: { programIdIndex: number }[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
}

export interface Classified {
  dir: Dir;
  kind: TxKind;
  /** SOL the address gained (positive) or lost, in lamports */
  lamports: number;
  /** the token movement shown instead of SOL, when there is one */
  token: { mint: string; delta: string; decimals: number } | null;
  /** who the value came from or went to; null when it cannot be told */
  counterparty: string | null;
  fee_payer: string;
}

const SYSTEM = "11111111111111111111111111111111";

/** What a successful transaction did to `address`, or null for a failed one or one that does not name it. */
export function classifyTx(tx: ActivityTx, address: string, scope: Scope, ids: ProgramIds): Classified | null {
  if (!tx.meta || tx.meta.err) return null;
  const m = tx.transaction.message;
  const keys = [...m.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const idx = keys.indexOf(address);
  if (idx < 0) return null;
  const feePayer = keys[0]!;
  const pre = tx.meta.preBalances ?? [];
  const post = tx.meta.postBalances ?? [];
  const sol = (i: number) => (post[i] ?? 0) - (pre[i] ?? 0);
  const lamports = sol(idx);
  const fee = tx.meta.fee ?? 0;
  // token movements: of the address itself (the vault is a token account), or of accounts the wallet owns
  const bal = (list: TokenBalance[] | null | undefined) => new Map((list ?? []).map((b) => [b.accountIndex, b]));
  const [tp, tq] = [bal(tx.meta.preTokenBalances), bal(tx.meta.postTokenBalances)];
  const deltas: { index: number; mint: string; owner: string | null; delta: bigint; decimals: number }[] = [];
  for (const i of new Set([...tp.keys(), ...tq.keys()])) {
    const a = tp.get(i), b = tq.get(i);
    const d = BigInt(b?.uiTokenAmount.amount ?? "0") - BigInt(a?.uiTokenAmount.amount ?? "0");
    if (d !== 0n) deltas.push({ index: i, mint: (b ?? a)!.mint, owner: (b ?? a)!.owner ?? null, delta: d, decimals: (b ?? a)!.uiTokenAmount.decimals });
  }
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const mine = deltas.filter((d) => (scope === "vault" ? d.index === idx : d.owner === address)).sort((a, b) => (abs(b.delta) > abs(a.delta) ? 1 : -1))[0] ?? null;
  // SOL that moved beyond the fee the address itself paid
  const solMoved = lamports + (feePayer === address ? fee : 0);
  const useToken = !!mine && (scope === "vault" || solMoved === 0);
  const dir: Dir = useToken ? (mine!.delta > 0n ? "in" : "out") : lamports > 0 ? "in" : lamports < 0 ? "out" : "none";
  // the other side: the largest opposite movement of the same asset
  let counterparty: string | null = null;
  if (useToken) {
    const other = deltas.filter((d) => d.mint === mine!.mint && d !== mine && d.delta > 0n !== mine!.delta > 0n).sort((a, b) => (abs(b.delta) > abs(a.delta) ? 1 : -1))[0];
    counterparty = other ? (other.owner ?? keys[other.index] ?? null) : null;
  } else if (dir !== "none") {
    let best = 0;
    for (let i = 0; i < keys.length; i++) {
      if (i === idx) continue;
      const d = sol(i) + (i === 0 ? fee : 0); // the fee payer's own fee is not a payment to anyone
      if (dir === "in" ? d < best : d > best) (best = d), (counterparty = keys[i]!);
    }
  }
  if (!counterparty && feePayer !== address) counterparty = feePayer;
  const programs = new Set<string>();
  for (const ix of m.instructions) if (keys[ix.programIdIndex]) programs.add(keys[ix.programIdIndex]!);
  for (const g of tx.meta.innerInstructions ?? []) for (const ix of g.instructions) if (keys[ix.programIdIndex]) programs.add(keys[ix.programIdIndex]!);
  const has = (p: string | string[]) => (Array.isArray(p) ? p.some((x) => programs.has(x)) : programs.has(p));
  const kind: TxKind = has(ids.msg) ? "post" : has(ids.pump) ? "trade" : has(ids.launch) ? "launch" : has(ids.registry) ? "registry" : "transfer";
  return { dir, kind, lamports, token: useToken ? { mint: mine!.mint, delta: mine!.delta.toString(), decimals: mine!.decimals } : null, counterparty, fee_payer: feePayer };
}

/** The memo texts a transaction's fee payer signed alone (what talk.ts reads a message from). */
export function memosOf(tx: ActivityTx, ids: ProgramIds): string[] {
  const keys = tx.transaction.message.accountKeys;
  const out: string[] = [];
  for (const ix of tx.transaction.message.instructions) {
    if (!ids.memo.includes(keys[ix.programIdIndex] ?? "") || ix.accounts.length !== 1 || ix.accounts[0] !== 0) continue;
    try {
      out.push(new TextDecoder("utf-8", { fatal: true }).decode(base58Decode(ix.data)));
    } catch {
      /* not text */
    }
  }
  return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallet_txs (
  signature TEXT NOT NULL,
  address TEXT NOT NULL,                -- the agent's wallet or its compute vault
  agent TEXT NOT NULL,
  scope TEXT NOT NULL,                  -- wallet | vault
  slot INTEGER NOT NULL,
  at INTEGER NOT NULL,                  -- block time (ms), else when it was read
  dir TEXT NOT NULL,                    -- in | out | none
  kind TEXT NOT NULL,
  lamports INTEGER NOT NULL,
  token_mint TEXT,
  token_delta TEXT,
  token_decimals INTEGER,
  counterparty TEXT,
  fee_payer TEXT NOT NULL,
  note TEXT,                            -- a message's id (talk_messages.id)
  usd REAL,                             -- the value at the transaction's own time, when Core held a reading then
  PRIMARY KEY (signature, address)
);
CREATE INDEX IF NOT EXISTS wallet_txs_agent ON wallet_txs(agent, at);
`;

export interface UsdNow {
  sol_usd: number | null;
  quote_usd: number | null;
  /** the coin the vault holds (the quote coin): only its movements get a dollar figure among tokens */
  quote_mint?: string | null;
}
/** A transaction read later than this after its own time has no dollar figure (the indexer's reach for a stored reading). */
export const USD_REACH_MS = 15 * 60_000;

export interface ActivityRow {
  signature: string;
  scope: Scope;
  at: number;
  dir: Dir;
  kind: TxKind;
  lamports: number;
  token: { mint: string; delta: string; decimals: number } | null;
  counterparty: string | null;
  note: string | null;
  usd: number | null;
}

export class WalletActivity {
  constructor(private db: Database, private now: () => number) {
    this.db.exec(SCHEMA);
  }

  /** Stores what `txs` did to `address`; idempotent. `messageOf` names the message a transaction carried (wallet scope). Returns how many were new. */
  store(agent: string, address: string, scope: Scope, txs: ActivityTx[], ids: ProgramIds, usd: UsdNow | null, messageOf: (signature: string) => string | null = () => null): number {
    let n = 0;
    const now = this.now();
    for (const tx of txs) {
      const sig = tx.transaction.signatures[0]!;
      const c = classifyTx(tx, address, scope, ids);
      if (!c || this.db.query("SELECT 1 FROM wallet_txs WHERE signature = ? AND address = ?").get(sig, address)) continue;
      const at = tx.blockTime ? tx.blockTime * 1000 : now;
      const note = scope === "wallet" ? messageOf(sig) : null;
      const kind: TxKind = note ? "message" : c.kind;
      let value: number | null = null;
      if (usd && Math.abs(now - at) <= USD_REACH_MS) {
        if (c.token) value = usd.quote_usd !== null && (scope === "vault" || (!!usd.quote_mint && usd.quote_mint === c.token.mint)) ? (Math.abs(Number(c.token.delta)) / 10 ** c.token.decimals) * usd.quote_usd : null;
        else if (usd.sol_usd !== null && c.dir !== "none") value = (Math.abs(c.lamports) / 1e9) * usd.sol_usd;
      }
      this.db
        .query("INSERT INTO wallet_txs (signature, address, agent, scope, slot, at, dir, kind, lamports, token_mint, token_delta, token_decimals, counterparty, fee_payer, note, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(sig, address, agent, scope, tx.slot, at, c.dir, kind, c.lamports, c.token?.mint ?? null, c.token?.delta ?? null, c.token?.decimals ?? null, c.counterparty, c.fee_payer, note, value);
      n++;
    }
    return n;
  }

  /**
   * One page, newest first. `filter`: all | in | out | messages | vault (the compute vault only; the
   * others list the wallet and the vault together). `before` is the `next` of the page before.
   */
  list(agent: string, q: { filter?: string; before?: string; limit?: number }): { rows: ActivityRow[]; next: string | null } {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 100));
    const where = ["agent = ?"];
    const args: (string | number)[] = [agent];
    if (q.filter === "in" || q.filter === "out") (where.push("dir = ?"), args.push(q.filter));
    else if (q.filter === "messages") where.push("kind = 'message'");
    else if (q.filter === "vault") where.push("scope = 'vault'");
    const m = /^(\d{1,16}):([A-Za-z0-9]{8,120})$/.exec(q.before ?? "");
    if (m) (where.push("(at < ? OR (at = ? AND signature > ?))"), args.push(Number(m[1]), Number(m[1]), m[2]!));
    type R = { signature: string; scope: Scope; at: number; dir: Dir; kind: TxKind; lamports: number; token_mint: string | null; token_delta: string | null; token_decimals: number | null; counterparty: string | null; note: string | null; usd: number | null };
    const rows = this.db.query<R, (string | number)[]>(`SELECT * FROM wallet_txs WHERE ${where.join(" AND ")} ORDER BY at DESC, signature LIMIT ?`).all(...args, limit + 1);
    const page = rows.slice(0, limit).map((r) => ({
      signature: r.signature, scope: r.scope, at: r.at, dir: r.dir, kind: r.kind, lamports: r.lamports,
      token: r.token_mint ? { mint: r.token_mint, delta: r.token_delta!, decimals: r.token_decimals ?? 0 } : null,
      counterparty: r.counterparty, note: r.note, usd: r.usd,
    }));
    const last = page[page.length - 1];
    return { rows: page, next: rows.length > limit && last ? `${last.at}:${last.signature}` : null };
  }

  /** The coin a vault holds, once one of its movements was read. */
  quoteMint(): string | null {
    return this.db.query<{ m: string }, []>("SELECT token_mint AS m FROM wallet_txs WHERE scope = 'vault' AND token_mint IS NOT NULL LIMIT 1").get()?.m ?? null;
  }
}
void SYSTEM;
