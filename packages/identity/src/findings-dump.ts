// The organisation's findings dump (docs/plans/AGENT-LEARNINGS.md 12): one public repository,
// units-agents/findings, holding every listed agent's final episodes, organised by unit and target,
// with the lessons Core distils from them and an index. Agents with their own account keep their
// <login>/units-learnings and app agents keep units-agents/units-learnings (AGENT-LEARNINGS.md 7);
// this repository is the one place that has all of them side by side.
//
// Commits are signed by the publisher account's SSH key (Verified), batched (at most 200 new episodes
// per commit) and rate limited (at most one commit per 10 minutes), nothing when nothing is new.
// Hidden test launches are never written (Core's listings leave them out), and an agent hidden after
// its episodes were written has its files removed by the next commit.
//
// Sealing: the input is Core's published episodes and the units view over them (GET
// /v1/learnings/episodes, /v1/learnings/units), which exist only once every candidate involved is
// final (SPEC 10.7, 17.3, 17.8); each episode is checked again here (isFinalEpisode) before writing.

import { isFinalEpisode, targetKey, targetSlug, unitSlug, type TargetFindings, type UnitFindings } from "../../core/src/shared-findings.ts";
import type { Fetch } from "../../souls/src/github/api.ts";
import type { AgentCredential } from "../../souls/src/github/credentials.ts";
import { profileRepoCommit, type ProfileCommitResult } from "../../souls/src/github/profile-repo.ts";
import { DEFAULT_ORG } from "./org.ts";
import { publisherIdentity, publisherRecord } from "./publisher.ts";
import { errText, type Log } from "./redact.ts";
import type { IdentityService } from "./service.ts";

export const DUMP_REPO = "findings";
export const DUMP_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const DUMP_BATCH = 200;

export interface DumpSources {
  /** GET Core /v1/learnings/episodes?since=&limit= (listed agents, published only) */
  episodes(since: number, limit: number): Promise<{ episodes: any[]; next_since: number; more: boolean }>;
  /** GET Core /v1/learnings/units?until= */
  units(until: number): Promise<{ units: UnitFindings[]; last_seq: number }>;
  /** GET Core /v1/learnings/agents (listed agents with published episodes) */
  agents(): Promise<{ agent: string; episodes: number; last_seq: number }[]>;
  /** GET Core /v1/learnings/repos (each agent's own learnings repository) */
  repos(): Promise<{ agent: string; status: string; repo: string | null; url: string | null }[]>;
  /** POST Core /v1/learnings/dump (runtime key); null without a key */
  record: ((rec: DumpReport) => Promise<void>) | null;
}

export interface DumpReport {
  status: "published" | "failed" | "skipped";
  repo: string | null;
  url: string | null;
  commit: string | null;
  verified: boolean | null;
  episodes: number | null;
  units: number | null;
  agents: number | null;
  last_seq: number | null;
  reason: string | null;
}

export interface DumpRecord {
  v: 1;
  status: DumpReport["status"];
  reason: string | null;
  repo: string | null;
  last_seq: number;
  episodes: number;
  units: number;
  /** agents whose episodes are in the repository */
  agents: string[];
  commit: { sha: string; verified: boolean | null; reason: string; html_url: string } | null;
  committed_at: number;
  updated_at: string;
}

export interface IndexEntry {
  episode_id: string;
  seq: number;
  agent: string;
  unit: string;
  target: string;
  outcome: string;
  provider: string | null;
  path: string;
}

export interface DumpIndex {
  schema: "units-findings-index/1";
  last_seq: number;
  episodes: IndexEntry[];
}

export function httpDumpSources(o: { core: string; fetch?: (u: string, i?: RequestInit) => Promise<Response>; post?: ((path: string, body: unknown) => Promise<{ status: number; body: any }>) | null }): DumpSources {
  const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const core = o.core.replace(/\/+$/, "");
  const get = async (p: string) => {
    const r = await f(`${core}${p}`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`${p.split("?")[0]} answered ${r.status}`);
    return r.json() as Promise<any>;
  };
  return {
    episodes: (since, limit) => get(`/v1/learnings/episodes?since=${since}&limit=${limit}`),
    units: (until) => get(`/v1/learnings/units?until=${until}`),
    agents: async () => (await get("/v1/learnings/agents")).agents,
    repos: async () => (await get("/v1/learnings/repos")).repos,
    record: o.post
      ? async (rec) => {
          const r = await o.post!("/v1/learnings/dump", rec);
          if (r.status !== 200) throw new Error(`Core answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
        }
      : null,
  };
}

// ------------------------------------------------------------------------------------------------
// paths and rendering (no em dashes; every figure copied from Core)

export const episodePath = (e: any) => `findings/${unitSlug(e.task?.recipe?.name, e.task.lineage_id)}/${targetSlug(targetKey(e.task.target))}/${e.episode_id}.json`;

const pct = (x: number) => `${x.toFixed(2)}%`;
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown time");
const who = (a: { id: string; name: string | null }) => `${a.name ?? "agent"} (\`${a.id.slice(0, 8)}\`)`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const counts = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ") || "none";
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderTarget(u: UnitFindings, t: TargetFindings): string {
  const out = [`# ${u.recipe.name ?? u.slug}: ${t.key === "none" ? "no target chosen" : t.key}`, ""];
  out.push(`Unit \`${u.lineage_id}\` on [${u.recipe.repo}](${u.recipe.repo}) at \`${u.recipe.commit}\`${u.tip ? `; current tip generation ${u.tip.height}` : ""}. [Unit summary](../README.md).`, "");
  out.push("Figures are copied from Core's published episodes: outcomes and effects were measured by independent replays; an idea is the agent's own description (claimed, not checked). Nothing here is estimated.", "");
  out.push("## Lessons", "", ...t.lessons.map((l) => `- ${l}`), "");
  if (t.worked.length) {
    out.push("## What worked", "");
    for (const w of t.worked) {
      const ef = w.effect && "ratio" in w.effect ? `${pct(w.effect.gain_pct)} on ${w.effect.metric} (ratio ${w.effect.ratio.toFixed(4)})` : w.effect && "fixed" in w.effect ? `fixed ${w.effect.fixed} tests` : "accepted";
      out.push(`- ${who(w.agent)}, generation ${w.height ?? "?"} on ${w.parent_height ?? "?"}${w.reverted ? " (reverted later)" : ""}: ${ef}. ${w.files.length ? `Files: ${w.files.map((f) => `\`${f}\``).join(", ")}. ` : ""}${w.idea ? `Idea: "${md(w.idea)}" ` : ""}[episode](./${w.episode_id}.json), ${day(w.finalized_at)}.`);
    }
    out.push("");
  }
  if (t.failed.length) {
    out.push("## What failed and why", "");
    for (const f of t.failed) {
      const m = f.measured ? ` Measured ${pct(f.measured.gain_pct)} on ${f.measured.metric} (ratio ${f.measured.ratio.toFixed(4)}).` : "";
      out.push(`- ${who(f.agent)} on generation ${f.parent_height ?? "?"}: ${f.reason}${f.verdict_reason ? ` (verdict: ${f.verdict_reason})` : ""}${f.detail ? `, "${md(f.detail)}"` : ""}.${m} ${f.files.length ? `Files: ${f.files.map((x) => `\`${x}\``).join(", ")}. ` : ""}${f.idea ? `Idea: "${md(f.idea)}" ` : ""}[episode](./${f.episode_id}.json), ${day(f.finalized_at)}.`);
    }
    out.push("");
  }
  if (t.no_candidate.count) {
    out.push("## Ended without a candidate", "", `${plural(t.no_candidate.count, "attempt")}: ${Object.entries(t.no_candidate.agents).map(([a, n]) => `${who({ id: a, name: u.agents.find((x) => x.id === a)?.name ?? null })} ${n}`).join(", ")}. Their episodes are in this folder (the actions, notes and give-up reason of each).`, "");
  }
  if (t.worked.length + t.failed.length < (t.outcomes.accepted ?? 0) + (t.outcomes.rejected ?? 0) + (t.outcomes.expired ?? 0)) out.push(`The lists show the newest ${t.worked.length + t.failed.length}; every episode is in this folder.`, "");
  out.push("## Licence", "", u.attribution ?? "", "");
  return out.join("\n");
}

export function renderUnit(u: UnitFindings): string {
  const out = [`# ${u.recipe.name ?? u.slug}`, ""];
  out.push(`Unit \`${u.lineage_id}\`: [${u.recipe.repo}](${u.recipe.repo}) at \`${u.recipe.commit}\`${u.recipe.class ? `, class ${u.recipe.class}` : ""}${u.tip ? `; current tip generation ${u.tip.height}` : ""}.`, "");
  out.push(`${plural(u.attempts, "published attempt")} by ${plural(u.agents.length, "agent")}: ${counts(u.outcomes)}.`, "");
  out.push("## Targets", "", "| Target | Attempts | Accepted | Failed | No candidate | Best accepted effect |", "|---|---|---|---|---|---|");
  for (const t of u.targets) {
    const failed = (t.outcomes.rejected ?? 0) + (t.outcomes.expired ?? 0);
    out.push(`| [${t.key === "none" ? "(none chosen)" : md(t.key)}](./${t.slug}/LESSONS.md) | ${t.attempts} | ${t.outcomes.accepted ?? 0} | ${failed} | ${t.no_candidate.count} | ${t.best ? `${pct(t.best.gain_pct)} on ${t.best.metric} by ${who(t.best.agent)}` : ""} |`);
  }
  out.push("", "## Lessons by target", "");
  for (const t of u.targets.filter((x) => x.key !== "none")) out.push(`### ${t.key}`, "", ...t.lessons.map((l) => `- ${l}`), "");
  out.push("## Agents", "", ...u.agents.map((a) => `- ${who(a)}: ${plural(a.attempts, "attempt")}, ${a.accepted} accepted`), "");
  out.push("## Licence", "", u.attribution ?? "", "");
  return out.join("\n");
}

export function renderLicenses(units: UnitFindings[]): string {
  const out = ["# Licences of the target repositories", "", "Episodes quote code from these repositories (reads, diffs, patches). Each excerpt stays under its repository's licence; the attribution is repeated in every episode (`attribution`, `license`).", ""];
  const seen = new Set<string>();
  for (const u of units) {
    const repo = u.recipe.repo;
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    const lic = u.license;
    out.push(`- [${repo}](${repo}): ${lic?.spdx && lic.spdx !== "NOASSERTION" ? `${lic.spdx}${lic.url ? ` ([licence file](${lic.url}))` : ""}, read from ${lic.source} on ${lic.read_on}` : "licence not determined; see the repository"}`);
  }
  out.push("");
  return out.join("\n");
}

export function renderCard(o: { core: string | null; site: string | null; index: DumpIndex; units: UnitFindings[]; repos: { agent: string; status: string; url: string | null }[]; owner: string; test?: boolean }): string {
  // a test network's agents are tagged as test agents, and its temporary site address is not linked
  // from the public repository (owner 2026-10-12): routes are named without a host there
  const test = o.test === true;
  const core = test ? null : (o.core?.replace(/\/+$/, "") ?? null);
  const eps = o.index.episodes;
  const by = (k: "outcome" | "provider") => eps.reduce<Record<string, number>>((m, e) => ((m[e[k] ?? "none"] = (m[e[k] ?? "none"] ?? 0) + 1), m), {});
  const agents = new Map<string, { name: string | null; n: number; acc: number }>();
  for (const u of o.units) for (const a of u.agents) {
    const x = agents.get(a.id) ?? { name: a.name, n: 0, acc: 0 };
    x.n += a.attempts;
    x.acc += a.accepted;
    x.name ??= a.name;
    agents.set(a.id, x);
  }
  const repoOf = new Map(o.repos.filter((r) => r.status === "published" && r.url).map((r) => [r.agent, r.url!]));
  const prov = by("provider");
  return [
    "# units findings",
    "",
    ...(test ? ["**Every agent listed here so far is a test agent.** These are findings from the units test network.", ""] : []),
    "Everything units agents found while improving real code, in one place: one record for every finished authoring attempt of every listed agent (accepted, rejected, expired, ended without a candidate, or abandoned; a model agent's empty attempt, with no candidate, no recorded step and no model usage, is left out since 2026-10-12), organised by unit (a repository and the lineage of accepted changes on it) and target (the metric or test an attempt aimed at), with lessons distilled from the measured facts. Agents read the same data from Core before each attempt (the shared findings block), so what one agent learned is in every other agent's context.",
    "",
    "## Contents",
    "",
    `- ${plural(eps.length, "episode")} from ${plural(agents.size, "agent")} on ${plural(o.units.length, "unit")}, up to Core cursor ${o.index.last_seq}. By outcome: ${counts(by("outcome"))}. By model provider: ${Object.entries(prov).map(([p, n]) => `${p === "none" ? "no model (scripted author or no recorded provider)" : p} ${n}`).join(", ") || "none"}.`,
    "- `findings/<unit>/README.md`: the unit's summary: targets with attempts, outcomes and the best accepted effect, lessons by target, agents.",
    "- `findings/<unit>/<target>/LESSONS.md`: what worked (agent, generation, effect, files, idea), what failed and why (the verdict's reason, what the replays measured), and the attempts that ended without a candidate.",
    "- `findings/<unit>/<target>/<episode_id>.json`: each episode as Core serves it (schema `lineage-episode/1`).",
    "- `index.json`: every episode with its unit, target, outcome, agent, provider, cursor and path.",
    "- `LICENSES.md`: the licence of each target repository.",
    "",
    "## Units",
    "",
    "| Unit | Repository | Attempts | Accepted | Failed | Best accepted effect |",
    "|---|---|---|---|---|---|",
    ...o.units.map((u) => {
      const best = u.targets.map((t) => t.best).filter(Boolean).sort((a, b) => b!.gain_pct - a!.gain_pct)[0];
      return `| [${md(u.recipe.name ?? u.slug)}](./findings/${u.slug}/README.md) | ${u.recipe.repo} | ${u.attempts} | ${u.outcomes.accepted ?? 0} | ${(u.outcomes.rejected ?? 0) + (u.outcomes.expired ?? 0)} | ${best ? `${pct(best.gain_pct)} on ${best.metric}` : ""} |`;
    }),
    "",
    "## Agents",
    "",
    ...[...agents].sort((a, b) => b[1].n - a[1].n).map(([id, a]) => `- ${a.name ?? "agent"} \`${id}\`${test ? " (test agent)" : ""}: ${plural(a.n, "episode")}, ${a.acc} accepted${repoOf.get(id) ? `; its own learnings repository: ${repoOf.get(id)}` : ""}${o.site && !test ? `; profile ${o.site.replace(/\/+$/, "")}/agents/${id}/profile` : ""}`),
    "",
    "## Schema",
    "",
    `Episodes: ${core ? `${core}/v1/learnings/schema` : "`GET /v1/learnings/schema`"}. The units and lessons view: ${core ? `${core}/v1/learnings/units` : "`GET /v1/learnings/units`"} (schema \`units-findings/1\`); the lessons here are that view at the cursor above (\`?until=${o.index.last_seq}\`). The same stream across all agents pages from ${core ? `${core}/v1/learnings/episodes?format=jsonl&since=0` : "`GET /v1/learnings/episodes?format=jsonl&since=0`"}.`,
    "",
    "## How the lessons are made",
    "",
    "Deterministically, by Core, with no model call: per unit and target, attempts by outcome; accepted effects (gain = (1 - ratio) x 100 on the worst counted replay); for each failed candidate the reason Core recorded (for example `no_improvement`, `stale_conflict`, `duplicate`), the verdict's detail and what the replays measured; files changed; median recorded model spend. The only free text is each agent's own submit rationale (or give-up reason), quoted as its idea and labelled as claimed.",
    "",
    "## Sealing",
    "",
    "An episode appears here only after Core published it: its candidate is final (accepted, rejected or expired) or the attempt ended without one, and every candidate its agent had open by then is final too. Nothing about an open candidate is ever in this repository. Hidden test launches are left out; an agent hidden later has its files removed.",
    "",
    "## How to verify",
    "",
    `1. Every episode file must equal \`GET /v1/learnings/episodes/<episode_id>\`${core ? ` on ${core}` : ""}.`,
    "2. `verify` in each episode lists the Core paths that serve its parts independently: the session, the candidate (patch and verdict), the generation, the signed provenance record and the signed journal entry.",
    "3. `bun scripts/learnings/verify.ts <episode file or URL> --core <core>` (units repository) checks equality with Core, the patch hash, the provenance signature and the journal signature.",
    "4. The verdict can be recomputed from the revealed replays, and the replay draws checked against the chain, with `bun scripts/verify.ts --core <core> --candidate <commit_id> --chain`.",
    `5. The lessons can be recomputed from \`GET /v1/learnings/units?until=${o.index.last_seq}\`.`,
    "",
    `Commits here are signed by the units publisher account's SSH key (GitHub shows Verified), at most one every 10 minutes with at most 200 new episodes each.`,
    "",
    "## Licence and attribution",
    "",
    "The records are offered under CC BY 4.0. Code excerpts inside them stay under their own repository's licence: see `LICENSES.md` and each episode's `attribution` and `license`.",
    "",
    "Each episode names the model provider, models and route that produced it (`model`). Providers' terms may restrict using model outputs to train models; filter by `model.provider` before any training (the clauses as read on 2026-10-10 are in docs/plans/AGENT-LEARNINGS.md 9 of the units repository).",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------
// runner

export interface DumpOptions {
  svc: IdentityService;
  sources: DumpSources;
  site: string | null;
  coreUrl?: string | null;
  /** the agents are a test network's: tagged as test agents, and the site is not linked (owner 2026-10-12) */
  test?: boolean;
  /** the repository's homepage on GitHub when the site is not to be linked (the public app) */
  homepage?: string | null;
  /** organisation that holds the repository; default the publisher's owner, else units-agents */
  org?: string | null;
  apiBase?: string;
  gitBase?: string;
  fetch?: Fetch;
  log?: Log;
  now?: () => Date;
  verifyPolls?: number;
}

export interface DumpSummary {
  result: "published" | "unchanged" | "rate_limited" | "skipped" | "failed";
  repo: string | null;
  added: number;
  removed: number;
  episodes: number;
  units: number;
  last_seq: number;
  more: boolean;
  commit: string | null;
  verified: boolean | null;
  reason: string | null;
}

export class FindingsDumpPublisher {
  private readonly log: Log;
  private readonly now: () => Date;
  constructor(readonly o: DumpOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
  }

  private get store() {
    return this.o.svc.o.store;
  }

  record(): DumpRecord | null {
    return this.store.get<DumpRecord>("findings-dump", "main");
  }

  private save(r: DumpRecord) {
    r.updated_at = this.now().toISOString();
    this.store.put("findings-dump", "main", r);
  }

  private cred(): { cred: AgentCredential; owner: string } | null {
    const pub = publisherRecord(this.o.svc);
    if (!pub) return null;
    const id = publisherIdentity(this.o.svc);
    return {
      cred: { v: 1, agent: "publisher", login: pub.login, github_id: pub.github_id, token: pub.token, ssh_private_key_path: id.signingKey!, ssh_public_key: pub.ssh_public_key, ssh_signing_key_id: pub.ssh_signing_key_id, assigned_at: pub.set_at },
      owner: this.o.org ?? pub.owner ?? DEFAULT_ORG,
    };
  }

  private async report(rec: DumpRecord) {
    if (!this.o.sources.record) return;
    await this.o.sources
      .record({ status: rec.status, repo: rec.repo, url: rec.repo && rec.status === "published" ? `https://github.com/${rec.repo}` : null, commit: rec.commit?.sha ?? null, verified: rec.commit?.verified ?? null, episodes: rec.episodes, units: rec.units, agents: rec.agents.length, last_seq: rec.last_seq, reason: rec.reason ? rec.reason.slice(0, 300) : null })
      .catch((e) => this.log(`findings dump: Core did not record it: ${errText(e)}`));
  }

  /** One batch: the next (at most 200) published episodes, the lessons at that cursor, one commit. */
  async run(o: { force?: boolean; dryRun?: boolean } = {}): Promise<DumpSummary> {
    const prev = this.record();
    const rec: DumpRecord = prev ?? { v: 1, status: "skipped", reason: null, repo: null, last_seq: 0, episodes: 0, units: 0, agents: [], commit: null, committed_at: 0, updated_at: "" };
    const sum = (result: DumpSummary["result"], x: Partial<DumpSummary> = {}): DumpSummary => ({ result, repo: rec.repo, added: 0, removed: 0, episodes: rec.episodes, units: rec.units, last_seq: rec.last_seq, more: false, commit: rec.commit?.sha ?? null, verified: rec.commit?.verified ?? null, reason: rec.reason, ...x });
    const t = this.cred();
    if (!t) {
      rec.status = "skipped";
      rec.reason = "no publisher account is configured";
      if (!o.dryRun) this.save(rec);
      return sum("skipped");
    }
    try {
      const listed = new Set((await this.o.sources.agents()).map((a) => a.agent));
      const gone = rec.agents.filter((a) => !listed.has(a));
      const page = await this.o.sources.episodes(rec.last_seq, DUMP_BATCH);
      const eps = page.episodes.filter((e) => isFinalEpisode(e) && listed.has(e?.agent?.id) && /^[0-9a-f]{64}$/.test(e?.episode_id ?? "") && /^[0-9a-f]{64}$/.test(e?.task?.lineage_id ?? "") && Number.isSafeInteger(e.seq));
      const cursor = Math.max(rec.last_seq, page.next_since ?? 0, ...eps.map((e) => e.seq as number));
      if (!eps.length && !gone.length) {
        if (cursor !== rec.last_seq && !o.dryRun) (rec.last_seq = cursor), this.save(rec);
        return sum("unchanged", { last_seq: cursor });
      }
      const at = this.now().getTime();
      if (!o.force && rec.committed_at && at - rec.committed_at < DUMP_MIN_INTERVAL_MS) return sum("rate_limited", { more: true });
      const { units } = await this.o.sources.units(cursor);
      const repos = await this.o.sources.repos().catch(() => []);
      const repo = `${t.owner}/${DUMP_REPO}`;
      let index: DumpIndex = { schema: "units-findings-index/1", last_seq: cursor, episodes: [] };
      let removed: string[] = [];
      const plan = (s: { read(p: string): string | null }) => {
        let old: DumpIndex | null = null;
        try {
          old = JSON.parse(s.read("index.json") ?? "null");
        } catch {
          old = null;
        }
        const have = new Map((old?.episodes ?? []).map((x) => [x.episode_id, x]));
        // an agent hidden since its episodes were written: its files leave the repository
        removed = [...have.values()].filter((x) => !listed.has(x.agent)).map((x) => x.path);
        for (const x of [...have.values()]) if (!listed.has(x.agent)) have.delete(x.episode_id);
        const files: Record<string, string> = {};
        for (const e of eps) {
          const path = episodePath(e);
          files[path] = JSON.stringify(e, null, 2) + "\n";
          have.set(e.episode_id, { episode_id: e.episode_id, seq: e.seq, agent: e.agent.id, unit: unitSlug(e.task.recipe?.name, e.task.lineage_id), target: targetKey(e.task.target), outcome: e.outcome, provider: e.model?.provider ?? null, path });
        }
        index = { schema: "units-findings-index/1", last_seq: cursor, episodes: [...have.values()].sort((a, b) => a.seq - b.seq) };
        for (const u of units) {
          files[`findings/${u.slug}/README.md`] = renderUnit(u);
          for (const tf of u.targets) files[`findings/${u.slug}/${tf.slug}/LESSONS.md`] = renderTarget(u, tf);
        }
        files["index.json"] = JSON.stringify(index, null, 1) + "\n";
        files["LICENSES.md"] = renderLicenses(units);
        files["README.md"] = renderCard({ core: this.o.coreUrl ?? this.o.site, site: this.o.site, index, units, repos, owner: t.owner, test: this.o.test });
        return files;
      };
      if (o.dryRun) {
        plan({ read: () => null });
        this.log(`findings dump: would commit ${eps.length} episodes to ${repo} (dry run)`);
        return sum("published", { added: eps.length, more: page.more, last_seq: cursor, units: units.length, episodes: index.episodes.length });
      }
      const site = this.o.site?.replace(/\/+$/, "") ?? null;
      const res: ProfileCommitResult = await profileRepoCommit({
        cred: t.cred, repoName: DUMP_REPO, owner: t.owner, replaceTree: false, plan, remove: () => removed,
        // read after plan(): the index is built there
        message: () => `units findings: ${eps.length} episode${eps.length === 1 ? "" : "s"} up to cursor ${cursor}${removed.length ? `, ${removed.length} removed (agent hidden)` : ""}\n\n${units.length} units, ${index.episodes.length} episodes in all.\n`,
        description: "Every units agent's findings in one place: final attempts by unit and target, with lessons from measured facts",
        homepage: (this.o.test ? this.o.homepage : site) ?? this.o.homepage ?? undefined,
        apiBase: this.o.apiBase, gitBase: this.o.gitBase, fetch: this.o.fetch, log: (m) => this.log(m), verifyPolls: this.o.verifyPolls,
      });
      const next: DumpRecord = {
        v: 1, status: "published", reason: null, repo: res.repo, last_seq: cursor, episodes: index.episodes.length, units: units.length,
        agents: [...new Set(index.episodes.map((x) => x.agent))].sort(), commit: { sha: res.sha, verified: res.verified, reason: res.reason, html_url: res.html_url }, committed_at: at, updated_at: "",
      };
      this.save(next);
      Object.assign(rec, next);
      await this.report(next);
      this.log(`findings dump: ${res.unchanged ? "unchanged on GitHub" : `committed ${eps.length} episodes${removed.length ? ` and removed ${removed.length}` : ""} to ${res.repo}@${res.sha.slice(0, 12)} (${res.verified ? "Verified" : res.reason})`}`);
      return sum("published", { added: eps.length, removed: removed.length, more: page.more });
    } catch (e) {
      rec.status = prev?.status === "published" ? "published" : "failed";
      rec.reason = errText(e);
      if (!o.dryRun) this.save(rec);
      this.log(`findings dump: failed: ${rec.reason}`);
      return sum("failed", { reason: rec.reason });
    }
  }
}
