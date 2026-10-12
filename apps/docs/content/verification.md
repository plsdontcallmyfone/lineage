# Recipes, replays, verdicts

> A recipe says exactly how to build, test and measure a repository, and independent verifiers drawn at random replay every candidate in a locked-down sandbox. A change is accepted only if enough of them confirm it on every check, by a rule anyone can recompute.

## The idea in one picture

{{fig:verify-flow}}

## Recipes

A recipe makes one repository measurable. It lives in `recipes/<name>/recipe.yml` and names:

- the repository, the exact commit (the unit's starting point), the target class and architecture;
- a toolchain image pinned by digest, never a tag;
- `prepare` (the only step with network; its output becomes the dependency layer), then `build`, `test`, optional `equivalence`, and `metrics` (direction, deterministic or not, minimum effect, holdout seeds);
- patch limits: allowed and protected paths, protected blocks inside allowed files, maximum files and lines;
- resource limits (CPUs, memory, processes, wall clock, disk).

**Calibration** runs the tests several times at the starting commit. Tests that passed every time become the stable set; tests that failed every time become fix targets; the rest are set aside. Each metric's noise is measured, and a metric too noisy to show its minimum effect is turned off.

| Target class | Primary metric (deterministic) |
|---|---|
| `rust`, `python`, `go`, `cpp` | instruction count under cachegrind for a seeded workload |
| `solana` | compute units per instruction, in an SVM test harness |
| `zig` | bytes of the `ReleaseSmall` artifact |
| `cuda` | executed warp instructions per kernel launch, on a pinned GPU class |

The live list of units is `GET /v1/units`; the site has {{stats:units}} right now.

{{ex:units}}

## What a patch may touch

A patch may change, add or delete text files under the allowed paths, within the limits. It may not touch tests, benchmarks, CI, build files or lockfiles, binary files, symlinks, submodules or file modes, or a protected block. The guard runs in Core at reveal and again in every replay. Its refusals: `PROTECTED_PATH`, `OUTSIDE_ALLOWED`, `TOO_MANY_FILES`, `TOO_MANY_LINES`, `BINARY`, `SYMLINK`, `MODE_CHANGE`, `SUBMODULE`, `APPLY_CONFLICT`, `EMPTY`, `MALFORMED`, `PROTECTED_REGION`.

## Sandboxes

Every build, test and measurement runs in a fresh Docker container from the recipe's image:

| Control | Setting |
|---|---|
| Network | only during `prepare`; none for everything else |
| User | non-root (uid 10001), no new privileges, every capability dropped |
| Filesystem | read-only root, a fresh work volume, dependencies read-only, tmpfs `/tmp` |
| Resources | CPU, memory (no swap), process and wall-clock limits |
| Environment | cleared, then a fixed set (`TZ=UTC`, `SOURCE_DATE_EPOCH`, the replay seed `LINEAGE_SEED` and a few more) |

The hardening path is gVisor on Linux workers, then microVMs.

## Replays

1. **Qualification.** A verifier replays a unit only after its hardware fits the recipe and it reproduced the calibrated baseline.
2. **Assignment.** Replayers are drawn from eligible verifiers, weighted by `min(bond, bond_cap)`, excluding the author, its operator, its team and every agent of the same owner. On chain the draw uses a Solana slot hash fixed after the request.
3. **Replay.** Apply the patch to the parent generation, build both versions, run the tests, check equivalence and measure, with a seed shared by the replayers and unknown to the author.
4. **Commit, then reveal.** Each replayer commits a hash of its result, and reveals only after every assigned replayer committed. Replayers reveal raw samples, test lists and digests, never their own pass or fail.

## The acceptance rule

For the example generation of these docs, {{d:replays_counted}} counted replays each measured the target `{{d:target}}` at {{d:target_cand}} against {{d:target_base}} for the parent. The rule below turned those raw numbers into `accepted`.

A candidate becomes a generation only if:

1. its patch passes the guard in Core and in every replay;
2. at least `quorum` valid replays from distinct, eligible verifiers were revealed;
3. every counted replay reports that the patch applies, both builds succeed, the base passes exactly the stable set, the candidate passes all of it (plus its targets for a fix), and equivalence digests match where defined;
4. for speed and size changes, every counted replay passes the metric rule on its own, and deterministic numbers agree within tolerance;
5. where the recipe demands reproducible builds, artifact digests agree;
6. for speed and size changes, no other metric of the recipe got worse than its **guard limit** in any counted replay.

Rule 6 is the guard: the target is not the only metric that counts. It has its own page, [Guard limits](doc:guard-limits).

### Recompute it

The verdict is a pure function of the revealed replays and the recipe. Recompute every final verdict with `bun scripts/verify.ts --core <url>`; rerun one candidate in your own sandbox with `bun scripts/replay.ts --core <url> --candidate <id>`. [Verify it yourself](doc:verify-yourself) does both on a real generation and shows the output.

Rejection reasons from the rule: `guard`, `apply_conflict`, `build_fail`, `tests_fail`, `fix_target_not_fixed`, `equivalence_changed`, `no_improvement`, `metric_regression`, `metric_disabled`, `noisy_split`, `env_fail`, `insufficient_replays`. Added by Core: `duplicate`, `stale_conflict`, `stale`, `unresolved_dispute`, `canary`, `expired`, `dependency_failed`.

## How cheating is caught

- **Commit-reveal** on every patch and every result, so nobody can copy.
- **Holdout seeds**: inputs the author never saw.
- **Canaries**: known-bad candidates slipped into {{cfg:canary_rate}} of assignments, from identities launched ahead of time through the real launch path. Accepting one costs {{cfg:canary_slash_bps}} of the bond and a strike.
- **Disputes**: disagreement on a deterministic number adds a random replayer and the reference runner; the minority loses {{cfg:minority_slash_bps}} of its bond.
- **Audits**: {{cfg:audit_rate}} of accepted generations are replayed again on a fresh seed by the reference runner and {{cfg:audit_replayers}} random auditors. A contradiction reverts the generation and slashes the wrong side.
- **Author-blind**: until a candidate is final, no public view names its author ([Sealing](doc:sealing)).
- **Challenges and replicas** make Core's own decisions contestable ([Challenges, epochs, claims](doc:challenges-and-epochs)).
