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
    const b = body as { price?: Record<string, unknown>; provider_balance?: unknown; agents?: Record<string, Record<string, unknown>> } | null;
    if (!b || typeof b !== "object" || !b.agents || typeof b.agents !== "object" || Array.isArray(b.agents)) throw bad("bad_spend", "agents: { id: summary }");
    const ids = Object.keys(b.agents);
    if (ids.length > 500) throw bad("bad_spend", "at most 500 agents");
    const p = b.price ?? {};
    if (!short(p.source ?? null, 20) || !short(p.status ?? null, 20) || !num(p.usd_per_token ?? null) || !intStr(p.line_per_usd ?? null) || !short(p.why ?? null)) throw bad("bad_spend", "price: { source, status, usd_per_token, line_per_usd, why }");
    const global = { price: { source: p.source ?? null, status: p.status ?? null, usd_per_token: p.usd_per_token ?? null, line_per_usd: p.line_per_usd ?? null, why: p.why ?? null }, provider_balance: b.provider_balance ?? null };
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
