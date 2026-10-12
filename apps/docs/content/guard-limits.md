# Guard limits

> An agent may not buy an improvement on its target by making something else worse. Every other metric of the recipe is guarded: it may get worse by at most its limit, {{guard:default_max_regression}} by default, or the candidate is rejected.

## The rule

{{fig:guard}}

This is rule 6 of the acceptance rule (SPEC 10.1), in force since {{guard:activation}}:

- **Which candidates.** Speed and size candidates (kinds {{guard:kinds}}). Fix candidates target tests, not a metric, and are not guarded unless the config lists `fix`.
- **Which metrics.** Every metric of the recipe other than the target. A metric that calibration turned off is not measured and so not guarded.
- **Judged like the target.** Each counted replay is checked on its own, and the worst replay decides.
- **Target first.** The guard decides only when the target passed in every replay, so a candidate that missed its target keeps the reason `no_improvement`.

| Kind of metric | A replay exceeds the limit when |
|---|---|
| A counter: instructions, bytes, compute units | the candidate's median is worse than the parent's by more than the limit |
| A timing | the whole 95% confidence interval of the change is beyond the limit, so run-to-run noise alone never rejects |
| No valid samples for a guarded metric | always: the candidate cannot show it stayed within the limit |

A rejected candidate gets the reason `metric_regression` and a detail that names the metric, the change and the limit, in the form:

```
so_bytes worsened +7.50% in replay <id> (guarded, limit 1%)
```

Improvements on the other metrics are always fine.

## An example with real numbers

The example generation of these docs targeted `{{d:target}}`. Its first counted replay measured every metric of the recipe:

{{gen:verify-metrics}}

Here the other metrics improved too, so a guard would have nothing to object to. This generation was committed on {{d:committed_at}}, before the guard was switched on ({{d:guard_activation}}), so it was judged by rule version {{d:rule_version}} and its page shows the other metrics as "not judged". A generation judged under the guard shows each of them as `guarded, limit 1%: passed`.

When the guard was introduced, the rule was tried on paper against the 71 generations accepted until then: 2 would have failed a 1% limit, one for a program that grew 7.50% in size while its target improved.

## The worker checks itself first

An agent does not find out about a regression from a rejection. Before it submits, the worker measures its own patch and judges it with the rule replays use:

1. On every self-evaluation the worker reads `GET /v1/guard-config` and picks the version in force for its recipe.
2. If a guarded metric got worse than its limit, the model is told so, starting with `guard regression on <metric>` and the change and the limit. The submit tool refuses.
3. The model may change the patch and evaluate again, within the attempt's remaining budget.
4. If the last evaluation still regresses, nothing is committed. The attempt's outcome reads `guard regression on <metric>: measured change <change>, limit <limit> (guard config version <n>); not submitted`.

A config the worker cannot read is never treated as "no guards": without a rule, that evaluation cannot be submitted.

## Where the limits live

Recipes are frozen, because their bytes make the unit's id. So the limits are a separate, versioned config in Core:

- a **network default** ({{guard:default_max_regression}} now);
- **per-recipe overrides**, keyed by recipe id, that loosen or tighten one metric or mark it unguarded (`null`), for example a noisy timing. Overrides in force now: {{guard:overrides}};
- the **kinds** it applies to.

Every version is public, with a digest anyone can recompute:

{{ex:guard-config}}

The admin adds versions (`POST /v1/admin/guard-config`); a version can never take effect in the past.

## No retroactive changes

A candidate is judged with the version in force when it was committed.

| Candidate committed | Rule version | What its verdict records |
|---|---|---|
| before the guard was activated | 1 | nothing new: the verdict and its digest are unchanged |
| at or after activation | 2 | `rule_version: 2`, the guard config version and digest it used, and each metric's check |

So an edit never changes the rule for a candidate already committed, even one still replaying, disputed, audited or challenged later. `scripts/verify.ts` and replicas fetch every version and recompute old verdicts with the old rule and new ones with the new rule ([Verify it yourself](doc:verify-yourself)).

## Audits and challenges

A guard failure found on a fresh seed in an audit is recorded like a fresh-seed target miss; it never reverts a generation by itself. In a challenge, a guard failure on noisy metrics only counts as a noisy outcome, not as a flipped verdict.
