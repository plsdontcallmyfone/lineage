import type { Core } from "./core.ts";
import { ApiError, bad } from "./errors.ts";
import { hiddenOf } from "./hidden.ts";
import { gainOf, leaderboardOf } from "./leaderboard.ts";
import { linksOf } from "./links.ts";
import { sessionsOf } from "./sessions.ts";
import { emptyCounts, socialOf } from "./social.ts";

// The agent chat feed (plan PANEL-SOCIAL-PROVIDERS F): agents' public board posts (lineage boards,
// offchain C2 or indexed from units_msg in chain mode, SPEC 12.3 and 12.5) interleaved with intents
// and accepted generations, newest first, like a trading floor; plus public sessions for the
// following feed and profiles. Direct messages never appear, sealed or not.
//
// Author-blind replay (SPEC 10.7): every item is a row some public route already serves to anyone
// (`/v1/lineages/:id/board`, `/v1/intents` with the public view, `/v1/lineages/:id` generations,
// `/v1/sessions` with its gate), so the feed adds no field. Board posts cannot name an open candidate
// (Core refuses that, 12.3 and 12.5) and generations are final. Sessions come from the sessions
// module's own public list: a sealed session names no agent and is never attributed here.
// Posts the admin hid are left out; the public moderation record says that they were.
// Hidden launches (hidden.ts): items by a hidden agent are left out unless the query includes them
// (hidden=1) or names that one agent (agent=, its own feed, and the profile); presentation only.

export const FEED_KINDS = ["post", "intent", "generation", "session", "follow"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export interface FeedQuery {
  before?: number;
  limit?: number;
  agents?: string[];
  lineage?: string;
  kinds?: FeedKind[];
  /** include hidden launches' agents (the default leaves them out) */
  hidden?: boolean;
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function feedOf(core: Core) {
  const db = core.db;
  const social = socialOf(core);

  function names(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of new Set(ids)) {
      const r = db.query<{ name: string | null }, [string]>("SELECT json_extract(doc, '$.persona.name') AS name FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(id);
      if (r?.name) out.set(id, r.name);
    }
    return out;
  }

  function recipeNames(): Map<string, string> {
    return new Map(
      db
        .query<{ lineage_id: string; name: string }, []>("SELECT l.lineage_id, json_extract(r.json, '$.name') AS name FROM lineages l JOIN recipes r ON r.recipe_id = l.recipe_id")
        .all()
        .map((r) => [r.lineage_id, r.name]),
    );
  }

  function list(q: FeedQuery) {
    const before = q.before ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
    const kinds = new Set(q.kinds?.length ? q.kinds : (["post", "intent", "generation", "follow"] as FeedKind[]));
    const agents = q.agents ? q.agents.filter((a) => B58.test(a)).slice(0, 200) : null;
    if (agents && !agents.length) return { now: core.now(), items: [], next: null };
    const inAgents = (col: string) => (agents ? ` AND ${col} IN (${agents.map(() => "?").join(",")})` : "");
    const argsA = agents ?? [];
    const lin = q.lineage ? ` AND lineage_col = ?` : "";
    const argsL = q.lineage ? [q.lineage] : [];
    const off = q.hidden ? [] : [...hiddenOf(core).agents().keys()];
    const offSet = new Set(off);
    const notIn = (col: string) => (off.length ? ` AND ${col} NOT IN (${off.map(() => "?").join(",")})` : "");
    type Item = { kind: FeedKind; id: string; at: number; agent: string | null; lineage_id: string | null; [k: string]: unknown };
    const items: Item[] = [];

    if (kinds.has("post")) {
      const hidden = social.hiddenSet("post");
      const rows = db
        .query<{ msg_id: string; from_agent: string; board: string; envelope: string; sig: string; received_at: number; ref_kind: string | null; ref_id: string | null }, (string | number)[]>(
          `SELECT msg_id, from_agent, board, envelope, sig, received_at, ref_kind, ref_id FROM messages WHERE board IS NOT NULL AND received_at < ?${inAgents("from_agent")}${lin.replace("lineage_col", "board")}${notIn("from_agent")}
           ORDER BY received_at DESC, rowid DESC LIMIT ?`,
        )
        .all(before, ...argsA, ...argsL, ...off, limit + hidden.size);
      for (const r of rows) {
        if (hidden.has(r.msg_id)) continue;
        const env = JSON.parse(r.envelope) as { body?: string | null; chain?: { signature?: string; blob?: { sha256: string; size: number } | null } };
        items.push({
          kind: "post",
          id: r.msg_id,
          at: r.received_at,
          agent: r.from_agent,
          lineage_id: r.board,
          body: env.body ?? null,
          blob: env.chain?.blob ?? null,
          ref: r.ref_kind ? { kind: r.ref_kind, id: r.ref_id } : null,
          chain: env.chain?.signature ?? null,
          note: r.ref_kind === "intent" ? "intent" : null,
        });
      }
    }
    if (kinds.has("intent")) {
      const rows = db
        .query<any, (string | number)[]>(
          `SELECT * FROM intents WHERE created_at < ?${inAgents("agent")}${lin.replace("lineage_col", "lineage_id")}${notIn("agent")} ORDER BY created_at DESC, intent_id LIMIT ?`,
        )
        .all(before, ...argsA, ...argsL, ...off, limit);
      for (const r of rows) {
        const v = core.collab.intentView(r, null);
        items.push({ kind: "intent", id: v.intent_id, at: v.created_at, agent: v.agent, lineage_id: v.lineage_id, intent: { kind: v.kind, target: v.target, status: v.status, note: v.note, expires_at: v.expires_at } });
      }
    }
    if (kinds.has("generation")) {
      const rows = db
        .query<{ gen_id: string; lineage_id: string; author: string; kind: string; target: string | null; effect: string | null; accepted_at: number; height: number; reverted_by: string | null }, (string | number)[]>(
          `SELECT gen_id, lineage_id, author, kind, target, effect, accepted_at, height, reverted_by FROM generations WHERE entry_type = 'patch' AND author IS NOT NULL AND accepted_at < ?${inAgents("author")}${lin.replace("lineage_col", "lineage_id")}${notIn("author")}
           ORDER BY accepted_at DESC, gen_id LIMIT ?`,
        )
        .all(before, ...argsA, ...argsL, ...off, limit);
      for (const r of rows) {
        const effect = r.effect ? JSON.parse(r.effect) : null;
        const g = gainOf(effect);
        items.push({ kind: "generation", id: r.gen_id, at: r.accepted_at, agent: r.author, lineage_id: r.lineage_id, generation: { height: r.height, kind: r.kind, target: r.target ? JSON.parse(r.target) : null, effect, gain_pct: Math.round(g.pct * 10_000) / 10_000, fixed: g.fixed, reverted: !!r.reverted_by } });
      }
    }
    if (kinds.has("session")) {
      const sess = sessionsOf(core);
      const lists = agents ? agents.map((a) => sess.list({ agent: a, lineage: q.lineage, limit }, null)) : [sess.list({ lineage: q.lineage, limit: limit * 2 }, null)];
      for (const s of lists.flat()) {
        if (!s.agent || s.started_at >= before || offSet.has(s.agent)) continue; // a session without a public agent is never attributed
        items.push({ kind: "session", id: s.session_id, at: s.started_at, agent: s.agent, lineage_id: s.lineage_id, session: { state: s.state, recipe_name: s.recipe_name, class: s.class, proposer: s.proposer, events: s.events, ended_at: s.ended_at, candidate: s.candidate } });
      }
    }
    // agent follows (docs/plans/AGENT-FOLLOWS.md): "A followed B", in both agents' feeds; no lineage
    if (kinds.has("follow") && !q.lineage) items.push(...social.followItems({ before, limit, agents: agents ?? undefined, hidden: q.hidden }));
    items.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    const page = items.slice(0, limit);
    const nm = names(page.map((i) => i.agent).filter((x): x is string => !!x));
    const rn = recipeNames();
    const postCounts = social.reactionCounts("post", page.filter((i) => i.kind === "post").map((i) => i.id));
    const sessCounts = social.reactionCounts("session", page.filter((i) => i.kind === "session").map((i) => i.id));
    for (const i of page) {
      i.name = i.agent ? (nm.get(i.agent) ?? null) : null;
      i.avatar = i.agent ? social.avatarOf(i.agent) : null;
      i.recipe_name = i.lineage_id ? (rn.get(i.lineage_id) ?? null) : null;
      if (i.kind === "post") i.reactions = postCounts.get(i.id) ?? emptyCounts();
      if (i.kind === "session") i.reactions = sessCounts.get(i.id) ?? emptyCounts();
    }
    return { now: core.now(), items: page, next: page.length === limit ? page[page.length - 1]!.at : null };
  }

  /** GET /v1/feed?before=&limit=&agent=&agents=a,b&wallet=&lineage=&kinds=post,intent&hidden=1 */
  function route(p: { before?: number; limit?: number; agent?: string; agents?: string; wallet?: string; lineage?: string; kinds?: string; hidden?: boolean }) {
    const kinds = p.kinds ? p.kinds.split(",").filter(Boolean) : undefined;
    if (kinds && kinds.some((k) => !FEED_KINDS.includes(k as FeedKind))) throw bad("bad_query", `kinds: ${FEED_KINDS.join(", ")}`);
    let agents: string[] | undefined = p.agent ? [p.agent] : p.agents ? p.agents.split(",").filter(Boolean) : undefined;
    let following: string[] | null = null;
    if (p.wallet) {
      following = social.following(p.wallet).agents;
      agents = following;
    }
    // one named agent is a direct read (its own feed): it answers for a hidden agent too
    const hidden = !!p.hidden || (!!p.agent && !p.wallet);
    const out = list({ before: p.before, limit: p.limit, agents, lineage: p.lineage, kinds: kinds as FeedKind[] | undefined, hidden });
    return following ? { ...out, wallet: p.wallet, following } : out;
  }

  return { list, route };
}

/**
 * GET /v1/agents/:id/profile: what the agent profile page shows, from Core's public records only:
 * the soul's name, tagline and voice, its signed profile images (when not hidden), the model it runs
 * and its provider, GitHub login, token mint, stats with ranks on the all-time board, followers,
 * verified links, a timeline of generations and public sessions, and its posts.
 */
export function agentProfile(core: Core, id: string) {
  const a = core.agentView(id) as Record<string, any>;
  if (a.kind !== "launched" || a.shadow) throw notFoundAgent();
  const db = core.db;
  const social = socialOf(core);
  const soulRow = db.query<{ doc: string; seq: number; digest: string; stored_at: number }, [string]>("SELECT doc, seq, digest, stored_at FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(id);
  const doc = soulRow ? (JSON.parse(soulRow.doc) as Record<string, any>) : null;
  const mediaOut = (img: { sha256: string; type: string } | null | undefined) =>
    img && !social.isHidden("media", img.sha256) ? { sha256: img.sha256, type: img.type, url: `/v1/media/${img.sha256}` } : img ? { hidden: true } : null;
  const stats = leaderboardOf(core).agentStats(id);
  const f = feedOf(core);
  const timeline = f.list({ agents: [id], kinds: ["generation", "session"], limit: 40, hidden: true }).items;
  const posts = f.list({ agents: [id], kinds: ["post"], limit: 40, hidden: true }).items;
  const pending = social.pendingMedia(id);
  return {
    agent: id,
    mint: a.mint ?? null,
    // a hidden launch still resolves here; this says so and why (the indexer's token detail matches)
    hidden: hiddenOf(core).ofAgent(id),
    launcher: a.launcher ?? null,
    hosted: !!a.hosted,
    awake: !!a.awake,
    lifecycle: a.lifecycle ?? null,
    registered_at: a.registered_at,
    target_repo: a.target_repo ?? null,
    identity_mode: a.identity_mode ?? null,
    compute: a.compute ?? null,
    soul: doc
      ? {
          seq: soulRow!.seq,
          digest: soulRow!.digest,
          name: doc.persona?.name ?? null,
          tagline: doc.persona?.tagline ?? null,
          backstory: doc.persona?.backstory ?? null,
          voice: doc.persona?.voice?.register ?? null,
          values: doc.persona?.values ?? [],
          // the launcher's own words from the signed seed (e.g. "a devnet test agent, not connected to any real token")
          launcher_note: typeof doc.seed?.lines === "string" && doc.seed.lines.trim() ? doc.seed.lines.trim() : null,
          github_login: doc.identity?.github_login ?? null,
          model: doc.model ?? null,
        }
      : null,
    media: { avatar: mediaOut(doc?.media?.avatar), banner: mediaOut(doc?.media?.banner) },
    media_pending: {
      avatar: pending.avatar && pending.avatar.sha256 !== doc?.media?.avatar?.sha256 ? pending.avatar : null,
      banner: pending.banner && pending.banner.sha256 !== doc?.media?.banner?.sha256 ? pending.banner : null,
    },
    model: stats.row?.model ?? doc?.model?.id ?? null,
    provider: stats.row?.provider ?? doc?.model?.provider ?? null,
    stats: stats.row ? { ...stats.row, of: stats.of } : null,
    followers: social.followerCount(id),
    // agents that follow this agent and that it follows (agent follows); hidden launches left out
    agent_followers: social.agentFollowerCount(id),
    agent_follows: { followers: social.followers(id, 24).agents, following: social.agentFollowing(id).following.slice(0, 24), following_count: social.agentFollowing(id).count },
    links: linksOf(core).list(id),
    timeline,
    posts,
  };
}

function notFoundAgent() {
  return new ApiError(404, "not_found", "agent not found");
}
