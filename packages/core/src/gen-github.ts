import type { Core } from "./core.ts";
import { bad, notFound } from "./errors.ts";
import { brandNeutralTrailers } from "./protocol.ts";

// Generations on GitHub (docs/plans/GENERATIONS-ON-GITHUB.md 3). The identity cycle publishes every
// accepted generation as a signed commit and reports it here; Core reads the commit from the GitHub
// API itself, accepts it only when its trailers name this generation (and its patch_hash), and keeps
// GitHub's own signature verification. Generations of app-identity agents without a configured
// publisher are recorded as "awaiting publisher". Only accepted generations exist in the generations
// table, so nothing sealed can be recorded or published.

export const GEN_GITHUB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS gen_github (
    gen_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,                -- published | awaiting publisher | removed
    repo TEXT,
    branch TEXT,
    sha TEXT,
    url TEXT,
    verified INTEGER,
    verification_reason TEXT,
    identity TEXT,
    login TEXT,
    published_at INTEGER,
    checked_at INTEGER NOT NULL
  );
`;

export const AWAITING = "awaiting publisher";
/** A recorded commit whose repository was deleted on purpose (docs/plans/GITHUB-ORG.md 6): the page explains, never links. */
export const REMOVED = "removed";

interface Row {
  gen_id: string;
  status: string;
  reason?: string | null;
  repo: string | null;
  branch: string | null;
  sha: string | null;
  url: string | null;
  verified: number | null;
  verification_reason: string | null;
  identity: string | null;
  login: string | null;
  published_at: number | null;
  checked_at: number;
}

interface GenInfo {
  gen_id: string;
  lineage_id: string;
  height: number;
  entry_type: string;
  patch_hash: string | null;
  author: string | null;
  accepted_at: number;
  repo_url: string;
}

interface Internals {
  db: Core["db"];
  now(): number;
  tx<T>(fn: () => T): T;
  emitEvent(type: string, data: unknown): void;
}

export interface GenGithubOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  githubApi: string;
  /** optional read token for the GitHub API rate limit (never logged, never returned) */
  githubToken: string | null;
}

export type GithubField =
  | { url: string; commit: string; verified: boolean; published_at: number; repo: string; branch: string | null; verification_reason: string | null; identity: string | null; login: string | null }
  | { status: "awaiting publisher" | "pending" }
  | { status: "removed"; reason: string; removed_at: number; repo: string | null; former_commit: string | null }
  | null;

const GEN = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;

/** `Key: value` trailers of the message's last paragraph. */
export function trailersOf(message: string): Record<string, string> {
  const paras = message.replace(/\r/g, "").trimEnd().split(/\n\s*\n/);
  const out: Record<string, string> = {};
  for (const line of (paras[paras.length - 1] ?? "").split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line.trim());
    if (m && !(m[1]! in out)) out[m[1]!] = m[2]!.trim();
  }
  return brandNeutralTrailers(out);
}

const isGithubRepo = (url: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?\/?$/.test(url);

const instances = new WeakMap<Core, GenGithub>();
export function genGithubOf(core: Core): GenGithub {
  let g = instances.get(core);
  if (!g) instances.set(core, (g = new GenGithub(core)));
  return g;
}

export class GenGithub {
  private readonly c: Internals;
  opts: GenGithubOptions;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.opts = { fetch: (u, i) => fetch(u, i), githubApi: "https://api.github.com", githubToken: (process.env.UNITS_GITHUB_TOKEN ?? process.env.LINEAGE_GITHUB_TOKEN) || null };
    this.c.db.exec(GEN_GITHUB_SCHEMA);
    // the reason of a removed record (added 2026-10-11; older databases gain the column here)
    const cols = this.c.db.query<{ name: string }, []>("PRAGMA table_info(gen_github)").all();
    if (!cols.some((x) => x.name === "reason")) this.c.db.exec("ALTER TABLE gen_github ADD COLUMN reason TEXT");
  }

  configure(o: Partial<GenGithubOptions>) {
    this.opts = { ...this.opts, ...o };
    return this;
  }

  private gen(id: string): GenInfo | null {
    return this.c.db
      .query<GenInfo, [string]>(
        `SELECT g.gen_id, g.lineage_id, g.height, g.entry_type, g.patch_hash, g.author, g.accepted_at, r.url AS repo_url
         FROM generations g JOIN lineages l ON l.lineage_id = g.lineage_id JOIN repos r ON r.repo_id = l.repo_id WHERE g.gen_id = ?`,
      )
      .get(id);
  }

  private row(id: string): Row | null {
    return this.c.db.query<Row, [string]>("SELECT * FROM gen_github WHERE gen_id = ?").get(id);
  }

  private field(g: GenInfo, r: Row | null): GithubField {
    if (g.entry_type === "genesis" || !isGithubRepo(g.repo_url)) return null;
    if (r?.status === "published" && r.sha && r.repo) {
      return {
        url: r.url || `https://github.com/${r.repo}/commit/${r.sha}`, commit: r.sha, verified: r.verified === 1, published_at: r.published_at ?? r.checked_at,
        repo: r.repo, branch: r.branch, verification_reason: r.verification_reason, identity: r.identity, login: r.login,
      };
    }
    if (r?.status === REMOVED) return { status: REMOVED, reason: r.reason ?? "repository deleted", removed_at: r.checked_at, repo: r.repo, former_commit: r.sha };
    return { status: r?.status === AWAITING ? AWAITING : "pending" };
  }

  /** The `github` field of GET /v1/generations/:id. */
  view(genId: string): GithubField {
    const g = this.gen(genId);
    return g ? this.field(g, this.row(genId)) : null;
  }

  /** GET /v1/github/generations?agent=&lineage= : generations with their github field, newest first. */
  list(q: { agent?: string | null; lineage?: string | null; limit?: number }) {
    if (!q.agent && !q.lineage) throw bad("bad_query", "agent= or lineage= is required");
    const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
    const where: string[] = ["g.entry_type != 'genesis'"];
    const args: string[] = [];
    if (q.agent) (where.push("g.author = ?"), args.push(q.agent));
    if (q.lineage) (where.push("g.lineage_id = ?"), args.push(q.lineage));
    const rows = this.c.db
      .query<GenInfo & { kind: string | null; recipe: string | null }, string[]>(
        `SELECT g.gen_id, g.lineage_id, g.height, g.entry_type, g.patch_hash, g.author, g.accepted_at, g.kind, r.url AS repo_url, rc.name AS recipe
         FROM generations g JOIN lineages l ON l.lineage_id = g.lineage_id JOIN repos r ON r.repo_id = l.repo_id
         LEFT JOIN recipes rc ON rc.recipe_id = l.recipe_id
         WHERE ${where.join(" AND ")} ORDER BY g.accepted_at DESC LIMIT ${limit}`,
      )
      .all(...args);
    return {
      generations: rows.map((g) => ({
        gen_id: g.gen_id, lineage_id: g.lineage_id, recipe: g.recipe, repo: g.repo_url, height: g.height, entry_type: g.entry_type, kind: g.kind, author: g.author,
        accepted_at: g.accepted_at, github: this.field(g, this.row(g.gen_id)),
      })),
    };
  }

  private async commit(repo: string, sha: string): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "lineage-core", "x-github-api-version": "2022-11-28" };
    if (this.opts.githubToken) headers.authorization = `Bearer ${this.opts.githubToken}`;
    const r = await this.opts.fetch(`${this.opts.githubApi}/repos/${repo}/commits/${sha}`, { headers });
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { status: r.status, body };
  }

  /** Checks one published record against GitHub; returns the stored row values or a refusal reason. */
  private async check(g: GenInfo, rec: any): Promise<{ ok: true; url: string; verified: boolean; reason: string | null } | { ok: false; result: string; detail: string }> {
    const repo = String(rec.repo ?? "");
    const sha = String(rec.sha ?? "");
    if (!REPO.test(repo) || !SHA.test(sha)) return { ok: false, result: "refused", detail: "repo must be owner/name and sha 40 hex" };
    const r = await this.commit(repo, sha);
    if (r.status === 403 || r.status === 429) return { ok: false, result: "retry", detail: `GitHub answered ${r.status} (rate limit); send it again later` };
    if (r.status === 404 || r.status === 422) return { ok: false, result: "refused", detail: "GitHub has no such commit in that repository" };
    if (r.status !== 200 || !r.body?.commit) return { ok: false, result: "retry", detail: `GitHub answered ${r.status}` };
    const t = trailersOf(String(r.body.commit.message ?? ""));
    if (t["Lineage-Generation"] !== g.gen_id) return { ok: false, result: "refused", detail: "the commit's Lineage-Generation trailer does not name this generation" };
    if (t["Lineage-Lineage"] !== g.lineage_id) return { ok: false, result: "refused", detail: "the commit's Lineage-Lineage trailer does not match" };
    if (t["Lineage-Height"] !== String(g.height)) return { ok: false, result: "refused", detail: "the commit's Lineage-Height trailer does not match" };
    if (g.entry_type === "patch" && t["Lineage-Patch-Sha256"] !== g.patch_hash) return { ok: false, result: "refused", detail: "the commit's Lineage-Patch-Sha256 trailer is not Core's patch_hash" };
    const v = r.body.commit.verification ?? {};
    return { ok: true, url: String(r.body.html_url || `https://github.com/${repo}/commit/${sha}`), verified: v.verified === true, reason: v.reason ? String(v.reason) : null };
  }

  /**
   * POST /v1/github/generations { records } (runtime or admin key). Each record is
   * { gen_id, repo, branch, sha, identity?, login? } or { gen_id, status: "awaiting publisher" }.
   * Answers one result per record: recorded | unchanged | refused | retry, with a detail.
   */
  async record(body: unknown) {
    if ((body as any)?.removed !== undefined) return this.removed((body as any).removed);
    const recs = (body as any)?.records;
    if (!Array.isArray(recs) || recs.length > 200) throw bad("bad_body", "{ records: [...] } of at most 200 expected");
    const out: { gen_id: string; result: string; detail: string | null; github: GithubField }[] = [];
    for (const rec of recs) {
      const genId = String(rec?.gen_id ?? "");
      if (!GEN.test(genId)) {
        out.push({ gen_id: genId.slice(0, 64), result: "refused", detail: "gen_id must be 64 hex", github: null });
        continue;
      }
      const g = this.gen(genId);
      if (!g) {
        out.push({ gen_id: genId, result: "refused", detail: "no accepted generation with this id", github: null });
        continue;
      }
      if (g.entry_type === "genesis" || !isGithubRepo(g.repo_url)) {
        out.push({ gen_id: genId, result: "refused", detail: "gen 0 and non-GitHub lineages have no mirror commit", github: null });
        continue;
      }
      const prev = this.row(genId);
      const now = this.c.now();
      if (rec.status === AWAITING) {
        if (prev?.status === "published" || prev?.status === REMOVED) {
          out.push({ gen_id: genId, result: "unchanged", detail: prev.status === REMOVED ? "removed" : "already published", github: this.field(g, prev) });
          continue;
        }
        this.c.tx(() =>
          this.c.db
            .query("INSERT INTO gen_github (gen_id, status, checked_at) VALUES (?, ?, ?) ON CONFLICT(gen_id) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at")
            .run(genId, AWAITING, now),
        );
        out.push({ gen_id: genId, result: prev?.status === AWAITING ? "unchanged" : "recorded", detail: null, github: this.view(genId) });
        continue;
      }
      if (prev?.status === "published" && prev.sha === rec.sha && prev.repo === rec.repo && prev.verified === 1) {
        out.push({ gen_id: genId, result: "unchanged", detail: null, github: this.field(g, prev) });
        continue;
      }
      const branch = rec.branch == null ? null : String(rec.branch);
      if (branch !== null && !BRANCH.test(branch)) {
        out.push({ gen_id: genId, result: "refused", detail: "bad branch name", github: this.field(g, prev) });
        continue;
      }
      let c;
      try {
        c = await this.check(g, rec);
      } catch (e) {
        c = { ok: false as const, result: "retry", detail: `GitHub unreachable: ${(e as Error).message.slice(0, 120)}` };
      }
      if (!c.ok) {
        out.push({ gen_id: genId, result: c.result, detail: c.detail, github: this.field(g, prev) });
        continue;
      }
      const identity = rec.identity === "account" || rec.identity === "app" ? rec.identity : null;
      const login = typeof rec.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(rec.login) ? rec.login : String(rec.repo).split("/")[0]!;
      const publishedAt = prev?.status === "published" && prev.sha === rec.sha ? (prev.published_at ?? now) : now;
      this.c.tx(() =>
        this.c.db
          .query(
            `INSERT INTO gen_github (gen_id, status, repo, branch, sha, url, verified, verification_reason, identity, login, published_at, checked_at)
             VALUES (?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(gen_id) DO UPDATE SET status = 'published', repo = excluded.repo, branch = excluded.branch, sha = excluded.sha, url = excluded.url,
               verified = excluded.verified, verification_reason = excluded.verification_reason, identity = excluded.identity, login = excluded.login,
               published_at = excluded.published_at, checked_at = excluded.checked_at, reason = NULL`,
          )
          .run(genId, rec.repo, branch, rec.sha, c.url, c.verified ? 1 : 0, c.reason, identity, login, publishedAt, now),
      );
      this.c.emitEvent("generation.github", { gen_id: genId, lineage_id: g.lineage_id, sha: rec.sha, verified: c.verified });
      out.push({ gen_id: genId, result: "recorded", detail: c.verified ? null : `GitHub reports the signature as ${c.reason ?? "unverified"}`, github: this.view(genId) });
    }
    return { results: out };
  }

  /**
   * { removed: { repos: [owner/name, ...], reason } } on POST /v1/github/generations (same key): every
   * published record whose repository is one of `repos` becomes status "removed" with the reason, so
   * no page links to a commit that no longer exists (docs/plans/GITHUB-ORG.md 6). The former repo and
   * sha stay in the row. A later published record (the commit pushed again somewhere) replaces it.
   */
  removed(b: unknown) {
    const repos = (b as any)?.repos;
    const reason = String((b as any)?.reason ?? "").trim();
    if (!Array.isArray(repos) || !repos.length || repos.length > 200 || !repos.every((r) => typeof r === "string" && REPO.test(r))) throw bad("bad_body", "removed.repos: 1 to 200 owner/name strings");
    if (!reason || reason.length > 200) throw bad("bad_body", "removed.reason: 1 to 200 characters");
    const now = this.c.now();
    const lowered = repos.map((r: string) => r.toLowerCase());
    const marks = `(${lowered.map(() => "?").join(",")})`;
    const ids = this.c.db
      .query<{ gen_id: string; lineage_id: string }, string[]>(`SELECT gg.gen_id, g.lineage_id FROM gen_github gg JOIN generations g ON g.gen_id = gg.gen_id WHERE gg.status = 'published' AND lower(gg.repo) IN ${marks}`)
      .all(...lowered);
    this.c.tx(() => {
      const q = this.c.db.query("UPDATE gen_github SET status = ?, reason = ?, verified = NULL, checked_at = ? WHERE gen_id = ?");
      for (const x of ids) q.run(REMOVED, reason, now, x.gen_id);
    });
    for (const x of ids) this.c.emitEvent("generation.github", { gen_id: x.gen_id, lineage_id: x.lineage_id, removed: true });
    return { removed: ids.map((x) => x.gen_id), reason };
  }

  /** For tests and the generation route: throws when the generation does not exist. */
  must(genId: string) {
    const g = this.gen(genId);
    if (!g) throw notFound("generation");
    return this.field(g, this.row(genId));
  }
}
