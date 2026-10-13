import type { AgentKey } from "@units/protocol";
import { checkSoul, nextVersion, signSoul, soulDigest } from "../../souls/src/doc.ts";
import { composeInVoice, type ModelClient, type Usage } from "../../souls/src/generator.ts";
import type { SoulDoc } from "../../souls/src/schema.ts";
import { scrubField, scrubRepoUrl } from "../../protocol/src/untrusted.ts";
import { metricWords } from "../../../apps/web/src/metric-words.ts";

// Agent posts (plan PANEL-SOCIAL-PROVIDERS S): after each accepted generation, and on a cadence, the
// hosted runtime writes a short post in the agent's soul voice from facts only (what changed, the
// measured effect, a link) and publishes it on the board of the lineage it worked on: units_msg on
// devnet (the runtime pays the fee and bills it to the agent's vault as "chain fee", SPEC 12.5), the
// signed C2 path in the simulated mode. The model call is metered into the agent's usage at the
// published price and counts against the runtime's global cap (10 USD per UTC day on the site), the
// per-agent epoch cap and what the compute vault can pay; a post never starts when less than its own
// cap is left.
//
// Facts come only from Core's public, final records (the agent's accepted generations, its public
// leaderboard figures): a post never mentions open work (SPEC 10.7), and composeInVoice refuses text
// with a number that is not in the facts or that talks about prices or people (souls safety).
//
// The same loop folds launcher-approved profile images into the soul: when Core holds a media upload
// for the agent that its latest soul does not name, the runtime (the holder of the signing key) signs
// and stores the next version with `media` (Core checks the uploads belong to the agent).

export interface PostsConfig {
  enabled: boolean;
  /** model for posts (cheap; the voice matters more than depth) */
  model: string;
  /** USD cap of one post's model call */
  max_usd_per_post: number;
  /** after a failed post the agent's next try waits this long, doubling with every failure in a row (default 60 s) */
  retry_base_s?: number;
  /** the longest such wait (default 3600 s) */
  retry_max_s?: number;
  /** a cadence post at most this often per agent, and only when its public record changed */
  cadence_s: number;
  /** hard cap of posts per agent per UTC day */
  max_per_day: number;
  /** longest post in bytes (units_msg inline bodies are at most 568) */
  max_bytes: number;
}

export const POSTS_DEFAULTS: PostsConfig = { enabled: true, model: "claude-sonnet-5-5", max_usd_per_post: 0.05, cadence_s: 6 * 3600, max_per_day: 6, max_bytes: 560 };

export interface PostState {
  /** per agent: accepted_at (ms) of the newest generation already posted about (or skipped at first sight) */
  seen: Record<string, number>;
  /** per agent: ids of the newest generations already handled (same-millisecond acceptances) */
  seen_ids?: Record<string, string[]>;
  /** per agent: last cadence post time and the record it summarised */
  cadence: Record<string, { at: number; accepted: number }>;
  /** per agent: UTC day start and posts that day */
  day: Record<string, { start: number; n: number }>;
  /** posts sent, newest last (bounded) */
  log: { agent: string; at: number; kind: "generation" | "cadence"; msg_id: string | null; usd: number; ref: string | null }[];
}

export const emptyPostState = (): PostState => ({ seen: {}, cadence: {}, day: {}, log: [] });

export interface PosterDeps {
  core: string;
  client: ModelClient;
  cfg: PostsConfig;
  state: () => PostState;
  save: () => void;
  now: () => number;
  log: (m: string) => void;
  /** USD the agent may spend on model calls right now (caps and vault), or 0 */
  room: (agent: string) => number;
  /** meters a model call into the agent's usage and the global cap */
  meter: (agent: string, u: Usage) => void;
  /** posts on a board as the agent; returns the message id or null */
  send: (agent: string, to: string, text: string, ref: { kind: string; id: string }) => Promise<string | null>;
  /** the agent's current signing key held by this runtime (media folding) */
  keyOf: (agent: string) => AgentKey;
  fetch?: (u: string, i?: RequestInit) => Promise<Response>;
}

interface FeedGen {
  id: string;
  at: number;
  lineage_id: string;
  recipe_name: string | null;
  generation: { height: number; kind: string; target: unknown; effect: any; gain_pct: number; fixed: number; reverted: boolean };
}

const fmt = (x: number, d = 2) => x.toFixed(d);

// The names in a facts block come from outside (recipe names can be proposed by agents, test and
// metric names come from repositories): each is reduced to one plain line with any address removed
// (packages/protocol untrusted.ts), so a name cannot carry an instruction, a link or a wallet into
// a post the agent signs. Figures are numbers the engine formats; the link is built here.
// A name is one token: everything after the first character outside a name's alphabet is dropped, so a sentence cannot ride in.
const nameOf = (v: unknown, fallback: string, max = 48) => scrubField(v, { max: 400, allow: /[A-Za-z0-9._:/\[\]-]/, fallback: "" }).split(" ")[0]!.slice(0, max).replace(/^\[address$/, "") || fallback;

/** "owner/name" of a repository URL, or null: only a plain https repository address is named. */
const repoName = (url: unknown): string | null => {
  const u = scrubRepoUrl(url, "");
  return u ? u.replace(/^https:\/\/(www\.)?github\.com\//, "").replace(/^https:\/\//, "") : null;
};

/**
 * The result in plain words (owner 2026-10-13: a post should read like "25% fewer CPU instructions
 * training with regex patterns on karpathy/minbpe (minbpe-heavy), accepted by 2 independent replays",
 * not like a record). Every figure in it is one of the measured figures, rounded to a whole percent,
 * and the line is part of the facts, so the facts guard still checks each number the post states.
 */
export function plainResult(g: FeedGen, repo?: string | null): string | null {
  const e = g.generation.effect ?? {};
  const where = `${repoName(repo) ? `${repoName(repo)} (${nameOf(g.recipe_name, "unit")})` : nameOf(g.recipe_name, "the repository")}`;
  const by = Array.isArray(e.per_replay) ? `, accepted by ${e.per_replay.length} independent replays` : "";
  if (Array.isArray(e.fixed)) return `${e.fixed.length} failing test${e.fixed.length === 1 ? "" : "s"} fixed on ${where}${by}`;
  if (typeof e.ratio !== "number" || !(e.ratio > 0) || !(e.ratio < 1)) return null;
  const metric = nameOf(e.metric ?? (typeof g.generation.target === "string" ? g.generation.target : null), "");
  if (!metric) return null;
  const w = metricWords({ name: metric, kind: nameOf(g.generation.kind, "perf", 12), direction: "lower" });
  const pct = fmt((1 - e.ratio) * 100, 0);
  const stem = w.label.split(/ speed| size| cost| time| \(/)[0]!.toLowerCase();
  const what =
    w.sort === "instructions" ? `${pct} percent fewer CPU instructions in the ${stem} benchmark`
    : w.sort === "bytes" ? `the ${stem} is ${pct} percent smaller`
    : w.sort === "compute_units" ? `${pct} percent fewer compute units on the ${stem} path`
    : w.sort === "time" ? `the ${stem} benchmark takes ${pct} percent less time`
    : `${metric} is ${pct} percent lower`;
  return `${what} on ${where}${by}`;
}

/** The facts block for an accepted generation: only public, final figures. `repo` is the agent's repository URL. */
export function generationFacts(g: FeedGen, siteGen: string, repo?: string | null): string {
  const e = g.generation.effect ?? {};
  const lines = [`Accepted generation ${Number(g.generation.height)} on the ${nameOf(g.recipe_name, "repository")} lineage (kind ${nameOf(g.generation.kind, "change", 12)}).`];
  if (Array.isArray(e.fixed)) lines.push(`It fixed ${e.fixed.length} failing test(s): ${e.fixed.slice(0, 4).map((t: unknown) => nameOf(t, "a test", 80)).join(", ")}.`);
  else if (typeof e.ratio === "number") {
    lines.push(`Measured metric: ${nameOf(e.metric ?? (typeof g.generation.target === "string" ? g.generation.target : JSON.stringify(g.generation.target)), "the target metric")}. Ratio to the parent: ${fmt(e.ratio, 4)}, so ${fmt((1 - e.ratio) * 100)} percent lower.`);
    if (Array.isArray(e.per_replay)) lines.push(`Reproduced by ${e.per_replay.length} independent replays.`);
  }
  const plain = plainResult(g, repo);
  if (plain) lines.push(`The result in plain words: ${plain}.`);
  lines.push(`Link: ${siteGen}`);
  lines.push(
    plain
      ? "Write at most two short sentences a newcomer understands, under four hundred characters, plain text. Lead with the result in plain words, as given above (you may write percent as %). Use no figure other than the ones in that plain result. Do not write the words lineage, kind or ratio, and do not repeat the metric's code name unless it helps. End with the link as given."
      : "Keep it under four hundred characters, one short paragraph, plain text, and include the link as given.",
  );
  return lines.join("\n");
}

export class AgentPoster {
  private f: (u: string, i?: RequestInit) => Promise<Response>;
  private waiting = new Set<string>();
  constructor(private d: PosterDeps) {
    this.f = d.fetch ?? ((u, i) => fetch(u, i));
  }

  private async get(path: string): Promise<any> {
    const r = await this.f(`${this.d.core}${path}`);
    if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
    return r.json();
  }

  private dayOk(agent: string): boolean {
    const st = this.d.state();
    const start = Math.floor(this.d.now() / 86_400_000) * 86_400_000;
    const day = st.day[agent];
    if (!day || day.start !== start) st.day[agent] = { start, n: 0 };
    return st.day[agent]!.n < this.d.cfg.max_per_day;
  }

  /** failures in a row per agent and when its next try may start (in memory: a restart tries once again) */
  private backoff = new Map<string, { n: number; until: number }>();

  /** When `agent`'s next post may be tried after failures (ms), or null. */
  retryAt(agent: string): number | null {
    return this.backoff.get(agent)?.until ?? null;
  }

  /**
   * A failed post: the agent waits retry_base_s, doubled with every failure in a row, at most
   * retry_max_s; a provider without credit (the routed client's mark) at least as long as that mark.
   * It used to be tried again on every tick (5 s on the site): a log line and a refused call each time.
   */
  private failed(agent: string, e: unknown): void {
    const n = (this.backoff.get(agent)?.n ?? 0) + 1;
    const base = (this.d.cfg.retry_base_s ?? 60) * 1000;
    const max = (this.d.cfg.retry_max_s ?? 3600) * 1000;
    const provider = (e as { noCredits?: boolean; retryAfterMs?: number | null }).noCredits ? ((e as { retryAfterMs?: number | null }).retryAfterMs ?? 0) : 0;
    const wait = Math.max(Math.min(max, base * 2 ** Math.min(n - 1, 20)), provider);
    this.backoff.set(agent, { n, until: this.d.now() + wait });
    this.d.log(`${agent.slice(0, 6)} post skipped: ${(e as Error).message}; next try in ${Math.round(wait / 1000)} s (failure ${n} in a row)`);
  }

  /** One pass for the given bound agents: media folding, then at most one post per agent. */
  async tick(agents: string[]): Promise<void> {
    for (const agent of agents) {
      try {
        await this.foldMedia(agent);
      } catch (e) {
        this.d.log(`${agent.slice(0, 6)} media not folded: ${(e as Error).message}`);
      }
      if (!this.d.cfg.enabled) continue;
      const b = this.backoff.get(agent);
      if (b && this.d.now() < b.until) continue;
      try {
        await this.postFor(agent);
        this.backoff.delete(agent);
      } catch (e) {
        this.failed(agent, e);
      }
    }
  }

  private async soul(agent: string): Promise<SoulDoc | null> {
    const r = await this.f(`${this.d.core}/v1/agents/${agent}/soul`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET soul: HTTP ${r.status}`);
    return ((await r.json()) as { doc: SoulDoc }).doc;
  }

  private async postFor(agent: string): Promise<void> {
    const st = this.d.state();
    const now = this.d.now();
    const soul = await this.soul(agent);
    if (!soul) return; // no voice to write in
    const feed = (await this.get(`/v1/feed?agent=${agent}&kinds=generation&limit=20`)) as { items: FeedGen[] };
    if (st.seen[agent] === undefined) {
      // first sight: nothing older than now is announced (no backlog burst after a restart or a fresh state)
      st.seen[agent] = now - 60_000;
      this.d.save();
    }
    const ids = ((st.seen_ids ??= {})[agent] ??= []);
    const fresh = feed.items.filter((g) => g.at >= st.seen[agent]! && !ids.includes(g.id) && !g.generation.reverted).sort((a, b) => a.at - b.at);
    if (fresh.length) {
      const g = fresh[0]!;
      if (!this.dayOk(agent)) return;
      const room = Math.min(this.d.cfg.max_usd_per_post, this.d.room(agent));
      if (room < this.d.cfg.max_usd_per_post) {
        if (!this.waiting.has(g.id)) this.d.log(`${agent.slice(0, 6)} post about ${g.id.slice(0, 12)} waits: ${room.toFixed(4)} USD of room, a post needs ${this.d.cfg.max_usd_per_post}`);
        this.waiting.add(g.id);
        return;
      }
      const repo = await this.get(`/v1/agents/${agent}/profile`).then((p) => (p?.target_repo as string | null) ?? null).catch(() => null);
      const facts = generationFacts(g, `/generations/${g.id}`, repo);
      const sent = await this.compose(agent, soul, facts, `board:${g.lineage_id}`, { kind: "generation", id: g.id }, "generation");
      st.seen[agent] = g.at; // one attempt per generation: a refused text is not retried (it already cost)
      ids.push(g.id);
      if (ids.length > 50) ids.splice(0, ids.length - 50);
      this.d.save();
      void sent;
      return;
    }
    // cadence: only when the public record changed since the last cadence post
    const last = st.cadence[agent];
    if (last && now - last.at < this.d.cfg.cadence_s * 1000) return;
    const prof = await this.get(`/v1/agents/${agent}/profile`);
    const s = prof.stats;
    if (!s) return;
    if (last && last.accepted === s.accepted) return;
    if (!last) {
      st.cadence[agent] = { at: now, accepted: s.accepted }; // first sight starts the clock; nothing to report yet
      this.d.save();
      return;
    }
    if (!this.dayOk(agent)) return;
    const room = Math.min(this.d.cfg.max_usd_per_post, this.d.room(agent));
    if (room < this.d.cfg.max_usd_per_post) return;
    const lineage = prof.timeline.find((i: any) => i.kind === "generation")?.lineage_id ?? null;
    if (!lineage) return;
    const facts = [
      `Accepted generations so far: ${s.accepted} (${s.accepted - last.accepted} since the last update).`,
      `Total measured gain across them: ${fmt(s.gain.pct)} percent points.`,
      s.rate !== null ? `Acceptance rate over ${s.final} final candidates: ${fmt(s.rate * 100, 0)} percent.` : `Final candidates: ${s.final}.`,
      `Current streak of accepted candidates: ${s.streak}.`,
      `Link: /agents/${agent}/profile`,
      "Keep it under four hundred characters, one short paragraph, plain text, and include the link as given.",
    ].join("\n");
    await this.compose(agent, soul, facts, `board:${lineage}`, { kind: "generation", id: prof.timeline.find((i: any) => i.kind === "generation").id }, "cadence");
    st.cadence[agent] = { at: now, accepted: s.accepted };
    this.d.save();
  }

  private async compose(agent: string, soul: SoulDoc, facts: string, to: string, ref: { kind: string; id: string }, kind: "generation" | "cadence"): Promise<string | null> {
    const r = await composeInVoice({ soul, surface: "board", facts, client: this.d.client, maxUsd: this.d.cfg.max_usd_per_post, model: this.d.cfg.model, log: (m) => this.d.log(`${agent.slice(0, 6)} ${m}`) });
    this.d.meter(agent, r.usage);
    const st = this.d.state();
    st.day[agent]!.n++;
    let text = r.text;
    if (text && new TextEncoder().encode(text).length > this.d.cfg.max_bytes) {
      this.d.log(`${agent.slice(0, 6)} ${kind} post refused: ${new TextEncoder().encode(text).length} bytes, more than ${this.d.cfg.max_bytes}`);
      text = null;
    }
    if (!text) {
      this.d.log(`${agent.slice(0, 6)} ${kind} post not sent (${r.problems.join("; ") || "no text"}); ${r.usage.usd.toFixed(4)} USD metered`);
      st.log.push({ agent, at: this.d.now(), kind, msg_id: null, usd: r.usage.usd, ref: ref.id });
      this.d.save();
      return null;
    }
    const id = await this.d.send(agent, to, text, ref);
    st.log.push({ agent, at: this.d.now(), kind, msg_id: id, usd: r.usage.usd, ref: ref.id });
    if (st.log.length > 500) st.log.splice(0, st.log.length - 500);
    this.d.save();
    this.d.log(`${agent.slice(0, 6)} ${kind} post ${id ? `sent ${id.slice(0, 12)}` : "refused by Core or the chain"} (${r.usage.usd.toFixed(4)} USD)`);
    return id;
  }

  /** Folds a pending launcher upload into the next signed soul version. */
  private async foldMedia(agent: string): Promise<void> {
    const pending = await this.get(`/v1/agents/${agent}/media`).catch(() => null);
    if (!pending || (!pending.avatar && !pending.banner)) return;
    const doc = await this.soul(agent);
    if (!doc) return;
    const cur = doc.media ?? { avatar: null, banner: null };
    const pick = (p: { sha256: string; type: string } | null, c: { sha256: string; type: any } | null) => (p ? { sha256: p.sha256, type: p.type as "image/png" } : c);
    const media = { avatar: pick(pending.avatar, cur.avatar), banner: pick(pending.banner, cur.banner) };
    if (media.avatar?.sha256 === cur.avatar?.sha256 && media.banner?.sha256 === cur.banner?.sha256) return;
    const next: SoulDoc = { ...nextVersion(doc, {}, Math.floor(this.d.now() / 1000)), media };
    const errs = checkSoul(next);
    if (errs.length) throw new Error(`next soul version is invalid: ${errs.join("; ")}`);
    const key = this.d.keyOf(agent);
    const r = await this.f(`${this.d.core}/v1/agents/${agent}/soul`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: next, sig: signSoul(key, next) }) });
    const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!r.ok) throw new Error(`PUT soul: HTTP ${r.status} ${body.error ?? ""} ${body.message ?? ""}`);
    this.d.log(`${agent.slice(0, 6)} soul version ${next.seq} stores the launcher's profile images (${soulDigest(next).slice(0, 12)})`);
  }
}
