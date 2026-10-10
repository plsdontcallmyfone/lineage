// Agent learnings repositories (docs/plans/AGENT-LEARNINGS.md 7). For every agent with its own GitHub
// account (ready, not a hidden test launch) the identity service keeps the public repository
// <login>/lineage-learnings in step with the agent's published episodes in Core: one JSON file per
// episode, lessons.md per lineage, a dataset card README and LICENSES.md. Commits are signed with the
// agent's SSH signing key (Verified), reusing the genesis publisher (profileRepoCommit). Batched and
// rate limited: at most one commit per agent per 10 minutes and 200 new episodes per commit.
//
// Agents without an account (app identity) are recorded as "awaiting publisher"; with a publisher
// account configured (publisher.ts) their learnings go to <publisher>/lineage-learnings under
// agents/<agent_id>/. The reserve pool accounts are never used.
//
// Sealing: this module reads only Core's published episodes (GET /v1/learnings/*), which exist only
// once nothing in them can name the author of an open candidate (SPEC 10.7, 17.3, 17.8).

import type { Fetch } from "../../souls/src/github/api.ts";
import type { AgentCredential } from "../../souls/src/github/credentials.ts";
import { lineageTrailers } from "../../souls/src/github/commit.ts";
import { profileRepoCommit, type ProfileCommitResult } from "../../souls/src/github/profile-repo.ts";
import { EncryptedCredentialStore } from "./creds.ts";
import { publisherIdentity, publisherRecord } from "./publisher.ts";
import { errText, type Log } from "./redact.ts";
import type { IdentityService } from "./service.ts";

export const LEARNINGS_REPO = "lineage-learnings";
export const LEARNINGS_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const LEARNINGS_BATCH = 200;

export interface LearningsSources {
  /** GET Core /v1/learnings/agents */
  agents(): Promise<{ agent: string; episodes: number; last_seq: number }[]>;
  /** GET Core /v1/learnings/episodes?agent=&since=&limit= */
  episodes(agent: string, since: number, limit: number): Promise<{ episodes: any[]; next_since: number; more: boolean }>;
  /** GET Core /v1/learnings/lessons?agent= */
  lessons(agent: string): Promise<{ lineages: any[] }>;
  /** POST Core /v1/learnings/repos (runtime key); null when there is no key */
  record: ((repos: RepoReport[]) => Promise<void>) | null;
}

export interface RepoReport {
  agent: string;
  status: "published" | "awaiting publisher" | "skipped" | "failed";
  repo: string | null;
  url: string | null;
  commit: string | null;
  verified: boolean | null;
  episodes: number | null;
  last_seq: number | null;
  reason: string | null;
}

export interface LearningsRecord {
  v: 1;
  agent: string;
  status: RepoReport["status"];
  reason: string | null;
  identity: "account" | "publisher" | null;
  login: string | null;
  repo: string | null;
  /** highest Core seq committed */
  last_seq: number;
  episodes: number;
  providers: Record<string, number>;
  lineages: string[];
  commit: { sha: string; verified: boolean | null; reason: string; html_url: string } | null;
  committed_at: number;
  updated_at: string;
}

export function httpLearningsSources(o: { core: string; fetch?: (u: string, i?: RequestInit) => Promise<Response>; post?: ((path: string, body: unknown) => Promise<{ status: number; body: any }>) | null }): LearningsSources {
  const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const core = o.core.replace(/\/+$/, "");
  const get = async (p: string) => {
    const r = await f(`${core}${p}`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`${p.split("?")[0]} answered ${r.status}`);
    return r.json() as Promise<any>;
  };
  return {
    agents: async () => (await get("/v1/learnings/agents")).agents,
    episodes: (a, since, limit) => get(`/v1/learnings/episodes?agent=${a}&since=${since}&limit=${limit}`),
    lessons: (a) => get(`/v1/learnings/lessons?agent=${a}`),
    record: o.post
      ? async (repos) => {
          for (let i = 0; i < repos.length; i += 200) {
            const r = await o.post!("/v1/learnings/repos", { repos: repos.slice(i, i + 200) });
            if (r.status !== 200) throw new Error(`Core answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
          }
        }
      : null,
  };
}

// ------------------------------------------------------------------------------------------------
// rendering (no em dashes; every figure copied from Core)

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pct = (x: number) => `${x.toFixed(2)}%`;
const tgt = (t: any) => (Array.isArray(t) ? t.join(", ") : String(t));

export function renderLessons(l: any): string {
  const out = [`# Lessons: ${l.recipe?.name ?? l.lineage_id}`, ""];
  out.push(`Lineage \`${l.lineage_id}\` on [${l.recipe?.repo}](${l.recipe?.repo}) at \`${l.recipe?.commit}\`. ${l.attempts} published attempt${l.attempts === 1 ? "" : "s"}.`, "");
  out.push("Figures are copied from Core's published episodes (verdicts from independent replays). Nothing here is estimated.", "");
  for (const t of l.targets ?? []) {
    out.push(`## Target ${t.target === "none" ? "(none chosen)" : t.target}`, "");
    out.push(`- Attempts: ${t.attempts} (${Object.entries(t.outcomes).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ")})`);
    if (t.best) out.push(`- Best accepted effect: ${pct(t.best.gain_pct)} (ratio ${t.best.ratio.toFixed(4)}), episode \`${t.best.episode_id.slice(0, 12)}\``);
    if (t.accepted_effects?.length > 1) out.push(`- Accepted effects: ${t.accepted_effects.map((x: any) => pct(x.gain_pct)).join(", ")}`);
    const rs = Object.entries(t.rejection_reasons ?? {});
    if (rs.length) out.push(`- Why candidates failed: ${rs.map(([k, v]) => `${k} (${v})`).join(", ")}`);
    if (t.files_accepted?.length) out.push(`- Files changed by accepted candidates: ${t.files_accepted.map((p: string) => `\`${p}\``).join(", ")}`);
    if (t.files_rejected?.length) out.push(`- Files changed by rejected candidates: ${t.files_rejected.map((p: string) => `\`${p}\``).join(", ")}`);
    if (t.median_usd !== null && t.usd_known) out.push(`- Median model spend per attempt: ${t.median_usd.toFixed(4)} USD (over ${t.usd_known} attempt${t.usd_known === 1 ? "" : "s"} with a recorded cost)`);
    out.push("");
  }
  if (l.journal?.length) {
    out.push("## In the agent's own words", "", "The agent's journal entries on this lineage, newest first, verbatim. They are its own notes: claimed, not checked.", "");
    for (const j of l.journal) out.push(`> ${String(j.text).replace(/\n+/g, "\n> ")}`, ">", `> ${day(j.created_at)}, episode \`${j.episode_id.slice(0, 12)}\` (${j.outcome.replace("_", " ")})`, "");
  }
  out.push("## Licence", "", l.attribution ?? "", "");
  return out.join("\n");
}

export function renderLicenses(lineages: any[]): string {
  const out = ["# Licences of the target repositories", "", "Episodes quote code from these repositories (reads, diffs, patches). Each excerpt stays under its repository's licence; the attribution is repeated in every episode (`attribution`, `license`).", ""];
  const seen = new Set<string>();
  for (const l of lineages) {
    const repo = l.recipe?.repo;
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    const lic = l.license;
    out.push(`- [${repo}](${repo}): ${lic?.spdx && lic.spdx !== "NOASSERTION" ? `${lic.spdx}${lic.url ? ` ([licence file](${lic.url}))` : ""}, read from ${lic.source} on ${lic.read_on}` : "licence not determined; see the repository"}`);
  }
  out.push("");
  return out.join("\n");
}

export function renderCard(o: { name: string | null; agent: string; site: string | null; core: string | null; rec: LearningsRecord; prefix: string }): string {
  const site = o.site?.replace(/\/+$/, "") ?? null;
  const core = o.core?.replace(/\/+$/, "") ?? site;
  const prov = Object.entries(o.rec.providers).sort((a, b) => b[1] - a[1]);
  return [
    `# Lineage learnings: ${o.name ?? `agent ${o.agent.slice(0, 8)}`}`,
    "",
    `What agent \`${o.agent}\` learned while improving code on Lineage: one record per finished authoring attempt (accepted, rejected, expired, ended without a candidate, or abandoned), with what it read, searched, edited and measured, the candidate it submitted, the independent replays and verdict, what it cost, and a reward computed only from measured facts. Meant for training and evaluating coding agents (recursive learning, reinforcement learning).`,
    "",
    "## Contents",
    "",
    `- \`${o.prefix}episodes/<lineage_id>/<episode_id>.json\`: one episode per attempt (schema \`lineage-episode/1\`). ${o.rec.episodes} episode${o.rec.episodes === 1 ? "" : "s"} so far, up to Core cursor ${o.rec.last_seq}.`,
    `- \`${o.prefix}episodes/<lineage_id>/lessons.md\`: per target, outcomes, effects, why candidates failed, and the agent's own journal entries.`,
    `- \`${o.prefix}LICENSES.md\`: the licence of each target repository.`,
    "",
    "## Schema",
    "",
    `Field by field at ${core ? `${core}/v1/learnings/schema` : "`GET /v1/learnings/schema` on the Lineage Core API"}. The full dataset across all agents pages from ${core ? `${core}/v1/learnings/episodes?format=jsonl&since=0` : "`GET /v1/learnings/episodes?format=jsonl&since=0`"} (follow \`x-next-since\`).`,
    "",
    "## Reward",
    "",
    "- `accepted`: 1 when the candidate was accepted by independent replays, else 0.",
    "- `effect`: for an accepted metric candidate, `1 - ratio` where `ratio` is new over old (lower is better) on the worst counted replay; 0 for every other outcome; null for an accepted fix (`fixed_tests` counts the tests it fixed).",
    "- `effect_per_usd` and `effect_per_sandbox_hour`: `effect` divided by the recorded model spend or sandbox time, null when either is unknown.",
    "- `inputs` lists the fields each value came from. Cost comes from the runtime's signed provenance record when there is one (`provenance:hosted`), else from the worker's own report (`worker_report`, claimed); it is never estimated.",
    "",
    "## Provenance",
    "",
    "Each episode names the model provider, model ids and route that produced it (`model`), with where that came from (`model.source`). Filter by provider before training: providers' terms may restrict using outputs to train models.",
    "",
    ...(prov.length ? prov.map(([p, n]) => `- ${p === "none" ? "no model (scripted author)" : p}: ${n} episode${n === 1 ? "" : "s"}`) : ["- none yet"]),
    "",
    "## Licence",
    "",
    `The records are offered under CC BY 4.0. Code excerpts inside them stay under their own repository's licence; see \`${o.prefix}LICENSES.md\` and each episode's \`attribution\`.`,
    "",
    "## How to verify",
    "",
    `1. Every episode is served by Core: \`GET /v1/learnings/episodes/<episode_id>\`${core ? ` on ${core}` : ""}; the file here must equal it.`,
    "2. `verify` in each episode lists the Core paths that serve its parts independently: the session, the candidate (patch and verdict), the generation, the signed provenance record and the signed journal entry.",
    "3. The verdict can be recomputed from the revealed replays, and the replay draws checked against the chain, with `bun scripts/verify.ts --core <core> --candidate <commit_id> --chain` from the Lineage repository.",
    `4. \`bun scripts/learnings/verify.ts <episode file or URL> --core <core>\` does 1 and 2 at once: equality with Core, the patch hash, the provenance signature (purpose \`provenance\`) and the journal signature (purpose \`journal\`).`,
    "",
    "Commits in this repository are signed by the agent's own SSH signing key (GitHub shows Verified).",
    ...(site ? ["", `Agent profile: ${site}/agents/${o.agent}/profile`] : []),
    "",
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------
// runner

export interface LearningsOptions {
  svc: IdentityService;
  sources: LearningsSources;
  site: string | null;
  /** public Core base for links in the dataset card (the site serves Core under the same origin) */
  coreUrl?: string | null;
  apiBase?: string;
  gitBase?: string;
  fetch?: Fetch;
  log?: Log;
  now?: () => Date;
  verifyPolls?: number;
}

export interface LearningsSummary {
  agents: number;
  published: { agent: string; repo: string; episodes: number; commit: string | null; verified: boolean | null }[];
  awaiting: string[];
  rate_limited: number;
  unchanged: number;
  failed: { agent: string; reason: string }[];
}

export class LearningsPublisher {
  private readonly creds: EncryptedCredentialStore;
  private readonly log: Log;
  private readonly now: () => Date;
  constructor(readonly o: LearningsOptions) {
    this.creds = new EncryptedCredentialStore(o.svc.o.store, `${o.svc.creds.runDir}/learnings`);
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
  }

  private get store() {
    return this.o.svc.o.store;
  }

  record(agent: string): LearningsRecord | null {
    return this.store.get<LearningsRecord>("learnings", agent);
  }

  private save(r: LearningsRecord) {
    r.updated_at = this.now().toISOString();
    this.store.put("learnings", r.agent, r);
  }

  /** The account an agent publishes under: its own (ready), the publisher, or none. */
  private target(agent: string): { cred: AgentCredential; identity: "account" | "publisher"; prefix: string } | null {
    const s = this.o.svc.state(agent);
    const own = s && s.status === "ready" ? this.creds.get(agent) : null;
    if (own) return { cred: own, identity: "account", prefix: "" };
    const pub = publisherRecord(this.o.svc);
    if (!pub) return null;
    const id = publisherIdentity(this.o.svc);
    return {
      cred: { v: 1, agent, login: pub.login, github_id: pub.github_id, token: pub.token, ssh_private_key_path: id.signingKey!, ssh_public_key: pub.ssh_public_key, ssh_signing_key_id: pub.ssh_signing_key_id, assigned_at: pub.set_at },
      identity: "publisher",
      prefix: `agents/${agent}/`,
    };
  }

  /** Publishes one agent's new episodes (one batch, one commit). */
  async runAgent(agent: string, o: { force?: boolean; dryRun?: boolean } = {}): Promise<"published" | "unchanged" | "rate_limited" | "awaiting" | "failed"> {
    const prev = this.record(agent);
    const rec: LearningsRecord = prev ?? { v: 1, agent, status: "skipped", reason: null, identity: null, login: null, repo: null, last_seq: 0, episodes: 0, providers: {}, lineages: [], commit: null, committed_at: 0, updated_at: "" };
    try {
      const t = this.target(agent);
      if (!t) {
        rec.status = "awaiting publisher";
        rec.reason = "the agent has no GitHub account of its own and no publisher account is configured";
        rec.identity = null;
        if (!o.dryRun) this.save(rec);
        return "awaiting";
      }
      // the account changed (a pasted token after the publisher, or the reverse): start the new repository from the beginning
      if (rec.login && rec.login.toLowerCase() !== t.cred.login.toLowerCase()) Object.assign(rec, { last_seq: 0, episodes: 0, providers: {}, lineages: [], commit: null, committed_at: 0 });
      const at = this.now().getTime();
      const page = await this.o.sources.episodes(agent, rec.last_seq, LEARNINGS_BATCH);
      const eps = page.episodes.filter((e) => e && e.agent?.id === agent && typeof e.episode_id === "string" && /^[0-9a-f]{64}$/.test(e.episode_id) && /^[0-9a-f]{64}$/.test(e.task?.lineage_id ?? ""));
      if (!eps.length && rec.status === "published" && rec.login?.toLowerCase() === t.cred.login.toLowerCase()) return "unchanged";
      if (!o.force && rec.committed_at && at - rec.committed_at < LEARNINGS_MIN_INTERVAL_MS) return "rate_limited";
      const lessons = await this.o.sources.lessons(agent);
      const name = eps.find((e) => e.agent?.name)?.agent?.name ?? null;
      const providers = { ...rec.providers };
      for (const e of eps) providers[e.model?.provider ?? "none"] = (providers[e.model?.provider ?? "none"] ?? 0) + 1;
      const next: LearningsRecord = {
        ...rec, identity: t.identity, login: t.cred.login, repo: `${t.cred.login}/${LEARNINGS_REPO}`, providers, episodes: rec.episodes + eps.length,
        last_seq: eps.length ? Math.max(...eps.map((e) => e.seq)) : rec.last_seq, lineages: [...new Set([...rec.lineages, ...eps.map((e) => e.task.lineage_id)])].sort(),
      };
      const touched = new Set(eps.map((e) => e.task.lineage_id));
      const files: Record<string, string> = {};
      for (const e of eps) files[`${t.prefix}episodes/${e.task.lineage_id}/${e.episode_id}.json`] = JSON.stringify(e, null, 2) + "\n";
      for (const l of lessons.lineages ?? []) if (touched.has(l.lineage_id) || !prev) files[`${t.prefix}episodes/${l.lineage_id}/lessons.md`] = renderLessons(l);
      files[`${t.prefix}LICENSES.md`] = renderLicenses(lessons.lineages ?? []);
      const card = renderCard({ name, agent, site: this.o.site, core: this.o.coreUrl ?? this.o.site, rec: next, prefix: t.prefix });
      if (t.identity === "account") files["README.md"] = card;
      else files[`${t.prefix}README.md`] = card;
      if (o.dryRun) {
        this.log(`learnings: ${agent} would commit ${eps.length} episodes to ${next.repo} (dry run)`);
        return "published";
      }
      const site = this.o.site?.replace(/\/+$/, "") ?? null;
      const res: ProfileCommitResult = await profileRepoCommit({
        cred: t.cred, repoName: LEARNINGS_REPO, replaceTree: false, plan: () => files,
        message: `Lineage learnings: ${eps.length} episode${eps.length === 1 ? "" : "s"} up to cursor ${next.last_seq}\n\n${lineageTrailers({ agent })}\n`,
        description: t.identity === "account" ? "What this Lineage agent learned: one record per authoring attempt, with verdicts and rewards" : "Learnings of Lineage agents without their own GitHub account",
        homepage: site ? `${site}/agents/${agent}/profile` : undefined,
        apiBase: this.o.apiBase, gitBase: this.o.gitBase, fetch: this.o.fetch, log: (m) => this.log(m), verifyPolls: this.o.verifyPolls,
      });
      next.status = "published";
      next.reason = null;
      next.repo = res.repo;
      next.commit = { sha: res.sha, verified: res.verified, reason: res.reason, html_url: res.html_url };
      next.committed_at = at;
      this.save(next);
      this.log(`learnings: ${agent} ${res.unchanged ? "unchanged on GitHub" : `committed ${eps.length} episodes to ${res.repo}@${res.sha.slice(0, 12)} (${res.verified ? "Verified" : res.reason})`}`);
      return "published";
    } catch (e) {
      rec.status = prev?.status === "published" ? "published" : "failed";
      rec.reason = errText(e);
      if (!o.dryRun) this.save(rec);
      this.log(`learnings: ${agent} failed: ${rec.reason}`);
      return "failed";
    } finally {
      this.creds.cleanup();
    }
  }

  /** One pass over every agent with published episodes; reports the records to Core. */
  async tick(o: { agents?: string[]; force?: boolean; dryRun?: boolean } = {}): Promise<LearningsSummary> {
    const sum: LearningsSummary = { agents: 0, published: [], awaiting: [], rate_limited: 0, unchanged: 0, failed: [] };
    const list = (await this.o.sources.agents()).map((a) => a.agent).filter((a) => !o.agents || o.agents.includes(a));
    sum.agents = list.length;
    for (const a of list) {
      const r = await this.runAgent(a, o);
      if (r === "awaiting") sum.awaiting.push(a);
      else if (r === "rate_limited") sum.rate_limited++;
      else if (r === "unchanged") sum.unchanged++;
      else if (r === "failed") sum.failed.push({ agent: a, reason: this.record(a)?.reason ?? "" });
      const rec = this.record(a);
      if (r === "published" && rec) sum.published.push({ agent: a, repo: rec.repo ?? "", episodes: rec.episodes, commit: rec.commit?.sha ?? null, verified: rec.commit?.verified ?? null });
    }
    if (!o.dryRun && this.o.sources.record) {
      const reports: RepoReport[] = list.map((a) => {
        const r = this.record(a);
        return {
          agent: a, status: r?.status ?? "skipped", repo: r?.repo ?? null, url: r?.repo && r.status === "published" ? `https://github.com/${r.repo}` : null,
          commit: r?.commit?.sha ?? null, verified: r?.commit?.verified ?? null, episodes: r?.episodes ?? null, last_seq: r?.last_seq ?? null, reason: r?.reason ? r.reason.slice(0, 300) : null,
        };
      });
      await this.o.sources.record(reports).catch((e) => this.log(`learnings: Core did not record the repositories: ${errText(e)}`));
    }
    return sum;
  }
}
