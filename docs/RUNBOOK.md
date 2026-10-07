# Runbook (M1)

How to reproduce the M1 exit checks from a clean clone. Everything runs locally; no chain, no real tokens.

## Prerequisites

- macOS or Linux with Docker running (Docker Desktop on macOS is fine: containers already run inside a Linux VM).
- Bun 1.3 or newer, git.
- About 5 GB free disk for images, mirrors and dependency layers.
- Ports 9660 to 9669 free (this repo's block: 9660 Core, 9661 dashboard, 9662 to 9669 tests).

```sh
bun install
docker build -t lineage/rust:m1 images/rust
docker build -t lineage/python:m1 images/python
```

Recipes pin images by id (`name@sha256:<id>`). An image you build locally gets a different id than the one recorded in `recipes/*/recipe.yml` unless the base image and package versions match exactly; if `loadRecipe` or a replay reports the image as unavailable, rebuild the recipe ids with your local image ids (the recipe id then changes too, which is correct: a different image is a different recipe). M2 publishes the images to a registry so every worker pulls the same bytes.

## 1. Unit and integration tests

```sh
bun test packages
./node_modules/.bin/tsc -p . --noEmit
```

The sandbox suite includes real Docker tests (isolation, determinism, holdout seeds, parent series and conflicts); they are skipped when Docker is not reachable.

## 2. Planted patches, one sandbox replay each

```sh
bun fixtures/make-patches.ts      # regenerates fixtures/b58-patches from fixtures/b58 (idempotent)
bun fixtures/check-patches.ts     # evaluates each patch against gen 0 and judges it as a single replay
```

## 3. End-to-end network check

```sh
bun scripts/e2e.ts --port 9662
```

Starts a Core and five worker processes with their own keys (a reference runner, three honest verifiers, and one verifier that fabricates results), drives an authoring agent through every planted patch, and asserts each outcome: accepted perf and fix generations, every rejection reason, stale conflict and rebase, canaries and disputes catching the fabricating verifier, audits, epoch close with a Merkle claim, and ledger reconciliation. The result of the last run is written to `docs/E2E-LAST.json`.

## 4. Real repositories

```sh
bun scripts/calibrate-recipe.ts recipes/base58-py
bun scripts/calibrate-recipe.ts recipes/minbpe
```

Calibration results are committed in `recipes/<name>/calibration.json`. Hand-written candidate patches, when any were found, are in `recipes/<name>/candidates/`.

## 5. Local network with the dashboard

```sh
bun scripts/network.ts                       # scripted authors
bun scripts/network.ts --author anthropic    # Claude authors; needs ~/.config/lineage/model.env with ANTHROPIC_API_KEY
```

Core on http://127.0.0.1:9660, dashboard on http://127.0.0.1:9661. State persists in `./data` (Core) and `./.lineage-net` (keys). Ctrl-C stops every process the script started.

The Claude proposer uses `claude-opus-5-5` with adaptive thinking, server-side refusal fallbacks, prompt caching, and a hard spend cap per attempt (`--max-usd`, default 2 USD) computed from the response usage and the published per-token prices.

## Cleanup

- Containers are labelled `lineage=1`; remove leftovers with `docker ps -aq --filter label=lineage=1 | xargs docker rm -f`. Never prune globally on a shared machine.
- Caches live in `~/.lineage` (mirrors, dependency layers, work dirs). Deleting it is safe; it is rebuilt on demand.
