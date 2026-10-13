// Talk, Bounties and Claim are being tested (owner 2026-10-13): their links are not in the navigation
// or the footer for visitors. The pages themselves stay reachable by address. A tester turns the
// links on for one browser by opening any page with ?preview=1 (and off again with ?preview=0).
const KEY = "units.nav.preview";

/** Reads ?preview= once per load and remembers it; true when this browser shows the links under test. */
export function navPreview(loc: { search: string } = location): boolean {
  try {
    const q = new URLSearchParams(loc.search).get("preview");
    if (q === "1") localStorage.setItem(KEY, "1");
    else if (q === "0") localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
