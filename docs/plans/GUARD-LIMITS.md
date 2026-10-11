# Guard limits on non-target metrics

Owner decision 2026-10-11. Spec: `docs/SPEC.md` 10.1 rule 6 (v0.38). This note records the why and
the choices behind the rule; the spec is the source of truth.

## 1. Problem

Until now only the target metric decided acceptance. Every other metric of the recipe was measured
and checked for replay agreement (`det_tolerance`, 0.1%) but could get worse without limit. Two
accepted generations the owner named: zig-charm `a3f70746` (target improved, `aead_ir` +5.5%) and
solana-config `fb39a847` (target improved, `so_bytes` +7.5%).

## 2. Rule

Every recipe metric other than the target is guarded: it may worsen by at most its limit, a fraction,
default 1%. A candidate whose guarded metric worsens beyond the limit in any counted replay is
rejected with `metric_regression` and a detail naming the metric, the measured change and the limit.

Aggregation, chosen to mirror how the target is judged (every counted replay alone, worst replay
decides):

| Metric | A replay exceeds when | Mirror of the target rule |
|---|---|---|
| deterministic (counts, sizes, compute units) | `orientedRatio(median base, median cand) > 1 + limit` | target passes when the ratio is `<= 1 - min_effect` |
| noisy (wall-clock) | the whole 95% bootstrap interval is beyond: `ci_low > 1 + limit` | target passes when `ci_high < 1 - min_effect` |

Same bootstrap seed and resample count as the target, so the check is recomputable from the
revealed samples. A noisy metric therefore rejects only on evidence, never on noise.

Choices:

- **Disabled by calibration = not guarded.** Calibration turns off metrics too noisy to resolve their
  `min_effect`; those are not measured in replays at all.
- **Missing samples reject (`unmeasured`).** Replays measure every enabled metric. If a guarded
  metric has no valid samples (for example its command broke on the candidate), the candidate cannot
  show it stayed within the limit. A recipe whose metric is unreliable gets an override of `null`.
- **Target first.** The guard decides only when the target passed in every replay, so a candidate
  that missed its target keeps the reason `no_improvement` or `noisy_split`. Checks are still recorded.
- **Fix candidates are not guarded by default.** Their target is tests, not a metric, and a
  correctness fix may cost a little speed. The config has `kinds` (default `perf`, `slim`); adding
  `fix` guards them too. Owner can flip this with one admin call.
- **Audits and challenges.** A fresh-seed `metric_regression` in an audit is recorded like a fresh-seed
  target miss: `weak` if a deterministic metric failed, `inconclusive` if only noisy ones did; it never
  reverts. In a challenge, a guard failure on noisy metrics only is a noisy outcome (not a flip).

## 3. Where the limits live

Recipes are frozen: their bytes feed `recipe_id` and unit ids, so no recipe file changes. Instead:

- **Network default:** `config/network.json` `guard_max_regression` (0.01) and `guard_activation_ms`
  (0 = active from Core's first start with this code). These seed guard config version 1 only.
- **Guard config in Core** (`packages/core/src/guard-config.ts`, table `guard_configs`): append-only
  versions `{ version, effective_from_ms, default_max_regression, kinds, overrides, digest }`, where
  `overrides` maps `recipe_id` to `{ metric: fraction | null }` (`null` = unguarded, for example a
  noisy timing). `digest = H("guard-config", canonical JSON)`.
- **Admin edits:** `POST /v1/admin/guard-config` with any of `default_max_regression`, `kinds`,
  `overrides` (a recipe's whole map; `null` removes it), `effective_from_ms`. Each edit is a new
  version, effective strictly after Core's clock (default clock + 1 ms) and never before the previous
  version. Unknown recipe ids, unknown metric names and out-of-range limits are refused.
- **Public:** `GET /v1/guard-config` returns every version and the activation time.

## 4. Which rule a verdict uses

A candidate is judged with the version in force at its `committed_at`: the latest version with
`effective_from_ms <= committed_at`. None means rule version 1 (the original rule, no guards). Since a
new version is always effective after Core's clock, an edit never changes the rule of a candidate
already committed, including one still replaying, disputed, audited or challenged later.

| Candidate | Rule | Verdict shape |
|---|---|---|
| committed before activation | 1 | unchanged; no new fields; digest unchanged |
| committed at or after activation | 2 | `rule_version: 2`, `guard_limits: { config_version, config_digest, checks }` inside the hashed outcome |

`scripts/verify.ts` and the replica (`packages/core/src/replica.ts`) fetch the versions, recompute each
version digest, pick each candidate's version from its `committed_at` and recompute its verdict, so
old verdicts are checked with the old rule and new ones with the new rule. verify.ts prints the count
per rule version.

## 5. Unchanged

Author-blind replay and sealing: the config names no candidate; verdicts are public only once final.
Replay agreement within `det_tolerance` still applies to every deterministic metric. Worker
self-checks apply the guard too (section 7).

## 6. UI and docs

The generation page summary shows each non-target metric as `guarded, limit 1%: passed` (or
`exceeded`) from the verdict's checks; generations judged by rule 1 keep `not judged`. Docs:
Recipes, replays, verdicts (`apps/docs/content/verification.md`), Core API notes for the two routes.

## 7. Worker self-evaluation (replica roots + worker guard lane, 2026-10-11)

The author's own pre-submit judge (`evaluate` tool in `packages/worker/src/proposers/anthropic.ts`,
shared by every model proposer, and `selfCheck` in `worker.ts`) judges with the same rule replays use:

- **Rule in force.** On every evaluation the worker reads `GET /v1/guard-config` and picks the
  version in force now for the recipe (`packages/worker/src/guard-limits.ts`). No version in force, or
  a Core without the route (404): rule version 1, as replays would judge it. Any other read failure
  keeps the last rule read in the attempt; with none, that evaluation cannot be submitted (an
  unreadable config is never treated as no guards).
- **Regression.** When the self-judgement rejects with `metric_regression`, the evaluate result
  starts with `guard regression on <metric>: <metric> worsened <change> against the parent; the limit
  is <limit>` (or `has no valid samples`), the submit tool refuses with the same metric, and the model
  may change the patch and evaluate again within the attempt's remaining budget and evaluation count.
- **Not submitted.** The worker never commits while the last evaluation regressed a guarded metric;
  an attempt that ends that way records the outcome `guard regression on <metric>: measured change
  <change>, limit <limit> (guard config version <n>); not submitted`.

Tests: `packages/worker/test/guard-limits.test.ts` (a +5% `decode_ir` change is refused, a +0.5% one is
submitted; the model fixing it within the attempt; rule version 1 unchanged; an unreadable config).

### Replica record roots, epochs 13, 15, 17, 18

The replica reported these four record roots as divergent. Cause: it enumerated agents from
`GET /v1/agents`, which leaves hidden launches out unless `hidden=1` (core hidden filter lane), so the
records and contribution leaves of hidden agents never reached its recomputation. Core's published
roots are correct: on the site database every record and contribution leaf rehashes from its record
and the sorted leaves root to the published value for all four epochs (leaves 15, 14, 58 and 31; the
plain listing gave the replica 7, 2, 16 and 11 of them). The replica now reads `/v1/agents?hidden=1`;
no historical exception is needed. Test: `packages/core/test/replica-records.test.ts`.

