import { Database } from "bun:sqlite";
import type { Decoded } from "./decode.ts";

// SQLite store. Amounts are base-unit integers kept as TEXT (u64 does not fit a JS number safely);
// prices are REAL (tLINE per agent token). Every row a transaction produces is keyed by its
// signature, so re-ingesting a transaction changes nothing.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY, agent TEXT NOT NULL, launcher TEXT NOT NULL, launch_account TEXT NOT NULL,
  name TEXT, symbol TEXT, uri TEXT, decimals INTEGER NOT NULL DEFAULT 6, repo_url TEXT, hosted INTEGER, identity_mode INTEGER,
  created_at INTEGER NOT NULL,
  dbc_config TEXT NOT NULL, dbc_pool TEXT NOT NULL, dbc_base_vault TEXT NOT NULL, dbc_quote_vault TEXT NOT NULL,
  damm_pool TEXT, damm_base_vault TEXT, damm_quote_vault TEXT, position TEXT, position_nft_account TEXT,
  graduated INTEGER NOT NULL DEFAULT 0, awake INTEGER, migrated INTEGER NOT NULL DEFAULT 0,
  fees_claimed TEXT, to_compute TEXT, to_protocol TEXT, debited TEXT, withdrawn TEXT,
  supply TEXT, quote_reserve TEXT, migration_threshold TEXT, sqrt_start_price TEXT, sqrt_price TEXT, spot_price REAL, start_price REAL,
  compute_vault TEXT NOT NULL, compute_balance TEXT,
  holders INTEGER, holders_source TEXT, holders_at INTEGER, state_at INTEGER
);
CREATE TABLE IF NOT EXISTS sources (
  address TEXT PRIMARY KEY, mint TEXT NOT NULL, kind TEXT NOT NULL,
  newest_sig TEXT, newest_slot INTEGER, txs INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER, last_ok_at INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS seen (sig TEXT NOT NULL, mint TEXT NOT NULL, slot INTEGER, time INTEGER, failed INTEGER NOT NULL, PRIMARY KEY (sig, mint));
CREATE TABLE IF NOT EXISTS trades (
  sig TEXT NOT NULL, idx INTEGER NOT NULL, mint TEXT NOT NULL, venue TEXT NOT NULL, slot INTEGER NOT NULL, time INTEGER,
  side TEXT NOT NULL, base_raw TEXT NOT NULL, quote_raw TEXT NOT NULL, base REAL NOT NULL, quote REAL NOT NULL, price REAL NOT NULL,
  spot_after REAL, fee_raw TEXT, trader TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (sig, idx)
);
CREATE INDEX IF NOT EXISTS trades_mint_slot ON trades (mint, slot, idx);
CREATE INDEX IF NOT EXISTS trades_mint_time ON trades (mint, time);
CREATE TABLE IF NOT EXISTS fee_cranks (
  sig TEXT NOT NULL, idx INTEGER NOT NULL, mint TEXT NOT NULL, slot INTEGER NOT NULL, time INTEGER,
  fees_raw TEXT NOT NULL, to_compute_raw TEXT NOT NULL, to_protocol_raw TEXT NOT NULL, pool_fees INTEGER NOT NULL, balance_raw TEXT NOT NULL, awake INTEGER NOT NULL,
  PRIMARY KEY (sig, idx)
);
CREATE INDEX IF NOT EXISTS fee_cranks_mint ON fee_cranks (mint, slot);
CREATE TABLE IF NOT EXISTS events (sig TEXT NOT NULL, mint TEXT NOT NULL, kind TEXT NOT NULL, slot INTEGER NOT NULL, time INTEGER, detail TEXT NOT NULL,
  PRIMARY KEY (sig, mint, kind));
CREATE TABLE IF NOT EXISTS token_accounts (mint TEXT NOT NULL, account TEXT NOT NULL, owner TEXT NOT NULL, amount TEXT NOT NULL, slot INTEGER NOT NULL,
  PRIMARY KEY (mint, account));
CREATE TABLE IF NOT EXISTS holders (mint TEXT NOT NULL, owner TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (mint, owner));
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // columns added after the first layout (CREATE TABLE IF NOT EXISTS keeps an older table as it was)
  const cols = new Set((db.query("PRAGMA table_info(tokens)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("holders_source")) db.exec("ALTER TABLE tokens ADD COLUMN holders_source TEXT");
  return db;
}

/** Stores one decoded transaction for one token, in one SQLite transaction. Idempotent by signature. */
export function storeDecoded(db: Database, mint: string, d: Decoded, decimals: { base: number; quote: number }) {
  const tr = db.prepare(`INSERT OR IGNORE INTO trades (sig, idx, mint, venue, slot, time, side, base_raw, quote_raw, base, quote, price, spot_after, fee_raw,
    trader, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const fc = db.prepare(`INSERT OR IGNORE INTO fee_cranks (sig, idx, mint, slot, time, fees_raw, to_compute_raw, to_protocol_raw, pool_fees, balance_raw, awake)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const ev = db.prepare(`INSERT OR IGNORE INTO events (sig, mint, kind, slot, time, detail) VALUES (?,?,?,?,?,?)`);
  const bal = db.prepare(`INSERT INTO token_accounts (mint, account, owner, amount, slot) VALUES (?,?,?,?,?)
    ON CONFLICT (mint, account) DO UPDATE SET owner = excluded.owner, amount = excluded.amount, slot = excluded.slot WHERE excluded.slot >= token_accounts.slot`);
  const seen = db.prepare(`INSERT OR IGNORE INTO seen (sig, mint, slot, time, failed) VALUES (?,?,?,?,?)`);
  db.transaction(() => {
    for (const t of d.trades) {
      tr.run(t.sig, t.idx, mint, t.venue, t.slot, t.time, t.side, t.baseRaw.toString(), t.quoteRaw.toString(), Number(t.baseRaw) / 10 ** decimals.base,
        Number(t.quoteRaw) / 10 ** decimals.quote, t.price, t.spotAfter, t.feeRaw?.toString() ?? null, t.trader, t.source);
    }
    for (const f of d.fees) {
      fc.run(f.sig, f.idx, mint, f.slot, f.time, f.feesRaw.toString(), f.toComputeRaw.toString(), f.toProtocolRaw.toString(), f.poolFees ? 1 : 0,
        f.balanceRaw.toString(), f.awake ? 1 : 0);
    }
    for (const e of d.events) ev.run(e.sig, mint, e.kind, e.slot, e.time, JSON.stringify(e.detail));
    for (const b of d.balances) bal.run(mint, b.account, b.owner, b.amountRaw.toString(), d.slot);
    seen.run(d.sig, mint, d.slot, d.time, d.failed ? 1 : 0);
  })();
}
