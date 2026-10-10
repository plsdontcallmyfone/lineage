// Pieces of the browser window the panel draws: toolbar and tab icons in the style of Chrome's
// current desktop UI (outlined 20 px glyphs), the address the agent is looking at, and favicons.
// No product logos: favicons are site initials or generic glyphs.

const ico = (d: string, vb = "0 0 20 20", sw = 1.6) =>
  `<svg viewBox="${vb}" width="20" height="20" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const C = {
  back: ico('<path d="M16 10H4.5M9.5 4.8L4.3 10l5.2 5.2"/>'),
  fwd: ico('<path d="M4 10h11.5M10.5 4.8l5.2 5.2-5.2 5.2"/>'),
  reload: ico('<path d="M15.6 10a5.6 5.6 0 11-1.7-4"/><path d="M14.4 2.9v3.6h-3.6"/>'),
  tune: ico('<path d="M3.5 6.5h7M14.5 6.5h2M3.5 13.5h2M9.5 13.5h7"/><circle cx="12.5" cy="6.5" r="2"/><circle cx="7.5" cy="13.5" r="2"/>', "0 0 20 20", 1.5),
  star: ico('<path d="M10 3.2l2 4.3 4.6.5-3.4 3.1 1 4.6L10 13.4l-4.2 2.3 1-4.6-3.4-3.1 4.6-.5z"/>', "0 0 20 20", 1.4),
  puzzle: ico('<path d="M8 3.5a1.7 1.7 0 013.4 0V5h3.1v3.1H16a1.7 1.7 0 010 3.4h-1.5v4h-4v-1.4a1.7 1.7 0 00-3.4 0v1.4h-3.6v-3.6h1.4a1.7 1.7 0 000-3.4H3.5V5H8z"/>', "0 0 20 20", 1.4),
  kebab: `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="10" cy="4.6" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="15.4" r="1.5" fill="currentColor"/></svg>`,
  plus: ico('<path d="M10 4.5v11M4.5 10h11"/>'),
  close: ico('<path d="M6 6l8 8M14 6l-8 8"/>', "0 0 20 20", 1.7),
  chevron: ico('<path d="M5.5 8l4.5 4.5L14.5 8"/>'),
  globe: ico('<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c-2.2 2.3-2.2 10.7 0 13M10 3.5c2.2 2.3 2.2 10.7 0 13"/>', "0 0 20 20", 1.3),
  // page glyphs (GitHub-like file view)
  file: ico('<path d="M5 2.8h6l4 4v10.4H5z"/><path d="M11 2.8v4h4"/>', "0 0 20 20", 1.3),
  folder: ico('<path d="M2.8 5.2h5l1.6 1.8h7.8v8.8H2.8z"/>', "0 0 20 20", 1.3),
  repo: ico('<path d="M5 3h10.5v12H6.3A1.8 1.8 0 004.5 16.8V4.5A1.5 1.5 0 016 3"/><path d="M4.5 16.8A1.3 1.3 0 005.8 18h1.7M10 18h5.5v-3"/>', "0 0 20 20", 1.3),
  branch: ico('<circle cx="6" cy="4.5" r="1.8"/><circle cx="6" cy="15.5" r="1.8"/><circle cx="14" cy="7" r="1.8"/><path d="M6 6.3v7.4M14 8.8c0 3-2.6 3.6-6.2 4.3"/>', "0 0 20 20", 1.3),
  search: ico('<circle cx="8.6" cy="8.6" r="5"/><path d="M12.4 12.4l4.3 4.3"/>', "0 0 20 20", 1.5),
  lock: ico('<rect x="4.5" y="8.5" width="11" height="8" rx="1.6"/><path d="M7 8.5V6.3a3 3 0 016 0v2.2"/>', "0 0 20 20", 1.4),
  copy: ico('<rect x="7" y="7" width="9" height="9.5" rx="1.5"/><path d="M13 7V4.8A1.3 1.3 0 0011.7 3.5H4.8A1.3 1.3 0 003.5 4.8v6.9A1.3 1.3 0 004.8 13H7"/>', "0 0 20 20", 1.3),
  check: ico('<path d="M4.5 10.5l3.5 3.5 7.5-8"/>', "0 0 20 20", 1.8),
  x: ico('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>', "0 0 20 20", 1.8),
  term: ico('<rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2"/><path d="M6 8l2.6 2.2L6 12.4M10.4 12.6h3.6"/>', "0 0 20 20", 1.3),
  // deck controls
  play: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3.2v9.6l7.5-4.8z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3.5v9M11 3.5v9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  restart: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v4h4"/><path d="M3.4 9.5A5 5 0 103.9 5"/></svg>`,
};

/** "https://github.com/karpathy/minbpe(.git)" to { host, path: "karpathy/minbpe" }. */
export function repoParts(u: string | null): { host: string; path: string } {
  if (!u) return { host: "", path: "repository" };
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(u);
  return m ? { host: m[1]!, path: m[2]! } : { host: "", path: u };
}

export type Place =
  | { kind: "home" }
  | { kind: "file"; path: string; start?: number; end?: number }
  | { kind: "search"; q: string }
  | { kind: "sandbox"; run: number }
  | { kind: "new" };

/**
 * The address shown in the omnibox, split into the emphasised host and the dimmed rest, as Chrome
 * draws it (scheme hidden). Files and searches use the repository host's own URL shapes.
 */
export function addressOf(repo: string | null, commit: string, place: Place): { host: string; rest: string; secure: boolean } {
  const r = repoParts(repo);
  const sha = commit.slice(0, 7);
  const base = r.host ? `/${r.path}` : "";
  switch (place.kind) {
    case "new":
      return { host: "", rest: "", secure: false };
    case "sandbox":
      return { host: "lineage://sandbox", rest: `/run-${place.run}`, secure: false };
    case "home":
      return { host: r.host || "repository", rest: `${base}/tree/${sha}`, secure: !!r.host };
    case "search":
      return { host: r.host || "repository", rest: `${base}/search?q=${encodeURIComponent(place.q).replace(/%20/g, "+")}&type=code`, secure: !!r.host };
    case "file": {
      const hash = place.start ? (place.end && place.end !== place.start ? `#L${place.start}-L${place.end}` : `#L${place.start}`) : "";
      return { host: r.host || "repository", rest: `${base}/blob/${sha}/${place.path}${hash}`, secure: !!r.host };
    }
  }
}

/** A favicon: the site's initial on a rounded square, or a generic glyph for internal pages. */
export function favicon(kind: "site" | "sandbox" | "new", host: string): string {
  if (kind === "sandbox") return `<span class="cr-fav cr-fav-g">${C.term}</span>`;
  if (kind === "new") return `<span class="cr-fav cr-fav-g">${C.globe}</span>`;
  const ch = (host.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  return `<span class="cr-fav cr-fav-s" aria-hidden="true">${ch}</span>`;
}

/** Tab titles in the shape the site gives its pages. */
export function titleOf(repo: string | null, commit: string, place: Place): string {
  const r = repoParts(repo);
  switch (place.kind) {
    case "new":
      return "New Tab";
    case "sandbox":
      return `Sandbox run ${place.run}`;
    case "home":
      return `${r.path} at ${commit.slice(0, 7)}`;
    case "search":
      return `Code search results`;
    case "file":
      return `${place.path.split("/").pop()} at ${commit.slice(0, 7)} · ${r.path}`;
  }
}
