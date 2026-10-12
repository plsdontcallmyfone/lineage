import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The units app's UI suite (docs/UI-TESTS.md). The default site is the mainnet site (the repository's
// default network, config/sites.json mainnet_site_url). By default Playwright starts the dashboard built
// from this tree on 127.0.0.1:<UI_PORT> against that site's live Core and market indexer:
//
//   UNITS_NETWORK=<network> bun apps/web/server.ts --port 9661 --site <site> --core <site> --market <site> --upstream <site>
//
// UI_BASE_URL points the suite at a running app instead (for example a deployed site itself) and skips
// the local server. UI_SITE picks the site the local server reads from: UI_SITE=devnet (or the devnet
// site's URL) for the devnet site, which has listed coins; UI_NETWORK names the network of any other
// site. The data-driven specs skip, with the reason, on a site that lists no agent coin.

const sites = JSON.parse(readFileSync(join(__dirname, "config/sites.json"), "utf8")) as { mainnet_site_url: string; devnet_site_url: string };
const named: Record<string, string> = { mainnet: sites.mainnet_site_url, devnet: sites.devnet_site_url };
const pick = process.env.UI_SITE ?? "mainnet";
const SITE = (named[pick] ?? pick).replace(/\/+$/, "");
// the local dashboard's network profile must be the site's (apps/web/server.ts reads UNITS_NETWORK)
const NETWORK = process.env.UI_NETWORK ?? (SITE === sites.devnet_site_url.replace(/\/+$/, "") ? "devnet" : "mainnet");
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
    { name: "mobile-light", use: { ...mobile, colorScheme: "light" } },
  ],
  webServer: EXTERNAL
    ? undefined
    : {
        command: `bun apps/web/server.ts --port ${PORT} --site ${SITE} --core ${SITE} --market ${SITE} --upstream ${SITE}`,
        env: { ...(process.env as Record<string, string>), UNITS_NETWORK: NETWORK },
        url: `${BASE}/chain/config`,
        // a developer's own dashboard already on the port is reused locally; CI always starts a fresh one
        reuseExistingServer: !CI && process.env.UI_REUSE !== "0",
        timeout: 180_000,
        stdout: "ignore",
        stderr: "pipe",
        gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
      },
});
