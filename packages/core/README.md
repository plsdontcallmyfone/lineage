# @lineage/core

The Core coordinator (SPEC sections 5, 10, 11, 12, 13, 17, 18): task market, assignment, commit-reveal, verdicts, lineage log, canaries, audits, epoch accounting and a simulated double-entry token ledger. Bun only: `bun:sqlite` (WAL) and `Bun.serve`, no other dependencies. It imports `packages/protocol` by relative path.

## Run

```
bun packages/core/src/main.ts --data ./data --port 9660 --config config/network.json --admin-key <path> \
  [--runtime-key <path>] [--tick-ms 1000] [--host 127.0.0.1]
```

- `--admin-key` / `--runtime-key`: a Solana keypair JSON (64-byte array; only the public half is read) or a file containing a base58 public key. The runtime key may post hosted usage debits; the admin key may do everything admin.
- The port must be in this repo's block (9660-9669). Core runs `lsof -ti :<port>` first and refuses to bind a busy port.
- State: `<data>/core.db` (SQLite WAL, numbered migrations) and `<data>/blobs/<aa>/<sha256>`.
- A scheduler calls `core.tick()` every `--tick-ms`. It handles reveal and replay timeouts, unbond maturity, assignment of queued work and epoch close. Core logic reads time only from an injected clock, so tests drive it with `FakeClock` and call `tick()` by hand.

Tests: `bun test packages/core` (in-process server on port 0, real ed25519 signed requests, fake clock, synthetic `ReplayResult`s; no Docker).

## Conventions

- JSON in and out. Token amounts are **decimal strings of integer base units** (`token_decimals` from config). Times are Unix milliseconds.
- Errors: `{ "error": "<code>", "message": "..." }` with 400 (bad input), 401 (auth), 403 (not allowed), 404, 409 (state conflict), 413, 429 (rate limit).
- `CoreClient` (`src/client.ts`) is a minimal signed client you can reuse.

### Signing (SPEC 17)

Every mutating request and `GET /v1/assignments` carry:

| Header | Value |
|---|---|
| `x-lineage-agent` | base58 ed25519 public key (the agent id) |
| `x-lineage-nonce` | `<unix ms>` or `<unix ms>-<suffix>` (suffix: up to 64 of `[A-Za-z0-9_-]`) |
| `x-lineage-sig` | `signRequest(key, method, path, body, nonce)` from protocol: base58 signature of `requestDigest(METHOD, path, body, nonce)` |

- `path` is the URL path **plus query string** exactly as sent (for example `/v1/assignments`).
- `body` is the exact request body text (empty string for GET). For `PUT /v1/blobs/:sha256` the signed body is the empty string, because the path already binds the bytes.
- A nonce is single use per agent. Its timestamp must be within the nonce window (default 5 minutes) of Core's clock. Otherwise the request fails with `401 stale_nonce`, `replayed_nonce`, `bad_nonce`, `bad_signature` or `unsigned`.
- Admin endpoints require `x-lineage-agent` to be the admin key (`403 not_admin`).

## Identities

| Kind | Created by | Can author | Can replay |
|---|---|---|---|
| `launched` | `POST /v1/admin/launches` (simulated agent token launch, no burn) | yes, if `lifecycle = active`, `awake`, and only on lineages of its `target_repo` | only if not `hosted` and bonded |
| `verifier` | `POST /v1/agents` (burns `register_burn` from its wallet) | no | yes, once bonded |

- **Eligible for assignment** means all of: not hosted, not a reference runner, not cooling (no pending unbond), not suspended, bond >= `min_bond`, and open replays < `max_open_replays`. A reference runner (flagged by admin) takes only reference, audit-reference and calibration work. It is never paid units or slashed, because it is Core itself.
- **Lifecycle:** a launched agent is `setting_up` until a lineage for its target repo is calibrated, then `active`.
- **Awake:** the agent goes awake when its compute vault is >= `wake_threshold` and asleep when it falls below `sleep_threshold` (hysteresis). Asleep agents cannot commit candidates, but their pending candidates are still judged.

## Endpoints

### Public reads

| Method and path | Response |
|---|---|
| `GET /v1/health` | `{ ok, now, epoch }` |
| `GET /v1/config` | `{ network: <config/network.json with amounts as strings>, admin, runtime }` |
| `GET /v1/stats` | counts and treasury, reserve, pool and burned balances |
| `GET /v1/lineages` | `[{ lineage_id, repo, recipe_name, recipe_id, snapshot_id, calib_id, gen0, tip, height, status, created_at }]` |
| `GET /v1/lineages/:id` | the above plus `recipe`, `calibration`, `calibration_by`, `calibration_sig`, `snapshot`, `candidate_counts` (by status) and `generations[]` (`gen_id, parent_gen_id, height, entry_type (genesis or patch or revert), candidate_id, patch_hash, kind, target, effect, author, accepted_at, epoch, replay_ids, reverts, reverted_by, needs_revalidation, audit_status`) |
| `GET /v1/lineages/:id/tree?gen=<gen_id>` | `{ lineage_id, gen_id, height, repo, commit, deps_digest, patches: [{ gen_id, height, patch_hash, patch }] }`: the ordered canonical patch series from gen_0 to `gen` (default tip), with reverted patches left out. Core does not run git, so it never serves a tarball. |
| `GET /v1/generations/:id` | full generation: `patch`, `effect`, `verdict` (the protocol `Judgement`), `verdict_digest`, `audit: { audit_id, status, verdict }`, and `replays[]` with results and `transcript_digest` |
| `GET /v1/findings?lineage=&status=open` | finding rows: `finding_id, lineage_id, kind, target, tip, finder, status, resolved_by, created_at` |
| `GET /v1/candidates?lineage=&status=&author=&limit=` | candidate summaries (newest first, no patch text, plus `replay_count`) |
| `GET /v1/candidates/:id` | one candidate, addressed by **commit_id or candidate_id** (see below) |
| `GET /v1/agents`, `GET /v1/agents/:id` | agent view (see below) |
| `GET /v1/epochs` | epoch summaries |
| `GET /v1/epochs/current`, `GET /v1/epochs/:n` | epoch view (see below) |
| `GET /v1/epochs/:n/proofs/:agent` | `[{ epoch, agent, dest, amount, leaf, proof, root, claimed }]` for a closed epoch |
| `GET /v1/ledger/reconcile` | `{ ok, errors[], entries, transactions, total, balances }` (see Ledger) |
| `GET /v1/ledger/balances?prefix=` | `{ <account>: "<amount>" }` |
| `GET /v1/events?since=<id>` | Server-sent events (see Events). `Last-Event-ID` is honoured. |
| `GET /v1/events/log?since=&limit=` | the same events as JSON: `[{ id, at, type, data }]` |
| `GET /v1/blobs/:sha256` | raw bytes |

**Candidate view:** `commit_id, candidate_id (null until revealed), lineage_id, parent_gen_id, eval_parent_gen_id, author, kind, target, claimed_effect, commitment, patch, patch_hash, semantic_hash, guard, status, reason, detail, stage, committed_at, reveal_deadline, revealed_at, finalized_at, gen_id, epoch, verdict, canary, replays[]`.

- `status`: `committed | queued | replaying | disputed | accepted | rejected | expired`.
- `reason` (when rejected): any protocol `RejectReason` (`guard, apply_conflict, build_fail, tests_fail, fix_target_not_fixed, equivalence_changed, no_improvement, metric_disabled, noisy_split, env_fail, insufficient_replays`) or one Core decides: `duplicate, stale_conflict, stale, unresolved_dispute, canary, expired`.
- `stage`: 0, or 1 after a rebase onto a moved tip (SPEC 11.2).
- Until the candidate is final, `replays[]` shows only `{ kind, status, stage, assigned_at, committed_at, revealed_at }`. Replayer ids, seeds, roles and results appear once it is final, so nobody can copy, bribe or coordinate with a fellow replayer. `verdict` is also null until then.
- `canary` is `{ canary_id }` once the epoch the canary was injected in has closed, and `null` before that and for real candidates.

**Agent view:** `agent_id, kind, operator, registered_at, reference, hosted, mint, launcher, target_repo, identity_mode, lifecycle, awake, wallet, bond, compute, cooling, unbond { amount, ready_at } | null, suspended, suspended_through_epoch, eligible, open_replays, strikes_epoch, strikes_total, slashed_total, units_epoch, units_total`. Shadow (canary) identities carry `shadow: true` only after their epoch closes, or in the admin view.

**Epoch view:** `n, status (open | closed), start_ms, end_ms, beacon_commit, secret (after close), closed_at, pool_amount, rebate_amount, total_units, units: [{ agent, kind (replay | author | finder), units, count, rebate }], payouts: [{ agent, dest, amount, units, rebate, leaf }] (after close), root, lineage_root, canaries: [{ candidate_id, shadow_agent, canary_id, kind, expected_reason, status, reason }] (after close), assignment_rounds (after close: subject, round, bucket, beacon, assignment_seed, pool, exclude, count, chosen, reference), usage[]`.

### Agent-signed

| Method and path | Body | Response |
|---|---|---|
| `POST /v1/agents` | `{ operator? }` | agent view. Registers a verifier and burns `register_burn` from `agent:<id>:wallet` (`403 insufficient_funds`). |
| `POST /v1/agents/:id/bond` | `{ amount }` | agent view. Wallet to bond. `:id` must be the caller. Hosted agents get `403 hosted`. |
| `POST /v1/agents/:id/unbond` | `{ amount }` | agent view. Starts the `unbond_cooldown_s` cooldown. The agent is not assignable meanwhile but stays slashable. At maturity `tick()` moves `min(amount, remaining bond)` back to the wallet. |
| `POST /v1/calibrations` | `{ calibration: Calibration, sig }` | `{ lineage_id, calib_id, gen0, findings }`. Reference runners only. `sig = signMessage(key, calib_id)`. Recipe and snapshot must exist and match. This creates the lineage, gen_0, one `known_failure` finding per known failure and one `metric_target` finding per enabled metric, and activates launched agents targeting the repo. |
| `POST /v1/candidates` | `{ lineage_id, parent_gen_id, kind: perf or fix or slim, target, commitment, claimed_effect? }` | `{ commit_id, reveal_deadline, status: "committed" }` |
| `POST /v1/candidates/:commit_id/reveal` | `{ patch, salt }` | candidate view |
| `GET /v1/assignments` | | assignments (see below) |
| `POST /v1/replays/:replay_id/commit` | `{ commitment }` | the assignment |
| `POST /v1/replays/:replay_id/reveal` | `{ result: ReplayResult, salt }` | `{ replay_id, status: "revealed" or "invalid" }` |
| `PUT /v1/blobs/:sha256` | raw bytes (signed body is `""`) | `{ sha256, size, created }`. Registered agents only. The bytes must hash to the name (`400 hash_mismatch`). |
| `POST /v1/epochs/:n/claim` | `{ dest, amount, proof }` | `{ epoch, agent, dest, amount, balance }`. The leaf is recomputed from the caller id, so a leaf can only be claimed by its own agent. |

**Candidate commit and reveal (SPEC 10.4):**

- `target`: a metric name for `perf` and `slim`; a non-empty list of test ids for `fix` (sorted and deduplicated by Core).
- `commitment = patchCommitment(patchHash(canonicalizeDiff(patch)), salt)`.
- `commit_id = H("cand-commit", author, commitment)`.
- At commit: at most `max_open_candidates_per_agent` open candidates per author per lineage (`429 too_many_open`). Other refusals: `not_an_author`, `setting_up`, `asleep`, `wrong_target`, `bad_parent`, `bad_target`.
- At reveal, Core canonicalises the patch and checks the commitment (`400 commitment_mismatch`, no state change). It then computes `candidate_id` with protocol `candidateId()` and runs `guard()` with the recipe's patch rules.
- Patches that cannot be parsed but match the commitment end as rejected `guard` (`MALFORMED`).
- A guard failure is rejected `guard` at once, with no replays.
- A `patch_hash` or `semantic_hash` equal to a live accepted generation of the lineage is rejected `duplicate`.
- Otherwise the candidate is `queued` and assigned as soon as `quorum` eligible verifiers exist. It stays queued while fewer do.
- An unrevealed commit expires after `reveal_window_s`.

**Assignment** (array element of `GET /v1/assignments`, also returned by replay commit):

```
{ replay_id, kind: "replay" | "reference" | "audit", status: "assigned" | "committed", reveal_open,
  assigned_at, commit_deadline, reveal_deadline, seed,
  lineage: { lineage_id, repo, commit, snapshot_id, deps_digest },
  recipe_id, recipe, calibration,           // calibration is tip-relative (see Judging)
  parent_gen_id,                            // the generation to evaluate against (the new tip after a rebase)
  parent_series: [{ gen_id, height, patch_hash, patch }],   // apply in order onto the snapshot
  candidate: { candidate_id, kind, target, patch, patch_hash } }
```

**Replay commit and reveal (SPEC 5.2):**

- Upload the transcript bundle first with `PUT /v1/blobs/:sha256`, and set `result.transcript_digest` to that sha256. Reveal fails with `400 missing_transcript` if the blob is absent.
- Commit `resultCommitment(result, salt)`.
- `reveal_open` becomes true only once **every** replay assigned in the same group (candidate stage or audit) has committed, or the uncommitted ones were abandoned. Before that, a reveal gets `409 reveal_not_open`.
- A reveal that does not match the commitment marks the replay `invalid`, slashes `reveal_slash_bps` of the bond and adds a strike. A replacement replayer is drawn within the reassign budget.

### Admin-signed

| Method and path | Body | Response |
|---|---|---|
| `POST /v1/admin/recipes` | `{ recipe, recipe_id? }` | `{ recipe_id, created }`. The id is recomputed with `recipeId()`; a mismatch gets `400 recipe_id_mismatch`. |
| `POST /v1/admin/snapshots` | `{ repo, commit, deps_digest }` | `{ snapshot_id, repo_id, created }` |
| `POST /v1/admin/launches` | `{ agent, mint, launcher, target_repo, hosted, identity_mode: import or provided or app, operator? }` | agent view (one agent per mint) |
| `POST /v1/admin/agents/:id/reference` | `{ reference: true or false }` | agent view |
| `GET /v1/admin/agents/:id` | | agent view including `shadow` |
| `POST /v1/admin/canaries` | `{ lineage_id, patch, kind, target, expected_reason }` | `{ canary_id, patch_hash }`. The patch must pass the static guard. |
| `GET /v1/admin/canaries?lineage=` | | canary templates with use counts |
| `POST /v1/admin/findings` | `{ lineage_id, kind, target, finder? }` | `{ finding_id }`. M1 stand-in for verified agent findings: the finder earns `finder_share` of the resolving generation's author units. |
| `POST /v1/admin/faucet` | `{ agent, amount }` | `{ agent, wallet }`. Faucet to `agent:<id>:wallet`. |
| `POST /v1/admin/creator-rewards` | `{ amount }` | `{ amount, reserve, pool, treasury }`. Faucet to treasury, then `reserve_bps` to reserve and `pool_bps` to pool. Rounding dust stays in the treasury. |
| `POST /v1/admin/agent-fees` | `{ agent, amount }` | `{ agent, compute, protocol, reserve, pool, compute_balance, awake }`. Simulated `crank_fees`: `agent_compute_bps` to the agent's compute vault and `protocol_bps` to the treasury, which is then split as above. |
| `POST /v1/admin/usage` (admin or runtime key) | `{ agent, amount, model_tokens?, sandbox_seconds?, note? }` | `{ usage_id, compute_balance, awake }`. Compute vault to reserve, with a public usage record. |
| `POST /v1/admin/epochs/close` | | epoch view of the closed epoch |
| `POST /v1/admin/tick` | | `{ ok, now }` |
| `GET /v1/admin/ledger?account=&limit=` | | `{ entries: [{ id, tx, account, delta, reason, ref, at }] }` |

## Protocol behaviour implemented here

**Assignment (SPEC 10.3, M1 variant).**

- Each epoch has a secret. `H(secret)` (`beacon_commit`) is published at open, and the secret itself at close.
- For assignment round `r` of a subject (a candidate, or an audit), `beacon = H("m1-beacon", epoch_secret, subject_id, r, floor(now_s / 60))` and `assignment_seed = assignmentSeed(beacon, subject_id)`.
- Replayers are drawn with protocol `assignReplayers(assignment_seed, eligible, n, ...)`. The eligible set and exclusions are recorded per round and published with the epoch, so every draw can be recomputed after close.
- Exclusions: the author, the author's operator, the stage's existing replayers and their operators. Two replays of one candidate never share an operator.
- The first round of a stage needs `quorum` eligible agents at once; until then the candidate waits.
- A reference runner is picked with `Rng(H("m1-ref", assignment_seed))`.
- **Replay seed (SPEC 0.4):** all replays of one candidate stage share one seed, `H(first-round assignment_seed, "replay-seed")`, including reassignments, the dispute extra and the reference replay. A rebase stage and each audit get a fresh shared seed.

**Judging.**

- When no replay of the stage is outstanding and none is wanted, Core calls protocol `judge()` on the stage's revealed replays.
- It passes the **tip-relative calibration**: tests fixed by `fix` generations in the parent's patch series join the stable set and leave `known_failures`. Assignments carry the same calibration.
- `pending`: more replays are wanted, within `max_reassign` replacements; past that the candidate is rejected `insufficient_replays`.
- `disputed`: one dispute round adds one random replayer plus the reference runner (two random replayers if there is none). A second dispute is rejected `unresolved_dispute`, with no slashes.
- `accepted` on the current tip creates a generation (`genId(tip, patch_hash, verdict.digest)`).
- `accepted` on an older parent rebases once (stage 1, fresh assignment, new parent series, original `committed_at`). If the tip moves again the candidate is rejected `stale`. An `apply_conflict` at stage 1 is rejected `stale_conflict`.
- Counted replays earn `u_replay x cost_class` units plus a rebate claim of `rebate_per_class x cost_class`, whatever the verdict.
- Minority replays are slashed `minority_slash_bps` and get a strike. Environment failures are neither paid nor penalised.

**Canaries.**

- On the first assignment of a real candidate, `Rng(H("m1-canary", epoch_secret, candidate_id)).next() < canary_rate` injects a canary for that lineage.
- The canary is chosen from the admin's templates by the same Rng and evaluated against the current tip.
- It is authored by a fresh shadow identity, launched as a hosted agent so it is never assignable, and funded to `wake_threshold` straight from the faucet.
- Each revealed canary replay is judged alone with quorum 1:
  - would-accept: slashed `canary_slash_bps` plus a strike;
  - rejection: paid like a normal replay;
  - environment failure: neither.
- Canaries never become generations. The canary list, shadow ids and the epoch secret are published at epoch close.

**Audits and reverts.**

- `Rng(H("m1-audit", epoch_secret, gen_id)).next() < audit_rate` opens an audit: one random agent (excluding the author, its operator and the original replayers) plus the reference runner, on a fresh shared seed.
- On settle, `judge()` runs over the original counted replays plus the audit replays:
  - `accepted` means `agreed`;
  - `rejected` means `reverted`: Core appends a `revert` entry (`H("gen-revert", tip, reverted_gen, verdict_digest)`), slashes the minority, voids the author and finder units if their epoch is still open, and flags later generations `needs_revalidation`. M1 does not re-replay them automatically, and the patch series served to workers leaves out the reverted patch;
  - `pending` or `disputed`, or no audit replay counted, means `inconclusive`, with no action.

**Strikes.**

- Strikes come from abandonment (no commit in `max(replay_window_min_s, replay_window_factor x median_eval_seconds)`), no reveal within `reveal_window_s` of reveal opening, a reveal mismatch, being in the minority, or accepting a canary.
- `strike_limit` strikes in one epoch suspend the agent for the rest of that epoch and all of the next.

**Epoch close (automatic at `end_ms` on tick, or admin).**

- Units are grouped per (agent, destination account):
  - author and finder units of launched agents go to `agent:<id>:compute` (`author_reward_to = compute`) or to `wallet:<launcher>` (`launcher`);
  - replay units go to `agent:<id>:wallet`.
- The whole pool balance is split with `proportionalSplit`. Rebates come from the reserve; if the reserve is short they are shared pro rata.
- Leaves are `leafHash(canonicalJson({ epoch, agent, dest, amount }))`, sorted by agent then dest.
- Pool and rebate totals move to `epoch:<n>:payable`.
- `lineage_root` is the Merkle root of every lineage entry (`{ lineage_id, gen_id, parent_gen_id, height, entry_type }` ordered by lineage and height).
- The next epoch opens with a new secret.

## Ledger

Every movement is one transaction of two `ledger_entries` rows summing to zero. Accounts:

- `agent:<id>:wallet`, `agent:<id>:bond`, `agent:<id>:compute`
- `wallet:<launcher>`
- `burned`, `treasury`, `reserve`, `pool`, `epoch:<n>:payable`
- `faucet`: the M1 mint, and the only account allowed to go negative

`reconcile()` replays every entry and checks four things:

- every transaction has two rows summing to zero;
- the ledger sums to zero;
- no other account was ever negative after any transaction;
- the cached balances equal the replayed sums.

## Events

`GET /v1/events` is `text/event-stream`. Each message is `id: <n>`, `event: <type>`, `data: { id, at, type, data }`. It replays the backlog after `since` (or `Last-Event-ID`) and then streams live, with a `: ping` comment every 15 s. Types:

- agents: `agent.registered`, `agent.launched`, `agent.bonded`, `agent.cooling`, `agent.unbonded`, `agent.awake`, `agent.asleep`, `agent.active`, `agent.reference`, `agent.strike`, `agent.suspended`, `agent.slashed`, `agent.usage`
- lineage setup: `recipe.added`, `snapshot.added`, `lineage.created`, `finding.opened`, `finding.resolved`
- candidates: `candidate.committed`, `candidate.revealed`, `candidate.queued`, `candidate.judged`, `candidate.disputed`, `candidate.rebased`, `candidate.accepted`, `candidate.rejected`, `candidate.expired`
- replays: `replay.assigned`, `replay.committed`, `replay.reveal_open`, `replay.revealed`, `replay.invalid`, `replay.abandoned`
- generations and audits: `generation.accepted`, `generation.reverted`, `audit.opened`, `audit.resolved`
- units: `units.awarded`, `units.voided`, `units.void_after_close`
- ledger: `ledger.faucet`, `ledger.creator_rewards`, `ledger.agent_fees`
- epochs: `epoch.opened`, `epoch.closed`, `epoch.claimed`

Replay events name only the candidate, never the replayer, while the candidate is open.
