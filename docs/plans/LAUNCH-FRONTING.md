# Launch fronting: the launcher pays an agent's start-up costs

Owner decision 2026-10-10. Whoever creates an agent and its token fronts its initial costs at
creation, in the launch flow:

1. **Token creation cost**: rent and network fees of every account the launch creates. The launcher
   already pays it; the wizard now shows it exactly, from the launch simulation (the launcher's SOL
   balance before minus after), never an estimate.
2. **Model credits**: a required prepaid deposit into the agent's compute vault, 10 USD by default,
   converted at Core's configured rate (a TEST rate on devnet). It was a minimum with an editable
   amount (plan C); it is now exactly the configured amount, and the amount is admin-editable.
3. **Initial buy**: the launcher buys `initial_buy_bps` of the token's total supply (100 = 1%), and
   the tokens go to the agent's own trading treasury. Admin-editable.

Owner decision later the same day: agent tokens launch on **pump.fun only** (Custom Pairs quoted in
$LINE), devnet included; Meteora DBC launches are being removed (docs/plans/PUMPFUN-LAUNCHES.md). This
lane therefore built only the venue-agnostic part. The buy itself is built by the pump.fun launches
lane, where it is the creator's initial buy inside `create_v2`. Section 6 is the exact interface that
lane calls.

## 1. What was built (this lane)

| Part | Where | What |
|---|---|---|
| Config | `config/network.json` `prepay` block, `packages/chain/src/prepay.ts` (`PrepayConfig`) | `initial_buy_bps` (default 100), `initial_buy_slippage_bps` (default 100), both integers 0 to 10,000. The required credits are `min_usd` (equal to `default_usd`). |
| Admin edit | `packages/core/src/prepay.ts`, `POST /v1/admin/launch-fronting` (admin key) | Body `{ credits_usd?: "10", initial_buy_bps?: 100, initial_buy_slippage_bps?: 100 }`; unknown fields and out-of-range values are refused; the patch is stored in Core (`prepay_admin`) and applied over the file's block, so `GET /v1/config` (`network.prepay`) serves the effective values. `GET /v1/launch-fronting` shows them with the stored patch. |
| Math | `packages/chain/src/prepay.ts` | `requiredCredits(cfg, decimals)`, `initialBuyAmount(supply, bps)` = floor(supply x bps / 10,000), `maxBuyInput(quote, slippageBps)` = ceil(quote x (10,000 + bps) / 10,000), `frontingCosts`, `frontingShortfall`. |
| Planner | `packages/chain/src/prepay.ts` `planLaunch` | New optional `buy: Ix[]`; result gains `buyTx` (0, 1 or null). See section 3. |
| Wizard | `apps/web/wallet/fronting.ts` (new; logic), small hunks in `wallet/main.ts`, `wallet/pages.ts`, `wallet/prepay.ts` | Funding and Review show the three lines and the total from the same simulation; Launch is disabled until the wallet covers all of it; the credits field is read-only at the configured amount. |
| Record | `packages/core/src/prepay.ts` `readLaunchDeposit` + `GET /v1/agents/:id/prepay` | Core reads the launch transaction once (as for the deposit) and records `initial_buy`: the agent mint's token balance owned by the agent key after that transaction (any venue), and the mint's supply; the view gives `initial_buy` and `initial_buy_bps_of_supply`. |
| Profile | `apps/web/src/pages/holding-line.ts` (new), one line in `agent-profile.ts` | Chip "Holds 1% of its supply (bought by the launcher at launch)" from Core's record; nothing for an agent launched without a buy. |
| Trader | `packages/trader/src/{policy,trader,analyst}.ts` | The agent's own token is held, not traded (section 4). |

## 2. The three cost lines, exactly

All from one simulation of the first launch transaction (`buildAndSimulate`, the one the Review step
already runs; the Funding step now runs it too when a wallet is connected):

- **Token creation (SOL)** = launcher lamports before minus after in the simulation. That is the
  network fee plus every rent deposit the launcher pays in that transaction (mint, pool or curve
  accounts, launch record, compute vault, the treasury's token account). Not a sum of guessed rents.
- **Model credits (quote token)** = `usdToBase(min_usd, line_per_usd, decimals)`, shown with its USD
  figure and the rate (labelled TEST on devnet).
- **Initial buy (quote token)** = the launcher's quote token balance before minus after in the
  simulation, minus the credits: the exact cost including the venue's fee. The line also shows the
  amount of tokens (exactly `initialBuyAmount(supply, bps)`) and the maximum input the transaction
  allows (`maxBuyInput(quote, slippage)`). When the planner put the buy in the second transaction
  (section 3), the first simulation cannot contain it and the line shows the venue's curve quote.
- **Total** = SOL line + (credits + buy cost) quote token. The wallet must hold the creation SOL and
  credits + the buy's maximum input; `frontingShortfall` says which is short, and the Launch button
  stays disabled with that reason.

Until a venue registers a buy builder (section 6), the buy line reads "not in this launch yet" and the
total is lines 1 and 2: today's Meteora launch is unchanged and still works.

## 3. Transaction composition

`planLaunch({ payer, main, buy, soul, budget, table, v0 })`, never more than two transactions:

1. one legacy transaction with main + buy + soul when it fits 1,232 bytes;
2. else one v0 transaction with the frozen launch lookup table (wallets that sign v0);
3. else two: (a) main + buy, (b) the soul;
4. else two: (a) main, (b) buy + soul (or the buy alone);
5. else a clear error.

The buy stays in the first transaction whenever it fits there, so nobody trades the new curve before
it. Measured with a stand-in buy of the shape a separate buy instruction has (an ATA create for the
treasury plus a 15-account swap; `packages/chain/test/launch-fronting.test.ts`): main 1,179 bytes legacy
/ 905 v0; main + buy 1,296 / 1,053; main + buy + soul 1,346 / 1,134; with the longest strings
`launch_agent` accepts, main + buy + soul is 1,250 as v0, so case 3 applies. A wallet that signs only
legacy lands in case 4: the buy is in the second transaction. On pump.fun the buy is part of
`create_v2` itself (section 6), so `buy` is empty and the buy can never be separated from the create.

Never a double send: the wizard's one-launch guard is unchanged (an `AgentLaunch` already on chain is
read back, not resent), and the second transaction is sent only while what it carries is missing on
chain (the soul digest is not set, or the treasury token account holds less than the buy amount).

## 4. The agent's own holding (trader rule)

- An agent never trades its own token (existing `integrity_own_token`, which already refused buys and
  sells by the model). It now also covers the holding explicitly:
  - `Book.own_held` carries the treasury's balance of its own mint; it is never a position and never
    counted in equity, so its price can neither trip a daily-loss or drawdown halt nor size a trade;
  - the risk exits skip the own mint, so no stop-loss or take-profit can sell it, even if a position
    in it existed in old state;
  - the executor refuses any action in the own mint before Core's dry run (defence in depth);
  - the analysis prompt tells the agent it holds the amount, bought by its launcher, held not traded.
- Tests: `packages/trader/test/policy.test.ts` "own-token holding": model sells at 1%, 50% and 100%
  refused, a buy refused, `checkTrade` refuses, risk exits at an extreme stop-loss and take-profit price
  do nothing and add no refusals, equity unchanged by the holding.
- Public: the profile chip (section 1) and Core's prepay view.

## 5. Where the tokens go: the treasury key

The trader's treasury is the agent's current registry signing key (`packages/trader/src/trader.ts`
`TradingAgent.key`). At launch time that is the agent key the wizard makes in the browser: it signs
`launch_agent` and owns the delivered tokens. A self-hosted agent keeps it.

A hosted agent rotates its signing key to the hosted runtime's key right after the launch (the bind
step), and the runtime only makes that key once it sees the launch on chain. So at creation the only
treasury that exists is the agent key. For hosted agents the holding must then move to the runtime's
key: the bind step can send one more transaction, signed by the agent key that is still in the tab
(the launcher pays the fee), with `createAtaIdempotent(runtimeKey, agentMint)` and a
`transferChecked` of the whole launch holding. This is not built (it touches the venue's token program
choice and the wizard's bind flow, both in flux); see open decision D3.

## 6. Interface for the pump.fun launches lane

Read the config from `P.cfg` (`apps/web/wallet/prepay.ts`, loaded from `GET /v1/config`):
`initial_buy_bps`, `initial_buy_slippage_bps`.

**Option A, the buy inside `create_v2` (recommended in PUMPFUN-LAUNCHES 6.1):**

1. `amountOut = initialBuyAmount(totalSupply, P.cfg.initial_buy_bps)` (pump.fun total supply from the
   `Global` account, base units).
2. Quote from the curve's virtual reserves at creation (no trade can precede it in the same
   transaction): `quote` = the exact quote input for `amountOut` including pump.fun's fees, and
   `maxIn = maxBuyInput(quote, P.cfg.initial_buy_slippage_bps)`.
3. Put the creator buy into the `create_v2` instruction (its exact-output amount `amountOut`, its
   maximum quote `maxIn`) so the tokens land in the **agent key's** token account (section 5).
4. Register the builder once, at wizard start:

```ts
import { setInitialBuyBuilder } from "./fronting.ts";
setInitialBuyBuilder({
  supply: async () => pumpGlobal.tokenTotalSupply,           // base units
  build: async ({ launcher, agent, agentMint, amountOut, slippageBps }) => ({
    ixs: [],                                                  // empty: the buy rides in create_v2
    amountOut,                                                // must equal the configured amount (checked)
    quote,                                                    // curve quote for exactly amountOut
    maxIn: maxBuyInput(quote, slippageBps),                   // checked against the config
    treasuryAccount: ata(agent, agentMint, tokenProgram),     // where the tokens land
  }),
});
```

   With `ixs: []` the planner keeps one transaction and `costsFromSim` still reads the exact buy cost
   from the simulation (quote spent minus credits), as long as the builder is registered and the
   create instruction in `main` carries the buy. The wizard's `launchReview` passes `buy.ixs` to
   `planLaunch` and the result to `costsFromSim` already; the venue lane only swaps the create
   instruction in `main` and registers the builder.

**Option B, a separate buy instruction after the create** (pump `buy_v3` exact out): return those
instructions in `ixs`; the planner places them after `main` and applies section 3.

Core needs nothing from the venue: it records `initial_buy` from the launch transaction's token
balances (agent mint, owner = agent key) whatever the venue is.

## 7. Open owner decisions (not decided here)

- **D1 Vesting or lock** of the agent's launch holding: today it is only "never traded" by the trader
  engine (a policy, enforced off chain, published). A lock on chain (a vesting or lock account the
  agent cannot move from) is not built and would need a program or a third-party lock.
- **D2 What happens at graduation or an owner transfer**: the holding stays with the treasury key.
- **D3 Hosted agents**: move the holding from the agent key to the runtime key at bind (section 5),
  or deliver at launch to an account the runtime can later claim. Until decided, a hosted agent's launch
  holding stays with the launch agent key (which the launcher can download in the wizard), so the
  "never sold" guarantee holds only for what the trader controls.
- **D4 Whether the launcher may ever buy more than the configured bps in the creation transaction**
  (pump.fun lets a creator buy any amount); the config is a fixed amount today.
- **D5 Mainnet credits rate**: the 10 USD converts at a TEST rate on devnet; mainnet needs a price.

## 8. Not done in this lane

- No devnet launch with an initial buy: the owner moved launches to pump.fun before it, and the
  coordinator asked this lane not to build or prove the buy on Meteora.
- No program change.
