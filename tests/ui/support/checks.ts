import { expect, type Page } from "@playwright/test";

// Checks every page gets (docs/UI-TESTS.md): no horizontal page scroll and no em dash (U+2014) in the
// rendered text, titles or labels (cleanPage, called at the end of each test), and no monospace font
// on UI chrome (monoChrome, one test per page in typography.spec.ts).

/**
 * Code blocks may be set in any face; everything else is UI chrome and must not be monospace, with one
 * exemption: the design's own label and wordmark tokens in apps/web/public/app.css, var(--mono)
 * ("GeistMono" uppercase labels: nav, eyebrows, .sec-lbl, footer, ...) and var(--wordmark) ("Departure
 * Mono"), from the restyle the owner chose to keep (db3ba9b). An element is exempt only when its whole
 * computed font-family list equals one of those tokens as the page resolves them; a browser fallback,
 * a different stack or new ad hoc monospace CSS still fails.
 */
const MONO = /mono|courier|menlo|consolas|monaco/i;
const CODE = "pre, code, kbd, samp, textarea, svg";

export async function noHorizontalScroll(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(r.sw, `page scrollWidth ${r.sw} > viewport ${r.w}`).toBeLessThanOrEqual(r.w + 1);
}

export async function noEmDash(page: Page) {
  const hits = await page.evaluate(() => {
    const out: string[] = [];
    const text = `${document.title}\n${document.body?.innerText ?? ""}`;
    for (const m of text.matchAll(/.{0,40}\u2014.{0,40}/g)) out.push(m[0]);
    for (const el of document.querySelectorAll("[title], [aria-label], [placeholder], [alt]"))
      for (const a of ["title", "aria-label", "placeholder", "alt"]) {
        const v = el.getAttribute(a);
        if (v?.includes("\u2014")) out.push(`${a}="${v.slice(0, 80)}"`);
      }
    return out.slice(0, 10);
  });
  expect(hits, "em dashes in rendered text").toEqual([]);
}

/** Text-bearing elements outside code blocks whose first font family is a monospace face. */
export async function monoChrome(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ mono, code }) => {
      const re = new RegExp(mono, "i");
      const norm = (f: string) => f.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean).join(",");
      const root = getComputedStyle(document.documentElement);
      const tokens = new Set(["--mono", "--wordmark"].map((t) => root.getPropertyValue(t)).filter((v) => v.trim()).map(norm));
      // --wordmark is written as "Departure Mono", var(--mono): resolve the nested var as well
      for (const v of [...tokens]) if (v.includes("var(")) tokens.add(norm(v.replace(/var\(--mono\)/, root.getPropertyValue("--mono"))));
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        if (el.closest(code)) continue;
        // only elements that draw text of their own
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
        const ff = getComputedStyle(el).fontFamily;
        if (!re.test(ff.split(",")[0]!)) continue;
        if (tokens.has(norm(ff))) continue;
        out.push(`<${el.tagName.toLowerCase()} class="${typeof el.className === "string" ? el.className : ""}"> "${el.textContent!.trim().slice(0, 30)}" (${ff})`);
      }
      return out;
    },
    { mono: MONO.source, code: CODE },
  );
}

/** The generic checks at the end of a test (console errors are checked by the guard fixture). */
export async function cleanPage(page: Page) {
  await noHorizontalScroll(page);
  await noEmDash(page);
}
