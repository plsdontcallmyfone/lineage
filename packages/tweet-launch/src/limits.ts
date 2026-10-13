// Posting limits (docs/plans/TWEET-LAUNCH.md 3). Every number is a setting. A mention over a limit
// gets no reply at all.

export interface LimitConfig {
  per_author_per_day: number;
  global_per_hour: number;
  global_per_day: number;
}

export interface PostLog {
  /** ms timestamps of every post of the last 24 h */
  posts: number[];
  /** ms timestamps of the replies to each author over the last 24 h */
  by_author: Record<string, number[]>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function prune(log: PostLog, now: number) {
  log.posts = log.posts.filter((t) => now - t < DAY);
  for (const [a, ts] of Object.entries(log.by_author)) {
    const keep = ts.filter((t) => now - t < DAY);
    if (keep.length) log.by_author[a] = keep;
    else delete log.by_author[a];
  }
}

/** Why a post may not go out now, or null. `author` null: a follow-up, counted against the global limits only. */
export function limited(log: PostLog, cfg: LimitConfig, author: string | null, now: number): string | null {
  if (author !== null && (log.by_author[author] ?? []).filter((t) => now - t < DAY).length >= cfg.per_author_per_day) return "per_author_per_day";
  if (log.posts.filter((t) => now - t < HOUR).length >= cfg.global_per_hour) return "global_per_hour";
  if (log.posts.filter((t) => now - t < DAY).length >= cfg.global_per_day) return "global_per_day";
  return null;
}

export function record(log: PostLog, author: string | null, now: number) {
  log.posts.push(now);
  if (author !== null) (log.by_author[author] ??= []).push(now);
}
