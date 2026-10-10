import type { Core } from "./core.ts";
import { bad, conflict, forbidden, notFound } from "./errors.ts";
import { canonicalJson, canonicalUrl, isKind, repoId, verifyStatement } from "./protocol.ts";

// Upstream policy (SPEC 16, plan W2): the opt-in registry, the PR bot's eligibility rule and
// upstream-merge detection.
//
// Opt-in. A repository opts in by a `.lineage.yml` on its default branch (read through the GitHub API)
// or by a maintainer-signed statement: `{ v: 1, kind: "lineage-upstream-optin", repo, maintainer,
// key, max_prs_per_week, kinds, contact, created_at }` signed by `key` with purpose "upstream" and
// posted as a public gist owned by `maintainer`, who must own the repository (or be a public member
// of the owning organisation). A contribution policy that bans AI-generated changes (CONTRIBUTING,
// AI_POLICY, AGENTS and similar files at the root, in .github/ or docs/) blocks the opt-in either
// way; `.lineage.yml` with `opt_out: true` (or `opt_in: false`) opts the repository out.
//
// PR bot. Core only decides and records; the PR itself is opened by the hosted runtime with the
// agent's own token (SPEC 13.9; packages/mirror/src/prbot.ts). One PR per accepted generation, only
// for opted-in repositories, within the repository's weekly cap and allowed kinds. A recorded PR, in
// any state, ends the attempt: the bot never comments, argues or reopens.
//
// Merge detection. For every live accepted generation of an opted-in repository, Core reads the
// default branch's commits since the generation was accepted and matches the generation's hunks
// (added and removed lines, per file) against each commit's diff. The first match credits
// `upstream_bonus` units (config key, TEST value) to the generation's authors, in the proportion of
// their author units, in the epoch that is open at detection, so they are paid when it closes.

export const UPSTREAM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS upstream_repos (
    repo_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    full_name TEXT NOT NULL,
    status TEXT NOT NULL,                -- opted_in | not_opted_in | ai_banned | opted_out | unreachable
    source TEXT,                         -- lineage_yml | signed
    default_branch TEXT,
    max_prs_per_week INTEGER,
    kinds TEXT,                          -- JSON array, null = every kind
    contact TEXT,
    ai_policy TEXT,                      -- JSON { file, excerpt } of the ban that blocked it
    signed TEXT,                         -- JSON { statement, sig, gist_id } of a maintainer opt-in
    checked_at INTEGER NOT NULL,
    scanned_at INTEGER,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS upstream_prs (
    gen_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    head TEXT,
    opened_by TEXT,
    state TEXT NOT NULL,                 -- open | closed | merged
    opened_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS upstream_merges (
    gen_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    upstream_sha TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    bonus REAL NOT NULL,
    credited TEXT NOT NULL               -- JSON [{ agent, units }]
  );
  CREATE TABLE IF NOT EXISTS upstream_seen (
    repo_id TEXT NOT NULL,
    sha TEXT NOT NULL,
    PRIMARY KEY (repo_id, sha)
  );
`;

// -------------------------------------------------------------------------------------------------
// Pure parts (unit-tested without GitHub)

export interface OptInConfig {
  opted_in: boolean;
  opted_out: boolean;
  max_prs_per_week: number;
  kinds: string[] | null;
  contact: string | null;
  errors: string[];
}

export const DEFAULT_MAX_PRS_PER_WEEK = 3; // TEST value; a repository sets its own
const KINDS = ["perf", "slim", "fix"];

/** Parses `.lineage.yml` (top level or under `lineage:`). Its presence on the default branch is the opt-in. */
export function parseLineageYml(text: string): OptInConfig {
  const out: OptInConfig = { opted_in: true, opted_out: false, max_prs_per_week: DEFAULT_MAX_PRS_PER_WEEK, kinds: null, contact: null, errors: [] };
  let raw: any;
  try {
    raw = text.trim() ? Bun.YAML.parse(text) : {};
  } catch (e) {
    out.opted_in = false;
    out.errors.push(`not valid YAML: ${(e as Error).message.slice(0, 120)}`);
    return out;
  }
  const o = raw && typeof raw === "object" && raw.lineage && typeof raw.lineage === "object" ? raw.lineage : raw && typeof raw === "object" ? raw : {};
  if (o.opt_out === true || o.opt_in === false) {
    out.opted_in = false;
    out.opted_out = true;
  }
  if (o.max_prs_per_week !== undefined) {
    if (Number.isInteger(o.max_prs_per_week) && o.max_prs_per_week >= 0 && o.max_prs_per_week <= 100) out.max_prs_per_week = o.max_prs_per_week;
    else out.errors.push("max_prs_per_week must be an integer from 0 to 100");
  }
  if (o.kinds !== undefined) {
    const k = Array.isArray(o.kinds) ? o.kinds.map(String) : [];
    const good = k.filter((x: string) => KINDS.includes(x));
    if (!good.length || good.length !== k.length) out.errors.push(`kinds must be a list of ${KINDS.join(", ")}`);
    if (good.length) out.kinds = good;
  }
  if (o.contact !== undefined) out.contact = String(o.contact).slice(0, 200);
  return out;
}

/** Contribution-policy files read for AI bans: at the root, in .github/ and in docs/. */
export function isPolicyFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1]!.toLowerCase();
  const dir = parts.slice(0, -1).join("/").toLowerCase();
  if (dir && dir !== ".github" && dir !== "docs") return false;
  return /^(contributing|ai[_-]?policy|ai[_-]?usage|ai[_-]?contributions?|ai|llms?[_-]?policy|generative[_-]ai|agents|claude|copilot-instructions|code[_-]of[_-]conduct)(\.(md|markdown|rst|txt|adoc))?$/.test(name);
}

const AI_TERM = /\b(ai|a\.i\.|artificial intelligence|llms?|large language models?|chatgpt|copilot|gpt-?\d*|claude|gemini|genai|generative|machine[- ]generated|ai[- ]generated|ai[- ]assisted|ai[- ]written|language models?|coding (assistants?|agents?)|autonomous agents?|ai agents?)\b/i;
const BAN_TERM =
  /\b(not (be )?(accepted|allowed|permitted|welcome|welcomed|tolerated)|(is|are) (prohibited|forbidden|banned|disallowed)|prohibit(ed|s)?|forbid(den|s)?|ban(ned|s)?|disallow(ed|s)?|(will|may) be (rejected|closed|refused)|reject(ed)?|do not (submit|use|send|open|contribute|accept)|don'?t (submit|use|send|open|contribute|accept)|must not|may not|cannot (be )?(accept|use)|never (submit|accept|merge)|refuse[ds]?|no (ai|llm)|zero[- ]tolerance)\b/i;

/** The first sentence of a policy file that bans AI-generated contributions, or null. */
export function detectAiBan(files: { path: string; text: string }[]): { file: string; excerpt: string } | null {
  for (const f of files) {
    if (!isPolicyFile(f.path)) continue;
    const sentences = f.text.replace(/\r/g, "").split(/(?<=[.!?])\s+|\n\s*\n|\n(?=\s*[-*#>]|\s*\d+\.)/);
    for (const s of sentences) {
      const t = s.replace(/\s+/g, " ").trim();
      if (t.length < 6) continue;
      if (AI_TERM.test(t) && BAN_TERM.test(t)) return { file: f.path, excerpt: t.slice(0, 240) };
    }
  }
  return null;
}

export interface Hunk {
  removed: string[];
  added: string[];
}

/**
 * Hunks per file of a unified diff. Accepts a full `diff --git` patch, or (with `file`) the per-file
 * `patch` text the GitHub commits API returns. Lines are compared with trailing whitespace trimmed.
 */
export function parseHunks(diff: string, file?: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  let path: string | null = file ?? null;
  let cur: Hunk | null = null;
  const push = () => {
    if (cur && path && (cur.added.length || cur.removed.length)) {
      if (!out.has(path)) out.set(path, []);
      out.get(path)!.push(cur);
    }
    cur = null;
  };
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      push();
      const m = / b\/(.+)$/.exec(line);
      path = m ? m[1]! : null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") path = p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ") && !cur) continue;
    if (line.startsWith("@@")) {
      push();
      cur = { removed: [], added: [] };
      continue;
    }
    if (!cur) continue;
    const c: Hunk = cur;
    if (line.startsWith("+")) c.added.push(line.slice(1).trimEnd());
    else if (line.startsWith("-")) c.removed.push(line.slice(1).trimEnd());
  }
  push();
  return out;
}

const containsSeq = (hay: string[], needle: string[]) => {
  if (!needle.length) return true;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length && ok; j++) ok = hay[i + j] === needle[j];
    if (ok) return true;
  }
  return false;
};

/**
 * True when every hunk of the generation's patch appears in the upstream commit's diff: in the same
 * file, its removed lines as a contiguous run of removed lines and its added lines as a contiguous
 * run of added lines of one upstream hunk.
 */
export function hunksMatch(genPatch: string, upstreamFiles: { filename: string; patch?: string | null }[]): boolean {
  const mine = parseHunks(genPatch);
  if (!mine.size) return false;
  const theirs = new Map<string, Hunk[]>();
  for (const f of upstreamFiles) if (f.patch) for (const [p, hs] of parseHunks(f.patch, f.filename)) theirs.set(p, [...(theirs.get(p) ?? []), ...hs]);
  for (const [path, hunks] of mine) {
    const up = theirs.get(path);
    if (!up) return false;
    for (const h of hunks) if (!up.some((u) => containsSeq(u.removed, h.removed) && containsSeq(u.added, h.added))) return false;
  }
  return true;
}

/** "owner/repo" of a GitHub URL, or null. */
export function githubFullName(url: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(canonicalUrl(url));
  // "." and ".." are not GitHub names: in /repos/<full> they walked Core's (token-bearing) API calls
  // to other GitHub endpoints (audit A2, OFF-15)
  if (!m || /^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!)) return null;
  return `${m[1]}/${m[2]}`;
}

// -------------------------------------------------------------------------------------------------
// Registry

export interface OptInStatement {
  v: 1;
  kind: "lineage-upstream-optin";
  repo: string;
  maintainer: string;
  key: string;
  max_prs_per_week: number;
  kinds: string[] | null;
  contact: string | null;
  created_at: number;
}

interface RepoRow {
  repo_id: string;
  url: string;
  full_name: string;
  status: string;
  source: string | null;
  default_branch: string | null;
  max_prs_per_week: number | null;
  kinds: string | null;
  contact: string | null;
  ai_policy: string | null;
  signed: string | null;
  checked_at: number;
  scanned_at: number | null;
  detail: string | null;
}

interface PrRow {
  gen_id: string;
  repo_id: string;
  number: number;
  url: string;
  head: string | null;
  opened_by: string | null;
  state: string;
  opened_at: number;
  updated_at: number;
}

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  now(): number;
  tx<T>(fn: () => T): T;
  emitEvent(type: string, data: unknown): void;
  currentEpoch(): { n: number };
  addUnits(agent: string, kind: string, ref: string, units: number): void;
}

export interface UpstreamOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  githubApi: string;
  /** optional read token for the GitHub API rate limit (never logged, never returned) */
  githubToken: string | null;
  /** seconds between merge scans of one repository (TEST value) */
  scanS: number;
  /** seconds before an opt-in is re-read from GitHub during a scan (TEST value) */
  recheckS: number;
  /** commits read per repository per scan at most */
  maxCommits: number;
}

const WEEK_MS = 7 * 86_400_000;
const instances = new WeakMap<Core, Upstream>();
export function upstreamOf(core: Core): Upstream {
  let u = instances.get(core);
  if (!u) instances.set(core, (u = new Upstream(core)));
  return u;
}

export class Upstream {
  private readonly c: Internals;
  opts: UpstreamOptions;
  private inflight = 0;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.opts = {
      fetch: (u, i) => fetch(u, i),
      githubApi: "https://api.github.com",
      githubToken: process.env.LINEAGE_GITHUB_TOKEN || null,
      scanS: Number(process.env.LINEAGE_UPSTREAM_SCAN_S ?? 900),
      recheckS: Number(process.env.LINEAGE_UPSTREAM_RECHECK_S ?? 86_400),
      maxCommits: 100,
    };
    this.c.db.exec(UPSTREAM_SCHEMA);
  }

  configure(o: Partial<UpstreamOptions>) {
    this.opts = { ...this.opts, ...o };
    return this;
  }

  private async gh<T = any>(path: string, okMissing = true): Promise<T | null> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "lineage-core", "x-github-api-version": "2022-11-28" };
    if (this.opts.githubToken) headers.authorization = `Bearer ${this.opts.githubToken}`;
    const r = await this.opts.fetch(`${this.opts.githubApi}${path}`, { headers });
    if (r.status === 404 && okMissing) return null;
    if (r.status === 204) return {} as T;
    if (!r.ok) throw new Error(`GitHub GET ${path.split("?")[0]}: ${r.status}`);
    return (await r.json()) as T;
  }

  private async fileText(full: string, path: string, ref: string): Promise<string | null> {
    const f = await this.gh<any>(`/repos/${full}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (!f || Array.isArray(f) || f.type !== "file") return null;
    if (f.encoding === "base64") return Buffer.from(String(f.content).replace(/\n/g, ""), "base64").toString("utf8");
    return typeof f.content === "string" ? f.content : null;
  }

  private row(url: string): RepoRow | null {
    return this.c.db.query<RepoRow, [string]>("SELECT * FROM upstream_repos WHERE repo_id = ?").get(repoId(url));
  }

  private viewRow(r: RepoRow) {
    return {
      repo: r.url, full_name: r.full_name, status: r.status, source: r.source, default_branch: r.default_branch,
      max_prs_per_week: r.max_prs_per_week, kinds: r.kinds ? JSON.parse(r.kinds) : null, contact: r.contact,
      ai_policy: r.ai_policy ? JSON.parse(r.ai_policy) : null, signed: r.signed ? JSON.parse(r.signed) : null,
      checked_at: r.checked_at, scanned_at: r.scanned_at, detail: r.detail,
      prs_last_week: this.prsSince(r.repo_id, this.c.now() - WEEK_MS),
    };
  }

  private prsSince(rid: string, t: number): number {
    return this.c.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM upstream_prs WHERE repo_id = ? AND opened_at > ?").get(rid, t)!.n;
  }

  /** GET /v1/upstream/repo?url= */
  view(url: string | undefined) {
    if (!url) throw bad("bad_url", "url is required");
    const r = this.row(url);
    if (!r) throw notFound("upstream repository (not checked yet)");
    return this.viewRow(r);
  }

  /** GET /v1/upstream/repos */
  list(status?: string) {
    const rows = status
      ? this.c.db.query<RepoRow, [string]>("SELECT * FROM upstream_repos WHERE status = ? ORDER BY url").all(status)
      : this.c.db.query<RepoRow, []>("SELECT * FROM upstream_repos ORDER BY url").all();
    return rows.map((r) => this.viewRow(r));
  }

  /**
   * POST /v1/upstream/check { url }: reads the repository's opt-in and contribution policy from GitHub
   * and records the result. At most once a minute per repository.
   */
  async check(body: unknown) {
    const url = String((body as any)?.url ?? "");
    const full = githubFullName(url);
    if (!full) throw bad("bad_url", "a https://github.com/<owner>/<repo> URL is required");
    const canon = canonicalUrl(url);
    const prev = this.row(canon);
    if (prev && this.c.now() - prev.checked_at < 60_000) return this.viewRow(prev);
    return this.refresh(canon, full);
  }

  private async refresh(canon: string, full: string) {
    const prev = this.row(canon);
    const now = this.c.now();
    let status = "not_opted_in";
    let source: string | null = null;
    let detail: string | null = null;
    let cfg: OptInConfig | null = null;
    let ban: { file: string; excerpt: string } | null = null;
    let branch: string | null = null;
    const signed = prev?.signed ? JSON.parse(prev.signed) : null;
    try {
      const repo = await this.gh<any>(`/repos/${full}`);
      if (!repo) {
        status = "unreachable";
        detail = "repository not found";
      } else {
        branch = String(repo.default_branch ?? "main");
        const policy: { path: string; text: string }[] = [];
        let yml: string | null = null;
        for (const dir of ["", ".github", "docs"]) {
          const list = await this.gh<any[]>(`/repos/${full}/contents${dir ? `/${dir}` : ""}?ref=${encodeURIComponent(branch)}`);
          if (!Array.isArray(list)) continue;
          for (const e of list) {
            if (e.type !== "file") continue;
            if (!dir && e.name === ".lineage.yml") yml = await this.fileText(full, ".lineage.yml", branch);
            else if (isPolicyFile(e.path)) {
              const t = await this.fileText(full, e.path, branch);
              if (t !== null) policy.push({ path: e.path, text: t });
            }
          }
        }
        ban = detectAiBan(policy);
        if (yml !== null) cfg = parseLineageYml(yml);
        if (ban) {
          status = "ai_banned";
          detail = `contribution policy bans AI-generated changes (${ban.file})`;
        } else if (cfg?.opted_out) {
          status = "opted_out";
          detail = ".lineage.yml opts out";
        } else if (cfg?.opted_in) {
          status = "opted_in";
          source = "lineage_yml";
          if (cfg.errors.length) detail = cfg.errors.join("; ");
        } else if (signed) {
          status = "opted_in";
          source = "signed";
        } else {
          detail = cfg?.errors.length ? `.lineage.yml: ${cfg.errors.join("; ")}` : "no .lineage.yml on the default branch and no signed opt-in";
        }
      }
    } catch (e) {
      status = prev?.status ?? "unreachable";
      detail = `check failed: ${(e as Error).message}`;
    }
    const conf = source === "signed" ? { max_prs_per_week: signed.statement.max_prs_per_week, kinds: signed.statement.kinds, contact: signed.statement.contact } : cfg;
    this.c.tx(() => {
      this.c.db
        .query(
          `INSERT INTO upstream_repos (repo_id, url, full_name, status, source, default_branch, max_prs_per_week, kinds, contact, ai_policy, signed, checked_at, scanned_at, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET status = excluded.status, source = excluded.source, default_branch = excluded.default_branch,
             max_prs_per_week = excluded.max_prs_per_week, kinds = excluded.kinds, contact = excluded.contact, ai_policy = excluded.ai_policy,
             checked_at = excluded.checked_at, detail = excluded.detail`,
        )
        .run(
          repoId(canon), canon, full, status, source, branch, conf?.max_prs_per_week ?? null, conf?.kinds ? JSON.stringify(conf.kinds) : null, conf?.contact ?? null,
          ban ? JSON.stringify(ban) : null, prev?.signed ?? null, now, prev?.scanned_at ?? null, detail,
        );
      if (prev?.status !== status) this.c.emitEvent("upstream.status", { repo: canon, status, source, detail });
    });
    return this.viewRow(this.row(canon)!);
  }

  /** POST /v1/upstream/optin { statement, sig, gist_id }: a maintainer-signed opt-in (see the header). */
  async optIn(body: unknown) {
    const b = body as any;
    const st = b?.statement as OptInStatement;
    if (!st || st.v !== 1 || !isKind(st.kind, "upstream-optin") || typeof st.repo !== "string" || typeof st.maintainer !== "string" || typeof st.key !== "string")
      throw bad("bad_statement", "statement { v: 1, kind: lineage-upstream-optin, repo, maintainer, key, max_prs_per_week, kinds, contact, created_at } expected");
    if (!Number.isInteger(st.max_prs_per_week) || st.max_prs_per_week < 0 || st.max_prs_per_week > 100) throw bad("bad_statement", "max_prs_per_week must be an integer from 0 to 100");
    if (st.kinds !== null && (!Array.isArray(st.kinds) || !st.kinds.length || st.kinds.some((k) => !KINDS.includes(k)))) throw bad("bad_statement", `kinds must be null or a list of ${KINDS.join(", ")}`);
    if (Math.abs(this.c.now() / 1000 - Number(st.created_at)) > 86_400) throw bad("stale_statement", "created_at must be within a day of now");
    const full = githubFullName(st.repo);
    if (!full) throw bad("bad_url", "repo must be a https://github.com/<owner>/<repo> URL");
    if (!verifyStatement(st.key, String(b.sig ?? ""), "upstream", st)) throw forbidden("bad_signature", "the statement is not signed by its key (purpose upstream)");
    const gistId = String(b.gist_id ?? "");
    if (!/^[0-9a-f]{20,40}$/.test(gistId)) throw bad("bad_gist", "gist_id is required");
    const gist = await this.gh<any>(`/gists/${gistId}`);
    if (!gist) throw notFound("gist");
    if (String(gist.owner?.login ?? "").toLowerCase() !== st.maintainer.toLowerCase()) throw forbidden("wrong_owner", "the gist is not owned by the maintainer named in the statement");
    const proof = canonicalJson({ statement: st, sig: b.sig });
    const files = Object.values(gist.files ?? {}) as { content?: string }[];
    if (!files.some((f) => typeof f.content === "string" && f.content.includes(proof))) throw forbidden("proof_missing", "the gist does not contain the canonical { statement, sig }");
    const [owner] = full.split("/") as [string];
    if (owner.toLowerCase() !== st.maintainer.toLowerCase()) {
      const member = await this.gh<any>(`/orgs/${owner}/public_members/${st.maintainer}`);
      if (!member) throw forbidden("not_maintainer", "the maintainer neither owns the repository nor is a public member of its organisation");
    }
    const canon = canonicalUrl(st.repo);
    this.c.tx(() => {
      const r = this.row(canon);
      const signed = JSON.stringify({ statement: st, sig: b.sig, gist_id: gistId });
      if (r) this.c.db.query("UPDATE upstream_repos SET signed = ? WHERE repo_id = ?").run(signed, r.repo_id);
      else
        this.c.db
          .query("INSERT INTO upstream_repos (repo_id, url, full_name, status, checked_at, signed) VALUES (?, ?, ?, 'not_opted_in', 0, ?)")
          .run(repoId(canon), canon, full, signed);
    });
    // the policy check still applies: an AI ban blocks a signed opt-in too
    return this.refresh(canon, full);
  }

  // ---------------------------------------------------------------------------------------------
  // PR bot (eligibility and records)

  private gen(genId: string) {
    return this.c.db
      .query<{ gen_id: string; lineage_id: string; entry_type: string; kind: string | null; patch: string | null; author: string | null; accepted_at: number; reverted_by: string | null; repo_url: string }, [string]>(
        `SELECT g.gen_id, g.lineage_id, g.entry_type, g.kind, g.patch, g.author, g.accepted_at, g.reverted_by, r.url AS repo_url
           FROM generations g JOIN lineages l ON l.lineage_id = g.lineage_id JOIN repos r ON r.repo_id = l.repo_id WHERE g.gen_id = ?`,
      )
      .get(genId);
  }

  /** GET /v1/upstream/eligible/:gen: whether the PR bot may open the one PR of this generation. */
  eligible(genId: string) {
    const g = this.gen(genId);
    if (!g) throw notFound("generation");
    const r = this.row(g.repo_url);
    const out = (eligible: boolean, reason: string | null) => ({
      gen_id: genId, repo: g.repo_url, eligible, reason, status: r?.status ?? "unchecked", default_branch: r?.default_branch ?? null, author: g.author, kind: g.kind,
      pr: this.prOf(genId),
    });
    if (g.entry_type !== "patch") return out(false, "not_a_patch");
    if (g.reverted_by) return out(false, "reverted");
    if (this.prOf(genId)) return out(false, "pr_exists");
    if (!r) return out(false, "unchecked");
    if (r.status !== "opted_in") return out(false, r.status);
    if (r.kinds && g.kind && !(JSON.parse(r.kinds) as string[]).includes(g.kind)) return out(false, "kind_not_allowed");
    if (this.c.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM upstream_merges WHERE gen_id = ?").get(genId)!.n) return out(false, "already_merged");
    const cap = r.max_prs_per_week ?? DEFAULT_MAX_PRS_PER_WEEK;
    if (this.prsSince(r.repo_id, this.c.now() - WEEK_MS) >= cap) return out(false, "weekly_cap");
    return out(true, null);
  }

  private prOf(genId: string) {
    const p = this.c.db.query<PrRow, [string]>("SELECT * FROM upstream_prs WHERE gen_id = ?").get(genId);
    return p ? { number: p.number, url: p.url, state: p.state, head: p.head, opened_by: p.opened_by, opened_at: p.opened_at } : null;
  }

  /** GET /v1/upstream/prs?repo=&gen= */
  prs(q: { repo?: string; gen?: string }) {
    if (q.gen) {
      const p = this.prOf(q.gen);
      return p ? [{ gen_id: q.gen, ...p }] : [];
    }
    const rows = q.repo
      ? this.c.db.query<PrRow, [string]>("SELECT * FROM upstream_prs WHERE repo_id = ? ORDER BY opened_at").all(repoId(q.repo))
      : this.c.db.query<PrRow, []>("SELECT * FROM upstream_prs ORDER BY opened_at").all();
    return rows.map((p) => ({ gen_id: p.gen_id, number: p.number, url: p.url, state: p.state, head: p.head, opened_by: p.opened_by, opened_at: p.opened_at }));
  }

  /**
   * POST /v1/upstream/prs { gen_id, number } (runtime or admin key): records the PR the runtime opened.
   * Core checks it on GitHub: the PR is on the generation's repository and its body names the gen_id.
   */
  async recordPr(body: unknown) {
    const b = body as any;
    const genId = String(b?.gen_id ?? "");
    const number = Number(b?.number);
    if (!/^[0-9a-f]{64}$/.test(genId) || !Number.isInteger(number) || number < 1) throw bad("bad_body", "{ gen_id, number } expected");
    const e = this.eligible(genId);
    if (!e.eligible) throw conflict("not_eligible", `generation is not eligible for a PR: ${e.reason}`);
    const full = githubFullName(e.repo)!;
    const pr = await this.gh<any>(`/repos/${full}/pulls/${number}`);
    if (!pr) throw notFound("pull request");
    if (String(pr.base?.repo?.full_name ?? "").toLowerCase() !== full.toLowerCase()) throw forbidden("wrong_repo", "the PR is not on the generation's repository");
    if (!String(pr.body ?? "").includes(genId)) throw forbidden("wrong_pr", "the PR body does not name the generation");
    const now = this.c.now();
    return this.c.tx(() => {
      const again = this.eligible(genId);
      if (!again.eligible) throw conflict("not_eligible", `generation is not eligible for a PR: ${again.reason}`);
      this.c.db
        .query("INSERT INTO upstream_prs (gen_id, repo_id, number, url, head, opened_by, state, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(genId, repoId(e.repo), number, String(pr.html_url ?? ""), String(pr.head?.label ?? ""), String(pr.user?.login ?? ""), pr.merged ? "merged" : String(pr.state ?? "open"), now, now);
      this.c.emitEvent("upstream.pr_opened", { gen_id: genId, repo: e.repo, number, url: pr.html_url ?? null });
      return { gen_id: genId, ...this.prOf(genId)! };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Merge detection

  /** GET /v1/upstream/merges */
  merges() {
    return this.c.db
      .query<{ gen_id: string; repo_id: string; upstream_sha: string; detected_at: number; epoch: number; bonus: number; credited: string }, []>("SELECT * FROM upstream_merges ORDER BY detected_at")
      .all()
      .map((m) => ({ ...m, credited: JSON.parse(m.credited) }));
  }

  /**
   * Scans opted-in repositories (or one, by url) for merged generations: refreshes the opt-in when it
   * is older than `recheckS`, updates recorded PR states and credits `upstream_bonus` on a hunk match.
   */
  async scan(body?: unknown) {
    const url = (body as any)?.url ? canonicalUrl(String((body as any).url)) : null;
    const rows = url ? [this.row(url)].filter((r): r is RepoRow => !!r) : this.c.db.query<RepoRow, []>("SELECT * FROM upstream_repos WHERE status = 'opted_in'").all();
    const out: { repo: string; status: string; commits_read: number; merged: string[]; prs_updated: number; error: string | null }[] = [];
    for (let r of rows) {
      const res = { repo: r.url, status: r.status, commits_read: 0, merged: [] as string[], prs_updated: 0, error: null as string | null };
      out.push(res);
      try {
        if (this.c.now() - r.checked_at > this.opts.recheckS * 1000) {
          await this.refresh(r.url, r.full_name);
          r = this.row(r.url)!;
          res.status = r.status;
        }
        res.prs_updated = await this.refreshPrs(r);
        if (r.status === "opted_in") {
          const found = await this.scanRepo(r, res);
          res.merged = found;
        }
        this.c.tx(() => this.c.db.query("UPDATE upstream_repos SET scanned_at = ? WHERE repo_id = ?").run(this.c.now(), r.repo_id));
      } catch (e) {
        res.error = (e as Error).message;
      }
    }
    return { scanned: out };
  }

  private async refreshPrs(r: RepoRow): Promise<number> {
    let n = 0;
    for (const p of this.c.db.query<PrRow, [string]>("SELECT * FROM upstream_prs WHERE repo_id = ? AND state = 'open'").all(r.repo_id)) {
      const pr = await this.gh<any>(`/repos/${r.full_name}/pulls/${p.number}`);
      if (!pr) continue;
      const state = pr.merged || pr.merged_at ? "merged" : String(pr.state ?? "open");
      if (state !== p.state) {
        n++;
        this.c.tx(() => {
          this.c.db.query("UPDATE upstream_prs SET state = ?, updated_at = ? WHERE gen_id = ?").run(state, this.c.now(), p.gen_id);
          this.c.emitEvent("upstream.pr_state", { gen_id: p.gen_id, number: p.number, state });
        });
      }
    }
    return n;
  }

  private async scanRepo(r: RepoRow, res: { commits_read: number }): Promise<string[]> {
    const gens = this.c.db
      .query<{ gen_id: string; patch: string; accepted_at: number }, [string]>(
        `SELECT g.gen_id, g.patch, g.accepted_at FROM generations g JOIN lineages l ON l.lineage_id = g.lineage_id
          WHERE l.repo_id = ? AND g.entry_type = 'patch' AND g.reverted_by IS NULL AND g.patch IS NOT NULL
            AND g.gen_id NOT IN (SELECT gen_id FROM upstream_merges) ORDER BY g.accepted_at`,
      )
      .all(r.repo_id);
    if (!gens.length) return [];
    const since = new Date(gens[0]!.accepted_at - 60_000).toISOString();
    const branch = r.default_branch ?? "main";
    const list = (await this.gh<any[]>(`/repos/${r.full_name}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&per_page=${this.opts.maxCommits}`)) ?? [];
    const found: string[] = [];
    const pending = new Set(gens.map((g) => g.gen_id));
    // oldest first, so the first commit that carries a change is the one credited
    for (const c of [...list].reverse()) {
      if (!pending.size) break;
      const sha = String(c.sha);
      const seen = this.c.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM upstream_seen WHERE repo_id = ? AND sha = ?").get(r.repo_id, sha)!.n;
      if (seen) continue;
      const detail = await this.gh<any>(`/repos/${r.full_name}/commits/${sha}`);
      res.commits_read++;
      const files = (detail?.files ?? []) as { filename: string; patch?: string }[];
      for (const g of gens) {
        if (!pending.has(g.gen_id)) continue;
        if (hunksMatch(g.patch, files)) {
          pending.delete(g.gen_id);
          if (this.credit(r, g.gen_id, sha)) found.push(g.gen_id);
        }
      }
      // read once: a generation accepted later cannot have been merged by an earlier commit
      this.c.tx(() => this.c.db.query("INSERT OR IGNORE INTO upstream_seen (repo_id, sha) VALUES (?, ?)").run(r.repo_id, sha));
    }
    return found;
  }

  private credit(r: RepoRow, genId: string, sha: string): boolean {
    return this.c.tx(() => {
      if (this.c.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM upstream_merges WHERE gen_id = ?").get(genId)!.n) return false;
      const g = this.gen(genId)!;
      if (g.reverted_by) return false;
      const bonus = this.c.cfg.upstream_bonus;
      const shares = this.c.db
        .query<{ agent_id: string; u: number }, [string]>("SELECT agent_id, SUM(units) AS u FROM units WHERE ref = ? AND kind = 'author' AND voided = 0 GROUP BY agent_id ORDER BY MIN(id)")
        .all(genId)
        .filter((x) => x.u > 0);
      const total = shares.reduce((a, x) => a + x.u, 0);
      const parts: { agent: string; units: number }[] = total > 0 ? shares.map((x) => ({ agent: x.agent_id, units: (bonus * x.u) / total })) : g.author ? [{ agent: g.author, units: bonus }] : [];
      for (const p of parts) this.c.addUnits(p.agent, "upstream", genId, p.units);
      const epoch = this.c.currentEpoch().n;
      this.c.db
        .query("INSERT INTO upstream_merges (gen_id, repo_id, upstream_sha, detected_at, epoch, bonus, credited) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(genId, r.repo_id, sha, this.c.now(), epoch, bonus, JSON.stringify(parts));
      this.c.db.query("UPDATE upstream_prs SET state = 'merged', updated_at = ? WHERE gen_id = ?").run(this.c.now(), genId);
      this.c.emitEvent("upstream.merged", { gen_id: genId, repo: r.url, upstream_sha: sha, epoch, bonus, credited: parts });
      return true;
    });
  }

  /** Background scans from Core.tick(): one repository at a time, each at most every `scanS`. */
  tick() {
    if (this.inflight > 0) return;
    const due = this.c.db
      .query<RepoRow, [number]>("SELECT * FROM upstream_repos WHERE status = 'opted_in' AND (scanned_at IS NULL OR scanned_at < ?) ORDER BY scanned_at LIMIT 1")
      .get(this.c.now() - this.opts.scanS * 1000);
    if (!due) return;
    this.inflight++;
    void this.scan({ url: due.url })
      .catch((e) => console.error("upstream: scan failed", e))
      .finally(() => this.inflight--);
  }

  /** Resolves once a background scan started by tick() has finished (tests). */
  async idle() {
    while (this.inflight > 0) await Bun.sleep(5);
  }
}
