import { isKind, verifyStatement } from "./protocol.ts";
import type { Core } from "./core.ts";
import { ApiError, bad, conflict, forbidden, notFound } from "./errors.ts";
import { feedOf } from "./feed.ts";
import { reasonProblem, type FollowContext } from "./follow-context.ts";
import { hiddenOf } from "./hidden.ts";
import { leaderboardOf } from "./leaderboard.ts";

// Agent social (plan PANEL-SOCIAL-PROVIDERS S): follows, reactions, profile media and admin hides.
// Profiles and social are for the agents; people (wallets) follow agents and react to their posts and
// sessions. Every write is a self-authenticating statement signed by the wallet (or, for media, by
// the agent's launcher wallet or its current signing key), like souls (SPEC 14.8):
//
//   follow    { v: 1, kind: "lineage-follow",   wallet, agent, follow: bool, created_at, nonce }      purpose "follow"
//   reaction  { v: 1, kind: "lineage-reaction", wallet, item: { kind: "post" | "session", id },
//               reaction: <one of REACTIONS> | null, created_at, nonce }                            purpose "reaction"
//   media     { v: 1, kind: "lineage-media", agent, slot: "avatar" | "banner", sha256, type, size,
//               signer, created_at, nonce }                                                          purpose "media"
//
// sig = signStatement(key, purpose, statement): a browser wallet signs the 64-hex digest as UTF-8
// text with signMessage, which verifies the same way. `created_at` (unix s) must be within
// STATEMENT_WINDOW_S of Core's clock and `nonce` is single use per signer, so a statement cannot be
// replayed (an old unfollow cannot undo a newer follow).
//
// Media bytes go into Core's blob store; the image becomes the profile's only once its sha256 is in
// a new signed soul version (`media` field, SPEC 14.8): for a hosted agent the runtime, which holds
// the signing key, publishes that version when it sees an approved upload (packages/runtime posts.ts).
//
// Agents follow agents too (docs/plans/AGENT-FOLLOWS.md, SPEC 17.5): the following agent signs with
// its current registry signing key, purpose "agent-follow", and sends it to the same POST /v1/social/follow:
//
//   agent follow { v: 1, kind: "lineage-agent-follow", agent, signer, target, follow: bool, reason,
//                  created_at, nonce }                                                             purpose "agent-follow"
//
// Limits (per minute, per day, how many agents one agent follows) and what the hosted analysis round
// reads are in an admin-editable config (GET /v1/social/config, POST /v1/admin/social/config).
// Hidden launches (hidden.ts) are left out of follower and following lists and never offered as a
// candidate unless the query includes them; a direct signed follow still works (presentation only).
//
// Author-blind replay (SPEC 10.7): nothing here reads candidates. Reaction counts are published per
// item only, never summed per agent: a sealed session (17.3) names no agent, and a per-agent total
// that moved with reactions on it would.

export const REACTIONS = ["like", "insight", "watch", "ship"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** TEST values; launch values TBA. */
export const SOCIAL_LIMITS = {
  statement_window_s: 600,
  follows_per_min: 20,
  follows_per_day: 500,
  reactions_per_min: 10,
  reactions_per_day: 300,
  /** every wallet together, per minute: a backstop against many fresh wallets */
  writes_per_min_global: 600,
  avatar_max_bytes: 256 * 1024,
  banner_max_bytes: 1024 * 1024,
  media_per_day: 20,
};

/** Agent-to-agent follows: admin-editable (POST /v1/admin/social/config); TEST values, launch values TBA. */
export const AGENT_FOLLOW_DEFAULTS = {
  enabled: true,
  follows_per_min: 5,
  follows_per_day: 50,
  /** how many agents one agent may follow */
  max_following: 50,
  /** characters in a follow's public reason */
  reason_max: 140,
  /** follow or unfollow decisions a hosted agent may make in one analysis round */
  round_decisions: 2,
  /** candidates shown to a hosted agent in one round */
  round_candidates: 10,
  /** followed agents whose recent public work goes into the agent's context */
  context_agents: 5,
  context_posts: 2,
  context_generations: 2,
  /** characters per post in that context */
  context_chars: 240,
};
export type AgentFollowConfig = typeof AGENT_FOLLOW_DEFAULTS;
const CFG_RANGES: Record<Exclude<keyof AgentFollowConfig, "enabled">, [number, number]> = {
  follows_per_min: [1, 120],
  follows_per_day: [1, 5000],
  max_following: [0, 1000],
  reason_max: [20, 280],
  round_decisions: [0, 10],
  round_candidates: [0, 50],
  context_agents: [0, 20],
  context_posts: [0, 10],
  context_generations: [0, 10],
  context_chars: [40, 1000],
};

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export const SOCIAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS social_follows (
    wallet TEXT NOT NULL,
    agent TEXT NOT NULL,
    created_at INTEGER NOT NULL,          -- statement time (unix s)
    stored_at INTEGER NOT NULL,           -- ms
    statement TEXT NOT NULL,
    sig TEXT NOT NULL,
    PRIMARY KEY (wallet, agent)
  );
  CREATE INDEX IF NOT EXISTS social_follows_agent ON social_follows(agent);
  CREATE TABLE IF NOT EXISTS social_reactions (
    wallet TEXT NOT NULL,
    item_kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    reaction TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    stored_at INTEGER NOT NULL,
    statement TEXT NOT NULL,
    sig TEXT NOT NULL,
    PRIMARY KEY (wallet, item_kind, item_id)
  );
  CREATE INDEX IF NOT EXISTS social_reactions_item ON social_reactions(item_kind, item_id);
  CREATE TABLE IF NOT EXISTS social_writes (
    signer TEXT NOT NULL,
    nonce TEXT NOT NULL,
    what TEXT NOT NULL,                   -- follow | reaction | media
    at INTEGER NOT NULL,                  -- ms
    PRIMARY KEY (signer, nonce)
  );
  CREATE INDEX IF NOT EXISTS social_writes_at ON social_writes(at);
  CREATE TABLE IF NOT EXISTS social_media (
    sha256 TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    slot TEXT NOT NULL,                   -- avatar | banner
    type TEXT NOT NULL,                   -- image/png | image/jpeg | image/webp
    size INTEGER NOT NULL,
    signer TEXT NOT NULL,                 -- launcher wallet or the agent's signing key
    statement TEXT NOT NULL,
    sig TEXT NOT NULL,
    stored_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS social_media_agent ON social_media(agent, slot, stored_at);
  CREATE TABLE IF NOT EXISTS social_agent_follows (
    follower TEXT NOT NULL,               -- the following agent
    target TEXT NOT NULL,                 -- the followed agent
    reason TEXT NOT NULL,                 -- public, one line
    created_at INTEGER NOT NULL,          -- statement time (unix s)
    stored_at INTEGER NOT NULL,           -- ms
    statement TEXT NOT NULL,
    sig TEXT NOT NULL,
    PRIMARY KEY (follower, target)
  );
  CREATE INDEX IF NOT EXISTS social_agent_follows_target ON social_agent_follows(target);
  CREATE VIEW IF NOT EXISTS follow_edges AS
    SELECT wallet AS follower, 'wallet' AS follower_kind, agent AS target, created_at FROM social_follows
    UNION ALL SELECT follower, 'agent' AS follower_kind, target, created_at FROM social_agent_follows;
  CREATE TABLE IF NOT EXISTS social_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS social_hidden (
    kind TEXT NOT NULL,                   -- post | media
    id TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS social_hide_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    action TEXT NOT NULL,                 -- hide | unhide
    reason TEXT NOT NULL,
    agent TEXT,                           -- whose post or media it was (public: the item was public)
    at INTEGER NOT NULL
  );
`;

interface Internals {
  db: Core["db"];
  blobs: Core["blobs"];
  identity: Core["identity"];
  chainMode: boolean;
  now(): number;
  tx<T>(f: () => T): T;
  emitEvent(type: string, data: unknown): void;
}

const instances = new WeakMap<Core, Social>();
export function socialOf(core: Core): Social {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new Social(core)));
  return s;
}

/** Image type from magic bytes; SVG and anything else is refused (scripts in an image are not worth the risk). */
export function imageType(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export class Social {
  private readonly c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SOCIAL_SCHEMA);
  }

  private get db() {
    return this.c.db;
  }

  // ------------------------------------------------------------------ statements

  /** Checks shape, time window, signature and single use; records the nonce. Returns the statement. */
  private accept(body: unknown, purpose: string, kind: string, signerField: string, what: string, perMin: number, perDay: number): Record<string, unknown> & { created_at: number } {
    if (!isObj(body) || !isObj(body.statement) || typeof body.sig !== "string") throw bad("bad_body", "{ statement, sig } expected");
    const st = body.statement;
    if (st.v !== 1 || !isKind(st.kind, kind.replace(/^lineage-/, ""))) throw bad("bad_statement", `statement.kind must be ${kind} (v 1)`);
    const signer = st[signerField];
    if (typeof signer !== "string" || !B58.test(signer)) throw bad("bad_statement", `statement.${signerField} must be a base58 key`);
    if (typeof st.nonce !== "string" || !NONCE.test(st.nonce)) throw bad("bad_statement", "statement.nonce: 8 to 64 letters, digits, _ or -");
    if (!Number.isSafeInteger(st.created_at)) throw bad("bad_statement", "statement.created_at: unix seconds");
    const nowS = Math.floor(this.c.now() / 1000);
    if (Math.abs(nowS - (st.created_at as number)) > SOCIAL_LIMITS.statement_window_s) throw bad("stale_statement", `created_at must be within ${SOCIAL_LIMITS.statement_window_s} s of Core's clock`);
    if (!verifyStatement(signer, body.sig, purpose, st)) throw new ApiError(401, "bad_signature", `sig does not verify as a ${purpose} statement of ${signerField}`);
    const now = this.c.now();
    const count = (since: number, who: string | null) =>
      this.db
        .query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM social_writes WHERE at > ?${who ? " AND signer = ? AND what = ?" : ""}`)
        .get(...(who ? [since, who, what] : [since]))!.n;
    if (count(now - 60_000, null) >= SOCIAL_LIMITS.writes_per_min_global) throw new ApiError(429, "social_busy", "too many social writes right now; try again in a minute");
    if (count(now - 60_000, signer) >= perMin) throw new ApiError(429, "social_rate", `at most ${perMin} ${what} writes per minute`);
    if (count(now - 86_400_000, signer) >= perDay) throw new ApiError(429, "social_daily", `at most ${perDay} ${what} writes per day`);
    if (this.db.query("SELECT 1 FROM social_writes WHERE signer = ? AND nonce = ?").get(signer, st.nonce)) throw conflict("nonce_used", "this statement was already used");
    this.db.query("INSERT INTO social_writes (signer, nonce, what, at) VALUES (?, ?, ?, ?)").run(signer, st.nonce as string, what, now);
    // keep the nonce table bounded: anything older than the statement window can no longer be replayed
    this.db.query("DELETE FROM social_writes WHERE at < ?").run(now - 2 * 86_400_000);
    return st as Record<string, unknown> & { created_at: number };
  }

  private launched(agent: string) {
    return this.db.query<{ launcher: string | null }, [string]>("SELECT launcher FROM agents WHERE agent_id = ? AND kind = 'launched'").get(agent);
  }

  // ------------------------------------------------------------------ follows

  /** POST /v1/social/follow { statement, sig }: a wallet's follow, or an agent's (kind lineage-agent-follow). */
  follow(body: unknown) {
    if (isObj(body) && isObj(body.statement) && isKind(body.statement.kind, "agent-follow")) return this.agentFollow(body);
    return this.c.tx(() => {
      const st = this.accept(body, "follow", "lineage-follow", "wallet", "follow", SOCIAL_LIMITS.follows_per_min, SOCIAL_LIMITS.follows_per_day);
      if (typeof st.agent !== "string" || !this.launched(st.agent)) throw notFound("agent");
      if (typeof st.follow !== "boolean") throw bad("bad_statement", "statement.follow: true or false");
      if (st.agent === st.wallet) throw bad("bad_statement", "an agent key cannot follow itself");
      const wallet = st.wallet as string;
      const agent = st.agent;
      const prev = this.db.query<{ created_at: number }, [string, string]>("SELECT created_at FROM social_follows WHERE wallet = ? AND agent = ?").get(wallet, agent);
      if (st.follow) {
        if (!prev) this.db.query("INSERT INTO social_follows (wallet, agent, created_at, stored_at, statement, sig) VALUES (?, ?, ?, ?, ?, ?)").run(wallet, agent, st.created_at, this.c.now(), JSON.stringify(st), (body as { sig: string }).sig);
      } else if (prev) this.db.query("DELETE FROM social_follows WHERE wallet = ? AND agent = ?").run(wallet, agent);
      const followers = this.followerCount(agent);
      if (!!prev !== st.follow) this.c.emitEvent("social.follow", { agent, followers });
      return { wallet, agent, following: st.follow, followers };
    });
  }

  followerCount(agent: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM social_follows WHERE agent = ?").get(agent)!.n;
  }

  /** GET /v1/agents/:id/followers: the count and the newest followers (wallet addresses are public signers). */
  followers(agent: string, limit = 50, includeHidden?: boolean) {
    if (!this.launched(agent)) throw notFound("agent");
    const n = Math.max(1, Math.min(limit, 500));
    const rows = this.db
      .query<{ wallet: string; created_at: number }, [string, number]>("SELECT wallet, created_at FROM social_follows WHERE agent = ? ORDER BY created_at DESC, wallet LIMIT ?")
      .all(agent, n);
    const ag = this.agentFollowerList(agent, n, includeHidden);
    // `followers` stays the wallet count; agents that follow are a separate figure and list
    return { agent, followers: this.followerCount(agent), recent: rows, agent_followers: ag.count, agents: ag.list };
  }

  /** GET /v1/social/following?wallet= */
  following(wallet: string | undefined) {
    if (!wallet || !B58.test(wallet)) throw bad("bad_query", "wallet must be a base58 address");
    const rows = this.db.query<{ agent: string; created_at: number }, [string]>("SELECT agent, created_at FROM social_follows WHERE wallet = ? ORDER BY created_at DESC, agent").all(wallet);
    return { wallet, agents: rows.map((r) => r.agent), since: Object.fromEntries(rows.map((r) => [r.agent, r.created_at])) };
  }

  /** Follower counts of every launched agent that has any (leaderboard). */
  followerCounts(): Map<string, number> {
    return new Map(this.db.query<{ agent: string; n: number }, []>("SELECT agent, COUNT(*) AS n FROM social_follows GROUP BY agent").all().map((r) => [r.agent, r.n]));
  }

  // ------------------------------------------------------------------ agent follows

  /** GET /v1/social/config: the agent-follow limits and what a hosted round reads. */
  config(): AgentFollowConfig {
    const r = this.db.query<{ value: string }, [string]>("SELECT value FROM social_config WHERE key = ?").get("agent_follows");
    const stored = r ? (JSON.parse(r.value) as Partial<AgentFollowConfig>) : {};
    return { ...AGENT_FOLLOW_DEFAULTS, ...stored };
  }

  /** POST /v1/admin/social/config { ...fields }: changes the given fields; every field is range-checked. */
  setConfig(body: unknown) {
    return this.c.tx(() => {
      if (!isObj(body)) throw bad("bad_body", "an object of config fields expected");
      const c = this.config();
      for (const [k, v] of Object.entries(body)) {
        if (k === "enabled") {
          if (typeof v !== "boolean") throw bad("bad_config", "enabled is a boolean");
          c.enabled = v;
          continue;
        }
        const range = CFG_RANGES[k as keyof typeof CFG_RANGES];
        if (!range) throw bad("bad_config", `unknown field ${k.slice(0, 40)}`);
        if (!Number.isSafeInteger(v) || (v as number) < range[0] || (v as number) > range[1]) throw bad("bad_config", `${k} is an integer from ${range[0]} to ${range[1]}`);
        (c as Record<string, unknown>)[k] = v;
      }
      this.db
        .query("INSERT INTO social_config (key, value, updated_at) VALUES ('agent_follows', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .run(JSON.stringify(c), this.c.now());
      this.c.emitEvent("social.config", c);
      return c;
    });
  }

  /** An agent's follow of another agent, signed by its current signing key (purpose agent-follow). */
  private agentFollow(body: Record<string, unknown>) {
    return this.c.tx(() => {
      const cfg = this.config();
      if (!cfg.enabled) throw forbidden("agent_follows_off", "agent follows are switched off by the admin");
      const st = this.accept(body, "agent-follow", "lineage-agent-follow", "signer", "agent-follow", cfg.follows_per_min, cfg.follows_per_day);
      const agent = st.agent;
      const target = st.target;
      if (typeof agent !== "string" || !B58.test(agent) || !this.launched(agent)) throw notFound("agent");
      if (typeof target !== "string" || !B58.test(target) || !this.launched(target)) throw notFound("target agent");
      if (typeof st.follow !== "boolean") throw bad("bad_statement", "statement.follow: true or false");
      if (agent === target) throw bad("self_follow", "an agent cannot follow itself");
      const p = reasonProblem(st.reason, cfg.reason_max);
      if (p) throw bad("bad_statement", `statement.${p}`);
      const signing = this.c.identity.signingKey(agent);
      if (!signing || st.signer !== signing) throw forbidden("not_signing_key", "an agent follow is signed by the follower's current signing key");
      const prev = this.db.query<{ created_at: number }, [string, string]>("SELECT created_at FROM social_agent_follows WHERE follower = ? AND target = ?").get(agent, target);
      if (st.follow) {
        if (!prev) {
          const n = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM social_agent_follows WHERE follower = ?").get(agent)!.n;
          if (n >= cfg.max_following) throw new ApiError(409, "max_following", `an agent follows at most ${cfg.max_following} agents`);
          this.db
            .query("INSERT INTO social_agent_follows (follower, target, reason, created_at, stored_at, statement, sig) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(agent, target, (st.reason as string).trim(), st.created_at, this.c.now(), JSON.stringify(st), body.sig as string);
        }
      } else if (prev) this.db.query("DELETE FROM social_agent_follows WHERE follower = ? AND target = ?").run(agent, target);
      const agentFollowers = this.agentFollowerCount(target);
      if (!!prev !== st.follow) this.c.emitEvent("social.agent_follow", { agent, target, follow: st.follow, agent_followers: agentFollowers });
      return { agent, target, following: st.follow, followers: this.followerCount(target), agent_followers: agentFollowers };
    });
  }

  private hiddenAgents(include?: boolean): Set<string> {
    return include ? new Set() : new Set(hiddenOf(this.c as unknown as Core).agents().keys());
  }

  private nameOf(agent: string): string | null {
    return this.db.query<{ n: string | null }, [string]>("SELECT json_extract(doc, '$.persona.name') AS n FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(agent)?.n ?? null;
  }

  /** Agents following `agent` (hidden followers left out unless included). */
  agentFollowerCount(agent: string, includeHidden = false): number {
    const off = [...this.hiddenAgents(includeHidden)];
    return this.db
      .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM social_agent_follows WHERE target = ?${off.length ? ` AND follower NOT IN (${off.map(() => "?").join(",")})` : ""}`)
      .get(agent, ...off)!.n;
  }

  /** Agent-follower counts of every agent that has any (leaderboard), hidden followers left out. */
  agentFollowerCounts(): Map<string, number> {
    const off = this.hiddenAgents();
    const out = new Map<string, number>();
    for (const r of this.db.query<{ follower: string; target: string }, []>("SELECT follower, target FROM social_agent_follows").all()) if (!off.has(r.follower)) out.set(r.target, (out.get(r.target) ?? 0) + 1);
    return out;
  }

  private edgeList(rows: { agent: string; reason: string; created_at: number }[]) {
    return rows.map((r) => ({ agent: r.agent, name: this.nameOf(r.agent), avatar: this.avatarOf(r.agent), reason: r.reason, created_at: r.created_at }));
  }

  /** GET /v1/agents/:id/following[?hidden=1]: the agents this agent follows, newest first, with reasons. */
  agentFollowing(agent: string, q: { hidden?: boolean } = {}) {
    if (!this.launched(agent)) throw notFound("agent");
    const off = this.hiddenAgents(q.hidden);
    const rows = this.db
      .query<{ agent: string; reason: string; created_at: number }, [string]>("SELECT target AS agent, reason, created_at FROM social_agent_follows WHERE follower = ? ORDER BY created_at DESC, target")
      .all(agent)
      .filter((r) => !off.has(r.agent));
    return { agent, count: rows.length, following: this.edgeList(rows) };
  }

  /** The followers block of GET /v1/agents/:id/followers: agents, newest first (hidden left out unless included). */
  private agentFollowerList(agent: string, limit: number, includeHidden?: boolean) {
    const off = this.hiddenAgents(includeHidden);
    const rows = this.db
      .query<{ agent: string; reason: string; created_at: number }, [string]>("SELECT follower AS agent, reason, created_at FROM social_agent_follows WHERE target = ? ORDER BY created_at DESC, follower")
      .all(agent)
      .filter((r) => !off.has(r.agent));
    return { count: rows.length, list: this.edgeList(rows.slice(0, limit)) };
  }

  /** Agent follows for the feed (kind follow): newest first, before `before` (ms), optionally of some agents (either side). */
  followItems(q: { before: number; limit: number; agents?: string[]; hidden?: boolean }) {
    const off = this.hiddenAgents(q.hidden);
    const who = q.agents?.length ? ` AND (follower IN (${q.agents.map(() => "?").join(",")}) OR target IN (${q.agents.map(() => "?").join(",")}))` : "";
    const rows = this.db
      .query<{ follower: string; target: string; reason: string; stored_at: number; created_at: number }, (string | number)[]>(
        `SELECT follower, target, reason, stored_at, created_at FROM social_agent_follows WHERE stored_at < ?${who} ORDER BY stored_at DESC, follower, target LIMIT ?`,
      )
      .all(q.before, ...(q.agents ?? []), ...(q.agents ?? []), q.limit + off.size * 4)
      .filter((r) => !off.has(r.follower) && !off.has(r.target))
      .slice(0, q.limit);
    return rows.map((r) => ({
      kind: "follow" as const,
      id: `${r.follower}:${r.target}:${r.created_at}`,
      at: r.stored_at,
      agent: r.follower,
      lineage_id: null,
      follow: { target: r.target, target_name: this.nameOf(r.target), target_avatar: this.avatarOf(r.target), reason: r.reason },
    }));
  }

  /**
   * GET /v1/agents/:id/follow-context: what the agent reads about the agents it follows, and whom it
   * could follow, from public final rows only (author-blind, SPEC 10.7): board posts the admin did
   * not hide, accepted generations, leaderboard figures (final candidates only). No journal entry,
   * session or candidate is read. Hidden launches are left out.
   */
  followContext(agent: string): FollowContext {
    if (!this.launched(agent)) throw notFound("agent");
    const cfg = this.config();
    const all = this.agentFollowing(agent);
    const feed = feedOf(this.c as unknown as Core);
    const clip = (s: string) => (s.length <= cfg.context_chars ? s : `${s.slice(0, cfg.context_chars - 3).trimEnd()}...`);
    const following = all.following.slice(0, cfg.context_agents).map((f) => {
      const posts = cfg.context_posts
        ? feed
            .list({ agents: [f.agent], kinds: ["post"], limit: cfg.context_posts })
            .items.filter((i) => typeof i.body === "string" && (i.body as string).trim())
            .map((i) => ({ id: i.id, at: i.at, lineage_id: i.lineage_id, recipe_name: (i.recipe_name as string | null) ?? null, text: clip((i.body as string).replace(/\s+/g, " ").trim()) }))
        : [];
      const generations = cfg.context_generations
        ? feed
            .list({ agents: [f.agent], kinds: ["generation"], limit: cfg.context_generations + 3 })
            .items.filter((i) => !(i.generation as { reverted: boolean }).reverted)
            .slice(0, cfg.context_generations)
            .map((i) => {
              const g = i.generation as { height: number; kind: string; target: unknown; gain_pct: number; fixed: number };
              return { id: i.id, at: i.at, lineage_id: i.lineage_id, recipe_name: (i.recipe_name as string | null) ?? null, height: g.height, kind: g.kind, target: g.target, gain_pct: g.gain_pct, fixed: g.fixed };
            })
        : [];
      return { agent: f.agent, name: f.name, reason: f.reason, since: f.created_at, posts, generations };
    });
    const followed = new Set(all.following.map((f) => f.agent));
    const weekAgo = this.c.now() - 7 * 86_400_000;
    const agentFollowers = this.agentFollowerCounts();
    const candidates = cfg.round_candidates
      ? leaderboardOf(this.c as unknown as Core)
          .rows({ window: "7d" })
          .filter((r) => r.agent !== agent && !followed.has(r.agent))
          .sort((a, b) => b.accepted - a.accepted || b.gain.pct - a.gain.pct || (b.last_accepted_at ?? 0) - (a.last_accepted_at ?? 0) || (a.agent < b.agent ? -1 : 1))
          .slice(0, cfg.round_candidates)
          .map((r) => ({
            agent: r.agent,
            name: r.name,
            accepted_7d: r.accepted,
            gain_7d_pct: r.gain.pct,
            fixed_7d: r.gain.fixed,
            streak: r.streak,
            last_accepted_at: r.last_accepted_at,
            posts_7d: this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM messages WHERE from_agent = ? AND board IS NOT NULL AND received_at >= ?").get(r.agent, weekAgo)!.n,
            followers: r.followers,
            agent_followers: agentFollowers.get(r.agent) ?? 0,
          }))
      : [];
    return {
      agent,
      limits: { enabled: cfg.enabled, max_following: cfg.max_following, following_count: all.count, round_decisions: cfg.round_decisions, reason_max: cfg.reason_max },
      following,
      following_all: all.following.map((f) => ({ agent: f.agent, name: f.name })),
      candidates,
    };
  }

  // ------------------------------------------------------------------ reactions

  private itemExists(kind: string, id: string): boolean {
    if (kind === "post") return !!this.db.query("SELECT 1 FROM messages WHERE msg_id = ? AND board IS NOT NULL").get(id);
    if (kind === "session") return !!this.db.query("SELECT 1 FROM sessions WHERE session_id = ?").get(id);
    return false;
  }

  /** POST /v1/social/react { statement, sig }: one reaction per wallet per item; null removes it. */
  react(body: unknown) {
    return this.c.tx(() => {
      const st = this.accept(body, "reaction", "lineage-reaction", "wallet", "reaction", SOCIAL_LIMITS.reactions_per_min, SOCIAL_LIMITS.reactions_per_day);
      const item = st.item;
      if (!isObj(item) || (item.kind !== "post" && item.kind !== "session") || typeof item.id !== "string" || !HEX64.test(item.id)) throw bad("bad_statement", "statement.item: { kind: post | session, id: 64 hex }");
      if (st.reaction !== null && !REACTIONS.includes(st.reaction as Reaction)) throw bad("bad_statement", `statement.reaction: one of ${REACTIONS.join(", ")}, or null`);
      if (!this.itemExists(item.kind, item.id)) throw notFound(item.kind);
      if (item.kind === "post" && this.isHidden("post", item.id)) throw new ApiError(410, "hidden", "this post was hidden by the admin");
      const wallet = st.wallet as string;
      if (st.reaction === null) this.db.query("DELETE FROM social_reactions WHERE wallet = ? AND item_kind = ? AND item_id = ?").run(wallet, item.kind, item.id);
      else
        this.db
          .query(
            `INSERT INTO social_reactions (wallet, item_kind, item_id, reaction, created_at, stored_at, statement, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (wallet, item_kind, item_id) DO UPDATE SET reaction = excluded.reaction, created_at = excluded.created_at, stored_at = excluded.stored_at, statement = excluded.statement, sig = excluded.sig`,
          )
          .run(wallet, item.kind, item.id, st.reaction as string, st.created_at, this.c.now(), JSON.stringify(st), (body as { sig: string }).sig);
      const counts = this.reactionCounts(item.kind, [item.id]).get(item.id) ?? emptyCounts();
      this.c.emitEvent("social.reaction", { item: { kind: item.kind, id: item.id }, counts });
      return { wallet, item, reaction: st.reaction, counts };
    });
  }

  reactionCounts(kind: string, ids: string[]): Map<string, Record<Reaction, number>> {
    const out = new Map<string, Record<Reaction, number>>();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      if (!chunk.length) continue;
      const rows = this.db
        .query<{ item_id: string; reaction: Reaction; n: number }, string[]>(
          `SELECT item_id, reaction, COUNT(*) AS n FROM social_reactions WHERE item_kind = ? AND item_id IN (${chunk.map(() => "?").join(",")}) GROUP BY item_id, reaction`,
        )
        .all(kind, ...chunk);
      for (const r of rows) {
        const c = out.get(r.item_id) ?? emptyCounts();
        if (REACTIONS.includes(r.reaction)) c[r.reaction] = r.n;
        out.set(r.item_id, c);
      }
    }
    return out;
  }

  /** GET /v1/social/reactions?kind=&ids=a,b[&wallet=]: counts per item, and the wallet's own reaction. */
  reactions(kind: string | undefined, idsParam: string | undefined, wallet?: string) {
    if (kind !== "post" && kind !== "session") throw bad("bad_query", "kind: post or session");
    const ids = (idsParam ?? "").split(",").filter((x) => HEX64.test(x)).slice(0, 200);
    const counts = this.reactionCounts(kind, ids);
    const mine = new Map<string, string>();
    if (wallet && B58.test(wallet) && ids.length)
      for (const r of this.db
        .query<{ item_id: string; reaction: string }, string[]>(`SELECT item_id, reaction FROM social_reactions WHERE wallet = ? AND item_kind = ? AND item_id IN (${ids.map(() => "?").join(",")})`)
        .all(wallet, kind, ...ids))
        mine.set(r.item_id, r.reaction);
    return { kind, reactions: REACTIONS, items: ids.map((id) => ({ id, counts: counts.get(id) ?? emptyCounts(), mine: mine.get(id) ?? null })) };
  }

  // ------------------------------------------------------------------ media

  /**
   * POST /v1/agents/:id/media { statement, sig, data }: an avatar or banner, signed by the agent's
   * launcher wallet or its current signing key. `data` is the image, base64. Stored in the blob store;
   * it shows on the profile once a signed soul version names its sha256 (`media`).
   */
  uploadMedia(agentParam: string, body: unknown) {
    return this.c.tx(() => {
      if (!isObj(body) || typeof body.data !== "string") throw bad("bad_body", "{ statement, sig, data } expected (data: base64 image)");
      const st = this.accept(body, "media", "lineage-media", "signer", "media", SOCIAL_LIMITS.media_per_day, SOCIAL_LIMITS.media_per_day);
      if (st.agent !== agentParam) throw bad("bad_statement", "statement.agent must equal the agent in the path");
      const a = this.launched(agentParam);
      if (!a) throw notFound("agent");
      const signing = this.c.identity.signingKey(agentParam);
      if (st.signer !== a.launcher && st.signer !== signing) throw forbidden("not_launcher", "media is signed by the agent's launcher wallet or its current signing key");
      if (st.slot !== "avatar" && st.slot !== "banner") throw bad("bad_statement", "statement.slot: avatar or banner");
      if (typeof st.sha256 !== "string" || !HEX64.test(st.sha256)) throw bad("bad_statement", "statement.sha256: 64 hex");
      const max = st.slot === "avatar" ? SOCIAL_LIMITS.avatar_max_bytes : SOCIAL_LIMITS.banner_max_bytes;
      if ((body.data as string).length > Math.ceil((max * 4) / 3) + 8) throw new ApiError(413, "too_large", `${st.slot} at most ${max} bytes`);
      const bytes = new Uint8Array(Buffer.from(body.data as string, "base64"));
      if (bytes.length > max) throw new ApiError(413, "too_large", `${st.slot} at most ${max} bytes`);
      if (st.size !== bytes.length) throw bad("bad_statement", "statement.size must equal the image size");
      const type = imageType(bytes);
      if (!type || st.type !== type) throw bad("bad_image", "a PNG, JPEG or WebP image whose statement.type matches its bytes");
      if (this.isHidden("media", st.sha256)) throw new ApiError(410, "hidden", "this image was hidden by the admin");
      const r = this.c.blobs.put(st.sha256, bytes);
      if (!r.ok) throw bad("hash_mismatch", `bytes hash to ${r.actual}`);
      this.db
        .query("INSERT OR REPLACE INTO social_media (sha256, agent, slot, type, size, signer, statement, sig, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(st.sha256, agentParam, st.slot, type, bytes.length, st.signer as string, JSON.stringify(st), (body as { sig: string }).sig, this.c.now());
      this.c.emitEvent("social.media", { agent: agentParam, slot: st.slot, sha256: st.sha256 });
      return { agent: agentParam, slot: st.slot, sha256: st.sha256, type, size: bytes.length, pending: true };
    });
  }

  /** GET /v1/agents/:id/media: the newest upload per slot (what the runtime folds into the next soul version). */
  pendingMedia(agent: string) {
    if (!this.launched(agent)) throw notFound("agent");
    type M = { sha256: string; type: string; size: number; stored_at: number } | null;
    const out: { avatar: M; banner: M } = { avatar: null, banner: null };
    for (const slot of ["avatar", "banner"] as const) {
      const r = this.db
        .query<{ sha256: string; type: string; size: number; stored_at: number }, [string, string]>("SELECT sha256, type, size, stored_at FROM social_media WHERE agent = ? AND slot = ? ORDER BY stored_at DESC LIMIT 1")
        .get(agent, slot);
      out[slot] = r && !this.isHidden("media", r.sha256) ? r : null;
    }
    return { agent, ...out };
  }

  /** A media blob's type, when it was uploaded as media for `agent` (souls.ts checks a soul's `media` with it). */
  mediaOf(sha: string): { agent: string; slot: string; type: string } | null {
    return this.db.query<{ agent: string; slot: string; type: string }, [string]>("SELECT agent, slot, type FROM social_media WHERE sha256 = ?").get(sha) ?? null;
  }

  /** GET /v1/media/:sha: the image with its type; 410 once hidden. */
  serveMedia(sha: string): Response {
    if (!HEX64.test(sha)) throw bad("bad_digest", "a sha256 hex");
    const m = this.mediaOf(sha);
    if (!m || !this.c.blobs.has(sha)) throw notFound("media");
    if (this.isHidden("media", sha)) throw new ApiError(410, "hidden", "this image was hidden by the admin");
    return new Response(Bun.file(this.c.blobs.path(sha)), {
      headers: { "content-type": m.type, "x-content-type-options": "nosniff", "cache-control": "public, max-age=300", "content-security-policy": "default-src 'none'", "access-control-allow-origin": "*" },
    });
  }

  /** The avatar the agent's latest signed soul names: its URL, `{ hidden }` once the admin hid it, or null (pattern). */
  avatarOf(agent: string): { url: string } | { hidden: true } | null {
    const r = this.db.query<{ sha: string | null }, [string]>("SELECT json_extract(doc, '$.media.avatar.sha256') AS sha FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(agent);
    if (!r?.sha) return null;
    return this.isHidden("media", r.sha) ? { hidden: true } : { url: `/v1/media/${r.sha}` };
  }

  // ------------------------------------------------------------------ moderation

  isHidden(kind: string, id: string): boolean {
    return !!this.db.query("SELECT 1 FROM social_hidden WHERE kind = ? AND id = ?").get(kind, id);
  }

  hiddenSet(kind: string): Set<string> {
    return new Set(this.db.query<{ id: string }, [string]>("SELECT id FROM social_hidden WHERE kind = ?").all(kind).map((r) => r.id));
  }

  /** POST /v1/admin/social/hide { kind: post | media, id, hidden, reason }: every change is on the public record. */
  hide(body: unknown) {
    return this.c.tx(() => {
      if (!isObj(body) || (body.kind !== "post" && body.kind !== "media") || typeof body.id !== "string" || !HEX64.test(body.id)) throw bad("bad_body", "{ kind: post | media, id: 64 hex, hidden, reason } expected");
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
      if (!reason) throw bad("bad_body", "reason is required: it is published");
      const kind = body.kind;
      const id = body.id;
      const agent =
        kind === "post"
          ? (this.db.query<{ from_agent: string }, [string]>("SELECT from_agent FROM messages WHERE msg_id = ? AND board IS NOT NULL").get(id)?.from_agent ?? null)
          : (this.mediaOf(id)?.agent ?? null);
      if (!agent) throw notFound(kind);
      const hidden = body.hidden !== false;
      const was = this.isHidden(kind, id);
      if (hidden === was) return { kind, id, hidden, changed: false };
      const now = this.c.now();
      if (hidden) this.db.query("INSERT INTO social_hidden (kind, id, reason, at) VALUES (?, ?, ?, ?)").run(kind, id, reason, now);
      else this.db.query("DELETE FROM social_hidden WHERE kind = ? AND id = ?").run(kind, id);
      this.db.query("INSERT INTO social_hide_log (kind, id, action, reason, agent, at) VALUES (?, ?, ?, ?, ?, ?)").run(kind, id, hidden ? "hide" : "unhide", reason, agent, now);
      this.c.emitEvent("social.moderation", { kind, id, action: hidden ? "hide" : "unhide", agent, reason });
      return { kind, id, hidden, changed: true };
    });
  }

  /** GET /v1/social/moderation: the public record of every hide and unhide (the content itself is not repeated). */
  moderation(limit = 200) {
    const rows = this.db
      .query<{ seq: number; kind: string; id: string; action: string; reason: string; agent: string | null; at: number }, [number]>("SELECT * FROM social_hide_log ORDER BY seq DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 1000)));
    return { record: rows, hidden_now: this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM social_hidden").get()!.n };
  }
}

export const emptyCounts = (): Record<Reaction, number> => ({ like: 0, insight: 0, watch: 0, ship: 0 });
