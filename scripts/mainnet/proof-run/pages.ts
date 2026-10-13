#!/usr/bin/env bun
// Proof run, read only: opens pages of the live site headless with the test wallet connected (it signs nothing here),
// saves a 1280 px screenshot and the page's text for each, and says whether the navbar setup bar shows.
//   bun scripts/mainnet/proof-run/pages.ts --step <record key> name=/path [name=/path ...]
import { openPage, saveStep, SITE } from "./lib.ts";
const argv = process.argv.slice(2);
const STEP = argv[argv.indexOf("--step") + 1]!;
const pages = argv.filter((a) => /^[a-z0-9-]+=\//.test(a)).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] as const);
const P = await openPage({ send: false, guard: () => "read only" });
const out: Record<string, unknown> = {};
try {
  for (const [name, path] of pages) {
    await P.page.goto(`${SITE}${path}`);
    await P.connected().catch(() => {});
    await P.page.waitForFunction(() => (document.querySelector("main")?.textContent ?? "").length > 200, null, { timeout: 60_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 7000));
    const bar = P.page.locator("#setup-bar, [data-setup-bar], .sb-bar, [class^=sb-]");
    out[name] = { path, setup_bar_shown: (await bar.count()) > 0 && (await bar.first().isVisible().catch(() => false)), setup_bar_text: (await bar.first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300),
      nav: (await P.text("header, nav")).slice(0, 400), text: (await P.text("main")).slice(0, 6000), wallet_requests: P.requests.length };
    await P.shot(name);
    console.log(`${name}: ${JSON.stringify(out[name]).slice(0, 2600)}\n`);
  }
  out.page_errors = P.errors.slice(0, 12);
} finally {
  await P.browser.close();
}
saveStep(STEP, out);
