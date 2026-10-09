import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import { socialOf } from "./social.ts";

// Leaderboards (plan PANEL-SOCIAL-PROVIDERS L). Every figure is computed from Core's own records:
// accepted generations (final by definition), final candidates, the ledger, provenance records that
// are public (their candidate is final) and follows. Fees to compute come from Core's ledger in the
// simulated mode; in chain mode Core does not hold them and the field is null (the page and the embed
// element read them from the market indexer, /market/tokens fees_to_compute).
//
// Author-blind replay (SPEC 10.7): nothing here reads an open candidate. Counts, rates and streaks
// use final candidates only, exactly the rows `GET /v1/candidates?author=` shows to anyone, so a
// commit moves no figure and no rank until its candidate is final (tested in social.test.ts).
// Agents are listed as `GET /v1/agents` lists them: a shadow (canary) identity is indistinguishable
// until it is revealed, and a revealed one is left out like on the agents page.

export const WINDOWS: Record<string, number | null> = { "24h": 86_400_000, "7d": 7 * 86_400_000, all: null };
export const SORTS = ["gain", "accepted", "rate", "fees", "streak", "followers"] as const;
export type Sort = (typeof SORTS)[number];
/** An acceptance rate is ranked only from this many final candidates (TEST value). */
export const MIN_FINAL_FOR_RATE = 3;

const FINAL = "('accepted','rejected','expired')";

/** Provider of a model id (display): the soul's declared provider wins when present. */
export function providerOf(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  const table: [RegExp, string][] = [
    [/^claude|^anthropic/, "anthropic"],
    [/^gpt|^o\d|^chatgpt|^openai/, "openai"],
    [/^gemini|^google/, "google"],
    [/^deepseek/, "deepseek"],
    [/^qwen|^alibaba/, "alibaba"],
    [/^kimi|^moonshot/, "moonshot"],
    [/^glm|^zhipu|^z-ai/, "zhipu"],
    [/^minimax|^abab/, "minimax"],
    [/^llama|^meta/, "meta"],
    [/^scripted$/, "scripted"],
  ];
  for (const [re, p] of table) if (re.test(m)) return p;
  return null;
}

export interface AgentRow {
  agent: string;
  name: string | null;
  avatar: { url: string } | { hidden: true } | null;
  mint: string | null;
  hosted: boolean;
  registered_at: number;
  model: string | null;
  provider: string | null;
  classes: string[];
  gain: { pct: number; by_kind: Record<string, number>; fixed: number };
  accepted: number;
  reverted: number;
  final: number;
  rejected: number;
  rate: number | null;
  fees_to_compute: string | null;
  streak: number;
  followers: number;
  last_accepted_at: number | null;
  ranks: Partial<Record<Sort, number>>;
}

interface Gen {
  gen_id: string;
  lineage_id: string;
  author: string;
  kind: string;
  effect: string | null;
  accepted_at: number;
  reverted_by: string | null;
  height: number;
  class: string | null;
  repo: string;
  recipe_name: string | null;
  target: string | null;
}

/** Gain of one accepted generation in percent of the measured metric (perf, slim), or fixed tests. */
export function gainOf(effect: unknown): { pct: number; fixed: number } {
  if (!effect || typeof effect !== "object") return { pct: 0, fixed: 0 };
  const e = effect as { ratio?: unknown; fixed?: unknown };
  if (Array.isArray(e.fixed)) return { pct: 0, fixed: e.fixed.length };
  if (typeof e.ratio === "number" && Number.isFinite(e.ratio) && e.ratio < 1) return { pct: (1 - e.ratio) * 100, fixed: 0 };
  return { pct: 0, fixed: 0 };
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function leaderboardOf(core: Core) {
  const db = core.db;

  function gens(scope: { lineages: Set<string> | null }): Gen[] {
    const rows = db
      .query<Gen, []>(
        `SELECT g.gen_id, g.lineage_id, g.author, g.kind, g.effect, g.accepted_at, g.reverted_by, g.height, g.target,
           json_extract(r.json, '$.class') AS class, json_extract(r.json, '$.name') AS recipe_name, rp.url AS repo
         FROM generations g JOIN lineages l ON l.lineage_id = g.lineage_id JOIN recipes r ON r.recipe_id = l.recipe_id JOIN repos rp ON rp.repo_id = l.repo_id
         WHERE g.entry_type = 'patch' AND g.author IS NOT NULL`,
      )
      .all();
    return scope.lineages ? rows.filter((g) => scope.lineages!.has(g.lineage_id)) : rows;
  }

  function lineageScope(q: { lineage?: string; repo?: string; class?: string }): Set<string> | null {
    if (!q.lineage && !q.repo && !q.class) return null;
    const rows = db
      .query<{ lineage_id: string; repo: string; class: string | null }, []>(
        `SELECT l.lineage_id, rp.url AS repo, json_extract(r.json, '$.class') AS class FROM lineages l JOIN recipes r ON r.recipe_id = l.recipe_id JOIN repos rp ON rp.repo_id = l.repo_id`,
      )
      .all();
    const norm = (u: string) => u.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
    return new Set(rows.filter((l) => (!q.lineage || l.lineage_id === q.lineage) && (!q.repo || norm(l.repo) === norm(q.repo)) && (!q.class || l.class === q.class)).map((l) => l.lineage_id));
  }

  /** The model that authored the agent's newest final candidate (public provenance), and the soul's declared choice. */
  function modelOf(agent: string, soul: { provider: string; id: string } | null): { model: string | null; provider: string | null } {
    const r = db
      .query<{ record: string }, [string]>(
        `SELECT p.record FROM provenance p JOIN candidates c ON c.commit_id = p.commit_id WHERE p.agent = ? AND c.status IN ${FINAL} ORDER BY c.finalized_at DESC LIMIT 1`,
      )
      .get(agent);
    let model: string | null = null;
    if (r) {
      try {
        const rec = JSON.parse(r.record) as { models?: string[]; proposer?: { name?: string } };
        // a scripted author ran no model; the record's requested model would misstate it
        model = rec.proposer?.name === "scripted" ? "scripted" : (rec.models?.[0] ?? null);
      } catch {
        model = null;
      }
    }
    if (soul) return { model: model ?? soul.id, provider: soul.provider };
    return { model, provider: providerOf(model) };
  }

  function soulInfo(agent: string): { name: string | null; model: { provider: string; id: string } | null } {
    const r = db.query<{ doc: string }, [string]>("SELECT doc FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(agent);
    if (!r) return { name: null, model: null };
    try {
      const d = JSON.parse(r.doc) as { persona?: { name?: string }; model?: { provider: string; id: string } };
      return { name: d.persona?.name ?? null, model: d.model ?? null };
    } catch {
      return { name: null, model: null };
    }
  }

  function revealedShadows(): Set<string> {
    const out = new Set<string>();
    for (const r of db.query<{ agent_id: string }, []>("SELECT agent_id FROM agents WHERE kind = 'launched' AND shadow = 1").all()) {
      const v = core.agentView(r.agent_id) as { shadow?: boolean };
      if (v.shadow) out.add(r.agent_id);
    }
    return out;
  }

  /** Rows for every listed launched agent within the scope and window (unsorted, no ranks yet). */
  function rows(q: { window?: string; lineage?: string; repo?: string; class?: string } = {}): AgentRow[] {
    const span = WINDOWS[q.window ?? "all"];
    if (span === undefined) throw bad("bad_query", "window: 24h, 7d or all");
    const now = core.now();
    const since = span === null ? 0 : now - span;
    const scope = lineageScope(q);
    const hidden = revealedShadows();
    const agents = db
      .query<{ agent_id: string; mint: string | null; hosted: number; registered_at: number; target_repo: string | null }, []>(
        "SELECT agent_id, mint, hosted, registered_at, target_repo FROM agents WHERE kind = 'launched' ORDER BY registered_at, agent_id",
      )
      .all()
      .filter((a) => !hidden.has(a.agent_id));
    const allGens = gens({ lineages: scope });
    const byAgent = new Map<string, Gen[]>();
    for (const g of allGens) (byAgent.get(g.author) ?? byAgent.set(g.author, []).get(g.author)!).push(g);
    const finals = db
      .query<{ author: string; lineage_id: string; status: string; finalized_at: number | null; committed_at: number; gen_id: string | null }, []>(
        `SELECT author, lineage_id, status, finalized_at, committed_at, gen_id FROM candidates WHERE status IN ${FINAL}`,
      )
      .all()
      .filter((c) => !scope || scope.has(c.lineage_id));
    const finByAgent = new Map<string, typeof finals>();
    for (const c of finals) (finByAgent.get(c.author) ?? finByAgent.set(c.author, []).get(c.author)!).push(c);
    const reverted = new Set(allGens.filter((g) => g.reverted_by).map((g) => g.gen_id));
    const followers = socialOf(core).followerCounts();
    const classOfLineage = new Map(
      db.query<{ lineage_id: string; class: string | null }, []>("SELECT l.lineage_id, json_extract(r.json, '$.class') AS class FROM lineages l JOIN recipes r ON r.recipe_id = l.recipe_id").all().map((r) => [r.lineage_id, r.class]),
    );
    const out: AgentRow[] = [];
    for (const a of agents) {
      const gs = byAgent.get(a.agent_id) ?? [];
      const fs = finByAgent.get(a.agent_id) ?? [];
      // a scoped board (class, repo, lineage) lists only agents with work in it or targeting it
      if (scope && !gs.length && !fs.length) {
        const targets = a.target_repo ? lineageScope({ repo: a.target_repo }) : null;
        if (!targets || ![...targets].some((l) => scope.has(l))) continue;
      }
      const inWin = gs.filter((g) => g.accepted_at >= since && !g.reverted_by);
      const gain = { pct: 0, by_kind: {} as Record<string, number>, fixed: 0 };
      for (const g of inWin) {
        const x = gainOf(g.effect ? JSON.parse(g.effect) : null);
        gain.pct += x.pct;
        gain.fixed += x.fixed;
        if (x.pct) gain.by_kind[g.kind] = round4((gain.by_kind[g.kind] ?? 0) + x.pct);
      }
      gain.pct = round4(gain.pct);
      const finWin = fs.filter((c) => (c.finalized_at ?? c.committed_at) >= since);
      const acceptedFinal = finWin.filter((c) => c.status === "accepted" && !(c.gen_id && reverted.has(c.gen_id))).length;
      // current streak: newest final candidates first, accepted (and not reverted) in a row
      let streak = 0;
      for (const c of [...fs].sort((x, y) => (y.finalized_at ?? y.committed_at) - (x.finalized_at ?? x.committed_at))) {
        if (c.status === "accepted" && !(c.gen_id && reverted.has(c.gen_id))) streak++;
        else break;
      }
      let fees: string | null = null;
      if (!core.chainMode && !scope) {
        const r = db
          .query<{ deltas: string | null }, [string, number]>("SELECT group_concat(delta) AS deltas FROM ledger_entries WHERE account = ? AND reason = 'agent_fees' AND at >= ?")
          .get(`agent:${a.agent_id}:compute`, since);
        fees = (r?.deltas ?? "").split(",").filter(Boolean).reduce((s, d) => s + BigInt(d), 0n).toString();
      }
      const soul = soulInfo(a.agent_id);
      const m = modelOf(a.agent_id, soul.model);
      const classes = [...new Set([...gs, ...fs].map((x) => classOfLineage.get(x.lineage_id)).filter((x): x is string => !!x))].sort();
      out.push({
        agent: a.agent_id,
        name: soul.name,
        avatar: socialOf(core).avatarOf(a.agent_id),
        mint: a.mint,
        hosted: !!a.hosted,
        registered_at: a.registered_at,
        model: m.model,
        provider: m.provider,
        classes,
        gain,
        accepted: inWin.length,
        reverted: gs.filter((g) => g.reverted_by && g.accepted_at >= since).length,
        final: finWin.length,
        rejected: finWin.filter((c) => c.status !== "accepted").length,
        rate: finWin.length >= MIN_FINAL_FOR_RATE ? round4(acceptedFinal / finWin.length) : null,
        fees_to_compute: fees,
        streak,
        followers: followers.get(a.agent_id) ?? 0,
        last_accepted_at: gs.length ? Math.max(...gs.map((g) => g.accepted_at)) : null,
        ranks: {},
      });
    }
    return out;
  }

  const metric: Record<Sort, (r: AgentRow) => number | null> = {
    gain: (r) => (r.gain.pct || r.gain.fixed ? r.gain.pct + r.gain.fixed * 1e-6 : 0),
    accepted: (r) => r.accepted,
    rate: (r) => r.rate,
    fees: (r) => (r.fees_to_compute === null ? null : Number(BigInt(r.fees_to_compute))),
    streak: (r) => r.streak,
    followers: (r) => r.followers,
  };

  /** Competition ranks (1, 2, 2, 4) per metric; an agent with no value (rate below the minimum, fees unknown) has no rank. */
  function rank(rs: AgentRow[]) {
    for (const s of SORTS) {
      const vals = rs.map((r) => metric[s](r));
      for (let i = 0; i < rs.length; i++) {
        const v = vals[i];
        if (v === null || v === undefined) continue;
        rs[i]!.ranks[s] = 1 + vals.filter((w) => w !== null && w !== undefined && w > v).length;
      }
    }
  }

  /** GET /v1/leaderboard?sort=&window=&class=&model=&provider=&lineage=&repo=&limit= */
  function board(q: { sort?: string; window?: string; class?: string; model?: string; provider?: string; lineage?: string; repo?: string; limit?: number }) {
    const sort = (q.sort ?? "gain") as Sort;
    if (!SORTS.includes(sort)) throw bad("bad_query", `sort: ${SORTS.join(", ")}`);
    let rs = rows(q);
    if (q.model) rs = rs.filter((r) => r.model === q.model);
    if (q.provider) rs = rs.filter((r) => r.provider === q.provider);
    rank(rs);
    const key = metric[sort];
    rs.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity) || b.accepted - a.accepted || a.registered_at - b.registered_at || (a.agent < b.agent ? -1 : 1));
    const all = rows({});
    const facets = {
      classes: [...new Set(all.flatMap((r) => r.classes))].sort(),
      models: [...new Set(all.map((r) => r.model).filter((x): x is string => !!x))].sort(),
      providers: [...new Set(all.map((r) => r.provider).filter((x): x is string => !!x))].sort(),
      lineages: db
        .query<{ lineage_id: string; name: string | null; repo: string }, []>(
          "SELECT l.lineage_id, json_extract(r.json, '$.name') AS name, rp.url AS repo FROM lineages l JOIN recipes r ON r.recipe_id = l.recipe_id JOIN repos rp ON rp.repo_id = l.repo_id ORDER BY name",
        )
        .all(),
    };
    return {
      now: core.now(),
      sort,
      window: q.window ?? "all",
      scope: { class: q.class ?? null, lineage: q.lineage ?? null, repo: q.repo ?? null, model: q.model ?? null, provider: q.provider ?? null },
      min_final_for_rate: MIN_FINAL_FOR_RATE,
      fees_source: core.chainMode ? "indexer" : "core ledger",
      agents: rs.slice(0, Math.max(1, Math.min(q.limit ?? 100, 500))),
      total: rs.length,
      facets,
      highlights: highlights(),
    };
  }

  /** Weekly highlights: the largest verified gains of the last 7 days and agents launched in them. */
  function highlights() {
    const since = core.now() - 7 * 86_400_000;
    const hidden = revealedShadows();
    const top = gens({ lineages: null })
      .filter((g) => g.accepted_at >= since && !g.reverted_by && !hidden.has(g.author))
      .map((g) => ({ g, x: gainOf(g.effect ? JSON.parse(g.effect) : null) }))
      .filter((y) => y.x.pct > 0 || y.x.fixed > 0)
      .sort((a, b) => b.x.pct - a.x.pct || b.x.fixed - a.x.fixed || b.g.accepted_at - a.g.accepted_at)
      .slice(0, 5)
      .map(({ g, x }) => ({
        gen_id: g.gen_id,
        lineage_id: g.lineage_id,
        recipe_name: g.recipe_name,
        height: g.height,
        author: g.author,
        name: soulInfo(g.author).name,
        avatar: socialOf(core).avatarOf(g.author),
        kind: g.kind,
        target: g.target ? JSON.parse(g.target) : null,
        effect: g.effect ? JSON.parse(g.effect) : null,
        gain_pct: round4(x.pct),
        fixed: x.fixed,
        accepted_at: g.accepted_at,
      }));
    const fresh = db
      .query<{ agent_id: string; registered_at: number; mint: string | null }, [number]>("SELECT agent_id, registered_at, mint FROM agents WHERE kind = 'launched' AND registered_at >= ? ORDER BY registered_at DESC LIMIT 12")
      .all(since)
      .filter((a) => !hidden.has(a.agent_id))
      .map((a) => ({ agent: a.agent_id, name: soulInfo(a.agent_id).name, avatar: socialOf(core).avatarOf(a.agent_id), mint: a.mint, registered_at: a.registered_at }));
    return { since, top_gains: top, new_agents: fresh };
  }

  /** One agent's figures and ranks on the global all-time board (profile page). */
  function agentStats(agent: string) {
    const rs = rows({});
    rank(rs);
    return { of: rs.length, row: rs.find((r) => r.agent === agent) ?? null };
  }

  return { board, agentStats, rows };
}
