// Mirror publisher (SPEC 16, plan W1). One cycle:
//   1. read every lineage of a GitHub repository from Core's public API;
//   2. build its deterministic commit chain (chain.ts), one commit per accepted generation;
//   3. for every agent with its own GitHub account that authored a generation of the lineage (and the
//      app identity when one is configured and an author has no account), make sure its fork exists
//      and that branch lineage/<recipe>-<lineage8> points at the chain's tip, pushing only when it
//      does not already (idempotent; a rerun after an interruption simply continues);
//   4. ask GitHub whether each of the agent's commits shows Verified.
// A generation whose author has no account is committed under the app identity and recorded as a
// fallback. Nothing here is canonical: deleting a branch and rerunning rebuilds the same commits.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCredential, CredentialStore } from "../../souls/src/github/credentials.ts";
import { APP_IDENTITY, buildChain, type Chain, type CommitIdentity, type Identities } from "./chain.ts";
import { CoreReader, githubRepo, type LineageSummary } from "./coreapi.ts";
import { noreplyEmail } from "./git.ts";
import { branchHead, client, ensureFork, gitUrl, push, verification, type GitHubTarget } from "./github.ts";
import { lineageBranch } from "./message.ts";

export interface MirrorOptions extends GitHubTarget {
  core: CoreReader;
  identities: Identities;
  /** public site base used in commit messages (default: Core's base URL) */
  site?: string;
  /** only these lineages (ids or id prefixes) */
  lineages?: string[];
  /** publish only for these agents (chains are still built whole) */
  agents?: string[];
  /** build chains, never write to GitHub */
  dryRun?: boolean;
  /** check GitHub verification of every published commit (default true) */
  verify?: boolean;
  log?: (m: string) => void;
  /** keep each lineage's working repository (for the PR bot); the caller removes them */
  keepWork?: boolean;
}

export interface PushRecord {
  agent: string | null;
  login: string;
  fork: string | null;
  branch: string;
  sha: string;
  action: "pushed" | "unchanged" | "dry_run" | "error";
  detail: string | null;
}

export interface GenRecord {
  lineage_id: string;
  recipe: string;
  gen_id: string;
  height: number;
  entry_type: "patch" | "revert";
  author: string | null;
  identity: "account" | "app";
  login: string | null;
  sha: string | null;
  signed: boolean;
  fork: string | null;
  branch: string;
  status: "published" | "fallback" | "dry_run" | "skipped" | "error";
  verified: boolean | null;
  verification_reason: string | null;
  html_url: string | null;
  detail: string | null;
}

export interface LineageRecord {
  lineage_id: string;
  recipe: string;
  repo: string;
  status: string;
  branch: string | null;
  base: string | null;
  tip: string | null;
  detail: string | null;
  pushes: PushRecord[];
}

export interface MirrorReport {
  core: string;
  site: string;
  at: string;
  dry_run: boolean;
  lineages: LineageRecord[];
  generations: GenRecord[];
  chains: Chain[];
}

/** Identities from the runtime-only credential store (SPEC 13.9); `app` is the fallback identity. */
export function storeIdentities(store: CredentialStore, app: CommitIdentity = APP_IDENTITY): Identities {
  return {
    forAgent(agent: string) {
      let c: AgentCredential | null = null;
      try {
        c = store.get(agent);
      } catch {
        c = null;
      }
      if (!c) return null;
      return { kind: "account", name: c.login, email: noreplyEmail(c.github_id, c.login), signingKey: c.ssh_private_key_path, login: c.login, token: c.token };
    },
    app: () => app,
  };
}

const matches = (id: string, filters?: string[]) => !filters?.length || filters.some((f) => id.startsWith(f));

export async function mirrorOnce(o: MirrorOptions): Promise<MirrorReport> {
  const log = o.log ?? (() => {});
  const site = (o.site ?? o.core.base).replace(/\/$/, "");
  const report: MirrorReport = { core: o.core.base, site, at: new Date().toISOString(), dry_run: !!o.dryRun, lineages: [], generations: [], chains: [] };
  const all: LineageSummary[] = await o.core.lineages();
  for (const s of all) {
    if (!matches(s.lineage_id, o.lineages)) continue;
    const upstream = githubRepo(s.repo);
    const rec: LineageRecord = { lineage_id: s.lineage_id, recipe: s.recipe_name, repo: s.repo, status: "skipped", branch: null, base: null, tip: null, detail: null, pushes: [] };
    report.lineages.push(rec);
    if (!upstream) {
      rec.detail = "not a GitHub repository";
      continue;
    }
    if (s.height === 0) {
      rec.detail = "no accepted generations";
      continue;
    }
    const L = await o.core.lineage(s.lineage_id);
    const branch = lineageBranch(L.recipe.name, L.lineage_id);
    rec.branch = branch;
    const dir = mkdtempSync(join(tmpdir(), "lineage-mirror-"));
    let chain: Chain;
    try {
      chain = await buildChain({ core: o.core, lineage: L, identities: o.identities, repoGitUrl: gitUrl(o, upstream), site, dir, log });
    } catch (e) {
      rec.status = "error";
      rec.detail = (e as Error).message;
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (o.keepWork) report.chains.push(chain);
    rec.base = chain.base;
    rec.tip = chain.tip;
    rec.status = chain.entries.some((e) => e.error) ? "partial" : "built";

    // who gets the branch: every author with an account, plus a configured app identity for the rest
    const publishers = new Map<string, { agent: string | null; id: CommitIdentity }>();
    for (const e of chain.entries) {
      if (!e.author || e.entry_type !== "patch") continue;
      const own = o.identities.forAgent(e.author);
      if (own?.login && own.token) {
        if (matches(e.author, o.agents)) publishers.set(own.login, { agent: e.author, id: own });
      } else {
        const app = o.identities.app();
        if (app.login && app.token) publishers.set(app.login, { agent: null, id: app });
      }
    }
    const forkOf = new Map<string, string>();
    for (const [login, p] of publishers) {
      const pr: PushRecord = { agent: p.agent, login, fork: null, branch, sha: chain.tip, action: "dry_run", detail: null };
      rec.pushes.push(pr);
      if (o.dryRun) continue;
      try {
        const gh = client(p.id.token!, o);
        const { fork, created } = await ensureFork(gh, login, upstream, o);
        pr.fork = fork;
        forkOf.set(login, fork);
        if (created) log(`mirror: forked ${upstream} to ${fork}`);
        const head = await branchHead(gh, fork, branch);
        if (head === chain.tip) {
          pr.action = "unchanged";
        } else {
          push(dir, p.id.token!, o, fork, chain.tip, branch);
          pr.action = "pushed";
          pr.detail = head ? `moved from ${head.slice(0, 12)}` : "new branch";
          log(`mirror: ${fork}:${branch} -> ${chain.tip.slice(0, 12)} (${pr.detail})`);
        }
      } catch (e) {
        pr.action = "error";
        pr.detail = (e as Error).message;
        log(`mirror: ${login}: ${pr.detail}`);
      }
    }

    for (const e of chain.entries) {
      const g: GenRecord = {
        lineage_id: L.lineage_id, recipe: L.recipe.name, gen_id: e.gen_id, height: e.height, entry_type: e.entry_type, author: e.author,
        identity: e.identity, login: e.login, sha: e.sha, signed: e.signed, fork: e.login ? (forkOf.get(e.login) ?? null) : null, branch,
        status: e.error ? "error" : o.dryRun ? "dry_run" : e.identity === "app" ? "fallback" : "published",
        verified: null, verification_reason: null, html_url: null, detail: e.error,
      };
      if (e.identity === "app" && !e.error) {
        g.detail = e.login ? `no GitHub account for ${e.author}; committed and pushed under the app identity ${e.login}` : `no GitHub account for ${e.author}; committed under the unconfigured app identity (unsigned, not pushed)`;
      }
      if (g.status === "published" && e.author && !matches(e.author, o.agents)) {
        g.status = "skipped";
        g.detail = "agent not selected in this cycle";
      } else if (g.status === "published" && !g.fork) {
        g.status = "error";
        g.detail = "the author's fork could not be updated";
      }
      if (!e.error && e.sha && g.fork && o.verify !== false && !o.dryRun) {
        const id = e.identity === "app" ? o.identities.app() : o.identities.forAgent(e.author!);
        try {
          const v = await verification(client(id!.token!, o), g.fork, e.sha, o);
          g.verified = v.verified;
          g.verification_reason = v.reason;
          g.html_url = v.html_url || null;
        } catch (err) {
          g.detail = `verification check failed: ${(err as Error).message}`;
        }
      }
      report.generations.push(g);
    }
    if (!o.keepWork) rmSync(dir, { recursive: true, force: true });
  }
  return report;
}

/** Removes the working repositories a `keepWork` cycle left. */
export function dropWork(r: MirrorReport) {
  for (const c of r.chains) rmSync(c.dir, { recursive: true, force: true });
  r.chains = [];
}

export { CoreReader };
