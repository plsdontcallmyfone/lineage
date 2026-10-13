import type { Database } from "bun:sqlite";
import { PUMP, readJupiterUsd, readQuotePair, type Address, type QuotePair } from "@units/chain";

// The quote coin's US dollar price: the ONE place it is computed (owner 2026-10-12: "everything needs
// to be denominated in USD"). It lives in the indexer because the indexer already holds the RPC, knows
// the quote mint from the launch program's config, prices every agent token in that coin, and serves
// the rows every page reads; Core and the pages take the price from here (GET /market/quote-usd and the
// *_usd fields), never from a multiplication of their own.
//
//   agent token price in the quote coin        (the indexer's rows, as before)
//   x quote coin price in its pair asset       (chain: its pump.fun curve, or PumpSwap pool after migration)
//   x pair asset price in USD                  (Jupiter Price API V3, the /chain/sol-price source)
//
// A reading is refreshed about every REFRESH_S and served, with the time it was read, for at most
// MAX_AGE_S; after that there is no price and every USD field is null ("$ unavailable" on the pages),
// never an old or guessed number. Each reading is also kept in quote_usd_samples (one per SAMPLE_S
// bucket) so trades, candles and fee records can be converted at the price of their own time.

export const REFRESH_S = 45;
export const MAX_AGE_S = 300;
export const SAMPLE_S = 300;
/** a stored sample prices an event at most this long after it was read */
export const SAMPLE_REACH_S = 900;
/** the pair asset's USD price must sit in this band (a wrong feed answer is refused, not shown) */
const PAIR_BAND = { min: 1e-9, max: 1e7 };

export const USD_SCHEMA = `CREATE TABLE IF NOT EXISTS quote_usd_samples (t INTEGER PRIMARY KEY, usd REAL NOT NULL, pair_usd REAL NOT NULL, pair_per_quote REAL NOT NULL, venue TEXT NOT NULL);`;

export type QuoteUsdReading =
  | { ok: true; usd: number; read_at: number; age_s: number; max_age_s: number; quote_mint: string; pair_mint: string; pair: string; pair_per_quote: number;
      pair_usd: number; sol_usd: number | null; venue: "curve" | "pool"; account: string; sources: { pair_per_quote: string; pair_usd: string } }
  | { ok: false; reason: string; read_at: number | null; max_age_s: number };

export interface QuoteUsdOpts {
  /** the quote mint and its decimals, null until the indexer has read the launch config */
  quote: () => { mint: Address; decimals: number } | null;
  pair?: (mint: Address, decimals: number) => Promise<QuotePair>;
  pairUsd?: (mint: string) => Promise<{ usd: number; block: number }>;
  now?: () => number;
}

/** Holds the latest quote coin USD reading. `refresh` reads chain and Jupiter; `current` never does. */
export class QuoteUsd {
  private last: { usd: number; at: number; mint: string; pair: QuotePair; pairUsd: number; solUsd: number | null; block: number } | null = null;
  private err: string | null = "the USD price has not been read yet";
  private readonly now: () => number;

  constructor(
    readonly db: Database,
    readonly opts: QuoteUsdOpts,
  ) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    db.exec(USD_SCHEMA);
  }

  async refresh(): Promise<QuoteUsdReading> {
    try {
      const q = this.opts.quote();
      if (!q) throw new Error("the quote coin is not known yet (the launch program's config has not been read)");
      if (!this.opts.pair || !this.opts.pairUsd) throw new Error("no USD price reader on this instance");
      const pair = await this.opts.pair(q.mint, q.decimals);
      const p = await this.opts.pairUsd(pair.pairMint);
      if (p.usd < PAIR_BAND.min || p.usd > PAIR_BAND.max) throw new Error("Jupiter's price for the pair asset is outside the accepted band");
      if (this.last && this.last.pair.pairMint === pair.pairMint && p.block < this.last.block) throw new Error("Jupiter's price went back to an older block");
      const usd = pair.pairPerQuote * p.usd;
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("the quote coin's price did not come out as a positive number");
      // SOL/USD rides along for the figures paid in SOL (units account payments): the pair price itself for a SOL-paired coin
      const solUsd = pair.pairMint === PUMP.wsol ? p.usd : await this.opts.pairUsd(PUMP.wsol).then((x) => (x.usd >= PAIR_BAND.min && x.usd <= PAIR_BAND.max ? x.usd : null), () => null);
      const at = this.now();
      this.last = { usd, at, mint: q.mint, pair, pairUsd: p.usd, solUsd, block: p.block };
      this.err = null;
      this.db.query("INSERT OR REPLACE INTO quote_usd_samples (t, usd, pair_usd, pair_per_quote, venue) VALUES (?,?,?,?,?)")
        .run(Math.floor(at / SAMPLE_S) * SAMPLE_S, usd, p.usd, pair.pairPerQuote, pair.venue);
    } catch (e) {
      this.err = (e as Error).message;
    }
    return this.current();
  }

  current(): QuoteUsdReading {
    const l = this.last;
    const age = l ? this.now() - l.at : null;
    if (!l || age! > MAX_AGE_S) return { ok: false, reason: this.err ?? "the last USD price reading is too old", read_at: l?.at ?? null, max_age_s: MAX_AGE_S };
    return {
      ok: true, usd: l.usd, read_at: l.at, age_s: age!, max_age_s: MAX_AGE_S, quote_mint: l.mint, pair_mint: l.pair.pairMint,
      pair: l.pair.pairMint === PUMP.wsol ? "SOL" : l.pair.pairMint, pair_per_quote: l.pair.pairPerQuote, pair_usd: l.pairUsd, sol_usd: l.solUsd, venue: l.pair.venue, account: l.pair.account,
      sources: {
        pair_per_quote: l.pair.venue === "curve" ? "the quote coin's pump.fun bonding curve (virtual reserves)" : "the quote coin's PumpSwap pool (vault balances)",
        pair_usd: "Jupiter Price API V3",
      },
    };
  }
}

/** A QuoteUsd reading chain through `rpc` and Jupiter through `f`. */
export function chainQuoteUsd(db: Database, rpc: Parameters<typeof readQuotePair>[0], quote: QuoteUsdOpts["quote"], f: typeof fetch = fetch): QuoteUsd {
  return new QuoteUsd(db, { quote, pair: (mint, decimals) => readQuotePair(rpc, mint, decimals), pairUsd: (mint) => readJupiterUsd(f, mint) });
}

/** The stored USD price of one quote coin at time `t` (unix seconds): the newest sample at or before it, within `reach` seconds; else null. */
export function usdAt(db: Database, t: number | null | undefined, reach = SAMPLE_REACH_S): number | null {
  if (t == null) return null;
  const r = db.query("SELECT t, usd FROM quote_usd_samples WHERE t <= ? ORDER BY t DESC LIMIT 1").get(t) as { t: number; usd: number } | null;
  return r && t - r.t <= reach ? r.usd : null;
}

/** The stored sample behind `usdAt`: its bucket time and price, or null. */
export function usdSampleAt(db: Database, t: number, reach = SAMPLE_REACH_S): { t: number; usd: number } | null {
  const r = db.query("SELECT t, usd FROM quote_usd_samples WHERE t <= ? ORDER BY t DESC LIMIT 1").get(t) as { t: number; usd: number } | null;
  return r && t - r.t <= reach ? r : null;
}

/** A lookup over the stored samples between `from` and `to` (one query, then binary search): the price at an event's own time, or null. */
export function usdLookup(db: Database, from: number, to: number, reach = SAMPLE_REACH_S): (t: number | null | undefined) => number | null {
  const rows = db.query("SELECT t, usd FROM quote_usd_samples WHERE t >= ? AND t <= ? ORDER BY t").all(from - reach - SAMPLE_S, to) as { t: number; usd: number }[];
  return (t) => {
    if (t == null || !rows.length) return null;
    let lo = 0, hi = rows.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]!.t <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return hit >= 0 && t - rows[hit]!.t <= reach ? rows[hit]!.usd : null;
  };
}

/**
 * The dollar price a market figure of time `t` is converted at (api.ts): the stored reading nearest before it within
 * `reach` seconds, else, when the indexer was not running then, the first one read after it within `reach`. Null when
 * neither exists: the figure then has no dollar value, never today's price in its place.
 */
export function usdNear(db: Database, from: number, to: number, reach = SAMPLE_REACH_S): (t: number | null | undefined) => number | null {
  const rows = db.query("SELECT t, usd FROM quote_usd_samples WHERE t >= ? AND t <= ? ORDER BY t").all(from - reach - SAMPLE_S, to + reach) as { t: number; usd: number }[];
  return (t) => {
    if (t == null || !rows.length) return null;
    let lo = 0, hi = rows.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]!.t <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit >= 0 && t - rows[hit]!.t <= reach) return rows[hit]!.usd;
    const next = rows[hit + 1];
    return next && next.t - t <= reach ? next.usd : null;
  };
}
