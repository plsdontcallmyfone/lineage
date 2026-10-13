import type { Database } from "bun:sqlite";
import { ensureCoreSchema } from "./core-sync.ts";
import { SAMPLE_REACH_S, SAMPLE_S, USD_SCHEMA, usdLookup, usdSampleAt, type QuoteUsdReading } from "./usd.ts";

// Read API (docs/plans/LAUNCHPAD-AND-LIVE.md L2), JSON with CORS *. Agent tokens trade on pump.fun
// (owner decisions 2026-10-10); a token from the earlier Meteora venue is listed with venue "meteora"
// and read_only true (devnet history, no new trades). Prices are $UNITS per agent
// token; amounts are UI units (numbers) with the exact base units next to them as strings ("_raw").
// Times are unix seconds. Nothing is estimated: a figure the chain has not produced yet is null.
//
// US dollars (owner 2026-10-12): every money figure also comes as a "_usd" field, the quote-coin figure
// times the quote coin's USD price from usd.ts (the one place that price is read). Current figures use
// the current reading; a trade, candle or fee record uses the reading stored nearest before its own
// time when there is one ("usd_basis": "at_time") and the current reading otherwise ("current"). With
// no reading every "_usd" field is null and "usd" says why: never a quote-coin number in its place.

const TF: Record<string, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "content-type" };

interface CoreRow { agent: string; class: string | null; lineage_id: string | null; repo: string | null; model: string | null; provider: string | null;
  generations: number; session_id: string | null; session_state: string | null; session_at: number | null; name: string | null; tagline: string | null;
  avatar: string | null; session_file: string | null; last_gen: string | null; last_lineage: string | null; last_metric: string | null; last_ratio: number | null;
  last_fixed: number | null; last_at: number | null; covered?: number | null }

export interface StatusSource {
  (): Record<string, unknown>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const ui = (raw: string | null | undefined, decimals: number) => (raw == null ? null : Number(BigInt(raw)) / 10 ** decimals);
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface TokRow {
  mint: string; agent: string; launcher: string; launch_account: string; name: string | null; symbol: string | null; uri: string | null; decimals: number;
  repo_url: string | null; hosted: number | null; identity_mode: number | null; created_at: number; dbc_config: string; dbc_pool: string;
  dbc_base_vault: string; dbc_quote_vault: string; damm_pool: string | null; damm_base_vault: string | null; damm_quote_vault: string | null;
  position: string | null; position_nft_account: string | null; graduated: number; awake: number | null; migrated: number;
  fees_claimed: string | null; to_compute: string | null; to_protocol: string | null; debited: string | null; withdrawn: string | null;
  supply: string | null; quote_reserve: string | null; migration_threshold: string | null; spot_price: number | null; start_price: number | null;
  compute_vault: string; compute_balance: string | null; holders: number | null; holders_source: string | null; holders_at: number | null; state_at: number | null;
  venue: string; pump_creator: string | null; progress: number | null; creator_fee_income: string | null;
}

// CORS for configured origins (embed kit, docs/EMBED.md): with UNITS_CORS_ORIGINS unset every answer
// keeps `*`; set (comma separated, `*` wildcards such as https://*.vercel.app), only listed origins
// get CORS headers, echoed back. The API is read-only either way.
export function corsFor(origin: string | null, env = (process.env.UNITS_CORS_ORIGINS ?? process.env.LINEAGE_CORS_ORIGINS)): Record<string, string> {
  const list = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return CORS;
  const ok = !!origin && list.some((o) => o === "*" || new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(origin));
  return ok ? { ...CORS, "access-control-allow-origin": origin!, vary: "Origin" } : { vary: "Origin" };
}

export function marketApi(db: Database, status: StatusSource, opts: { now?: () => number; corsOrigins?: string; quote?: string; usd?: () => QuoteUsdReading } = {}) {
  const handle = marketHandler(db, status, opts);
  return async function withCors(req: Request): Promise<Response> {
    const res = await handle(req);
    const h = corsFor(req.headers.get("origin"), opts.corsOrigins ?? (process.env.UNITS_CORS_ORIGINS ?? process.env.LINEAGE_CORS_ORIGINS));
    for (const k of Object.keys(CORS)) res.headers.delete(k);
    for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
    return res;
  };
}

function marketHandler(db: Database, status: StatusSource, opts: { now?: () => number; quote?: string; usd?: () => QuoteUsdReading } = {}) {
  db.exec(USD_SCHEMA);
  const usdNow = (): QuoteUsdReading => opts.usd?.() ?? { ok: false, reason: "no USD price reader on this instance", read_at: null, max_age_s: 0 };
  /** quote-coin figure to USD at `rate`; null when either is missing */
  const inUsd = (v: number | null | undefined, rate: number | null) => (v == null || rate == null ? null : v * rate);
  // the quote token's symbol under the network profile (SPEC 14.10)
  const QUOTE = opts.quote ?? "UNITS";
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const lineDecimals = () => Number((db.query("SELECT v FROM meta WHERE k = 'line_decimals'").get() as { v: string } | null)?.v ?? 6);
  ensureCoreSchema(db);
  const coreOf = (agent: string) => db.query("SELECT * FROM core_agents WHERE agent = ?").get(agent) as CoreRow | null;
  const hiddenOf = (mint: string) => db.query("SELECT reason, added_at FROM hidden_mints WHERE mint = ?").get(mint) as { reason: string; added_at: number | null } | null;

  /** Token directory fields (FRONTEND-EMBED.md amendment 2): chain state plus what Core says about the agent. */
  function directory(t: TokRow) {
    const c = coreOf(t.agent);
    const awake = t.awake == null ? null : t.awake === 1;
    const working = c?.session_state === "live";
    // network compute: asleep on chain, and the network pays for its attempts (Core's compute_covered); `awake` stays the chain's
    const covered = c?.covered === 1;
    return {
      fees_to_compute: ui(t.to_compute, lineDecimals()),
      awake,
      covered,
      state: working ? "working" : t.graduated ? "graduated" : awake === null ? null : awake ? "awake" : covered ? "covered" : "asleep",
      class: c?.class ?? null,
      model: c?.model ?? null,
      provider: c?.provider ?? null,
      generations: c ? c.generations : null,
      lineage_id: c?.lineage_id ?? null,
      session: c?.session_id ? { id: c.session_id, state: c.session_state, at: c.session_at } : null,
      // the agent's public face (its soul and the launcher's avatar) and what it is building
      // (APP-CONSOLIDATION amendment 2): the repository, the file a running session last touched, and
      // its latest verified improvement; all read from Core, null where Core has nothing
      agent_name: c?.name ?? null,
      tagline: c?.tagline ?? null,
      avatar: c?.avatar ?? null,
      building: c
        ? {
            repo: c.repo ?? t.repo_url,
            live: working,
            session_id: c.session_id,
            file: working ? c.session_file : null,
            last: c.last_gen
              ? { gen_id: c.last_gen, lineage_id: c.last_lineage, metric: c.last_metric, ratio: c.last_ratio, fixed: c.last_fixed, at: c.last_at }
              : null,
          }
        : null,
      hidden: hiddenOf(t.mint),
    };
  }

  function summary(t: TokRow, cur: number | null = rateOf(usdNow()), at: (t: number | null) => number | null = usdLookup(db, now() - 86400 - 3600, now())) {
    const qd = lineDecimals();
    const t0 = now() - 86400;
    const vol = db.query("SELECT COALESCE(SUM(quote), 0) AS q, COALESCE(SUM(base), 0) AS b, COUNT(*) AS n FROM trades WHERE mint = ? AND time >= ?")
      .get(t.mint, t0) as { q: number; b: number; n: number };
    // 24h volume in USD: each trade at the price of its own time where a reading was stored, else at the current one
    let volUsd: number | null = 0;
    if (vol.n) {
      for (const r of db.query("SELECT time, quote FROM trades WHERE mint = ? AND time >= ?").all(t.mint, t0) as { time: number; quote: number }[]) {
        const rate = at(r.time) ?? cur;
        if (rate == null) { volUsd = null; break; }
        volUsd! += r.quote * rate;
      }
    }
    const all = db.query("SELECT COUNT(*) AS n, MAX(time) AS last FROM trades WHERE mint = ?").get(t.mint) as { n: number; last: number | null };
    // Reference for the 24h change: the pool price after the last trade before the window; with no
    // such trade the pool still sat at the curve's start price.
    const ref = db.query("SELECT COALESCE(spot_after, price) AS p FROM trades WHERE mint = ? AND time < ? ORDER BY slot DESC, idx DESC LIMIT 1")
      .get(t.mint, t0) as { p: number } | null;
    const refPrice = ref?.p ?? t.start_price;
    // the same change in dollars needs the quote coin's dollar price 24 hours ago: only when a reading was stored within the hour before
    // a coin launched inside the window has no price 24 hours ago: its reference is its start price, in dollars at the reading stored for its launch
    const rate24 = !ref && t.created_at >= t0 ? usdLookup(db, t.created_at - 3600, t.created_at, 3600)(t.created_at) : usdAt24(t0);
    const supply = ui(t.supply, t.decimals);
    const price = t.spot_price;
    const threshold = t.migration_threshold ? BigInt(t.migration_threshold) : null;
    const reserve = t.quote_reserve ? BigInt(t.quote_reserve) : null;
    const pump = t.venue === "pump";
    return {
      mint: t.mint,
      agent: t.agent,
      name: t.name,
      symbol: t.symbol,
      venue: pump ? "pump" : "meteora",
      read_only: !pump,
      phase: t.graduated ? "graduated" : "curve",
      migrated: t.migrated === 1,
      price,
      market_cap: price != null && supply != null ? price * supply : null,
      volume_24h: vol.q,
      volume_24h_base: vol.b,
      trades_24h: vol.n,
      change_24h: price != null && refPrice ? price / refPrice - 1 : null,
      // US dollars (usd.ts): null when the price cannot be read
      quote_usd: cur,
      price_usd: inUsd(price, cur),
      market_cap_usd: inUsd(price != null && supply != null ? price * supply : null, cur),
      volume_24h_usd: volUsd,
      change_24h_usd: price != null && refPrice && cur != null && rate24 != null ? (price * cur) / (refPrice * rate24) - 1 : null,
      quote_reserve_usd: inUsd(ui(t.quote_reserve, qd), cur),
      migration_threshold_usd: inUsd(ui(t.migration_threshold, qd), cur),
      fees_to_compute_usd: inUsd(ui(t.to_compute, qd), cur),
      // pump.fun: the share of the curve's real tokens sold (its graduation raise in $UNITS is set by pump.fun at launch)
      curve_progress: t.graduated ? 1 : pump ? t.progress : reserve != null && threshold ? Number(reserve) / Number(threshold) : null,
      quote_reserve: ui(t.quote_reserve, qd),
      migration_threshold: ui(t.migration_threshold, qd),
      holders: t.holders,
      trades: all.n,
      last_trade_at: all.last,
      created_at: t.created_at,
      launcher: t.launcher,
      repo_url: t.repo_url,
      state_at: t.state_at,
      ...directory(t),
    };
  }

  const rateOf = (u: QuoteUsdReading) => (u.ok ? u.usd : null);
  const usdAt24 = (t0: number) => usdLookup(db, t0 - 3600, t0, 3600)(t0);
  /** every token's summary row under one reading and one sample lookup */
  function summaries(): ReturnType<typeof summary>[] {
    const cur = rateOf(usdNow());
    const at = usdLookup(db, now() - 86400 - 3600, now());
    return (db.query("SELECT * FROM tokens").all() as TokRow[]).map((t) => summary(t, cur, at));
  }

  function detail(t: TokRow) {
    const qd = lineDecimals();
    const reading = usdNow();
    const cur = rateOf(reading);
    const fees = db.query(`SELECT COUNT(*) AS n FROM fee_cranks WHERE mint = ?`).get(t.mint) as { n: number };
    const events = db.query("SELECT kind, sig, slot, time, detail FROM events WHERE mint = ? ORDER BY slot").all(t.mint) as
      { kind: string; sig: string; slot: number; time: number | null; detail: string }[];
    return {
      ...summary(t),
      decimals: t.decimals,
      quote_decimals: qd,
      supply: ui(t.supply, t.decimals),
      supply_raw: t.supply,
      start_price: t.start_price,
      start_price_usd: inUsd(t.start_price, cur),
      usd: reading,
      hosted: t.hosted === 1,
      identity_mode: t.identity_mode,
      awake: t.awake == null ? null : t.awake === 1,
      pools: {
        venue: t.venue === "pump" ? "pump" : "meteora",
        bonding_curve: t.venue === "pump" ? t.dbc_pool : null,
        pump_pool: t.venue === "pump" ? t.damm_pool : null,
        pump_creator: t.pump_creator,
        launch_account: t.launch_account,
        dbc_config: t.dbc_config,
        dbc_pool: t.dbc_pool,
        dbc_base_vault: t.dbc_base_vault,
        dbc_quote_vault: t.dbc_quote_vault,
        damm_pool: t.damm_pool,
        damm_base_vault: t.damm_base_vault,
        damm_quote_vault: t.damm_quote_vault,
        position: t.position,
        position_nft_account: t.position_nft_account,
      },
      fees: {
        claimed: ui(t.fees_claimed, qd),
        to_compute: ui(t.to_compute, qd),
        to_treasury: ui(t.to_protocol, qd),
        claimed_raw: t.fees_claimed,
        to_compute_raw: t.to_compute,
        to_treasury_raw: t.to_protocol,
        cranks: fees.n,
        claimed_usd: inUsd(ui(t.fees_claimed, qd), cur),
        to_compute_usd: inUsd(ui(t.to_compute, qd), cur),
        to_treasury_usd: inUsd(ui(t.to_protocol, qd), cur),
        creator_fee_income_usd: inUsd(ui(t.creator_fee_income, qd), cur),
        // pump.fun: creator fees the agent's trades charged (income, from the trade events) and what pump.fun's sweeps paid out
        creator_fee_income: ui(t.creator_fee_income, qd),
        creator_fee_income_raw: t.creator_fee_income,
        swept_raw: sweptRaw(t.mint),
      },
      compute_vault: {
        address: t.compute_vault,
        balance: ui(t.compute_balance, qd),
        balance_raw: t.compute_balance,
        debited: ui(t.debited, qd),
        withdrawn: ui(t.withdrawn, qd),
        balance_usd: inUsd(ui(t.compute_balance, qd), cur),
        debited_usd: inUsd(ui(t.debited, qd), cur),
        withdrawn_usd: inUsd(ui(t.withdrawn, qd), cur),
      },
      events: events.map((e) => ({ kind: e.kind, signature: e.sig, slot: e.slot, time: e.time, ...JSON.parse(e.detail) })),
      holders_at: t.holders_at,
    };
  }

  const sweptRaw = (mint: string) =>
    (db.query("SELECT amount_raw AS a FROM sweeps WHERE mint = ?").all(mint) as { a: string }[]).reduce((n, r) => n + BigInt(r.a), 0n).toString();
  const alerts = () => {
    const v = (db.query("SELECT v FROM meta WHERE k = 'pump_alerts'").get() as { v: string } | null)?.v;
    return v ? (JSON.parse(v) as { checked_at: number; baseline: unknown; alerts: { kind: string; subject: string; detail: string }[] }) : null;
  };
  const getTok = (mint: string) => (MINT.test(mint) ? (db.query("SELECT * FROM tokens WHERE mint = ?").get(mint) as TokRow | null) : null);

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
    const url = new URL(req.url);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts[0] !== "market") return json({ error: "not found" }, 404);
    const q = url.searchParams;
    const int = (k: string, d: number, max = Number.MAX_SAFE_INTEGER) => {
      const v = Number(q.get(k));
      return q.has(k) && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : d;
    };

    if (parts.length === 2 && parts[1] === "status") return json(status());
    // the quote coin's US dollar price, its sources and when it was read (usd.ts); ok false with the reason when there is none
    // ?at=<unix seconds>: the stored sample covering that time instead (the newest one read at or before it, within
    // SAMPLE_REACH_S), for Core's check of a launch deposit made while it had no reading of its own; ok false when none is stored
    if (parts.length === 2 && parts[1] === "quote-usd" && q.has("at")) {
      const at = Number(q.get("at"));
      const s = Number.isInteger(at) && at > 0 ? usdSampleAt(db, at) : null;
      return json(s ? { quote: QUOTE, ok: true, at, usd: s.usd, read_at: s.t, sample_s: SAMPLE_S, reach_s: SAMPLE_REACH_S }
        : { quote: QUOTE, ok: false, at: Number.isFinite(at) ? at : null, reason: Number.isInteger(at) && at > 0 ? "no USD price is stored for that time" : "at must be a unix time in seconds", reach_s: SAMPLE_REACH_S });
    }
    if (parts.length === 2 && parts[1] === "quote-usd") return json({ quote: QUOTE, ...usdNow() });
    // The same reading in the shape of Jupiter Price API V3 (GET ?ids=<mint> -> { <mint>: { usdPrice } }), for the hosted
    // runtime's price source (packages/runtime price.ts `price.api`): a pump.fun quote coin on its bonding curve is priced
    // here from chain, so billing and every page use one number. A mint that is not the quote coin, or no reading within
    // its maximum age, answers {} (the runtime then has no price and starts nothing), never an old or guessed figure.
    if (parts.length === 3 && parts[1] === "price" && parts[2] === "v3") {
      const r = usdNow();
      const ids = (q.get("ids") ?? "").split(",").filter(Boolean);
      return json(r.ok && ids.includes(r.quote_mint) ? { [r.quote_mint]: { usdPrice: r.usd, blockId: null, read_at: r.read_at, source: "units market indexer (GET /market/quote-usd)" } } : {});
    }
    // pump.fun watch (docs/plans/PUMPFUN-LAUNCHES.md 6.6): creator reassignments, max_curve_depth and fee config changes
    if (parts.length === 2 && parts[1] === "alerts") {
      const a = alerts();
      return json({ checked_at: a?.checked_at ?? null, baseline: a?.baseline ?? null, alerts: a?.alerts ?? [] });
    }
    if (parts.length === 2 && parts[1] === "summary") {
      const rows = summaries().filter((r) => !r.hidden);
      const sumUsd = (f: (r: (typeof rows)[number]) => number | null) => rows.reduce<number | null>((n, r) => { const v = f(r); return n === null || v === null ? null : n + v; }, 0);
      const synced = (db.query("SELECT v FROM meta WHERE k = 'core_synced_at'").get() as { v: string } | null)?.v ?? null;
      const known = !!synced && rows.some((r) => r.generations !== null);
      return json({
        tokens: rows.length,
        awake: rows.filter((r) => r.awake === true).length,
        working: known ? rows.filter((r) => r.state === "working").length : null,
        graduated: rows.filter((r) => r.phase === "graduated").length,
        // null until Core has a record of at least one token's agent (never a zero Core did not say)
        verified_generations: known ? rows.reduce((n, r) => n + (r.generations ?? 0), 0) : null,
        fees_to_compute: rows.reduce((n, r) => n + (r.fees_to_compute ?? 0), 0),
        fees_to_compute_usd: sumUsd((r) => (r.fees_to_compute == null ? 0 : r.fees_to_compute_usd)),
        // listed tokens, last 24 hours and now: in the quote coin and in US dollars (null when the price cannot be read)
        volume_24h: rows.reduce((n, r) => n + r.volume_24h, 0),
        volume_24h_usd: sumUsd((r) => r.volume_24h_usd),
        market_cap: rows.reduce((n, r) => n + (r.market_cap ?? 0), 0),
        market_cap_usd: sumUsd((r) => (r.market_cap == null ? 0 : r.market_cap_usd)),
        usd: usdNow(),
        hidden: (db.query("SELECT COUNT(*) AS n FROM hidden_mints").get() as { n: number }).n,
        core_synced_at: synced ? Number(synced) : null,
        quote: QUOTE,
        alerts: alerts()?.alerts.length ?? null,
      });
    }
    // Protocol flows (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md 7): every fee crank with what it
    // paid the agent's compute vault and the registry treasury, and each token's counters as the
    // AgentLaunch account carries them (debited: what debit_compute moved to the compute sink). Read only;
    // raw base units of the quote token as strings. Hidden launches are left out unless hidden=1.
    if (parts.length === 2 && parts[1] === "flows") {
      const withHidden = q.get("hidden") === "1";
      const hidden = new Set((db.query("SELECT mint FROM hidden_mints").all() as { mint: string }[]).map((r) => r.mint));
      const toks = (db.query("SELECT * FROM tokens").all() as TokRow[]).filter((t) => withHidden || !hidden.has(t.mint));
      const byMint = new Map(toks.map((t) => [t.mint, t]));
      const cranks = (db.query("SELECT sig, idx, mint, slot, time, fees_raw, to_compute_raw, to_protocol_raw FROM fee_cranks ORDER BY slot, idx").all() as
        { sig: string; idx: number; mint: string; slot: number; time: number | null; fees_raw: string; to_compute_raw: string; to_protocol_raw: string }[])
        .filter((r) => byMint.has(r.mint));
      const atAll = usdLookup(db, 0, now());
      return json({
        quote: QUOTE,
        // the quote coin's USD price now, and per crank the price stored nearest before its own time (quote_usd; null when none was stored)
        usd: usdNow(),
        quote_mint: (db.query("SELECT v FROM meta WHERE k = 'line_mint'").get() as { v: string } | null)?.v ?? null,
        quote_decimals: lineDecimals(),
        cranks: cranks.map((r) => ({ signature: r.sig, idx: r.idx, mint: r.mint, agent: byMint.get(r.mint)!.agent, venue: byMint.get(r.mint)!.venue === "pump" ? "pump" : "meteora",
          slot: r.slot, time: r.time, fees_raw: r.fees_raw, to_compute_raw: r.to_compute_raw, to_protocol_raw: r.to_protocol_raw, quote_usd: atAll(r.time) })),
        tokens: toks.map((t) => ({ mint: t.mint, agent: t.agent, symbol: t.symbol, venue: t.venue === "pump" ? "pump" : "meteora", hosted: t.hosted == null ? null : t.hosted === 1,
          hidden: hidden.has(t.mint), fees_claimed_raw: t.fees_claimed, to_compute_raw: t.to_compute, to_protocol_raw: t.to_protocol, debited_raw: t.debited, state_at: t.state_at })),
      });
    }
    if (parts[1] !== "tokens") return json({ error: "not found" }, 404);

    if (parts.length === 2) {
      // hidden launches leave the listing and its search unless asked for (hidden=1); launcher= lists one wallet's own
      const launcher = q.get("launcher");
      const withHidden = q.get("hidden") === "1" || !!launcher;
      const all = summaries().filter((r) => (withHidden || !r.hidden) && (!launcher || r.launcher === launcher));
      const sort = q.get("sort") ?? "newest";
      const key: Record<string, (r: ReturnType<typeof summary>) => number> = {
        newest: (r) => r.created_at,
        market_cap: (r) => r.market_cap ?? -1,
        volume: (r) => r.volume_24h,
        change: (r) => r.change_24h ?? -1e9,
        progress: (r) => r.curve_progress ?? -1,
        fees: (r) => r.fees_to_compute ?? -1,
        verified: (r) => r.generations ?? -1,
        // awake first (working counts as awake), then market cap
        awake: (r) => (r.state === "working" ? 2e18 : r.awake || r.covered ? 1e18 : 0) + Math.min(9.9e17, r.market_cap ?? 0),
        // the agent directory: working now, then the newest verified improvement, then market cap
        building: (r) => (r.state === "working" ? 4e18 : 0) + (r.building?.last?.at ?? 0) * 1e3 + Math.min(9.9e2, (r.market_cap ?? 0) / 1e4),
      };
      const k = key[sort] ?? key.newest!;
      // filters: class, model ("unknown" for none), state (working, awake, asleep, graduated), q (name, ticker, mint or agent)
      const cls = q.get("class");
      const model = q.get("model");
      const state = q.get("state");
      const text = (q.get("q") ?? "").trim().replace(/^\$/, "").toLowerCase();
      const facet = (v: string | null) => v ?? "unknown";
      const rows = all.filter((r) =>
        (!cls || facet(r.class) === cls) &&
        (!model || facet(r.model) === model) &&
        (!state || (state === "graduated" ? r.phase === "graduated" : state === "awake" ? r.awake === true : state === "asleep" ? r.awake === false && !r.covered : r.state === state)) &&
        (!text || r.mint.toLowerCase() === text || r.agent.toLowerCase() === text || (r.symbol ?? "").toLowerCase().includes(text) || (r.name ?? "").toLowerCase().includes(text)));
      rows.sort((a, b) => k(b) - k(a) || (a.mint < b.mint ? -1 : 1));
      const count = (f: (r: (typeof all)[number]) => string) => all.reduce<Record<string, number>>((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
      const offset = int("offset", 0);
      const limit = int("limit", rows.length || 1, 500);
      return json({ tokens: rows.slice(offset, offset + limit), count: rows.length, total: all.length, offset, quote: QUOTE, usd: usdNow(), sort: key[sort] ? sort : "newest",
        facets: { class: count((r) => facet(r.class)), model: count((r) => facet(r.model)) } });
    }

    const t = getTok(parts[2] ?? "");
    if (!t) return json({ error: "unknown token" }, 404);
    if (parts.length === 3) return json(detail(t));

    switch (parts[3]) {
      case "candles": {
        const tf = q.get("tf") ?? "1h";
        const sec = TF[tf];
        if (!sec) return json({ error: "tf must be 1m, 5m, 1h or 1d" }, 400);
        const to = int("to", now());
        const from = int("from", to - sec * 500);
        const rows = db.query(`SELECT time, slot, idx, price, COALESCE(spot_after, price) AS p, base, quote FROM trades WHERE mint = ? AND time >= ?
          AND time <= ? ORDER BY slot, idx`).all(t.mint, from, to) as { time: number; p: number; base: number; quote: number }[];
        type C = { t: number; open: number; high: number; low: number; close: number; volume: number; volume_base: number; trades: number;
          open_usd: number | null; high_usd: number | null; low_usd: number | null; close_usd: number | null; volume_usd: number | null };
        const out: C[] = [];
        // US dollars: each trade at the reading stored nearest before its own time, else at the current reading
        const reading = usdNow();
        const cur = rateOf(reading);
        const at = usdLookup(db, from, to);
        let atTime = 0, atCurrent = 0;
        const mx = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.max(a, b));
        const mn = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.min(a, b));
        // Where the first candle opens: the pool price after the last trade before the window; with no such
        // trade the pool still sat at the curve's start price (the first buy then shows as a move, not a dot).
        const prior = rows.length ? db.query(`SELECT COALESCE(spot_after, price) AS p FROM trades WHERE mint = ? AND time < ? ORDER BY slot DESC, idx DESC LIMIT 1`)
          .get(t.mint, from) as { p: number } | null : null;
        const before = prior?.p ?? (t.start_price != null && t.start_price > 0 ? t.start_price : null);
        for (const r of rows) {
          const b = Math.floor(r.time / sec) * sec;
          const stored = at(r.time);
          const rate = stored ?? cur;
          if (stored != null) atTime++; else atCurrent++;
          const pu = inUsd(r.p, rate);
          let c = out[out.length - 1];
          if (!c || c.t !== b) {
            const prev = out[out.length - 1];
            const open = prev ? prev.close : before ?? r.p;
            const openUsd = prev ? prev.close_usd : before != null ? inUsd(before, rate) : pu;
            c = { t: b, open, high: Math.max(open, r.p), low: Math.min(open, r.p), close: r.p, volume: 0, volume_base: 0, trades: 0,
              open_usd: openUsd, high_usd: mx(openUsd, pu), low_usd: mn(openUsd, pu), close_usd: pu, volume_usd: 0 };
            out.push(c);
          }
          c.high = Math.max(c.high, r.p);
          c.low = Math.min(c.low, r.p);
          c.close = r.p;
          c.volume += r.quote;
          c.volume_base += r.base;
          c.trades++;
          c.high_usd = mx(c.high_usd, pu);
          c.low_usd = mn(c.low_usd, pu);
          c.close_usd = pu;
          c.volume_usd = c.volume_usd == null || rate == null ? null : c.volume_usd + r.quote * rate;
        }
        return json({ mint: t.mint, tf, from, to, price: `pool price after each trade, ${QUOTE} per token; the _usd fields are the same in US dollars`, usd: reading,
          usd_basis: cur == null && atCurrent ? null : atCurrent === 0 ? "at_time" : atTime === 0 ? "current" : "mixed",
          // the curve's start price in dollars as the candles are: at the reading stored for the launch, else at the current one
          start_price_usd: inUsd(t.start_price, usdSampleAt(db, t.created_at)?.usd ?? cur), candles: out });
      }
      case "trades": {
        const limit = Math.max(1, int("limit", 50, 500));
        const before = q.get("before");
        let cond = "";
        const args: (string | number)[] = [t.mint];
        if (before) {
          const b = db.query("SELECT slot, idx FROM trades WHERE sig = ? AND mint = ? ORDER BY idx LIMIT 1").get(before, t.mint) as { slot: number; idx: number } | null;
          if (!b) return json({ error: "unknown 'before' signature" }, 400);
          cond = " AND (slot < ? OR (slot = ? AND sig < ?))";
          args.push(b.slot, b.slot, before);
        }
        args.push(limit);
        const rows = db.query(`SELECT * FROM trades WHERE mint = ?${cond} ORDER BY slot DESC, sig DESC, idx DESC LIMIT ?`).all(...args) as
          { sig: string; idx: number; slot: number; time: number | null; venue: string; side: string; base: number; quote: number; base_raw: string;
            quote_raw: string; price: number; spot_after: number | null; fee_raw: string | null; trader: string; creator_fee_raw: string | null }[];
        const reading = usdNow();
        const cur = rateOf(reading);
        const times = rows.map((r) => r.time).filter((x): x is number => x != null);
        const at = usdLookup(db, times.length ? Math.min(...times) : 0, times.length ? Math.max(...times) : 0);
        return json({
          mint: t.mint,
          usd: reading,
          trades: rows.map((r) => {
            const stored = at(r.time);
            const rate = stored ?? cur;
            return { signature: r.sig, index: r.idx, slot: r.slot, time: r.time, venue: r.venue, side: r.side, base_amount: r.base,
              quote_amount: r.quote, base_raw: r.base_raw, quote_raw: r.quote_raw, price: r.price, price_after: r.spot_after, trader: r.trader,
              creator_fee_raw: r.creator_fee_raw, quote_amount_usd: inUsd(r.quote, rate), price_usd: inUsd(r.price, rate), price_after_usd: inUsd(r.spot_after, rate),
              usd_basis: rate == null ? null : stored != null ? "at_time" : "current" };
          }),
          next: rows.length === limit ? rows[rows.length - 1]!.sig : null,
        });
      }
      case "holders": {
        const limit = Math.max(1, int("limit", 20, 500));
        const rows = db.query("SELECT owner, amount FROM holders WHERE mint = ?").all(t.mint) as { owner: string; amount: string }[];
        rows.sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
        const supply = t.supply ? Number(BigInt(t.supply)) : null;
        return json({
          mint: t.mint,
          holders: t.holders,
          source: t.holders_source,
          as_of: t.holders_at,
          excludes: "pool vaults",
          top: rows.slice(0, limit).map((r) => ({ owner: r.owner, amount: ui(r.amount, t.decimals), amount_raw: r.amount,
            share: supply ? Number(BigInt(r.amount)) / supply : null })),
        });
      }
      case "fees": {
        const qd = lineDecimals();
        const rows = db.query("SELECT * FROM fee_cranks WHERE mint = ? ORDER BY slot DESC, idx DESC").all(t.mint) as
          { sig: string; slot: number; time: number | null; fees_raw: string; to_compute_raw: string; to_protocol_raw: string; pool_fees: number;
            balance_raw: string; awake: number }[];
        const reading = usdNow();
        const cur = rateOf(reading);
        const at = usdLookup(db, 0, now());
        return json({
          mint: t.mint,
          usd: reading,
          cranks: rows.map((r) => {
            const stored = at(r.time);
            const rate = stored ?? cur;
            return { signature: r.sig, slot: r.slot, time: r.time,
              source: t.venue === "pump" ? (r.pool_fees ? "pump_curve_and_pool" : "pump_curve") : r.pool_fees ? "damm_v2" : "dbc", amount: ui(r.fees_raw, qd),
              to_vault: ui(r.to_compute_raw, qd), to_treasury: ui(r.to_protocol_raw, qd), amount_raw: r.fees_raw, to_vault_raw: r.to_compute_raw,
              to_treasury_raw: r.to_protocol_raw, vault_balance_after: ui(r.balance_raw, qd), awake_after: r.awake === 1,
              amount_usd: inUsd(ui(r.fees_raw, qd), rate), to_vault_usd: inUsd(ui(r.to_compute_raw, qd), rate), to_treasury_usd: inUsd(ui(r.to_protocol_raw, qd), rate),
              usd_basis: rate == null ? null : stored != null ? "at_time" : "current" };
          }),
          totals_onchain: { claimed: ui(t.fees_claimed, qd), to_vault: ui(t.to_compute, qd), to_treasury: ui(t.to_protocol, qd),
            claimed_usd: inUsd(ui(t.fees_claimed, qd), cur), to_vault_usd: inUsd(ui(t.to_compute, qd), cur), to_treasury_usd: inUsd(ui(t.to_protocol, qd), cur) },
          creator_fee_income: ui(t.creator_fee_income, qd),
          creator_fee_income_usd: inUsd(ui(t.creator_fee_income, qd), cur),
          creator_fee_income_raw: t.creator_fee_income,
          sweeps: (db.query("SELECT * FROM sweeps WHERE mint = ? ORDER BY slot DESC, idx DESC").all(t.mint) as
            { sig: string; slot: number; time: number | null; venue: string; amount_raw: string; recipient: string }[])
            .map((r) => ({ signature: r.sig, slot: r.slot, time: r.time, venue: r.venue, amount: ui(r.amount_raw, qd), amount_raw: r.amount_raw, recipient: r.recipient,
              amount_usd: inUsd(ui(r.amount_raw, qd), at(r.time) ?? cur) })),
          compute_vault: { address: t.compute_vault, balance: ui(t.compute_balance, qd), balance_usd: inUsd(ui(t.compute_balance, qd), cur) },
        });
      }
    }
    return json({ error: "not found" }, 404);
  };
}
