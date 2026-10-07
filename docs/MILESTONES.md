# Milestones

Each milestone ends with an exit check that is run, not asserted. Nothing is "done" until its exit check passes on a clean checkout.

## M1: the engine (local, offchain ledger)

Goal: the full discover, mutate, replay, judge, lineage loop running on real public repositories with real Docker sandboxes, several independent Worker processes and a Core, with every protocol rule in SPEC sections 6 to 13 enforced. Token flows are simulated in a double-entry offchain ledger with the same accounts the M2 program will have.

### Packages

| Path | What |
|---|---|
| `packages/protocol` | Pure, dependency-light: canonical JSON, ids (SPEC 4), canonical diff + guard (7), stats (9), verdict function (10.1, 10.2), work units (13.3), Merkle tree. Shared by Core and Worker so verdicts are recomputable anywhere. |
| `packages/sandbox` | Recipe loader and schema, Docker runner (SPEC 8), output parsers, `prepare`, `calibrate`, `evaluate(parent, patch, seed)` producing a replay result. |
| `packages/core` | HTTP API (SPEC 17), SQLite store (18), signature auth, commit-reveal, weighted random assignment, canaries, disputes, audits, lineage append and rebase, epochs, ledger. |
| `packages/worker` | CLI: keygen, register, bond, run loop (replay assignments first, then author). Proposers: `scripted` (deterministic mutators) and `anthropic` (LLM; needs the owner's key). |
| `apps/web` | Read-only dashboard on 9661: lineages, live candidates and replays, generations with effect and transcripts, agents, epoch units. Real data only. |
| `recipes/` | Fixture recipe plus at least two real repos (one crypto, one AI). |
| `fixtures/` | Generator for a local fixture repo with planted, known improvements and known traps, used by the e2e suite. |

### Exit check (all must pass)

1. `bun test` green in every package; protocol has property tests for canonical diff, guard, stats and verdict.
2. `scripts/e2e.sh` on the fixture lineage with Core plus 4 workers (separate processes, separate keys) produces, from real Docker runs:
   - one accepted `perf` generation (deterministic metric) and one accepted `fix` generation;
   - rejections with the right reason for: a test-breaking patch, a protected-path patch, a perf regression, an equivalence-changing patch, a duplicate of an accepted patch (tip-relative), a stale conflicting patch;
   - a canary rejected by honest workers, and a slash plus strike for a deliberately dishonest worker (`--dishonest accept-all`);
   - a lazy worker (`--dishonest copy-claim`) caught by a dispute and slashed;
   - an audit replay that agrees;
   - epoch close with units and payouts that reconcile to the ledger to the lamport.
3. Two real repos calibrated (stable set, quarantine, metric noise recorded) and at least one real candidate evaluated end to end by two replayers. Whether it is accepted is whatever the measurement says; the result is reported as measured.
4. Dashboard shows the above from the live Core with no placeholder values.
5. `docs/RUNBOOK.md` lets someone reproduce 2 and 3 from a clean clone.


### M1 additions (owner direction 2026-10-07: every Veemo/Cellumo surface, real; see docs/PARITY.md)

- Target classes with real lineages: rust (debris/base58, fixture), python (keis/base58, karpathy/minbpe), solana compute units (solana-program/config, cu-tally fixture), zig binary size (Hejsil/zig-clap, zigsize fixture), go and cpp (famous-repos lane), cuda (fixture + karpathy/llm.c, proven on one rented GPU session).
- Verifier capabilities, qualification replays, capability-filtered assignment (done, e2e 35/35).
- Live wall, machine wall, spawn page, manual page from real telemetry (live lane).
- `scripts/verify.ts` (recompute verdicts) and `scripts/replay.ts` (re-run any final candidate locally): done.
- Claude as author on real repos with a spend cap: first accepted candidate on minbpe (0.19 USD), confirmed by two independent replays.

## M2: onchain and public

- `lineage_registry` Anchor program (SPEC 14), localnet tests, devnet deploy with a devnet test mint.
- Core reads registration and bonds from chain; posts epoch roots; agents claim by Merkle proof.
- Slot-hash beacon for assignment (SPEC 10.3).
- Public transcript bucket and a `verify` CLI that recomputes any verdict from blobs.
- Linux worker image (`docker run lineage/worker`) for operators.
- Public lineage forks mirrored to GitHub.

## M3: scale the work

- LLM discovery (hotspot findings with profiles), agent-proposed recipes and metrics via calibration replays.
- gVisor runtime on Linux workers.
- Upstream opt-in registry, PR bot for opted-in repos, upstream-merge bonus.
- Recipe set: 20+ crypto and AI repos.

## M4: contestable Core

- Bonded challenges against any verdict, slash or epoch root within a window; challenge resolved by fresh random replays.
- Multiple Core replicas computing the same verdicts from the public log.

## M5: mainnet

- Token launch (Pump.fun), treasury wiring of creator rewards, audit, Firecracker workers, launch parameters set by the owner.
