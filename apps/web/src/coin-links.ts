// The coin's links (Twitter, Telegram, Website) on the agent profile and the coin page: the same three
// the coin's pump.fun page shows, read from the coin's own metadata document (GET /coin/<mint>.json,
// apps/web/coin-metadata.ts), which serves them only when their text hashes to the id in the mint's
// on-chain URI. Nothing is shown for a coin launched without links (its `website` is then the app's own
// page for it, which is this page).
// The app bundle carries no chain code, so the three field rules are restated here in their shortest form
// (packages/chain/src/coin-metadata.ts coinLinkProblem is the rule; apps/web/test/coin-links.test.ts holds the two together).
import { html, type Raw } from "./html.ts";

export interface CoinLinks {
  twitter?: string;
  telegram?: string;
  website?: string;
}
const COIN_LINK_KEYS = ["twitter", "telegram", "website"] as const;
const HOSTS: Record<(typeof COIN_LINK_KEYS)[number], RegExp | null> = { twitter: /^(www\.)?(x|twitter)\.com$/, telegram: /^(www\.)?t\.me$/, website: null };
/** Whether a link may be shown under this field: https, no credentials, the field's own site, nothing that could break out of an attribute. */
export function showableLink(k: (typeof COIN_LINK_KEYS)[number], v: string): boolean {
  if (v.length > 120 || /[\s<>"'`\\]/.test(v)) return false;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return false;
    const h = HOSTS[k];
    return !h || (h.test(u.hostname.toLowerCase()) && u.pathname.replace(/\/+$/, "") !== "");
  } catch {
    return false;
  }
}

const LABEL = { twitter: "Twitter (X)", telegram: "Telegram", website: "Website" } as const;
const answers = new Map<string, CoinLinks | Promise<CoinLinks>>();

/** The launcher's links in a metadata document: valid ones only, and never the app's own fallback website. */
export function linksOfDoc(doc: unknown, mint: string): CoinLinks {
  const out: CoinLinks = {};
  if (!doc || typeof doc !== "object") return out;
  for (const k of COIN_LINK_KEYS) {
    const v = (doc as Record<string, unknown>)[k];
    if (typeof v !== "string" || !showableLink(k, v)) continue;
    if (k === "website" && new RegExp(`/tokens/${mint}/?$`).test(v)) continue;
    out[k] = v;
  }
  return out;
}

/** The links as a row of labelled links; empty when there are none. */
export function coinLinksRow(l: CoinLinks): Raw {
  const have = COIN_LINK_KEYS.filter((k) => l[k]);
  if (!have.length) return html``;
  return html`<span class="coin-links" data-coin-links-n="${String(have.length)}">${have.map((k, i) => html`${i ? html` <span class="faint">·</span> ` : ""}<a class="link" href="${l[k]!}" target="_blank" rel="noopener nofollow ugc" data-coin-link="${k}">${LABEL[k]}</a>`)}</span>`;
}

/** A slot for the coin's links, filled once the coin's document answers; a repaint shows the kept answer at once. */
export function coinLinksSlot(mint: string | null | undefined, f: typeof fetch = fetch): Raw {
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return html``;
  const have = answers.get(mint);
  if (have && !(have instanceof Promise)) return html`<span data-coin-links="${mint}">${coinLinksRow(have)}</span>`;
  const p = have ?? f(`/coin/${mint}.json`, { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((doc) => linksOfDoc(doc, mint))
    .catch(() => ({}) as CoinLinks);
  if (!have) answers.set(mint, p);
  void p.then((links) => {
    answers.set(mint, links);
    const fill = () => {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-coin-links="${mint}"][data-pending]`)) {
        el.removeAttribute("data-pending");
        el.innerHTML = coinLinksRow(links).s;
      }
    };
    fill();
    for (const ms of [50, 250, 1000, 3000]) setTimeout(fill, ms);
  });
  return html`<span data-coin-links="${mint}" data-pending="1"></span>`;
}
