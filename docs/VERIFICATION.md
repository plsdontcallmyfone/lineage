# Verification record

Every check a new developer can run, run from a clean clone and recorded as seen. Nothing below is
marked PASS without its output having been read. Logs of this run are in the verification lane's
session scratchpad (not committed); the commands are in `docs/RUNBOOK.md`.

## Run

| | |
|---|---|
| Date | 2026-10-07 23:00 to 2026-10-08 00:10 (UTC-3); 2026-10-08 02:00 to 03:10 UTC |
| Clean clone | `git clone /Users/achi/lineage` at `b637f4f`, pulled to each fix commit and finally to `750ac98` |
| Fixes | 9 commits, `f8f2b57` to `750ac98` (list below) |
| Machine | Apple M4, 10 cores, 16 GB, macOS 26.5.1, arm64 |
| Docker | Docker Desktop 29.8.1, VM with 10 CPUs and 7.9 GB; images reused, not rebuilt (`lineage/rust:m1`, `lineage/python:m1`, `lineage/go:1.26.8`, `lineage/cpp:gcc14`, `lineage/zig:0.15.2`, `lineage/solana:m1`; ids equal the ids pinned in `recipes/*/recipe.yml`) |
| Toolchain | Bun 1.3.13, TypeScript 5.9.3, rustc 1.94.1, anchor-cli 0.31.1, solana-cli 3.1.12, playwright-core 1.63.0 with chrome-headless-shell v1243 |
| Disk | 4.7 GB free at the start; other sessions' scratchpads (about 11 GB under `/private/tmp`) took it to 2.2 GB, below the 3 GB floor, so the remaining Docker checks were stopped (BLOCKED below) |
| RPC | public devnet `https://api.devnet.solana.com`; no HTTP 429 met on any devnet run |

## Checks

Status: PASS (seen passing), FAIL (seen failing; each has a fix below and a later PASS row), BLOCKED (could not run, cause recorded), NOT RUN (not applicable here, reason recorded).

| # | Check | Command | Status | Counts | Duration |
|---|---|---|---|---|---|
| 1 | Install | `bun install` | PASS | 22 packages | 1.1 s |
| 2 | Typecheck, root | `./node_modules/.bin/tsc -p . --noEmit` | PASS | 0 errors (at `b637f4f` and at `750ac98`) | 2 s |
| 3 | Typecheck, dashboard | `./node_modules/.bin/tsc -p apps/web --noEmit` | PASS | 0 errors (both commits) | 1 s |
| 4 | Unit and integration tests | `bun test packages` | PASS | 292/292, 1,888 expects, real Docker tests included (at `b637f4f`) | 110 s |
| 4b | Same, after the fixes, packages without Docker | `bun test packages/protocol packages/core packages/chain` | PASS | 251/251, 1,712 expects (at `750ac98`, includes the new regression test) | 8 s |
| 4c | Same, full suite after the fixes | `bun test packages` | BLOCKED | disk under 3 GB (the Docker sandbox and worker suites) | |
| 5 | Onchain LiteSVM suites (main repo `onchain/target`, nothing rebuilt or cleaned) | `cargo test --offline -p lineage-onchain-tests` | PASS | 34/34 (client_vectors 1, identity 7, launch 13, registry 13); the `.so` files hash to the deployed sha256 in `onchain/DEVNET.md` (registry `030766bc...`, launch `847af591...`) | 5 s |
| 6 | Leaf encoder | `cargo test --offline -p lineage-registry --lib` | PASS | 3/3 | under 1 s |
| 7 | Merkle fixtures current | `bun onchain/scripts/make-fixtures.ts --check` | PASS | `merkle.json current` | under 1 s |
| 8 | End-to-end network | `bun scripts/e2e.ts --port 9662 --keep` | PASS | 59/59 | 139 s |
| 9 | Planted patches | `bun fixtures/check-patches.ts` | PASS | 12/12 as expected for a single replay against gen 0 | 64 s |
| 10 | Recompute every verdict | `bun scripts/verify.ts --core http://127.0.0.1:9664` (Core on the kept e2e data) | PASS | 15/15 recomputed, digests match | under 1 s |
| 11 | Re-run every final candidate locally | `bun scripts/replay.ts --core http://127.0.0.1:9664 --candidate <id>` for each of the 13 with replays | PASS | 13/13 candidates: every honest replay reproduced field for field; 4 runs exit 1 because they differ from replayer `9MfE2JG9` only, the e2e liar that Core slashed four times and suspended (the expected outcome) | 31 s |
| 12 | Dashboard routes and assets | `bun apps/web/server.ts --port 9663 --core http://127.0.0.1:9664`, curl of every page route, `/assets/app.js`, `/assets/wallet.js`, `/assets/app.css`, `/favicon.svg`, `/live/*`, `/chain/config`, `/api/*` | PASS | 24/24 HTTP 200, no server errors | |
| 13 | Dashboard renders (headless Chromium, every route, console and page errors, failed `/api` calls, error boxes) | scratch script against the kept e2e Core | PASS | 39/39 routes clean | |
| 14 | Dev seed | `bun apps/web/scripts/seed-dev.ts --port 9665` | FAIL | 0 accepted generations: verifiers never qualified (fix 2) | |
| 14b | Dev seed after the fix | same | PASS | 4/4 runs: 6 accepted generations on two lineages; rejections for tests_fail, guard, no_improvement, equivalence_changed, duplicate, stale_conflict; 2 canaries; the dishonest verifier slashed by a canary and as a dispute minority, then suspended; 6 audits opened and 4 resolved (each one inspected read "agreed"); epoch 0 closed with units, payouts, record root and canary list; ledger reconciles | 14 to 16 s |
| 15 | Dashboard renders the seed | headless Chromium against the seed Core | FAIL | 35/38: shadow agents' pages got 404 from `/v1/agents/:id/records` (fix 1) | |
| 15b | Same after the fix | same | PASS | 40/40 routes clean; overview, epoch 0 (payouts, canaries with their shadows), canary candidate, suspended verifier with its reputation record all shown | |
| 16 | Local network, default recipe set | `bun scripts/network.ts` (stopped after start) | PASS after fix 4 | CUDA recipes skipped with their `requires` printed; before the fix they were included and could never calibrate on this host | |
| 17 | Local network, one recipe | `bun scripts/network.ts --recipes fixture-b58` | PASS | first generation accepted 26 s after start; dashboard on 9661 HTTP 200; stopped by PID, no containers left | 26 s |
| 18 | Devnet setup, must send nothing | `bun scripts/devnet/setup.ts` | PASS | 18 PASS lines, every step skipped, deployer moved 0.000000000 SOL | 8 s |
| 19 | Devnet end to end | `bun scripts/devnet/e2e-devnet.ts --port 9665` | PASS | 37/37, deployer spent 0.00394644 SOL; repeated with `--keep`: 37/37 | 199 s, 202 s |
| 20 | Wallet page on devnet | `bun apps/web/scripts/wallet-e2e.ts --pw <playwright dir>` | FAIL | 8/9 twice: the buy simulation failed with SPL "insufficient funds" (fix 3) | 139 s, 142 s |
| 20b | Same after the fix | same | PASS | 26/26 | 152 s |
| 21 | Credential from chain alone | `bun scripts/verify-credential.ts --file <kept>/credential-v1.json` | PASS | exit 0, 1 leaf checked against epoch 9's onchain `record_root`, issuer signature valid | 1 s |
| 22 | Tampered credential is refused | same with `--tamper` | PASS | exit 0 (the altered record fails, `"ok": false`) | under 1 s |
| 23 | Credential via a live Core | `bun scripts/verify-credential.ts --core <url> --agent <id>` | NOT RUN | needs a Core in chain mode; restarting the kept devnet Core would close and post epochs to devnet, which other lanes rely on. Covered inside row 19 | |
| 24 | base58-py canaries / candidates | `bun scripts/check-canaries.ts recipes/base58-py canaries` / `candidates` | PASS | 3/3 rejected as expected / 2/2 accepted | 48 s / 25 s |
| 25 | minbpe canaries / candidates | same for `recipes/minbpe` | PASS | 3/3 / 2/2 | 156 s / 79 s |
| 26 | base58-rs canaries / candidates | same for `recipes/base58-rs` | PASS | 3/3 / 1/1 | 13 s / 4 s |
| 27 | lc-text-splitters canaries | same for `recipes/lc-text-splitters` | PASS | 3/3 | 300 s |
| 28 | lc-text-splitters candidates | | BLOCKED | disk under 3 GB | |
| 29 | bitcoin-base58 canaries, candidates | | BLOCKED | disk under 3 GB | |
| 30 | zig-clap canaries, candidates | | BLOCKED | disk under 3 GB | |
| 31 | fixture-zigsize candidates | | BLOCKED | disk under 3 GB | |
| 32 | solana-config canaries, candidates | | BLOCKED | disk under 3 GB | |
| 33 | ollama-tokenizer canaries, candidates | | BLOCKED | disk under 3 GB | |
| 34 | geth-rlp canaries, candidates (about 21 min per evaluation, planned last) | | BLOCKED | disk under 3 GB | |
| 35 | fixture-cu-tally planted patches | `bun fixtures/cu-tally-patches/check.ts` | BLOCKED | disk under 3 GB | |
| 36 | fixture-b58 | covered by row 9 (`recipes/fixture-b58` has no canaries or candidates directory) | PASS | | |
| 37 | fixture-cuda, llmc-cuda | | NOT RUN | CUDA recipes need an amd64 host with an NVIDIA GPU; this machine is arm64 with none | |

## Fixes made

| # | Commit | Where | What was wrong | Fix | Regression check |
|---|---|---|---|---|---|
| 1 | `f8f2b57`, `40fd509` | `packages/core/src/records.ts` | `GET /v1/agents/:id/records` and `/credential` answered 404 "agent not found" for shadow agents only, while `/v1/agents/:id`, `/keys`, `/intents` and `/teams` answered 200. Anyone could list the shadow pool (the identities Core uses to author canaries) from the moment each shadow launched, before it authored anything, which defeats canaries (SPEC 10.5, 10.7). Found by the dashboard render check: the agent page logged a 404 only for those agents. | A shadow answers exactly as a real agent with nothing final: `{ agent, epochs: [] }` and a credential with no epochs. SPEC 18 already says shadows get no record. | new test "a launched shadow's records and credential answer exactly like a real agent's with nothing final" fails without the fix (404 vs 200) and passes with it; the existing records test now expects the empty answer |
| 2 | `40992df`, `4c768e1` | `apps/web/scripts/seed-dev.ts` | 0 accepted generations: verifiers registered without capabilities, so Core never issued qualification replays and no verifier was ever eligible. Canaries were also never committed (they now come from shadows after delays of up to 10 minutes), and the dishonest verifier was usually struck out by disputes before any canary drew it. | Verifiers declare capabilities and answer qualification replays honestly; canary timings compressed as `scripts/e2e.ts` does, with a settle loop; the dishonest verifier lies only on canaries (a fresh canary per round) until a canary catches it, then copies claims until a dispute does. | 4 consecutive runs, each with both slashes; dashboard 40/40 |
| 3 | `9b1919d` | `apps/web/scripts/wallet-e2e.ts` | Could not pass twice within 24 h: the flow spends about 206 tLINE, the page faucet drips once per wallet per 24 h, and the second run stopped at the buy with SPL "insufficient funds" (177.152 tLINE held, 200 bought), after already paying for a launch. A run by another session at 00:09 UTC stopped at the same point. | The script tops the test wallet up to 400 tLINE from the faucet's own devnet key when it holds less than 250, as it already tops up SOL from the deployer; logged in `onchain/DEVNET.md`. | 26/26 on devnet |
| 4 | `8cf0431` | `apps/web/scripts/wallet-e2e.ts` | The browser path was hardcoded to a macOS arm64 headless shell, so a new developer on Linux or with another playwright version could not run it. | Falls back to playwright's own lookup when that path is absent (checked: playwright-core 1.63.0 launches the installed headless shell by itself). | |
| 5 | `c27b91d` | `scripts/network.ts` | With no `--recipes` (the RUNBOOK's command) it loaded every recipe, including the two CUDA recipes, whose calibration cannot run on a machine without an NVIDIA GPU. | By default, recipes the local `doctor` capabilities do not satisfy are skipped with a note; `--recipes` still runs exactly what is named. | rows 16 and 17 |
| 6 | `c27b91d` | `docs/RUNBOOK.md`, `docs/MILESTONES.md` | The runbook covered only the M1 checks of an earlier milestone: no apps/web typecheck, no `--keep` with `verify.ts` and `replay.ts`, no recipe canaries, onchain tests, dev seed, devnet scripts, wallet-e2e browser setup or images beyond rust and python; MILESTONES named a `scripts/e2e.sh` that does not exist. | Runbook rewritten from the commands as run here, with measured durations; MILESTONES names `scripts/e2e.ts`. | every command in it was run in this record, except those marked BLOCKED or NOT RUN |
| 7 | `baf78a6`, `750ac98` | `onchain/DEVNET.md`, run records | The devnet scripts log their transactions to the checkout they run in, here the clean clone. | The 49 transaction lines of these runs appended to the main log; `E2E-DEVNET-LAST.json` (37/37) and `WALLET-E2E-LAST.json` (26/26) updated. | |

## Residual issues

- Rows 4c and 24 to 35 are BLOCKED by disk: the machine's data volume is shared with other sessions and fell to 2.2 GB free. They need a rerun when at least 3 GB is free; geth-rlp last.
- `onchain/DEVNET.md` in the main tree carries one uncommitted line from another session's earlier wallet-e2e run (`page: launch_agent TUICHECK10`, 00:09 UTC), which stopped at the buy for the reason of fix 3. Left in place for its owner.
- `replay.ts` exits 1 whenever any revealed replay differs, including when the only difference is a known dishonest replayer. That is correct for its purpose, but a script that wants "my run matches the honest majority" has to read the DIFF lines.
- Core prints `canaries: ~/.config/lineage/canaries is not a directory` and runs without a private canary library when none is configured, which is the case for `scripts/network.ts`; a local network therefore never injects canaries unless the owner creates that directory.
- The wallet e2e keeps launching a new test agent token on devnet per run (about 0.016 SOL from the test wallet each time).
