import { randomBytes } from "node:crypto";
import { signRequest, type AgentKey } from "../../protocol/src/index.ts";
import type { Config } from "./config.ts";
import { checkRepo, type ReadRepo } from "./github.ts";
import { limited, prune, record } from "./limits.ts";
import { parseCommand, repoKey, repoLabel, repoSayable, resolveRepo, type Mention } from "./parse.ts";
import { followUpReply, linkReply, NO_REPO, NOT_PUBLIC, noTestsReply, X_MAX, xLength } from "./replies.ts";
import { textSafety } from "../../souls/src/safety.ts";
import { trim, type Request, type State, type Store } from "./state.ts";
import { RefreshRefused } from "./tokens.ts";
import { XError, type XApi } from "./x.ts";

// One pass of the bot (docs/plans/TWEET-LAUNCH.md 6): mentions since the last id, one answer each at
// most, then every open link against Core and the follow-up for a launch that landed. With `send`
// false it is a dry run: it reads, decides and reports what it would post; nothing is posted and the
// state file is not written.

export interface Action {
  kind: "reply" | "follow_up" | "skip" | "stop_listed" | "expired" | "mismatch";
  mention_id: string;
  /** what was decided: link, no_repo, not_public, no_unit, duplicate, or why nothing is said */
  why: string;
  in_reply_to?: string;
  text?: string;
  /** true once X returned the post's id */
  posted?: boolean;
  post_id?: string | null;
}

export interface Report {
  send: boolean;
  /** why this run did nothing, or null */
  halted: string | null;
  account: string | null;
  mentions: number;
  actions: Action[];
  open_requests: number;
}

export interface Deps {
  x: XApi;
  store: Store;
  fetch: typeof fetch;
  readRepo: ReadRepo;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  newRef?: () => string;
  /** the key that signs which tweet a link answers (config core_key_file); none: nothing is registered */
  coreKey?: AgentKey | null;
}

export const newRef = () => randomBytes(16).toString("base64url");
const HOUR = 3_600_000;

/** The launch page's address for a request: the repository, the optional coin fields and the opaque id. Nothing about the author or the tweet. */
export function launchLink(appUrl: string, repo: string, ref: string, f: { name: string | null; ticker: string | null; vibe: string | null }): string {
  const q = new URLSearchParams({ repo });
  if (f.name) q.set("name", f.name);
  if (f.ticker) q.set("ticker", f.ticker);
  if (f.vibe) q.set("vibe", f.vibe);
  q.set("tl", ref);
  return `${appUrl}/launch?${q.toString().replace(/%2F/g, "/")}`;
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Tells Core which tweet a link answers (POST <core_url>/tweet-links, signed with the bot's key): the tweet that asked, its
 * author, the author of the post it replied to when that is someone else, and the repository. Core serves it to the launch page
 * and to the agent's pages. False when there is no key, X gave no handle, or Core did not take it; the link works either way.
 */
export async function registerLink(cfg: Config, d: Pick<Deps, "fetch" | "now" | "log" | "coreKey">, r: Request): Promise<boolean> {
  if (!d.coreKey || !r.handle || !HANDLE.test(r.handle) || !/^[1-9][0-9]{0,19}$/.test(r.mention_id)) return false;
  const url = new URL(`${cfg.core_url}/tweet-links`);
  const body = JSON.stringify({ ref: r.ref, repo: r.repo, tweet_id: r.mention_id, handle: r.handle, under_handle: r.under_handle && HANDLE.test(r.under_handle) ? r.under_handle : null, hours: cfg.link_hours });
  const nonce = `${d.now()}-${randomBytes(6).toString("hex")}`;
  try {
    const res = await d.fetch(url, {
      method: "POST", signal: AbortSignal.timeout(20_000), body,
      headers: { "content-type": "application/json", "x-lineage-agent": d.coreKey.id, "x-lineage-nonce": nonce, "x-lineage-sig": signRequest(d.coreKey, "POST", url.pathname, body, nonce) },
    });
    if (!res.ok) d.log(`Core did not register the tweet of a link (HTTP ${res.status}): the link is given without it`);
    return res.ok;
  } catch (e) {
    d.log(`Core could not be told the tweet of a link (${(e as Error).message}): the link is given without it`);
    return false;
  }
}

const canon = (repo: string) => repo.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();

class Halt extends Error {}

export async function runOnce(cfg: Config, d: Deps, o: { send: boolean }): Promise<Report> {
  const report: Report = { send: o.send, halted: null, account: null, mentions: 0, actions: [], open_requests: 0 };
  const stopped = d.store.stopped();
  if (stopped) return { ...report, halted: `STOP file: ${stopped}` };
  if (o.send && !cfg.enabled) return { ...report, halted: 'the config says "enabled": false' };
  const s = d.store.load();
  const save = () => (o.send ? d.store.save(s) : undefined);
  if (s.backoff_until && d.now() < s.backoff_until) return { ...report, halted: `X asked to wait until ${new Date(s.backoff_until).toISOString()}` };
  s.backoff_until = null;
  prune(s, d.now());
  trim(s, d.now(), cfg.read_cache_hours * HOUR);
  let lastPost = 0;

  /** Posts one text, or in a dry run only reports it. The caller has already written down that this mention is handled. */
  const post = async (a: Action, author: string | null): Promise<string | null> => {
    report.actions.push(a);
    if (xLength(a.text!) > X_MAX) throw new Error(`a reply is longer than ${X_MAX} characters as X counts it`);
    if (!o.send) return null;
    const wait = lastPost + cfg.min_seconds_between_posts * 1000 - d.now();
    if (lastPost && wait > 0) await d.sleep(wait);
    try {
      const r = await d.x.reply(a.in_reply_to!, a.text!);
      lastPost = d.now();
      record(s, author, lastPost);
      a.posted = true;
      a.post_id = r.id;
      return r.id;
    } catch (e) {
      a.posted = false;
      // X refuses a text it has already posted; the fixed refusal sentences can repeat. That mention stays unanswered, the service goes on
      if (e instanceof XError && e.status === 403 && /duplicate/i.test(e.detail ?? "")) {
        d.log(`X refused a reply to ${a.in_reply_to} as duplicate content: not answered`);
        return null;
      }
      if (e instanceof XError && (e.status === 401 || e.status === 403)) {
        d.store.stop(`X refused a post with HTTP ${e.status}${e.detail ? ` (${e.detail})` : ""}; delete this file to resume`);
        throw new Halt(`X refused a post with HTTP ${e.status}: the service stopped itself (STOP file written)`);
      }
      if (e instanceof XError && e.status === 429) {
        s.backoff_until = e.resetAt ?? d.now() + 15 * 60_000;
        throw new Halt(`X rate limit on posting: waiting until ${new Date(s.backoff_until).toISOString()}`);
      }
      throw e;
    }
  };

  const decide = async (m: Mention): Promise<void> => {
    const done = (did: string, why = did): void => {
      s.answered[m.id] = { at: d.now(), did };
      report.actions.push({ kind: "skip", mention_id: m.id, why });
    };
    if (m.author_id === s.me!.id) return done("own_post");
    if (m.refs.some((r) => r.type === "retweeted")) return done("retweet");
    const cmd = parseCommand(m.text, cfg.handle);
    if (cmd.kind === "stop") {
      s.stopped[m.author_id] = d.now();
      s.answered[m.id] = { at: d.now(), did: "stop" };
      report.actions.push({ kind: "stop_listed", mention_id: m.id, why: "the author asked not to be answered" });
      return;
    }
    if (cmd.kind === "none") return done("no_command");
    if (s.stopped[m.author_id]) return done("author_stopped");
    const age = m.created_at ? d.now() - Date.parse(m.created_at) : 0;
    if (age > cfg.max_mention_age_hours * HOUR) return done("too_old");

    // what to say
    let why = "link";
    let text: string;
    let req: Request | null = null;
    const found = resolveRepo(m);
    if (!found) {
      why = "no_repo";
      text = NO_REPO;
    } else {
      const gh = await checkRepo(cfg.github_api, found.owner, found.name, d.fetch);
      const label = gh.state === "public" ? gh.full_name : repoLabel(found);
      const key = label.toLowerCase();
      if (!repoSayable({ owner: label.split("/")[0]!, name: label.split("/")[1]! })) return done("repo_name_refused");
      const dup = Object.values(s.requests).find((r) => r.status === "open" && r.author_id === m.author_id && r.repo.toLowerCase() === key);
      if (gh.state === "missing") {
        why = "not_public";
        text = NOT_PUBLIC;
      } else if (dup) {
        // the same person asking again for the same repository: no reply at all (owner, 2026-10-12)
        return done("duplicate");
      } else {
        let impossible: string | null = null;
        if (cfg.read_repos && gh.state === "public" && gh.size_kb <= cfg.read_max_kb) {
          const cached = s.readings[key];
          if (cached) impossible = cached.impossible;
          else {
            try {
              impossible = await d.readRepo(`https://github.com/${label}`);
              s.readings[key] = { at: d.now(), impossible };
            } catch (e) {
              d.log(`reading ${label} failed (${(e as Error).message}): the link is given without it`);
            }
          }
        }
        // only "no tests" has a wording; any other reason a unit cannot exist is not answered, so nobody is sent to pay for a launch that cannot work
        if (impossible && !/^it has no tests\b/.test(impossible)) return done("no_unit", `no unit can exist (${impossible.slice(0, 80)}): no reply`);
        if (impossible) {
          why = "no_tests";
          text = noTestsReply(label);
        } else {
          const ref = (d.newRef ?? newRef)();
          req = { ref, mention_id: m.id, author_id: m.author_id, repo: label, handle: m.username, under_handle: m.replied_to && m.replied_to.author_id !== m.author_id ? m.replied_to.username : null, created_at: d.now(), reply_id: null, status: "open", outcome: null, agent: null, mint: null, follow_up_id: null };
          text = linkReply(m.username, label, launchLink(cfg.app_url, label, ref, cmd));
        }
      }
    }

    const over = limited(s, cfg, m.author_id, d.now());
    if (over) return done("limited", `limit ${over}: no reply`);
    // written down before the post goes out: a crash here means no answer, never two
    s.answered[m.id] = { at: d.now(), did: why, reply_id: null };
    if (req) s.requests[req.ref] = req;
    save();
    // Core hears which tweet the link answers before anyone can open it; never in a dry run
    if (req && o.send) req.registered = await registerLink(cfg, d, req);
    const id = await post({ kind: "reply", mention_id: m.id, why, in_reply_to: m.id, text }, m.author_id);
    s.answered[m.id]!.reply_id = id;
    if (req) req.reply_id = id;
    save();
  };

  try {
    s.me ??= await d.x.me();
    report.account = s.me.username;
    if (s.me.username.toLowerCase() !== cfg.handle.toLowerCase()) throw new Halt(`these credentials belong to @${s.me.username}, the config says @${cfg.handle}`);
    const got = await d.x.mentions(s.me.id, s.since_id);
    s.dialect = got.dialect;
    report.mentions = got.mentions.length;
    for (const m of got.mentions) {
      if (!s.answered[m.id]) await decide(m);
      s.since_id = m.id;
      save();
    }

    // launches that landed
    for (const r of Object.values(s.requests)) {
      if (r.status !== "open") continue;
      if (d.now() - r.created_at > cfg.link_hours * HOUR) {
        r.status = "done";
        r.outcome = "expired";
        report.actions.push({ kind: "expired", mention_id: r.mention_id, why: `no launch within ${cfg.link_hours} hours` });
        continue;
      }
      // a link that was never posted (dry run, or the post failed) has nothing to follow up
      if (!r.reply_id && o.send) continue;
      const res = await d.fetch(`${cfg.core_url}/tweet-launches/${r.ref}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } }).catch(() => null);
      if (!res || !res.ok) continue;
      const c = (await res.json().catch(() => null)) as { agent?: unknown; mint?: unknown; repo?: unknown; launched_at?: unknown } | null;
      if (!c || typeof c.agent !== "string" || typeof c.mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.agent)) continue;
      r.agent = c.agent;
      r.mint = c.mint;
      // the launch must be on the asked repository and registered after the link was made
      if (typeof c.repo !== "string" || canon(c.repo) !== r.repo.toLowerCase() || typeof c.launched_at !== "number" || c.launched_at < r.created_at) {
        r.status = "done";
        r.outcome = "mismatch";
        report.actions.push({ kind: "mismatch", mention_id: r.mention_id, why: "the launch handed in for this link is on another repository or older than the link" });
        continue;
      }
      const target = cfg.follow_up === "own_reply" ? r.reply_id : cfg.follow_up === "mention" ? r.mention_id : null;
      if (!target) {
        r.status = "done";
        r.outcome = "launched";
        continue;
      }
      if (limited(s, cfg, null, d.now())) continue; // over a limit: tried again on the next run
      // the coin's name as the market lists it; until it is listed the follow-up waits, and a name the safety list refuses is never posted
      const tok = await d.fetch(`${cfg.market_url}/tokens/${r.mint}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } }).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { name?: unknown; token?: { name?: unknown } } | null;
      const name = typeof tok?.name === "string" ? tok.name.trim() : typeof tok?.token?.name === "string" ? tok.token.name.trim() : "";
      if (!name) continue;
      if (textSafety(name).length || /[@\n\r]|https?:/i.test(name)) {
        r.status = "done";
        r.outcome = "launched";
        report.actions.push({ kind: "skip", mention_id: r.mention_id, why: "launched; the coin's name is not one the bot posts: no follow-up" });
        continue;
      }
      r.status = "following";
      save();
      try {
        r.follow_up_id = await post({ kind: "follow_up", mention_id: r.mention_id, why: "launched", in_reply_to: target, text: followUpReply(name, r.repo, `${cfg.app_url}/tokens/${r.mint}`) }, null);
        r.status = "done";
        r.outcome = "followed";
      } catch (e) {
        r.status = "done";
        r.outcome = "follow_up_failed";
        throw e;
      } finally {
        if (!o.send) {
          r.status = "open";
          r.outcome = null;
        }
      }
    }
  } catch (e) {
    if (e instanceof RefreshRefused) {
      d.store.stop(`${e.message}; put new tokens in the credentials file, then delete this file`);
      report.halted = `${e.message}: the service stopped itself (STOP file written)`;
    } else if (e instanceof Halt) report.halted = e.message;
    else if (e instanceof XError && (e.status === 401 || e.status === 403)) {
      // credentials X no longer takes: stop here instead of asking again on every run
      d.store.stop(`${e.message}; fix the credentials or the app's permissions, then delete this file`);
      report.halted = `${e.message}: the service stopped itself (STOP file written)`;
    }
    else if (e instanceof XError && e.status === 429) {
      s.backoff_until = e.resetAt ?? d.now() + 15 * 60_000;
      report.halted = `X rate limit on reading: waiting until ${new Date(s.backoff_until).toISOString()}`;
    } else {
      save();
      throw e;
    }
  }
  report.open_requests = Object.values(s.requests).filter((r) => r.status === "open").length;
  save();
  return report;
}
