# Verification record

Every check a new developer can run, run from a clean clone and recorded as seen. Nothing below is
marked PASS without its output having been read. Logs of this run are in the verification lane's
session scratchpad (not committed); the commands are in `docs/RUNBOOK.md`. The previous record (the
2026-10-07 verification lane) is in this file's git history.

## Run

| | |
|---|---|
| Date | 2026-10-08 16:55 to 18:15 (UTC-3); 19:55 to 21:15 UTC |
| Clean clone | `git clone /Users/achi/lineage` at `95db842`, `bun install --frozen-lockfile`; fix files copied in as they were made; finally pulled to `2c98194` (which adds another lane's Core qualification change) for rows 1b, 4b and 8b |
| Fixes | 3 commits: `db69af2`, `73ef190`, `5b40ad4` (list below) |
| Machine | Apple M4, 10 cores, 16 GB, macOS 26.5.1, arm64 |
| Docker | Docker Desktop 29.8.1, VM with 10 CPUs and 7.9 GB; images reused, not rebuilt (`lineage/rust:m1`, `lineage/python:m1`, `lineage/go:1.26.8`, `lineage/cpp:gcc14`, `lineage/zig:0.15.2`, `lineage/solana:m1`) |
| Toolchain | Bun 1.3.13, TypeScript 5.9.3, rustc 1.94.1, anchor-cli 0.31.1, solana-cli 3.1.12, playwright-core 1.63.0 with chrome-headless-shell v1243 |
| Onchain binaries | `onchain/target/deploy/*.so` and `onchain/vendor/meteora/*.so` copied from the main tree into the clone (neither is committed); a fresh cargo target dir in the scratchpad, deleted after |
| Disk | 6.3 GB free at the start, lowest 4.3 GB; never below the 3 GB floor |

## Checks

Status: PASS (seen passing), FAIL (seen failing; each has a fix below and a later PASS row), NOT RUN (reason and last recorded result given).

| # | Check | Command | Status | Counts | Duration |
|---|---|---|---|---|---|
| 1 | Install | `bun install --frozen-lockfile` | PASS | 22 packages | under 1 s |
| 1b | Typecheck, root and dashboard | `./node_modules/.bin/tsc -p . --noEmit`, `-p apps/web` | PASS | 0 errors at `95db842` and at `2c98194` | 4.5 s, 2.8 s |
| 4 | Unit and integration tests | `bun test packages` | PASS | 444/444, 3,028 expects, real Docker tests included (at `95db842`) | 133 s |
| 4b | Same at the final commit | `bun test packages` | PASS | 444/444, 3,028 expects (at `2c98194`) | 114 s |
| 4c | Finishing lanes' unit tests (inside row 4, run alone) | see RUNBOOK section 1 | PASS | W1+W2 mirror, PR bot, upstream 14/14; W4 Shapley, split, ports 20/20; W5 links 4/4; W6 findings, recipe proposals, discovery 15/15; W7 challenges and replica 20/20; site deploy gate 7/7 | under 4 s each |
| 5 | Onchain LiteSVM suites | `cargo test --offline -p lineage-onchain-tests` | PASS | 56/56: bounty 10, challenge 6, client_vectors 1, identity 7, launch 13, msg 6, registry 13 | 57 s (cold target dir) |
| 6 | Leaf encoder | `cargo test --offline -p lineage-registry --lib` | PASS | 3/3 | 15 s |
| 7 | Merkle fixtures current | `bun onchain/scripts/make-fixtures.ts --check` | PASS | `merkle.json current` | under 1 s |
| 8 | End-to-end network, incl. the W4 collab extras (`scripts/e2e-collab-extras.ts`, imported by e2e.ts: measured split and ports on a second lineage) | `bun scripts/e2e.ts --port 9662 --keep` | PASS | 83/83, including the collab extras checks | 273 s |
| 8b | Same at the final commit, without `--keep` | `bun scripts/e2e.ts --port 9662` | PASS | 83/83; the second lineage's temp recipe dir is removed (fix 1); `docs/E2E-LAST.json` | 364 s |
| 9 | Planted patches | `bun fixtures/make-patches.ts`, `bun fixtures/check-patches.ts` | PASS | 12/12 as expected for a single replay against gen 0 | 93 s |
| 10 | Recompute every verdict, kept e2e Core | `bun scripts/verify.ts --core http://127.0.0.1:9664` | PASS | 21/21 recomputed, digests match, measured split 1271/8729 bps matches | under 1 s |
| 11 | Re-run every final candidate locally | `bun scripts/replay.ts --core http://127.0.0.1:9664 --candidate <id>` for each of the 21 | PASS | 19 with revealed replays: 15 reproduced field for field; 4 exit 1 differing only from replayer `4SXa8KMx`, the e2e liar that Core slashed and suspended (expected); 2 (duplicate, guard) have no replays. The 2 second-lineage candidates first failed with "recipe not in your local recipes/" and reproduced with `LINEAGE_RECIPES_EXTRA` (fix 1 prints that dir) | 61 s + 10 s |
| 12 | Replica of the kept e2e Core | `bun packages/core/src/main.ts --replica-of http://127.0.0.1:9664 --once` | FAIL | 6 divergences, all false (fix 3) | under 1 s |
| 12b | Same after the fix | same | PASS | zero divergence: 19 verdicts, 7 audits, 63 unit checks, 1 closed epoch; also zero against the dev seed Core (14 verdicts, 4 audits, 43 unit checks, 1 closed epoch) | under 1 s |
| 13 | Dashboard routes and assets, kept e2e Core | `bun apps/web/server.ts --port 9663 --core http://127.0.0.1:9664`, curl of the 8 page routes, `/assets/app.js`, `/assets/wallet.js`, `/assets/app.css`, `/favicon.svg`, `/api/lineages`, `/api/stats`, `/chain/config` | PASS | 15/15 HTTP 200 | |
| 14 | Dashboard renders, kept e2e Core (headless Chromium, every route at 1280 and 390 px: page errors, console errors, failed `/api` calls, error boxes, leftover skeletons, horizontal scroll) | scratch script | FAIL | 114/116: one candidate page scrolled sideways at both widths (fix 2) | 101 s |
| 14b | Same after the fix | same | PASS | 116/116 (58 routes x 2 widths); 70 `/provenance` and `/soul` 404s are the documented "none" answers, rendered as empty panels | 101 s |
| 15 | Dev seed | `bun apps/web/scripts/seed-dev.ts --port 9665` | PASS | 2 runs: 2 lineages, 6 generations, 19 candidates, 4 verifiers qualified, lazy verifier slashed for minority and canary, epoch 0 closed, ledger reconciles | 15 s |
| 16 | Dashboard renders the seed | scratch script against the seed Core | PASS | 110/110 (55 routes x 2 widths); 72 documented "none" answers (`/provenance` 404 or 409 `not_final`, `/soul` 404) | 96 s |
| 17 | Identity UI check (W5) | `bun scripts/identity/ui-check.ts --pw <dir> --gist <live proof gist>` | PASS | 20/20 (Core read the live gist from GitHub; nothing written) | 2.5 s |
| 18 | Souls UI check | `bun scripts/souls/ui-check.ts --pw <dir>` | PASS | 15/15, 2 runs | 2.1 s |
| 19 | Live site: recompute every verdict | `bun scripts/verify.ts --core https://157-245-71-188.sslip.io` | PASS | 17/17 (2 accepted with replays, digests match; 15 duplicates and retired-lineage rejections with no replay verdict) | 4.3 s |
| 20 | Live site: read-only replica (W7) | `bun packages/core/src/main.ts --replica-of https://157-245-71-188.sslip.io --once` | PASS | zero divergence: 2 verdicts, 8 unit checks, 2 closed epochs; 15 terminal candidates without a replay verdict skipped; Core epoch 15. Rerun after fix 3: still zero | 25 s |
| 21 | base58-py canaries / candidates | `bun scripts/check-canaries.ts recipes/base58-py canaries` / `candidates` | PASS | 3/3 rejected as expected / 2/2 accepted | 44 s / 33 s |
| 22 | minbpe canaries / candidates | same for `recipes/minbpe` | PASS | 3/3 / 2/2 | 164 s / 86 s |
| 23 | base58-rs canaries / candidates | same for `recipes/base58-rs` | PASS | 3/3 / 1/1 | 17 s / 5 s |
| 24 | bitcoin-base58 canaries / candidates | same for `recipes/bitcoin-base58` | PASS | 3/3 / 2/2 | 95 s / 77 s |
| 25 | zig-clap canaries / candidates | same for `recipes/zig-clap` | PASS | 3/3 / 1/1 | 120 s / 42 s |
| 26 | fixture-zigsize candidates (its only set) | same for `recipes/fixture-zigsize candidates` | PASS | 7/7 as expected | 333 s |
| 27 | solana-config canaries / candidates | same for `recipes/solana-config` | PASS | 3/3 / 1/1 | 364 s / 120 s |
| 28 | ollama-tokenizer canaries / candidates | same for `recipes/ollama-tokenizer` | PASS | 3/3 / 1/1 | 401 s / 110 s |
| 29 | lc-text-splitters canaries / candidates | same for `recipes/lc-text-splitters` | PASS | 3/3 / 2/2 | 281 s / 169 s |
| 30 | fixture-cu-tally planted patches | `bun fixtures/cu-tally-patches/check.ts` | PASS | 8/8 as expected | 30 s |
| 31 | geth-rlp canaries / candidates | `bun scripts/check-canaries.ts recipes/geth-rlp ...` | NOT RUN | about 21 minutes per evaluation (83 minutes for the four); skipped for time. Last result: 3/3 and 1/1 PASS on 2026-10-07 (this file's history) | |
| 32 | bech32-py (W6 agent-drafted recipe) | | NOT RUN | has no canaries or candidates sets; its calibration came from 2 verifier calibration replays (`scripts/discovery/runs/`) | |
| 33 | fixture-cuda, llmc-cuda | `scripts/gpu/session.sh` | NOT RUN | needs an NVIDIA GPU. Last result: PASS on a rented RTX 4000 Ada on 2026-10-08 (`docs/GPU-SESSION.md`: doctor-gpu 7/7, fixture patches 7/7, llm.c canaries 3/3, e2e-cuda 15/15) | |
| 34 | Devnet end to end | `bun scripts/devnet/e2e-devnet.ts` | NOT RUN | posts epochs with the same Core authority as the live site and would block the site's own epoch post. Last result: 49/49 on 2026-10-08 10:56 UTC (`scripts/devnet/E2E-DEVNET-LAST.json`), which predates the W7 registry upgrade; the claim path it covers passed in row 5 against the deployed registry binary | |
| 35 | Devnet challenges | `bun scripts/devnet/challenge-e2e.ts` | NOT RUN | resolves challenges and slashes on chain with the site's Core authority. Last result: 22/22 on 2026-10-08 17:07 UTC (`scripts/devnet/CHALLENGE-E2E-LAST.json`, onchain/DEVNET.md) | |
| 36 | Other devnet, GitHub and model scripts | `scripts/devnet/setup.ts`, `msg-e2e.ts`, `apps/web/scripts/wallet-e2e.ts`, `scripts/runtime/*-run.ts`, `scripts/souls/*`, `scripts/identity/proof.ts`, `scripts/mirror/*.ts`, `scripts/discovery/run.ts` | NOT RUN | each sends devnet transactions, writes to GitHub or spends on Claude (RUNBOOK section 10). Last results: msg-e2e 17/17 (12:27 UTC), wallet-e2e 29/29 (11:17 UTC), runtime sim 15/15 and devnet 18/18, identity proof 13/13 (16:34 UTC), mirror W2 14/14 (17:26 UTC) and W1 live 3/3 (17:30 UTC), all 2026-10-08, in the `*-LAST.json` files next to each script | |

## Fixes made

| # | Commit | Where | What was wrong | Fix | Regression check |
|---|---|---|---|---|---|
| 1 | `db69af2` | `scripts/e2e.ts` | The W4 module creates the second lineage's recipe in a fresh temp dir at import and nothing deleted it: one dir leaked per e2e run (4 were in `$TMPDIR`). With `--keep` its path was never printed, so `replay.ts` could not re-run that lineage's candidates ("recipe not in your local recipes/"). | Deleted with the temp dir when not kept; with `--keep` printed as `kept recipes <dir>` with the `LINEAGE_RECIPES_EXTRA` line for `replay.ts`. | row 8b: no new dir after a run; row 11: both second-lineage candidates reproduce |
| 2 | `73ef190` | `apps/web/public/app.css` | A candidate rejected as a duplicate shows "same change as accepted generation <64 hex>" in an empty-state panel; the unbroken id widened the page by 98 px at 1280 and 108 px at 390. | `.empty` wraps anywhere, like the other id-bearing elements. | row 14b: 116/116 |
| 3 | `5b40ad4` | `packages/core/src/replica.ts` | The replica (W7) reported 6 false divergences on the e2e Core: a counted replay that measured a split's coalitions gets a second `replay` award of `u_replay x class x extra_trees` (SPEC 12.6), which the replica checked as base pay (core 2, replica 1, rebate likewise); and team, split and port shares are divided in micro-units (`splitByBps`), so a generation's author total is within 1e-6 units of `u_author x class x effect`, while the replica compared at 1e-9. A replica of any Core with a team or a measured split would therefore claim Core diverged. | The second award of a replay is checked against `extra_trees` from the candidate's public split reports (revealed, not skipped); author totals are compared within 1e-6. | row 12b: zero divergence on the e2e and seed Cores; row 20: still zero on the live site; `challenges.test.ts` 9/9 |

## Live site

filled by the main session

## gVisor

filled by the main session

## Residual issues

- `onchain/target/deploy/lineage_launch.so` (724,192 bytes, sha256 `966528ad...0e12`) and `lineage_msg.so` (342,200 bytes, `0d402e82...d085`) in the main tree are rebuilds from 2026-10-08 13:35, after the W7 registry change; their sources did not change, but both link the registry crate. They differ from the deployed binaries recorded in `onchain/DEVNET.md` (launch `2bf5fb61...9b34`, msg `94de4765...0b62`), so rows 5's launch, bounty and msg suites ran against these local builds, not byte for byte the deployed ones. `lineage_registry.so` equals the deployed `770d56ba...24a0`.
- Assignment still uses the M1 beacon in chain mode (MILESTONES M2): Core, which holds the epoch secret, could predict draws; they are verifiable only after the epoch closes.
- The dashboard asks Core for `/provenance` and `/soul` and treats 404 (and 409 `not_final`) as "none", which logs a browser console error per page for agents without them. Harmless, but it hides real failures in a console-error check; the render check here filters exactly those answers.
- `replay.ts` exits 1 whenever any revealed replay differs, including when the only difference is a known dishonest replayer (row 11).
- e2e duration varies with machine load: 273 s and 364 s in this run.
