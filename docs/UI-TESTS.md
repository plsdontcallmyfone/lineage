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

    bun run test:ui                      # all projects, a local dashboard on the mainnet site's live data
    UI_SITE=devnet bun run test:ui       # the same against the devnet site (it has listed coins)
    bun run test:ui -- explorer          # one spec file (any name filter)
    bun run test:ui -- --project desktop-light
    bun run test:ui:report               # open the HTML report of the last run

By default Playwright starts the dashboard built from this tree,
`UNITS_NETWORK=<network> bun apps/web/server.ts --port 9661 --site <site> --core <site> --market <site> --upstream <site>`,
reading the deployed site's Core and market indexer. The default site is the mainnet site (the
repository's default network, `config/sites.json` `mainnet_site_url`). Environment:

| Variable | Default | Meaning |
|---|---|---|
| `UI_BASE_URL` | unset | test a running app instead (no local server), e.g. `UI_BASE_URL=https://main-157-245-71-188.sslip.io` for the deployed mainnet site or `UI_BASE_URL=https://157-245-71-188.sslip.io` for the devnet one |
| `UI_SITE` | `mainnet` | the site the local dashboard reads from: `mainnet`, `devnet` (both from `config/sites.json`) or a site URL |
| `UI_NETWORK` | from `UI_SITE` | the network profile of the local dashboard (`mainnet` or `devnet`); only needed for a site URL that is neither of the two |
| `UI_PORT` | `9661` | the local dashboard's port (this repo owns 9660-9669; `lsof -ti :<port>` first) |
| `UI_REUSE` | reuse | a dashboard already on `UI_PORT` is reused outside CI; `UI_REUSE=0` refuses to |
| `UI_WORKERS` | `2` | parallel workers (the site's gate rate-limits reads per address) |
| `UI_WALLET_KEY` | `~/.config/lineage/devnet/app-launch-test.json` | key of the mock wallet (see below) |

Projects: `desktop-light` (1280 px) and `mobile-light` (390 px); the app has one theme. Retries: 1
locally, 2 in CI. A trace is kept on the first retry, a screenshot on failure.

## Two sites, one suite

The specs read the network of the app under test from its `GET /chain/config` (`data.network()`) and
assert the wording of that network: on mainnet nothing says devnet, TEST, test tokens, faucet or tUNITS;
on devnet the TEST name prefix and the "Devnet test tokens, no value" line are expected.

A site that lists no agent coin (the mainnet site before its first launch) has no card, token page or
agent profile to compare with the API. The data-driven tests take their rows from `data.coins()`, which
skips the test with that reason when `GET /market/tokens` is empty; the page-level tests (routes, nav,
empty states, Launch, Profile, Analytics, typography) still run. Run against devnet to exercise the
figures.

The Launch total comes from a simulation of the launch, which the chain refuses for a wallet with no
SOL. The stored test wallet is funded on devnet only, so on mainnet the funding and review steps are
checked in that state: no figure, "Launch disabled: this wallet holds no SOL, and the launch is paid in
SOL", cost lines "not simulated". On devnet the same tests require the dollar total and its SOL amount.

## Reading the report

`bun run test:ui:report` serves `tests/ui/.report` (gitignored; artifacts in `tests/ui/.results`). Each
failed test has its screenshot, error context (page snapshot) and, if it was retried, a trace: open it
from the report or with `bunx playwright show-trace <trace.zip>`.

## What every test gets (tests/ui/support)

- `fixtures.ts`: the theme follows the project's colorScheme; console errors and page errors fail the test
  (allow-list `CONSOLE_ALLOW`, each entry with its reason); a write guard aborts and fails on any request
  that could change state (only reads, RPC reads and simulations, and routes a test answers itself
  pass), so no transaction can be sent. Third-party POSTs pass only from `THIRD_PARTY_POSTS`, matched by
  exact host and then path prefix: Privy's analytics events (`auth.privy.io/api/v1/analytics_events`) and
  the Cloudflare bot check in front of Privy (`auth.privy.io/cdn-cgi/challenge-platform/`), which Privy's
  SDK sends once Connect opens its modal. They write nothing to units; any other path on that host (a
  Privy login or session call) or any other host still fails the test; a read pacer keeps Core, indexer and RPC reads under the site
  gate's per-address limits (retries 429s, caches identical Core reads for 30 s; responses stay live).
  `data` reads the same indexer and Core the page uses, so figures are asserted equal to the API, never
  hardcoded; `data.network()` is the site's network and `data.coins()` the listed tokens or a skip.
- `wallet.ts`: a mock Wallet Standard wallet (named `MOCK_WALLET_NAME`). It connects and signs messages with the app-check test
  wallet's key (it launched TLAMP and holds devnet UNITS; it holds nothing on mainnet) and refuses every transaction. It offers
  both clusters (`solana:devnet`, `solana:mainnet`), so the app accepts it on either site. Without that key
  (CI) a throwaway key is used and the checks that need a funded launcher (the Launch review simulation)
  are skipped.
- `checks.ts`: `cleanPage(page)` (no horizontal scroll, no em dash in rendered text or labels) at the end of
  each test, and `monoChrome(page)` (typography.spec.ts, one test per page): no monospace font on UI
  chrome outside `pre`, `code`, `kbd`, `samp`, `textarea`. **Exempt**: the design's own tokens in
  `apps/web/public/app.css`, `var(--mono)` (GeistMono uppercase labels: nav, eyebrows, `.sec-lbl`,
  footer, ...) and `var(--wordmark)` (Departure Mono), kept by the owner from the restyle in db3ba9b. An
  element is exempt only when its whole computed font-family list equals one of those tokens; a browser
  fallback, another stack or new ad hoc monospace CSS fails.
- `figures.ts`: money is in US dollars. It reads the exact dollar value each figure carries (`data-v`) and
  the API field it names (`data-f`, e.g. `price_usd`), and checks both and the visible text against the
  API row's `_usd` fields, through the app's own formatter (`apps/web/src/usd.ts`, imported, so the two
  cannot drift). A figure that exists without a dollar price must read "$ unavailable", never the
  quote-coin number; the 24h change is of the dollar price where the indexer has one.

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
