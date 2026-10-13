// Launch from a tweet (docs/plans/TWEET-LAUNCH.md 1, 4): the reply bot's link opens /launch with the
// repository (filled by mountLaunch's own ?repo= code), optional coin fields and an opaque single-use
// id (?tl=). This module fills the optional fields as if typed and, once the launch this page sent has
// landed, hands the id to Core with the agent and coin so the bot can answer in the thread. It sends
// nothing else and launches nothing: every field stays editable and the launch needs the wallet's
// approval like any other.

export const TWEET_REF = /^[A-Za-z0-9_-]{22}$/;
const KEY = "units.tweet_ref";
const TRY_EVERY_MS = 6_000;
const TRY_FOR_MS = 10 * 60_000;

export interface Prefill {
  name: string | null;
  /** only ever what the link carries: never made from the name */
  ticker: string | null;
  vibe: string | null;
  ref: string | null;
}

/** The optional launch fields of an address, each checked with the wizard's own rule; a value that breaks it is left out. */
export function readPrefill(search: string): Prefill {
  const q = new URLSearchParams(search);
  const get = (k: string) => (q.get(k) ?? "").trim();
  const clean = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
  const name = get("name");
  const ticker = get("ticker").toUpperCase();
  const vibe = get("vibe");
  const ref = get("tl");
  return {
    name: name && clean(name) && new TextEncoder().encode(name).length <= 32 ? name : null,
    ticker: /^[A-Z0-9]{1,10}$/.test(ticker) ? ticker : null,
    vibe: vibe && clean(vibe) && vibe.length <= 200 ? vibe : null,
    ref: TWEET_REF.test(ref) ? ref : null,
  };
}

const repoKey = (url: string) => url.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();

/** Fills the empty Name, Ticker and Vibe fields from the address and keeps the link's id for this tab. */
export function applyLaunchPrefill(root: ParentNode | null | undefined, search: string = location.search): Prefill {
  const p = readPrefill(search);
  if (!root) return p;
  const fill = (field: string, value: string | null) => {
    const el = root.querySelector<HTMLInputElement>(`[name="${field}"]`);
    if (!el || !value || el.value) return;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  fill("l_name", p.name);
  fill("l_symbol", p.ticker);
  fill("s_vibe", p.vibe);
  const repo = new URLSearchParams(search).get("repo");
  if (p.ref && repo) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ ref: p.ref, repo: repoKey(repo) }));
    } catch {
      // no storage: the launch still works, only the bot is not told
    }
  }
  return p;
}

/**
 * After a launch landed: when this tab came from a reply bot's link for the same repository, hand its
 * id to Core with the agent and coin. Core answers 404 until it has read the launch from the chain, so
 * this asks again for a while. Never throws; the launch is done either way.
 */
export function reportTweetLaunch(agent: string, mint: string, repoUrl: string, o: { fetch?: typeof fetch; every_ms?: number; for_ms?: number } = {}): void {
  let held: { ref?: unknown; repo?: unknown } | null = null;
  try {
    held = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
  } catch {
    return;
  }
  if (!held || typeof held.ref !== "string" || !TWEET_REF.test(held.ref) || held.repo !== repoKey(repoUrl)) return;
  const ref = held.ref;
  const f = o.fetch ?? fetch;
  const until = Date.now() + (o.for_ms ?? TRY_FOR_MS);
  const done = () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // nothing to clear
    }
  };
  const attempt = async () => {
    let status = 0;
    try {
      status = (await f("/api/tweet-launches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, agent, mint }) })).status;
    } catch {
      // offline for a moment: asked again below
    }
    // stored, or refused for good (the id was used, or the body is wrong): stop asking
    if (status === 200 || status === 400 || status === 409) return done();
    if (Date.now() < until) setTimeout(() => void attempt(), o.every_ms ?? TRY_EVERY_MS);
  };
  void attempt();
}
