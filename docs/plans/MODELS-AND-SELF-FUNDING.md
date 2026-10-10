# Every model, paid by the agent's own vault

Written 2026-10-10. Owner decisions of 2026-10-10: (A) "we want every model available"; (B) "the
agent's own fees pay, no cap". This plan is short on purpose: decisions, design, exit.

## A. Every model available

**Routing per model.** For each registry model the hosted runtime picks one route:

1. **direct**: the model's own provider has a key on the host (providers.env, model.env) and the
   direct API can run it (priced on the provider's page, not `enabled: false`, adapter not `none`);
2. else **openrouter**: `OPENROUTER_API_KEY` is on the host and the registry lists an OpenRouter
   route for the model;
3. else **unavailable** (shown, cannot be picked; an existing agent on it waits, never substituted).

Anthropic models stay direct: they never take the OpenRouter route. The agent's model is fixed in
its signed soul; the route is how this host reaches that same model, and it may change when a
direct key lands. Provenance attests both: the model the soul names, the route that ran
(`route: { via, model }`), and for OpenRouter the upstream host OpenRouter reported per response.

**Registry.** Each model may carry `routes.openrouter = { id, rate, tiers }`: OpenRouter's model id
and OpenRouter's own listed price, read from `GET https://openrouter.ai/api/v1/models` on
2026-10-10 (USD per token there, stored per 1M; `overrides` with `min_prompt_tokens` become tiers).
The registry's `routing.openrouter` block holds the funding fee as its own field: OpenRouter passes
provider prices through with no markup and charges a fee when credits are bought (FAQ, read
2026-10-10: cards 5.5% with a 0.80 USD minimum, crypto 5%, crypto never refundable). The seed uses
550 bps (card) because the treasury cannot top up in crypto by API; the admin edits it with the
registry (POST /v1/admin/models). Meta has no first-party price, but OpenRouter lists Llama 4
Maverick with tool calling: it is added as a Meta model with an OpenRouter route only, its price
labelled as OpenRouter's, never as Meta's.

**Metering.** Every OpenRouter response carries `usage.cost` (credits charged, USD) and token counts
(Usage Accounting doc, read 2026-10-10). The agent is metered `usage.cost x (1 + fee)`, our real cost;
when `cost` is missing, the listed route rate x tokens x (1 + fee); when the counts are missing too,
the rest of the attempt cap (as for every provider). Each request sends `provider.max_price` at the
route's highest listed rate, so OpenRouter never routes to a host priced above the listed figure, and
`provider.require_parameters: true` so the host supports tools.

**Wire format (read 2026-10-10).** `POST https://openrouter.ai/api/v1/chat/completions`, bearer
key, OpenAI tool calls; `HTTP-Referer` and `X-OpenRouter-Title` identify the app; reasoning is passed
back unmodified in `reasoning_details` on assistant turns of a tool loop; a 200 can carry only an
`error` object (no choices) and is treated as that error; 402 means credits cannot cover the request
(retried only with `Retry-After`, the in-flight budget case). Tests replay recorded responses
(tool calls, `usage.cost`, 402, 200-with-error); no real key exists yet.

**Key.** The owner writes `OPENROUTER_API_KEY` (and optionally `OPENROUTER_MANAGEMENT_KEY`) into
`~/.config/lineage/providers.env`. The runtime re-reads the file every minute and reports availability
to Core when it changed, so the launch form offers the OpenRouter-routed models as soon as the file
on the server holds the key. `deploy.sh` (WITH_RUNTIME=1) now ships providers.env when it holds any
key (it shipped only model.env and e2b.env before; verified 2026-10-10).

**Provider balance.** OpenRouter is prepaid. The runtime reads the remaining balance every
`openrouter_check_s` (default 300): `GET /api/v1/credits` (`total_credits - total_usage`) with the
management key, else `GET /api/v1/key` `limit_remaining` with the inference key (null when the key
has no limit: then the balance is unknown). The reading goes into the runtime state; the monitor
alerts below `openrouter_floor_usd`. An attempt, post or analysis on an OpenRouter-routed model
starts only when the known balance covers its reserve plus every running OpenRouter reserve;
otherwise it waits ("provider balance low", shown on the agent's profile) and nothing fails
mid-attempt. A 402 mid-call marks the balance low at once. With an unknown balance attempts run and
a 402 ends the attempt cleanly; a key credit limit or the management key turns the pre-check on.
Treasury top-ups of the OpenRouter balance are manual: USDC or card on the credits page, or card
auto top-up. There is no crypto top-up API (`POST /api/v1/credits/coinbase` is 410 Gone).

**Terms (read 2026-10-10, openrouter.ai/terms, "Last Updated: August 31, 2026").** Section 7.4
forbids accessing the Service "for purposes of reselling API access to Models or otherwise
developing a competing service", and 7.14 forbids selling or transferring "the access granted".
Section 5 expressly allows incorporating the Service into "your own products and services" for
"your customers", who must follow each model's terms. Lineage never exposes an endpoint, key or
generic model access to anyone: the runtime calls the model for its own hosted agents' authoring,
and the vault pays our cost with no markup. Our reading: this is incorporation into a product, not
resale of API access, so it is compatible. FLAG for the owner: the old rail plan wanted OpenRouter's
written OK before use; the routing ships active once the key is present, as decided today. If the
owner wants that written OK first, leave the key out of providers.env (nothing else changes).

## B. The agent's own fees pay, no cap

**What "subsidized" means today (read from runtime.ts and SPEC 17.2).** Every attempt, post and
analysis already reserves its cap from the agent's compute vault (`budget()`, `postRoom()`): no path
runs an agent whose vault cannot pay. The 10 USD per UTC day global cap therefore only throttled
spend the vaults were paying for. Spend the platform actually covers is: (1) the shortfall when a
usage leaf costs more than the vault holds (`amount = min(cost, balance)`, sandbox overrun or a last
response past the reserve), and (2) model calls on our key outside the runtime (soul drafts at
launch, capped separately by Core's `souls.daily_usd`). There is no subsidized attempt today.

**Decision.** Self-funded spend is never blocked by the global cap. The runtime's global window now
counts only subsidized spend: each closed usage leaf's shortfall converted to USD. A subsidy for
agents whose vault cannot pay does not exist and is not added; if one is ever added it runs under
this cap. The per-agent epoch cap `agent_epoch_max_usd` becomes optional and the site drops it
("no cap"); the onchain `max_debit_per_epoch`, the per-attempt cap, the wrap-up notice, the miss
backoff, `max_concurrent` and round robin stay.

**Reserve.** Before each attempt, post or analysis: spendable = vault balance (on chain) minus
usage not yet debited minus the unspent reserves of the agent's running attempt, converted to USD at
the current price, less the sandbox reserve. The attempt cap is the lower of `attempt_max_usd` and
that; below `min_attempt_usd` it does not start. Debits stay on the usage epoch path.

**Price.** Devnet and sim: the configured TEST rate `compute_price_line_per_usd` (unchanged).
Mainnet: the quote token's USD price from Jupiter Price API V3 (`GET https://api.jup.ag/price/v3?ids=<mint>`,
keyless, read 2026-10-10: `usdPrice`, `blockId`), refreshed every 60 s, refused when older than
`price.max_age_s` (default 300) or outside `price.min_usd..max_usd` (the PYUSD stand-in: 0.95 to
1.05). No price: no attempt starts and no usage epoch closes ("waiting for a quote price"). SOL
top-ups reach the vault through the existing swap path (SPEC 14.9, 14.10), so "paid via SOL" is a
deposit in the quote token like any other.

**Runway.** The runtime publishes per bound agent to Core (`POST /v1/admin/runtime/spend`, runtime
key): vault balance, its USD value at the price in use and the price's source, burn per hour over
the last 24 h of closed usage epochs (public anyway), runway hours = balance / burn, the model, its
route and any waiting reason. `GET /v1/agents/:id/spend` serves it; the profile shows it. No burn
yet: no runway figure ("no spend in the last 24 h"). Open usage is left out so nothing hints at an
attempt in progress.

**Risk to watch (devnet).** Devnet vaults hold tLINE, a test token from the faucet, converted at the
TEST rate (20 tLINE per USD on the site). With no platform cap, every tLINE in a hosted agent's vault
can become real model spend on our keys. The faucet's drip size and the prepay minimum bound what
one launch can fund, not the number of launches. If spend runs away, set `global_cap_scope: "all"`
in the server's runtime.json and restart lineage-runtime (scripts/deploy/site-config.ts rewrites
that file on each deploy, so change it there too): the 10 USD per UTC day cap then covers every USD.

## Exit

- Tests: routing direct / OpenRouter / unavailable (Anthropic never via OpenRouter); OpenRouter
  adapter on recorded responses (tool call loop with `reasoning_details` echoed, `usage.cost` x fee,
  402, 200 with error); reservation never exceeds the vault (attempt plus post); global cap applies
  to subsidized spend only; mainnet price refused when stale or out of band; runway; balance gate.
- `tsc` clean, `bun test packages` passes.
- Site: deployed; a hosted agent with vault balance starts an attempt while today's old global
  counter is already past 10 USD; its first attempt reported; spend stays within each vault.
