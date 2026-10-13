import { createHmac, randomBytes } from "node:crypto";
import type { Creds, OAuth1Creds } from "./config.ts";
import type { Mention, XPost } from "./parse.ts";
import type { TokenStore } from "./tokens.ts";

// The three X API calls the bot makes (docs/plans/TWEET-LAUNCH.md 3): who am I, my mentions since an
// id, and a reply. User context: OAuth 2.0 (a bearer access token, refreshed by tokens.ts) or
// OAuth 1.0a. No secret is ever part of an error message or a log line.

export class XError extends Error {
  constructor(readonly status: number, readonly what: string, readonly resetAt: number | null, readonly detail: string | null) {
    super(`X answered HTTP ${status} to ${what}${detail ? `: ${detail}` : ""}`);
  }
}

export interface XApi {
  me(): Promise<{ id: string; username: string }>;
  /** mentions newer than `sinceId`, oldest first, and the newest id seen */
  mentions(userId: string, sinceId: string | null): Promise<{ mentions: Mention[]; newest_id: string | null; dialect: "tweet" | "post" }>;
  reply(inReplyTo: string, text: string): Promise<{ id: string }>;
}

const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The OAuth 1.0a Authorization header of one request (HMAC-SHA1; a JSON body is not part of the signature). */
export function oauth1Header(c: OAuth1Creds, method: string, url: string, o: { nonce?: string; timestamp?: number } = {}): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.api_key, oauth_nonce: o.nonce ?? randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(o.timestamp ?? Math.floor(Date.now() / 1000)), oauth_token: c.access_token, oauth_version: "1.0",
  };
  const all: [string, string][] = [...Object.entries(oauth), ...u.searchParams.entries()].map(([k, v]) => [pct(k), pct(v)] as [string, string]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(all.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  oauth.oauth_signature = createHmac("sha1", `${pct(c.api_secret)}&${pct(c.access_token_secret)}`).update(base).digest("base64");
  return `OAuth ${Object.entries(oauth).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(", ")}`;
}

const big = (s: string) => BigInt(s);
export const idAsc = (a: { id: string }, b: { id: string }) => (big(a.id) < big(b.id) ? -1 : big(a.id) > big(b.id) ? 1 : 0);

type Raw = Record<string, any>;

function post(raw: Raw, users: Map<string, string>): XPost {
  const note = raw.note_tweet ?? raw.note_post;
  const urls: string[] = [];
  for (const e of [...(raw.entities?.urls ?? []), ...(note?.entities?.urls ?? [])]) for (const k of ["unwound_url", "expanded_url"]) if (typeof e?.[k] === "string") urls.push(e[k]);
  return {
    id: String(raw.id), text: typeof note?.text === "string" ? note.text : String(raw.text ?? ""), author_id: String(raw.author_id ?? ""),
    username: users.get(String(raw.author_id ?? "")) ?? null, created_at: typeof raw.created_at === "string" ? raw.created_at : null, urls,
    refs: (raw.referenced_tweets ?? raw.referenced_posts ?? []).filter((r: Raw) => r && typeof r.id === "string" && typeof r.type === "string").map((r: Raw) => ({ type: r.type, id: r.id })),
  };
}

/** A mentions response in either naming (tweets or posts) as mentions with their replied-to and quoted posts. */
export function readMentions(body: Raw): Mention[] {
  const users = new Map<string, string>((body.includes?.users ?? []).map((u: Raw) => [String(u.id), String(u.username)]));
  const inc = new Map<string, XPost>((body.includes?.tweets ?? body.includes?.posts ?? []).map((t: Raw) => [String(t.id), post(t, users)]));
  return (body.data ?? []).map((d: Raw) => {
    const p = post(d, users);
    const ref = (type: string) => inc.get(p.refs.find((r) => r.type === type)?.id ?? "") ?? null;
    return { ...p, replied_to: ref("replied_to"), quoted: ref("quoted") };
  });
}

const QUERY = {
  tweet: "expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id&tweet.fields=created_at,conversation_id,author_id,referenced_tweets,entities,note_tweet&user.fields=username",
  post: "expansions=author_id,referenced_posts&post.fields=created_at,conversation_id,author_id,referenced_posts,entities,note_post&user.fields=username",
};

export class XClient implements XApi {
  constructor(
    private readonly o: { base: string; creds: Creds; tokens: TokenStore | null; fetch: typeof fetch; dialect: "tweet" | "post"; max_results: number; max_pages: number },
  ) {}

  private async auth(method: string, url: string): Promise<string> {
    if (this.o.creds.kind === "oauth1") return oauth1Header(this.o.creds, method, url);
    return `Bearer ${await this.o.tokens!.access()}`;
  }

  private async call(method: string, path: string, what: string, body?: unknown): Promise<Raw> {
    const url = `${this.o.base}${path}`;
    const send = async () =>
      this.o.fetch(url, { signal: AbortSignal.timeout(30_000), method, headers: { authorization: await this.auth(method, url), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let res = await send();
    // an access token X no longer takes: one refresh, one more try, never a loop
    if (res.status === 401 && this.o.tokens?.canRefresh) {
      await this.o.tokens.refresh();
      res = await send();
    }
    const j = (await res.json().catch(() => null)) as Raw | null;
    if (!res.ok) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      const detail = typeof j?.detail === "string" ? j.detail : typeof j?.title === "string" ? j.title : null;
      throw new XError(res.status, what, res.status === 429 && Number.isFinite(reset) && reset > 0 ? reset * 1000 : null, detail?.slice(0, 200) ?? null);
    }
    return j ?? {};
  }

  async me() {
    const j = await this.call("GET", "/2/users/me", "GET /2/users/me");
    if (typeof j.data?.id !== "string" || typeof j.data?.username !== "string") throw new Error("X did not say which account these credentials belong to");
    return { id: j.data.id as string, username: j.data.username as string };
  }

  async mentions(userId: string, sinceId: string | null) {
    let dialect = this.o.dialect;
    const page = async (token: string | null) => {
      const q = `${QUERY[dialect]}&max_results=${this.o.max_results}${sinceId ? `&since_id=${sinceId}` : ""}${token ? `&pagination_token=${token}` : ""}`;
      return this.call("GET", `/2/users/${userId}/mentions?${q}`, "GET /2/users/:id/mentions");
    };
    const out: Mention[] = [];
    let token: string | null = null;
    for (let i = 0; i < this.o.max_pages; i++) {
      let j: Raw;
      try {
        j = await page(token);
      } catch (e) {
        // the reference page and the guides name the fields differently: try the other naming once
        if (!(e instanceof XError) || e.status !== 400 || i > 0 || dialect !== this.o.dialect) throw e;
        dialect = dialect === "tweet" ? "post" : "tweet";
        j = await page(token);
      }
      out.push(...readMentions(j));
      token = typeof j.meta?.next_token === "string" ? j.meta.next_token : null;
      if (!token) break;
    }
    out.sort(idAsc);
    return { mentions: out, newest_id: out.length ? out[out.length - 1]!.id : null, dialect };
  }

  async reply(inReplyTo: string, text: string) {
    const j = await this.call("POST", "/2/tweets", "POST /2/tweets", { text, reply: { in_reply_to_tweet_id: inReplyTo } });
    if (typeof j.data?.id !== "string") throw new Error("X accepted the reply but returned no id");
    return { id: j.data.id as string };
  }
}
