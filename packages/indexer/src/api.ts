import type { Database } from "bun:sqlite";
import { ensureCoreSchema } from "./core-sync.ts";

// Read API (docs/plans/LAUNCHPAD-AND-LIVE.md L2), JSON with CORS *. Prices are tLINE per agent
// token; amounts are UI units (numbers) with the exact base units next to them as strings ("_raw").
// Times are unix seconds. Nothing is estimated: a figure the chain has not produced yet is null.

const TF: Record<string, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "content-type" };

interface CoreRow { agent: string; class: string | null; lineage_id: string | null; repo: string | null; model: string | null; provider: string | null;
  generations: number; session_id: string | null; session_state: string | null; session_at: number | null; name: string | null; tagline: string | null;
  avatar: string | null; session_file: string | null; last_gen: string | null; last_lineage: string | null; last_metric: string | null; last_ratio: number | null;
  last_fixed: number | null; last_at: number | null }

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
}

// CORS for configured origins (embed kit, docs/EMBED.md): with LINEAGE_CORS_ORIGINS unset every answer
// keeps `*`; set (comma separated, `*` wildcards such as https://*.vercel.app), only listed origins
// get CORS headers, echoed back. The API is read-only either way.
export function corsFor(origin: string | null, env = process.env.LINEAGE_CORS_ORIGINS): Record<string, string> {
  const list = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return CORS;
  const ok = !!origin && list.some((o) => o === "*" || new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(origin));
  return ok ? { ...CORS, "access-control-allow-origin": origin!, vary: "Origin" } : { vary: "Origin" };
}

export function marketApi(db: Database, status: StatusSource, opts: { now?: () => number; corsOrigins?: string } = {}) {
  const handle = marketHandler(db, status, opts);
  return async function withCors(req: Request): Promise<Response> {
    const res = await handle(req);
    const h = corsFor(req.headers.get("origin"), opts.corsOrigins ?? process.env.LINEAGE_CORS_ORIGINS);
    for (const k of Object.keys(CORS)) res.headers.delete(k);
    for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
    return res;
  };
}

function marketHandler(db: Database, status: StatusSource, opts: { now?: () => number } = {}) {
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
    return {
      fees_to_compute: ui(t.to_compute, lineDecimals()),
      awake,
      state: working ? "working" : t.graduated ? "graduated" : awake === null ? null : awake ? "awake" : "asleep",
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

  function summary(t: TokRow) {
    const qd = lineDecimals();
    const t0 = now() - 86400;
    const vol = db.query("SELECT COALESCE(SUM(quote), 0) AS q, COALESCE(SUM(base), 0) AS b, COUNT(*) AS n FROM trades WHERE mint = ? AND time >= ?")
      .get(t.mint, t0) as { q: number; b: number; n: number };
    const all = db.query("SELECT COUNT(*) AS n, MAX(time) AS last FROM trades WHERE mint = ?").get(t.mint) as { n: number; last: number | null };
    // Reference for the 24h change: the pool price after the last trade before the window; with no
    // such trade the pool still sat at the curve's start price.
    const ref = db.query("SELECT COALESCE(spot_after, price) AS p FROM trades WHERE mint = ? AND time < ? ORDER BY slot DESC, idx DESC LIMIT 1")
      .get(t.mint, t0) as { p: number } | null;
    const refPrice = ref?.p ?? t.start_price;
    const supply = ui(t.supply, t.decimals);
    const price = t.spot_price;
    const threshold = t.migration_threshold ? BigInt(t.migration_threshold) : null;
    const reserve = t.quote_reserve ? BigInt(t.quote_reserve) : null;
    return {
      mint: t.mint,
      agent: t.agent,
      name: t.name,
      symbol: t.symbol,
      phase: t.graduated ? "graduated" : "curve",
      migrated: t.migrated === 1,
      price,
      market_cap: price != null && supply != null ? price * supply : null,
      volume_24h: vol.q,
      volume_24h_base: vol.b,
      trades_24h: vol.n,
      change_24h: price != null && refPrice ? price / refPrice - 1 : null,
      curve_progress: t.graduated ? 1 : reserve != null && threshold ? Number(reserve) / Number(threshold) : null,
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

  function detail(t: TokRow) {
    const qd = lineDecimals();
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
      hosted: t.hosted === 1,
      identity_mode: t.identity_mode,
      awake: t.awake == null ? null : t.awake === 1,
      pools: {
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
      },
      compute_vault: {
        address: t.compute_vault,
        balance: ui(t.compute_balance, qd),
        balance_raw: t.compute_balance,
        debited: ui(t.debited, qd),
        withdrawn: ui(t.withdrawn, qd),
      },
      events: events.map((e) => ({ kind: e.kind, signature: e.sig, slot: e.slot, time: e.time, ...JSON.parse(e.detail) })),
      holders_at: t.holders_at,
    };
  }

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
    if (parts.length === 2 && parts[1] === "summary") {
      const rows = (db.query("SELECT * FROM tokens").all() as TokRow[]).map(summary).filter((r) => !r.hidden);
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
        hidden: (db.query("SELECT COUNT(*) AS n FROM hidden_mints").get() as { n: number }).n,
        core_synced_at: synced ? Number(synced) : null,
        quote: "tLINE",
      });
    }
    if (parts[1] !== "tokens") return json({ error: "not found" }, 404);

    if (parts.length === 2) {
      // hidden launches leave the listing and its search unless asked for (hidden=1); launcher= lists one wallet's own
      const launcher = q.get("launcher");
      const withHidden = q.get("hidden") === "1" || !!launcher;
      const all = (db.query("SELECT * FROM tokens").all() as TokRow[]).map(summary).filter((r) => (withHidden || !r.hidden) && (!launcher || r.launcher === launcher));
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
        awake: (r) => (r.state === "working" ? 2e18 : r.awake ? 1e18 : 0) + Math.min(9.9e17, r.market_cap ?? 0),
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
        (!state || (state === "graduated" ? r.phase === "graduated" : state === "awake" ? r.awake === true : state === "asleep" ? r.awake === false : r.state === state)) &&
        (!text || r.mint.toLowerCase() === text || r.agent.toLowerCase() === text || (r.symbol ?? "").toLowerCase().includes(text) || (r.name ?? "").toLowerCase().includes(text)));
      rows.sort((a, b) => k(b) - k(a) || (a.mint < b.mint ? -1 : 1));
      const count = (f: (r: (typeof all)[number]) => string) => all.reduce<Record<string, number>>((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
      const offset = int("offset", 0);
      const limit = int("limit", rows.length || 1, 500);
      return json({ tokens: rows.slice(offset, offset + limit), count: rows.length, total: all.length, offset, quote: "tLINE", sort: key[sort] ? sort : "newest",
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
        const out: { t: number; open: number; high: number; low: number; close: number; volume: number; volume_base: number; trades: number }[] = [];
        for (const r of rows) {
          const b = Math.floor(r.time / sec) * sec;
          let c = out[out.length - 1];
          if (!c || c.t !== b) {
            const open = out.length ? out[out.length - 1]!.close : r.p;
            c = { t: b, open, high: Math.max(open, r.p), low: Math.min(open, r.p), close: r.p, volume: 0, volume_base: 0, trades: 0 };
            out.push(c);
          }
          c.high = Math.max(c.high, r.p);
          c.low = Math.min(c.low, r.p);
          c.close = r.p;
          c.volume += r.quote;
          c.volume_base += r.base;
          c.trades++;
        }
        return json({ mint: t.mint, tf, from, to, price: "pool price after each trade, tLINE per token", candles: out });
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
            quote_raw: string; price: number; spot_after: number | null; fee_raw: string | null; trader: string }[];
        return json({
          mint: t.mint,
          trades: rows.map((r) => ({ signature: r.sig, index: r.idx, slot: r.slot, time: r.time, venue: r.venue, side: r.side, base_amount: r.base,
            quote_amount: r.quote, base_raw: r.base_raw, quote_raw: r.quote_raw, price: r.price, price_after: r.spot_after, trader: r.trader })),
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
        return json({
          mint: t.mint,
          cranks: rows.map((r) => ({ signature: r.sig, slot: r.slot, time: r.time, source: r.pool_fees ? "damm_v2" : "dbc", amount: ui(r.fees_raw, qd),
            to_vault: ui(r.to_compute_raw, qd), to_treasury: ui(r.to_protocol_raw, qd), amount_raw: r.fees_raw, to_vault_raw: r.to_compute_raw,
            to_treasury_raw: r.to_protocol_raw, vault_balance_after: ui(r.balance_raw, qd), awake_after: r.awake === 1 })),
          totals_onchain: { claimed: ui(t.fees_claimed, qd), to_vault: ui(t.to_compute, qd), to_treasury: ui(t.to_protocol, qd) },
          compute_vault: { address: t.compute_vault, balance: ui(t.compute_balance, qd) },
        });
      }
    }
    return json({ error: "not found" }, 404);
  };
}
