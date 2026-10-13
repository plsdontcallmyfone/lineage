import { textSafety } from "../../souls/src/safety.ts";

// What a mention asks for (docs/plans/TWEET-LAUNCH.md 2). Pure: no network, no state.

export interface XPost {
  id: string;
  text: string;
  author_id: string;
  username: string | null;
  created_at: string | null;
  /** the expanded links X returned for the post (t.co hides them in the text) */
  urls: string[];
  refs: { type: string; id: string }[];
}

export interface Mention extends XPost {
  /** the post this one replies to, when X returned it */
  replied_to: XPost | null;
  /** the post this one quotes, when X returned it */
  quoted: XPost | null;
}

export interface Repo {
  owner: string;
  name: string;
}

// github.com paths whose first segment is not an account
const NOT_OWNERS = new Set([
  "orgs", "topics", "features", "about", "pricing", "marketplace", "sponsors", "settings", "login", "join", "signup", "explore", "trending", "collections",
  "events", "enterprise", "team", "customer-stories", "security", "readme", "apps", "site", "contact", "notifications", "issues", "pulls", "search", "new",
  "organizations", "codespaces", "copilot", "solutions", "resources", "users", "stars", "watching", "dashboard", "account", "sessions", "gist", "blog",
]);
const REPO_LINK = /(?<![A-Za-z0-9.-])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})/gi;

/** The first GitHub repository a text links to, or null. A link to a file, issue or pull request gives its repository. */
export function repoInText(text: string): Repo | null {
  for (const m of text.matchAll(REPO_LINK)) {
    const owner = m[1]!;
    const name = m[2]!.replace(/\.git$/i, "").replace(/[.]+$/, "");
    if (NOT_OWNERS.has(owner.toLowerCase()) || owner.endsWith("-") || !name || name === "." || name === "..") continue;
    return { owner, name };
  }
  return null;
}

/** The repository of one post: the links X expanded first, then its text. */
export function repoOfPost(p: XPost | null): Repo | null {
  if (!p) return null;
  for (const u of p.urls) {
    const r = repoInText(u);
    if (r) return r;
  }
  return repoInText(p.text);
}

/** Where the repository of a mention is looked for, in order: the mention, the post it replies to, the post it quotes. */
export function resolveRepo(m: Mention): (Repo & { from: "mention" | "replied_to" | "quoted" }) | null {
  for (const [from, p] of [["mention", m], ["replied_to", m.replied_to], ["quoted", m.quoted]] as const) {
    const r = repoOfPost(p);
    if (r) return { ...r, from };
  }
  return null;
}

export const repoLabel = (r: Repo) => `${r.owner}/${r.name}`;
export const repoKey = (r: Repo) => repoLabel(r).toLowerCase();

export type Command =
  | { kind: "none" }
  | { kind: "stop" }
  | { kind: "launch"; name: string | null; ticker: string | null; vibe: string | null; dropped: string[] };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// `name <Name>` and `ticker <TICKER>` (a colon or equals sign is allowed); `vibe:` needs its colon
const KEY = String.raw`(?:name|ticker)\s*[:=]?\s|vibe\s*[:=]`;
const FIELD = new RegExp(String.raw`(^|\s)(name|ticker|vibe)(\s*[:=]\s*|\s+)(?:"([^"\n]*)"|\u201c([^\u201d\n]*)\u201d|([^\n]*?))(?=\s+(?:${KEY})|\n|$)`, "gi");

/** The wizard's own rule for a coin name (apps/web/wallet/main.ts stepProblem): at most 32 bytes. */
export const nameOk = (s: string) => s.length > 0 && new TextEncoder().encode(s).length <= 32 && !/[\u0000-\u001f\u007f]/.test(s);
/** The wizard's own rule for a ticker: 1 to 10 of A to Z and 0 to 9. */
export const tickerOk = (s: string) => /^[A-Z0-9]{1,10}$/.test(s);
export const VIBE_MAX = 200;

/**
 * The command in a mention's text: the word `launch` right after the handle (any case; only spaces,
 * commas, colons, other @handles and at most two short words such as "please" may stand between), so a post that merely talks about the bot
 * ("@handle turns a reply into an agent launch") is not a request; without it, `stop` right after the
 * handle. `launch` may be followed by `name <Name>`, `ticker <TICKER>`
 * and `vibe: <text>`. A field that breaks the wizard's rule or the soul safety check is
 * dropped (named in `dropped`); the ticker is only ever what was typed after `ticker:`.
 */
export function parseCommand(text: string, handle: string): Command {
  const tag = new RegExp(`@${esc(handle)}(?![A-Za-z0-9_])`, "i").exec(text);
  if (!tag) return { kind: "none" };
  const after = text.slice(tag.index + tag[0].length);
  const word = /^(?:[\s,:]*@[A-Za-z0-9_]{1,15})*(?:[\s,:]+[A-Za-z']{1,8}){0,2}[\s,:]+launch(?![A-Za-z0-9_])/i.exec(after);
  if (!word) return /^[\s,:]*stop(?![A-Za-z0-9_])/i.test(after) ? { kind: "stop" } : { kind: "none" };
  const rest = after.slice(word.index + word[0].length);
  const out: Command = { kind: "launch", name: null, ticker: null, vibe: null, dropped: [] };
  for (const m of rest.matchAll(FIELD)) {
    const key = m[2]!.toLowerCase() as "name" | "ticker" | "vibe";
    // an unquoted value ends where a link starts (X appends t.co links to the text)
    if (key === "vibe" && !/[:=]/.test(m[3]!)) continue;
    const value = (m[4] ?? m[5] ?? (m[6] ?? "").replace(/\s*https?:\/\/\S*.*$/i, "")).trim();
    if (!value || out[key] !== null || out.dropped.includes(key)) continue;
    if (key === "name") {
      if (nameOk(value) && !textSafety(value).length) out.name = value;
      else out.dropped.push(key);
    } else if (key === "ticker") {
      const t = value.replace(/^\$/, "").toUpperCase();
      if (tickerOk(t) && !textSafety(t).length) out.ticker = t;
      else out.dropped.push(key);
    } else if (value.length <= VIBE_MAX && !/[\u0000-\u001f\u007f]/.test(value) && !textSafety(value).length) out.vibe = value;
    else out.dropped.push(key);
  }
  return out;
}

/**
 * A repository name the bot will write in a reply. The safety list's price and harassment rules are
 * applied to it; its people rule is not, as in souls: an owner's handle is part of a repository's name.
 */
export const repoSayable = (r: Repo) => textSafety(repoLabel(r)).length === 0;
