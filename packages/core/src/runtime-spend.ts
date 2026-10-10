import type { Core } from "./core.ts";
import { bad } from "./errors.ts";

// Runtime spend summaries (plan MODELS-AND-SELF-FUNDING): the hosted runtime posts, about once a
// minute, each bound agent's vault, its USD value at the price in use, its burn over the last 24 h
// of closed usage epochs, its runway, its model and route, and why it waits (for example "provider
// balance low"). GET /v1/agents/:id/spend serves the latest one to the profile. Every figure is the
// runtime's own reading; nothing is derived here, and null stays null.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_spend (
  agent_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  reported_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_spend_global (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,
  reported_at INTEGER NOT NULL
);`;

interface Internals {
  db: Core["db"];
  now(): number;
}

const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const num = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));
const intStr = (v: unknown) => v === null || (typeof v === "string" && /^\d{1,30}$/.test(v));
const short = (v: unknown, n = 300) => v === null || (typeof v === "string" && v.length <= n && !/—/.test(v));

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The runtime's platform cap (Runtime.capStatus), numbers only; null when absent or malformed. */
function capOf(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const past = Array.isArray(c.past_windows) ? c.past_windows.slice(-14) : [];
  return {
    max_usd: fin(c.max_usd), window_s: fin(c.window_s), window_start: fin(c.window_start), window_end: fin(c.window_end), spent_usd: fin(c.spent_usd), left_usd: fin(c.left_usd), lifetime_usd: fin(c.lifetime_usd),
    scope: typeof c.scope === "string" && c.scope.length <= 20 ? c.scope : null,
    past_windows: past.filter((w): w is Record<string, unknown> => !!w && typeof w === "object").map((w) => ({ start: fin(w.start), window_s: fin(w.window_s), usd: fin(w.usd) })),
  };
}

/** The desktop pool's counts (packages/desktop pool.status, summarized by the runtime): no host names or addresses. */
function desktopsOf(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, Record<string, unknown> | undefined>;
  const slot = (x: Record<string, unknown> | undefined) => (x && typeof x === "object" ? { running: fin(x.running), max: fin(x.max) } : null);
  return {
    required: typeof (v as { required?: unknown }).required === "boolean" ? (v as { required: boolean }).required : null,
    local: slot(d.local),
    hosts: d.hosts && typeof d.hosts === "object" ? { ...slot(d.hosts), count: fin(d.hosts.count), up: fin(d.hosts.up) } : null,
    e2b: d.e2b && typeof d.e2b === "object" ? { ...slot(d.e2b), spent_today_usd: fin(d.e2b.spent_today_usd), cap_usd: fin(d.e2b.cap_usd) } : null,
  };
}

const instances = new WeakMap<Core, RuntimeSpend>();
export function runtimeSpendOf(core: Core): RuntimeSpend {
  let m = instances.get(core);
  if (!m) instances.set(core, (m = new RuntimeSpend(core)));
  return m;
}

export class RuntimeSpend {
  private readonly c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  /** POST /v1/admin/runtime/spend (runtime key). */
  report(by: string, body: unknown) {
    const b = body as { price?: Record<string, unknown>; provider_balance?: unknown; cap?: unknown; desktops?: unknown; agents?: Record<string, Record<string, unknown>> } | null;
    if (!b || typeof b !== "object" || !b.agents || typeof b.agents !== "object" || Array.isArray(b.agents)) throw bad("bad_spend", "agents: { id: summary }");
    const ids = Object.keys(b.agents);
    if (ids.length > 500) throw bad("bad_spend", "at most 500 agents");
    const p = b.price ?? {};
    if (!short(p.source ?? null, 20) || !short(p.status ?? null, 20) || !num(p.usd_per_token ?? null) || !intStr(p.line_per_usd ?? null) || !short(p.why ?? null)) throw bad("bad_spend", "price: { source, status, usd_per_token, line_per_usd, why }");
    const global = { price: { source: p.source ?? null, status: p.status ?? null, usd_per_token: p.usd_per_token ?? null, line_per_usd: p.line_per_usd ?? null, why: p.why ?? null }, provider_balance: b.provider_balance ?? null, cap: capOf(b.cap), desktops: desktopsOf(b.desktops) };
    const now = this.c.now();
    const put = this.c.db.query("INSERT OR REPLACE INTO runtime_spend (agent_id, body, reported_at, reported_by) VALUES (?, ?, ?, ?)");
    for (const id of ids) {
      const a = b.agents[id]!;
      if (!AGENT.test(id) || !a || typeof a !== "object") throw bad("bad_spend", `agents.${id.slice(0, 50)}: an agent id and a summary`);
      if (!intStr(a.vault ?? null) || !num(a.vault_usd ?? null) || !intStr(a.burn_per_h ?? null) || !num(a.burn_usd_per_h ?? null) || !num(a.burn_window_s ?? null) || !num(a.runway_h ?? null) || !short(a.waiting ?? null) || !(a.via === null || a.via === undefined || a.via === "direct" || a.via === "openrouter"))
        throw bad("bad_spend", `agents.${id}: vault, vault_usd, burn_per_h, burn_usd_per_h, burn_window_s, runway_h, via, waiting`);
      const m = a.model as { provider?: unknown; id?: unknown } | null | undefined;
      if (m != null && !(typeof m.provider === "string" && typeof m.id === "string" && m.provider.length <= 32 && m.id.length <= 100)) throw bad("bad_spend", `agents.${id}.model: { provider, id }`);
      const row = { vault: a.vault ?? null, vault_usd: a.vault_usd ?? null, burn_per_h: a.burn_per_h ?? null, burn_usd_per_h: a.burn_usd_per_h ?? null, burn_window_s: a.burn_window_s ?? null, runway_h: a.runway_h ?? null, model: m ?? null, via: a.via ?? null, waiting: a.waiting ?? null };
      put.run(id, JSON.stringify(row), now, by);
    }
    this.c.db.query("INSERT OR REPLACE INTO runtime_spend_global (id, body, reported_at) VALUES (1, ?, ?)").run(JSON.stringify(global), now);
    return { ok: true, agents: ids.length };
  }

  /** Every agent's latest summary (the Analytics page's runway and waiting lists). */
  all(): { agent: string; reported_at: number; spend: Record<string, any> }[] {
    return this.c.db
      .query<{ agent_id: string; body: string; reported_at: number }, []>("SELECT agent_id, body, reported_at FROM runtime_spend ORDER BY agent_id")
      .all()
      .map((r) => ({ agent: r.agent_id, reported_at: r.reported_at, spend: JSON.parse(r.body) }));
  }

  /** The latest runtime-wide part: price, provider balance, the platform cap and the desktop pool (null when never reported). */
  global(): { reported_at: number; body: Record<string, any> } | null {
    const g = this.c.db.query<{ body: string; reported_at: number }, []>("SELECT body, reported_at FROM runtime_spend_global WHERE id = 1").get();
    return g ? { reported_at: g.reported_at, body: JSON.parse(g.body) } : null;
  }

  /** GET /v1/agents/:id/spend: the latest summary for the agent, or nulls when the runtime never reported it. */
  of(agent: string) {
    const row = this.c.db.query<{ body: string; reported_at: number }, [string]>("SELECT body, reported_at FROM runtime_spend WHERE agent_id = ?").get(agent);
    const g = this.c.db.query<{ body: string; reported_at: number }, []>("SELECT body, reported_at FROM runtime_spend_global WHERE id = 1").get();
    const global = g ? (JSON.parse(g.body) as { price: unknown; provider_balance: { openrouter?: { low?: boolean } | null } | null }) : null;
    const s = row ? JSON.parse(row.body) : null;
    return {
      agent,
      reported_at: row?.reported_at ?? null,
      spend: s,
      price: global?.price ?? null,
      // the note the profile shows when the agent's model runs through OpenRouter and its balance is low
      provider_balance_low: !!(s?.via === "openrouter" && global?.provider_balance?.openrouter?.low),
    };
  }
}
