// "Started from a tweet": a launch opened from the reply bot's link (docs/plans/TWEET-LAUNCH.md 9).
// The fact never comes from an address: Core serves it, from the statement the bot signed when it made
// the link (GET /v1/tweet-links/:id while the link is open). This module checks what Core answered once more
// before anything is shown, and holds the two places it is shown: the line on the launch page and its
// row in Review.
import { html, type Raw } from "./html.ts";

export interface TweetOrigin {
  /** owner/name, lower case */
  repo: string;
  /** who wrote the tweet that asked for the launch, without @ */
  handle: string;
  tweet_url: string;
  /** the author of the tweet it replied to, when that is someone else */
  under_handle: string | null;
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/;

/** owner/name in lower case, from a repository URL or owner/name. */
export const repoKey = (url: string) => url.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();

/** Core's answer as something that may be shown: the link is a tweet of that handle on x.com and nothing else, or null. */
export function readOrigin(j: unknown): TweetOrigin | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (typeof o.repo !== "string" || !REPO.test(o.repo) || typeof o.handle !== "string" || !HANDLE.test(o.handle) || typeof o.tweet_url !== "string") return null;
  if (!new RegExp(`^https://x\\.com/${o.handle}/status/[1-9][0-9]{0,19}$`).test(o.tweet_url)) return null;
  const under = typeof o.under_handle === "string" && HANDLE.test(o.under_handle) && o.under_handle.toLowerCase() !== o.handle.toLowerCase() ? o.under_handle : null;
  return { repo: o.repo, handle: o.handle, tweet_url: o.tweet_url, under_handle: under };
}

/** Whether the line may be shown on the launch page: Core confirmed the link and the form still names its repository. */
export const originFor = (o: TweetOrigin | null, formRepo: string | null | undefined): TweetOrigin | null => (o && formRepo && repoKey(formRepo) === o.repo ? o : null);

const tweetLink = (o: TweetOrigin, label: string): Raw => html`<a class="link" href="${o.tweet_url}" target="_blank" rel="noopener nofollow ugc" data-tweet-origin-link>${label}</a>`;
const under = (o: TweetOrigin) => (o.under_handle ? `, under a tweet by @${o.under_handle}` : "");

/** The line above the launch form. */
export const originLine = (o: TweetOrigin): Raw => html`<p class="wl-fine" data-tweet-origin="line" style="margin:0 0 12px">Started from ${tweetLink(o, `a tweet by @${o.handle}`)}${under(o)}.</p>`;

/** The same fact as a row of the Review step (it has nothing to edit, so no Edit button). */
export const originReviewRow = (o: TweetOrigin): Raw => html`<div class="lz-rr" data-tweet-origin="review"><span class="eyebrow">Started from</span><span class="lz-rv">${tweetLink(o, `A tweet by @${o.handle}`)}${under(o)}</span></div>`;

/** GET /api/tweet-links/<id>: the tweet an open link answers, or null (Core says null for an id it does not know, one past its time and a used one; or Core is away). */
export async function resolveTweetLink(ref: string, f: typeof fetch = fetch): Promise<TweetOrigin | null> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(ref)) return null;
  try {
    const r = await f(`/api/tweet-links/${ref}`, { headers: { accept: "application/json" } });
    return r.ok ? readOrigin(((await r.json()) as { origin?: unknown } | null)?.origin) : null;
  } catch {
    return null;
  }
}
