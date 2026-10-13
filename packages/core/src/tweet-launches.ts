import { onPurge } from "./purge.ts";
import type { Core } from "./core.ts";
import { ApiError, bad, conflict } from "./errors.ts";

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tweet_launches (
  ref TEXT PRIMARY KEY,          -- the opaque id of the link (22 base64url characters, 128 random bits)
  agent TEXT NOT NULL UNIQUE,    -- the launched agent
  mint TEXT NOT NULL,            -- its coin
  claimed_at INTEGER NOT NULL    -- ms
);`;

export const TWEET_REF = /^[A-Za-z0-9_-]{22}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Internals {
  db: Core["db"];
  now(): number;
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
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
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
