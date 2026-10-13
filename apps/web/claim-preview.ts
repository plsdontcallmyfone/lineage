// The title and description of /claim/<owner>/<name> as a posted link shows them (owner 2026-10-13: the
// shareable page of the fees waiting for a repository's owners). The app is rendered in the browser, so
// a link preview would otherwise carry no words at all: the server writes these tags into the document
// it serves for that one path. The amount is Core's (GET /v1/fee-claims/waiting?repo=), in US dollars at
// the current price; when Core gives none (the feature is off, no dollar reading, nothing waiting) the
// title says what the page is and names no figure.

export const CLAIM_SHARE_PATH = /^\/claim\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** "$12.34", "$1,234", "$0.001234": the app's own rule for a dollar amount (apps/web/src/usd.ts fmtUsd). */
export function usdWords(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 12 })}`;
}

export interface Preview {
  title: string;
  description: string;
}

/** The words for one repository. `row` is Core's row for it (null: none, or Core did not answer). */
export function claimPreview(name: string, row: { repository?: { full_name?: unknown }; waiting?: unknown; waiting_usd?: unknown; agents?: unknown } | null): Preview {
  // Core answers by every name GitHub ever gave the repository, so its row may carry a newer name than the address: that one is shown
  const full = typeof row?.repository?.full_name === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(row.repository.full_name) ? row.repository.full_name : name;
  const usd = typeof row?.waiting_usd === "number" && Number.isFinite(row.waiting_usd) && row.waiting_usd > 0 && /^[1-9]\d*$/.test(String(row.waiting ?? "")) ? row.waiting_usd : null;
  const description = `Fees from agents working on ${full}, claimable by anyone with admin on the repository.`;
  return usd !== null ? { title: `${usdWords(usd)} is waiting for the owners of ${full}`, description } : { title: `Fees for the owners of ${full}`, description };
}

/** The document with the preview's tags in its head. */
export function withPreview(indexHtml: string, p: Preview, url: string | null): string {
  const tags = [
    `<title>${esc(p.title)} | units</title>`,
    `<meta name="description" content="${esc(p.description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="units">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    `<meta property="og:description" content="${esc(p.description)}">`,
    ...(url ? [`<meta property="og:url" content="${esc(url)}">`, `<link rel="canonical" href="${esc(url)}">`] : []),
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(p.title)}">`,
    `<meta name="twitter:description" content="${esc(p.description)}">`,
  ].join("\n");
  return indexHtml.replace(/<title>[^<]*<\/title>\n?/i, "").replace(/<\/head>/i, `${tags}\n</head>`);
}

const held = new Map<string, { at: number; p: Preview }>();
/** The preview for a repository, from Core, kept for a minute; the plain words when Core does not answer in time. */
export async function loadClaimPreview(core: string, name: string, f: typeof fetch = fetch, now: () => number = Date.now): Promise<Preview> {
  const key = name.toLowerCase();
  const have = held.get(key);
  if (have && now() - have.at < 60_000) return have.p;
  let row: Parameters<typeof claimPreview>[1] = null;
  try {
    const r = await f(`${core}/v1/fee-claims/waiting?repo=${encodeURIComponent(name)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(2_500) });
    if (r.ok) row = ((await r.json()) as { repositories?: Parameters<typeof claimPreview>[1][] }).repositories?.[0] ?? null;
  } catch {
    row = null;
  }
  const p = claimPreview(name, row);
  if (held.size > 500) held.clear();
  held.set(key, { at: now(), p });
  return p;
}
