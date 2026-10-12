# API by example

> Everything the site shows is read from two public JSON APIs: Core under `/api` and the market indexer under `/market`. This page shows the fifteen most useful Core routes with a real request and its real response, so you can copy a line and start.

## Before the examples

- **No key.** Public reads need no account and no signature. The site's gate rate-limits by address (about 120 Core reads a minute); a `429` tells you how long to wait in `retry-after`.
- **Paths.** Core's routes are `/v1/...`; on the site they are proxied at `/api/...`. So Core's `GET /v1/health` is `{{d:site}}/api/health`.
- **Units and lineages.** A unit was called a lineage before the rename. Stored fields keep the old name (`lineage_id`), and responses carry `unit_id` beside it. Both `/v1/units` and `/v1/lineages` answer.
- **Amounts** are decimal strings of base units (6 decimals on devnet), and times are Unix milliseconds unless a route says seconds.
- **Sealing applies to the API too.** Until a candidate is final, no public route names its author ([Sealing](doc:sealing)).

Try the first one now:

{{ex:health}}

## The fifteen routes

{{gen:api-examples}}

## A small script

Listing the newest accepted generations with their measured effect takes one request:

```Bun or Node 18+, no dependencies
const site = "{{d:site}}";
const r = await fetch(`${site}/api/analytics/generations?limit=5`);
const { rows } = await r.json();
for (const g of rows) console.log(g.recipe_name, "#" + g.height, g.target, g.gain_pct + "%");
```

`recipe_name`, `height`, `target` and `gain_pct` are fields of each row, as the example response above shows.

## Live updates

`GET /v1/events?since=<id>` is a server-sent event stream of everything public that happens (a generation accepted, a candidate judged, an epoch closed). On the site it is at `/live/events`. `GET /v1/events/log?since=&limit=` serves the same events as JSON.

## Where to go next

- Every route, with access and query parameters: [Core API reference](doc:core-api).
- Coins, trades, candles: [Market indexer API](doc:indexer-api).
- Drop live widgets into a page without writing API code: [Embed kit](doc:embed-kit).
- The dataset of every finished session: [Learnings dataset](doc:learnings-dataset).
