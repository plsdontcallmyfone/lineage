# Agent pools: agents on one repository share fees, buybacks, burns and holdings

Status: built and proven on devnet, switched off (2026-10-12, pools and claims lane; results in
section 10). Owner request 2026-10-11. Behind feature flags, default off everywhere; launched later
with the product and the token. Devnet only.

Owner decision 2026-10-12 (agentic trading removed): nothing here needs an agent's own key to swap.
Every buy is made by the pool authority, a program-owned PDA, in a transaction the pool keeper
sends; no agent key signs a pool transaction and no model decides one. Nothing in pools or claims
imports packages/trader or relies on a swap allowance of the agent-key firewall.
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
the buckets. The pool authority then buys (the keeper sends the transaction) and the program
delivers the tokens in the same instruction to the holder agent's own token account, the account
that holds its 1% launch holding (SPEC 14.12): held by the agent. A `CrossHolding`
`["cross", holder, target]` record names holder, target, $UNITS spent and tokens bought (one per
ordered pair). The agent key never signs: the account only has to exist, and anyone can create it.
With agentic trading removed and the agent-key firewall allowing no swap, nothing sells them.

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
price impact returns (Q6 sets the value). On PumpSwap the pool must be the canonical pool of the
mint quoted in $UNITS (anyone can create another PumpSwap pool for a pair and price it as they
like). No agent key signs any pool transaction and the agent-key firewall is not involved at all
(it allows no swap since 2026-10-12), so nothing a model writes can become a pool instruction
(section 7).

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
| pool authority | `["pool_auth", repo_id]` | signer only; owns the pool vault (its $UNITS ATA) and one ATA per member mint (buybacks); the buyer inside every venue call |
| `PoolMember` | `["pool_member", agent]` | pool, agent, mint, index, contributed, cross due and funded, payout / buyback / burn due, totals paid, bought, held, burned |
| `CrossHolding` | `["cross", holder, target]` | one per ordered pair: $UNITS spent, tokens (delivered to the holder agent's own token account) |

Instructions: `set_features` and `set_pool_config` (launch admin), `join_pool`, the pool slice
inside `crank_pump_fees`, `pool_settle` (keeper), `pool_pay` (anyone), `pool_buy` (keeper; kinds
cross, buyback, burn). `LaunchConfig.reserved` (always zero) becomes `features` (1 byte) plus 15
reserved bytes and `AgentLaunch.reserved` becomes `routes` (1 byte) plus 31: same sizes, same
bytes, no migration. `crank_pump_fees` keeps its eight accounts; an agent with a route or a
membership needs trailing accounts, an agent without neither does not, so existing clients keep
working for every agent that did not opt in.

Test values: `pool_fee_bps` 2000, `payout_bps` 4000, `buyback_bps` 4000, `burn_bps` 2000,
`author_buyback_bps` 2000, `buyback_per_gen_bps` 2500, `burn_per_milestone_bps` 5000,
`cross_hold_quote` 0.5 UNITS, `max_buy_quote` 1,000 UNITS, `max_members` 8 (program maximum 16).

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

## 8. Shared liquidity pair and repo index (research, read 2026-10-11; not shipped)

Both are feasible. Neither is built: each needs an owner decision first (Q8, Q9).

**A shared A/B pair between two graduated member tokens.** A pool between two arbitrary mints can
be created without permission on all three venues. pump.fun `create_v2` coins are Token-2022 mints
carrying only the metadata pointer and token metadata extensions, with no mint or freeze authority
(read on mainnet for one coin and its quote).

| Venue | A/B pool without permission | Takes a pump.fun Token-2022 coin | A PDA can own the liquidity | On devnet | Cost to create |
|---|---|---|---|---|---|
| PumpSwap | yes, any index and creator (IDL `create_pool`, pump-public-docs `2293f9a`; `create_pool` simulated on mainnet with a pump coin as base and its pump-coin quote, index 0 and 1) | yes (simulated) | by design (LP tokens go to the creator's ATA); a CPI from our program NOT CONFIRMED | yes, same id | rent only (about 0.0077 SOL derived from account sizes, not measured) |
| Meteora DAMM v2 | yes, `initialize_customizable_pool` (damm-v2 `a85c926`) | yes by source (metadata pointer, token metadata and transfer fee are allowed), not simulated | yes (the creator is an unchecked account that receives the position NFT) | yes, same id | rent only; no figure confirmed |
| Raydium CPMM | yes | yes by source (extension allowlist), not simulated | yes | yes, at another id (`DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`) | 0.15 SOL fee plus rent (docs.raydium.io fee comparison; api-v3 `cpmm-config`) |

Sources: github.com/pump-fun/pump-public-docs (`idl/pump_amm.json`, `PUMP_SWAP_README.md`,
`PUMP_SWAP_CREATOR_FEE_README.md`, `FEE_PROGRAM_README.md`); github.com/MeteoraAg/damm-v2 (README,
`ix_initialize_customizable_pool.rs`, `utils/token.rs`); github.com/raydium-io/raydium-cp-swap
(`initialize.rs`, `utils/token.rs`, `lib.rs`); developers.jup.ag/docs/routing/market-listing.

What speaks against it: both legs are volatile and uncorrelated, so the vault takes impermanent
loss whenever A and B diverge; each token's deep venue stays its $UNITS pool, so arbitrage reprices
the thin A/B pool at the vault's expense; a non-canonical PumpSwap pool pays the agents no creator
fee (`OnlyCanonicalPumpPoolsCanHaveCoinCreator`), so A/B volume funds no compute; Jupiter lists all
three venues but drops a pool that fails its liquidity test (a 500 USD round trip under 30% loss),
which a small vault-seeded pool will. Recommendation if the owner wants it anyway: PumpSwap
(same program id on devnet, already vendored in the test suite, no creation fee), first step a
fork test of `create_pool` and `withdraw` by CPI from the pool authority; Meteora DAMM v2 if the
position must be locked or its fees claimed without withdrawing.

**A repository index (buy every member in one action).** Measured with this repository's own
builders, one lookup table per pool, two compute budget instructions: eight curve buys paid in
$UNITS are 973 bytes (1,085 with eight token account creations) and 52 account locks (the limit is
64); eight PumpSwap buys 965 bytes; ten fit only without account creations; twelve do not fit.
Compute, from the single-instruction measurements in `scripts/mainnet/PUMP-FORK-LAST.json` (batches
not measured): eight curve buys about 646,880 CU, eight pool buys about 455,192 CU. Paying in SOL
through `multi_hop_swap` fits seven on-curve members by compute. So an index of up to eight members
is one v0 transaction in $UNITS; beyond that a Jito bundle (mainnet only, at most five
transactions). It is a client feature (a button on the pool page), no program change.

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
- Q8. Build the shared A/B pair (section 8)? As researched it costs the vault impermanent loss and
  earns the agents no creator fee; the lane recommends not building it.
- Q9. Build the repository index button (section 8)? No program change; needs a pool page.
- Q10. Cross-holdings sit in the agents' own token accounts (owner decision 2026-10-12). Nothing on
  chain stops the agent key from moving them; today only the firewall does (it signs no swap and no
  transfer of them). If they must be locked on chain, keep them with the pool authority instead
  (one line in `pool_cross_buy`).

## 10. Results (2026-10-12)

- **Program.** `units_launch` `src/pool.rs` (723 lines) and the pool slice in `crank_pump_fees`.
  LiteSVM against mainnet's Pump and PumpSwap builds: 7 pool tests (`onchain/tests/tests/pools.rs`),
  all red on the pre-change build and green on the new one; the whole suite 84/84; clippy clean for
  the programs. Build: 958,368 bytes (was 685,224), sha256 `79609057...9ac2`, kept in
  `onchain/target/pools` (the default output still holds the pre-pools build the mainnet test lane
  uses; `UNITS_LAUNCH_SO=target/pools/units_launch.so cargo test`).
- **Devnet.** Upgraded in place with the bits off (onchain/DEVNET.md "Pools and claims"), dump equals
  the build. `scripts/pools/devnet-proof.ts` PASS 67/67 (`scripts/pools/DEVNET-PROOF-LAST.json`),
  bits on for the run and off again after it: two TEST agents launched on one repository URL, both
  joined by their owner (pool `6ESVeSW4...XoXc1`), each crank's four amounts exact (for example fees
  65.185186 UNITS: compute 27.377778, protocol 19.555556, GitHub 9.125926, pool 9.125926), each
  slice funding its cross-holding first, one settlement (TEST inputs: one generation credited to A,
  one milestone; these agents never authored) whose allocation equals the offchain recomputation
  (A: payout 6.568888, buyback 0.328444, burn 0.821111; B: buyback 1.313778, burn 0.821111), then
  the staging Core's own keeper: the payout into A's compute vault, both cross-holdings delivered
  to the holder agents' own token accounts, buybacks held by the pool, milestone burns that lowered
  both supplies by exactly the tokens burned, and vault balance = buckets + dues afterwards. With
  the bits off again the eight-account crank paid today's two amounts to the unit.
- **Mainnet fork.** `scripts/pools/fork-rehearsal.ts` PASS 28/28 (`FORK-REHEARSAL-LAST.json`): the
  mainnet-id build beside mainnet's own pump.fun builds, auto-join by the keeper, every new
  instruction with its cost at mainnet rent, compute units and size: `join_pool` 0.007238920 SOL for
  the first member (pool, vault and member accounts) and 0.001645840 for the next, `pool_settle`
  33,223 CU, `pool_pay` 38,472 CU, `pool_cross_buy` 0.001142920 SOL and up to 145,122 CU in 759
  bytes, `pool_buy` up to 126,119 CU in 660 bytes, a routed crank 937 bytes and up to 213,724 CU.
- **Core.** `packages/core/src/pools.ts`: 4 tests (flag off changes nothing; target claims among
  members; the settlement record with weights and milestones; the allocation). Not yet exercised on
  real authored work: no pool on devnet has members that author, so the keeper's own settlement
  (from Core's records) ran only in the simulated-mode test; the devnet settlement used TEST inputs.
- **Not built.** A pool page in the app (the profile chip and the wizard opt-in exist); a worker
  change to re-plan on `409 pool_target_claimed` (today the worker treats a refused intent as
  advisory and may still author on that target); `scripts/pools/verify-settlement.ts`; leaving a
  pool; the shared pair and the index (section 8).
- **Left on devnet.** Ten TEST agents from five proof runs (two runs stopped early), all
  self-hosted and asleep, names "TEST pool proof A/B <run>"; they show on the public Explorer until
  hidden (their mints are in the lane's report). `PoolConfig` and `ClaimConfig` exist with TEST
  values; `LaunchConfig.features` is 0.
