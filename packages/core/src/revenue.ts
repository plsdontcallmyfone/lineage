import type { Core } from "./core.ts";

// Protocol revenue records (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md section 7). What flows
// to protocol-controlled accounts is recorded in three places, and Core keeps a read-only copy of the
// two it does not hold itself so the Analytics route answers from one database:
//
//   market indexer   GET /market/flows?hidden=1: every crank_pump_fees event (FeesCranked: what
//                    the crank paid the agent's compute vault and the registry treasury) and each
//                    token's AgentLaunch counters (debited: what debit_compute moved to the compute sink)
//   identity service GET /identity/payments: the units account payments found in launch transactions
//                    (lamports, recipient, signatures)
//   Core itself      slashes (bond to the reserve) and failed or expired challenges (bond to the reserve)
//
// Core reads the two services once a minute over loopback (UNITS_INDEXER_URL, UNITS_IDENTITY_URL) and
// replaces its copy with the answer, so a record the source no longer has leaves here too. A source
// that does not answer keeps the last copy and says since when it has not answered; a source that was
// never configured is reported as not available, never as zero. Amounts are raw base units as strings
// (quote token for cranks and counters, lamports for payments).
//
// US dollars (owner 2026-10-12): Core prices nothing itself. The indexer's answer carries the quote
// coin's USD price as it read it (packages/indexer/src/usd.ts, the one place: `usd`, with SOL/USD and
// the time of the reading) and, per crank, the price it had stored nearest before the crank's own time
// (`quote_usd`). Core keeps both with its copy; `usd()` hands the reading on while it is fresh.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS revenue_cranks (
  sig TEXT NOT NULL, idx INTEGER NOT NULL, mint TEXT NOT NULL, agent TEXT NOT NULL, venue TEXT NOT NULL,
  time INTEGER,                 -- unix seconds of the transaction (null when the RPC gave no block time)
  fees TEXT NOT NULL, to_compute TEXT NOT NULL, to_protocol TEXT NOT NULL,
  quote_usd REAL,               -- USD per quote coin the indexer had stored nearest before this crank (null: none stored)
  PRIMARY KEY (sig, idx)
);
CREATE TABLE IF NOT EXISTS revenue_tokens (
  mint TEXT PRIMARY KEY, agent TEXT NOT NULL, symbol TEXT, venue TEXT NOT NULL, hosted INTEGER,
  fees_claimed TEXT, to_compute TEXT, to_protocol TEXT, debited TEXT, state_at INTEGER
);
CREATE TABLE IF NOT EXISTS revenue_identity (
  agent TEXT PRIMARY KEY, mint TEXT NOT NULL, launcher TEXT NOT NULL, lamports TEXT NOT NULL, recipient TEXT NOT NULL,
  signatures TEXT NOT NULL,     -- JSON array
  launched_at INTEGER NOT NULL  -- unix seconds of the launch (the payment rides in the launch transactions)
);
CREATE TABLE IF NOT EXISTS revenue_sources (
  source TEXT PRIMARY KEY,      -- indexer | identity
  ok_at INTEGER, tried_at INTEGER, error TEXT,
  meta TEXT                     -- JSON: what the source says about itself (quote token, payment start)
);`;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const U64 = /^\d{1,20}$/;
const MAX_ROWS = 200_000;
/** Core's copy of the indexer's USD reading is used for at most this long after the indexer read it (its own limit is 300 s; Core samples once a minute). */
export const USD_MAX_AGE_S = 420;

export type UsdReading =
  | { ok: true; quote_usd: number; sol_usd: number | null; read_at: number; source: string }
  | { ok: false; reason: string; read_at: number | null };

interface Internals {
  db: Core["db"];
  now(): number;
}

export interface CrankRow {
  sig: string;
  idx: number;
  mint: string;
  agent: string;
  venue: string;
  time: number | null;
  fees: string;
  to_compute: string;
  to_protocol: string;
  /** USD per quote coin at the crank's own time, from the indexer's stored readings; null when it had none */
  quote_usd: number | null;
}
export interface TokenFlowRow {
  mint: string;
  agent: string;
  symbol: string | null;
  venue: string;
  hosted: number | null;
  fees_claimed: string | null;
  to_compute: string | null;
  to_protocol: string | null;
  debited: string | null;
  state_at: number | null;
}
export interface IdentityPaymentRow {
  agent: string;
  mint: string;
  launcher: string;
  lamports: string;
  recipient: string;
  signatures: string[];
  launched_at: number;
}
export interface SourceState {
  source: "indexer" | "identity";
  ok_at: number | null;
  tried_at: number | null;
  error: string | null;
  meta: Record<string, unknown> | null;
}

export interface IndexerFlows {
  quote: string | null;
  quote_mint: string | null;
  quote_decimals: number;
  cranks: CrankRow[];
  tokens: TokenFlowRow[];
  /** the indexer's current reading of the quote coin's USD price; null when it had none (or is an older indexer) */
  usd: { quote_usd: number; sol_usd: number | null; read_at: number } | null;
  usd_reason: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const u64 = (v: unknown) => (typeof v === "string" && U64.test(v) ? v : null);
const venueOf = (v: unknown) => (v === "pump" ? "pump" : "meteora");
const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** The indexer's answer, only the fields kept here; a row that is not well formed is dropped. Null when the answer is not the route's shape. */
export function parseIndexerFlows(v: unknown): IndexerFlows | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.cranks) || !Array.isArray(o.tokens)) return null;
  const dec = typeof o.quote_decimals === "number" && Number.isInteger(o.quote_decimals) && o.quote_decimals >= 0 && o.quote_decimals <= 18 ? o.quote_decimals : null;
  if (dec === null) return null;
  const cranks: CrankRow[] = [];
  for (const x of o.cranks.slice(0, MAX_ROWS) as Record<string, unknown>[]) {
    if (!x || typeof x !== "object") continue;
    const sig = str(x.signature), mint = str(x.mint), agent = str(x.agent);
    const fees = u64(x.fees_raw), c = u64(x.to_compute_raw), p = u64(x.to_protocol_raw);
    if (!sig || !SIG.test(sig) || !mint || !B58.test(mint) || !agent || !B58.test(agent) || fees === null || c === null || p === null) continue;
    const idx = typeof x.idx === "number" && Number.isInteger(x.idx) && x.idx >= 0 ? x.idx : 0;
    const time = typeof x.time === "number" && Number.isInteger(x.time) && x.time > 0 ? x.time : null;
    cranks.push({ sig, idx, mint, agent, venue: venueOf(x.venue), time, fees, to_compute: c, to_protocol: p, quote_usd: pos(x.quote_usd) });
  }
  const tokens: TokenFlowRow[] = [];
  for (const x of o.tokens.slice(0, MAX_ROWS) as Record<string, unknown>[]) {
    if (!x || typeof x !== "object") continue;
    const mint = str(x.mint), agent = str(x.agent);
    if (!mint || !B58.test(mint) || !agent || !B58.test(agent)) continue;
    tokens.push({
      mint, agent, symbol: str(x.symbol)?.slice(0, 40) ?? null, venue: venueOf(x.venue), hosted: x.hosted === true ? 1 : x.hosted === false ? 0 : null,
      fees_claimed: u64(x.fees_claimed_raw), to_compute: u64(x.to_compute_raw), to_protocol: u64(x.to_protocol_raw), debited: u64(x.debited_raw),
      state_at: typeof x.state_at === "number" && Number.isInteger(x.state_at) ? x.state_at : null,
    });
  }
  const u = o.usd && typeof o.usd === "object" ? (o.usd as Record<string, unknown>) : null;
  const rate = u?.ok === true ? pos(u.usd) : null;
  const readAt = typeof u?.read_at === "number" && Number.isInteger(u.read_at) && u.read_at > 0 ? u.read_at : null;
  return {
    quote: str(o.quote)?.slice(0, 20) ?? null, quote_mint: str(o.quote_mint), quote_decimals: dec, cranks, tokens,
    usd: rate !== null && readAt !== null ? { quote_usd: rate, sol_usd: pos(u!.sol_usd), read_at: readAt } : null,
    usd_reason: rate === null ? (str(u?.reason)?.slice(0, 200) ?? (u ? "the indexer gave no USD price" : "the market indexer does not serve a USD price (older release)")) : null,
  };
}

/** The identity service's payments list; a row that is not well formed is dropped. */
export function parseIdentityPayments(v: unknown): { since: number | null; payments: IdentityPaymentRow[] } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.payments)) return null;
  const payments: IdentityPaymentRow[] = [];
  for (const x of o.payments.slice(0, MAX_ROWS) as Record<string, unknown>[]) {
    if (!x || typeof x !== "object") continue;
    const agent = str(x.agent), mint = str(x.mint), launcher = str(x.launcher), recipient = str(x.recipient), lamports = u64(x.lamports);
    if (!agent || !B58.test(agent) || !mint || !B58.test(mint) || !launcher || !B58.test(launcher) || !recipient || !B58.test(recipient) || lamports === null) continue;
    if (typeof x.launched_at !== "number" || !Number.isInteger(x.launched_at) || x.launched_at <= 0) continue;
    const signatures = Array.isArray(x.signatures) ? (x.signatures.filter((s) => typeof s === "string" && SIG.test(s)) as string[]).slice(0, 8) : [];
    payments.push({ agent, mint, launcher, lamports, recipient, signatures, launched_at: x.launched_at });
  }
  return { since: typeof o.since === "number" && Number.isFinite(o.since) ? o.since : null, payments };
}

const instances = new WeakMap<Core, Revenue>();
export function revenueOf(core: Core): Revenue {
  let m = instances.get(core);
  if (!m) instances.set(core, (m = new Revenue(core)));
  return m;
}

export class Revenue {
  private readonly c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
    const cols = new Set((this.c.db.query("PRAGMA table_info(revenue_cranks)").all() as { name: string }[]).map((x) => x.name));
    if (!cols.has("quote_usd")) this.c.db.exec("ALTER TABLE revenue_cranks ADD COLUMN quote_usd REAL");
  }

  /** The quote coin's USD price (and SOL/USD) as the indexer last gave it to Core, while it is fresh; otherwise why there is none. */
  usd(): UsdReading {
    const s = this.source("indexer");
    const m = s?.meta as { usd?: { quote_usd?: unknown; sol_usd?: unknown; read_at?: unknown } | null; usd_reason?: unknown } | null | undefined;
    if (!s?.ok_at) return { ok: false, reason: s?.error ?? "no market indexer configured for this Core (UNITS_INDEXER_URL)", read_at: null };
    const rate = pos(m?.usd?.quote_usd), readAt = typeof m?.usd?.read_at === "number" ? m.usd.read_at : null;
    if (rate === null || readAt === null) return { ok: false, reason: typeof m?.usd_reason === "string" ? m.usd_reason : "the market indexer gave no USD price", read_at: null };
    if (this.c.now() / 1000 - readAt > USD_MAX_AGE_S) return { ok: false, reason: "the last USD price reading is too old", read_at: readAt };
    return { ok: true, quote_usd: rate, sol_usd: pos(m?.usd?.sol_usd), read_at: readAt, source: "market indexer (GET /market/quote-usd): the quote coin's pump.fun market, then Jupiter Price API V3" };
  }

  private mark(source: SourceState["source"], ok: boolean, error: string | null, meta?: Record<string, unknown>) {
    const now = this.c.now();
    this.c.db
      .query(
        `INSERT INTO revenue_sources (source, ok_at, tried_at, error, meta) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (source) DO UPDATE SET ok_at = COALESCE(excluded.ok_at, ok_at), tried_at = excluded.tried_at, error = excluded.error, meta = COALESCE(excluded.meta, meta)`,
      )
      .run(source, ok ? now : null, now, error ? error.slice(0, 300) : null, meta ? JSON.stringify(meta) : null);
  }

  /** Replaces Core's copy of the indexer's cranks and token counters with this answer. */
  recordIndexer(f: IndexerFlows) {
    const db = this.c.db;
    db.transaction(() => {
      db.exec("DELETE FROM revenue_cranks; DELETE FROM revenue_tokens;");
      const c = db.query("INSERT OR REPLACE INTO revenue_cranks (sig, idx, mint, agent, venue, time, fees, to_compute, to_protocol, quote_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const r of f.cranks) c.run(r.sig, r.idx, r.mint, r.agent, r.venue, r.time, r.fees, r.to_compute, r.to_protocol, r.quote_usd ?? null);
      const t = db.query("INSERT OR REPLACE INTO revenue_tokens (mint, agent, symbol, venue, hosted, fees_claimed, to_compute, to_protocol, debited, state_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const r of f.tokens) t.run(r.mint, r.agent, r.symbol, r.venue, r.hosted, r.fees_claimed, r.to_compute, r.to_protocol, r.debited, r.state_at);
      this.mark("indexer", true, null, { quote: f.quote, quote_mint: f.quote_mint, quote_decimals: f.quote_decimals, usd: f.usd ?? null, usd_reason: f.usd_reason ?? null });
    })();
    return { ok: true, cranks: f.cranks.length, tokens: f.tokens.length };
  }

  /** Replaces Core's copy of the identity service's payments with this answer. */
  recordIdentity(p: { since: number | null; payments: IdentityPaymentRow[] }) {
    const db = this.c.db;
    db.transaction(() => {
      db.exec("DELETE FROM revenue_identity");
      const q = db.query("INSERT OR REPLACE INTO revenue_identity (agent, mint, launcher, lamports, recipient, signatures, launched_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const r of p.payments) q.run(r.agent, r.mint, r.launcher, r.lamports, r.recipient, JSON.stringify(r.signatures), r.launched_at);
      this.mark("identity", true, null, { since: p.since });
    })();
    return { ok: true, payments: p.payments.length };
  }

  /** Reads both services once; one that does not answer keeps its last copy and records why. */
  async sample(urls: { indexer?: string | null; identity?: string | null }, fetchImpl: typeof fetch = fetch) {
    const read = async (base: string, path: string) => {
      const r = await fetchImpl(`${base.replace(/\/+$/, "")}${path}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`answered ${r.status}`);
      return (await r.json()) as unknown;
    };
    const out: Record<string, unknown> = {};
    if (urls.indexer) {
      try {
        const f = parseIndexerFlows(await read(urls.indexer, "/market/flows?hidden=1"));
        if (!f) throw new Error("answer not understood");
        out.indexer = this.recordIndexer(f);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.mark("indexer", false, error);
        out.indexer = { ok: false, error };
      }
    }
    if (urls.identity) {
      try {
        const p = parseIdentityPayments(await read(urls.identity, "/identity/payments"));
        if (!p) throw new Error("answer not understood");
        out.identity = this.recordIdentity(p);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.mark("identity", false, error);
        out.identity = { ok: false, error };
      }
    }
    return out;
  }

  source(source: SourceState["source"]): SourceState | null {
    const r = this.c.db.query<{ ok_at: number | null; tried_at: number | null; error: string | null; meta: string | null }, [string]>("SELECT ok_at, tried_at, error, meta FROM revenue_sources WHERE source = ?").get(source);
    if (!r) return null;
    let meta: Record<string, unknown> | null = null;
    try {
      meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null;
    } catch {
      meta = null;
    }
    return { source, ok_at: r.ok_at, tried_at: r.tried_at, error: r.error, meta };
  }

  cranks(): CrankRow[] {
    return this.c.db.query<CrankRow, []>("SELECT sig, idx, mint, agent, venue, time, fees, to_compute, to_protocol, quote_usd FROM revenue_cranks ORDER BY time, sig, idx").all();
  }

  tokens(): TokenFlowRow[] {
    return this.c.db.query<TokenFlowRow, []>("SELECT mint, agent, symbol, venue, hosted, fees_claimed, to_compute, to_protocol, debited, state_at FROM revenue_tokens ORDER BY mint").all();
  }

  payments(): IdentityPaymentRow[] {
    return this.c.db
      .query<Omit<IdentityPaymentRow, "signatures"> & { signatures: string }, []>("SELECT agent, mint, launcher, lamports, recipient, signatures, launched_at FROM revenue_identity ORDER BY launched_at, agent")
      .all()
      .map((r) => {
        let signatures: string[] = [];
        try {
          signatures = JSON.parse(r.signatures) as string[];
        } catch {
          signatures = [];
        }
        return { ...r, signatures };
      });
  }
}
