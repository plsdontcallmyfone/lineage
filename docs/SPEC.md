# Lineage: specification

Status: draft v0.8, 2026-10-07. Working name "Lineage" is a placeholder; the token is called `$LINE` in this document only as a stand-in (ticker, mint, supply, burn amount and treasury addresses are TBA).

This document is the source of truth. Code that disagrees with it is a bug in one of the two; fix whichever is wrong and note it in the changelog at the bottom.

---

## 1. What this is

A network where software agents improve real open-source code and only get paid when other machines independently reproduce the improvement.

The unit of value is a **generation**: one bounded patch, applied to a pinned parent, that built, passed the full test suite, improved a declared metric (or fixed a declared failure), and was reproduced by at least two independent, randomly assigned replayers. Generations chain into a per-repository **lineage**, a hash-linked, publicly auditable history.

Every authoring agent is launched as its own token on Meteora, paired with `$LINE`. The agent is pointed at a public repository. Its token's trading fees pay for its compute (model tokens and sandbox time), so trading keeps it awake, and its accepted generations are the public record of what that compute produced. Verification is done by separate, bonded verifier nodes that never share infrastructure with the agents they check.

### 1.1 Design principles

1. **Measured, not argued.** A change is never accepted because it reads well. Acceptance is a pure function of replay transcripts.
2. **The author never verifies itself.** Replayers are chosen by public randomness after the author is locked in.
3. **Pay replayers for doing the work, not for agreeing.** Replay rewards do not depend on the verdict. This removes the incentive to rubber-stamp.
4. **Make lazy and colluding replays detectable.** Commit-reveal on every result, hidden artifact digests, canary patches, holdout benchmark seeds, random audits.
5. **Measure relative to the lineage tip.** Every candidate is measured against its parent generation, so duplicates and stacked claims fail naturally.
6. **Prefer deterministic metrics.** Instruction counts, compute units, binary size and allocation counts beat wall-clock time. Wall-clock is allowed only with interleaved runs and a confidence interval.
7. **Never spam maintainers.** Lineages live on our own public forks. Upstream pull requests happen only for repositories whose maintainers opted in.
8. **No fabricated state.** UIs show only measured values and real records. Unknown values are shown as TBA.

### 1.2 Non-goals

- Feature development, refactors with no measurable effect, style changes, documentation edits.
- Changing tests, benchmarks, CI, build scripts or dependencies (these are protected; see section 7).
- A chat assistant or a code generator product.
- Rewarding holders. Holding the token earns nothing.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| Repo | A public git repository tracked by the network, identified by its canonical URL. |
| Snapshot | An immutable upstream commit SHA of a repo, plus the digest of its vendored dependency layer. |
| Recipe | A content-addressed evaluation spec for a repo: image, build, test, metrics, protected paths, patch bounds. |
| Calibration | A recorded run of a recipe at a snapshot that fixes the stable test set, quarantines flaky tests and measures metric noise. |
| Lineage | The ordered chain of accepted generations for one (repo, recipe) pair, rooted at a snapshot. |
| Generation | An accepted node in a lineage. Gen 0 is the snapshot itself. |
| Tip | The newest generation of a lineage. |
| Finding | A reproducible, measurable problem at a tip: a failing stable test, or a metric target. |
| Candidate | A patch submitted by an author against a parent generation, claiming a kind and target. |
| Replay | An independent evaluation of a candidate by an assigned replayer, inside a sandbox. |
| Verdict | The deterministic acceptance decision computed from revealed replays. |
| Canary | A candidate injected by the network that is known to be bad. Passing it is slashable. |
| Agent | An identity created by burning tokens, owned by a wallet, able to author, replay and discover. |
| Bond | Tokens an agent locks to be eligible for replay assignment; slashable. |
| Epoch | A fixed accounting period. Rewards are computed and paid per epoch. |

---

## 3. Actors

| Actor | Role | Trust |
|---|---|---|
| Launcher | Anyone who launches an agent token, names its target repo, and picks or imports its GitHub identity. | Untrusted. |
| Agent | An authoring identity created by a token launch (section 14). Discovers and authors. Runs hosted (our runtime, paid from its compute vault) or self-hosted. | Untrusted. |
| Verifier | A bonded operator node that replays candidates. Self-hosted only, never on the hosted agent runtime, so replays are independent of the machines that authored them. A self-hosted agent may also bond and verify. | Untrusted, slashable. |
| Worker | The process both agents and verifiers run: discover, author, replay. | Untrusted. |
| Core | Coordinator: task market, assignment, verdicts, lineage log, epoch accounting. | Trusted in M1 and M2, made auditable from M2 (all inputs and outputs public and replayable), contestable from M4 (bonded challenges). |
| Reference runner | A Core-operated Worker used for calibration, tie-breaks and audits. | Same as Core. |
| Maintainer | Owner of an upstream repo. Can opt in to upstream PRs or opt out of tracking. | External. |
| Treasury | Receives `$LINE` creator rewards and the protocol share of every agent token's fees; splits them into the compute reserve and the epoch pool. | Onchain program from M2. |
| Hosted runtime | Our infrastructure that runs hosted agents, metered against each agent's compute vault. Never assigned replays. | Operated by us; its spend is public per agent. |

---

## 4. Objects and identifiers

All hashes are SHA-256, hex, over canonical encodings (sorted-key JSON with no whitespace, or the canonical diff format in section 7.3). Every id below is a hash, so any party can recompute it.

```
repo_id        = H("repo"    | canonical_url)
snapshot_id    = H("snap"    | repo_id | commit_sha | deps_digest)
recipe_id      = H("recipe"  | canonical_json(recipe))
calib_id       = H("calib"   | recipe_id | snapshot_id | canonical_json(calibration_result))
lineage_id     = H("lineage" | snapshot_id | recipe_id)
patch_hash     = H("patch"   | canonical_diff)
candidate_id   = H("cand"    | lineage_id | parent_gen_id | patch_hash | author_agent_id | kind | target)
gen_id         = H("gen"     | parent_gen_id | patch_hash | verdict_digest)
gen_0          = H("gen"     | lineage_id)
```

### 4.1 Recipe

YAML in `recipes/<name>.yml`, normalised to canonical JSON for hashing. Full schema in section 6.

### 4.2 Candidate

```
{
  candidate_id, lineage_id, parent_gen_id, author_agent_id,
  kind: "perf" | "fix" | "slim",
  target: metric name (perf, slim) or list of test ids (fix),
  claimed_effect: number (relative change the author measured, informational only),
  commitment: H(patch_hash | salt),     // phase 1
  patch: canonical_diff, salt,          // phase 2 (reveal)
  committed_at, revealed_at,
  status
}
```

### 4.3 Replay

```
{
  replay_id, candidate_id, replayer_agent_id, seed,
  commitment: H(canonical_json(result) | salt),   // phase 1
  result, salt,                                  // phase 2
  assigned_at, committed_at, revealed_at, status
}
result = {
  apply: "ok" | "conflict",
  guard: "ok" | <violation code>,
  build: { base: "ok"|"fail", cand: "ok"|"fail", base_digest, cand_digest },
  tests: { base_pass: [ids], cand_pass: [ids], cand_fail: [ids] },
  equivalence: { base_digest, cand_digest } | null,
  metrics: { <name>: { base: [samples], cand: [samples], deterministic: bool } },
  env: { image_digest, cpu_model, cores, worker_version },
  transcript_digest   // hash of the full log bundle, stored content-addressed
}
```

### 4.4 Generation

```
{ gen_id, lineage_id, parent_gen_id, height, candidate_id, patch_hash,
  kind, target, effect: { metric, ratio, ci_low, ci_high } | { fixed: [ids] },
  verdict_digest, replay_ids, author_agent_id, accepted_at, epoch }
```

---

## 5. Lifecycles

### 5.1 Candidate

```
committed ──reveal──▶ revealed ──guard ok──▶ queued ──assign──▶ replaying
    │                    │                                         │
    │ (timeout)          │ guard fail                              ├─ both revealed ─▶ judged
    ▼                    ▼                                         │                    │
 expired             rejected(guard)                               └─ timeout ─▶ reassigned (max 2)
                                                                                     │
                     judged ──▶ accepted (new generation) | rejected(<reason>) | disputed ─▶ tiebreak ─▶ accepted | rejected
                     accepted but parent != tip at commit time  ──▶ see 11.2 (rebase)
```

Timeouts are recipe-scaled: `reveal_window`, `replay_window = k * calibration.median_eval_seconds` (k from config).

### 5.2 Replay

```
assigned ──commit──▶ committed ──(all assigned replays committed or window closes)──▶ reveal_open ──reveal──▶ revealed
    │                    │                                                                │
    └─ timeout ─▶ abandoned (no reward, strike)          reveal mismatch with commitment ─┴─▶ invalid (slash small)
```

Reveal opens only when every assigned replayer of that candidate has committed, so no replayer can copy another.

### 5.3 Agent (authoring)

```
(token launch) ──▶ setting_up (recipe for its target repo is drafted and calibrated, section 6)
                        │ calibration accepted
                        ▼
                     awake ◀──── compute vault ≥ wake_threshold (fees arrive from trading) ────┐
                        │ vault below sleep_threshold                                         │
                        ▼                                                                     │
                     asleep ──────────────────────────────────────────────────────────────────┘
```

A target whose recipe cannot be calibrated (no runnable tests, no metric, AI-ban policy) stays in `setting_up` with a public reason; the agent's compute is not spent on authoring until it is active.

### 5.4 Verifier eligibility

```
(registered: token launch, or verifier registration) ──bond ≥ min──▶ eligible ──unbond request──▶ cooling (no new assignments, still slashable) ──cooldown──▶ registered
                          │
                          └─ slashed below min ──▶ registered (ineligible) ;  strikes ≥ limit ──▶ suspended (epoch-scoped)
```

Hosted agents are never eligible, whatever their bond.

---

## 6. Recipes

A recipe makes one repository measurable. Recipes are written by Core in M1 and proposed by agents from M3 (a recipe proposal is accepted only after calibration replays agree).

```yaml
name: bs58-rs
class: rust                        # target class (6.1)
requires: { arch: arm64 }          # plus gpu: { vendor: nvidia, sm: "8.9" } for cuda
repo: https://github.com/Nullus157/bs58-rs
commit: <sha>                      # snapshot; lineage root
image: lineage/rust:1.83@sha256:<digest>   # pinned by digest, never a tag alone
workdir: /work/src
prepare:                           # runs WITH network, once per snapshot; output becomes the deps layer
  - cargo fetch --locked
prepare_outputs: []                # files prepare generates that every tree needs (e.g. a lockfile the repo does not commit)
build:                             # runs with NO network from here on
  commands:
    - cargo build --release --locked --offline --all-targets
  artifacts: [target/release/*.rlib]        # digested for reproducibility checks (optional)
  reproducible: true
test:
  command: cargo test --release --locked --offline
  parser: libtest                   # libtest | junit (file at /out/junit.xml) | tap
  exclude: []                       # test ids that need network or hardware; never counted, never targets
  timeout_s: 600
equivalence:                        # optional; required for kind=perf when present
  command: cargo run --release --offline --example lineage_equiv -- --seed $LINEAGE_SEED --n 20000
  output: stdout-digest
metrics:
  - name: encode_ir
    kind: perf
    direction: lower
    deterministic: true             # instruction counts under cachegrind
    command: valgrind --tool=cachegrind --cache-sim=no --cachegrind-out-file=/dev/null target/release/examples/lineage_bench encode $LINEAGE_SEED
    parser: cachegrind-ir
    holdout: true                   # replayers pass a random seed the author never saw
    min_effect: 0.01                # relative improvement required (1%)
  - name: encode_ns
    kind: perf
    direction: lower
    deterministic: false
    command: target/release/examples/lineage_bench encode-wall $LINEAGE_SEED
    parser: number                  # cachegrind-ir | number | bytes
    rounds: 15                      # interleaved A/B pairs
    min_effect: 0.03
patch:
  allowed_paths: ["src/**"]
  protected_paths: ["tests/**", "benches/**", "examples/lineage_*", "Cargo.toml", "Cargo.lock", "build.rs", ".github/**", "**/*.yml"]
  max_files: 5
  max_lines: 200                    # added + removed
limits: { cpus: 2, memory_mb: 4096, pids: 512, wall_s: 1800, disk_mb: 4096 }
```

Rules:

- **Harness files are ours.** Benchmarks and equivalence harnesses that upstream does not ship live in an overlay directory of the recipe (`recipes/<name>/overlay/`), copied in before build, and are always protected. The overlay is part of the recipe hash.
- **`$LINEAGE_SEED`** is the only nondeterministic input. Authors measure with seeds of their choice; replayers get seeds derived from public randomness (section 10.3), so special-casing benchmark inputs fails.
- **Calibration** (Core reference runner, then two random replayers once the network has them) runs the test suite `calib_runs` times (default 5) at the snapshot, keeps tests that passed every time as the **stable set**, records tests that failed every time as **known failures** (candidate fix targets), quarantines everything else, and measures each metric's coefficient of variation. A non-deterministic metric whose noise is too large to resolve its `min_effect` at the configured `rounds` is disabled for that calibration and the recipe author is told why.

---

### 6.1 Target classes

A launcher spawns an agent into a **target class**. A class is a contract, not a label: it names a toolchain image, the deterministic metric that class optimises, a measurement harness template, and the hardware a verifier needs to replay it. A class is only offered at launch once it has at least one calibrated real lineage and enough eligible verifiers to reach quorum.

| Class | Toolchain image | Primary metric (deterministic) | Secondary metric (noisy, CI) | Verifier needs |
|---|---|---|---|---|
| `rust` (systems performance) | `lineage/rust` | instruction count under cachegrind (`Ir`) for a seeded workload | wall-clock ns, ABBA rounds | image arch; CPU |
| `solana` (compute units) | `lineage/solana` (Agave platform tools, `cargo-build-sbf`) | compute units consumed per instruction, measured in-process by an SVM test harness (mollusk or litesvm) on seeded instruction data | none needed: CU is exact | image arch; CPU |
| `zig` (binary size) | `lineage/zig` (pinned Zig release) | bytes of the `ReleaseSmall` artifact | instruction count of a seeded workload | image arch; CPU |
| `cuda` (kernel throughput) | `lineage/cuda` (CUDA devel image, Nsight Compute) | executed warp instructions per kernel launch (`smsp__inst_executed.sum` via `ncu`) for a seeded input | kernel time from CUDA events, ABBA rounds, bootstrap CI | NVIDIA GPU of the recipe's compute capability class, driver at least the image's CUDA version |
| `python` (interpreter performance) | `lineage/python` | instruction count under cachegrind | wall-clock | image arch; CPU |
| `go` (systems performance) | `lineage/go` (pinned Go release) | instruction count under cachegrind of a seeded workload run with `GOMAXPROCS=1 GOGC=off` so the scheduler and collector do not perturb counts; calibration decides whether it is deterministic enough | `go test -bench` ns/op, ABBA rounds | image arch; CPU |
| `cpp` (systems performance) | `lineage/cpp` (pinned compiler and CMake) | instruction count under cachegrind of a seeded workload | wall-clock | image arch; CPU |

Rules:

- **Architecture is part of the recipe.** Instruction counts and binary sizes differ between amd64 and arm64, so a recipe pins a single-platform image digest and `requires.arch`; only verifiers of that arch are assigned. The same repository can have one lineage per arch.
- **GPU classes pin hardware tightly.** Warp instruction counts are stable for a given GPU architecture and compiler; a CUDA recipe pins `requires.gpu = { vendor: "nvidia", sm: "<compute capability>" }` and the image digest (which fixes `nvcc`). Kernel time is only ever a secondary, noisy metric with the same interleaving and CI rules as 9.2.
- **Capabilities are declared, then proven.** A verifier declares its capabilities (`arch` amd64 or arm64, `cpus`, `memory_mb`, `gpus[]` of `{ vendor: "nvidia", model, sm, mem_gb, driver }`) when it registers and may replace them at any time (`PUT /v1/agents/:id/capabilities`, agent-signed). Core validates them strictly (unknown fields are refused). `lineage-worker doctor` prints what a machine has: arch from the Docker engine, its CPUs and memory, NVIDIA GPUs from `nvidia-smi`, and which `lineage/*` images are present; `lineage-worker run` declares that on start.
- **Qualification.** A verifier is eligible for a lineage only when (a) its declared capabilities satisfy the recipe's `requires` and (b) it holds a passed qualification for that lineage (M1 granularity: per lineage; per class from M2). Core issues a qualification assignment (kind `qualify`, not tied to any candidate) to every generally eligible verifier (5.4) whose capabilities satisfy an active lineage's recipe and that has no passed or open qualification for it. The assignment carries the recipe, the calibration as of gen_0 **without its recorded base values** (they are the answer key), and the seed the reference runner calibrated with (`calibration.seed`; calibrations without one used `H("calibration", snapshot_id)`). The verifier measures the baseline only (build, one test run, deterministic metrics on gen_0 with that seed) and reveals through the same commit-reveal as a replay; its reveal opens as soon as it commits. Core passes it when the base build succeeds, the base passing tests (excluded and quarantined tests aside) equal the calibrated stable set, and every enabled deterministic metric's base value equals the calibrated `base_value` within the metric's tolerance. A failure or a missed window has no slash and no strike (it may be honest hardware that differs): the reason is recorded and a new attempt is issued after `qualify_retry_s`. Declaring capabilities that no longer satisfy a recipe revokes that lineage's qualification (re-issued at once if they satisfy again). Reference runners are qualified by definition (they are Core); one that declared capabilities is still only used for recipes they satisfy. Known M1 limit: calibrations, base values included, are public on the lineage view, so a dishonest verifier that reads them can pass; qualification here screens out wrong or broken hardware and lazy fabricators, while canaries, disputes and audits catch lying replays. From M2 a qualification should replay a fresh seed that only the reference runner has measured.
- **Assignment filters on capability** before the weighted draw (10.3).

## 7. Patches

### 7.1 What a patch may do

- Modify, add or delete text files under `allowed_paths`.
- Nothing under `protected_paths`, even if also allowed (protected wins).
- No binary files, symlinks, submodule changes, mode changes, renames across the allowed boundary.
- At most `max_files` files and `max_lines` added plus removed lines.
- Must apply cleanly (no fuzz) to the parent generation tree.

### 7.2 Guard

The guard is a pure function `guard(parent_tree, diff, recipe) -> ok | violation`. It runs at reveal time in Core and again inside every replay. Violation codes: `PROTECTED_PATH`, `OUTSIDE_ALLOWED`, `TOO_MANY_FILES`, `TOO_MANY_LINES`, `BINARY`, `SYMLINK`, `MODE_CHANGE`, `SUBMODULE`, `APPLY_CONFLICT`, `EMPTY`, `MALFORMED`.

Extra heuristic flags (logged, not fatal in M1, scored by auditors): reads of `LINEAGE_*` environment variables or of the benchmark harness path from patched code; timing or process-introspection calls added to library code.

### 7.3 Canonical diff

Unified diff, `a/` and `b/` prefixes, files sorted by path, three lines of context, LF line endings, no `index` lines, no timestamps, trailing newline. Produced by `git diff --no-color --no-ext-diff --no-renames -U3 --full-index` and then normalised (strip `index` lines). `patch_hash` covers this exact byte string. A whitespace-insensitive `semantic_hash` is also stored to detect trivially re-skinned duplicates.

---

## 8. Sandbox

Every build, test, equivalence and metric command runs in a fresh Docker container created from the recipe image digest. The worker host must keep no secrets reachable from the container.

| Control | Setting |
|---|---|
| Network | `prepare`: default bridge. Everything else: `--network none`. |
| User | Non-root (uid 10001). `--security-opt no-new-privileges`, `--cap-drop ALL`. |
| Filesystem | Root filesystem read-only. `/work` is a fresh writable volume populated from the snapshot tree plus patch; deps layer mounted read-only; `/tmp` tmpfs. |
| Resources | `--cpus`, `--memory`, `--memory-swap` equal to memory, `--pids-limit`, wall-clock kill. |
| Environment | Cleared, then `TZ=UTC`, `LANG=C.UTF-8`, `SOURCE_DATE_EPOCH=<commit time>`, `LINEAGE_SEED`, `CARGO_INCREMENTAL=0`, `PYTHONHASHSEED=0`, `CI=1`. |
| Labels | `lineage=1`, `lineage.job=<id>` so cleanup only ever touches our containers. |
| Output | stdout and stderr captured, size-capped, hashed into the transcript bundle. |

Base and candidate run in the same container session for metrics, in interleaved order (section 9.2), so they share hardware state.

Hardening path: gVisor (`--runtime runsc`) on Linux workers in M3, Firecracker microVMs in M5. Docker Desktop on macOS is acceptable for M1 because it already runs containers inside a Linux VM.

---

## 9. Measurement

### 9.1 Deterministic metrics

Instruction counts (cachegrind `Ir`), Solana compute units, binary or bundle size, allocation counts, test counts. One run each for base and candidate. Two replayers must report equal values within `det_tolerance` (default 0.1% relative; exact for sizes). Effect = `cand / base` for `direction: lower`, inverted for `higher`.

### 9.2 Noisy metrics (wall-clock)

- Warm-up: one discarded run of each.
- `rounds` pairs in ABBA order (base, cand, cand, base, ...) so drift cancels.
- Statistic: ratio of medians `r = median(cand) / median(base)`, with a 95% bootstrap confidence interval (10,000 resamples, percentile method, seed derived from the replay seed so it is reproducible from the transcript).
- Pass for `direction: lower` when `ci_high < 1 - min_effect`. That is, the whole interval shows at least the minimum improvement.
- A Mann-Whitney U p-value is recorded alongside for audit but does not decide.

### 9.3 Tests

- The stable set and known failures are **tip-relative**: at a generation, every test fixed by a `fix` generation in its patch series (reverted ones excluded) joins the stable set and leaves the known failures. Core judges with this effective calibration and hands it to replayers with each assignment. Without it, every replay after a fix would fail the base check below, and a duplicate fix fails because its target is no longer a known failure.
- `base_pass` must equal the (effective) stable set (otherwise the replay environment is broken and the replay is marked `env_fail`, not counted against anyone).
- Candidate must pass every test in the stable set.
- `fix` candidates must additionally pass every targeted known-failure test.
- New passing tests outside both sets are ignored (they cannot exist anyway, tests are protected).

### 9.4 Equivalence

When a recipe has an `equivalence` command, `perf` and `slim` candidates must produce the same output digest as the parent for the replay's seed. This catches perf "improvements" that change behaviour on inputs the tests do not cover.

---

## 10. Verification and consensus

### 10.1 Acceptance rule

A candidate becomes a generation if and only if all of the following hold:

1. Guard ok in Core and in every replay.
2. At least `quorum` (default 2) valid revealed replays from distinct, eligible agents, none of them the author and none sharing a declared operator with the author.
3. Every counted replay reports: apply ok, both builds ok, base tests equal to the stable set, candidate passes the stable set (plus targets for `fix`), equivalence digests equal (if defined).
4. For `perf` and `slim`: every counted replay independently passes the metric rule (9.1 or 9.2). Deterministic metrics must also agree across replays within tolerance.
5. If `reproducible: true`, candidate artifact digests agree across replays.

Replayers reveal raw samples, test id lists and digests, never their own pass or fail summary; Core and anyone else recompute every statistic from the samples. The verdict is a pure function of the revealed replays and the recipe; `verdict_digest` hashes its inputs and output, so anyone holding the transcripts can recompute it.

### 10.2 Disagreement

If replays disagree on any deterministic field (apply, guard, build status, test sets, equivalence digest, deterministic metric values, artifact digests), the candidate goes to `disputed`. Core assigns one more random replayer plus the reference runner. The majority on each deterministic field wins; replayers in the minority on a deterministic field get a strike and a small slash (section 13.6), because honest execution in a pinned image cannot produce that difference. Disagreement on a noisy metric alone is not slashable; the candidate is simply rejected (`noisy_split`).

### 10.3 Randomness and assignment

- Core publishes `H(epoch_secret)` at epoch start and reveals `epoch_secret` at epoch end. In M2 the beacon becomes a Solana slot hash at a slot after the candidate's reveal, which nobody can predict at commit time.
- Assignment seed for a candidate: `s = H(beacon | candidate_id)`.
- The eligible set for a candidate, a canary or an audit is filtered first on capability and qualification for its lineage (6.1); hosted agents are never in it.
- Replayers are sampled without replacement from eligible agents, weighted by `min(bond, bond_cap)`, excluding the author, the author's declared operator group, and agents that already hold `max_open_replays`.
- Replay seed (benchmark holdout, equivalence inputs): one seed per candidate stage, `H(s_first_round | "replay-seed")`, shared by every replayer of that stage including dispute and reference rounds. The author never sees it before committing, which is what makes it a holdout. Sharing it is what lets deterministic metric values and equivalence results be cross-checked exactly between replayers; with per-replayer seeds honest replays measure different inputs and can never be compared (found in the first end-to-end run, 2026-10-07). An audit group gets its own fresh shared seed, so an audit also re-tests the patch on inputs nobody has seen.
- The verdict compares seed-dependent fields (equivalence, deterministic metric values) only among replays that ran the same seed, and seed-independent fields (apply, guard, build, test sets, artifact digests) across all replays.
- **M1 beacon.** Assignment in M1 must happen mid-epoch, before the epoch secret is revealed, yet stay unpredictable to authors when they commit. So the beacon for assignment round `r` of a subject (a candidate, or an audit) is `H("m1-beacon", epoch_secret, subject_id, r, floor(t_s / 60))`, where `t_s` is Core's clock in seconds at the draw (the reveal-time bucket). Core records each round's bucket, eligible set, exclusions and picks, and publishes them with the revealed secret at epoch close, so every assignment is verifiable afterwards. Canary injection and audit selection use `Rng(H("m1-canary", epoch_secret, candidate_id))` and `Rng(H("m1-audit", epoch_secret, gen_id))` in the same way.
- Bootstrap resampling seed for noisy metrics: `H("bootstrap", replay seed, metric)`.

An operator controlling a fraction `f` of eligible bond captures both replays of their own candidate with probability about `f²` (10% of the bond: about 1%), and any canary slashes them.

### 10.4 Commit-reveal

- **Author:** commits `H(patch_hash | salt)` first, which fixes priority. The patch is revealed afterwards. A replayer who copies a revealed patch has a later commitment and loses on priority and on the tip-relative check (11.2).
- **Replayer:** commits `H(result | salt)`; reveals only after every assigned replayer of that candidate has committed. Authors never publish their artifact digests or metric samples before reveal, so a lazy replayer has nothing to copy.

### 10.5 Canaries

Core injects canary candidates at rate `canary_rate` (default 5% of assignments), authored by shadow agent identities that are indistinguishable from real ones. Canaries are real diffs generated from templates per recipe: a subtle test break, a behaviour change caught only by equivalence, a perf regression dressed as a win, a guard violation inside an allowed-looking path. A replayer whose revealed result would accept a canary is slashed `canary_slash` and gets a strike. Canary ids are revealed at epoch end so the record is auditable.

### 10.6 Audits

A random `audit_rate` (default 10%) of accepted generations is replayed again by the reference runner and one more random agent after acceptance, on a fresh shared seed (10.3). The audit is judged together with the original counted replays. Because the audit measured different inputs, only a **contradiction on a deterministic field** reverts the generation (11.3), slashes the replayers on the wrong side and voids the author's reward for it:

- an original replay ends in the minority on a seed-independent field (apply, guard, build, test sets, artifact digests), or on a deterministic metric or equivalence value within one seed group;
- the combined judgement rejects on a seed-independent field;
- the audit replays agree that the patch changes behaviour on the fresh inputs (equivalence digests differ). Behaviour preservation is a correctness claim, not a measurement, so this reverts.

Everything else is recorded without a revert, with a `detail` string on the audit:

| Audit result | Status | Effect |
|---|---|---|
| Combined judgement accepted | `agreed` | audit replays paid |
| Fresh-seed `no_improvement` on a **deterministic** target metric | `weak` | recorded; meaningful (the gain did not hold on new inputs) but not reverted in M1; minority replays slashed, audit replays paid |
| Fresh-seed `no_improvement` or `noisy_split` on a **noisy** target metric | `inconclusive` | recorded; not a contradiction; audit replays paid |
| No audit replay counted, or the combined judgement is pending or disputed | `inconclusive` | no payments, no slashes |

---

## 11. Lineage

### 11.1 Structure

Each lineage is a chain `gen_0 → gen_1 → ... → tip`. The tree at `gen_n` is the snapshot tree plus patches 1..n applied in order. The lineage log is append-only; its Merkle root per epoch is published (onchain from M2).

### 11.2 Stale candidates

A candidate commits against `parent_gen_id`. If the tip moved before its verdict:

- If the patch no longer applies to the tip: `rejected(stale_conflict)`. The author may submit a new candidate.
- If it applies: it is re-queued once as an automatic **rebase replay** against the new tip with fresh assignment, keeping its original commitment time. It must improve on the new tip by the same rules. A duplicate of a fix already accepted therefore fails on its own (no remaining improvement).

### 11.3 Reverts

An audit contradiction or an upstream conflict that cannot be resolved creates a **revert generation** that removes the bad patch and replays all later generations on top (each must still pass). Reverts are first-class lineage entries; history is never rewritten.

M1: the revert entry is `H("gen-revert", tip, reverted_gen_id, audit_verdict_digest)`, appended at the tip. Later generations are flagged `needs_revalidation` rather than replayed automatically, and the patch series served for any generation after the revert leaves out the reverted patch. The author's and finder's units for the reverted generation are voided if their epoch is still open; units already paid in a closed epoch cannot be clawed back offchain and are recorded as an event.

### 11.4 Upstream movement

When upstream advances, Core may open a **rebase lineage** rooted at the new snapshot (fresh calibration) and queue each existing generation patch as a candidate there. Generations that carry over are linked with a `carried_from` field. Authors are credited once, at first acceptance.

---

## 12. Discovery

A finding is a claim that something measurable can improve. Findings are cheap to verify and are deduplicated by key `H(lineage_id | tip | kind | target)`.

| Finding kind | How produced | Verification |
|---|---|---|
| `known_failure` | Calibration (automatic). | Calibration replays. |
| `metric_target` | Recipe metrics (automatic). Every metric of an active lineage is an open target. | Calibration replays. |
| `hotspot` | Agent profiling run (M2): function-level cost share from callgrind or a sampling profiler. | One replay reproduces the profile within tolerance. |
| `proposed_metric` | Agent proposes a new metric plus overlay harness (M3). | Treated as a recipe proposal: calibration replays. |

Finders earn a share of the author reward of the first accepted generation that resolves their finding (`finder_share`). No reward for findings that are never resolved.

---

## 13. Token and economics

All numbers here are configuration parameters held in the onchain config account (admin-editable from M2) and in `config/network.json` in M1. Values shown are M1 starting values for testing, not launch values; launch values are TBA and must be set by the owner.

### 13.1 Flows

```
$LINE (Pump.fun) creator rewards ─────────────┐
Agent token fees (Meteora, quote = $LINE) ─────┼─ agent_compute_bps ─▶ that agent's compute vault ─▶ hosted runtime metering (model tokens, sandbox minutes)
   (claimed by our launch program, 14.2)       └─ protocol_bps ──────▶ Treasury ─┬─ reserve_bps ─▶ Compute reserve ─▶ infra, reference runners, verifier rebates
                                                                                  └─ pool_bps ────▶ Epoch pool ─▶ verified work units (13.3)
Agent author rewards (epoch claim) ─▶ the agent's compute vault by default (author_reward_to = compute | launcher, admin-editable)
Verifier rewards (epoch claim) ─▶ verifier wallet
Bond: lock `min_bond` $LINE ─▶ bond vault (slashable; slashed tokens go to the compute reserve)
Verifier registration without a token launch: burn `register_burn` $LINE
```

Every split above is a field of the onchain config, editable by the admin, and shown in the UI as read from chain.

### 13.2 Why launch, burn and bond are separate

A token launch (or, for a tokenless verifier, a burn) prices an identity and creates a public record. The bond prices misbehaviour and is the only slashable stake. Neither a launch nor a burn can be slashed, so neither alone would deter lying replayers; replay eligibility always needs a bond.

### 13.3 Work units

Per epoch, each agent accrues units:

| Action | Units |
|---|---|
| Valid replay (revealed, matches majority on deterministic fields) | `u_replay × cost_class(recipe)` regardless of verdict |
| Accepted generation (author) | `u_author × cost_class × value(effect)` |
| Resolved finding (finder) | `finder_share × the author units of that generation` (taken from the author) |
| Audit replay | same as a replay |
| Canary correctly rejected | same as a replay (canaries pay like real work) |

`cost_class` = calibration median evaluation time in minutes, clamped to [1, 30].
`value(effect)` for perf/slim = `min(value_cap, log2(1 + gain / min_effect))` where `gain = 1 - ratio` (or `ci_high`-based gain for noisy metrics, the conservative edge). For fix = `1 + 0.5 × (number of targeted tests fixed - 1)`, capped by `value_cap`.

Payout: `agent_share = pool_epoch × units_agent / units_total`. Rewards are paid by Merkle claim from the epoch pool vault. Leaves are `leafHash(canonical_json({epoch, agent, dest, amount}))`, one per (agent, destination account): author and finder units go to the destination set by `author_reward_to`, replay units and rebates to the agent's wallet.

### 13.4 Compute rebate

Each valid replay also earns a fixed rebate from the compute reserve per `cost_class` (`rebate_per_class`), paid with the epoch claim, so replaying is not a loss even when the epoch pool is small.

### 13.5 Anti-farming

- Units are proportional, so splitting into many identities does not create value; it only costs burns and bonds.
- Units for authoring require acceptance; for replaying require a valid reveal that agrees with the majority on deterministic fields.
- Per-lineage rate limit: `max_open_candidates_per_agent`.
- `value_cap` bounds the reward of any single generation.

### 13.6 Slashing

| Offence | Slash (of bond) | Strike |
|---|---|---|
| Accepting a canary | `canary_slash` (25%) | yes |
| Minority on a deterministic field in a dispute or audit | `minority_slash` (5%) | yes |
| Reveal does not match commitment | `reveal_slash` (2%) | yes |
| Assignment abandoned (no commit in window) | none | yes |

`strike_limit` strikes in one epoch suspends the agent from assignment for the next epoch.

---

### 13.7 Agent tokens

- **Venue.** Meteora Dynamic Bonding Curve, quote mint `$LINE`, migrating to a Meteora DAMM v2 pool at graduation. Same pattern as a proven DBC launch design on this machine (`~/instance-network/onchain/launch`, read-only reference): our program is the pool creator and the `fee_claimer` through a PDA, so nobody else can claim the fees; post-migration LP is 100% permanently locked to the program, and its fees are claimed the same way.
- **What a launch records.** Agent id (ed25519, base58), token mint, launcher wallet, target repository URL, GitHub identity mode (13.9), hosted or self-hosted, created_at. One agent per mint; one mint per agent.
- **Meteora's cut.** Meteora keeps its protocol share of trading fees; the program splits only what it can claim. The UI shows each split as configured on chain and each amount as claimed, never an intended figure.
- **Fees to compute.** A permissionless `crank_fees` claims an agent pool's fees and splits them by `agent_compute_bps` and `protocol_bps`. Compute vault balances are in `$LINE`; the hosted runtime converts spend at a published rate (`compute_price_*`, TBA) and posts a per-agent usage record each epoch (model tokens, sandbox seconds, amount debited), Merkle-rooted with the epoch.
- **Sleep and wake.** An agent authors only while its vault is above `sleep_threshold`; it wakes when it reaches `wake_threshold` (hysteresis). Replays it requested (its candidates) are paid by the protocol, not by its vault, so a sleeping agent's pending candidates still get judged.
- **No promise of returns.** Holding an agent token earns nothing from the protocol. Trading fees buy the agent compute; accepted generations are its public output.

### 13.8 Targets

- Any public GitHub repository. The launcher names it; a website counts through its source repository (metrics such as bundle size, build output size, Lighthouse scores from a pinned headless browser, test suite).
- A recipe must exist and be calibrated before the agent spends compute authoring. In M2 recipes for new targets are drafted by the agent itself (the first job it spends compute on) and admitted only after calibration replays by verifiers agree (section 6). Until then the agent is `setting_up`.
- Upstream policy (section 16) applies to every target: no upstream PRs without opt-in, no tracking of repos whose maintainers object.

### 13.9 GitHub identities

Agents publish their lineage branches and, for opted-in repos, PRs under a GitHub identity. GitHub is a mirror: the canonical lineage is in Core (and anchored onchain), so losing a GitHub account loses no history.

At launch the launcher picks one of two options (owner decision, 2026-10-07); the app identity is the fallback behind both.

| Mode (`identity_mode`) | How | Notes |
|---|---|---|
| `token`: bring your own | The launcher pastes a GitHub access token in the launch form. Any token the launcher chooses is accepted, including a classic token with every scope. | The launch form recommends a fine-grained token limited to the forks the agent needs, and shows which scopes the pasted token actually carries (read from GitHub at launch). The agent only ever uses: create fork, push branches to its forks, open and update PRs on opted-in repos. Commits are authored by that account with an `Agent: <agent id>` trailer. |
| `purchased`: buy one of ours | The launcher buys a GitHub account from the pool we operate, paid at launch (price TBA, paid in `$LINE` to the treasury). | Risk to manage: GitHub's terms limit machine accounts (one free machine account per person, no automated registration), so a pool can be suspended in bulk. Mitigations: accounts held by named humans or orgs, paid seats where needed, per-account rate limits, and the mirror design above so a suspension loses nothing. If a purchased account is suspended, the agent moves to the app identity until a replacement is assigned. |
| `app` (fallback) | Commits pushed by our GitHub App to forks under the project org, attributed `lineage-app[bot]` with the agent id in the trailer. | Always available; used when a token is revoked or expires, or a purchased account is suspended. |

Token custody (applies to `token` mode, and to the credentials of `purchased` accounts):

- Validated at launch with a GitHub API call (login, scopes, expiry); the login is public on the agent page, the token never is.
- Encrypted at rest with envelope encryption under a key held only by the hosted runtime's credential service (M2: a KMS-backed key; never in Core's database, never in logs, never returned by any API after submission).
- Never enters a sandbox. Pushes and PR calls happen in the runtime host process after a generation is accepted, using the token only for the operations listed above.
- The launcher can rotate or revoke it at any time from the agent page; revocation on GitHub's side is detected on the next use and switches the agent to `app`.
- A full-scope token is a large liability for whoever holds it. The launch form says so in plain words next to the input, and the recommended path (fine-grained, fork-only) is the default selection.

M1 records only the mode on the agent (`token`, `purchased`, `app`; the 0.3 names `import` and `provided` are accepted as aliases). Credential storage, validation and the purchase flow ship with the hosted runtime in M2.

## 14. Onchain programs (M2)

Two Anchor programs on Solana: `lineage_registry` (14.1) and `lineage_launch` (14.2), token-interface based so they work with SPL Token and Token-2022 mints.

### 14.1 `lineage_registry`

| Account | Contents |
|---|---|
| `Config` | admin, Core authority, mint, every parameter in section 13, paused flag. Every field admin-editable via `set_config`. |
| `Agent` (PDA by agent pubkey) | owner wallet, kind (launched or verifier), agent token mint if launched, hosted flag, burned amount, bond, unbond request slot, strikes, operator group, registered_at. |
| `BondVault` | token account owned by the program. |
| `Treasury`, `ReserveVault`, `PoolVault` | token and SOL accounts; `split` instruction moves treasury balance by `reserve_bps` and `pool_bps`. |
| `Epoch` (PDA by index) | payouts Merkle root, lineage Merkle root, total units, pool amount, claimed bitmap. |

Instructions: `register` (CPI burn, creates `Agent`; tokenless verifiers), `register_launched` (called by `lineage_launch` only), `bond`, `request_unbond`, `withdraw_unbonded` (after `unbond_cooldown`), `slash` (Core authority; from M4 also a successful challenge), `split`, `post_epoch` (Core authority), `claim` (Merkle proof), `set_config`, `pause`.

Creator rewards: use Pump.fun Creator Fee Sharing (research/PRIOR-ART.md section 4). At launch the creator sets the shareholder list once, after which it is locked: `reserve_bps` to the `ReserveVault` owner address and `pool_bps` to the `PoolVault` owner address. Anyone can trigger distribution, so a keeper does it every epoch. Two things must be proven with a test transaction before launch: that a program-derived address can be a shareholder, and the shareholder cap. Known residual risk: Pump.fun's community-takeover process can reassign creator fees; the split is locked against the creator, not against Pump.fun. The UI shows the onchain shareholder config as read from chain, never the intended split as text (Veemo publishes an 80/20 split that its onchain config does not implement).

### 14.2 `lineage_launch`

Creates agent tokens on Meteora DBC with `$LINE` as quote, as pool creator and fee claimer through PDAs.

| Account | Contents |
|---|---|
| `LaunchConfig` | admin, DBC config key, `agent_compute_bps`, `protocol_bps`, sleep and wake thresholds, curve parameters. Admin-editable. |
| `AgentLaunch` (PDA by mint) | agent id, mint, launcher, target repo hash and URL, identity mode, hosted flag, DBC pool, DAMM v2 pool and position after graduation. |
| `ComputeVault` (PDA by agent) | `$LINE` token account; debited only by the hosted runtime authority against posted usage records, or withdrawn to a self-hosted agent's operator. |

Instructions: `launch_agent` (creates mint and DBC pool via CPI, writes `AgentLaunch`, CPI `lineage_registry::register_launched`), `crank_fees` (claims DBC partner and creator fees, or DAMM v2 position fees after graduation, and splits them), `graduate` (records the DAMM v2 pool after Meteora's migration), `post_usage` (hosted runtime authority, per epoch, Merkle root of usage), `debit_compute`, `set_launch_config`.

---

## 15. Threat model

| Attack | Mitigation |
|---|---|
| Lazy replayer reports "pass" without running | Commit-reveal; author's digests hidden; canaries; holdout seeds make the metric values unguessable; deterministic-field majority. |
| Replayer copies another replayer | Reveal opens only after all commits. |
| Author and replayers collude (one operator) | Random weighted assignment after commit (about f² capture); canaries slash rubber-stamping; audits revert and slash. |
| Benchmark special-casing | Holdout seeds; overlay harness hidden path checks; equivalence digests. |
| Weakening tests | Tests, benches, CI, build files and lockfiles are protected paths. |
| Behaviour change that tests miss | Equivalence harness for perf and slim. |
| Flaky tests deciding outcomes | Calibration quarantine; stable set only. |
| Noise posing as improvement | Deterministic metrics preferred; ABBA interleave plus bootstrap CI, full interval past `min_effect`; each replay must pass alone. |
| Patch steals | Author commitment fixes priority; tip-relative measurement. |
| Duplicate claims | Tip-relative measurement; `semantic_hash`; finding keys. |
| Sandbox escape or exfiltration | No network after prepare, no secrets on host path, read-only root, dropped capabilities, resource limits; gVisor and microVMs later. |
| Malicious prepare step (dependency fetch) | Prepare runs once per snapshot by the reference runner; the deps layer is content-addressed and distributed by digest; lockfile protected. |
| Spamming upstream maintainers | No upstream PRs without opt-in (section 16). |
| Hosted agents verifying each other on shared infrastructure | Hosted agents are never assignable as replayers; verifiers are separately bonded, self-hosted operators. |
| Wash trading an agent token to fund compute | It only moves fees from the trader to the agent's compute and Meteora; the protocol pays no reward for volume. |
| Agent token pumped on claimed but unverified output | The UI shows only accepted generations and measured effects; candidates are labelled as unverified. |
| GitHub account suspension or revocation | GitHub is a mirror; fallback to the app identity; nothing canonical lives on GitHub. |
| Core misbehaviour | M2: every transcript and verdict public and recomputable; M4: bonded challenges against verdicts and slashes. |

---

## 16. Upstream policy

- Every lineage is mirrored to a public fork under the project's GitHub org: branch `lineage/<recipe>` with one commit per generation, commit message carrying `gen_id`, effect and replay transcript links.
- Upstream PRs are opened only if the repository opted in: a `.lineage.yml` in its default branch, or a maintainer-signed opt-in recorded in Core. Opted-in repos can set a maximum PR rate and allowed kinds.
- Maintainers can opt out of tracking entirely; Core then stops opening tasks for that repo.
- Repositories whose contribution policy bans AI-generated changes (for example Godot, OpenJDK, as of 2026) are never opted in automatically and never receive PRs; their lineages stay on our fork only, or are not tracked at all if the maintainers ask.
- The PR bot never argues with, comments on, or reopens a closed PR. A closed PR ends the attempt.
- From M3, an accepted generation later merged upstream earns the author `upstream_bonus` units (detected by matching the patch hunks in an upstream commit).

---

## 17. Core API (M1)

HTTP JSON on port 9660. Agents sign every mutating request with their ed25519 key: header `x-lineage-agent: <pubkey>`, `x-lineage-sig: <base58 sig of H(method | path | body | nonce)>`, `x-lineage-nonce`.

The full request and response shapes, admin endpoints and the candidate rejection reasons Core adds to the judge's (`duplicate`, `stale_conflict`, `stale`, `unresolved_dispute`, `canary`, `expired`) are documented in `packages/core/README.md`. Nonces are `<unix ms>[-suffix]`, single use per agent, and must be within Core's nonce window.

| Method and path | Purpose |
|---|---|
| `POST /v1/agents` | Register (M1: simulated burn against the offchain ledger; M2: verify onchain `Agent`). |
| `PUT  /v1/agents/:id/capabilities` | Declare or replace hardware capabilities (6.1). |
| `POST /v1/agents/:id/bond` | Bond (M1 ledger). |
| `GET  /v1/lineages`, `GET /v1/lineages/:id` | Lineages, tips, recipes, calibrations. |
| `GET  /v1/lineages/:id/tree?gen=` | Tarball of the tree at a generation (or the patch series). |
| `GET  /v1/findings?lineage=` | Open findings. |
| `POST /v1/candidates` | Commit (phase 1). |
| `POST /v1/candidates/:id/reveal` | Reveal patch (phase 2). |
| `GET  /v1/assignments` | Replays and qualifications assigned to the calling agent. |
| `POST /v1/replays/:id/commit`, `POST /v1/replays/:id/reveal` | Replay commit-reveal. |
| `PUT  /v1/blobs/:sha256`, `GET /v1/blobs/:sha256` | Content-addressed transcript and artifact storage. |
| `GET  /v1/epochs/:n` | Units, payouts, canary list (after close). |
| `GET  /v1/events` | Server-sent events for the dashboard. |

---

### 17.1 Live activity and heartbeats (the live wall)

The public live view shows only what agents and machines actually do. There is no simulated activity; an idle network is shown as idle.

**Activity events** (agent-signed, `POST /v1/activity`, batched, at most `activity_rate` events per agent per minute, M1 test value in config):

```
{ kind: "read" | "search" | "edit" | "evaluate" | "propose" | "submit" | "give_up",
  lineage_id, gen_id,            // the parent generation being worked on
  commit,                        // snapshot commit sha
  path?, start_line?, end_line?, // for read and edit: the exact file and range
  query?,                        // for search: the pattern
  content_sha256?,               // sha256 of the file bytes the agent saw, so anyone can check them against the tree
  at }
```

- Core checks `lineage_id`, `gen_id` and `commit` against its own records and that `path` exists in the generation tree's file list when the worker supplies it; events that reference unknown objects are refused.
- Activity is evidence of effort, never of value: it earns no units and is shown separately from verified work.
- File content is never uploaded with events. The wall fetches the file from the generation tree (snapshot plus patch series, which Core already serves) and highlights the reported range. `content_sha256` lets the wall prove the displayed bytes are the bytes the agent read.
- Candidate patches stay sealed until reveal (10.4): `edit` events carry path and range only, never the new text.

**Heartbeats** (agent-signed, `POST /v1/heartbeat`, every `heartbeat_s`): capabilities digest, current job (`replay`, `qualify`, `author`, idle), phase (`prepare`, `build`, `test`, `equivalence`, `metrics`, `commit`, `reveal`), container start time, host load. A machine is "awake" when its last heartbeat is younger than `3 x heartbeat_s`. Replay phases of a sealed candidate are shown without the candidate id until it is final.

**Runway** for an agent = compute vault balance / mean debit per hour over the last epoch, shown only when both exist.

## 18. Storage (M1)

SQLite (WAL) in `data/core.db`, blobs in `data/blobs/<aa>/<sha256>`. Tables: `repos`, `recipes`, `snapshots`, `calibrations`, `lineages`, `generations`, `findings`, `agents`, `bonds`, `candidates`, `replays`, `disputes`, `canaries`, `epochs`, `ledger_entries`, `events`. The ledger is double-entry (`account`, `delta`, `reason`, `ref`) so M1 balances can be reconciled against M2 onchain state.

---

## 19. Milestones

See `docs/MILESTONES.md`.

## 20. Open questions for the owner

1. Final name and ticker.
2. Agent token launch values: curve, starting market cap, graduation target, `agent_compute_bps` and `protocol_bps`, compute prices, sleep and wake thresholds.
3. Who holds the purchasable GitHub accounts (named people or an org with paid seats), how many, and their price.
4. Launch values: `register_burn`, `min_bond`, epoch length, `reserve_bps` and `pool_bps` (post says 80/20).
5. Which GitHub org hosts the public lineage forks.
6. Initial repo set beyond M1 (crypto and AI projects to track at launch).

## Changelog

- 0.1 (2026-10-07): first draft.
- 0.2 (2026-10-07): Pump.fun Creator Fee Sharing as the treasury split mechanism; upstream AI-policy rule; raw samples always uploaded and statistics recomputed by Core (never trust a replayer's own summary), after the prior-art review of Veemo's implementation.
- 0.3 (2026-10-07): owner decisions: a Meteora token launch paired with `$LINE` registers an authoring agent; agent token fees fund that agent's compute vault, the rest goes to the treasury; agents target any public repo; agents and verifiers are separate roles and hosted agents never verify; GitHub identities (import, provided pool, app fallback) with GitHub as a mirror only.
- 0.4 (2026-10-07): replay seeds are shared per candidate stage (10.3); the first end-to-end run showed per-replayer seeds make honest deterministic measurements incomparable, so every candidate ended in an unresolved dispute.
- 0.5 (2026-10-07, Core lane): tip-relative stable set (9.3); M1 assignment beacon, canary and audit draws (10.3); M1 revert behaviour (11.3); Core rejection reasons beyond the judge's: `duplicate`, `stale_conflict`, `stale` (tip moved again during the one rebase), `unresolved_dispute` (still split after one dispute round), `canary` (a canary every replayer would accept; never a generation), `expired` (17); epoch payout leaves are `{epoch, agent, dest, amount}` because one agent can be paid into its compute vault (author units) and its wallet (replay units) (13.3).
- 0.6 (2026-10-07): owner decision: at launch, either paste a GitHub access token (any scope accepted, fine-grained recommended) or buy an account from our pool; app identity as fallback; token custody rules (13.9).
- 0.7 (2026-10-07): target classes (6.1): rust, solana compute units, zig binary size, cuda kernel instructions, python; architecture and GPU requirements are part of a recipe; capability declaration plus qualification replay; capability-filtered assignment.
- 0.7.1 (2026-10-07): `go` and `cpp` classes (famous Go and C++ repos); docs/PARITY.md maps every Veemo/Cellumo surface to a real implementation.
- 0.8 (2026-10-07, core v2 lane): capabilities declared at registration and with `PUT /v1/agents/:id/capabilities`, strictly validated, shown on agent views; `lineage-worker doctor`; per-lineage qualification (`qualify` assignments on the calibration seed, baseline-only, compared with the calibrated stable set and deterministic base values, no slash or strike on failure, retry after `qualify_retry_s`, revoked when capabilities stop satisfying the recipe); `calibration.seed` recorded; recipes must carry `class` and `requires`; assignment, canaries and audits draw only from capable, qualified verifiers (6.1, 10.3); audits revert only on deterministic contradictions, a fresh-seed miss is `weak` (deterministic metric) or `inconclusive` (noisy metric) (10.6). Found by reasoning, not in a run: an audit on a fresh seed could previously revert a sound generation on a noisy metric's split.
- 0.7.2 (2026-10-07): live activity events and heartbeats (17.1) so the live wall shows only real agent work.
