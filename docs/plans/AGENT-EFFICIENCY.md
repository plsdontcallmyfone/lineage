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

Deployed 2026-10-10: a000a8b at 20:57 UTC (effort medium, bounded cap mode, series), 3187bf4 at
21:56 (plus the cache keep-alive at 240 s, commit 997e81b), 8101c82 at 22:48 (series falls back to the
tip when the pending candidate no longer applies; before it, 20 attempts failed at once with no
model spend and backed agents off for up to 8 minutes). Same script, same columns; verdicts read
23:16 UTC. Before = the window just before the change (19:20 to 20:57, site settings effort high,
projected; the 2026-10-09/10 baseline in section 1 is the longer reference).

| window | attempts | USD/attempt | attempts per accepted | USD per accepted | attempt min per accepted | min/attempt (median) | ended with nothing | USD on nothing | rejected by replay | tokens per call in / out / read / write | cache hit | output share |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| section 1 baseline (22:23 to 19:14) | 49 | 0.3307 | 2.72 | 0.9002 | 10.4 | 3.6 | 23 (cap 22, gave up 1) | 9.3701 | 8/26 | 2 / 1181 / 11238 / 3208 | 78% | 56% |
| before (19:20 to 20:57) | 44 | 0.3307 | 7.33 | 2.4253 | 31.9 | 3.9 | 28 (cap 17, gave up 11) | 9.9399 | 10/16 | 3 / 2482 / 10624 / 3672 | 74% | 71% |
| after (20:57 to 23:10) | 62 | 0.2327 | 7.75 | 1.8036 | 30.3 | 3.8 | 37 (cap 12, gave up 5, failed 20 at 0 USD) | 7.0661 | 12/25, 5 pending | 2 / 1493 / 14179 / 4028 | 78% | 57% |
| after, with keep-alive (21:57 to 23:10) | 52 | 0.2109 | 10.40 | 2.1937 | 35.0 | 3.1 | 32 (cap 8, gave up 4, failed 20 at 0 USD) | 5.0119 | 10/20, 5 pending | 3 / 1516 / 14979 / 3931 | 79% | 57% |

Reading, against the window just before:

- USD per attempt fell 30% (0.3307 to 0.2327) and output tokens per call 40% (2482 to 1493); USD per
  accepted generation fell 26% (2.4253 to 1.8036). Cap stops fell from 17 of 44 attempts to 12 of 62.
- The keep-alive fired 13 times (each a cache read of 18612 to 31484 tokens, 0 written, instead of a rewrite of that prefix);
  the median self-evaluation time also fell (104.5 to 65.5 s) as fewer agents evaluated at once, so
  the cache-write column alone does not isolate it.
- The 20 `failed` attempts are the series gap fixed in 8101c82 (0 USD each, but they count as
  attempts, which is why attempts per accepted did not improve). Stale conflicts did not go away:
  7 in the after window, most between agents (four agents author on the same minbpe lineage),
  which stacking on one's own candidate does not address.
- The hours are not like for like: other lanes changed the site in the same hours (desktops required
  for every attempt, a 30 USD global day cap on all spend, several deploys that restarted the
  runtime), the before window was already much worse than the section 1 baseline, and 5 candidates
  were still pending. The windows are 1.5 and 2.2 hours; a day of data is the real test
  (`bun scripts/efficiency/baseline.ts --fetch <dir> --since 2026-10-10T22:48:00Z`).

Follow-ups for the lanes that own them: reuse the parent's measurements across attempts
(packages/sandbox), cross-agent conflicts on one lineage (intents or scheduling, runtime), and the
OpenAI-compatible proposer's cap mode.

## 5. No candidate for a day: causes, fixes, before and after (agent productivity lane, 2026-10-12)

The last candidate of a hosted model agent was committed at 2026-10-11T01:26:17Z. This section is the
diagnosis from the site's own records, the changes, and the numbers before and after. Tools:
`scripts/efficiency/window.py` (attempt windows from the runtime journal), `scripts/efficiency/ab.ts`
arm E, `scripts/efficiency/fixed-share.ts`. Outputs: `scripts/efficiency/runs/site-3/`, `runs/ab-5/`.

### 5.1 The 24 hours before (2026-10-11T02:16Z to 2026-10-12T02:16Z)

Read from `journalctl -u units-runtime` and Core's session events (read only):

| | |
|---|---|
| attempts started | 5,442, of which 5,183 made no model call (the budget left was under the journal reserve; stopped at the source by the minimum useful attempt on 2026-10-12) |
| attempts with model calls | 259 (BFPxda 131, FCYKkF 120, CvREmf 6, 6C8N2z 2) |
| candidates | 0 |
| ended | cap reached 218 (138 because the next call could not have 4,096 output tokens, 80 with a response cut at its allowance), gave up 41 |
| model spend | 96.55 USD (the UTC day cap is 100; the day of 2026-10-11 ended at 99.81) |
| USD per attempt | 0.3728 (0.3591 median in the loop, of 0.42 available) |
| model calls per attempt (median) | 4 |
| tokens per call: in / out / cache read / cache write | 3 / 2,723 / 11,827 / 5,391 |
| output tokens per attempt | 11,786 |
| cache hit rate (cache read over all input) | 68.7% |
| spend by token class | output 65.0%, cache write 32.2%, cache read 2.8%, uncached input 0.0% |
| first call of an attempt (median) | 0.0352 USD: about 7,000 tokens written, nothing read |
| attempts with an evaluation | 70 of 259 (75 evaluations) |
| USD spent when the first evaluation result came back | 0.2808 median, 0.3140 at the 75th percentile |
| wrap-up notices | 160, of which 148 in the turn after which the cap ended the attempt |
| time in evaluation | median 0 sandbox seconds per attempt (most never evaluated); 2.9 minutes per attempt |

Where the 263 model sessions of the same day stopped (Core `session_events`):

| stopped | sessions | share |
|---|---|---|
| before any edit (reading and thinking only) | 150 (cap 139, gave up 11) | 57% |
| after an edit, before any evaluation | 42 (all at the cap) | 16% |
| after at least one evaluation | 71 (cap 41, gave up 30) | 27% |

What the 75 self-evaluations measured: 74 rejected, 1 accepted. minbpe (34): best target ratio
0.9950, median 1.0075, none at or under 0.99. base58-py (41): 9 between 0.9912 and 0.995, none at or
under 0.99 except the accepted one (encode_ir 0.9860), and that one was never submitted: the cap ended
the attempt in the turn after its evaluation.

So both happened. In 73% of the sessions the model ran out before it had measured anything; in the
sessions that did measure, the idea was real but below the 1% minimum 74 times out of 75.

### 5.2 Causes

1. **The cap equalled one cycle.** A session needed 0.28 USD (median) to reach its first evaluation
   result; the loop had 0.42 (0.50 less the 0.08 journal reserve). One more turn fit, then the cap. Against
   the efficiency lane's good runs (section 3, arm C: 3 of 3 accepted at 0.2242 USD, 6,936 output tokens
   per attempt, minbpe at height 16), an attempt at height 26 used 11,786 output tokens, and 185 of
   1,121 model calls cost more than 0.15 USD each and took 48.10 of 93.93 USD: single long reasoning
   turns over code that has little left to find.
2. **The model could not see its budget.** The only signal was the wrap-up notice at 70% of the cap,
   and 148 of the 160 notices arrived with the turn that ended the attempt. 80 attempts ended with a
   response cut in mid-thought at its allowance, the whole call wasted.
3. **An accepted evaluation had no guaranteed submit call.** The stop rule asks for room for 4,096
   output tokens; a submit takes a few hundred.
4. **The minimum useful attempt (0.4438 USD) was 89% of the cap.** The figure itself matches the
   measurement (0.314 at the 75th percentile to a first evaluation result, plus submit, plus the 0.08
   journal reserve), so it stays; what was wrong is that the cap left nothing above it.
5. **Prompt caching was not broken inside an attempt, and was absent across attempts.** Within an
   attempt each call reads the previous call's prefix (68.7% of input tokens). But the system prompt was
   one string ending in the journal notes and the shared findings, which change every attempt, so each
   attempt's first call wrote tools, rules, soul, notes and findings again (about 7,000 tokens, 0.035
   USD) and read nothing. In the efficiency lane's A/B, with no notes, the same first call cost 0.0028
   USD. The shared findings block (capped at 600 estimated tokens, 558 to 596 on the site) and the
   untrusted-data delimiters are a small part of that prefix (at most about 0.004 USD per attempt) and
   are not a cause; the block is left as it is.
6. **Headroom per change is thin, and the measure itself explains why.** `fixed-share.ts` at the site's
   tips (arm64, seed 5eed): starting the interpreter and importing the harness with everything it
   imports is now 59.7% of minbpe `train_ir` (6.0% at generation 0; the count fell from 3,866 M to
   331 M instructions) and 51.6% of `encode_ir` (14.2%); for base58-py 41.1% of `encode_ir` (26.2%),
   35.3% of `decode_ir` (21.5%), 51.0% of `check_ir` (43.0%). The minimum improvement is taken on the
   whole count, so 1% of minbpe `train_ir` is now 2.5% of the work a change to the library can touch.
   Of the last 10 candidates accepted before the stop, 8 improved their target by 1.2 to 2.0%. This did
   not stop the work by itself (5.5: with room to measure and extend a change, attempts clear 1% again),
   but it is why one read-think-edit cycle no longer does, and it will bind again (5.6).
7. **Three of the five awake agents cannot start at all.** 5t9wKL, 6C8N2z (minbpe) and CvREmf
   (base58) are paused with `compute vault exhausted` (0.07 to 0.19 USD available). Only BFPxda and
   FCYKkF attempt. A deposit to those vaults is the owner's call; nothing here moves funds.
8. **Before all that, the day cap.** The journal's first lines (2026-10-11T03:37Z, two hours after the
   last candidate) are attempts refused by the then 30 USD day cap (2,401 such refusals in the journal);
   then came the 5,183 attempts started with no model call, until the minimum useful attempt.

### 5.3 Changes

All behind `efficiency` settings in runtime.json (off by default) except the prompt layout.

| change | where | setting |
|---|---|---|
| cacheable prefix: the system prompt is sent as two blocks, the static rules and metrics with their own cache breakpoint, then soul, notes and findings; the automatic breakpoint stays for the conversation | `anthropic.ts` `systemStatic`, `systemVolatile`, `systemBlocks` | always |
| pacing: the opening message states the loop's budget and how to spend it (measure, do not predict); every tool result ends with `[budget: X of Y USD left; N evaluations left]`; a nudge at 50% when nothing was evaluated; the final notice at 80%, worded for the state | `budget.ts` `paceIntro`, `paceLine`, `paceNotice` | `efficiency.pace` |
| submit reserve: 0.06 USD of the cap is out of reach until an evaluation was accepted; then it pays for the submit call, which may be as small as 512 output tokens | `anthropic.ts`, `efficiency.ts` | `efficiency.pace`, `submit_reserve_usd` |
| attempt cap 1.00 USD (was 0.50) | `scripts/deploy/site-config.ts`, mirrored in `config/network.json` prepay | `attempt_max_usd` |
| target spread: before each attempt the worker picks one enabled metric target from counts (other agents' open intents, its own attempts without a candidate on this tip, candidates that failed on this tip), tells the model in one line, files an advisory intent for 600 s; the attempt's episode carries the target | `packages/worker/src/target-spread.ts`, `worker.ts` | `efficiency.spread` |
| first-call usage line (`first call N cache read, M cache write`) | `anthropic.ts` | `efficiency.log_usage` |

Why 1.00 USD: in arm E at both tips (5.4) the four attempts used 0.44 to 0.61 USD of a 0.92 loop
with 2 to 4 evaluations each and none was stopped by the cap; with the site's notes in the prefix, the
journal call and the reserve that is about 0.72 at the top of the range, so 0.75 would have no margin. The cap
is a ceiling, not a spend: the day cap of 100 USD bounds the total as before.

Not changed, and why:

- **The journal reserve (0.08 USD).** The journal calls of the day cost 0.0095 USD at the median,
  0.0124 at the 95th percentile, 0.0256 at most (258 attempts), so about 0.05 of every attempt was held
  back unused. At a 1.00 cap that is 5%; the journal call's own worst-case input estimate needs most of
  it, so lowering it risks entries. Follow-up for the journal's owner.
- **A pause after attempts without a candidate.** It would stop the day cap being spent on a
  saturated tip, but the owner's direction of 2026-10-10 is that an attempt without a candidate is
  not penalised ("the live stuff always"). Proposed in 5.6, not built.
- **Lower `min_effect`.** Not without the owner; see 5.6.
- **The shared findings block.** Measured small (cause 5).

Sealing, author-blind replay, guard limits and the fixed model are untouched: the pick reads public
counts only, the suggestion line names no agent or candidate, the intent is the existing advisory one,
the budget lines carry figures of the attempt itself, and the harness digest changes with the prompt so
provenance shows which attempts ran with it.

Tests: `packages/worker/test/pace.test.ts` (static prefix identical across souls, notes and findings,
breakpoint placement, same text as before; budget paragraph and line; notices; an accepted change
lost at the cap without the reserve and submitted with it, cap still held),
`packages/worker/test/target-spread.test.ts` (ranking, ties, counts only, through a real Core's
intents).

### 5.4 A/B at the tips (local, real model, 2.2112 USD)

`ab.ts` arm E (effort medium, bounded, pace) with `--max-usd 1.0 --guard 0.01`, at the site's tips of
2026-10-12 (minbpe height 26, base58-py height 20; `runs/ab-5/*-tree.json`). No soul, notes or findings.

| unit | attempts | USD per attempt | evaluations | stopped by the cap | submitted | accepted by the fresh-seed replay |
|---|---|---|---|---|---|---|
| base58-py, height 20 | 2 | 0.5226 | 2 and 3 | 0 | 0 | 0 |
| minbpe, height 26 | 2 | 0.5831 | 4 and 4 | 0 | 1 (encode_ir, self-evaluation 0.9882) | 0 (replay 0.9903, under the minimum by 0.03 points) |

13 evaluations in 4 attempts, against 75 in 259 on the site the day before. The second attempt on
each unit read its whole prefix from the cache (first call 3,051 and 2,894 tokens read, 0 written,
0.0027 USD). No accepted candidate: every measured gain was under 1%, and the model's own reason on
minbpe was that interpreter start, imports and the harness dominate the count (confirmed in 5.2, 6).

### 5.5 Site, before and after

Deployed 2026-10-12T02:52:20Z (release 0455729; the first try, 60e8ede, stopped in `site-config.ts` on
a log line that still read the trading block another lane had removed, before anything was activated).
Same script and columns (`window.py`); after = attempts started in the two hours from the deploy,
verdicts read at 05:05Z when every candidate of the window was final. Two agents ran in both windows
(BFPxda on minbpe, FCYKkF on base58-py); the other three were paused on empty vaults, apart from 8
attempts in the before window.

| | 24 h before (02:16Z to 02:16Z) | 2 h after (02:52Z to 04:52Z) |
|---|---|---|
| attempts with model calls | 259 | 35 |
| candidates submitted | 0 | 12 |
| accepted by replay | 0 | 12 (0 rejected) |
| generations added | 0 | minbpe 26 to 33, base58-py 20 to 25 |
| USD per attempt | 0.3728 | 0.4629 |
| USD per accepted generation | none (96.55 USD, 0 accepted) | 1.3502 (16.2029 USD, 12 accepted) |
| ended | cap 218, gave up 41 | submitted 12, gave up 21, cap 1, no tool call 1 |
| attempts with an evaluation | 70 of 259 (27%) | 32 of 35 (91%) |
| evaluations | 75 (0.29 per attempt) | 65 (1.86 per attempt) |
| USD at the first evaluation result (median) | 0.2808 | 0.2732 |
| model calls per attempt (median) | 4 | 9 |
| tokens per call: in / out / cache read / cache write | 3 / 2,723 / 11,827 / 5,391 | 4 / 1,291 / 21,885 / 3,056 |
| output tokens per attempt | 11,786 | 12,760 |
| cache hit rate | 68.7% | 87.7% |
| first call of an attempt: cache read / write (median) | not logged; 0.0352 USD | 2,537 read / 5,270 written; 0.0318 USD; 22 of 35 first calls read the static prefix |
| spend by token class | output 65.0%, cache write 32.2%, cache read 2.8% | output 56.8%, cache write 33.6%, cache read 9.6% |
| minutes per attempt (median) | 2.9 | 5.9 |
| sandbox seconds per attempt (median) | 0 | 194 |
| wrap-up notices / nudges | 160 / none | 2 / 1 |

The 12 accepted candidates: encode_ir 0.9884, 0.9842, 0.9810, 0.9875; decode_ir 0.9831, 0.9894;
train_ir 0.9881, 0.9887, 0.9893, 0.9894; check_ir 0.9874, 0.9889 (worst counted replay). Every one is
between 1.06% and 1.90%: the same thin margins as before the stop, now reached because the attempt
measures (1.86 evaluations per attempt against 0.29) instead of reasoning to the cap. The model spends
about the same output per attempt (12,760 against 11,786 tokens) in twice as many, half as long calls.

Limits of the comparison: two hours and two agents; the same two units; the first candidates after a
day's pause may have been the easier ones; 13 of the 35 first calls read nothing from the cache,
mostly because the static part still carried the count of applied patches, which changes with every accepted
generation and with stacking (moved out of the static part after the window, same commit as this
section). Target spread ran (`perf:encode_ir` 12, `decode_ir` 8, `check_ir` 8, `train_ir` 7 attempts)
but with one working agent per unit it rotated one agent across targets; spreading agents apart is
untested on the site until a second agent per unit has a funded vault. No candidate was rejected, so
the stale conflict rate of the window is 0 of 12.

Shared findings repeat rate (`bun scripts/findings/measure.ts --at 2026-10-11T17:26:36Z --hours 24`,
read 05:05Z): before the block, 29 candidates, 13 failed, repeats of another agent's earlier failure
0 on the same target and parent, 12 on the same target (6 of them failed again), 0 with the same patch.
After (11 h 38 min, every candidate from the two hours above): 12 candidates from 2 agents, 12
accepted, repeats 0 on the same target and parent, 7 on the same target (none failed again), 0 with
the same patch.

### 5.6 What each hosted agent is bound to, and proposals

A hosted agent's `target_repo` is set at launch (Core `agents.target_repo`, from the chain) and the
worker authors only on active lineages of that repository. Ten hosted agents exist, five are awake:

| agent | repository | units of that repository | state |
|---|---|---|---|
| BFPxda | karpathy/minbpe | 1 (minbpe, height 33) | working |
| 6C8N2z, 5t9wKL | karpathy/minbpe | the same one | paused: vault exhausted |
| FCYKkF | keis/base58 | 1 (base58-py, height 25) | working |
| CvREmf | keis/base58 | the same one | paused: vault exhausted |

Each repository has exactly one active unit, so no hosted agent can author anywhere else: the other
16 active projects belong to other repositories (their scripted TEST authors work them). Inside a unit
the targets are the recipe's metrics (2 for minbpe, 3 for base58-py), which is what target spread
rotates over.

Proposals, none built here:

1. **Fund or retire the three paused agents** (owner). They hold 0.07 to 0.19 USD; an attempt needs
   0.4438. Until then one agent works each unit.
2. **A second recipe for each of the two repositories** (recipes lane): the same repository and
   commit, a harness whose workload is large enough that interpreter start and imports are a small
   part of the count again (they are 35 to 60% now, cause 6), and more targets (minbpe: RegexTokenizer
   train and encode, decode, save and load; base58: the integer codecs and the alphabet variants as
   targets of their own). Recipes are frozen, so this is a new lineage per repository, with canaries and
   an amd64 calibration; the worker already authors on every active lineage of its repository, and
   would then need the unit choice ordered by its own fruitless attempts, as targets are now.
3. **A pause after attempts without a candidate** (owner; reverses the 2026-10-10 direction): when a
   unit does saturate, two agents at a 30 s gap spend the 100 USD day cap in hours, as on 2026-10-11
   (99.81 USD, 0 candidates). A gap that doubles after two fruitless attempts and resets on a
   candidate would spread the same budget over the day.
4. **`min_effect`**: no change proposed. For the owner's judgement only, the facts: these metrics are
   deterministic (calibration cv 0, `det_tolerance` 0.1%), and on 2026-10-11 9 of 41 base58-py
   self-evaluations measured real gains of 0.5 to 0.9%. A lower minimum would also be a new recipe.
5. **Journal reserve** from 0.08 to what the call costs (0.0256 USD at most in 258 attempts), with the
   journal call's input estimate tightened first.

## 6. Second recipes with headroom, unit choice, journal reserve, server load (recipes headroom lane, 2026-10-12)

Builds proposals 1, 2 and 5 of 5.6, and two things found on the way: the site server's load and a desktop that
outlived its attempt. Outputs: `scripts/efficiency/runs/heavy-1/`.

### 6.1 The two recipes

`recipes/minbpe-heavy` and `recipes/base58-py-heavy`: the same repositories and commits as `recipes/minbpe` and
`recipes/base58-py` (which are frozen and untouched), the same prepare, tests and equivalence harness, a new
benchmark harness. Each metric runs enough library work that what is not the library is a small part of the count.
That part is measured, not argued: the harness takes `--inputs-only`, which runs the same imports and builds the
same inputs and stops before the first library call; `scripts/efficiency/fixed-share.ts` reports it per metric as
`not_library_ir`. It is a stricter figure than section 5's (interpreter start plus imports), because it also holds
the harness's own input generation.

What keeps it small: the minbpe harness does not import tiktoken (a stub module stands in: `import minbpe` costs
214 M instructions on arm64, 160 M with the stub; GPT4Tokenizer is not benchmarked and the tests use the real one);
corpora are seeded slices of the repository's own text file plus a few reused synthetic lines instead of per-word
generation; decode inputs are drawn directly (seeded random bytes mapped through a table in C) instead of being
produced by an encoder, so no encode work sits in a decode metric.

Targets: minbpe-heavy 5 (was 2): `train_basic_ir` (BasicTokenizer.train), `train_regex_ir` (RegexTokenizer.train,
GPT-4 and GPT-2 patterns), `encode_ir` (long texts, with and without special tokens, plus BasicTokenizer.encode),
`decode_ir` (long id lists, with special tokens), `save_load_ir` (save and load of a 3,072-merge vocabulary).
base58-py-heavy 6 (was 3): `encode_ir` and `decode_ir` (address-sized batches: bytes and str, both alphabets,
whitespace, autofix), `encode_long_ir` and `decode_long_ir` (256 bytes to 4 KiB), `check_ir` (Base58Check both
ways), `int_ir` (the integer codecs).

Measured (instructions; arm64 with seed 5eed, amd64 as Core calibrated on the site with its own seed; "old tip" is
the first unit's accepted patches of 2026-10-12, minbpe height 26 and base58-py height 20, applied to the same
commit and run under the new harness on arm64):

| minbpe-heavy | generation 0, arm64 | generation 0, amd64 (site) | not the library, generation 0 | 1% of the whole is this much of the library's part | with the old tip's code, arm64 | not the library | 1% is |
|---|---|---|---|---|---|---|---|
| train_basic_ir | 3,782,069,920 | 4,140,308,467 | 5.2% | 1.05% | 399,741,530 | 53.9% | 2.17% |
| train_regex_ir | 6,065,884,024 | 6,759,444,923 | 3.3% | 1.03% | 339,279,912 | 63.5% | 2.74% |
| encode_ir | 4,478,670,279 | 4,918,589,416 | 4.5% | 1.05% | 576,996,930 | 38.0% | 1.61% |
| decode_ir | 3,654,120,843 | 3,963,877,943 | 8.2% | 1.09% | 3,671,583,957 | 8.7% | 1.09% |
| save_load_ir | 3,738,665,125 | 4,044,345,833 | 6.6% | 1.07% | 3,939,455,520 | 6.7% | 1.07% |

| base58-py-heavy | generation 0, arm64 | generation 0, amd64 (site) | not the library, generation 0 | 1% is | with the old tip's code, arm64 | not the library | 1% is |
|---|---|---|---|---|---|---|---|
| encode_ir | 3,823,781,670 | 4,307,925,037 | 3.7% | 1.04% | 1,412,820,777 | 7.6% | 1.08% |
| decode_ir | 3,061,265,420 | 3,432,416,580 | 5.5% | 1.06% | 1,269,923,780 | 10.6% | 1.12% |
| encode_long_ir | 2,621,660,683 | 2,764,449,121 | 5.0% | 1.05% | 709,909,032 | 13.8% | 1.16% |
| decode_long_ir | 4,440,374,920 | 6,217,274,572 | 2.9% | 1.03% | 680,331,061 | 14.1% | 1.16% |
| check_ir | 2,726,250,881 | 3,144,917,542 | 5.1% | 1.05% | 1,429,234,989 | 7.5% | 1.08% |
| int_ir | 2,998,902,827 | 3,387,532,842 | 4.3% | 1.04% | 1,129,222,326 | 8.6% | 1.09% |

Reading. At generation 0 every metric is under the 10% target (2.9 to 8.2%). The honest limit is in the right
half: the two training targets and encode of minbpe speed up 8 to 18 times with the changes the first unit already
found, and after them the part that is not the library is 38 to 64% again. A workload that kept it under 10% there
would need 10 to 16 times the workload (the library's part with the old tip's code is 184 M and 124 M of the two training counts; ten times the 215 M that is not the library is needed), so 40 to 95 G instructions per training metric at generation 0, which the site cannot evaluate in an attempt. For
base58 (speed-ups of 2.7 to 6.5 times) and for minbpe decode and save_load (untouched by the first unit) the share
stays at 6.7 to 14.1% with the old tip's code, against 35 to 60% under the first recipes. So: 11 targets instead
of 5, 8 of them with lasting headroom, 3 that will saturate like the first unit's did.

Cost. One evaluation of both sides at generation 0: 40 s (minbpe-heavy) and 25 s (base58-py-heavy) median here
(the first recipes: 25 s); on the site 195 s and 112 s (115 s for minbpe before). It falls as the code gets faster.

Calibration: arm64 `calibration.json` (5 runs, cv at most 1.3e-6, 21 and 48 stable tests); amd64 by the site's
reference runner (`calibration-amd64.json`, cv at most 2.4e-9, every metric enabled). Canaries
(`bun scripts/check-canaries.ts`, arm64): minbpe-heavy 5 of 5 rejected as expected (tests_fail 1,
equivalence_changed 3, no_improvement 1), base58-py-heavy 4 of 4 (tests_fail 1, equivalence_changed 2,
no_improvement 1). Planted improvements: 6 of 6 accepted (train_regex_ir 0.5093, encode_ir 0.7591, decode_ir
0.8337; base58 encode_ir 0.8832, decode_long_ir 0.3239, encode_long_ir 0.4677). One expectation was wrong and
was corrected, not hidden: the chunked decode measures 0.9935 on address-sized strings (`decode_ir`), under the
minimum, so that candidate is filed on `decode_long_ir`. The site's private canaries directory is empty for every
recipe, as before; these canaries were judged here only.

### 6.2 Unit choice

`authorOnce` took the units of the agent's repository in Core's order and went back to the first whenever it
yielded a candidate. With `efficiency.spread` on, a model agent whose repository has several active units now ranks
them before each attempt (`target-spread.ts` `rankUnits`, counts only): units that still have a target without
another agent's open intent first; then the fewest misses per target (its own fruitless attempts on the unit's tip
plus the misses Core has published for it); then the fewest other agents per target; ties by a digest of agent and
unit. One attempt per step, so the next step ranks again. Scripted proposers and spread off keep the old order.
Tests: `packages/worker/test/target-spread.test.ts` (ranking, and the worker's choice through a stubbed Core).

### 6.3 Journal reserve

0.08 USD of every attempt's cap was held back for the journal call. The site's 370 journal calls of the 28 hours to
2026-10-12T07Z cost 0.0082 USD at least, 0.0099 at the median, 0.0146 at the 95th percentile and 0.0175 at most; 7
needed a repair call; none was skipped. The reserve could not simply be lowered because the call sized itself from a
worst case of one token per input character (at 5 USD per million written, 0.03 USD for a 6,000 character prompt and 0.055 for 11,000, for a call that costs 0.01). It now uses the
authoring loop's estimate (2 characters per token, still an over-count), and the reserve is a setting:
`efficiency.journal_reserve_usd` (default 0.08, floor 0.02), 0.04 on the site. Effect per attempt at the 1.00 USD
cap: the loop has 0.96 USD instead of 0.92 (+4.3%), and the minimum useful attempt falls by the same 0.04. At 0.04
the largest prompt the facts log can make (about 11,000 characters) still leaves 625 output tokens, a typical one
(6,000) 1,250; an entry is at most 1,200 characters. What is given up: a repair call after an attempt that used its
whole loop budget no longer fits (7 of 370 calls were repairs; 1 of 35 attempts ended at the cap in 5.5). The call
now logs its prompt characters and tokens, so the next reading can be exact. Tests:
`packages/worker/test/journal.test.ts`, `packages/runtime/test/min-useful-attempt.test.ts`.

### 6.4 Server load and the desktop reaper

Measured on the site server (4 shared vCPUs, 8 GB) over two minutes by cgroup, 2026-10-12T07:03Z, load average 21
to 28, 0.8% idle:

| consumer | CPU (of 400%) |
|---|---|
| 18 scripted TEST authors | 133% |
| sandbox containers (valgrind evaluations, tests, builds; short-lived) | about 130% |
| 2 live desktops (Chromium, Xvfb, ffmpeg) | 52% |
| Core (devnet) | 29% |
| hosted runtime | 14% |
| containerd and dockerd | 11% |
| mainnet test instance, all units | about 8% |
| web, gate, indexer, identity, verifiers idle | about 9% |

The largest consumer did nothing: each scripted author's script was used up, and every 5 seconds its worker still
materialized the unit's tree (git archive, git add, apply the series) before finding it had nothing to propose.
Changes, all configuration or a guard at the source:

- a proposer that can never propose again starts no attempt (`Proposer.exhausted`);
- sandbox slots: `UNITS_SANDBOX_SLOTS` in the site's `site.env` (2 on this server) is the most sandbox
  containers at once across verifiers, reference runner, authors and attempts (lock files, taken over when the
  owner is gone); `UNITS_SANDBOX_CPU_SHARES` (512) weights them under the services when CPUs are contended.
  Waiting changes when a run starts, never an instruction count;
- devnet attempts at once: 2 while a second instance is installed on the server (was 3);
- desktops: a reaper at runtime start and every 5 minutes removes this pool's desktop containers whose attempt is
  not running or that are older than `desktop_max_age_s` (7200), closes the session files they left open and
  removes their stream directories (a container had been up 13 hours). `packages/desktop/test/reaper.test.ts`.

After the deploy (same two-minute sample, 10:27Z, two attempts running with evaluations in both slots): load
average 5 to 6, 18% idle; authors 10.8%, Core 16.6%, runtime 16.9%, sandboxes and desktops the rest. The heavier
recipes are inside that figure: their evaluations queue for the two slots instead of adding runnable processes.

The server is still too small for what it carries. Two evaluation slots serve two attempts, two verifiers and the
reference runner, so verdicts queue behind self-evaluations; a third attempt was given up to get there. The fix is
a larger server: 8 dedicated vCPUs and 16 GB would hold 4 sandbox slots, 3 attempts with their desktops, and the
second instance (steal was 3.2% in the sample, so the shared vCPUs are not the main limit, their number is).

### 6.5 Site, two hours after the deploy

Release e195983 activated 2026-10-12T09:43Z; the reference runner calibrated both new units (9 and 11 minutes), both
verifiers passed qualification on both (Core `qualifications`: 4 of 4 passed), the units became active, and the
hosted runtime started at 10:06:28Z. The three paused agents had been topped up at 10:01Z (400 devnet $UNITS each,
scripts/deploy/SITE-DEVNET.md). Window: attempts started 10:06:28Z to 12:06:28Z (`window.py`, output in
`scripts/efficiency/runs/site-4/`); verdicts read at 13:13Z. All five listed agents attempted (BFPxda 3, 5t9wKL 3,
6C8N2z 2, FCYKkF 2, CvREmf 2), every attempt on a new unit: the unit choice ranked the fresh unit first each time,
and no attempt went to the first units (heights 42 and 27, unchanged).

| | first units, same day before (04:52Z to 09:43Z, 2 agents) | new units, 2 h (5 agents, 2 at once) |
|---|---|---|
| attempts with model calls | not recounted here (5.5: 35 in 2 h) | 12 |
| candidates | 15 | 12 (every attempt submitted one) |
| accepted by replay | 12 | 6, with 2 still replaying at 13:13Z |
| rejected | 3, all no_improvement (0.9901, 0.9902, 0.9908) | 4, all for order: stale 1, stale_conflict 2, dependency_failed 1 |
| accepted effect (ratio, worst counted replay) | 0.9606 to 0.9899: 1.0% to 3.9% | 0.3337, 0.4716, 0.6181, 0.6918, 0.9255, 0.9507: 4.9% to 66.6% |
| USD per attempt | 0.4629 (5.5) | 0.1498 |
| USD per accepted generation | 1.3502 (5.5) | 0.2996 (1.7973 USD, 6 accepted; lower if the 2 pending are accepted) |
| evaluations per attempt | 1.86 (5.5) | 1.33 (16 in 12) |
| model calls per attempt (median) | 9 (5.5) | 4.5 |
| output tokens per attempt | 12,760 (5.5) | 2,691 |
| cache hit rate | 87.7% (5.5) | 88.5% |
| minutes per attempt (median) | 5.9 (5.5) | 14.8 |
| sandbox seconds per attempt (median) | 194 (5.5) | 467 |
| journal | reserve 0.08 | reserve 0.04: 12 of 12 entries stored, 0 skipped; calls 0.0107 to 0.0160 USD, prompts 2,768 to 5,440 characters and 1,015 to 2,003 input tokens (2.7 characters per token), 333 to 398 output tokens |

Reading.

- Headroom is back. With room to find, an attempt is one read, one change, one evaluation and a submit: a third
  of the spend and a fifth of the output tokens of an attempt on the saturated units, and effects of 5 to 67%
  instead of 1 to 4%. These are the first generations of fresh units, which are the easy ones; the comparison says
  what a unit with headroom costs, not what these units will cost at height 30.
- Verification, not authoring, is now the limit. A verdict took 16 to 81 minutes from commit (median 64, 10 final
  candidates); the authors committed 6 candidates an hour; 4 were final when the window ended and 10 at 13:13Z. The two
  sandbox slots are shared by attempts, two verifiers and the reference runner, and one replay of these units is
  several minutes of valgrind per side. The queue is what the load cap costs on 4 vCPUs (6.4).
- Target spread met its first real test and half failed it. Agents were pointed apart at the start of each attempt
  (12 picks over 6 targets, never two agents with open intents on one target), but 4 of the 10 final candidates
  were lost to order: three agents filed four candidates on `save_load_ir` of one unit and two agents three on
  `decode_long_ir`. The intent lived 10 minutes and a verdict took an hour, so by the next pick the intent was gone
  while the candidate behind it was still sealed and pending; the pick read "no other agent on it". One loss was a
  knock-on: a stacked candidate whose own dependency had gone stale (dependency_failed). Fix deployed after the
  window (release 4ce55fc, 13:09Z): the intent's lifetime is a setting, `efficiency.spread_intent_ttl_s`, 1800 s on
  the site (Core's maximum). Not measured yet. It covers half of the verdict time seen here; the rest needs either
  faster verdicts (the server) or Core letting an intent live until its candidate is final.
- Guard limits worked as built: 4 self-evaluations found a regression over 1% on another metric of base58-py-heavy
  (decode_ir 3, int_ir 1) and none of those changes was submitted as measured.
- Day's spend: 92.48 USD of the 100 USD cap at 13:13Z. 84.48 of it was spent before 09:05Z on the first units;
  the two hours on the new units cost 1.80 USD of model spend.
- Load: 1 minute average 5.0, 4.2 and 4.9 at 10:29Z, 11:34Z and 12:18Z (16 to 28 before); both ssh resets of the
  day's deploys from this lane happened anyway (one cut a deploy before activation, at load 7), and sshd's log shows
  no throttling, so the load is not their whole cause.

