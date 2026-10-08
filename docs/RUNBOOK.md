# Runbook

How to reproduce every check from a clean clone: the M1 engine checks (local, simulated ledger), the
onchain program tests, the dashboard, and the devnet checks. Durations below were measured on
2026-10-07 on an Apple M4 (10 cores, 16 GB, Docker Desktop with 10 CPUs and 7.9 GB); the full record
of that run is `docs/VERIFICATION.md`.

## Prerequisites

- macOS or Linux with Docker running (Docker Desktop on macOS is fine: containers already run inside a Linux VM).
- Bun 1.3 or newer, git.
- Ports 9660 to 9669 free (this repo's block: 9660 Core, 9661 dashboard, 9662 to 9669 tests). Check with `lsof -ti :<port>` before binding.
- Disk: the sandbox images take 1.35 GB (rust), 0.42 GB (python), 0.68 GB (go), 0.56 GB (cpp), 0.62 GB (zig) and 2.25 GB (solana); `~/.lineage` (mirrors, dependency layers, work dirs) grew to 2.0 GB after every recipe had run. The rust and python images plus about 1 GB of cache are enough for sections 1 to 3.
- For section 5 only: the Rust toolchain with anchor-cli 0.31.1 and solana-cli 3.1.12 (`onchain/README.md`).
- For section 7 only: the devnet keys in `~/.config/lineage/` (owner machine; see `onchain/DEVNET.md`).

```sh
bun install
docker build -t lineage/rust:m1 images/rust
docker build -t lineage/python:m1 images/python
# the other target classes, only for the recipes that use them (section 4):
docker build -t lineage/go:1.26.8 images/go
docker build -t lineage/cpp:gcc14 images/cpp
docker build -t lineage/zig:0.15.2 images/zig
docker build -t lineage/solana:m1 images/solana
# cuda: only on an amd64 host with an NVIDIA GPU, see images/cuda/Dockerfile
```

Recipes pin images by id (`name@sha256:<id>`). An image you build locally gets a different id than the one recorded in `recipes/*/recipe.yml` unless the base image and package versions match exactly; if `loadRecipe` or a replay reports the image as unavailable, rebuild the recipe ids with your local image ids (the recipe id then changes too, which is correct: a different image is a different recipe). M2 publishes the images to a registry so every worker pulls the same bytes. `docker images --no-trunc` shows whether your ids match the recipes.

## 1. Unit and integration tests, typecheck

```sh
bun test packages                                  # 293 tests, about 110 s
./node_modules/.bin/tsc -p . --noEmit              # packages, scripts, tests
./node_modules/.bin/tsc -p apps/web --noEmit       # dashboard (DOM types)
```

The sandbox suite includes real Docker tests (isolation, determinism, holdout seeds, parent series and conflicts); they are skipped when Docker is not reachable.

## 2. Planted patches, one sandbox replay each

```sh
bun fixtures/make-patches.ts      # regenerates fixtures/b58-patches from fixtures/b58 (idempotent)
bun fixtures/check-patches.ts     # evaluates each patch against gen 0 and judges it as a single replay (about 65 s)
```

Each patch is judged alone against gen 0, so `perf_encode_dup` and `stale_conflict` show as accepted here: their expected rejections (duplicate, stale conflict) only exist once `perf_encode` is in the lineage, which section 3 checks.

## 3. End-to-end network check, independent verification

```sh
bun scripts/e2e.ts --port 9662 --keep      # 59 checks, about 140 s; prints "kept <dir>"
```

Starts a Core and worker processes with their own keys (a reference runner, honest verifiers, a verifier that fabricates its qualification, one declaring the wrong arch, and a liar that qualifies honestly and then fabricates), drives an authoring agent through every planted patch, and asserts each outcome: accepted perf and fix generations, every rejection reason, stale conflict and rebase, qualification, canaries and disputes catching the liar, audits, teams and intents, epoch close with a Merkle claim, and ledger reconciliation. The result of the last run is written to `docs/E2E-LAST.json`. Without `--keep` the temp dir is deleted.

Anyone can then recheck the network's work from its public API. Start a Core on the kept data (it warns that `~/.config/lineage/canaries` is missing; the e2e canaries are public test fixtures, hence the flag) and run:

```sh
K=<kept dir>
bun packages/core/src/main.ts --data $K/data --port 9664 --config $K/network.json --admin-key $K/admin.json --allow-public-canaries &
bun scripts/verify.ts --core http://127.0.0.1:9664                       # recomputes every final verdict (15/15)
bun scripts/replay.ts --core http://127.0.0.1:9664 --candidate <id>      # re-runs one candidate in your sandbox
```

`replay.ts` exits 1 when any revealed replay differs from your local run. On the e2e data that is the expected result for every candidate the liar replayed: the DIFF lines name only the liar (slashed and suspended by Core), and every honest replay reproduces. Stop the Core by its PID afterwards.

## 4. Real repositories

```sh
bun scripts/calibrate-recipe.ts recipes/base58-py
bun scripts/calibrate-recipe.ts recipes/minbpe
bun scripts/check-canaries.ts recipes/<name> canaries      # every canary must be rejected for its expected reason
bun scripts/check-canaries.ts recipes/<name> candidates    # hand-written candidates, judged as one replay each
```

Calibration results are committed in `recipes/<name>/calibration.json`; `check-canaries.ts` reuses them when the recipe id matches and writes `recipes/<name>/<set>/results.json`. It exits 1 on any verdict that differs from the expected one in `index.json`. The CUDA recipes (`fixture-cuda`, `llmc-cuda`) need an NVIDIA GPU (`scripts/gpu/`). `geth-rlp` takes about 21 minutes per evaluation. The solana compute-unit fixture has its own check: `bun fixtures/cu-tally-patches/check.ts`.

## 5. Onchain programs

```sh
cd onchain
cargo test --offline -p lineage-onchain-tests     # 34 LiteSVM tests against target/deploy/*.so
cargo test --offline -p lineage-registry --lib    # leaf encoder
cd .. && bun onchain/scripts/make-fixtures.ts --check
```

The LiteSVM suites load `onchain/target/deploy/*.so`, so build both programs first (`onchain/README.md`). Never delete `onchain/target` without the program keypairs backed up (`onchain/keys-backup/`).

## 6. Dashboard

Against a seeded dev Core (synthetic replay results, real Core logic, real HTTP API):

```sh
bun apps/web/scripts/seed-dev.ts --port 9664 [--live]          # about 15 s; prints "seed scenario done"
bun apps/web/server.ts --port 9663 --core http://127.0.0.1:9664
```

The seed qualifies four verifiers, accepts generations on two lineages, rejects candidates for broken tests, a protected path, a regression, an equivalence change, a duplicate and a stale conflict, catches its dishonest verifier with a canary and a dispute, runs audits, closes epoch 0 and leaves epoch 1 work open. `--live` keeps submitting candidates so the feed moves. Against the kept e2e Core of section 3, point `--core` at port 9664 instead.

## 7. Local network

```sh
bun scripts/network.ts                       # scripted authors
bun scripts/network.ts --author anthropic    # Claude authors; needs ~/.config/lineage/model.env with ANTHROPIC_API_KEY
bun scripts/network.ts --recipes fixture-b58,base58-py,minbpe   # a smaller set
```

Core on http://127.0.0.1:9660, dashboard on http://127.0.0.1:9661. Without `--recipes` it calibrates every recipe this machine's hardware satisfies (the CUDA recipes are skipped with a note on a machine without an NVIDIA GPU); a first start calibrates each one, which takes long for the slow recipes. State persists in `./data` (Core) and `./.lineage-net` (keys). Ctrl-C stops every process the script started.

The Claude proposer uses `claude-opus-5-5` with adaptive thinking, server-side refusal fallbacks, prompt caching, and a hard spend cap per attempt (`--max-usd`, default 2 USD) computed from the response usage and the published per-token prices.

## 8. Devnet (owner machine)

Needs the devnet keys under `~/.config/lineage/` and the deployed programs (`onchain/DEVNET.md`). Every script passes its keys and the cluster explicitly and never touches `solana config` or `~/.config/solana/id.json`. The RPC is the public devnet endpoint unless `LINEAGE_DEVNET_RPC` or `~/.config/lineage/rpc.env` names another; the scripts back off and retry on HTTP 429.

```sh
bun scripts/devnet/setup.ts                   # idempotent; on a set-up devnet it skips every step, sends nothing and reads everything back
bun scripts/devnet/e2e-devnet.ts --port 9665  # 37 checks, about 200 s, about 0.004 devnet SOL; --keep keeps the temp dir
bun scripts/verify-credential.ts --file <kept dir>/credential-v1.json            # verifies from chain alone
bun scripts/verify-credential.ts --file <kept dir>/credential-v1.json --tamper   # exit 0 only if the altered record fails
```

The Wallet page check drives the real page in headless Chromium. playwright-core is not a repo dependency:

```sh
mkdir -p <dir> && cd <dir> && bun add playwright-core@1.63.0 && ./node_modules/.bin/playwright-core install chromium-headless-shell
bun apps/web/scripts/wallet-e2e.ts --pw <dir> [--shots <dir>]   # 26 checks, about 150 s; ports 9665 and 9666
```

It tops the test wallet up with devnet SOL from the deployer and with tLINE from the faucet key when they run low, so it can run more than once a day. Every transaction these scripts send is appended to `onchain/DEVNET.md`.

## Cleanup

- Containers are labelled `lineage=1`; remove leftovers with `docker ps -aq --filter label=lineage=1 | xargs docker rm -f`. Never prune globally on a shared machine.
- Caches live in `~/.lineage` (mirrors, dependency layers, work dirs). Deleting it is safe; it is rebuilt on demand.
- Stop servers you started by PID, never by pattern (`pkill -f bun` would stop other sessions' processes).
