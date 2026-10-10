# Projects, Generations and Analytics pages

Owner request 2026-10-10. Three new pages in the app (units; code identifiers still say lineage until
the rebrand lane renames them): Projects (`/projects`, `/projects/:repo`), the Generations explorer
(`/generations`) and Analytics (`/analytics`). Every figure comes from Core, the market indexer, the
hosted runtime's spend report (through Core) or the learnings export; nothing is modelled or filled in.
A figure no source holds shows as an empty state or "TBA".

## 1. Sources and the sealing rule

Core serves four read-only aggregate routes (`packages/core/src/analytics.ts`). They read only records
that are public one by one already:

| Record | Public because | Used for |
|---|---|---|
| accepted generations (`generations`, entry_type patch) | final by definition | timelines, explorer, per-day counts, last improvement |
| counted replays of accepted generations (`replays.result`) | revealed with the verdict | metric values per generation |
| calibration (`calibrations.json` metrics base_value) | served by `GET /v1/lineages/:id` | metric baselines |
| provenance of accepted candidates | final candidates only (`GET /v1/candidates/:id/provenance`) | model and provider per generation |
| published learnings episodes | published only once nothing in them can name the author of an open candidate (SPEC 17.8) | every attempt, cost, model and duration figure |
| replays of final candidates (accepted, rejected, expired) | revealed with the verdict | verifier agreement, replay throughput |
| live sessions (`GET /v1/sessions?state=live`) | a live session's agent is public by design (SPEC 17.3) | agents working now, desktops in use |
| open candidate count per lineage | `GET /v1/lineages/:id` candidate_counts already serves it | "open candidates" (a count, nothing else) |
| runtime spend report (`runtime_spend`, `runtime_spend_global`) | `GET /v1/agents/:id/spend` already serves it | runway, waiting reasons, provider balance, platform cap, desktops |
| epochs and `chain_epochs` | `GET /v1/epochs`, `GET /v1/chain` | epochs closed and posted |

About an open candidate nothing is served but that count. Tested in `packages/core/test/analytics.test.ts`:
every analytics route returns the same body before and after a candidate is committed, except the
lineage's open count, and the generic route sweep (`authorLeaks`) finds no route naming its author.

Hidden launches (test agents, `GET /v1/hidden`) are left out of agent rows, model rows, spend and the
explorer unless the query has `hidden=1`. A project's metric values and generation timeline are the
lineage's state, whoever wrote them: a test launch's generation stays in the timeline with its author
withheld (`author_hidden: true`) unless `hidden=1`.

## 2. Core routes

All `GET`, no auth, cached 10 s per query.

- `GET /v1/analytics/projects?hidden=1&all=1`: repositories with an active lineage on GitHub (`all=1`
  adds retired lineages and local fixtures). Per project: `key` (owner/name, else the repo id), repo,
  classes, lineages (recipe, status, height, open candidates, accepted, metrics), accepted (unreverted),
  accepted by test launches, reverted, authors (listed), last improvement, open candidates, live agents
  (from live sessions: agent, session, desktop), live sessions.
  Per metric: direction, `baseline` (calibration base_value, null when the calibration disabled it),
  `best` and `latest` (value, height, generation), `improvement_pct` (baseline to best, oriented so
  positive is better), `latest_change_pct`, `measured_generations`.
- `GET /v1/analytics/project?repo=<owner/name | repo id | url>&hidden=1`: the project row plus per
  lineage: `metrics[].points` (height, generation, value = median over the counted replays of each
  replay's candidate median, parent = the same for the parent side, replays, accepted_at, targeted),
  `timeline` (every accepted generation newest first: kind, metric, effect, gain, author or withheld,
  model, provider, reverted, audit, GitHub field), `sessions` (the lineage's last 30 sessions exactly as
  `GET /v1/sessions` summarises them; sealed sessions keep their agent withheld).
- `GET /v1/analytics/generations?repo=&lineage=&agent=&metric=&class=&kind=&model=&provider=&from=&to=&sort=time|effect&dir=desc|asc&page=&limit=&hidden=1`:
  accepted generations across projects, paged (limit up to 200), with facets (projects, agents, metrics,
  classes, kinds, models, providers) and the GitHub field per row (`gen-github.ts` view: commit URL,
  verified, reason). `from`/`to` are UTC days (YYYY-MM-DD) or unix ms. Effect sort: percent gain, fixes
  after equal gains by test count. `metric=fix` selects fixes.
- `GET /v1/analytics/overview?window=24h|7d|all&hidden=1`:
  - `network`: Core start time and release (the deploy kit runs Core from
    `/opt/lineage/releases/<sha>`: the release directories are the deploy history, newest 30 by mtime),
    machines (`GET /v1/live` totals), live sessions and how many have a desktop, epochs (current, closed,
    posted on chain, unposted with error, the chain view), the runtime's last report (price status,
    OpenRouter balance, platform cap, desktop slots), waiting agents with the runtime's reason and a
    category (vault, provider balance, desktop slot, platform cap, other), chain deployments.
  - `costs` over the window (attempt start time): totals, by agent, by provider; attempts that ended
    with nothing (no candidate, rejected, expired, abandoned) by outcome and reason (verdict reason, or
    the worker's outcome line up to its first colon), runway per bound agent, per-day attempts, accepted
    and USD (all time, last 90 days). USD per accepted and USD per point of gain use priced attempts only,
    so an attempt without a cost record never lowers a cost.
  - `models.rows` per (provider, model): attempts, priced, USD, accepted, rate (null under
    `MIN_ATTEMPTS_FOR_RATE` = 5 attempts), mean gain (null under `MIN_ACCEPTED_FOR_MEANS` = 3 accepted
    with a ratio), gain per USD (same threshold), USD per accepted, median attempt duration (session start
    to end). Attempts without an attested or reported model are their own row, "not reported (<harness>
    harness)"; scripted authors are "scripted".
  - `activity`: accepted generations per UTC day (last 90 days, with how many by test launches) and per
    hour (last 48 h).
  - `verification`: final candidates by status, replays of final candidates by role, agreement =
    counted / (counted + minority), audits by status, revealed replays per day.

The hosted runtime's spend report gains two optional blocks (`packages/runtime/src/runtime.ts`
spendReport): `cap` (Runtime.capStatus plus scope: max, window, spent, left, lifetime, past windows) and
`desktops` (counts by backend: local, desktop hosts, E2B with its UTC-day spend and cap; no host names).
`runtime-spend.ts` keeps numbers only and serves them through the overview.

Market totals come from the indexer as the app already reads it (`GET /market/tokens`, hidden mints
left out by the indexer): tokens, 24 h volume, trades, holders. No fee figure anywhere on these pages.

## 3. Pages (apps/web/src/pages)

Each page is one self-contained module built from the app's existing pieces (`panel`, `stat`, `.t`
tables, `.seg` chips, `.lb-sel` selects, `empty`), plus `insights-ui.ts`: a small shared module with
its own `ins-` classes on the app's tokens and plain SVG charts (line per generation height, bars per
day). The token chart's lightweight-charts is time-based; heights are not times, so SVG is used.

- `projects.ts` `/projects`: header with counts; one card per project: repo link (GitHub), classes,
  live badge with the agents working now, per lineage the metrics as baseline, best and measured
  improvement, accepted generations, open candidates (count), last improvement. Toggle "include retired
  and fixtures" (`?all=1`).
- `project.ts` `/projects/:owner/:name` (or `/projects/<repo id>`): header and GitHub link; per lineage
  a metric chart over generations (real values only, one line per metric with the baseline as a dashed
  rule), metric table, generation timeline (links to the generation page and its GitHub commit with the
  Verified state), live sessions (link to the live page), recent sessions as facts only (no replays:
  live only), open candidates as a count.
- `generations.ts` `/generations`: filters (project, agent, metric, class, model, provider, from, to),
  sort chips (newest, largest effect), table rows: generation, project and height, effect, agent, model,
  GitHub commit with "Verified on GitHub", "How to verify" (the generation page's GitHub panel, and the
  docs page); 50 per page; `?hidden=1` shows test launches.
- `analytics.ts` `/analytics`: window chips (24 h, 7 d, all). Sections: Network status (services,
  machines, live sessions and desktops, waiting agents and why, platform cap, epochs, releases), Cost
  transparency (totals, spend by agent with runway, by provider, per day, attempts ending with nothing),
  Model leaderboard (thresholds stated on the table), Activity (generations per day or hour), Verification
  (agreement, replays per day), Token market (indexer totals). Empty states where a source has nothing.

Navigation: the Eco page's link list gains Projects, Generations and Analytics (minimal; Chaitanya may
move them). Routes light the Eco header item.

## 4. Checks

- Core: `bun test packages/core/test/analytics.test.ts` (figures equal records, hidden rule, author-blind).
- UI: `tests/ui/projects-generations-analytics.spec.ts` (Playwright, headless Chromium, 1280 and 390,
  light and dark color scheme; the app has one theme, so dark checks that nothing breaks): figures equal
  the Core routes, no hidden agent without `?hidden=1`, no horizontal scroll, no em dash, no fee wording.
  Local server on UI_PORT 9663 (9662 is the owner's review server).
