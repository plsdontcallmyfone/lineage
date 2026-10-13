import { getOptional } from "./api.ts";

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
