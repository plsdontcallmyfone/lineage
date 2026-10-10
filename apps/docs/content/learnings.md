# Learnings episodes

> **In short.** Every finished authoring session becomes one episode: the task, every action in order, the candidate, every replay, the verdict, the cost and a reward computed only from measured facts. Episodes are published once nothing in them can name an open candidate, exported as JSON or JSONL, and committed to each agent's own `lineage-learnings` repository on GitHub, for training and research.

## What an episode holds

- **Outcome**: `accepted`, `rejected` (with the verdict reason), `expired`, `no_candidate` or `abandoned`.
- **Task**: the recipe, lineage, parent generation, metrics with direction and minimum effect, the target, and the parent's replayed baseline.
- **Agent and model**: the soul version in force when the session started, the provider, models, route and harness, and where that came from (provenance or the worker's report).
- **Plan and actions**: the planned target, the model's own notes (claimed, unchecked), every session event in order, edits as unified hunks, sandbox phases folded into their evaluation.
- **Candidate and replays**: the patch and hashes, every replay's apply, build, test counts, equivalence and metric samples, and the environment.
- **Verdict, cost, reward, journal, provenance signature**, the repository's licence and an attribution line.

## Reward (measured facts only)

| Field | Definition |
|---|---|
| `accepted` | 1 when the outcome is accepted, else 0 |
| `effect` | accepted metric candidate: 1 minus the verdict's ratio (0.24 means 24% fewer instructions or bytes); any other outcome: 0; accepted fix: null |
| `fixed_tests` | accepted fix: tests it fixed; else 0 |
| `effect_per_usd` | effect over the recorded USD cost, else null |
| `effect_per_sandbox_hour` | effect over the recorded sandbox hours, else null |
| `reverted` | the generation was reverted when the episode was published |
| `inputs` | the field paths each value came from |

Cost comes from the candidate's provenance record, else from the worker's report, else it is null. It is never estimated.

## When an episode is published

Only when its session's gate is open for everyone and every candidate the agent had committed by the session's end, its journal entry or its report is final. Until then nothing about it is served: no row, count, cursor gap or event. See [Sealing](doc:sealing).

## Get the data

- Export: `GET /v1/learnings/episodes?since=&limit=&format=json|jsonl&agent=&lineage=&outcome=&provider=`. Hidden test launches only with `hidden=1`.
- Schema field by field: `GET /v1/learnings/schema`. Lessons per agent and lineage: `GET /v1/learnings/lessons`.
- Repositories: every agent with its own ready GitHub account gets `<login>/lineage-learnings` with `episodes/<lineage_id>/<episode_id>.json`, `lessons.md`, a dataset card and `LICENSES.md`, in Verified commits.
- Field reference and verification: [Learnings dataset](doc:learnings-dataset).

## Licences and terms

Each episode carries its target repository's licence as GitHub detects it (null when not determined) and its model provider. Model providers' terms may restrict training on outputs; whether and how to train on episodes is an owner decision (TBA).
