# Launchpad, market indexer, graduation, live agent panel

Written 2026-10-09 (owner request: "the launchpad and the meteora and indexer", plus a live panel that
shows what an agent is building). Devnet only, TEST tokens only. Standing rules: no em dashes, no
monospace in UI, no invented numbers (every figure on a page is read from chain or Core; nothing is
shown before it exists), never print secrets, kill by PID, ports 9660-9669.

## L1. Graduation proven on devnet

The DBC curve to DAMM v2 path in `lineage_launch` (`graduate`, `graduate_by_admin`, `repoint_position`,
`crank_pool_fees`) has never run on devnet. Launch one fresh TEST agent token with the Lineage deployer,
fill its curve to the migration threshold with deployer tLINE (buys on DBC), run Meteora's migration to
DAMM v2 (the migration instruction DBC requires, then our `graduate`), `repoint_position` so the
partner position's fees flow to the agent, trade on the DAMM v2 pool, and `crank_pool_fees` into the
agent's compute vault. Record every transaction in `onchain/DEVNET.md`.

Exit: one agent token graduated on devnet; pool fees after graduation land in that agent's compute
vault (balance read back from chain); an e2e script `scripts/devnet/graduation-e2e.ts` that reruns it
on a fresh token; fixes to the program or client found on the way, with LiteSVM tests.

## L2. Market indexer

New package `packages/indexer` (Bun, SQLite, own process, default port 9668 locally; on the site it
sits behind the same Caddy as Core at `/market/*`). Sources, devnet: every pool created by
`launch_agent` (read from `lineage_launch` accounts), its DBC swaps, its DAMM v2 pool after graduation,
`crank_fees` and `crank_pool_fees` events and compute-vault balances. Ingest by
`getSignaturesForAddress` backfill plus polling (and `logsSubscribe` when the RPC allows), decoding
swap amounts from the transactions' token balance deltas and program logs; idempotent by signature;
resumable; uses the RPC resolver in `packages/chain/src/endpoint.ts` with 429 backoff.

Read API (JSON, CORS for the site):

| Route | Returns |
|---|---|
| `GET /market/tokens` | every agent token: mint, agent id, name and symbol, phase (`curve` or `graduated`), price in tLINE, market cap in tLINE, 24h volume, 24h change, curve progress (quote reserve / migration threshold), holders, created_at |
| `GET /market/tokens/:mint` | the same plus pool addresses, supply, fees to the compute vault and treasury so far, compute-vault balance |
| `GET /market/tokens/:mint/candles?tf=1m\|5m\|1h\|1d&from=&to=` | OHLC in tLINE per base token, volume |
| `GET /market/tokens/:mint/trades?before=&limit=` | trades: signature, time, side, base amount, quote amount, price, trader |
| `GET /market/tokens/:mint/holders?limit=` | top holders and balances |
| `GET /market/tokens/:mint/fees` | fee cranks: time, signature, amount, vault and treasury split |
| `GET /market/status` | last indexed slot per source, lag, RPC in use (redacted) |

Prices are tLINE per token only (no USD: tLINE has no market). Exit: unit tests on recorded
transactions (decode buy, sell, crank, migration); a run against devnet that indexes every existing
Lineage agent token with trade counts matching a recount from chain for at least one token; deployed
on the site as a systemd unit.

## L3. Launchpad pages

On the existing web app (`apps/web`), reading `/market/*` and Core: a token list (`/tokens`) sortable
by market cap, volume, newest, graduation progress; a token page (`/tokens/:mint`) with price chart
(candles), trade box (buy and sell on DBC before graduation, DAMM v2 after, signed in the browser
wallet through the existing wallet bundle), recent trades, holders, curve progress and graduation
state, fee history and compute-vault balance, and links to the agent's page and lineages. The token page embeds that agent's live panel (L4) as a main element (owner request 2026-10-09): the agent's current session live when it is working, otherwise its most recent session in replay, with a list of earlier sessions.
Built as plain components so the owner's UI work can restyle them.

Exit: headless check at 1280 and 390 px with no horizontal scroll and no console errors; a real devnet
buy and sell through the page in the wallet e2e harness; numbers on the page equal the indexer's.

## L4. Live agent panel

A browser-style window with an orange glow border and an orange cursor that shows what an authoring
agent is doing: tab bar (repo, branch, one tab per file it touches), code view where the cursor moves
to the lines it reads and its edits type in, and a run strip (build, tests, metrics) with real output
and the verdict.

- Worker: the Claude proposer's tool calls (`read_file`, `list_files`, `search`, `edit_file`,
  `write_file`, `evaluate`, `submit`) become session events (file, line range, and for edits the
  before and after text); scripted authors emit their patch hunk by hunk as edit events labelled as a
  patch being applied. Batched to Core with the telemetry channel.
- Core: stores sessions per authoring attempt. Navigation events (file, lines) and run phases are
  public in real time; edit contents are withheld until the attempt's candidate is committed (a copy
  of a visible patch could otherwise be committed first, and author-blind replay, SPEC 10.7, would
  leak). The agent's identity follows 10.7 (hidden while the candidate is open, unless the agent is
  already publicly working that lineage through an intent). An attempt that ends without a candidate
  publishes its edits when it ends. Sessions are kept for replay.
- Web: `/live/agent/:session` and an embeddable panel component; live mode follows the stream; replay
  mode plays a finished session at adjustable speed.
- Website repos: a preview tab of the built site is a later step (needs a web recipe class).

Exit: unit tests for the gate (edit contents never served before commit); a local network run where a
Claude author's session plays live (navigation) and then shows its edits after commit, and a scripted
author's session on the site; headless UI check at both widths.

## Order

L1, L2 and L4 run in parallel (different paths). L3 starts once L2's API answers (it can mock from the
table above until then) and embeds L4's panel component once it exists. The site gets one drain-safe deploy at the end.
