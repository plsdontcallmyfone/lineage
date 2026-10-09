// One mirror and PR bot cycle for every agent with credentials (plan B "Timers"; SPEC 16.1, 16.2).
// Run by the lineage-identity-cycle timer as the identity user, so the credentials never leave it:
//   1. every stored token is checked with GET /user; one GitHub rejects moves its agent to the app
//      identity (status rejected) and its credential is dropped;
//   2. the lineages to publish are those with an accepted generation by an agent with credentials,
//      skipped when nothing changed since the last successful cycle (tip and credential set);
//   3. mirrorOnce publishes them to each author's fork (signed, Verified), then prCycle asks Core per
//      generation and opens a PR only where Core says the repository opted in (with the Core key that
//      may record PRs); otherwise nothing is opened;
//   4. the materialised signing keys are removed and a summary (no secrets) is stored for the API.

import { readFileSync } from "node:fs";
import { keyFromSolanaJson, type AgentKey } from "../../protocol/src/auth.ts";
import { GitHub, GitHubError, type Fetch } from "../../souls/src/github/api.ts";
import { CoreReader, githubRepo } from "../../mirror/src/coreapi.ts";
import { dropWork, mirrorOnce, storeIdentities, type GenRecord } from "../../mirror/src/mirror.ts";
import { prCycle, type PrRecord } from "../../mirror/src/prbot.ts";
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
}

export interface CycleSummary {
  at: string;
  agents: number;
  rejected: string[];
  lineages: { lineage_id: string; recipe: string; status: string; detail: string | null }[];
  skipped_unchanged: number;
  published: number;
  verified: number;
  prs: { gen_id: string; action: string; reason: string | null; url: string | null }[];
  error: string | null;
}

export async function cycleOnce(o: CycleOptions): Promise<CycleSummary> {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const { svc } = o;
  const store = svc.o.store;
  const sum: CycleSummary = { at: now().toISOString(), agents: 0, rejected: [], lineages: [], skipped_unchanged: 0, published: 0, verified: 0, prs: [], error: null };
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
    if (!agents.length) return finish();

    // 2. lineages with a generation by one of them
    const reader = new CoreReader(o.core);
    const cache = store.get<Record<string, string>>("cycle", "cache") ?? {};
    const selected: string[] = [];
    const wanted = new Set(agents);
    for (const l of await reader.lineages()) {
      if (!githubRepo(l.repo) || l.height === 0) continue;
      const L = await reader.lineage(l.lineage_id);
      const mine = [...new Set(L.generations.filter((g) => g.entry_type === "patch" && g.author && wanted.has(g.author)).map((g) => g.author!))].sort();
      if (!mine.length) continue;
      const logins = mine.map((a) => svc.creds.record(a)?.login ?? "?");
      const key = `${L.tip}|${L.height}|${mine.join(",")}|${logins.join(",")}`;
      if (!o.force && cache[l.lineage_id] === key) {
        sum.skipped_unchanged++;
        continue;
      }
      selected.push(l.lineage_id);
      cache[l.lineage_id] = `pending:${key}`;
    }
    if (!selected.length) return finish();

    // 3. mirror, then the PR bot
    const identities = storeIdentities(svc.creds);
    const report = await mirrorOnce({
      core: reader, identities, site: o.site, lineages: selected, agents, dryRun: o.dryRun, verify: true, log, keepWork: !!o.coreKeyFile,
      apiBase: o.apiBase, gitBase: o.gitBase, fetch: o.fetch,
    });
    let prs: PrRecord[] = [];
    try {
      if (o.coreKeyFile) {
        const raw = JSON.parse(readFileSync(o.coreKeyFile, "utf8"));
        const key: AgentKey = Array.isArray(raw) ? keyFromSolanaJson(raw) : raw;
        prs = await prCycle({ core: reader, coreUrl: o.core, runtimeKey: key, identities, mirror: report, site: o.site, dryRun: o.dryRun, log, apiBase: o.apiBase, gitBase: o.gitBase, fetch: o.fetch });
      }
    } finally {
      dropWork(report);
    }
    sum.prs = prs.filter((p) => p.author && wanted.has(p.author)).map((p) => ({ gen_id: p.gen_id, action: p.action, reason: p.reason, url: p.url }));
    for (const l of report.lineages) sum.lineages.push({ lineage_id: l.lineage_id, recipe: l.recipe, status: l.status, detail: l.detail });

    // per-agent published records (kept for the status API), and the cache only for clean lineages
    const byAgent = new Map<string, GenRecord[]>();
    for (const g of report.generations) if (g.author && wanted.has(g.author) && g.identity === "account") byAgent.set(g.author, [...(byAgent.get(g.author) ?? []), g]);
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
    for (const id of selected) {
      const lr = report.lineages.find((l) => l.lineage_id === id);
      const gens = report.generations.filter((g) => g.lineage_id === id && g.author && wanted.has(g.author));
      const clean = lr && lr.status === "built" && lr.pushes.every((p) => p.action === "pushed" || p.action === "unchanged") && gens.every((g) => g.status === "published" && g.verified !== false);
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
