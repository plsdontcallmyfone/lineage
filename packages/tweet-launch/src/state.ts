import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PostLog } from "./limits.ts";

// What the bot remembers between runs: one JSON file (mode 600, written with a rename) and the STOP
// file that is its kill switch. No secret is in the state file; tokens live in tokens.json.

export interface Request {
  /** the opaque id in the link (22 base64url characters) */
  ref: string;
  mention_id: string;
  author_id: string;
  /** owner/name as GitHub spells it */
  repo: string;
  /** the asker's handle and, when the mention replied to another account's post, that account's; absent on links made before 2026-10-13 */
  handle?: string | null;
  under_handle?: string | null;
  /** true once Core took the signed statement of which tweet this link answers (the launch page and the agent's pages show it) */
  registered?: boolean;
  /** ms, when the link was made */
  created_at: number;
  /** the bot's reply with the link; null until X returned its id */
  reply_id: string | null;
  /** open: the launch is watched for; following: the follow-up is being posted (never posted twice); done: over, see `outcome` */
  status: "open" | "following" | "done";
  outcome: null | "followed" | "launched" | "expired" | "mismatch" | "follow_up_failed";
  agent: string | null;
  mint: string | null;
  follow_up_id: string | null;
}

/** One maintainer notice as it was composed (notices.ts): written before the post goes out. */
export interface NoticeRecord {
  at: number;
  /** the dollars waiting when it was composed */
  usd: number;
  text: string;
  /** the handle named, from GitHub's own profile field of the repository's owner; null: none named */
  handle: string | null;
  /** X's id of the post; null in a dry record, and when X did not take it */
  post_id: string | null;
}

export interface State extends PostLog {
  v: 1;
  me: { id: string; username: string } | null;
  since_id: string | null;
  /** the field naming X accepted on the last read */
  dialect: "tweet" | "post" | null;
  /** every mention id handled, with what was done: nothing is answered twice */
  answered: Record<string, { at: number; did: string; reply_id?: string | null }>;
  requests: Record<string, Request>;
  /** free readings by lowercase owner/name */
  readings: Record<string, { at: number; impossible: string | null }>;
  /** authors who said stop */
  stopped: Record<string, number>;
  /** ms: X asked to wait until then (HTTP 429) */
  backoff_until: number | null;
  /**
   * Maintainer notices by the repository's numeric GitHub id. `steps`: real posts by threshold step (a step is used once, for
   * good). `dry`: what dry mode composed, which never counts as a post. `skipped`: the line that asked for no such contact.
   */
  notices?: Record<string, { repo: string; steps: Record<string, NoticeRecord>; dry: Record<string, NoticeRecord>; skipped?: { at: number; why: string } }>;
}

export const emptyState = (): State => ({ v: 1, me: null, since_id: null, dialect: null, answered: {}, requests: {}, readings: {}, stopped: {}, backoff_until: null, posts: [], by_author: {} });

export class Store {
  readonly file: string;
  readonly stopFile: string;
  readonly tokensFile: string;
  constructor(readonly dir: string) {
    this.file = join(dir, "state.json");
    this.stopFile = join(dir, "STOP");
    this.tokensFile = join(dir, "tokens.json");
  }

  load(): State {
    if (!existsSync(this.file)) return emptyState();
    const s = JSON.parse(readFileSync(this.file, "utf8")) as State;
    if (!s || s.v !== 1) throw new Error(`${this.file} is not a state file of this service`);
    return { ...emptyState(), ...s };
  }

  save(s: State) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** Why the service is stopped (the STOP file's text), or null. */
  stopped(): string | null {
    return existsSync(this.stopFile) ? readFileSync(this.stopFile, "utf8").trim() || "stopped by hand" : null;
  }

  stop(reason: string) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.stopFile, `${new Date().toISOString()} ${reason}\n`, { mode: 0o600 });
  }

  resume() {
    rmSync(this.stopFile, { force: true });
  }
}

/** Old entries are dropped so the file stays small: answered ids and closed requests after 30 days, readings after their cache time. */
export function trim(s: State, now: number, readCacheMs: number) {
  const old = now - 30 * 24 * 3_600_000;
  for (const [id, a] of Object.entries(s.answered)) if (a.at < old) delete s.answered[id];
  for (const [ref, r] of Object.entries(s.requests)) if (r.status === "done" && r.created_at < old) delete s.requests[ref];
  for (const [k, r] of Object.entries(s.readings)) if (now - r.at > readCacheMs) delete s.readings[k];
}
