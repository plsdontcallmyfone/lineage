import type { Database } from "bun:sqlite";

// Double-entry ledger (SPEC 18). Every movement is one transaction of exactly two rows whose deltas
// sum to zero. `balances` is a cache of the per-account sums that reconcile() proves correct.
//
// Accounts:
//   agent:<id>:wallet    agent (or launcher) wallet
//   agent:<id>:bond      bond vault share of an agent (slashable)
//   agent:<id>:compute   agent compute vault (agent token fees, author rewards by default)
//   wallet:<address>     a launcher wallet that is not itself an agent
//   burned               registration burns
//   treasury             creator rewards and protocol share of agent token fees, before the split
//   reserve              compute reserve: slashes, rebates, hosted runtime usage
//   pool                 epoch pool
//   epoch:<n>:payable    closed epoch payouts awaiting claim
//   faucet               M1 mint: the only account allowed to go negative (it stands for supply
//                        that exists outside the simulated system)

export const ACC = {
  wallet: (id: string) => `agent:${id}:wallet`,
  bond: (id: string) => `agent:${id}:bond`,
  compute: (id: string) => `agent:${id}:compute`,
  extWallet: (addr: string) => `wallet:${addr}`,
  burned: "burned",
  treasury: "treasury",
  reserve: "reserve",
  pool: "pool",
  payable: (n: number) => `epoch:${n}:payable`,
  faucet: "faucet",
} as const;

export const NEGATIVE_OK = new Set<string>([ACC.faucet]);

export class LedgerError extends Error {}

export class Ledger {
  constructor(
    private db: Database,
    private now: () => number,
  ) {}

  balance(account: string): bigint {
    const row = this.db.query<{ amount: string }, [string]>("SELECT amount FROM balances WHERE account = ?").get(account);
    return row ? BigInt(row.amount) : 0n;
  }

  /** Moves `amount` from one account to another. Must be called inside a database transaction. */
  transfer(from: string, to: string, amount: bigint, reason: string, ref: string | null = null): number | null {
    if (amount < 0n) throw new LedgerError("negative transfer");
    if (amount === 0n) return null;
    if (from === to) throw new LedgerError("transfer to same account");
    const fromBal = this.balance(from);
    if (!NEGATIVE_OK.has(from) && fromBal < amount)
      throw new LedgerError(`insufficient balance in ${from}: have ${fromBal}, need ${amount}`);
    const at = this.now();
    const tx =
      (this.db.query<{ t: number }, []>("SELECT tx AS t FROM ledger_entries ORDER BY id DESC LIMIT 1").get()?.t ?? 0) + 1;
    const ins = this.db.query("INSERT INTO ledger_entries (tx, account, delta, reason, ref, at) VALUES (?, ?, ?, ?, ?, ?)");
    ins.run(tx, from, (-amount).toString(), reason, ref, at);
    ins.run(tx, to, amount.toString(), reason, ref, at);
    this.setBalance(from, fromBal - amount);
    this.setBalance(to, this.balance(to) + amount);
    return tx;
  }

  private setBalance(account: string, amount: bigint) {
    this.db
      .query("INSERT INTO balances (account, amount) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET amount = excluded.amount")
      .run(account, amount.toString());
  }

  balances(prefix?: string): Record<string, string> {
    const rows = prefix
      ? this.db.query<{ account: string; amount: string }, [string]>("SELECT account, amount FROM balances WHERE account LIKE ? ORDER BY account").all(prefix + "%")
      : this.db.query<{ account: string; amount: string }, []>("SELECT account, amount FROM balances ORDER BY account").all();
    return Object.fromEntries(rows.map((r) => [r.account, r.amount]));
  }

  entries(account?: string, limit = 500): { id: number; tx: number; account: string; delta: string; reason: string; ref: string | null; at: number }[] {
    type Row = { id: number; tx: number; account: string; delta: string; reason: string; ref: string | null; at: number };
    return account
      ? this.db.query<Row, [string, number]>("SELECT * FROM ledger_entries WHERE account = ? ORDER BY id DESC LIMIT ?").all(account, limit)
      : this.db.query<Row, [number]>("SELECT * FROM ledger_entries ORDER BY id DESC LIMIT ?").all(limit);
  }

  /**
   * Replays every entry in order and proves: each transaction has two rows summing to zero, the
   * whole ledger sums to zero, no account other than the faucet ever went negative, and the cached
   * balances equal the replayed sums.
   */
  reconcile(): ReconcileReport {
    const errors: string[] = [];
    const running = new Map<string, bigint>();
    const txSums = new Map<number, { sum: bigint; rows: number }>();
    let total = 0n;
    let count = 0;
    const it = this.db
      .query<{ tx: number; account: string; delta: string }, []>("SELECT tx, account, delta FROM ledger_entries ORDER BY id")
      .iterate();
    let lastTx = -1;
    let touched: string[] = [];
    const checkTouched = () => {
      for (const acc of touched) {
        const bal = running.get(acc)!;
        if (bal < 0n && !NEGATIVE_OK.has(acc)) errors.push(`account ${acc} negative (${bal}) after tx ${lastTx}`);
      }
      touched = [];
    };
    for (const e of it) {
      count++;
      const d = BigInt(e.delta);
      // the rows of one transaction are adjacent; balances are checked once it is complete
      if (e.tx !== lastTx && lastTx !== -1) checkTouched();
      lastTx = e.tx;
      const t = txSums.get(e.tx) ?? { sum: 0n, rows: 0 };
      t.sum += d;
      t.rows++;
      txSums.set(e.tx, t);
      running.set(e.account, (running.get(e.account) ?? 0n) + d);
      touched.push(e.account);
      total += d;
    }
    if (lastTx !== -1) checkTouched();
    for (const [tx, t] of txSums) {
      if (t.sum !== 0n) errors.push(`tx ${tx} sums to ${t.sum}`);
      if (t.rows !== 2) errors.push(`tx ${tx} has ${t.rows} rows`);
    }
    if (total !== 0n) errors.push(`ledger sums to ${total}`);
    const cached = this.balances();
    const accounts = new Set([...running.keys(), ...Object.keys(cached)]);
    for (const a of accounts) {
      const r = running.get(a) ?? 0n;
      const c = BigInt(cached[a] ?? "0");
      if (r !== c) errors.push(`balance cache for ${a} is ${c}, entries sum to ${r}`);
    }
    return {
      ok: errors.length === 0,
      errors,
      entries: count,
      transactions: txSums.size,
      total: total.toString(),
      balances: Object.fromEntries([...running.entries()].sort().map(([k, v]) => [k, v.toString()])),
    };
  }
}

export interface ReconcileReport {
  ok: boolean;
  errors: string[];
  entries: number;
  transactions: number;
  total: string;
  balances: Record<string, string>;
}
