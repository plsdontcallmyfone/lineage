// One mirror and PR bot cycle for every agent with credentials (plan B "Timers"; SPEC 16.1, 16.2).
// Run by the lineage-identity-cycle timer as the identity user, so the credentials never leave it:
//   1. every stored token is checked with GET /user; one GitHub rejects moves its agent to the app
//      identity (status rejected) and its credential is dropped;
//   2. the lineages to publish are those with an accepted generation by an agent with credentials,
//      skipped when nothing changed since the last successful cycle (tip and credential set);
//   3. mirrorOnce publishes them to each author's fork (signed, Verified), then prCycle asks Core per
//      generation and opens a PR only where Core says the repository opted in (with the Core key that
//      may record PRs); otherwise nothing is opened;
//   4. every accepted generation of those lineages is reported to Core (POST /v1/github/generations,
//      docs/plans/GENERATIONS-ON-GITHUB.md): its Verified commit, or "awaiting publisher" for an
//      app-identity generation while no publisher account is configured (publisher.ts); Core reads
//      each commit from GitHub itself before recording it;
//   5. the materialised signing keys are removed and a summary (no secrets) is stored for the API.

import { readFileSync } from "node:fs";
import { keyFromSolanaJson, type AgentKey } from "../../protocol/src/auth.ts";
import { GitHub, GitHubError, type Fetch } from "../../souls/src/github/api.ts";
import { CoreReader, githubRepo } from "../../mirror/src/coreapi.ts";
import { dropWork, mirrorOnce, storeIdentities, type GenRecord } from "../../mirror/src/mirror.ts";
import { prCycle, type PrRecord } from "../../mirror/src/prbot.ts";
import { CoreClient } from "../../core/src/client.ts";
import { publisherIdentity } from "./publisher.ts";
import type { PublishedRecord } from "./records.ts";
import { errText, type Log } from "./redact.ts";
import type { IdentityService } from "./service.ts";

export interface CycleOptions {
  svc: IdentityService;
  core: string;
  site?: string;
  /** Core's runtime or admin key file (Solana keypair JSON): needed to record PRs; without it no PR is opened */
  coreKeyFile?: string | null;
  apiBase?: string;
  gitBase?: string;
  fetch?: Fetch;
  dryRun?: boolean;
  /** rebuild every selected lineage even if unchanged */
  force?: boolean;
  log?: Log;
  now?: () => Date;
  /** sends a signed POST to Core (tests); default: CoreClient with the Core key */
  postCore?: (path: string, body: unknown) => Promise<{ status: number; body: any }>;
  /** fetch for Core's public API (tests) */
  coreFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** One generation's GitHub record for Core (docs/plans/GENERATIONS-ON-GITHUB.md 3). */
export type GithubRecord = { gen_id: string; repo: string; branch: string; sha: string; identity: "account" | "app"; login: string | null } | { gen_id: string; status: "awaiting publisher" };

/** Bumped when the commit message format changes: every lineage is rebuilt and re-recorded once. */
export const CYCLE_FORMAT = "g2";

export interface CycleSummary {
  at: string;
  agents: number;
  rejected: string[];
  lineages: { lineage_id: string; recipe: string; status: string; detail: string | null }[];
  skipped_unchanged: number;
  published: number;
  verified: number;
  prs: { gen_id: string; action: string; reason: string | null; url: string | null }[];
  /** generation records Core accepted (recorded or unchanged), records awaiting a publisher, and Core's refusals */
  recorded: number;
  awaiting: number;
  record_failures: { gen_id: string; result: string; detail: string | null }[];
  publisher: string | null;
  error: string | null;
}

export async function cycleOnce(o: CycleOptions): Promise<CycleSummary> {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const { svc } = o;
  const store = svc.o.store;
  const sum: CycleSummary = { at: now().toISOString(), agents: 0, rejected: [], lineages: [], skipped_unchanged: 0, published: 0, verified: 0, prs: [], recorded: 0, awaiting: 0, record_failures: [], publisher: null, error: null };
  try {
    // 1. tokens still accepted?
    const agents: string[] = [];
    for (const a of svc.creds.agents()) {
      const c = svc.creds.record(a);
      if (!c) continue;
      try {
        const u = await new GitHub({ token: c.token, base: o.apiBase, fetch: o.fetch }).get<{ login: string }>("/user");
        if (String(u.login).toLowerCase() !== c.login.toLowerCase()) throw new GitHubError(401, "GET", "/user", `token now belongs to ${u.login}`);
        agents.push(a);
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 401 || e.status === 403)) {
          const why = `GitHub rejected the stored token on use (${e.status}); the agent uses the app identity`;
          if (!o.dryRun) svc.markRejected(a, why);
          sum.rejected.push(a);
          log(`cycle: ${a} (${c.login}): ${why}`);
        } else {
          log(`cycle: ${a} (${c.login}): token check failed, kept: ${errText(e)}`);
          agents.push(a);
        }
      }
    }
    sum.agents = agents.length;

    // 2. lineages to build: a generation by an agent with an account, or (with a publisher) any
    //    app-identity generation. Lineages with only app-identity authors and no publisher are not
    //    built: their generations are recorded as awaiting a publisher straight from Core's view.
    const app = publisherIdentity(svc);
    const hasPublisher = !!(app.login && app.token);
    sum.publisher = hasPublisher ? app.login : null;
    const reader = new CoreReader(o.core, o.coreFetch);
    const cache = store.get<Record<string, string>>("cycle", "cache") ?? {};
    const selected: string[] = [];
    const awaitingOnly = new Map<string, GithubRecord[]>();
    const wanted = new Set(agents);
    for (const l of await reader.lineages()) {
      if (!githubRepo(l.repo) || l.height === 0) continue;
      const L = await reader.lineage(l.lineage_id);
      const gens = L.generations.filter((g) => g.entry_type === "patch" || g.entry_type === "revert");
      if (!gens.length) continue;
      const mine = [...new Set(gens.filter((g) => g.entry_type === "patch" && g.author && wanted.has(g.author)).map((g) => g.author!))].sort();
      const appGens = gens.filter((g) => !g.author || !svc.creds.record(g.author));
      const logins = mine.map((a) => svc.creds.record(a)?.login ?? "?");
      const build = mine.length > 0 || (hasPublisher && appGens.length > 0);
      const key = `${CYCLE_FORMAT}|${L.tip}|${L.height}|${mine.join(",")}|${logins.join(",")}|${build ? (hasPublisher ? app.login : "-") : "awaiting"}`;
      if (!o.force && cache[l.lineage_id] === key) {
        sum.skipped_unchanged++;
        continue;
      }
      if (!build && appGens.length !== gens.length) continue; // an account author whose token check failed this cycle: next cycle
      cache[l.lineage_id] = `pending:${key}`;
      if (build) selected.push(l.lineage_id);
      else awaitingOnly.set(l.lineage_id, gens.map((g) => ({ gen_id: g.gen_id, status: "awaiting publisher" as const })));
    }

    // 3. mirror, then the PR bot
    const identities = storeIdentities(svc.creds, app);
    const report = selected.length
      ? await mirrorOnce({
          core: reader, identities, site: o.site, lineages: selected, agents, dryRun: o.dryRun, verify: true, log, keepWork: !!o.coreKeyFile,
          apiBase: o.apiBase, gitBase: o.gitBase, fetch: o.fetch,
        })
      : null;
    let prs: PrRecord[] = [];
    if (report) {
      try {
        if (o.coreKeyFile && agents.length) {
          prs = await prCycle({ core: reader, coreUrl: o.core, runtimeKey: coreKey(o.coreKeyFile), identities, mirror: report, site: o.site, dryRun: o.dryRun, log, apiBase: o.apiBase, gitBase: o.gitBase, fetch: o.fetch });
        }
      } finally {
        dropWork(report);
      }
    }
    sum.prs = prs.filter((p) => p.author && wanted.has(p.author)).map((p) => ({ gen_id: p.gen_id, action: p.action, reason: p.reason, url: p.url }));
    for (const l of report?.lineages ?? []) sum.lineages.push({ lineage_id: l.lineage_id, recipe: l.recipe, status: l.status, detail: l.detail });

    // per-agent published records (kept for the status API), and the cache only for clean lineages
    const byAgent = new Map<string, GenRecord[]>();
    for (const g of report?.generations ?? []) if (g.author && wanted.has(g.author) && g.identity === "account") byAgent.set(g.author, [...(byAgent.get(g.author) ?? []), g]);
    for (const [agent, gens] of byAgent) {
      const prev = store.get<PublishedRecord[]>("published", agent) ?? [];
      const out = new Map(prev.map((p) => [p.gen_id, p]));
      for (const g of gens) {
        if (g.status !== "published") continue;
        sum.published++;
        if (g.verified) sum.verified++;
        out.set(g.gen_id, { gen_id: g.gen_id, lineage_id: g.lineage_id, recipe: g.recipe, height: g.height, fork: g.fork, branch: g.branch, sha: g.sha, verified: g.verified, verification_reason: g.verification_reason, html_url: g.html_url, at: sum.at });
      }
      if (!o.dryRun) store.put("published", agent, [...out.values()].slice(-50));
    }

    // 4. GitHub records for Core, per lineage
    const records = new Map<string, GithubRecord[]>(awaitingOnly);
    for (const g of report?.generations ?? []) {
      const r = githubRecord(g);
      if (r) records.set(g.lineage_id, [...(records.get(g.lineage_id) ?? []), r]);
    }
    const accepted = new Set<string>();
    const all = [...records.values()].flat();
    sum.awaiting = all.filter((r) => "status" in r).length;
    const post = o.postCore ?? (o.coreKeyFile ? corePoster(o.core, coreKey(o.coreKeyFile)) : null);
    if (o.dryRun || !post) {
      for (const r of all) accepted.add(r.gen_id);
      if (!post && all.length) log(`cycle: no Core key; ${all.length} GitHub records not sent`);
    } else {
      for (let i = 0; i < all.length; i += 100) {
        const chunk = all.slice(i, i + 100);
        try {
          const res = await post("/v1/github/generations", { records: chunk });
          if (res.status !== 200) throw new Error(`Core answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
          for (const x of res.body.results as { gen_id: string; result: string; detail: string | null }[]) {
            if (x.result === "recorded" || x.result === "unchanged") accepted.add(x.gen_id);
            else sum.record_failures.push({ gen_id: x.gen_id, result: x.result, detail: x.detail });
          }
        } catch (e) {
          for (const r of chunk) sum.record_failures.push({ gen_id: r.gen_id, result: "error", detail: errText(e) });
        }
      }
      sum.recorded = all.filter((r) => !("status" in r) && accepted.has(r.gen_id)).length;
      for (const f of sum.record_failures.slice(0, 10)) log(`cycle: GitHub record of ${f.gen_id.slice(0, 12)} ${f.result}: ${f.detail ?? ""}`);
    }

    for (const id of [...selected, ...awaitingOnly.keys()]) {
      const lr = report?.lineages.find((l) => l.lineage_id === id);
      const gens = (report?.generations ?? []).filter((g) => g.lineage_id === id && g.author && wanted.has(g.author));
      const built = awaitingOnly.has(id) || (lr && lr.status === "built" && lr.pushes.every((p) => p.action === "pushed" || p.action === "unchanged") && gens.every((g) => g.status === "published" && g.verified !== false));
      const recs = records.get(id) ?? [];
      const clean = built && recs.every((r) => accepted.has(r.gen_id)) && (awaitingOnly.has(id) || recs.length === (report?.generations ?? []).filter((g) => g.lineage_id === id).length);
      if (clean) cache[id] = cache[id]!.replace(/^pending:/, "");
      else delete cache[id];
    }
    if (!o.dryRun) store.put("cycle", "cache", cache);
  } catch (e) {
    sum.error = errText(e);
    log(`cycle: ${sum.error}`);
  } finally {
    svc.creds.cleanup();
  }
  return finish();

  function finish(): CycleSummary {
    if (!o.dryRun) store.put("cycle", "last", { summary: sum });
    return sum;
  }
}

function coreKey(file: string): AgentKey {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(raw) ? keyFromSolanaJson(raw) : raw;
}

function corePoster(core: string, key: AgentKey) {
  const cc = new CoreClient(core.replace(/\/$/, ""), key);
  return (path: string, body: unknown) => cc.post(path, body);
}

/** What Core records for one mirrored generation: its pushed commit, awaiting a publisher, or nothing yet. */
export function githubRecord(g: GenRecord): GithubRecord | null {
  if (g.status === "dry_run" || g.status === "skipped" || g.status === "error" || g.detail?.startsWith("verification check failed")) return null;
  if (g.sha && g.fork && (g.status === "published" || g.status === "fallback")) {
    return { gen_id: g.gen_id, repo: g.fork, branch: g.branch, sha: g.sha, identity: g.identity, login: g.login };
  }
  // no publisher configured (the app identity has no login): queued; a publisher whose push failed: retried
  if (g.status === "fallback" && !g.login) return { gen_id: g.gen_id, status: "awaiting publisher" };
  return null;
}
