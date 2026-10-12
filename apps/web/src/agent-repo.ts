// The agent's OWN GitHub repository, beside the upstream it improves (owner 2026-10-12: "on the main web
// it should also show the agent's repo that it's working on"). Upstream is the public repository the
// unit measures (keis/base58); the agent's repository is where its accepted generations are published
// as commits: its own account's fork (<login>/base58) or, for an agent without an account, its branch
// of the publisher's units-agents/generations. Everything here is read from Core's record of published
// commits (GET /v1/github/generations, the generation `github` field): a repository is shown only when
// a commit of the agent is recorded in it, never built from a guess. With none: "No repository yet".
import { repoLabel } from "./fmt.ts";
import { html, type Raw } from "./html.ts";

export interface GenGithubRow {
  gen_id: string;
  author?: string | null;
  /** the upstream repository URL of the generation's unit */
  repo?: string | null;
  github?: { url?: string; commit?: string; repo?: string; branch?: string | null; identity?: string | null; login?: string | null; status?: string } | null;
}
export interface AgentRepo {
  /** owner/name as GitHub has it */
  repo: string;
  url: string;
  /** set when the repository is shared by several agents (the publisher's), so the agent's part is this branch */
  branch: string | null;
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;

/** The repository a published generation's commit is in, or null (not published, removed, or a malformed record). */
export function repoOfRow(r: GenGithubRow): AgentRepo | null {
  const g = r.github;
  if (!g || !g.commit || typeof g.repo !== "string" || !NAME.test(g.repo)) return null;
  // the publisher's shared repository holds one branch per unit and agent: the branch is the agent's part of it
  const shared = g.identity === "app" && typeof g.branch === "string" && BRANCH.test(g.branch) && !g.branch.includes("..");
  return { repo: g.repo, url: `https://github.com/${g.repo}${shared ? `/tree/${g.branch}` : ""}`, branch: shared ? g.branch! : null };
}

/** The distinct repositories in a list of generations (newest first), optionally only those of one upstream. */
export function agentRepos(rows: GenGithubRow[], upstream?: string | null): AgentRepo[] {
  const out = new Map<string, AgentRepo>();
  for (const r of rows) {
    if (upstream && r.repo && r.repo.replace(/\.git$/, "").replace(/\/+$/, "") !== upstream.replace(/\.git$/, "").replace(/\/+$/, "")) continue;
    const a = repoOfRow(r);
    if (a && !out.has(a.url)) out.set(a.url, a);
  }
  return [...out.values()];
}

const repoText = (a: AgentRepo) => (a.branch ? `${a.repo}, branch ${a.branch}` : a.repo);
/** The label of the agent side: one agent's repository, or the repositories of a unit's agents. */
export const agentRepoLabel = (many: boolean, n: number) => (many ? (n === 1 ? "Agent's repo" : "Agents' repos") : "Agent's repo");

/**
 * "Upstream: keis/base58" and "Agent's repo: <login>/base58", each a link, labelled so the two are not
 * confused. `repos` null: not read yet (only the upstream shows); empty: "No repository yet".
 */
export function repoPair(o: { upstream: string | null | undefined; repos: AgentRepo[] | null; many?: boolean }): Raw {
  const up = o.upstream
    ? html`<span class="ar-up"><span class="dim">Upstream:</span> ${/^https:\/\//.test(o.upstream) ? html`<a class="link" href="${o.upstream}" target="_blank" rel="noopener">${repoLabel(o.upstream)}</a>` : html`<span>${o.upstream}</span>`}</span>`
    : "";
  const mine =
    o.repos === null
      ? ""
      : o.repos.length
        ? html`<span class="ar-own"><span class="dim">${agentRepoLabel(!!o.many, o.repos.length)}:</span> ${o.repos.slice(0, 4).map((a, i) => html`${i ? ", " : ""}<a class="link" href="${a.url}" target="_blank" rel="noopener">${repoText(a)}</a>`)}${o.repos.length > 4 ? html` <span class="dim">and ${o.repos.length - 4} more</span>` : ""}</span>`
        : html`<span class="ar-own dim">${o.many ? "No agent repository yet" : "No repository yet"}</span>`;
  return html`<span class="ar-pair" style="display:inline-flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline">${up}${mine}</span>`;
}

/** A published generation's commit in its author's repository as a link, or nothing. */
export function commitLink(r: GenGithubRow | undefined): Raw {
  const a = r ? repoOfRow(r) : null;
  const g = r?.github;
  if (!a || !g?.url || !g.commit || !/^https:\/\/github\.com\//.test(g.url)) return html``;
  return html`<a class="link" href="${g.url}" target="_blank" rel="noopener" title="${g.commit}">commit ${g.commit.slice(0, 7)} in ${a.repo}</a>`;
}

// ---------------------------------------------------------------- page slots (read once per key, kept)
const lists = new Map<string, GenGithubRow[] | Promise<GenGithubRow[] | null>>();
function listOf(by: "agent" | "lineage", id: string): GenGithubRow[] | Promise<GenGithubRow[] | null> {
  const key = `${by}:${id}`;
  let p = lists.get(key);
  if (!p) {
    p = fetch(`/api/github/generations?${by}=${encodeURIComponent(id)}&limit=200`, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (Array.isArray(j?.generations) ? (j.generations as GenGithubRow[]) : null))
      .catch(() => null);
    lists.set(key, p);
    void p.then((v) => (v ? lists.set(key, v) : lists.delete(key)));
  }
  return p;
}

/**
 * The labelled pair for an agent (its repository for this upstream) or a unit (its agents' repositories),
 * filled once Core answers; a repaint of the page shows the kept answer at once.
 */
export function repoPairSlot(by: "agent" | "lineage", id: string | null | undefined, upstream: string | null | undefined): Raw {
  if (!id) return repoPair({ upstream, repos: null });
  const many = by === "lineage";
  const have = listOf(by, id);
  const slot = `${by}:${id}`;
  if (Array.isArray(have)) return html`<span data-repo-pair="${slot}">${repoPair({ upstream, repos: agentRepos(have, many ? null : upstream), many })}</span>`;
  void have.then((rows) => {
    if (!rows) return;
    const fill = () => {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-repo-pair="${slot}"][data-pending]`)) {
        el.removeAttribute("data-pending");
        el.innerHTML = repoPair({ upstream: el.dataset.upstream || null, repos: agentRepos(rows, many ? null : el.dataset.upstream || null), many }).s;
      }
      for (const el of document.querySelectorAll<HTMLElement>("[data-gen-commit][data-pending]")) {
        const row = rows.find((r) => r.gen_id === el.dataset.genCommit);
        if (!row) continue;
        el.removeAttribute("data-pending");
        el.innerHTML = commitLink(row).s;
      }
    };
    // the page may put this markup into the document only after Core answered: fill now and shortly after
    fill();
    for (const ms of [50, 250, 1000, 3000]) setTimeout(fill, ms);
  });
  return html`<span data-repo-pair="${slot}" data-pending="1" data-upstream="${upstream ?? ""}">${repoPair({ upstream, repos: null, many })}</span>`;
}

/** A generation row's commit link, filled by the unit's repoPairSlot read (same request). */
export function commitSlot(lineage: string, genId: string): Raw {
  const have = lists.get(`lineage:${lineage}`);
  if (Array.isArray(have)) return html`<span data-gen-commit="${genId}">${commitLink(have.find((r) => r.gen_id === genId))}</span>`;
  return html`<span data-gen-commit="${genId}" data-pending="1"></span>`;
}
