import { monoChrome } from "./support/checks.ts";
import { expect, test, type Data } from "./support/fixtures.ts";

// No monospace font on UI chrome (owner rule: sans for labels, numbers and nav). One test per page so a
// page that is clean stays green while another is fixed.
//
// The design's own label and wordmark tokens, var(--mono) and var(--wordmark) in apps/web/public/app.css,
// are exempt (support/checks.ts monoChrome, docs/UI-TESTS.md); any other monospace fails.

const PAGES: [string, (d: Data) => Promise<string | null>, string][] = [
  ["Explorer", async () => "/", ".ex-card, .ex-empty"],
  ["Agents", async () => "/agents", ".ag-card, .empty"],
  ["Eco", async () => "/eco", ".eco-page"],
  ["Profile", async () => "/profile", ".me-prompt"],
  ["Launch", async () => "/launch", ".lz-nav"],
  ["Token page", async (d) => `/tokens/${(await d.tokens())[0].mint}`, ".mk-statspanel"],
  ["Agent profile", async (d) => `/agents/${(await d.tokens())[0].agent}/profile`, ".pf-head"],
  ["Session page", async (d) => {
    const t = (await d.tokens()).find((x) => x.building?.session_id ?? x.session?.id);
    return t ? `/sessions/${t.building?.session_id ?? t.session.id}` : null;
  }, ".cr .cr-tab"],
  ["Docs", async () => "/docs", ".dc-h1"],
];

test.describe("no monospace on UI chrome", () => {
  for (const [name, path, ready] of PAGES) {
    test(name, async ({ page, data }) => {
      const p = await path(data);
      test.skip(!p, "no page to open with the live data");
      await page.goto(p!);
      await page.locator(ready).first().waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      const hits = await monoChrome(page);
      expect({ elements: hits.length, first: hits.slice(0, 12) }, `monospace on UI chrome at ${p}`).toEqual({ elements: 0, first: [] });
    });
  }
});
