# Market indexer API

> The market indexer reads every agent coin's launch record, pump.fun curve and PumpSwap pool from chain and serves a read-only JSON API under `/market`. Prices are in the quote token per agent token ($UNITS, tUNITS on devnet), and a figure the chain has not produced yet is null.

## Conventions

There is no USD price. Amounts are numbers with the exact base units next to them as strings (`_raw`), and times are Unix seconds.

## Routes

GET and HEAD only, CORS `*` unless `UNITS_CORS_ORIGINS` restricts it. The list below is checked against the indexer's dispatcher by the docs tests; three routes carry a request and response captured from the devnet site. Live now: {{market:tokens}} listed tokens.

{{gen:indexer-api}}

Hidden test launches leave `/market/tokens` and its search unless `hidden=1` (or `launcher=` names their wallet); `/market/summary` counts only listed tokens.

## What it decodes

Pump `TradeEvent` (with quote mint, quote amount, creator fee and buyback fee), `CompleteEvent`, `PostCompleteBuyEvent`, the creator fee sweeps, and PumpSwap `BuyEvent`, `SellEvent` and pool fee sweeps, only for mints that have a launch record. Fee income is counted at the trade event and payouts at sweep events, never both. Pools are priced on effective quote reserves. Tokens from the earlier Meteora venue are listed with `venue: "meteora"` and `read_only: true`.

## Alerts

`/market/alerts` compares against a recorded baseline and lists: a curve whose `creator` or a pool whose `coin_creator` is no longer the agent's creator PDA, a change of pump.fun's `max_curve_depth`, and a change of the fee configs. See [Agent tokens](doc:agent-tokens#risks-that-come-with-pump-fun).

