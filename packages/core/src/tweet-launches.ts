import { onPurge } from "./purge.ts";
import type { Core } from "./core.ts";
import { ApiError, bad, conflict, forbidden } from "./errors.ts";

// Launch from a tweet (docs/plans/TWEET-LAUNCH.md 4): the link the reply bot posts carries an opaque
// single-use id. The launch page hands that id back here once the launch it sent has landed, with the
// agent and the coin it created; the bot (packages/tweet-launch) reads the row and answers in the
// thread with the agent's page. Nothing here launches, signs or pays anything.
//
// The write needs no key because it can only name a launch that already exists: the agent must be a
// launched agent Core has read from the chain, with that coin. So the table holds at most one row per
// real launch, and a row costs whoever writes it a launch. The id is used once (the first launch
// handed in keeps it) and a launch answers one id. The bot still checks the repository and the time
// of the launch against its own request before it posts.
//
// Where a launch started (owner 2026-10-13): the bot also tells Core, in a request signed with its own
// key, which tweet each link answers (the tweet that asked, its author, the author of the tweet it
// replied to, the repository). Only a key Core was started with (UNITS_TWEET_LAUNCH_KEYS, or the admin
// key) may write that, so "started from a tweet" is never something a visitor, a link or a launch page
// can make up. One public read serves it and nothing else: the launch page resolves a link's id while the link
// is open.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tweet_launches (
  ref TEXT PRIMARY KEY,          -- the opaque id of the link (22 base64url characters, 128 random bits)
  agent TEXT NOT NULL UNIQUE,    -- the launched agent
  mint TEXT NOT NULL,            -- its coin
  claimed_at INTEGER NOT NULL    -- ms
);
CREATE TABLE IF NOT EXISTS tweet_links (
  ref TEXT PRIMARY KEY,          -- the same opaque id
  repo TEXT NOT NULL,            -- owner/name, lower case
  tweet_id TEXT NOT NULL,        -- the tweet that asked for the launch
  handle TEXT NOT NULL,          -- its author, without @
  under_handle TEXT,             -- the author of the tweet it replied to, when that is another account
  created_at INTEGER NOT NULL,   -- ms
  expires_at INTEGER NOT NULL    -- ms: the link is open until then
);`;

export const TWEET_REF = /^[A-Za-z0-9_-]{22}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID = /^[1-9][0-9]{0,19}$/;
const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/;
/** How long a link stays open when the bot names no time, and the longest it may ask for. */
export const LINK_HOURS = 72;
export const LINK_HOURS_MAX = 24 * 90;
const HOUR = 3_600_000;

/** owner/name in lower case, from a repository URL or owner/name. */
export const repoKey = (repo: string) => repo.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
/** The address of a tweet: https://x.com/<handle>/status/<id>. */
export const tweetUrl = (handle: string, id: string) => `https://x.com/${handle}/status/${id}`;

/** What the public may read about the tweet a link answers: the tweet, who wrote it, whose tweet it was under, the repository. */
export interface TweetOrigin {
  repo: string;
  handle: string;
  tweet_url: string;
  under_handle: string | null;
}

interface Internals {
  db: Core["db"];
  adminId: string;
  now(): number;
}

interface Link {
  ref: string;
  repo: string;
  tweet_id: string;
  handle: string;
  under_handle: string | null;
  created_at: number;
  expires_at: number;
}

interface Row {
  ref: string;
  agent: string;
  mint: string;
  claimed_at: number;
}

const instances = new WeakMap<Core, TweetLaunches>();
onPurge((core) => instances.delete(core));
export function tweetLaunchesOf(core: Core): TweetLaunches {
  let t = instances.get(core);
  if (!t) instances.set(core, (t = new TweetLaunches(core)));
  return t;
}

export class TweetLaunches {
  private readonly c: Internals;
  /** the keys that may say which tweet a link answers (the reply bot's), besides the admin key */
  writers: Set<string>;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
    this.writers = new Set((process.env.UNITS_TWEET_LAUNCH_KEYS ?? "").split(",").map((k) => k.trim()).filter((k) => B58.test(k)));
  }

  private origin(l: Link): TweetOrigin {
    return { repo: l.repo, handle: l.handle, tweet_url: tweetUrl(l.handle, l.tweet_id), under_handle: l.under_handle };
  }

  /**
   * POST /v1/tweet-links { ref, repo, tweet_id, handle, under_handle?, hours? }, signed by the reply bot's key (or the admin
   * key): the tweet a link answers. Written once per id; the same statement again is answered the same.
   */
  register(signer: string | null, body: unknown) {
    if (!signer || (signer !== this.c.adminId && !this.writers.has(signer))) throw forbidden("not_tweet_bot", "only the reply bot's key may register a launch link");
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const ref = typeof b.ref === "string" ? b.ref : "";
    const repo = typeof b.repo === "string" ? repoKey(b.repo) : "";
    const tweet_id = typeof b.tweet_id === "string" ? b.tweet_id : "";
    const handle = typeof b.handle === "string" ? b.handle : "";
    const under = b.under_handle === undefined || b.under_handle === null ? null : typeof b.under_handle === "string" ? b.under_handle : "";
    const hours = b.hours === undefined ? LINK_HOURS : b.hours;
    if (!TWEET_REF.test(ref)) throw bad("bad_ref", "ref is the 22 character id of a launch link");
    if (!REPO.test(repo)) throw bad("bad_repo", "repo is owner/name on GitHub");
    if (!TWEET_ID.test(tweet_id) || !HANDLE.test(handle) || (under !== null && !HANDLE.test(under))) throw bad("bad_tweet", "tweet_id is a tweet's id; handle and under_handle are X handles without @");
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > LINK_HOURS_MAX) throw bad("bad_hours", `hours is a whole number from 1 to ${LINK_HOURS_MAX}`);
    // the author of the tweet above is named only when it is someone else
    const under_handle = under !== null && under.toLowerCase() !== handle.toLowerCase() ? under : null;
    const have = this.c.db.query<Link, [string]>("SELECT * FROM tweet_links WHERE ref = ?").get(ref);
    if (have) {
      if (have.repo === repo && have.tweet_id === tweet_id && have.handle === handle && have.under_handle === under_handle) return this.origin(have);
      throw conflict("ref_registered", "this launch link is already registered for another tweet or repository");
    }
    // an id a launch already used before anyone registered it did not come from this link
    if (this.c.db.query("SELECT 1 FROM tweet_launches WHERE ref = ?").get(ref)) throw conflict("ref_used", "this launch link was already used by a launch");
    const now = this.c.now();
    const l: Link = { ref, repo, tweet_id, handle, under_handle, created_at: now, expires_at: now + hours * HOUR };
    this.c.db.query("INSERT INTO tweet_links (ref, repo, tweet_id, handle, under_handle, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(l.ref, l.repo, l.tweet_id, l.handle, l.under_handle, l.created_at, l.expires_at);
    return this.origin(l);
  }

  /**
   * GET /v1/tweet-links/:id: `origin`, the tweet an open link answers, or null for an id nobody registered, one past its time
   * and one a launch has used (an answer either way, so a stale link is not an error in the page that asks).
   */
  resolve(ref: string): { origin: TweetOrigin | null } {
    if (!TWEET_REF.test(ref)) throw bad("bad_ref", "ref is the 22 character id of a launch link");
    const l = this.c.db.query<Link, [string]>("SELECT * FROM tweet_links WHERE ref = ?").get(ref);
    if (!l || this.c.now() >= l.expires_at || this.c.db.query("SELECT 1 FROM tweet_launches WHERE ref = ?").get(ref)) return { origin: null };
    return { origin: this.origin(l) };
  }

  private view(r: Row) {
    const a = this.c.db
      .query<{ target_repo: string | null; registered_at: number; launcher: string | null }, [string]>("SELECT target_repo, registered_at, launcher FROM agents WHERE agent_id = ?")
      .get(r.agent);
    return { ref: r.ref, agent: r.agent, mint: r.mint, repo: a?.target_repo ?? null, launched_at: a?.registered_at ?? null, claimed_at: r.claimed_at };
  }

  /** POST /v1/tweet-launches { ref, agent, mint }: the launch page hands in the launch it sent for a link. */
  claim(body: unknown) {
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const ref = typeof b.ref === "string" ? b.ref : "";
    const agent = typeof b.agent === "string" ? b.agent : "";
    const mint = typeof b.mint === "string" ? b.mint : "";
    if (!TWEET_REF.test(ref)) throw bad("bad_ref", "ref is the 22 character id of a launch link");
    if (!B58.test(agent) || !B58.test(mint)) throw bad("bad_body", "agent and mint are base58 addresses");
    const known = this.c.db.query<{ mint: string | null }, [string]>("SELECT mint FROM agents WHERE agent_id = ? AND kind = 'launched' AND shadow = 0").get(agent);
    // the page asks again: Core reads a new launch from the chain a little after it lands
    if (!known || known.mint !== mint) throw new ApiError(404, "launch_unknown", "Core has not read this launch from the chain yet");
    const byRef = this.c.db.query<Row, [string]>("SELECT * FROM tweet_launches WHERE ref = ?").get(ref);
    if (byRef) {
      if (byRef.agent === agent) return this.view(byRef);
      throw conflict("ref_used", "this launch link was already used by another launch");
    }
    if (this.c.db.query("SELECT 1 FROM tweet_launches WHERE agent = ?").get(agent)) throw conflict("launch_used", "this launch already answered another launch link");
    const row: Row = { ref, agent, mint, claimed_at: this.c.now() };
    this.c.db.query("INSERT INTO tweet_launches (ref, agent, mint, claimed_at) VALUES (?, ?, ?, ?)").run(row.ref, row.agent, row.mint, row.claimed_at);
    return this.view(row);
  }

  /** GET /v1/tweet-launches/:id: the launch a link led to, with its repository and the time Core registered it. */
  get(ref: string) {
    if (!TWEET_REF.test(ref)) throw bad("bad_ref", "ref is the 22 character id of a launch link");
    const r = this.c.db.query<Row, [string]>("SELECT * FROM tweet_launches WHERE ref = ?").get(ref);
    if (!r) throw new ApiError(404, "not_found", "no launch has used this link");
    return this.view(r);
  }
}
