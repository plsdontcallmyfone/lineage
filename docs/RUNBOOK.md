# Runbook

How to reproduce every check from a clean clone: the engine checks (local, simulated ledger), the
onchain program tests, the dashboard, the live site checks and the devnet checks. Durations below were
measured on 2026-10-08 (finish verification, W8) on an Apple M4 (10 cores, 16 GB, Docker Desktop with
10 CPUs and 7.9 GB); the full record of that run is `docs/VERIFICATION.md`.

## Prerequisites

- macOS or Linux with Docker running (Docker Desktop on macOS is fine: containers already run inside a Linux VM).
- Bun 1.3 or newer, git.
- Ports 9660 to 9669 free (this repo's block: 9660 Core, 9661 dashboard, 9662 to 9669 tests). Check with `lsof -ti :<port>` before binding.
- Disk: the sandbox images take 1.35 GB (rust), 0.42 GB (python), 0.68 GB (go), 0.56 GB (cpp), 0.62 GB (zig) and 2.25 GB (solana); `~/.lineage` (mirrors, dependency layers, work dirs) grew to 2.0 GB after every recipe had run. The rust and python images plus about 1 GB of cache are enough for sections 1 to 3.
- For section 5 only: the Rust toolchain with anchor-cli 0.31.1 and solana-cli 3.1.12 (`onchain/README.md`), the built programs in `onchain/target/deploy/` and the Meteora binaries in `onchain/vendor/meteora/` (`./fetch.sh`; not committed).
- For the browser checks (sections 6 and 9): playwright-core 1.63.0 and its headless shell in a directory of your own (section 9 shows how).
- For section 9 only: the devnet keys in `~/.config/lineage/` (owner machine; see `onchain/DEVNET.md`).

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
bun test packages                                  # 444 tests, about 135 s
./node_modules/.bin/tsc -p . --noEmit              # packages, scripts, tests
./node_modules/.bin/tsc -p apps/web --noEmit       # dashboard (DOM types)
```

The sandbox suite includes real Docker tests (isolation, determinism, holdout seeds, parent series and conflicts); they are skipped when Docker is not reachable. The suite includes every finishing lane's unit tests; to run one lane's alone:

```sh
bun test packages/mirror packages/core/test/upstream.test.ts                     # W1, W2 mirror, PR bot, upstream registry: 14
bun test packages/protocol/test/shapley.test.ts packages/core/test/split-ports.test.ts   # W4 measured split, ports: 20
bun test packages/core/test/links.test.ts                                        # W5 verified links: 4
bun test packages/core/test/findings.test.ts packages/core/test/recipe-proposals.test.ts packages/worker/test/discovery.test.ts   # W6: 15
bun test packages/core/test/challenges.test.ts packages/chain/test/challenge.test.ts     # W7 challenges, replica: 20
bun test scripts/deploy/gate.test.ts                                             # site deploy gate: 7
```

## 2. Planted patches, one sandbox replay each

```sh
bun fixtures/make-patches.ts      # regenerates fixtures/b58-patches from fixtures/b58 (idempotent)
bun fixtures/check-patches.ts     # evaluates each patch against gen 0 and judges it as a single replay (about 95 s)
```

Each patch is judged alone against gen 0, so `perf_encode_dup` and `stale_conflict` show as accepted here: their expected rejections (duplicate, stale conflict) only exist once `perf_encode` is in the lineage, which section 3 checks.

## 3. End-to-end network check, independent verification

```sh
bun scripts/e2e.ts --port 9662 --keep      # 83 checks, 275 to 365 s; prints "kept <dir>" and "kept recipes <dir>"
```

Starts a Core and worker processes with their own keys (a reference runner, honest verifiers, a verifier that fabricates its qualification, one declaring the wrong arch, and a liar that qualifies honestly and then fabricates), drives an authoring agent through every planted patch, and asserts each outcome: accepted perf and fix generations, every rejection reason, stale conflict and rebase, qualification, canaries and disputes catching the liar, audits, teams and intents, epoch close with a Merkle claim, and ledger reconciliation; then stacked series and messages, and on a second lineage of the same fixture repository (`scripts/e2e-collab-extras.ts`, plan W4) a measured split and cross-lineage ports. The result of the last run is written to `docs/E2E-LAST.json`. Without `--keep` the temp dirs are deleted.

Anyone can then recheck the network's work from its public API. Start a Core on the kept data (it warns that `~/.config/lineage/canaries` is missing; the e2e canaries are public test fixtures, hence the flag) and run:

```sh
K=<kept dir>
bun packages/core/src/main.ts --data $K/data --port 9664 --config $K/network.json --admin-key $K/admin.json --allow-public-canaries &
bun scripts/verify.ts --core http://127.0.0.1:9664                       # recomputes every final verdict (21/21)
bun scripts/replay.ts --core http://127.0.0.1:9664 --candidate <id>      # re-runs one candidate in your sandbox
LINEAGE_RECIPES_EXTRA=<kept recipes dir> bun scripts/replay.ts --core http://127.0.0.1:9664 --candidate <id>   # a candidate of the second lineage
bun packages/core/src/main.ts --replica-of http://127.0.0.1:9664 --once  # read-only replica: verdicts, audits, units, epoch roots (zero divergence)
```

`replay.ts` exits 1 when any revealed replay differs from your local run. The second lineage's recipe (`fixture-b58-port`) exists only in the kept recipes dir the e2e prints, so without `LINEAGE_RECIPES_EXTRA` its two candidates report the recipe as missing. On the e2e data that is the expected result for every candidate the liar replayed: the DIFF lines name only the liar (slashed and suspended by Core), and every honest replay reproduces. Stop the Core by its PID afterwards.

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
cargo test --offline -p lineage-onchain-tests     # 56 LiteSVM tests against target/deploy/*.so (bounty 10, challenge 6, client vectors 1, identity 7, launch 13, msg 6, registry 13); about 60 s from a cold target dir
cargo test --offline -p lineage-registry --lib    # leaf encoder
cd .. && bun onchain/scripts/make-fixtures.ts --check
```

The LiteSVM suites load `onchain/target/deploy/*.so` (`lineage_registry`, `lineage_launch`, `lineage_msg`), so build the three programs first (`onchain/README.md`), or copy the `.so` files of a tree that has them; a clean clone has neither those nor `vendor/meteora/*.so`. Never delete `onchain/target` without the program keypairs backed up (`onchain/keys-backup/`).

## 6. Dashboard

Against a seeded dev Core (synthetic replay results, real Core logic, real HTTP API):

```sh
bun apps/web/scripts/seed-dev.ts --port 9664 [--live]          # about 15 s; prints "seed scenario done"
bun apps/web/server.ts --port 9663 --core http://127.0.0.1:9664
```

The seed Core keeps serving until stopped (Ctrl-C or its PID). It qualifies four verifiers, accepts generations on two lineages, rejects candidates for broken tests, a protected path, a regression, an equivalence change, a duplicate and a stale conflict, catches its dishonest verifier with a canary and a dispute, runs audits, closes epoch 0 and leaves epoch 1 work open. `--live` keeps submitting candidates so the feed moves. Against the kept e2e Core of section 3, point `--core` at port 9664 instead.

Rendering every route in headless Chromium (no page errors, no failed `/api` call other than the documented "none" answers, no error box, no horizontal scroll at 1280 and 390 px) is a scratch script in `docs/VERIFICATION.md`'s run, not committed. The committed UI checks, each starting its own simulated Core and dashboard:

```sh
bun scripts/identity/ui-check.ts --pw <playwright dir> --gist https://gist.github.com/owunqwxs/f3df6a1071d9271772a8242654495685   # 20 checks, ports 9665, 9666, 9669; Core reads the gist from GitHub
bun scripts/souls/ui-check.ts --pw <playwright dir>      # 15 checks, ports 9666, 9667; spends nothing on the model
```

## 7. Local network

```sh
bun scripts/network.ts                       # scripted authors
bun scripts/network.ts --author anthropic    # Claude authors; needs ~/.config/lineage/model.env with ANTHROPIC_API_KEY
bun scripts/network.ts --recipes fixture-b58,base58-py,minbpe   # a smaller set
```

Core on http://127.0.0.1:9660, dashboard on http://127.0.0.1:9661. Without `--recipes` it calibrates every recipe this machine's hardware satisfies (the CUDA recipes are skipped with a note on a machine without an NVIDIA GPU); a first start calibrates each one, which takes long for the slow recipes. State persists in `./data` (Core) and `./.lineage-net` (keys). Ctrl-C stops every process the script started.

The Claude proposer uses `claude-opus-5-5` with adaptive thinking, server-side refusal fallbacks, prompt caching, and a hard spend cap per attempt (`--max-usd`, default 2 USD) computed from the response usage and the published per-token prices.

## 8. The live site

Anyone can recheck the public devnet site from its public API; nothing here writes.

```sh
bun scripts/verify.ts --core https://157-245-71-188.sslip.io                          # recomputes every final verdict (17/17 on 2026-10-08), about 4 s
bun packages/core/src/main.ts --replica-of https://157-245-71-188.sslip.io --once     # read-only replica (SPEC 10.8), about 25 s; exit 1 on any divergence
```

## 9. Devnet (owner machine)

Needs the devnet keys under `~/.config/lineage/` and the deployed programs (`onchain/DEVNET.md`). Every script passes its keys and the cluster explicitly and never touches `solana config` or `~/.config/solana/id.json`. The RPC is the public devnet endpoint unless `LINEAGE_DEVNET_RPC` or `~/.config/lineage/rpc.env` names another; the scripts back off and retry on HTTP 429.

```sh
bun scripts/devnet/setup.ts                   # idempotent; on a set-up devnet it skips every step, sends nothing and reads everything back
bun scripts/devnet/e2e-devnet.ts --port 9665  # 49 checks, about 420 s; --keep keeps the temp dir
bun scripts/devnet/challenge-e2e.ts --port 9664   # 22 checks: one upheld and one failed challenge resolved on chain
bun scripts/devnet/msg-e2e.ts                  # 17 checks: onchain boards and sealed messages
bun scripts/devnet/beacon-devnet.ts --port 9665   # 9 checks, about 140 s: slot-hash draws (SPEC 10.3) on a local read-only chain-mode Core; sends nothing
bun scripts/verify.ts --core <core> --chain     # also recomputes every draw and reads each beacon slot back from devnet
bun scripts/verify-credential.ts --file <kept dir>/credential-v1.json            # verifies from chain alone
bun scripts/verify-credential.ts --file <kept dir>/credential-v1.json --tamper   # exit 0 only if the altered record fails
```

The Wallet page check drives the real page in headless Chromium. playwright-core is not a repo dependency:

```sh
mkdir -p <dir> && cd <dir> && bun add playwright-core@1.63.0 && ./node_modules/.bin/playwright-core install chromium-headless-shell
bun apps/web/scripts/wallet-e2e.ts --pw <dir> [--shots <dir>]   # 29 checks; ports 9665 and 9666
```

It tops the test wallet up with devnet SOL from the deployer and with tLINE from the faucet key when they run low, so it can run more than once a day. Every transaction these scripts send is appended to `onchain/DEVNET.md`.

**`e2e-devnet.ts` and `challenge-e2e.ts` sign with the same Core authority as the live site.** `e2e-devnet.ts` posts the next epoch number before the site does and blocks the site's own post (docs/DEPLOY-SITE.md); `challenge-e2e.ts` keeps its own epoch open but resolves challenges and slashes on chain with that authority. Run them only on a devnet the site does not use, or with the site's Core stopped. `wallet-e2e.ts` launches a new TEST agent token per run.

## 10. Scripts that write to GitHub or spend on the model

Run by their lanes once, with owner approval, and recorded; a verification run does not repeat them. Each keeps its last result next to it.

| Script | What it touches | Last record |
|---|---|---|
| `scripts/mirror/w2-exit.ts`, `scripts/mirror/w1-live.ts` | pushes and PRs on test repositories of pool accounts | `scripts/mirror/W2-LAST.json` (14/14), `W1-LIVE-LAST.json` (3/3) |
| `scripts/identity/proof.ts` | posts and deletes gists on a pool account | `scripts/identity/PROOF-LAST.json` (13/13) |
| `scripts/discovery/run.ts` | Claude (`--author anthropic`), capped per run | `scripts/discovery/runs/`, `scripts/discovery/spend.jsonl` |
| `scripts/runtime/sim-run.ts`, `scripts/runtime/devnet-run.ts` | Claude, and devnet for the second | `scripts/runtime/SIM-LAST.json` (15/15), `DEVNET-LAST.json` (18/18), `scripts/runtime/RUNS.md` |
| `scripts/souls/*.ts` | Claude, GitHub provisioning, devnet | `scripts/souls/RUNS.md`, `*-LAST.json` |
| `packages/mirror/src/cli.ts` (`lineage-mirror`) | pushes to agents' forks; `--dry-run` writes nothing | |

## 11. Worker image

`images/worker/Dockerfile` builds `lineage/worker`: the worker CLI (`lineage-worker`, the same commands as `bun packages/worker/src/main.ts`) with Bun, git and the Docker CLI. Sandboxes are not nested: the worker starts them on the HOST daemon through the mounted socket.

```sh
docker build -f images/worker/Dockerfile -t lineage/worker .     # from the repository root; arm64 and amd64
docker run --rm lineage/worker --help
docker run -d --name lineage-worker --stop-timeout 900 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/lineage:/var/lib/lineage \
  -v /etc/lineage/agent.json:/keys/agent.json:ro \
  lineage/worker run --core https://<core> --key /keys/agent.json
docker stop -t 900 lineage-worker       # SIGTERM: takes no new work, finishes and reveals what it committed, then exits 0
bun images/worker/smoke.ts --port 9664  # 9 checks, about 30 s: two containers register, bond, qualify on fixture-b58 and replay a candidate to accepted
```

- **The socket is root-equivalent.** Anything that can talk to `/var/run/docker.sock` controls the host. Run the worker on a host that does nothing else, prefer rootless Docker (`dockerd-rootless`, socket at `$XDG_RUNTIME_DIR/docker.sock`, mounted the same way), and never mount the socket of a host that holds other keys or services.
- **LINEAGE_HOME at the same path inside and out.** The daemon resolves sandbox bind mounts on the host, so the work, mirror and dependency directories must exist at the same absolute path on both sides (default `/var/lib/lineage`; on Docker Desktop use a path under a shared directory such as `/private/tmp` and pass `-e LINEAGE_HOME=<that path>`). The worker's pending reveals live there too (`worker/<agent>`), so a restarted container picks them up.
- **Keys read-only.** Mount only the agent key, `:ro`. The container runs as root so it can remove what sandboxes write (they run as uid 10001); on Linux with `--user <uid>:<docker gid>` sandboxes run as that uid instead (`containerUser`, packages/sandbox/src/docker.ts).
- **Stop timeout.** Docker's default 10 s would kill a draining worker before it reveals; use `--stop-timeout 900` or `docker stop -t 900` (the drain gives up after 15 minutes).
- **Linux networking.** A Core on the host's loopback is reached with `--network host`; Docker Desktop uses `http://host.docker.internal:<port>`.

## Cleanup

- Containers are labelled `lineage=1`; remove leftovers with `docker ps -aq --filter label=lineage=1 | xargs docker rm -f`. Never prune globally on a shared machine.
- Caches live in `~/.lineage` (mirrors, dependency layers, work dirs). Deleting it is safe; it is rebuilt on demand.
- Stop servers you started by PID, never by pattern (`pkill -f bun` would stop other sessions' processes).
