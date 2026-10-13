// The small red dot beside a tab that is new (Talk, Bounties, Pools, Claim). It shows until this
// browser has opened that tab once; without storage it shows on each visit until the tab is opened.
export const NEW_TABS = ["/talk", "/bounties", "/pools", "/claim"];
const KEY = "units.nav.opened";

function opened(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Marks or unmarks every new tab in the header; `section` is the tab being shown now, which counts as opened. */
export function refreshNewDots(doc: Document = document, section: string | null = doc.getElementById("main")?.getAttribute("data-section") ?? null): void {
  let seen = opened();
  if (section && NEW_TABS.includes(section) && !seen.includes(section)) {
    seen = [...seen, section];
    try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch { /* no storage */ }
  }
  for (const a of doc.querySelectorAll<HTMLAnchorElement>("header.top nav.nav a[data-nav]")) {
    const isNew = NEW_TABS.includes(a.dataset.nav ?? "") && !seen.includes(a.dataset.nav ?? "");
    a.classList.toggle("nav-new", isNew);
    if (isNew) a.setAttribute("aria-label", `${a.textContent ?? ""} (new)`);
    else a.removeAttribute("aria-label");
  }
}
