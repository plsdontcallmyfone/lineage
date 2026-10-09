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
2. `scripts/e2e.ts` on the fixture lineage with Core plus 4 workers (separate processes, separate keys) produces, from real Docker runs:
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

## Status as built (2026-10-08)

Marked by the finish verification lane (W8) from runs and committed records only: DONE (built, its exit evidence named), PARTIAL (built, with the named gap), NOT DONE. Devnet only; nothing here is on mainnet. The clean-clone record is `docs/VERIFICATION.md`.

## M2: onchain and public

| Item | Status | Evidence |
|---|---|---|
| `lineage_registry` Anchor program (SPEC 14), localnet tests, devnet deploy with a devnet test mint | DONE | LiteSVM 56/56 (`docs/VERIFICATION.md`); deployed and upgraded on devnet with the tLINE test mint, every upgrade hash-verified against the local build (`onchain/DEVNET.md`); plus `lineage_launch` (agent tokens on Meteora DBC, bounties) and `lineage_msg` (onchain messages) |
| Core reads registration and bonds from chain; posts epoch roots; agents claim by Merkle proof | DONE | `scripts/devnet/e2e-devnet.ts` 49/49 on 2026-10-08 (`scripts/devnet/E2E-DEVNET-LAST.json`); the live site runs Core in chain mode on devnet (`docs/DEPLOY-SITE.md`) |
| Slot-hash beacon for assignment (SPEC 10.3) | NOT DONE | assignment still uses the M1 beacon `H("m1-beacon", epoch_secret, subject, round, bucket)` in both modes (`packages/core/src/core.ts` `beacon()`); every round is published with the epoch secret, so draws are verifiable after the fact, but Core, which holds the secret, could predict them |
| Public transcript bucket and a `verify` CLI that recomputes any verdict from blobs | PARTIAL | `scripts/verify.ts` recomputes every verdict from the public API (21/21 on the e2e Core, 17/17 on the live site) and `scripts/replay.ts` re-runs any final candidate; transcripts and raw samples are served by Core's content-addressed blob store (`GET /v1/blobs/:sha256`), not yet by a separate public bucket |
| Linux worker image (`docker run lineage/worker`) for operators | NOT DONE | no worker image; operators run `packages/worker` with Bun, and the site runs verifiers as systemd units (`scripts/deploy/systemd/lineage-verifier@.service`) |
| Public lineage forks mirrored to GitHub | PARTIAL | `packages/mirror` (SPEC 16.1): Verified signed commits, idempotent identical rebuild, `scripts/mirror/W2-LAST.json` 14/14 on test repos; on the live site the 2 minbpe generations by an app-mode agent were recorded as app fallbacks and no agent with a pool account has a live generation yet (`scripts/mirror/W1-LIVE-LAST.json`); the site does not yet run the mirror on a timer |

## M3: scale the work

| Item | Status | Evidence |
|---|---|---|
| LLM discovery (hotspot findings with profiles) | DONE | SPEC 12.8; Claude hotspot on base58-rs `to_base58` reproduced by a replay and resolved by an accepted generation (`scripts/discovery/runs/`) |
| Agent-proposed recipes and metrics via calibration replays | DONE | SPEC 6.2; Claude-drafted `recipes/bech32-py` (sipa/bech32) calibrated by 2 verifier replays into an active lineage (`scripts/discovery/runs/`) |
| gVisor runtime on Linux workers | PARTIAL | `LINEAGE_DOCKER_RUNTIME=runsc` (`packages/sandbox/src/docker.ts`, test); measured on the site server: deterministic metrics within 0.01% of runc, verdicts identical, 1.4x to 1.5x wall time (`docs/GVISOR.md`); the site's verifiers stay on runc because geth-rlp would exceed its `wall_s` |
| Upstream opt-in registry, PR bot for opted-in repos, upstream-merge bonus | DONE | SPEC 16.2; `scripts/mirror/W2-LAST.json` 14/14: one real PR on an opted-in test repo, merged and credited `upstream_bonus` in a closed epoch of a local Core, none on the no-opt-in and AI-ban repos; the live site's Core must be redeployed to serve `/v1/upstream` |
| Recipe set: 20+ crypto and AI repos | DONE | 21 real repositories have recipes (base58-py, base58-rs, bech32-py, bip39-go, bip39-py, bitcoin-base58, btcd-bech32, geth-rlp, hmac-sha256-rs, lc-text-splitters, llama2c, llmc-cuda, md5-rs, minbpe, ollama-tokenizer, pyrlp, solana-config, spl-record, subword-nmt, zig-charm, zig-clap) plus 4 fixtures; the 9 added in W9c and spl-record (second solana recipe, 2026-10-09) each have a committed calibration, canaries 3/3 and hand-written candidates judged as expected by `check-canaries.ts`; 12 non-CUDA lineages run on the live site (`docs/DEPLOY-SITE.md`), the 10 new ones are calibrated on arm64 only |

## M4: contestable Core

| Item | Status | Evidence |
|---|---|---|
| Bonded challenges against any verdict, slash or epoch root within a window; resolved by fresh random replays | DONE | SPEC 10.8; LiteSVM challenge 6/6; `scripts/devnet/challenge-e2e.ts` 22/22 on 2026-10-08 (one upheld verdict challenge, one failed slash challenge, both resolved on chain; `scripts/devnet/CHALLENGE-E2E-LAST.json`) |
| Multiple Core replicas computing the same verdicts from the public log | DONE (read-only replicas) | `--replica-of` recomputes verdicts, audits, challenges, units and epoch roots from the public API; zero divergence against the live site in this verification (2 verdicts, 8 unit checks, 2 closed epochs; 15 terminal candidates without a replay verdict skipped) and against the e2e Core; replicas do not vote or take over |

## M5: mainnet

Owner only, not started: token launch (Pump.fun), treasury wiring of creator rewards, audit, Firecracker workers, launch parameters set by the owner.
