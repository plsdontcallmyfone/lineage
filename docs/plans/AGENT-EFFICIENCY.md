# Agent efficiency

Owner direction 2026-10-10: "we want these agents to be efficient as well." Efficiency here is
verified improvement per dollar and per hour (accepted generations per USD of model spend and per
hour of attempt time), not low spend. Measure first, change what the measurements point at, measure
again. Every figure below is computed by a script in `scripts/efficiency/` from the files it names;
nothing is estimated or modelled.

## 1. Baseline (site, before any change)

### Method

`bun scripts/efficiency/baseline.ts --fetch <dir>` reads, read only:

- the hosted runtime's journal on the site (`journalctl -u lineage-runtime -o short-iso`). One
  attempt runs per agent at a time, so each agent's lines from `attempt starts, cap X USD` to
  `attempt done: X USD model spend, S sandbox s, ..., candidate C | no candidate` are one attempt:
  its cap, every model turn (`turn N, X USD so far`), every self-evaluation, why it ended (`spend
  cap reached`, `gave up`, `ended without submit`, `turn limit`, `refusal`, `attempt failed`), its
  USD (model spend including the journal call), sandbox seconds, and its candidate;
- Core's SQLite (`sqlite3 -readonly -json`): every hosted agent's candidates with status and
  rejection reason, and the provenance records (attested by the runtime authority) with the token
  breakdown of each attempt that committed a candidate.

Columns: USD per attempt; attempts per accepted generation; USD per accepted generation; attempt
minutes per accepted generation (wall time from start to done, attempts of one agent run one after
another); model calls per attempt (median); minutes and sandbox seconds per attempt (median);
self-evaluations per attempt (median); share of attempts ending with nothing and why; share of
candidates rejected and why; tokens per model call (uncached input, output, cache read, cache
write) and cache hit rate (cache read over all input) for the attempts with provenance; the output
share of USD at the model's published prices.

Limits of the data: the journal on the site starts 2026-10-09 22:22 UTC (earlier attempts were in a
Core database that has since been rebuilt). Token breakdowns exist only for attempts that committed
a candidate (provenance); attempts that end with nothing are measured by USD, turns and time. 7
early attempts were logged before the runtime logged its model route ("unknown" below); every one
of the 26 provenance records in the window names `claude-opus-5-5`, and the runtime's rail default
model at the time was `claude-opus-5-5`. All hosted attempts in the window ran on Anthropic direct
(no OpenRouter attempt in the journal). Run: `scripts/efficiency/runs/site-0/` holds the output.

### Baseline table (attempts started 2026-10-09 22:23 to 2026-10-10 19:14 UTC, 49 finished attempts, 6 agents; verdicts read 2026-10-10 after every candidate in the window was final)

All attempts:

| attempts | USD/attempt | attempts per accepted | USD per accepted | attempt min per accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing | USD spent on attempts with nothing | candidates rejected by replay | tokens per call: in / out / cache read / cache write | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 49 | 0.3307 | 2.72 | 0.9002 | 10.4 | 5 | 3.6 | 128 | 1 | 47% (23/49): cap_reached 22, gave_up 1 | 9.3701 of 16.2035 (58%) | 31% (8/26): stale_conflict 8 | 2 / 1181 / 11238 / 3208 | 78% | 56% |

Per agent (all `claude-opus-5-5`; rows marked unknown are the early attempts described above):

| agent | attempts | USD/attempt | attempts per accepted | USD per accepted | min per accepted | calls (median) | min/attempt (median) | ended with nothing | USD on nothing | rejected by replay | tokens per call in / out / read / write | cache hit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5iCWSo (Wick Radix) | 6 | 0.2747 | 1.20 | 0.3296 | 3.4 | 5 | 3.0 | 1/6 cap_reached | 0.2361 | 0/5 | 2 / 1420 / 9700 / 3344 | 74% |
| 5t9wKL | 2 | 0.3899 | 2.00 | 0.7798 | 9.4 | 6 | 4.7 | 1/2 cap_reached | 0.3761 | 0/1 | 2 / 1867 / 18949 / 1866 | 91% |
| 5t9wKL unknown | 1 | 0.4690 | n/a | n/a | n/a | 10 | 6.6 | 1/1 cap_reached | 0.4690 | n/a | n/a | n/a |
| 63JTud | 5 | 0.3565 | 5.00 | 1.7823 | 18.4 | 6 | 3.7 | 3/5 cap_reached | 1.1786 | 1/2 stale_conflict | 2 / 872 / 15792 / 3926 | 80% |
| 63JTud unknown | 1 | 0.4041 | n/a | n/a | n/a | 7 | 5.0 | 1/1 cap_reached | 0.4041 | n/a | n/a | n/a |
| 6C8N2z (TEST) | 23 | 0.3151 | 2.56 | 0.8053 | 10.2 | 5 | 3.6 | 8/23 cap_reached | 3.7798 | 6/15 stale_conflict | 2 / 988 / 10597 / 3002 | 78% |
| 6C8N2z unknown | 4 | 0.2584 | n/a | n/a | n/a | 3 | 1.7 | 4/4 cap_reached | 1.0335 | n/a | n/a | n/a |
| BFPxda | 4 | 0.4329 | 4.00 | 1.7317 | 18.4 | 6.5 | 4.9 | 3/4: cap_reached 2, gave_up 1 | 1.3492 | 0/1 | 3 / 1446 / 14732 / 4552 | 76% |
| BFPxda unknown | 1 | 0.5437 | n/a | n/a | n/a | 6 | 5.6 | 1/1 cap_reached | 0.5437 | n/a | n/a | n/a |
| CLy55w (Neap) | 2 | 0.2817 | 2.00 | 0.5633 | 6.9 | 3.5 | 3.5 | 0/2 | 0 | 1/2 stale_conflict | 3 / 2105 / 5904 / 3859 | 60% |

Full output: `scripts/efficiency/runs/site-0/baseline.md` and `baseline.json` (no candidate ids).

### What the baseline says

1. **Cap stops are the largest waste.** 22 of 49 attempts (45%) ended at the per-attempt spend
   cap with no candidate, and they took 9.37 of 16.20 USD (58% of all model spend). The cap rule
   ("projected") stops before a call when spend so far plus the last call's cost would pass the
   cap. A single long thinking turn costs 0.2 to 0.3 USD on the site (the last turn before the 22
   stops cost 0.026 to 0.318 USD), so after one such turn at a 0.42 USD effective cap (0.50 minus
   the 0.08 journal reserve) the rule ends the attempt, even when the remaining turns (evaluate,
   submit) cost a few cents. The same rule does not hold the cap either, since one turn can run
   past it: 12 of the 22 cap-stopped attempts spent more than the 0.42 USD the proposer may use, 5
   more than the whole 0.50 cap (largest: 0.6222 USD, journal call included).
2. **Stale conflicts are the only replay rejections.** 8 of 26 candidates (31%) were rejected
   `stale_conflict` ("patch does not apply to parent"). 7 were authored on the same parent as the
   agent's own previous candidate while that one was still being judged (each next attempt starts
   30 s after the last ends and edits the same function; 6C8N2z 6, 63JTud 1), 1 across agents
   (CLy55w after 5iCWSo on the same lineage). No candidate was rejected for performance, tests or
   equivalence.
3. **Output tokens are most of a call's cost** (56% of USD at Opus 5.5 rates; effort `high`), cache
   writes most of the rest. Cache reads already cover 78% of input tokens: the automatic breakpoint
   caches each turn's prefix and the next turn reads it, so the cacheable prefix is not the problem.
4. **Time:** a median attempt is 3.6 minutes, of which about 2 minutes is the one self-evaluation in
   the sandbox (128 s median); 5 model calls and 1 evaluation per attempt. Early stopping after two
   failed evaluations would rarely fire (median 1 evaluation; 1 attempt of 49 gave up).

## 2. Changes (each behind configuration, off by default)

Picked by expected impact from the baseline:

| change | targets | where | setting |
|---|---|---|---|
| bounded cap mode | cap stops (58% of spend) and cap overruns | `packages/worker/src/proposers/efficiency.ts`, `anthropic.ts` | runtime.json `efficiency.cap_mode: "bounded"` (default `projected`), `efficiency.min_turn_tokens` (default 4096) |
| stacked authoring on the agent's own pending candidate | stale conflicts (31% of candidates) | runtime `series` (worker SPEC 12.4, existed, was off), worker commit path | runtime.json `efficiency.series: true` |
| effort | output tokens (56% of USD) | existing runtime `effort` | runtime.json `effort` |
| usage line per attempt | measurement: token breakdown for every attempt, not only committed ones | `anthropic.ts` | `efficiency.log_usage` (default on) |

**Bounded cap mode.** Before each call the proposer sets `max_tokens` to what is left of the cap
after the call's worst-case input cost: the previous input at the cache read rate (at the write rate
when more than 270 s have passed, past the 5 minute cache life), the previous output and the newly
appended tool results (estimated at 2 characters per token, an over-count for code) at the cache
write rate, then divides the rest by the output rate, at most 64000. The attempt stops when that
allowance is below `min_turn_tokens`, or when a response is cut at its allowance (its tool calls
cannot run). The cap then holds per call by construction instead of by projection, and the
evaluate-and-submit turns that cost cents still run after a long thinking turn. Tests:
`packages/worker/test/efficiency.test.ts` (allowance math; projected stops after a 0.3 USD turn at a
0.5 cap; bounded runs the cheap turns and stays under the cap; bounded stops below the minimum and on
a cut response).

**Stacked authoring.** With `series` on, the worker authors the next attempt on top of the agent's
own newest revealed, still pending candidate and commits it with `depends_on`; Core holds it until
the dependency is final, then measures it on the tip (SPEC 12.4, unchanged, with its author-blind
rules). One gap made it unsafe for the site's timing (judgement takes 2 to 5 minutes, an attempt
about 4): if the dependency became final while the attempt ran, Core answers 409 `dependency_final`
and the attempt's work was lost. The worker now checks the tip: when the dependency was accepted the
tip is exactly the tree the change was made and measured on, so it commits there as an ordinary
candidate; otherwise it drops the change (logged).

**Scope:** the cap mode and the usage line are in the Anthropic proposer, which runs every hosted
attempt in the baseline. The OpenAI-compatible proposer (models routed through OpenRouter or other
providers) keeps its projected cap and its own settings; `series` applies to every proposer.

Commits: c9c8f00 (proposer, runtime block, scripts), eb8ac23 (baseline, A/B tooling), 690aacd
(notice), the worker's `dependency_final` handling landed inside cd08c39 (another lane committed the
shared working file with this hunk in it).

**Not done, and why:**

- Cheaper helper pass to pick a hotspot first: off. The soul fixes the authoring model and
  provenance attests one model per attempt; a helper model choosing the target would author part of
  the change with a model the soul did not pick. Kept off under the fixed-model rule.
- Cacheable prefix rework: the cache already covers 78% of input; writes are mostly each turn's new
  output and tool results, which no breakpoint placement avoids.
- Early stop after two evaluations without gain, reuse of baseline measurements across attempts:
  median 1 evaluation per attempt, so early stop has little to act on; reusing the parent's
  measurements would cut about half of the 128 s evaluation but lives in `packages/sandbox`
  (`evaluate` measures both sides each time), outside this lane. Left as a follow-up.
- Tool output trimming: not measured to matter yet (reads are about 2000 tokens of new input per call).

## 3. A/B (local, real model)

`scripts/efficiency/ab.ts` runs one authoring attempt per cell with `claude-opus-5-5` in every arm,
under the site's cap (0.50 USD per attempt with 0.08 kept back for the journal call, so 0.42 for the
loop), no soul and no notes in any arm; after the attempt, every submitted change is replayed once
more in the sandbox with a fresh seed the author never saw and judged by the recipe's own rules
(what one verifier does). Arms differ only in these settings:

| arm | effort | cap mode |
|---|---|---|
| A (site before) | high | projected |
| B | high | bounded |
| C | medium | bounded |
| D | medium | projected |

Runs (results, logs and diffs in `scripts/efficiency/runs/ab-*`):

- ab-1, gen 0 of fixture-b58 and minbpe (one round, 6 attempts, 0.7133 USD): all 6 submitted and
  replay-accepted in every arm (0.0688 to 0.1856 USD each). At gen 0 the easy wins are still there
  and no attempt came near the cap, so it shows nothing about the cap; kept as a control.
- ab-2, ab-3, ab-4: minbpe at the site's tip (height 16: the 16 accepted patches from the site's
  minbpe lineage, `runs/ab-2/minbpe-tree.json`), where the site's agents work and where the cap
  stops happened. ab-2 (A0, B0) ran B with the wrap-up notice of the projected mode; after A0 gave up
  "out of budget" at 0.25 of 0.42 USD right after the notice, bounded mode got the 70%-only notice
  (commit 690aacd) and ab-3 and ab-4 ran with it.

Results at the tip (ab-2, ab-3, ab-4 together):

| arm | attempts | USD/attempt | submitted | accepted by the replay | USD per accepted | author s per accepted | output tokens per attempt (mean) | ended with nothing (why) |
|---|---|---|---|---|---|---|---|---|
| A high, projected (site before) | 4 | 0.2621 | 1 | 1 | 1.0482 | 507 | n/a for ab-2; 9189 in ab-3 | 3: gave up, each citing the budget or an improvement under the 1% minimum |
| B high, bounded | 4 | 0.3151 | 1 | 1 | 1.2605 | 601 | 12075 in ab-3 | 3: cap reached 2, gave up 1 |
| C medium, bounded | 3 | 0.2242 | 3 | 3 | 0.2242 | 118 | 6936 | none |
| D medium, projected | 3 | 0.2320 | 2 | 1 | 0.6959 | 1158 | 5873 | 1 gave up; 1 submitted change the replay could not finish (insufficient replays: its evaluation ran 14 min) |

Reading: at effort high one thinking turn takes 9k to 13k output tokens (0.2 to 0.27 USD), which
leaves no room in a 0.42 USD loop: the projected mode gives up after it, the bounded mode stops
when the next call could only be a few thousand tokens. Effort medium alone (D) cut output tokens
but still lost attempts to the projection; medium with bounded calls (C) submitted 3 of 3 and every
one was accepted by the independent replay, at 0.2242 USD per accepted change against 1.0482 for the
site's settings (A), and 118 s of author time per accepted change against 507 s. The samples are
small (3 or 4 attempts per arm at the tip); the site run below is the larger check.

Total A/B spend: 4.3906 USD of Anthropic usage metered by the script, plus at most two model calls of
attempts stopped by hand at their start (ab-1 B1, ab-2 C0), which the script did not meter. No
OpenRouter model was used.

Winning settings, enabled on the site: `effort: "medium"`, `efficiency: { cap_mode: "bounded",
series: true }` (scripts/deploy/site-config.ts). `series` is not in the A/B (one attempt at a time
cannot conflict with itself); it is judged on the site by the stale conflict count.

## 4. Site after the change

PENDING
