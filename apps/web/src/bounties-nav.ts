import { getOptional } from "./api.ts";
import { refreshNewDots } from "./new-dot.ts";

// The Bounties link in the header navigation and the footer. It is added only once Core's board
// answers with settings (the board is open): where bounties are not open the link does not exist,
// so the closed state is never advertised. /bounties itself stays reachable and says so.
interface BoardOpen { settings: unknown | null; escrow?: unknown | null }

export const boardOpen = (b: BoardOpen | null | undefined): boolean => !!b && (!!b.settings || !!b.escrow);

/** Adds the two links once, in the same markup as their neighbours. `section` is the current nav section. */
export function addBountiesLinks(doc: Document, section: string | null): void {
  if (doc.querySelector("[data-bounties-link]")) return;
  const nav = doc.querySelector("header.top nav.nav");
  if (nav) {
    const a = doc.createElement("a");
    a.href = "/bounties";
    a.dataset.nav = "/bounties";
    a.dataset.bountiesLink = "";
    a.textContent = "Bounties";
    if (section === "/bounties") a.setAttribute("aria-current", "page");
    nav.append(a);
  }
  const list = doc.querySelector('#footer nav.sf-col[aria-label="Network"] .sf-col-list');
  if (list) {
    const li = doc.createElement("li");
    const a = doc.createElement("a");
    a.className = "sf-col-link";
    a.href = "/bounties";
    a.dataset.bountiesLink = "";
    a.textContent = "Bounties";
    li.append(a);
    list.append(li);
  }
}

/** One read of the board after the shell is drawn; a Core without the route, or a closed board, adds nothing. */
export async function wireBountiesLinks(doc: Document = document): Promise<void> {
  const board = await getOptional<BoardOpen>("bounties/board").catch(() => null);
  if (boardOpen(board)) addBountiesLinks(doc, doc.getElementById("main")?.getAttribute("data-section") ?? null);
}

// The Pools and Claim links, by the same rule as Bounties: each is added only where its feature is
// open on this deployment (Core serves a pool config; Core serves the claim providers), in the header
// navigation and the footer's Network column. Their pages stay reachable either way.
function addFeatureLink(doc: Document, section: string | null, href: string, label: string): void {
  if (doc.querySelector(`[data-feature-link="${href}"]`)) return;
  const nav = doc.querySelector("header.top nav.nav");
  if (nav) {
    const a = doc.createElement("a");
    a.href = href;
    a.dataset.nav = href;
    a.dataset.featureLink = href;
    a.textContent = label;
    if (section === href) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
  const list = doc.querySelector('#footer nav.sf-col[aria-label="Network"] .sf-col-list');
  if (list) {
    const li = doc.createElement("li");
    const a = doc.createElement("a");
    a.className = "sf-col-link";
    a.href = href;
    a.dataset.featureLink = href;
    a.textContent = label;
    li.append(a);
    list.append(li);
  }
}

export const poolsOpen = (p: { config?: unknown | null } | null | undefined): boolean => !!p && !!p.config;
export const claimsOpen = (p: { attestor?: unknown | null } | null | undefined): boolean => !!p && !!p.attestor;

// What this browser last saw open. A link that was shown stays shown while a read fails (a refused or
// rate limited read is not "closed"): only an answered read that says closed takes it away again.
const SEEN = "units.nav.open";
type Seen = { bounties?: boolean; pools?: boolean; claim?: boolean };
function seen(): Seen {
  try { return JSON.parse(localStorage.getItem(SEEN) ?? "{}") as Seen; } catch { return {}; }
}
function remember(k: keyof Seen, open: boolean): void {
  try { localStorage.setItem(SEEN, JSON.stringify({ ...seen(), [k]: open })); } catch { /* no storage: the links follow each read */ }
}

/** The three feature links in a fixed order (Bounties, Pools, Claim): first from what was last seen, then from one read each, asked again once if a read fails. */
export async function wireFeatureLinks(doc: Document = document): Promise<void> {
  const section = () => doc.getElementById("main")?.getAttribute("data-section") ?? null;
  const draw = () => {
    const s = seen();
    if (s.bounties) addBountiesLinks(doc, section());
    if (s.pools) addFeatureLink(doc, section(), "/pools", "Pools");
    if (s.claim) addFeatureLink(doc, section(), "/claim", "Claim");
    refreshNewDots(doc);
  };
  draw();
  const once = async (): Promise<boolean> => {
    const [board, pools, claims] = await Promise.all([
      getOptional<BoardOpen>("bounties/board").catch(() => undefined),
      getOptional<{ config?: unknown | null }>("pools").catch(() => undefined),
      getOptional<{ attestor?: unknown | null }>("fee-claims/providers").catch(() => undefined),
    ]);
    if (board !== undefined && board !== null) remember("bounties", boardOpen(board));
    if (pools !== undefined && pools !== null) remember("pools", poolsOpen(pools));
    if (claims !== undefined && claims !== null) remember("claim", claimsOpen(claims));
    draw();
    return board != null && pools != null && claims != null;
  };
  if (!(await once())) setTimeout(() => void once(), 6_000);
}
