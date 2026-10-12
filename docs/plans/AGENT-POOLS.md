# Agent pools: agents on one repository share fees, buybacks, burns and holdings

Status: spec (2026-10-11, pools and claims lane). Owner request 2026-10-11. Built behind feature
flags, default off everywhere; launched later with the product and the token. Devnet only.
Companion: `docs/plans/GITHUB-FEE-CLAIMS.md` (the other slice of the same fee crank).

Every number below is a TEST value for devnet unless it says otherwise. Launch values are TBA and
the owner sets them; every percentage is an admin-editable basis-point field on chain.

## 1. What the owner chose

Agents working on the same repository form a pool, so it is not one repository per agent, and being
in a pool benefits every member's token: a shared fee pool AND cross buybacks, plus more price
impact.

## 2. Flags

| Flag | Where | Default | Effect when off |
|---|---|---|---|
| `LaunchConfig.features` bit 0 (`FEATURE_POOLS` = 1) | on chain, `units_launch`, admin `set_features` | 0 | `join_pool`, `pool_settle`, `pool_buy` refused; `crank_pump_fees` ignores pool membership and splits exactly as today |
| `PoolConfig.auto_join` | on chain, admin `set_pool_config` | false | joining needs the signature of the agent's registry owner |
| `PoolConfig.paused` | on chain | false | when true: no join, settle or buy, and the crank routes no pool slice |
| `features.agent_pools` | `config/network.json` (Core), env `UNITS_FEATURE_AGENT_POOLS=1` overrides for one process | false | Core serves no pool route (404 `feature_off`), runs no pool keeper, applies no pool coordination rule; pages show nothing |
| `features.agent_pools` | `config/profile.json`, both network blocks | false | the wallet and dashboard bundles hide the pool UI |

A solo pool does nothing: slices are routed only while the pool has two or more members.

## 3. Decisions

**D1. A pool is per repository.** PDA `["pool", repo_id]` of `units_launch`, `repo_id` being the
`AgentLaunch.repo_id` the program computed at launch (protocol `repoId(canonical url)`), so an agent
can only ever join the pool of the repository it was launched on. The member list (agent keys) is in
the `Pool` account; each member also has `PoolMember` `["pool_member", agent]`.

**D2. Joining.** `join_pool` is signed by the agent's current registry owner (the launcher at
launch: the wizard adds it to the launch transaction when the launcher opts in). With
`auto_join` on, any signer may join any launched agent to the pool of its repository, and Core's
keeper does so when a second agent targets a repository (both agents are joined). No leaving in
this version (open question Q4).

**D3. Fee slice.** A member routes `pool_fee_bps` of its own share of each fee crank into the pool
vault. Both new slices (pool, GitHub) come out of the agent's share; the protocol share is computed
first and is byte-identical to today:

```
agent_share = floor(fees x agent_compute_bps / 10,000)      to_protocol = fees - agent_share   (unchanged)
to_github   = floor(agent_share x route.bps / 10,000)       (GITHUB-FEE-CLAIMS.md; 0 without a route)
to_pool     = floor(agent_share x pool_fee_bps / 10,000)    (0 unless a member of a pool with >= 2 members)
to_compute  = agent_share - to_github - to_pool
```

`pool_fee_bps` and the GitHub maximum are each capped at 5,000 by the program, so the compute share
never goes negative.

**D4. Buckets, not a drip.** Each routed amount first fills the member's cross-holding obligations
(D8), then is divided into three buckets held in the pool vault: payouts (`payout_bps`), buybacks
(`buyback_bps`) and burns (`burn_bps`, the rest; the three sum to 10,000). Buckets only move at
verified events (an epoch with verified improvement, verified generations, a milestone). This is the
"more price impact" lever: buys land as fewer, larger, public events tied to verified work, instead
of a continuous trickle that arbitrage flattens.

**D5. Payouts (i): by measured share.** At a settled epoch with at least one verified generation by
a member, the whole payout bucket is allocated to the members in proportion to their author units on
the repository's units in that epoch (SPEC 13.3: `u_author x cost_class x value(effect)`, already
divided by declared shares or the measured Shapley split, 12.2 and 12.6). Each allocation is paid
into that member's compute vault by the permissionless `pool_pay`. An epoch without verified
improvement carries the bucket forward.

**D6. Buybacks (ii): weighted to the non-authors.** Per settled epoch the buyback budget is
`bucket x min(1, gens x buyback_per_gen_bps / 10,000)`, `gens` being the members' verified
generations in the epoch. Each author's part of the budget (by the same weights as D5) is split:
`author_buyback_bps` buys the author's own token, the rest is divided equally among the other
members' tokens. Bought tokens stay in the pool's token account for that mint for good: the program
has no instruction that moves them out (burning aside).
Why not pro rata: the author's token already gets the news of its accepted generation and the
author gets the larger payout (D5). Sending the larger part of the buyback to the others is what
makes membership worth something to a member that did not author this epoch, and it removes the
reason to stay solo. A nonzero author part keeps authoring strictly better than waiting. Equal
division among the others (not by market cap or contribution) is the simplest rule a reader can
check; the sybil case is Q2.

**D7. Milestone buy-and-burn (iii).** When the repository crosses a verified milestone (Core:
cumulative improvement of a metric of one of its units reaches a configured threshold, section 6),
`bucket_burn x min(1, milestones x burn_per_milestone_bps / 10,000)` is divided equally among all
members; each part buys that member's token and the tokens are burned in the same instruction.

**D8. Cross-holdings (iv).** On join the new member owes one purchase of each existing member's
token and each existing member owes one purchase of the newcomer's, `cross_hold_quote` $UNITS per
purchase. Obligations are funded from the owing member's own routed slice before anything reaches
the buckets, then bought by the keeper through the same swap path; a `CrossHolding`
`["cross", holder, target]` record names holder, target, $UNITS spent and tokens bought (one per
ordered pair). The tokens sit in the pool's token account like buyback tokens: held, never sold,
like the 1% launch holding (SPEC 14.12).

**D9. Who decides what.** Core's pool keeper (`PoolConfig.keeper`, a dedicated service key, never
an agent key and never a model) posts one `pool_settle` per pool and epoch: the epoch, the number
of verified generations, the members' weights (bps, sum 10,000), the number of new milestones and a
digest of the public settlement record. The program enforces everything else: the epoch must be
posted in the registry and newer than the pool's last settled epoch; budgets come from the buckets
by the configured bps; payouts can only reach members' compute vault PDAs; buys can only buy a
member's mint into the pool's own token account. A wrong keeper can skew the split between members
of one pool for one epoch; it cannot take funds out. Core's settlement inputs are public records,
so `scripts/pools/verify-settlement.ts` recomputes them. Permissionless settlement from
contribution leaves (as bounties do, SPEC 14.7) is Q5.

**D10. Buys: a narrow CPI, checked by balances.** `pool_buy` calls exactly one of two instructions
with data the program builds itself: Pump `buy_v3` (curve) or PumpSwap `buy_v2` (after graduation),
with the pool authority PDA as the buyer. The program ids are constants; the keeper only supplies
the account list. After the call the program requires that the pool vault lost at most the allowed
budget (and at most `max_buy_quote` per call) and that the pool's token account of the target
member's mint gained at least the requested tokens; otherwise the transaction fails. This is the
first place `units_launch` calls pump.fun (launch attach still reads only, PUMPFUN-LAUNCHES.md 12):
a pump.fun interface change can make a buy fail, never overspend. Only the keeper may call it, and
`max_buy_quote` bounds a single buy so that sandwiching one costs more in pump.fun fees than the
price impact returns (Q6 sets the value). These two instructions are the same swap paths the agent
wallet firewall allows (docs/plans/AGENT-WALLET-SAFETY.md); no agent key signs any pool
transaction, so nothing a model writes can become a pool instruction (section 7).

**D11. Coordination (b).** Offchain, in Core, only while the Core flag is on:
- `GET /v1/pools/:id/context`: the members, their open intents, the open findings and shared
  findings of every unit of the repository, in one answer for workers.
- Target claims: a member's intent (SPEC 12.1) on a target another member of the same pool already
  holds an open intent on is refused (`409 pool_target_claimed`). It binds members only, expires
  with the intent (TTL, tip move, withdrawal, or the candidate becoming final) and never blocks a
  commit, so verdicts and author-blind replay (10.7) are untouched. This addresses the measured
  cross-agent stale conflicts (AGENT-EFFICIENCY.md: 31% of candidates stale).
- Stacked work: a series (12.4) whose team members are all in one pool must ask for the measured
  split (12.6) where it is available (`400 pool_split_required`); where it is not (chain mode today,
  noisy metrics, more than `max_split_members`) declared shares apply and the candidate records why.

## 4. Onchain (`units_launch`, `src/pool.rs`)

| Account | Seeds | Contents |
|---|---|---|
| `PoolConfig` | `["pool_config"]` | keeper, `auto_join`, `paused`, `max_members`, `pool_fee_bps`, `payout_bps`, `buyback_bps`, `burn_bps`, `author_buyback_bps`, `buyback_per_gen_bps`, `burn_per_milestone_bps`, `cross_hold_quote`, `max_buy_quote` |
| `Pool` | `["pool", repo_id]` | repo id, member agent keys, the four buckets (cross, payout, buyback, burn), last settled epoch, totals |
| pool authority | `["pool_auth", repo_id]` | signer only; owns the pool vault (its $UNITS ATA) and one ATA per member mint |
| `PoolMember` | `["pool_member", agent]` | pool, agent, mint, index, contributed, cross due and funded, payout / buyback / burn due, totals paid, bought, held, burned |
| `CrossHolding` | `["cross", holder, target]` | one per ordered pair: $UNITS spent, tokens |

Instructions: `set_features` and `set_pool_config` (launch admin), `join_pool`, the pool slice
inside `crank_pump_fees`, `pool_settle` (keeper), `pool_pay` (anyone), `pool_buy` (keeper; kinds
cross, buyback, burn). `LaunchConfig.reserved` (always zero) becomes `features` (1 byte) plus 15
reserved bytes and `AgentLaunch.reserved` becomes `routes` (1 byte) plus 31: same sizes, same
bytes, no migration. `crank_pump_fees` keeps its eight accounts; an agent with a route or a
membership needs trailing accounts, an agent without neither does not, so existing clients keep
working for every agent that did not opt in.

Test values: `pool_fee_bps` 2000, `payout_bps` 4000, `buyback_bps` 4000, `burn_bps` 2000,
`author_buyback_bps` 2000, `buyback_per_gen_bps` 2500, `burn_per_milestone_bps` 5000,
`cross_hold_quote` 10 tUNITS, `max_buy_quote` 1,000 tUNITS, `max_members` 8 (program maximum 16).

## 5. Core, indexer, pages

- `packages/core/src/pools.ts`: mirror of pools and members from chain, `GET /v1/pools`,
  `GET /v1/pools/:id`, `GET /v1/agents/:id/pool`, `GET /v1/pools/:id/context`,
  `GET /v1/pools/:id/settlements`, `GET/POST /v1/admin/pools/config` (milestone thresholds, keeper
  switches), `POST /v1/admin/pools/settle` (run one settlement now). The keeper loop joins
  (auto-join), settles after each epoch close, pays and buys.
- `packages/chain/src/pools.ts`: builders, PDAs, decoders, the keeper's buy planner.
- Indexer: `PoolJoined`, `PoolRouted` (in `FeesRouted`), `PoolSettled`, `PoolPaid`, `PoolBought`.
- Pages: a pool line on the agent profile and the token page ("In the <repo> pool with N agents"),
  the opt-in checkbox in the wizard. Hidden while the flag is off.

## 6. Milestones

A milestone is a threshold of cumulative verified improvement of one metric of one unit of the
repository: `1 - product(effect ratio of every accepted, live generation on that metric)`.
Thresholds are a Core config list per pool default (`pool.milestones`, TEST values 0.10, 0.25,
0.50), admin-editable; each (unit, metric, threshold) counts once. Core's settlement record lists
the generations behind every crossing.

## 7. Safety

- No agent key signs a pool transaction; the keeper key is a Core service key, and the program
  pins what its signature can do (D9, D10). Model output never reaches a pool instruction: the
  keeper reads records and chain state only.
- Attack tests (LiteSVM, red on the old build, green on the new): crank with another agent's
  member, pool or vault; a non-member mint; a look-alike venue program; a buy past its budget or
  past `max_buy_quote`; a buy whose accounts name another mint; a second cross buy for one pair;
  settle by a stranger, twice for one epoch, for an unposted epoch, with weights that do not sum;
  pay to another vault; join another repository's pool, twice, or without the owner; and with the
  flag off: identical splits to today and every pool instruction refused.

## 8. Shared liquidity pair and repo index (research)

Filled in by the feasibility run (section 10 has the result). Not shipped unless feasible.

## 9. Open questions for the owner

- Q1. Launch values of every bps, `cross_hold_quote`, `max_buy_quote`, the milestone thresholds.
- Q2. Sybil members: a launcher can add a second agent on its own repository to receive the
  non-author buybacks its first agent funds. Today that only moves the launcher's own fees between
  its own tokens. If outside members' fees are at stake, weight the others' part by fees
  contributed over a window instead of equally (program change, small).
- Q3. Does the protocol share also contribute to pools, or only the agent share (as built)?
- Q4. Leaving a pool (and what happens to a leaver's dues and the tokens the pool holds of it).
- Q5. Permissionless settlement from contribution leaves instead of the keeper's attestation.
- Q6. Should buybacks be burned too (as built: buybacks held, milestone buys burned)?
- Q7. Auto-join on mainnet from day one, or opt-in only?

## 10. Results

To be written by the lane as it lands (tests, devnet proof, feasibility).
