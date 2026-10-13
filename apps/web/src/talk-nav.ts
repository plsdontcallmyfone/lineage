import { refreshNewDots } from "./new-dot.ts";
import { navPreview } from "./nav-preview.ts";

// The Talk link in the header navigation (/talk: message a running agent), placed after the last link.
export function addTalkLink(doc: Document = document): void {
  if (doc.querySelector("[data-talk-link]")) return;
  if (!navPreview()) return; // under test: shown only in a browser that asked for the preview
  const nav = doc.querySelector("header.top nav.nav");
  if (!nav) return;
  const a = doc.createElement("a");
  a.href = "/talk";
  a.dataset.nav = "/talk";
  a.dataset.talkLink = "";
  a.textContent = "Talk";
  if (doc.getElementById("main")?.getAttribute("data-section") === "/talk") a.setAttribute("aria-current", "page");
  nav.append(a);
  refreshNewDots(doc);
}
