import type { Config } from "./config.ts";
import { repoSayable } from "./parse.ts";
import { X_MAX, xLength } from "./replies.ts";
import type { NoticeRecord, State, Store } from "./state.ts";
import { RefreshRefused } from "./tokens.ts";
import { XError, type XApi } from "./x.ts";

// The maintainer notice (docs/plans/TWEET-LAUNCH.md 10; owner 2026-10-13 "Unclaimed fees waiting for
// you"): when the fees waiting for a repository's owners first cross a threshold, ONE original post
// says so and links the repository's page. OFF by default behind its own setting (`notify_unclaimed`:
// "off", "dry", "on"), apart from `enabled` and from the launch replies' limits.
//
// It is an original post, not a reply: X lets the account reply only to people who mentioned it. A
// post that names someone who did not ask is the kind X's automation rules call unsolicited, so every
// default here is conservative: one post per repository per step (the threshold, then each multiple by
// `notify_step_factor`, each at most once, for good), a small cap a day, a handle only when GitHub's
// own profile field of the repository's owner gives one, and never for a repository whose README or
// CONTRIBUTING asks for no bots or no unsolicited contact. What was decided is written to the state
// file before anything is posted, so a restart or a crash never repeats a post.
//
// "dry" composes exactly what "on" would post, writes it to the log and to the state file (its own
// record, which never counts as a post) and posts nothing. "on" posts only in a run with --send;
// without --send it reports what it would do and writes nothing.

export interface NoticeAction {
  kind: "notice" | "notice_dry" | "notice_skip";
  repo: string;
  why: string;
  text?: string;
  posted?: boolean;
  post_id?: string | null;
}
export interface NoticeReport {
  mode: "off" | "dry" | "on";
  send: boolean;
  halted: string | null;
  repositories: number;
  actions: NoticeAction[];
}
export interface NoticeDeps {
  x: Pick<XApi, "post">;
  store: Store;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

const DAY = 24 * 3_600_000;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** A dollar amount as the pages write it: "$1,235", "$530.96", "$0.024". */
export function usdWords(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 12 })}`;
}

/** The post, word for word (owner 2026-10-13). The handle is named once, at the start, only when there is one. */
export const noticeText = (handle: string | null, usd: number, repo: string, url: string) =>
  `${handle ? `@${handle} ` : ""}${usdWords(usd)} is waiting for the owners of ${repo}. Fees from agents working on it, claimable by anyone with admin on the repository: ${url}`;

/** The step an amount has reached: 0 at the threshold, 1 at threshold x factor, and so on; -1 below the threshold. */
export function stepOf(usd: number, threshold: number, factor: number): number {
  let k = -1;
  for (let t = threshold; usd >= t && k < 40; t *= factor) k++;
  return k;
}

/** A line that asks for no bots, no automated messages or no unsolicited contact. A short list on purpose: when in doubt the repository is left alone. */
const NO_CONTACT = [
  /\b(no|not|never|don'?t|do not|please do not|please don'?t)\b[^.\n]{0,60}\b(bots?\b|automated (messages?|mentions?|contact|posts?|outreach|pull requests?|prs?)|unsolicited|solicit|spam|advertis|promot)/i,
  /\b(bots?|automated (messages?|mentions?|contact|posts?|outreach)|unsolicited (messages?|contact|mentions?|pull requests?|prs?))\b[^.\n]{0,40}\b(not (welcome|allowed|accepted|wanted)|unwelcome|will be (blocked|banned|closed|reported|ignored)|are (blocked|banned))/i,
];
export function asksForNoContact(text: string): string | null {
  for (const line of text.split(/\r?\n/)) for (const re of NO_CONTACT) if (re.test(line)) return line.trim().slice(0, 160);
  return null;
}

const gh = (cfg: Config, f: typeof fetch, path: string, raw = false) =>
  f(`${cfg.github_api}${path}`, { signal: AbortSignal.timeout(20_000), headers: { accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json", "user-agent": "units-tweet-launch" } });

/** The line of the repository's README or CONTRIBUTING that asks for no such contact, or null. Throws when GitHub cannot say now (the repository is then left for a later run). */
export async function contactPolicy(cfg: Config, f: typeof fetch, repo: string): Promise<string | null> {
  for (const path of [`/repos/${repo}/readme`, `/repos/${repo}/contents/CONTRIBUTING.md`, `/repos/${repo}/contents/.github/CONTRIBUTING.md`]) {
    const r = await gh(cfg, f, path, true);
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`GitHub API HTTP ${r.status} reading ${path}`);
    const hit = asksForNoContact((await r.text()).slice(0, 400_000));
    if (hit) return hit;
  }
  return null;
}

/** The X handle GitHub's own profile of the repository's owner lists (`twitter_username`, a user or an organisation), or null. Never from anywhere else. */
export async function ownerHandle(cfg: Config, f: typeof fetch, owner: string): Promise<string | null> {
  const r = await gh(cfg, f, `/users/${owner}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub API HTTP ${r.status} reading the owner's profile`);
  const j = (await r.json().catch(() => null)) as { twitter_username?: unknown; type?: unknown } | null;
  const h = typeof j?.twitter_username === "string" ? j.twitter_username.replace(/^@/, "") : "";
  return (j?.type === "User" || j?.type === "Organization") && HANDLE.test(h) ? h : null;
}

interface Row { github_id: string; repo: string; usd: number }

/** Core's public list (GET <core_url>/fee-claims/waiting): repositories with a dollar figure waiting, largest first. Null when Core does not serve it. */
async function waiting(cfg: Config, f: typeof fetch): Promise<Row[] | null> {
  const r = await f(`${cfg.core_url}/fee-claims/waiting`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = (await r.json().catch(() => null)) as { repositories?: unknown } | null;
  if (!Array.isArray(j?.repositories)) return null;
  const rows: Row[] = [];
  for (const x of j.repositories as { github_id?: unknown; repository?: { full_name?: unknown }; waiting?: unknown; waiting_usd?: unknown }[]) {
    const name = x?.repository?.full_name;
    if (typeof x?.github_id !== "string" || !/^[1-9]\d{0,18}$/.test(x.github_id) || typeof name !== "string" || !REPO.test(name)) continue;
    // a dollar figure Core did not serve is never worked out here
    if (typeof x.waiting_usd !== "number" || !Number.isFinite(x.waiting_usd) || x.waiting_usd <= 0 || !/^[1-9]\d*$/.test(String(x.waiting))) continue;
    rows.push({ github_id: x.github_id, repo: name, usd: x.waiting_usd });
  }
  return rows.sort((a, b) => b.usd - a.usd);
}

const reached = (bucket: Record<string, NoticeRecord> | undefined, k: number) => Object.keys(bucket ?? {}).some((s) => Number(s) >= k);
const inDay = (s: State, bucket: "steps" | "dry", now: number) => Object.values(s.notices ?? {}).reduce((n, r) => n + Object.values(r[bucket] ?? {}).filter((x) => now - x.at < DAY).length, 0);

export async function runNotices(cfg: Config, d: NoticeDeps, o: { send: boolean }): Promise<NoticeReport> {
  const report: NoticeReport = { mode: cfg.notify_unclaimed, send: o.send, halted: null, repositories: 0, actions: [] };
  if (cfg.notify_unclaimed === "off") return report;
  const stopped = d.store.stopped();
  if (stopped) return { ...report, halted: `STOP file: ${stopped}` };
  const s = d.store.load();
  if (s.backoff_until && d.now() < s.backoff_until) return { ...report, halted: `X asked to wait until ${new Date(s.backoff_until).toISOString()}` };
  // "on" posts only with --send; without it this is a look at what it would do, and nothing is written
  const live = cfg.notify_unclaimed === "on" && o.send;
  const bucket = live ? "steps" : "dry";
  const keep = live || cfg.notify_unclaimed === "dry";
  const save = () => (keep ? d.store.save(s) : undefined);
  const rows = await waiting(cfg, d.fetch);
  if (!rows) return { ...report, halted: "Core did not serve the list of fees waiting (GET /fee-claims/waiting)" };
  report.repositories = rows.length;
  s.notices ??= {};
  let lastPost = 0;
  try {
    for (const row of rows) {
      const k = stepOf(row.usd, cfg.notify_threshold_usd, cfg.notify_step_factor);
      if (k < 0) continue;
      const rec = (s.notices[row.github_id] ??= { repo: row.repo, steps: {}, dry: {} });
      rec.repo = row.repo;
      // a step is used once, for good: a real post also covers every smaller step, and a dry record never stands in for a post
      if (reached(rec.steps, k) || (!live && reached(rec.dry, k))) continue;
      const skip = (why: string) => void report.actions.push({ kind: "notice_skip", repo: row.repo, why });
      // a repository that asked for no such contact is not read again for 30 days
      if (rec.skipped && d.now() - rec.skipped.at < 30 * DAY) continue;
      if (inDay(s, bucket, d.now()) >= cfg.notify_per_day) {
        skip(`the cap of ${cfg.notify_per_day} a day is reached: left for a later run`);
        break;
      }
      const [owner, name] = row.repo.split("/") as [string, string];
      if (!repoSayable({ owner, name })) {
        skip("the repository's name is not one the bot posts");
        continue;
      }
      let handle: string | null, policy: string | null;
      try {
        policy = await contactPolicy(cfg, d.fetch, row.repo);
        handle = policy ? null : await ownerHandle(cfg, d.fetch, owner);
      } catch (e) {
        skip(`GitHub could not be read (${(e as Error).message}): left for a later run`);
        continue;
      }
      if (policy) {
        // remembered, so the repository is not read again on every run; looked at again after 30 days
        rec.skipped = { at: d.now(), why: policy };
        d.log(`no notice for ${row.repo}: its README or CONTRIBUTING asks for no such contact ("${policy}")`);
        skip(`its README or CONTRIBUTING asks for no such contact: "${policy}"`);
        save();
        continue;
      }
      delete rec.skipped;
      const text = noticeText(handle, row.usd, row.repo, `${cfg.app_url}/claim/${row.repo}`);
      if (xLength(text) > X_MAX) {
        skip(`the post would be longer than ${X_MAX} characters as X counts it`);
        continue;
      }
      const entry: NoticeRecord = { at: d.now(), usd: row.usd, text, handle, post_id: null };
      // written down before anything goes out: a crash here means no post, never two
      rec[bucket] = { ...rec[bucket], [String(k)]: entry };
      save();
      if (!live) {
        d.log(`would post (step ${k}, ${usdWords(cfg.notify_threshold_usd * cfg.notify_step_factor ** k)}):\n${text.replace(/^/gm, "    ")}`);
        report.actions.push({ kind: "notice_dry", repo: row.repo, why: `step ${k}`, text });
        continue;
      }
      const action: NoticeAction = { kind: "notice", repo: row.repo, why: `step ${k}`, text, posted: false, post_id: null };
      report.actions.push(action);
      const wait = lastPost + cfg.min_seconds_between_posts * 1000 - d.now();
      if (lastPost && wait > 0) await d.sleep(wait);
      try {
        const r = await d.x.post(text);
        lastPost = d.now();
        entry.post_id = action.post_id = r.id;
        action.posted = true;
        save();
      } catch (e) {
        if (e instanceof XError && e.status === 403 && /duplicate/i.test(e.detail ?? "")) {
          d.log(`X refused the notice for ${row.repo} as duplicate content: not posted, not tried again`);
          continue;
        }
        if (e instanceof XError && (e.status === 401 || e.status === 403)) {
          d.store.stop(`X refused a post with HTTP ${e.status}${e.detail ? ` (${e.detail})` : ""}; delete this file to resume`);
          report.halted = `X refused a post with HTTP ${e.status}: the service stopped itself (STOP file written)`;
          break;
        }
        if (e instanceof XError && e.status === 429) {
          s.backoff_until = e.resetAt ?? d.now() + 15 * 60_000;
          report.halted = `X rate limit on posting: waiting until ${new Date(s.backoff_until).toISOString()}`;
          break;
        }
        throw e;
      }
    }
  } catch (e) {
    if (!(e instanceof RefreshRefused)) {
      save();
      throw e;
    }
    d.store.stop(`${e.message}; put new tokens in the credentials file, then delete this file`);
    report.halted = `${e.message}: the service stopped itself (STOP file written)`;
  }
  save();
  return report;
}
