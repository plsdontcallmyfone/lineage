import type { Core } from "./core.ts";
import { ApiError } from "./errors.ts";
import { canonicalUrl, isKind, repoId, signKind, verifyStatement } from "./protocol.ts";
import { repoCheckOf } from "./repo-check.ts";

// "Request a repository" (docs/plans/OPEN-BOUNTIES.md 10): someone who wants a bounty on a repository
// with no unit asks for one. A request is a message the wallet signs (no transaction, no cost); Core
// stores the repository, the wallet, an optional note and an optional pledge in US dollars. A pledge
// is a statement of interest: nothing is escrowed and nothing is owed, and no view calls it money on
// offer. Whether a repository can be asked for is the launch form's own free reading
// (repo-check.ts): a repository with a unit needs no request, one agents cannot work on takes none.
// A request is ready, for every requester, as soon as an active unit exists on its repository.
//
// What makes the unit: the automatic unit setup of a hosted agent launched on the repository
// (SPEC 6.2), or, as an admin setting that is OFF by default, the network drafting units for the most
// requested repositories on the platform's budget. This module holds that setting, its limits per
// day and per repository in US dollars, the plan the limits allow and the record of what was spent;
// the runtime side that would run the drafter without a bound agent is not built.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repo_requests (
    repo TEXT PRIMARY KEY,               -- canonical https://github.com/owner/name (lower case)
    name TEXT NOT NULL,                  -- owner/name as first written
    class TEXT,                          -- the reading's class and language when it was asked for
    language TEXT,
    status TEXT NOT NULL,                -- open | ready
    created_at INTEGER NOT NULL,
    ready_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS repo_request_signers (
    repo TEXT NOT NULL,
    wallet TEXT NOT NULL,
    note TEXT,                           -- cleaned plain text, at most 280 characters
    pledge_usd REAL NOT NULL,            -- interest stated in US dollars; never escrowed
    created_at INTEGER NOT NULL,
    PRIMARY KEY (repo, wallet)
  );
  CREATE INDEX IF NOT EXISTS repo_request_signers_wallet ON repo_request_signers(wallet, created_at);
  CREATE TABLE IF NOT EXISTS repo_request_drafts (repo TEXT NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS repo_request_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export interface RepoRequestConfig {
  /** new requests one wallet may make in 24 hours */
  max_per_wallet_per_day: number;
  /** the network drafts units for the most requested repositories on the platform's budget */
  network_drafts: { enabled: boolean; min_requesters: number; per_repo_usd: number; per_day_usd: number; max_repos_per_day: number };
}
export const REPO_REQUEST_DEFAULTS: RepoRequestConfig = {
  max_per_wallet_per_day: 5,
  network_drafts: { enabled: false, min_requesters: 3, per_repo_usd: 4, per_day_usd: 10, max_repos_per_day: 2 },
};
export const REPO_REQUEST_LIMITS = { note: 280, pledge_usd: 100_000, statement_age_s: 600, listed: 200 };

export interface RepoRequestStatement { v: 1; kind: string; repo: string; wallet: string; note: string; pledge_usd: number; created_at: number }
/** The statement a requester's wallet signs. */
export function repoRequestStatement(repo: string, wallet: string, note: string, pledgeUsd: number, createdAt: number): RepoRequestStatement {
  return { v: 1, kind: signKind("repo-request"), repo: canonicalUrl(repo), wallet, note, pledge_usd: pledgeUsd, created_at: Math.floor(createdAt) };
}

interface Internals { db: Core["db"]; now(): number }
const bad = (code: string, message: string) => new ApiError(400, code, message);
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GITHUB = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})$/;
/** Plain text for a note: no control characters, no markup characters, one line, at most 280 characters. */
export function cleanNote(v: unknown): string {
  let out = "";
  for (const ch of typeof v === "string" ? v : "") {
    const c = ch.codePointAt(0)!;
    // control characters, zero-width and direction marks, line and paragraph separators: a space
    const hidden = c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff;
    if (hidden) out += " ";
    else if (ch !== "<" && ch !== ">" && ch !== "`") out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, REPO_REQUEST_LIMITS.note);
}
const cents = (n: number) => Math.round(n * 100) / 100;

const instances = new WeakMap<Core, RepoRequests>();
export function repoRequestsOf(core: Core): RepoRequests {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new RepoRequests(core)));
  return s;
}

type CheckView =
  | { state: "has_units"; units: number }
  | { state: "can_measure"; class: string; language: string; tests: number }
  | { state: "cannot"; reason: string }
  | { state: "checking" }
  | { state: "unreadable"; reason: string };

export class RepoRequests {
  private readonly c: Internals;
  constructor(private readonly core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  // ---------------------------------------------------------------------------------------------
  // settings

  config(): RepoRequestConfig {
    const row = this.c.db.query<{ v: string }, []>("SELECT v FROM repo_request_kv WHERE k = 'config'").get();
    let saved: Partial<RepoRequestConfig> = {};
    try {
      saved = row ? (JSON.parse(row.v) as Partial<RepoRequestConfig>) : {};
    } catch { /* defaults */ }
    return { max_per_wallet_per_day: saved.max_per_wallet_per_day ?? REPO_REQUEST_DEFAULTS.max_per_wallet_per_day, network_drafts: { ...REPO_REQUEST_DEFAULTS.network_drafts, ...(saved.network_drafts ?? {}) } };
  }
  /** POST /v1/admin/repo-requests/config: any of the settings; what is left out keeps its value. */
  setConfig(body: unknown) {
    const b = (body ?? {}) as { max_per_wallet_per_day?: unknown; network_drafts?: Record<string, unknown> };
    const cur = this.config();
    const whole = (v: unknown, lo: number, hi: number, name: string) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw bad("bad_config", `${name} must be a whole number from ${lo} to ${hi}`);
      return v;
    };
    const usd = (v: unknown, hi: number, name: string) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > hi) throw bad("bad_config", `${name} must be US dollars from 0 to ${hi}`);
      return cents(v);
    };
    const n = b.network_drafts ?? {};
    if (typeof n !== "object" || Array.isArray(n)) throw bad("bad_config", "network_drafts must be an object");
    for (const k of Object.keys(n)) if (!(k in cur.network_drafts)) throw bad("bad_config", `network_drafts.${k} is not a setting`);
    if (n.enabled !== undefined && typeof n.enabled !== "boolean") throw bad("bad_config", "network_drafts.enabled must be true or false");
    const next: RepoRequestConfig = {
      max_per_wallet_per_day: b.max_per_wallet_per_day === undefined ? cur.max_per_wallet_per_day : whole(b.max_per_wallet_per_day, 1, 100, "max_per_wallet_per_day"),
      network_drafts: {
        enabled: n.enabled === undefined ? cur.network_drafts.enabled : (n.enabled as boolean),
        min_requesters: n.min_requesters === undefined ? cur.network_drafts.min_requesters : whole(n.min_requesters, 1, 1000, "network_drafts.min_requesters"),
        per_repo_usd: n.per_repo_usd === undefined ? cur.network_drafts.per_repo_usd : usd(n.per_repo_usd, 50, "network_drafts.per_repo_usd"),
        per_day_usd: n.per_day_usd === undefined ? cur.network_drafts.per_day_usd : usd(n.per_day_usd, 500, "network_drafts.per_day_usd"),
        max_repos_per_day: n.max_repos_per_day === undefined ? cur.network_drafts.max_repos_per_day : whole(n.max_repos_per_day, 1, 50, "network_drafts.max_repos_per_day"),
      },
    };
    this.c.db.query("INSERT INTO repo_request_kv (k, v) VALUES ('config', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(next));
    return this.config();
  }

  // ---------------------------------------------------------------------------------------------
  // the check and a request

  private parse(raw: unknown): { repo: string; name: string } {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 200) throw bad("bad_repo", "repo: a GitHub repository address");
    const t = raw.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
    const url = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(t) ? `https://github.com/${t}` : t;
    let repo: string;
    try {
      repo = canonicalUrl(url);
    } catch {
      throw bad("bad_repo", "repo: a GitHub repository address");
    }
    const m = GITHUB.exec(repo);
    if (!m) throw bad("bad_repo", "repo: a GitHub repository address, https://github.com/owner/name");
    return { repo, name: url.replace(/^https?:\/\/github\.com\//i, "") };
  }
  private units(repo: string): number {
    return this.c.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM lineages WHERE repo_id = ? AND status = 'active'").get(repoId(repo))?.n ?? 0;
  }
  /** A request whose repository now has an active unit is ready: its requesters are told and it takes no more. */
  private sweep() {
    const now = this.c.now();
    for (const r of this.c.db.query<{ repo: string }, []>("SELECT repo FROM repo_requests WHERE status = 'open'").all())
      if (this.units(r.repo) > 0) this.c.db.query("UPDATE repo_requests SET status = 'ready', ready_at = ? WHERE repo = ? AND status = 'open'").run(now, r.repo);
  }
  private async reading(repo: string): Promise<CheckView> {
    const r = await repoCheckOf(this.core).check(repo);
    if (r.state === "ready") return { state: "has_units", units: r.units };
    if (r.state === "can_set_up") return { state: "can_measure", class: r.class, language: r.language, tests: r.tests };
    if (r.state === "cannot") return { state: "cannot", reason: r.reason };
    if (r.state === "checking") return { state: "checking" };
    return { state: "unreadable", reason: r.why };
  }
  private summary(repo: string, wallet?: string | null) {
    const q = this.c.db.query<{ status: string; created_at: number; ready_at: number | null }, [string]>("SELECT status, created_at, ready_at FROM repo_requests WHERE repo = ?").get(repo);
    if (!q) return null;
    const agg = this.c.db.query<{ n: number; usd: number | null }, [string]>("SELECT COUNT(*) AS n, SUM(pledge_usd) AS usd FROM repo_request_signers WHERE repo = ?").get(repo)!;
    const mine = wallet ? !!this.c.db.query("SELECT 1 FROM repo_request_signers WHERE repo = ? AND wallet = ?").get(repo, wallet) : false;
    return { state: q.status as "open" | "ready", requesters: agg.n, interest_usd: cents(agg.usd ?? 0), created_at: q.created_at, ready_at: q.ready_at, mine };
  }

  /** GET /v1/repo-requests/check?repo=&wallet=: what the form shows before it takes anything. */
  async check(raw: string | undefined, wallet?: string) {
    const { repo, name } = this.parse(raw);
    this.sweep();
    return { repo, name, ...(await this.reading(repo)), request: this.summary(repo, wallet && ADDRESS.test(wallet) ? wallet : null) };
  }

  /** POST /v1/repo-requests { statement, sig }: a request, or one more wallet behind an open one. */
  async create(body: unknown) {
    const b = (body ?? {}) as { statement?: unknown; sig?: unknown };
    const s = b.statement as RepoRequestStatement | undefined;
    if (!s || typeof s !== "object" || s.v !== 1 || !isKind(s.kind, "repo-request") || s.kind !== signKind("repo-request")) throw bad("bad_statement", "not a units-repo-request statement");
    if (typeof s.wallet !== "string" || !ADDRESS.test(s.wallet)) throw bad("bad_statement", "wallet must be a Solana address");
    const { repo, name } = this.parse(s.repo);
    if (s.repo !== repo) throw bad("bad_statement", "repo must be the repository's address in lower case, https://github.com/owner/name");
    if (typeof s.note !== "string" || s.note.length > 1000) throw bad("bad_statement", "note must be text");
    if (typeof s.pledge_usd !== "number" || !Number.isFinite(s.pledge_usd) || s.pledge_usd < 0 || s.pledge_usd > REPO_REQUEST_LIMITS.pledge_usd) throw bad("bad_statement", `pledge_usd must be US dollars from 0 to ${REPO_REQUEST_LIMITS.pledge_usd}`);
    const nowS = this.c.now() / 1000;
    if (typeof s.created_at !== "number" || !Number.isFinite(s.created_at) || s.created_at > nowS + 300 || s.created_at < nowS - REPO_REQUEST_LIMITS.statement_age_s) throw bad("bad_statement", "the statement is too old; sign it again");
    let ok = false;
    try {
      ok = typeof b.sig === "string" && verifyStatement(s.wallet, b.sig, "repo-request", s);
    } catch {
      ok = false;
    }
    if (!ok) throw new ApiError(403, "bad_signature", "the wallet's signature does not verify");
    this.sweep();
    if (this.c.db.query("SELECT 1 FROM repo_request_signers WHERE repo = ? AND wallet = ?").get(repo, s.wallet)) throw new ApiError(409, "already_requested", "this wallet has already asked for this repository");
    const day = this.c.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM repo_request_signers WHERE wallet = ? AND created_at > ?").get(s.wallet, this.c.now() - 86_400_000)!.n;
    if (day >= this.config().max_per_wallet_per_day) throw new ApiError(429, "too_many_requests", "this wallet has asked for as many repositories as one wallet may in a day");
    const have = this.c.db.query<{ status: string }, [string]>("SELECT status FROM repo_requests WHERE repo = ?").get(repo);
    if (have?.status === "ready" || this.units(repo) > 0) throw new ApiError(409, "has_units", "this repository can already be measured: post a bounty on it");
    let cls: string | null = null, language: string | null = null;
    if (!have) {
      // a new repository is asked for only when the free reading says agents can work on it
      const r = await this.reading(repo);
      if (r.state === "has_units") throw new ApiError(409, "has_units", "this repository can already be measured: post a bounty on it");
      if (r.state === "cannot") throw new ApiError(422, "cannot_measure", `agents cannot work on this repository: ${r.reason}`);
      if (r.state === "checking") throw new ApiError(409, "checking", "the repository is still being read; send the request again in a few seconds");
      if (r.state === "unreadable") throw new ApiError(422, "unreadable", `the repository could not be read: ${r.reason}`);
      cls = r.class;
      language = r.language;
    }
    const now = this.c.now();
    this.c.db.query("INSERT OR IGNORE INTO repo_requests (repo, name, class, language, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)").run(repo, name, cls, language, now);
    this.c.db.query("INSERT INTO repo_request_signers (repo, wallet, note, pledge_usd, created_at) VALUES (?, ?, ?, ?, ?)").run(repo, s.wallet, cleanNote(s.note) || null, cents(s.pledge_usd), now);
    return { repo, name, request: this.summary(repo, s.wallet)! };
  }

  /**
   * GET /v1/repo-requests[?wallet=]: open requests by number of requesters, then by stated interest, then the ones
   * that became ready in the last 30 days. `mine`: the given wallet is one of the requesters.
   */
  list(wallet?: string) {
    this.sweep();
    const w = wallet && ADDRESS.test(wallet) ? wallet : null;
    const rows = this.c.db.query<{ repo: string; name: string; class: string | null; language: string | null; status: string; created_at: number; ready_at: number | null; n: number; usd: number | null }, [number]>(
      `SELECT r.repo, r.name, r.class, r.language, r.status, r.created_at, r.ready_at, COUNT(s.wallet) AS n, SUM(s.pledge_usd) AS usd FROM repo_requests r JOIN repo_request_signers s ON s.repo = r.repo
       WHERE r.status = 'open' OR r.ready_at > ? GROUP BY r.repo ORDER BY (r.status = 'open') DESC, n DESC, usd DESC, r.created_at ASC LIMIT ${REPO_REQUEST_LIMITS.listed}`).all(this.c.now() - 30 * 86_400_000);
    const requests = rows.map((r) => ({
      repo: r.repo, name: r.name, state: r.status as "open" | "ready", requesters: r.n, interest_usd: cents(r.usd ?? 0), class: r.class, language: r.language, created_at: r.created_at, ready_at: r.ready_at,
      notes: this.c.db.query<{ note: string; pledge_usd: number; created_at: number }, [string]>("SELECT note, pledge_usd, created_at FROM repo_request_signers WHERE repo = ? AND note IS NOT NULL ORDER BY created_at DESC LIMIT 3").all(r.repo),
      mine: w ? !!this.c.db.query("SELECT 1 FROM repo_request_signers WHERE repo = ? AND wallet = ?").get(r.repo, w) : false,
    }));
    return { requests, network_drafts: this.config().network_drafts.enabled, limits: { note: REPO_REQUEST_LIMITS.note, pledge_usd: REPO_REQUEST_LIMITS.pledge_usd, per_wallet_per_day: this.config().max_per_wallet_per_day } };
  }

  // ---------------------------------------------------------------------------------------------
  // the network drafting units on the platform's budget (off by default; the runtime side is not built)

  private spent(repo: string | null, since: number): number {
    const row = repo === null ? this.c.db.query<{ usd: number | null }, [number]>("SELECT SUM(usd) AS usd FROM repo_request_drafts WHERE at > ?").get(since)
      : this.c.db.query<{ usd: number | null }, [string, number]>("SELECT SUM(usd) AS usd FROM repo_request_drafts WHERE repo = ? AND at > ?").get(repo, since);
    return row?.usd ?? 0;
  }
  private dayStart(): number {
    return Math.floor(this.c.now() / 86_400_000) * 86_400_000; // the UTC day
  }
  /** GET /v1/repo-requests/draft-plan (runtime): the repositories the limits allow a draft for now, most requested first, each with what may still be spent on it. */
  draftPlan() {
    const cfg = this.config().network_drafts;
    this.sweep();
    if (!cfg.enabled) return { enabled: false, day_left_usd: 0, repos: [] as { repo: string; name: string; requesters: number; budget_usd: number }[] };
    const day = this.dayStart();
    let left = cents(Math.max(0, cfg.per_day_usd - this.spent(null, day - 1)));
    const today = new Set(this.c.db.query<{ repo: string }, [number]>("SELECT DISTINCT repo FROM repo_request_drafts WHERE at > ?").all(day - 1).map((r) => r.repo));
    const out: { repo: string; name: string; requesters: number; budget_usd: number }[] = [];
    for (const r of this.list().requests) {
      if (r.state !== "open" || r.requesters < cfg.min_requesters) continue;
      if (!today.has(r.repo) && today.size + out.filter((x) => !today.has(x.repo)).length >= cfg.max_repos_per_day) continue;
      const budget = cents(Math.min(left, cfg.per_repo_usd - this.spent(r.repo, 0)));
      if (budget <= 0) continue;
      out.push({ repo: r.repo, name: r.name, requesters: r.requesters, budget_usd: budget });
    }
    return { enabled: true, day_left_usd: left, repos: out };
  }
  /** POST /v1/repo-requests/drafts { repo, usd } (runtime): records what a draft cost; refused past any limit, so the caller asks before it spends. */
  recordDraft(body: unknown) {
    const b = (body ?? {}) as { repo?: unknown; usd?: unknown };
    const { repo } = this.parse(b.repo);
    if (typeof b.usd !== "number" || !Number.isFinite(b.usd) || b.usd <= 0) throw bad("bad_usd", "usd must be a positive number of US dollars");
    const allowed = this.draftPlan().repos.find((r) => r.repo === repo);
    if (!allowed) throw new ApiError(409, "not_planned", "the limits allow no draft for this repository now");
    if (b.usd > allowed.budget_usd + 1e-9) throw new ApiError(409, "over_budget", `at most ${allowed.budget_usd} US dollars may be spent on this repository now`);
    this.c.db.query("INSERT INTO repo_request_drafts (repo, usd, at) VALUES (?, ?, ?)").run(repo, cents(b.usd), this.c.now());
    return { repo, spent_usd: cents(this.spent(repo, 0)), day_spent_usd: cents(this.spent(null, this.dayStart() - 1)) };
  }
}
