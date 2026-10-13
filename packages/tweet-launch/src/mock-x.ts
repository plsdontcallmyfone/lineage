import type { Creds } from "./config.ts";
import { oauth1Header } from "./x.ts";

// A mock of the X API over HTTP for tests and the local proof (docs/plans/TWEET-LAUNCH.md 8): the
// three calls the bot makes and the OAuth 2.0 token refresh, with the checks X makes that matter
// here (the signature or the bearer token, an expired access token, a spent refresh token, Basic
// client authentication, rate limit headers, both field namings). It never talks to X.

export interface MockPost {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  urls?: string[];
  replied_to?: string;
  quoted?: string;
  retweeted?: string;
}

export interface MockX {
  url: string;
  account: { id: string; username: string };
  users: Map<string, string>;
  posts: Map<string, MockPost>;
  /** ids of posts that mention the account */
  mentionIds: string[];
  /** what the bot posted, in order */
  /** every post the mock took; `in_reply_to` null for an original post */
  posted: { id: string; text: string; in_reply_to: string | null }[];
  requests: { method: string; path: string; auth: string }[];
  /** the next POST /2/tweets answers this status instead */
  failNextPost: number | null;
  /** the next token refresh answers this status instead */
  failNextRefresh: number | null;
  /** which field naming the mentions read accepts */
  accepts: "tweet" | "post" | "both";
  /** OAuth 2.0: the live pair and when the access token runs out (ms) */
  oauth2: { access_token: string; refresh_token: string; expires_at: number; refreshes: number };
  now: () => number;
  add(p: Omit<MockPost, "id" | "created_at"> & { id?: string; created_at?: string; mention?: boolean }): MockPost;
  stop(): void;
}

export const MOCK_OAUTH1 = { kind: "oauth1", api_key: "mock-key", api_secret: "mock-secret", access_token: "mock-token", access_token_secret: "mock-token-secret" } as const;
export const MOCK_CLIENT = { client_id: "mock-client", client_secret: "mock-client-secret" };
/** The OAuth 2.0 credentials a fresh mock accepts (what the owner's file would hold). */
export const mockOAuth2 = (m: MockX): Creds => ({ kind: "oauth2", access_token: m.oauth2.access_token, refresh_token: m.oauth2.refresh_token, ...MOCK_CLIENT });

export function startMockX(o: { port?: number; username?: string; now?: () => number; expires_in?: number } = {}): MockX {
  let seq = 1_900_000_000_000_000_000n;
  let tok = 0;
  const expiresIn = o.expires_in ?? 7200;
  const now = o.now ?? Date.now;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "x-rate-limit-limit": "300", "x-rate-limit-remaining": "299", "x-rate-limit-reset": String(Math.floor(now() / 1000) + 900), ...headers } });
  const m: MockX = {
    url: "", account: { id: "1000", username: o.username ?? "unitsdotgg" }, users: new Map(), posts: new Map(), mentionIds: [], posted: [], requests: [],
    failNextPost: null, failNextRefresh: null, accepts: "both", now,
    oauth2: { access_token: "mock-access-0", refresh_token: "mock-refresh-0", expires_at: now() + expiresIn * 1000, refreshes: 0 },
    add(p) {
      const id = p.id ?? String(++seq);
      const post: MockPost = { ...p, id, created_at: p.created_at ?? new Date(now()).toISOString() };
      m.posts.set(id, post);
      if (p.mention) m.mentionIds.push(id);
      return post;
    },
    stop: () => server.stop(true),
  };
  m.users.set(m.account.id, m.account.username);

  const authed = (req: Request, url: URL): boolean => {
    const h = req.headers.get("authorization") ?? "";
    if (h.startsWith("Bearer ")) return h === `Bearer ${m.oauth2.access_token}` && now() < m.oauth2.expires_at;
    if (!h.startsWith("OAuth ")) return false;
    const f = Object.fromEntries([...h.slice(6).matchAll(/([a-z_]+)="([^"]*)"/g)].map((x) => [x[1]!, decodeURIComponent(x[2]!)]));
    if (f.oauth_consumer_key !== MOCK_OAUTH1.api_key || f.oauth_token !== MOCK_OAUTH1.access_token) return false;
    // the URL as the client signed it: this server's own origin
    return oauth1Header(MOCK_OAUTH1, req.method, `${m.url}${url.pathname}${url.search}`, { nonce: f.oauth_nonce, timestamp: Number(f.oauth_timestamp) }) === h;
  };

  const shape = (p: MockPost, dialect: "tweet" | "post") => {
    const refs = [p.replied_to && { type: "replied_to", id: p.replied_to }, p.quoted && { type: "quoted", id: p.quoted }, p.retweeted && { type: "retweeted", id: p.retweeted }].filter(Boolean);
    return {
      id: p.id, text: p.text, author_id: p.author_id, created_at: p.created_at, conversation_id: p.replied_to ?? p.id,
      ...(p.urls?.length ? { entities: { urls: p.urls.map((u, i) => ({ url: `https://t.co/m${i}`, expanded_url: u })) } } : {}),
      ...(refs.length ? { [dialect === "tweet" ? "referenced_tweets" : "referenced_posts"]: refs } : {}),
    };
  };

  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      m.requests.push({ method: req.method, path: url.pathname, auth: (req.headers.get("authorization") ?? "").split(" ")[0]! });
      if (req.method === "POST" && url.pathname === "/2/oauth2/token") {
        if (m.failNextRefresh) {
          const st = m.failNextRefresh;
          m.failNextRefresh = null;
          return json({ error: "invalid_request", error_description: "mock failure" }, st);
        }
        const f = new URLSearchParams(await req.text());
        const basic = `Basic ${Buffer.from(`${MOCK_CLIENT.client_id}:${MOCK_CLIENT.client_secret}`).toString("base64")}`;
        if (req.headers.get("content-type") !== "application/x-www-form-urlencoded") return json({ error: "invalid_request" }, 400);
        if (req.headers.get("authorization") !== basic) return json({ error: "unauthorized_client", error_description: "Missing valid authorization header" }, 401);
        // a refresh token works once
        if (f.get("grant_type") !== "refresh_token" || f.get("refresh_token") !== m.oauth2.refresh_token) return json({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, 400);
        tok++;
        m.oauth2 = { access_token: `mock-access-${tok}`, refresh_token: `mock-refresh-${tok}`, expires_at: now() + expiresIn * 1000, refreshes: m.oauth2.refreshes + 1 };
        return json({ token_type: "bearer", expires_in: expiresIn, access_token: m.oauth2.access_token, scope: "tweet.read tweet.write users.read offline.access", refresh_token: m.oauth2.refresh_token });
      }
      if (!authed(req, url)) return json({ title: "Unauthorized", detail: "Unauthorized", status: 401 }, 401);
      if (req.method === "GET" && url.pathname === "/2/users/me") return json({ data: { id: m.account.id, username: m.account.username, name: "units" } });
      const men = /^\/2\/users\/(\d+)\/mentions$/.exec(url.pathname);
      if (req.method === "GET" && men) {
        if (men[1] !== m.account.id) return json({ title: "Forbidden", detail: "not this account's mentions" }, 403);
        const dialect = url.searchParams.has("post.fields") ? "post" : "tweet";
        if (m.accepts !== "both" && m.accepts !== dialect) return json({ title: "Invalid Request", detail: `The query parameter [${dialect}.fields] is not one of the allowed parameters` }, 400);
        const since = url.searchParams.get("since_id");
        const max = Number(url.searchParams.get("max_results") ?? 10);
        if (!(max >= 5 && max <= 100)) return json({ title: "Invalid Request", detail: "max_results must be between 5 and 100" }, 400);
        const all = m.mentionIds.map((id) => m.posts.get(id)!).filter((p) => !since || BigInt(p.id) > BigInt(since)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
        const start = Number(url.searchParams.get("pagination_token") ?? 0);
        const page = all.slice(start, start + max);
        const inc = new Map<string, MockPost>();
        for (const p of page) for (const id of [p.replied_to, p.quoted]) if (id && m.posts.has(id)) inc.set(id, m.posts.get(id)!);
        const authors = new Set([...page, ...inc.values()].map((p) => p.author_id));
        return json({
          data: page.map((p) => shape(p, dialect)),
          includes: { users: [...authors].map((id) => ({ id, username: m.users.get(id) ?? `user${id}` })), [dialect === "tweet" ? "tweets" : "posts"]: [...inc.values()].map((p) => shape(p, dialect)) },
          meta: { result_count: page.length, ...(start + max < all.length ? { next_token: String(start + max) } : {}) },
        });
      }
      if (req.method === "POST" && url.pathname === "/2/tweets") {
        if (m.failNextPost) {
          const st = m.failNextPost;
          m.failNextPost = null;
          return json({ title: st === 429 ? "Too Many Requests" : "Forbidden", detail: "mock failure", status: st }, st);
        }
        const b = (await req.json().catch(() => null)) as { text?: unknown; reply?: { in_reply_to_tweet_id?: unknown } } | null;
        const to = b?.reply?.in_reply_to_tweet_id;
        // an original post (no `reply`): the same duplicate rule, no summons needed
        if (b && typeof b.text === "string" && b.text && b.reply === undefined) {
          if (m.posted.some((p) => p.text === b.text)) return json({ title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content." }, 403);
          const p = m.add({ text: b.text, author_id: m.account.id });
          m.posted.push({ id: p.id, text: b.text, in_reply_to: null });
          return json({ data: { id: p.id, text: b.text } }, 201);
        }
        if (!b || typeof b.text !== "string" || !b.text || typeof to !== "string") return json({ title: "Invalid Request", detail: "text and reply.in_reply_to_tweet_id are required" }, 400);
        const parent = m.posts.get(to);
        if (!parent) return json({ title: "Invalid Request", detail: "the post replied to does not exist" }, 400);
        // the 2026-02-23 rule: a programmatic reply only to an author who mentioned the account (or to the account's own post)
        if (parent.author_id !== m.account.id && !m.mentionIds.includes(to)) return json({ title: "Forbidden", detail: "You are not permitted to reply to this post" }, 403);
        if (m.posted.some((p) => p.text === b.text)) return json({ title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content." }, 403);
        const p = m.add({ text: b.text, author_id: m.account.id, replied_to: to });
        m.posted.push({ id: p.id, text: b.text, in_reply_to: to });
        return json({ data: { id: p.id, text: b.text } }, 201);
      }
      return json({ title: "Not Found" }, 404);
    },
  });
  m.url = `http://127.0.0.1:${server.port}`;
  return m;
}
