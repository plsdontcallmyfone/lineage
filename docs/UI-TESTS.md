# UI tests (Playwright)

The app's UI suite lives in `tests/ui` and runs with [@playwright/test](https://playwright.dev/) (pinned in
`package.json`), headless Chromium only. It replaces the ad hoc playwright-core scripts for the app
(`apps/web/scripts/app-check.ts` and friends) as the one command a developer runs.

## Install

    bun install
    bunx playwright install chromium

Browsers go to Playwright's default cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright`
on Linux), about 200 MB.

## Run

    bun run test:ui                      # all projects, against a local dashboard on live site data
    bun run test:ui -- explorer          # one spec file (any name filter)
    bun run test:ui -- --project desktop-light
    bun run test:ui:report               # open the HTML report of the last run

By default Playwright starts the dashboard built from this tree,
`bun apps/web/server.ts --port 9661 --core <site> --market <site> --upstream <site>`, reading the deployed
site's Core and market indexer. Environment:

| Variable | Default | Meaning |
|---|---|---|
| `UI_BASE_URL` | unset | test a running app instead (no local server), e.g. `UI_BASE_URL=https://157-245-71-188.sslip.io` for the deployed site |
| `UI_SITE` | `https://157-245-71-188.sslip.io` | the site the local dashboard reads from |
| `UI_PORT` | `9661` | the local dashboard's port (this repo owns 9660-9669; `lsof -ti :<port>` first) |
| `UI_REUSE` | reuse | a dashboard already on `UI_PORT` is reused outside CI; `UI_REUSE=0` refuses to |
| `UI_WORKERS` | `2` | parallel workers (the site's gate rate-limits reads per address) |
| `UI_WALLET_KEY` | `~/.config/lineage/devnet/app-launch-test.json` | key of the mock wallet (see below) |

Projects: `desktop-light` (1280 px) and `mobile-light` (390 px); the app has one theme. Retries: 1
locally, 2 in CI. A trace is kept on the first retry, a screenshot on failure.

## Reading the report

`bun run test:ui:report` serves `tests/ui/.report` (gitignored; artifacts in `tests/ui/.results`). Each
failed test has its screenshot, error context (page snapshot) and, if it was retried, a trace: open it
from the report or with `bunx playwright show-trace <trace.zip>`.

## What every test gets (tests/ui/support)

- `fixtures.ts`: the theme follows the project's colorScheme; console errors and page errors fail the test
  (allow-list `CONSOLE_ALLOW`, each entry with its reason); a write guard aborts and fails on any request
  that could change state (only reads, devnet RPC reads and simulations, and routes a test answers itself
  pass), so no transaction can be sent. Third-party POSTs pass only from `THIRD_PARTY_POSTS`, matched by
  exact host and then path prefix: Privy's analytics events (`auth.privy.io/api/v1/analytics_events`) and
  the Cloudflare bot check in front of Privy (`auth.privy.io/cdn-cgi/challenge-platform/`), which Privy's
  SDK sends once Connect opens its modal. They write nothing to Lineage; any other path on that host (a
  Privy login or session call) or any other host still fails the test; a read pacer keeps Core, indexer and RPC reads under the site
  gate's per-address limits (retries 429s, caches identical Core reads for 30 s; responses stay live).
  `data` reads the same indexer and Core the page uses, so figures are asserted equal to the API, never
  hardcoded.
- `wallet.ts`: a mock Wallet Standard wallet (named `MOCK_WALLET_NAME`). It connects and signs messages with the app-check test
  wallet's key (it launched TLAMP and holds devnet tLINE) and refuses every transaction. Without that key
  (CI) a throwaway key is used and the checks that need a funded launcher (the Launch review simulation)
  are skipped.
- `checks.ts`: `cleanPage(page)` (no horizontal scroll, no em dash in rendered text or labels) at the end of
  each test, and `monoChrome(page)` (typography.spec.ts, one test per page): no monospace font on UI
  chrome outside `pre`, `code`, `kbd`, `samp`, `textarea`. **Exempt**: the design's own tokens in
  `apps/web/public/app.css`, `var(--mono)` (GeistMono uppercase labels: nav, eyebrows, `.sec-lbl`,
  footer, ...) and `var(--wordmark)` (Departure Mono), kept by the owner from the restyle in db3ba9b. An
  element is exempt only when its whole computed font-family list equals one of those tokens; a browser
  fallback, another stack or new ad hoc monospace CSS fails.
- `figures.ts`: reads the exact value each figure carries (title or data-v) and checks it and its
  formatting against the API row. The formatters mirror `apps/web/src/market.ts`; change both together.

## Adding a test

1. Put a `*.spec.ts` in `tests/ui` and import `test`, `expect` from `./support/fixtures.ts` (not from
   `@playwright/test`, or the guard and pacer are skipped).
2. Navigate with relative paths (`page.goto("/agents")`); take ids and figures from `data` (live rows),
   never from constants.
3. Wait for the page's own content (`locator(...).waitFor()`), assert, and end with `await cleanPage(page)`.
4. Needs the wallet? Add the `wallet` fixture and connect it as a returning visitor: set localStorage
   `lineage-wallet` to `MOCK_WALLET_NAME` and reload; the site reconnects the remembered Wallet Standard
   wallet silently (`restoreSession` in `apps/web/wallet/standard.ts`). Clicking `#cn-btn` opens Privy's
   login modal (apps/web/privy/main.tsx), which a test cannot finish without a real Privy login; see
   `connect()` in `profile-launch.spec.ts`. Never press a button that sends.
5. Run it in one project first (`bun run test:ui -- myspec --project desktop-light`), then both.
