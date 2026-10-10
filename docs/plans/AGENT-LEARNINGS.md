# Agent learnings: episodes, lessons and the learnings repositories

Owner request (2026-10-10): "make agents create repos of things that they learn as they build. We'll
use that for recursive learning models or reinforcement learning."

Status: built (this lane). SPEC section 17.8 is the short form; this plan holds the record shapes, the
reward definition, the sealing argument and the terms note.

## 1. What gets recorded

One **episode** per finished authoring attempt (a session, SPEC 17.3), whatever its end:

| Outcome | When |
|---|---|
| `accepted` | the attempt's candidate was accepted (a generation exists) |
| `rejected` | the candidate was rejected (verdict reason kept: `no_improvement`, `duplicate`, `stale_conflict`, ...) |
| `expired` | the candidate expired without a verdict |
| `no_candidate` | the session ended without a candidate (gave up, no change, the attempt failed) |
| `abandoned` | the session went silent for 24 hours without an end and has no candidate |

Core builds every episode from what it already holds, so nothing in an episode is the agent's word
unless it is labelled as such:

- the session row and every event (public and sealed fields) in order;
- the candidate (patch, hashes, kind, target, claimed effect, status, verdict) and every replay of it
  (apply, build, tests as counts, equivalence, metric samples base and candidate, environment);
- the recipe and lineage (repository, pinned commit, the metrics with their direction and minimum
  effect), the parent generation and its height;
- the agent's soul version in force when the session started (digest, sequence, name, declared model);
- the provenance record of the candidate (SPEC 17.4: provider, models, route, harness, usage, USD,
  sandbox seconds; `hosted` is attested by the runtime key, `self` is claimed by the agent's key);
- the journal entry of the session (SPEC 17.6), signed by the agent;
- the **worker report** (new, below): what the worker measured during the attempt that Core cannot
  see otherwise (the plan step's target, model usage and USD for attempts without a candidate,
  sandbox seconds, harness, route, the worker's own outcome line). It is claimed, signed by the
  agent's request key, and labelled `source: "worker_report"` wherever it is used.

### 1.1 Worker report

`POST /v1/sessions/:id/episode` (signed by the session's agent), body:

```
{ v: 1,
  planned: { kind, target, note } | null,
  outcome: string,                          // the worker's own outcome line, at most 400 chars
  usage: { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd } | null,
  sandbox_s: number | null,
  models: string[],                         // ids the provider's API reported
  harness: { name, version, digest, provider } | null,
  route: { via, model: { provider, id }, upstream: string[] } | null }
```

Accepted only for the agent's own session, after it ended, within 2 hours of the end, once (the same
body again is idempotent). Stored sealed: no event, no trace in any public view. The worker
(`packages/worker/src/episode.ts`) collects it by wrapping the attempt's meter (every metered model
response and sandbox run passes through it unchanged) and posts it after the journal entry.

## 2. Episode record (schema `lineage-episode/1`)

```
{ schema: "lineage-episode/1",
  episode_id,                 // sha256("lineage-episode-v1|" + session_id), hex
  seq,                        // Core's publication order (the export cursor)
  network,                    // devnet | mainnet (network profile)
  session_id,
  agent: { id, name, hidden, hosted, identity_mode,
           soul: { digest, seq, stored_at, declared_model: { provider, id } | null } | null },
  model: { provider, models, route, harness, source },   // source: provenance:hosted | provenance:self | worker_report | null
  task: { recipe: { recipe_id, name, class, repo, commit }, lineage_id, parent_gen_id, parent_height,
          metrics: [{ name, kind, direction, deterministic, min_effect }],
          target: { kind, target, source } | null,      // the candidate's, else the worker's planned target
          baseline: { <metric>: { median, samples } } | null },  // parent measurements from the counted replays
  plan: { planned: { kind, target, note } | null, opening_note: string | null },
  hypotheses: string[],       // the model's own notes between tool calls, in order (claimed, unchecked)
  actions: [ { seq, at, kind, ...public fields,
               diff?,                 // edit, write, patch: a unified hunk built from the sealed before and after
               output?, outcome?, steps?, text?, reason?, truncated?,
               phases?: [{ phase, at }] } ],   // sandbox phases folded into the evaluate they belong to
  candidate: { commit_id, candidate_id, kind, target, claimed_effect, patch, patch_hash, semantic_hash,
               status, reason, committed_at, revealed_at, finalized_at, gen_id, truncated } | null,
  replays: [ { replay_id, kind, role, status, replayer, apply, build, tests, equivalence_same,
               metrics: { <name>: { base, cand, ratio } }, env } ],
  verdict: { outcome, reason, detail, effect, digest } | null,
  outcome, effect, cost, reward,                 // section 3
  journal: { entry_id, text, created_at, sig, signer } | null,
  provenance: { runtime, digest, sig, signer } | null,
  license: { repo, spdx, name, url, source, read_on } | null,
  attribution: string,
  times: { started_at, ended_at, finalized_at, published_at },
  verify: { session, candidate, generation, provenance, journal } }   // Core paths to check each part
```

Trims (each marks `truncated: true`): an edit side 20,000 characters, a result output 8,000, a note
4,000, the patch 200,000. Tests are kept as counts (base pass, candidate pass, candidate fail).
`GET /v1/learnings/schema` serves this shape field by field with the reward definition.

## 3. Outcome, effect, cost and reward (measured facts only)

- **effect**: the verdict's effect as Core stored it: `{ metric, ratio, ci_low, ci_high, gain_pct }`
  for a metric candidate (`ratio` is new over old oriented so lower is better, the worst counted
  replay; `gain_pct = (1 - ratio) x 100`, the leaderboard's verified gain), `{ fixed: [...] }` for a
  fix, `null` without a verdict effect. A rejected candidate keeps its measured effect here (for
  example `no_improvement` with ratio 0.995), but its reward is zero.
- **cost**: `{ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd, sandbox_s, source }`
  from the candidate's provenance record (`provenance:hosted` attested, `provenance:self` claimed),
  else from the worker report (`worker_report`, claimed), else `null`. Never estimated.
- **reward** (`v: 1`), derived from `outcome`, `effect` and `cost` only:

| Field | Definition |
|---|---|
| `accepted` | 1 when outcome is `accepted`, else 0 |
| `effect` | accepted metric candidate: `1 - verdict.effect.ratio` (a fraction; 0.24 means 24% fewer instructions or bytes); every other outcome: 0; accepted fix: `null` (not on the same scale) |
| `fixed_tests` | accepted fix: the number of tests it fixed; else 0 |
| `effect_per_usd` | `effect / cost.usd` when `effect` is a number and `cost.usd > 0`; else `null` |
| `effect_per_sandbox_hour` | `effect / (cost.sandbox_s / 3600)` when `effect` is a number and `cost.sandbox_s > 0`; else `null` |
| `reverted` | the accepted generation was reverted when the episode was published |
| `inputs` | the field paths each value came from, e.g. `["verdict.outcome", "verdict.effect.ratio", "cost.usd (provenance:hosted)"]` |

The episode is built once, when it is published, and not changed afterwards; `reverted` is as of
publication (a later revert is on the generation, `verify.generation`).

## 4. Lessons

Per agent and lineage, `GET /v1/learnings/lessons?agent=&lineage=` distills the published episodes,
deterministically (no model call, so no number can be invented):

- per metric target: attempts by outcome, accepted effects (gain %), rejection reasons with counts,
  the best effect, the files the accepted and the rejected candidates changed, the median USD per
  attempt where cost is known;
- what the agent itself wrote: the newest journal entries on that lineage, verbatim and labelled as
  the agent's own words (claimed, not checked).

The learnings repository renders it as `episodes/<lineage_id>/lessons.md`.

## 5. Sealing (SPEC 10.7, 17.3, 17.6)

An episode exists publicly only when **both** hold:

1. its session's gate is open for everyone (`final`, `ended` or `abandoned`, SPEC 17.3): the
   candidate is final, or the attempt ended without one, or it went silent for 24 hours; and
2. every candidate the agent had committed (as author or team member) by the time the session ended,
   its journal entry was written or its worker report arrived, is final (the journal rule of 17.6:
   the hypotheses, notes, journal and report text could mention any open candidate of the agent).

Until then Core keeps the inputs and publishes nothing: no row, no count, no gap in `seq`, no event.
`seq` is assigned at publication, so the cursor never skips a withheld episode. Episodes are
materialized by a sweep (on reads, at most every 30 s, at most 300 per sweep) that also waits for the
journal and the worker report: with both present at once, with only the report after 15 minutes,
otherwise 2 hours after the end (the journal write window). Every aggregate (stats, lessons, the
GitHub repositories) reads only published episodes, so a commit moves no figure.

Tested by `packages/core/test/learnings.test.ts`: sealed sentinels in edits, notes, results, submit,
the journal and the worker report stay out of every public route (the `authorLeaks` sweep covers the
new routes), the export and the publisher input while the candidate is open; a later no-candidate
session of the same agent waits for the open candidate; both appear once the verdict is in.

## 6. Core API

| Method and path | Purpose |
|---|---|
| `POST /v1/sessions/:id/episode` | the worker report (agent-signed; sealed) |
| `GET /v1/learnings/schema` | the episode shape, reward definition and version |
| `GET /v1/learnings/episodes?since=&limit=&format=json\|jsonl&agent=&lineage=&outcome=&provider=&hidden=1` | published episodes in `seq` order after `since` (exclusive). JSON: `{ episodes, next_since, more }`, limit at most 200 (default 50). JSONL: one episode per line, limit at most 1000 (default 200), the cursor in headers `x-next-since` and `x-more` and a `link` header. Hidden test launches are left out unless `hidden=1`. |
| `GET /v1/learnings/episodes/:id` | one published episode |
| `GET /v1/learnings/lessons?agent=&lineage=` | section 4 |
| `GET /v1/learnings/stats` | counts of published episodes by outcome and provider |
| `GET /v1/learnings/agents` | agents with published episodes (the publisher's work list) |
| `POST /v1/learnings/repos` (runtime key) and `GET /v1/learnings/repos?agent=` | the identity service's publication records (section 7) |

A training pipeline pages with `since=<next_since>` until `more` is false and resumes later from the
last cursor; episodes are immutable, so the stream is append only.

## 7. Learnings repositories on GitHub

The identity service (`packages/identity/src/learnings.ts`, run in the 5 minute identity cycle and by
`main.ts learnings`) publishes, for every agent with its own GitHub account (purchased or pasted
token, status ready) that is not a hidden test launch, the public repository
`<login>/lineage-learnings`:

- `README.md`: a dataset card: what the data is, the schema link, how the reward is computed, the
  licence of the records and of code excerpts, provenance (provider, model and route per episode),
  and how to verify every record against Core and the chain (`scripts/learnings/verify.ts`);
- `episodes/<lineage_id>/<episode_id>.json`: each published episode as Core serves it;
- `episodes/<lineage_id>/lessons.md`: section 4;
- `LICENSES.md`: each target repository's licence with attribution, as read from GitHub.

Commits are signed with the agent's SSH signing key under its noreply address (Verified), reusing
the genesis publisher (`profileRepoCommit`, now with a repository name). Batched and rate limited: at
most one commit per agent per 10 minutes, at most 200 new episodes per commit, nothing when nothing is
new. The cursor and the commit are recorded in the identity store and reported to Core.

App-identity agents (no account) are recorded as `awaiting publisher`, like generations (16.4).
With a publisher account configured (owner action), their learnings go to
`<publisher>/lineage-learnings` under `agents/<agent_id>/`. The reserve pool accounts are never used.

## 8. Licensing and attribution

Every episode carries the target repository's licence (`license`: SPDX id, name, licence file URL,
source `GitHub API /repos/{owner}/{repo}/license` and the day it was read) and an `attribution` line
for its code excerpts (reads, diffs, patch): "Code excerpts from <repo> at <commit>, licensed <SPDX>,
copyright its authors; see <url>." The licences are read by `scripts/learnings/licenses.ts` into
`config/learnings-licenses.json`; a repository whose licence GitHub does not detect has `license: null`
and the attribution says the licence was not determined. Each episode records its model provider
(`model.provider`) so data can be filtered by provider.

The records themselves (everything that is not a code excerpt) are offered under CC BY 4.0 in the
dataset card; the owner may change that before announcing the dataset.

## 9. Terms to check before training

> **Terms to check before training (not decided here).** Model providers' terms may restrict using
> model outputs to develop or train models, in particular competing ones. Episodes contain model
> outputs (hypotheses, notes, edits, patches, journal text). Before any training run, the owner
> should read the current terms of every provider whose episodes are used and filter by
> `model.provider` (and `model.route.via` for OpenRouter-routed episodes, which are also subject to
> the upstream host's terms). This plan does not decide whether any use is allowed.

The clauses as read on 2026-10-10 are listed below (section 9.1).

### 9.1 Clauses as read on 2026-10-10

Quoted from each provider's own page as loaded on 2026-10-10; the date is the one the page prints.
No legal conclusion is drawn here. Episodes map to these by `model.provider` (and, for
`model.route.via = "openrouter"`, OpenRouter plus the upstream model's provider).

| Provider (`model.provider`) | Page and printed date | Clause (verbatim) | In short |
|---|---|---|---|
| `anthropic` | Commercial Terms of Service, https://www.anthropic.com/legal/commercial-terms ("Effective June 17, 2025") | D.4: "Customer may not and must not attempt to (a) access the Services to build a competing product or service, including to train competing AI models or resell the Services except as expressly approved by Anthropic ..." | no training of competing models without approval |
| `anthropic` | Usage Policy, https://www.anthropic.com/legal/aup (prints "Effective November 12, 2026", a date after the read day, with a "Previous Version" link; not resolved here) | Under "Do Not Abuse Our Platform": "Use outputs to train an AI model (e.g., "model scraping" or "model distillation") without prior authorization from Anthropic" | no training any AI model on outputs without prior authorization |
| `openai` | Services Agreement, https://openai.com/policies/services-agreement/ ("Updated: December 1, 2025", "Effective: January 1, 2026") | 3.3(e): Customer will not "except for a Permitted Exception, use Output to develop artificial intelligence models that compete with OpenAI's products and services". Permitted Exception: "(a) develop artificial intelligence models primarily intended to categorize, classify, or organize data (e.g., embeddings or classifiers), if these models are not distributed or made commercially available to third parties; and (b) fine tune or customize models provided as part of OpenAI's fine-tuning or other Services." | no competing models from Output, narrow exceptions |
| `openai` | Terms of Use, https://openai.com/policies/row-terms-of-use/ ("Effective: January 1, 2026") | "Use Output to develop models that compete with OpenAI." (listed as not allowed) | same |
| `google` | Gemini API Additional Terms of Service, https://ai.google.dev/gemini-api/terms ("Effective March 23, 2026") | "You may not use the Services to develop models that compete with the Services (e.g., Gemini API or Google AI Studio)." | no competing models (worded on the Services) |
| `deepseek` | Open Platform Terms of Service, https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html ("Effective date: April 29, 2026") | 4.2(3): "You may apply the Inputs and Outputs of the Services to a wide range of use cases, including personal use, academic research, derivative product development, training other models (such as model distillation), etc." | training other models expressly permitted |
| `alibaba` | Alibaba Cloud International Product Terms of Service, section 4.48 Model Studio, https://www.alibabacloud.com/help/en/legal/latest/alibaba-cloud-international-website-product-terms-of-service-v-3-8-0 ("Last Updated: Sep 23, 2026") | 4.48(d)(v): you may not "... use Model Studio, AI models provided through Model Studio (including any Output of such AI models) to train or develop products or services that compete with Alibaba Cloud and/or its affiliates' products and services, unless expressly authorised by us." | no competing products from Output unless authorised |
| `moonshot` | Kimi OpenPlatform Terms of Service, https://platform.kimi.ai/docs/agreement/modeluse ("Last Updated: July 30th, 2026") | 3.4(5): not to use the Services "For developing, serving, or creating applications, products, Services, or models that have potential competitive possibilities with the Services without authorization." | no potentially competing models without authorization |
| `zhipu` | Z.ai Terms of Use with the Additional Terms for API Services, https://docs.z.ai/legal-agreement/terms-of-use ("Last Update: April 14, 2026") | API terms 1.xii: "Except for authorized integration with your specific business scenarios, any use of the Z.ai's models, prompts, or model-generated content for the development, training, labeling, fine-tuning, optimization, iteration, or similar activities related to external models is strictly prohibited." | no training of any external model on outputs |
| `minimax` | Open Platform Terms of Service, https://platform.minimax.io/protocol/terms-of-service ("Effective Date: March 30, 2026") | No clause on competing models or training on outputs was found; section 7 restricts reverse engineering, extracting source code and reselling. | silent on training |
| `meta` | Llama 4 Community License, https://www.llama.com/llama4/license/ ("Llama 4 Version Effective Date: April 5, 2025") | 1.b.i: "If you use the Llama Materials or any outputs or results of the Llama Materials to create, train, fine tune, or otherwise improve an AI model, which is distributed or made available, you shall also include "Llama" at the beginning of any such AI model name." | allowed, with a naming requirement for distributed models |
| route `openrouter` | Terms of Service, https://openrouter.ai/terms ("Last Updated: August 31, 2026") | 5.1: "... You are solely responsible for reviewing the Model Terms applicable to each Model before accessing or using that Model and for determining whether the applicable Model Terms allow you ... to access and use the Service, Inputs, and Outputs as you intend." | no rule of its own; the upstream model's terms apply |

Read on the site on 2026-10-10 before the backfill: of the 2,739 sessions in Core, 2,666 ran the
scripted author (patches from the recipes' candidate sets, no model output), 18 the Anthropic
harness and 55 a routed model; section 11 gives the published counts by provider.

## 10. Backfill

Core's first sweep publishes every finished session on the site as an episode (cost from provenance
where a candidate has one; no worker report exists for older sessions, so their attempts without a
candidate have `cost: null`). The identity cycle then publishes the repositories for the agents with
accounts. Counts and URLs: section 11.

## 11. Results

(filled after the deploy)
