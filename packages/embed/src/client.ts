import { ApiError } from "../../../apps/web/src/api.ts";
import type { SessionSummary } from "../../../apps/web/src/live-panel/index.ts";
import type { Candle, FeeCrank, Holders, TokenDetail, TokenSummary, Trade } from "../../../apps/web/src/market.ts";

// The embed kit's data client (docs/plans/FRONTEND-EMBED.md): plain JSON from Core and the market
// indexer, nothing computed that the API does not serve except sums and counts over its own rows.
// Exposed to hosts as window.Lineage, and used by every element.
//
// Where things live, given a site origin `api` (the Lineage site, e.g. https://<site>):
//   Core      <api>/api/<path>     (the dashboard's proxy; the site gate adds CORS)
//   market    <api>/market/<path>  (the indexer; CORS from the indexer)
//   events    <api>/live/events    (the dashboard's shared SSE fan-out of Core's stream)
//   pages     <api>/<path>         (links to agent, token and generation pages)
// Each can be overridden (data-core, data-market, data-events, data-site), for example to talk to a
// Core directly at http://127.0.0.1:9660/v1.

export { ApiError };
export type { Candle, FeeCrank, Holders, SessionSummary, TokenDetail, TokenSummary, Trade };

export interface Bases {
  core: string;
  market: string;
  events: string;
  site: string;
}

export interface BaseOverrides {
  api?: string | null;
  core?: string | null;
  market?: string | null;
  events?: string | null;
  site?: string | null;
}

const trim = (s: string) => s.replace(/\/+$/, "");

export function resolveBases(o: BaseOverrides, fallbackOrigin: string): Bases {
  const api = trim(o.api || fallbackOrigin);
  return {
    core: trim(o.core || `${api}/api`),
    market: trim(o.market || `${api}/market`),
    events: o.events || `${api}/live/events`,
    site: trim(o.site || api),
  };
}

export interface SessionEvent {
  seq: number;
  kind: string;
  at: number;
  path?: string;
  start_line?: number;
  end_line?: number;
  query?: string;
  matches?: number;
  count?: number;
  phase?: string;
  target?: string;
  label?: string;
  sealed?: boolean;
  before?: string;
  after?: string;
  outcome?: string;
  text?: string;
  reason?: string;
}
export type SessionView = SessionSummary & { event_list: SessionEvent[] };

export interface Soul {
  agent: string;
  name: string | null;
  tagline: string | null;
  digest: string;
  seq: number;
}

/** "unknown" when Core's sessions could not be read: the card then claims nothing about the agent's work. */
export type CardState = "working" | "idle" | "graduated" | "unknown";

/** One token as a card shows it: indexer fields, the soul's tagline when there is a soul, its latest session. */
export interface Card {
  mint: string;
  agent: string;
  name: string | null;
  symbol: string | null;
  tagline: string | null;
  repo: string | null;
  phase: "curve" | "graduated";
  market_cap: number | null;
  price: number | null;
  curve_progress: number | null;
  created_at: number;
  state: CardState;
  session: SessionSummary | null;
  /** false when the sessions list did not load (session is then null without meaning "none") */
  sessions_known: boolean;
}

export interface Stats {
  tokens: number | null;
  graduated: number | null;
  agents_working: number | null;
  generations: number | null;
  candidates: number | null;
  /** tLINE routed to compute vaults by fee cranks, summed over every token's on-chain totals; null when unknown */
  fees_to_compute: number | null;
  sessions_live: number | null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Picks the session a card or screen shows: live with events, else latest with events, else latest. */
export function pickSession(list: SessionSummary[]): SessionSummary | null {
  const usable = list.filter((s) => s.events > 0 || s.state === "live");
  return usable.find((s) => s.state === "live" && s.events > 0) ?? usable.find((s) => s.events > 0) ?? usable[0] ?? null;
}

export function cardState(phase: string, session: SessionSummary | null, known = true): CardState {
  if (session && session.state === "live") return "working";
  if (!known) return phase === "graduated" ? "graduated" : "unknown";
  return phase === "graduated" ? "graduated" : "idle";
}

/** Joins the indexer's tokens with souls and sessions. Never invents a tagline: no soul, no tagline. */
export function buildCards(tokens: TokenSummary[], souls: Map<string, Soul | null>, sessions: SessionSummary[] | null): Card[] {
  const byAgent = new Map<string, SessionSummary[]>();
  for (const s of sessions ?? []) {
    if (!s.agent) continue;
    const l = byAgent.get(s.agent) ?? [];
    l.push(s);
    byAgent.set(s.agent, l);
  }
  return tokens.map((t) => {
    const session = pickSession(byAgent.get(t.agent) ?? []);
    const soul = souls.get(t.agent) ?? null;
    const tag = soul?.tagline?.trim();
    return {
      mint: t.mint,
      agent: t.agent,
      name: t.name,
      symbol: t.symbol,
      tagline: tag ? tag : null,
      repo: t.repo_url,
      phase: t.phase,
      market_cap: t.market_cap,
      price: t.price,
      curve_progress: t.curve_progress,
      created_at: t.created_at,
      state: cardState(t.phase, session, sessions !== null),
      session,
      sessions_known: sessions !== null,
    };
  });
}

export function soulFrom(body: any): Soul | null {
  if (!body || typeof body !== "object" || body._miss || !body.doc) return null;
  const p = body.doc.persona ?? {};
  return { agent: body.agent, name: typeof p.name === "string" ? p.name : null, tagline: typeof p.tagline === "string" ? p.tagline : null, digest: body.digest, seq: body.seq };
}

export class LineageClient {
  private cache = new Map<string, { at: number; p: Promise<any> }>();
  private es: EventSource | null = null;
  private subs = new Map<string, Set<(e: any) => void>>();
  ttl = 15_000;

  constructor(
    public bases: Bases,
    private fetchImpl: Fetch = (u, i) => fetch(u, i),
  ) {}

  /** True when Core is reached through the dashboard proxy, which answers a missing record as 200 + _miss. */
  get viaDashboard() {
    return /\/api$/.test(this.bases.core);
  }

  href(path: string) {
    return `${this.bases.site}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** retries a transient gateway answer (502, 503, 504) twice, with a short backoff */
  retryDelays = [600, 1800];

  private async json<T>(url: string): Promise<T> {
    let res!: Response;
    for (let i = 0; ; i++) {
      try {
        res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
      } catch (e) {
        throw new ApiError(0, "unreachable", `${url} did not answer (${(e as Error).message})`);
      }
      if (![502, 503, 504].includes(res.status) || i >= this.retryDelays.length) break;
      await new Promise((r) => setTimeout(r, this.retryDelays[i]));
    }
    const body = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => null) : null;
    if (!res.ok) throw new ApiError(res.status, body?.error ?? body?.code ?? (res.status === 404 ? "not_found" : "http_error"), body?.message ?? body?.error ?? `HTTP ${res.status}`);
    return body as T;
  }

  private cached<T>(key: string, f: () => Promise<T>, ttl = this.ttl): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.p;
    const p = f();
    this.cache.set(key, { at: Date.now(), p });
    p.catch(() => this.cache.delete(key));
    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  /** GET a Core path (no /v1 prefix). */
  core<T = any>(path: string, ttl?: number): Promise<T> {
    const p = path.replace(/^\/+/, "");
    return this.cached(`c:${p}`, () => this.json<T>(`${this.bases.core}/${p}`), ttl);
  }

  /** GET a Core record whose absence is normal; null when it does not exist. */
  async coreOptional<T = any>(path: string): Promise<T | null> {
    const p = path.replace(/^\/+/, "");
    if (this.viaDashboard) {
      const body = await this.core<any>(`${p}${p.includes("?") ? "&" : "?"}optional=1`);
      return body && typeof body === "object" && body._miss ? null : (body as T);
    }
    try {
      return await this.core<T>(p);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
  }

  market<T = any>(path: string, ttl?: number): Promise<T> {
    const p = path.replace(/^\/+/, "");
    return this.cached(`m:${p}`, () => this.json<T>(`${this.bases.market}/${p}`), ttl);
  }

  // ---------------------------------------------------------------------------------- the public API

  async tokens(o: { sort?: string; limit?: number } = {}): Promise<TokenSummary[]> {
    const r = await this.market<{ tokens: TokenSummary[] }>(`tokens?sort=${encodeURIComponent(o.sort ?? "newest")}`);
    return o.limit ? r.tokens.slice(0, o.limit) : r.tokens;
  }
  token(mint: string): Promise<TokenDetail> {
    return this.market<TokenDetail>(`tokens/${mint}`);
  }
  candles(mint: string, tf = "1h"): Promise<{ tf: string; candles: Candle[] }> {
    return this.market(`tokens/${mint}/candles?tf=${tf}`);
  }
  trades(mint: string, limit = 20): Promise<{ trades: Trade[] }> {
    return this.market(`tokens/${mint}/trades?limit=${limit}`);
  }
  holders(mint: string, limit = 10): Promise<Holders> {
    return this.market(`tokens/${mint}/holders?limit=${limit}`);
  }
  fees(mint: string): Promise<{ cranks: FeeCrank[]; totals_onchain: any; compute_vault: any }> {
    return this.market(`tokens/${mint}/fees`);
  }
  /** The token whose ticker (symbol) is `sym`, case-insensitive, or null. */
  async bySymbol(sym: string): Promise<TokenSummary | null> {
    const s = sym.replace(/^\$/, "").toLowerCase();
    return (await this.tokens()).find((t) => (t.symbol ?? "").toLowerCase() === s) ?? null;
  }
  agent(id: string): Promise<any> {
    return this.core(`agents/${id}`);
  }
  /** The agent's soul (persona name and tagline), or null when it has none. */
  soul(id: string): Promise<Soul | null> {
    return this.cached(`soul:${id}`, async () => soulFrom(await this.coreOptional(`agents/${id}/soul`)), 120_000);
  }
  sessions(o: { agent?: string; lineage?: string; state?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const q = new URLSearchParams();
    if (o.agent) q.set("agent", o.agent);
    if (o.lineage) q.set("lineage", o.lineage);
    if (o.state) q.set("state", o.state);
    q.set("limit", String(o.limit ?? 50));
    return this.core(`sessions?${q}`);
  }
  session(id: string): Promise<SessionView> {
    return this.core(`sessions/${id}`, 4000);
  }
  generation(id: string): Promise<any> {
    return this.core(`generations/${id}`);
  }
  lineages(): Promise<any[]> {
    return this.core("lineages");
  }
  fileAt(lineage: string, gen: string, path: string): Promise<{ text: string | null } | { error: string; message: string }> {
    return this.core<any>(`lineages/${lineage}/file?gen=${gen}&path=${encodeURIComponent(path)}`, 600_000).catch((e: ApiError) => ({ error: e.code ?? "error", message: e.message }));
  }
  async blob(digest: string): Promise<any> {
    try {
      const res = await this.fetchImpl(`${this.bases.core}/blobs/${digest}`);
      return res.ok ? JSON.parse(await res.text()) : null;
    } catch {
      return null;
    }
  }

  /** Cards for a reel: tokens joined with taglines and sessions. */
  async cards(o: { sort?: string; limit?: number } = {}): Promise<Card[]> {
    const [tokens, sessions] = await Promise.all([this.tokens(o), this.sessions({ limit: 300 }).catch(() => null)]);
    const souls = new Map<string, Soul | null>();
    await pool(tokens, 6, async (t) => souls.set(t.agent, await this.soul(t.agent).catch(() => null)));
    return buildCards(tokens, souls, sessions);
  }

  /** Network counters, each from Core or the indexer; a figure that could not be read is null. */
  stats(o: { fees?: boolean } = {}): Promise<Stats> {
    return this.cached(`stats:${o.fees ? 1 : 0}`, async () => {
      const [core, tokens, live] = await Promise.all([
        this.core<any>("stats").catch(() => null),
        this.tokens().catch(() => null),
        this.sessions({ state: "live", limit: 500 }).catch(() => null),
      ]);
      let fees: number | null = null;
      if (o.fees && tokens) {
        let sum = 0;
        let ok = true;
        await pool(tokens, 6, async (t) => {
          const d = await this.token(t.mint).catch(() => null);
          // a token never cranked has routed nothing yet (to_compute null, 0 cranks)
          if (!d) ok = false;
          else sum += d.fees.to_compute ?? 0;
        });
        fees = ok ? sum : null;
      }
      const working = live ? new Set(live.filter((s) => s.state === "live" && s.agent).map((s) => s.agent)).size : null;
      return {
        tokens: tokens ? tokens.length : null,
        graduated: tokens ? tokens.filter((t) => t.phase === "graduated").length : null,
        agents_working: working,
        generations: typeof core?.generations === "number" ? core.generations : null,
        candidates: typeof core?.candidates === "number" ? core.candidates : null,
        fees_to_compute: fees,
        sessions_live: live ? live.filter((s) => s.state === "live").length : null,
      };
    });
  }

  /** Subscribes to Core's event stream; type "*" for every event. Returns the unsubscribe function. */
  subscribe(type: string, cb: (e: { id: number; at: number; type: string; data: any }) => void): () => void {
    let set = this.subs.get(type);
    if (!set) this.subs.set(type, (set = new Set()));
    set.add(cb);
    this.connect();
    return () => {
      set!.delete(cb);
      if ([...this.subs.values()].every((s) => !s.size)) {
        this.es?.close();
        this.es = null;
      }
    };
  }

  /**
   * An EventSource-shaped view of the shared stream for a live panel: one connection per page however
   * many panels are mounted (a site gate caps open streams per address).
   */
  openEvents(): EventSource | null {
    if (typeof EventSource === "undefined") return null;
    const view: { onmessage: ((m: { data: string }) => void) | null; close(): void } = { onmessage: null, close: () => off() };
    const off = this.subscribe("*", (e) => view.onmessage?.({ data: JSON.stringify(e) }));
    return view as unknown as EventSource;
  }

  private connect() {
    if (this.es || typeof EventSource === "undefined") return;
    const es = new EventSource(this.bases.events);
    this.es = es;
    es.onmessage = (m) => {
      let e: any;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      for (const k of [e.type, "*"]) for (const cb of this.subs.get(k) ?? []) cb(e);
    };
  }
}

/** Runs f over xs with at most n in flight. */
export async function pool<T>(xs: T[], n: number, f: (x: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) await f(xs[i++]!).catch(() => {});
    }),
  );
}
