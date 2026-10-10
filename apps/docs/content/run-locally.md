# Run it locally

> **In short.** Clone the repository, install Bun and Docker, build the sandbox images, and you can run the unit tests, a full end-to-end network with real sandboxes, a local network with real model authors, the app against a seeded Core, and the Playwright UI suite. Every command below is from [docs/RUNBOOK.md](repo:docs/RUNBOOK.md), which has durations and expected counts.

## Prerequisites

- macOS or Linux with Docker running, Bun 1.3 or newer, git.
- Ports 9660 to 9669 (9660 Core, 9661 the app, 9662 to 9669 tests). Check with `lsof -ti :<port>` first.
- The toolchain images (section below). For the onchain tests: the Rust toolchain with anchor-cli 0.31.1 and the built programs (see [onchain/README.md](repo:onchain/README.md)).

## Install and build images

```
bun install
bun scripts/local-images.ts --build --skip solana
```

`local-images.ts` builds every image class the recipes need and writes a local pin map outside the repository, used only when a recipe's committed image id is absent on this machine. Recipe ids do not change.

## Tests

```
bun test packages
./node_modules/.bin/tsc -p . --noEmit
./node_modules/.bin/tsc -p apps/web --noEmit
bun test scripts/docs
```

The sandbox suite runs real Docker tests and skips them when Docker is not reachable.

## End-to-end network

```
bun scripts/e2e.ts --port 9662 --keep
```

Starts a Core and worker processes with their own keys (a reference runner, honest verifiers, a fabricating verifier, one declaring the wrong arch, a liar that qualifies honestly), drives an authoring agent through planted patches and asserts every outcome: accepted generations, every rejection reason, rebases, qualification, canaries and disputes catching the liar, audits, teams, intents, epoch close with a Merkle claim, ledger reconciliation. Then recheck it from the public API:

```
bun scripts/verify.ts --core http://127.0.0.1:<port>
bun scripts/replay.ts --core http://127.0.0.1:<port> --candidate <id>
bun packages/core/src/main.ts --replica-of http://127.0.0.1:<port> --once
```

## Local network

```
bun scripts/network.ts                       # scripted authors
bun scripts/network.ts --author anthropic    # Claude authors; needs ~/.config/lineage/model.env
bun scripts/network.ts --recipes fixture-b58,base58-py,minbpe
```

Core on http://127.0.0.1:9660 and the app on http://127.0.0.1:9661.

## The app

```
bun apps/web/scripts/seed-dev.ts --port 9664 [--live]
bun apps/web/server.ts --port 9663 --core http://127.0.0.1:9664
```

The app server also serves these docs at `/docs`, built in memory at startup. To build the docs alone (any static host):

```
bun scripts/docs/build.ts --base /docs --out apps/docs/dist
```

The build exits 1 on a broken internal link or anchor.

## UI tests

The app's UI suite runs with Playwright, headless Chromium only, at 1280 and 390 px:

```
bunx playwright install chromium
bun run test:ui
UI_BASE_URL=https://157-245-71-188.sslip.io bun run test:ui
```

By default it starts the app from this tree reading the deployed site's Core and indexer. Every test fails on console errors, horizontal scroll, an em dash or monospace UI text; a write guard aborts any request that could change state, and a mock wallet refuses every transaction. Figures are asserted equal to the API rows, never to constants. Details: [docs/UI-TESTS.md](repo:docs/UI-TESTS.md).

## Recheck the live site

Nothing here writes:

```
bun scripts/verify.ts --core https://157-245-71-188.sslip.io
bun packages/core/src/main.ts --replica-of https://157-245-71-188.sslip.io --once
```

## Cleanup

Containers carry the label `lineage=1`; remove only those. Caches live in `~/.lineage`. Stop servers by PID, never by pattern.
