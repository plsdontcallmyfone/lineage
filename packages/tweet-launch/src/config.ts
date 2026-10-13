import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LimitConfig } from "./limits.ts";

// Settings and credentials (docs/plans/TWEET-LAUNCH.md 3, 6). Every number here is a setting; the
// defaults are a cautious start. Credentials never come from this file and are never printed.

export interface Config extends LimitConfig {
  /** false: nothing is posted even with --send (the kill switch in the config) */
  enabled: boolean;
  /** the account the bot answers as, without @ */
  handle: string;
  /** the app's public address: the links in replies start with it */
  app_url: string;
  /** where Core's API is read (GET <core_url>/tweet-launches/<id>); default <app_url>/api */
  core_url: string;
  state_dir: string;
  credentials_file: string;
  x_base: string;
  /** field names of the mentions read: "tweet" (tweet.fields, referenced_tweets.id) or "post" (post.fields, referenced_posts); the other is tried once on HTTP 400 */
  dialect: "tweet" | "post";
  github_api: string;
  /** where the market API is read for a coin's name (GET <market_url>/tokens/<mint>); default <app_url>/market */
  market_url: string;
  /** off (default): one reply per mention and nothing more; own_reply: a second post answers the bot's own first reply once the launch landed; mention: it answers the mention again */
  follow_up: "own_reply" | "mention" | "off";
  min_seconds_between_posts: number;
  max_mention_age_hours: number;
  poll_max_results: number;
  poll_max_pages: number;
  /** how long a link's launch is watched for */
  link_hours: number;
  /** repositories GitHub reports larger than this are not cloned for the free reading */
  read_max_kb: number;
  read_cache_hours: number;
  /** false: the free reading (a clone) is never run; the link is given without it */
  read_repos: boolean;
  /** an OAuth 2.0 access token is refreshed this long before it runs out */
  refresh_margin_s: number;
}

export const X_BASE = "https://api.x.com";
export const DEFAULTS: Config = {
  enabled: false,
  handle: "unitsdotgg",
  app_url: "https://app.units.gg",
  core_url: "",
  market_url: "",
  state_dir: join(homedir(), ".local/state/units-tweet-launch"),
  credentials_file: join(homedir(), ".config/units/x.env"),
  x_base: X_BASE,
  dialect: "tweet",
  github_api: "https://api.github.com",
  follow_up: "off",
  per_author_per_day: 2,
  global_per_hour: 20,
  global_per_day: 100,
  min_seconds_between_posts: 20,
  max_mention_age_hours: 24,
  poll_max_results: 50,
  poll_max_pages: 3,
  link_hours: 72,
  read_max_kb: 50_000,
  read_cache_hours: 24,
  read_repos: true,
  refresh_margin_s: 300,
};

const isLoopback = (u: URL) => u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";

export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config: a JSON object is expected");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!(k in DEFAULTS) && k !== "note") throw new Error(`config: unknown setting ${k}`);
  const c = { ...DEFAULTS, ...r } as Config;
  if (typeof c.enabled !== "boolean" || typeof c.read_repos !== "boolean") throw new Error("config: enabled and read_repos are true or false");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(c.handle)) throw new Error("config: handle is an X handle without @");
  for (const k of ["app_url", "x_base", "github_api"] as const) {
    let u: URL;
    try {
      u = new URL(c[k]);
    } catch {
      throw new Error(`config: ${k} is a URL`);
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u))) throw new Error(`config: ${k} is https (http only on this machine)`);
    c[k] = c[k].replace(/\/+$/, "");
  }
  c.core_url = (typeof c.core_url === "string" && c.core_url ? c.core_url : `${c.app_url}/api`).replace(/\/+$/, "");
  c.market_url = (typeof c.market_url === "string" && c.market_url ? c.market_url : `${c.app_url}/market`).replace(/\/+$/, "");
  if (c.dialect !== "tweet" && c.dialect !== "post") throw new Error('config: dialect is "tweet" or "post"');
  if (!["own_reply", "mention", "off"].includes(c.follow_up)) throw new Error('config: follow_up is "own_reply", "mention" or "off"');
  const ints: [keyof Config, number, number][] = [
    ["per_author_per_day", 1, 100], ["global_per_hour", 1, 1000], ["global_per_day", 1, 10_000], ["min_seconds_between_posts", 0, 3600], ["max_mention_age_hours", 1, 720],
    ["poll_max_results", 5, 100], ["poll_max_pages", 1, 10], ["link_hours", 1, 24 * 90], ["read_max_kb", 0, 100_000_000], ["read_cache_hours", 0, 24 * 30], ["refresh_margin_s", 0, 3600],
  ];
  for (const [k, lo, hi] of ints) if (!Number.isInteger(c[k]) || (c[k] as number) < lo || (c[k] as number) > hi) throw new Error(`config: ${k} is a whole number from ${lo} to ${hi}`);
  if (typeof c.state_dir !== "string" || !c.state_dir.startsWith("/")) throw new Error("config: state_dir is an absolute path");
  if (typeof c.credentials_file !== "string" || !c.credentials_file.startsWith("/")) throw new Error("config: credentials_file is an absolute path");
  return c;
}

export const loadConfig = (file: string): Config => parseConfig(JSON.parse(readFileSync(file, "utf8")));

/** OAuth 2.0 user context (the primary path): a short-lived access token and a refresh token that changes with every refresh. */
export interface OAuth2Creds {
  kind: "oauth2";
  access_token: string;
  refresh_token: string | null;
  client_id: string;
  /** a confidential client (Web App, Automated App or bot) has one and authenticates the refresh with it */
  client_secret: string | null;
}
/** OAuth 1.0a user context: four static values. */
export interface OAuth1Creds {
  kind: "oauth1";
  api_key: string;
  api_secret: string;
  access_token: string;
  access_token_secret: string;
}
export type Creds = OAuth2Creds | OAuth1Creds;

/**
 * Reads the owner's credentials file (KEY=value lines). Null when the file is missing or holds no
 * complete set. Refused when anyone but its owner can read it. OAuth 2.0 when X_CLIENT_ID or
 * X_REFRESH_TOKEN is there, else OAuth 1.0a when its four values are.
 */
export function loadCredentials(file: string): Creds | null {
  if (!existsSync(file)) return null;
  if (statSync(file).mode & 0o077) throw new Error(`the credentials file ${file} can be read by other users: chmod 600 it`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) env[m[1]!] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  const g = (k: string) => env[k] || null;
  if (g("X_CLIENT_ID") || g("X_REFRESH_TOKEN")) {
    if (!g("X_ACCESS_TOKEN") && !g("X_REFRESH_TOKEN")) return null;
    if (!g("X_CLIENT_ID")) throw new Error("the credentials file has OAuth 2.0 tokens but no X_CLIENT_ID");
    return { kind: "oauth2", access_token: g("X_ACCESS_TOKEN") ?? "", refresh_token: g("X_REFRESH_TOKEN"), client_id: g("X_CLIENT_ID")!, client_secret: g("X_CLIENT_SECRET") };
  }
  if (g("X_API_KEY") && g("X_API_SECRET") && g("X_ACCESS_TOKEN") && g("X_ACCESS_TOKEN_SECRET")) {
    return { kind: "oauth1", api_key: g("X_API_KEY")!, api_secret: g("X_API_SECRET")!, access_token: g("X_ACCESS_TOKEN")!, access_token_secret: g("X_ACCESS_TOKEN_SECRET")! };
  }
  return null;
}

/** The config as it may be printed: it holds no secret, the credentials file is only named. */
export const publicConfig = (c: Config) => ({ ...c });
