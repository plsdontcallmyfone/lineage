import { defineConfig, devices } from "@playwright/test";

// The Lineage app's UI suite (docs/UI-TESTS.md). By default Playwright starts the dashboard built from
// this tree on 127.0.0.1:<UI_PORT> against the deployed site's live Core and market indexer:
//
//   bun apps/web/server.ts --port 9661 --core <site> --market <site> --upstream <site>
//
// UI_BASE_URL points the suite at a running app instead (for example the deployed site itself) and
// skips the local server. UI_SITE picks the site the local server reads from.

const SITE = (process.env.UI_SITE ?? "https://157-245-71-188.sslip.io").replace(/\/+$/, "");
const PORT = Number(process.env.UI_PORT ?? 9661);
const EXTERNAL = process.env.UI_BASE_URL?.replace(/\/+$/, "");
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;

const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 };
// a 390 px phone viewport on Chromium (touch and a mobile user agent, like a current iPhone width)
const mobile = { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

export default defineConfig({
  testDir: "tests/ui",
  outputDir: "tests/ui/.results",
  // the site's gate rate-limits Core reads per address (scripts/deploy/gate.ts): a few workers, not one per core
  workers: Number(process.env.UI_WORKERS ?? 2),
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  globalTimeout: 60 * 60 * 1000,
  reporter: [["list"], ["html", { outputFolder: "tests/ui/.report", open: "never" }]],
  use: {
    baseURL: BASE,
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
  },
  projects: [
    { name: "desktop-light", use: { ...desktop, colorScheme: "light" } },
    { name: "desktop-dark", use: { ...desktop, colorScheme: "dark" } },
    { name: "mobile-light", use: { ...mobile, colorScheme: "light" } },
    { name: "mobile-dark", use: { ...mobile, colorScheme: "dark" } },
  ],
  webServer: EXTERNAL
    ? undefined
    : {
        command: `bun apps/web/server.ts --port ${PORT} --core ${SITE} --market ${SITE} --upstream ${SITE}`,
        url: `${BASE}/chain/config`,
        // a developer's own dashboard already on the port is reused locally; CI always starts a fresh one
        reuseExistingServer: !CI && process.env.UI_REUSE !== "0",
        timeout: 180_000,
        stdout: "ignore",
        stderr: "pipe",
        gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
      },
});
