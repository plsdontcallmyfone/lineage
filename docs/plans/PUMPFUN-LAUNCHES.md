# Agent token launches on pump.fun (research and plan)

Written 2026-10-10 as research and spec. The owner decided the open questions the same day; section 12
records those decisions and what the pump.fun launches lane built and proved (sections 1 to 11 are the
research as written; where they recommend Meteora as a fallback, section 12 supersedes them).
Owner request (2026-10-10): "for token launches, can we use pump.fun actually ... they allow for any
token to be paired with each other." $LINE itself launches on pump.fun.

Every fact below names its source and the date it was read. Chain reads were made on 2026-10-10
between 18:59 and 19:12 UTC against the public endpoints `https://api.mainnet-beta.solana.com` and
`https://api.devnet.solana.com` (read only, nothing signed). The scratch scripts that did the reads
are not part of the repo; every account address is given so anyone can repeat them.

## 1. Answer in one paragraph

Feasible, with one hard condition and several things we lose. pump.fun's program has supported
"Custom Pairs" since its 2026-10-08 release: `create_v2` can create a coin whose bonding curve is
quoted in an existing pump.fun coin. So once $LINE exists as a SOL- or USDC-paired pump.fun coin
(not mayhem mode), every agent token can launch on pump.fun quoted in $LINE. The call is
permissionless, `creator` is any non-zero address we pass (so a PDA of `lineage_launch` works), and
creator fees are paid in the quote asset ($LINE) by permissionless sweep and collect instructions.
So compute funding (creator fees to the compute vault) keeps working. Prepaid credits, bounties,
sleep and wake, the registry and the hidden list do not depend on the venue. What we lose: our own
curve, fee, supply and graduation parameters (pump.fun's are fixed and set by pump.fun); the LP fees
of the graduated pool (the LP is burned and pump.fun takes the protocol fee); a creator fee that
pump.fun cannot change (pump.fun's admins can change rates and reassign creators through a community
takeover); and devnet tLINE minted by our faucet (a pump.fun quote must be a pump.fun coin, whose
mint authority is revoked). The hard condition: pump.fun's `Global.max_curve_depth` must stay at 1
or more. Its admin can set it to 0, which turns the pump-coin-as-quote path off for new launches.
For that reason we recommend keeping Meteora DBC in the program as a fallback venue.

## 2. Decisions the owner must make

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Venue for mainnet agent launches | (a) pump.fun only; (b) pump.fun primary, Meteora DBC kept as an admin-switchable fallback; (c) stay on Meteora | (b). pump.fun can turn the path off (`max_curve_depth = 0`, section 4.1) and Meteora is already built, audited internally and rehearsed on a mainnet fork |
| D2 | How `lineage_launch` attaches to pump.fun | (a) the launch instruction CPIs into pump `create_v2`; (b) the launcher's transaction calls pump `create_v2` at the top level, then `lineage_launch::register_pump_launch` reads and checks the new bonding curve in the same transaction (no CPI into pump) | (b). pump.fun has changed its account lists often (v2 trades, then v3 trades, then new remaining accounts within weeks), and (b) depends only on the `BondingCurve` layout, whose new fields are appended. (a) is a fallback if (b) proves exploitable on the fork |
| D3 | $LINE launch shape | SOL-paired or USDC-paired; never mayhem mode; Creator Fee Sharing or a single creator | SOL- or USDC-paired, not mayhem (a mayhem coin cannot be a quote, section 4.1). The $LINE creator fee question is separate (section 6.9) |
| D4 | Creator fee rate on agent coins | (a) pass `creator_fee_bps = 0` (pump.fun's flat custom-pair schedule); (b) pass a rate from 1 to `Global.max_configurable_creator_fee_bps` (300 today) | Decide after reading section 4.2: the program and a live trade say (b) works today; pump.fun's Fees Page says the custom-pair creator fee is fixed and not set by the creator. Build (a) as the default, make the value an admin-editable `LaunchConfig` field, and do not show any rate in the UI that was not read from chain |
| D5 | Devnet tLINE | (a) launch a new devnet tLINE as a pump.fun coin on devnet and fund the faucet by buying it on its curve with devnet SOL; (b) keep the current devnet tLINE and Meteora on devnet, test pump.fun only on a mainnet fork | (b) for now, plus a mainnet-fork rehearsal; (a) only if the owner wants the live devnet site on pump.fun |
| D6 | Audit timing | Make the program change before the external audit engagement, or audit the current commit and add pump.fun as a later change | Before. Any program change regenerates `docs/audit/SCOPE.md` (section 9) |
| D7 | Accept pump.fun's governance and terms risk | CTO powers, fee changes, Terms of Use sections 6.1, 21(h), 21(t) (section 4.6) | Owner and legal review (already a go/no-go item in docs/MAINNET-RUNBOOK.md) |

## 3. Sources

| Source | What it is | Read |
|---|---|---|
| `https://github.com/pump-fun/pump-public-docs` at commit `2293f9a` (2026-10-08 22:32 +0400), previous `8cda1fa` (2026-10-08 00:11 +0400, "pump coins as quote mints, fee sweeps, synthetic migration") | pump.fun's official integration docs and IDLs (`idl/pump.json`, `idl/pump_amm.json`, `idl/pump_fees.json`) | cloned 2026-10-10 |
| `docs/instructions/CREATE_WITH_PUMP_COIN_QUOTE.md`, `COIN_CREATION.md`, `SWEEP_FEES.md`, `COLLECT_CREATOR_FEE.md`, `CREATOR_FEE_SHARING.md`, `TRADE_V3.md`, `MULTI_HOP_SWAP.md`, `SYNTHETIC_MIGRATION.md`, `CPI_README.md`, `PUMP_PROGRAM_README.md`, `PUMP_SWAP_README.md`, `HOLDER_REWARDS_README.md` in that repo | instruction pages | 2026-10-10 |
| `https://x.com/Pumpfun/status/2108265460697624755` (posted 2026-10-08T18:37:10Z): "Recently, we introduced Custom Pairs, allowing you to launch coins paired with tokenized stocks, whitelisted coins, etc. Now, you can pair new tokens with ANY coin that was launched on pump fun" | official announcement; text read through X's public syndication endpoint | 2026-10-10 (also relayed by the coordinator) |
| `https://pump.fun/docs/fees` ("Last Updated: 08 October 2026") | the Fees Page, part of the Terms of Use | 2026-10-10 |
| `https://pump.fun/docs/custom-pairs` ("Last updated: October 9, 2026") | Supported Pair Assets list and the rules for "Secondary Pair Assets" | 2026-10-10 |
| `https://pump.fun/docs/terms-and-conditions` ("Last Updated: 08 October 2026") | Terms of Use | 2026-10-10 |
| `https://pump.fun/docs/tokenized-agent-disclaimer` | pump.fun's own "Tokenized Agent" buyback setting | 2026-10-10 |
| Mainnet and devnet accounts named in section 4 | live program state | 2026-10-10, 18:59 to 19:12 UTC |
| `https://lite-api.jup.ag/swap/v1/quote` | Jupiter routes for a few custom-pair coins | 2026-10-10, 19:10 UTC |

Program ids (from the docs and the IDLs): Pump `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`,
PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, Pump Fees `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`,
Mayhem `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` (an account of every `create_v2`).

## 4. Findings

### 4.1 Creating a coin quoted in another pump.fun coin (question 1)

- **Instruction.** Pump `create_v2(name, symbol, uri, creator, is_mayhem_mode, is_cashback_enabled,
  creator_fee_bps, is_holder_reward)`, 16 fixed accounts (`mint` signer, `mint_authority`,
  `bonding_curve`, `associated_bonding_curve`, `global`, `user` signer and payer, system, Token-2022,
  ATA program, the Mayhem program and three Mayhem PDAs, `event_authority`, `program`). For a pump
  coin Q as the quote, remaining accounts in order: `quote_mint` (Q), `associated_quote_bonding_curve`
  (ATA of Q owned by the new curve, created and paid by `user`), `quote_token_program`, `quote_control`
  (`6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP`), Q's `bonding_curve`, and, only if Q has migrated,
  Q's PumpSwap pool and its two vaults. Source: `CREATE_WITH_PUMP_COIN_QUOTE.md`, `COIN_CREATION.md`,
  `idl/pump.json` instruction docs.
- **Which coins can be the quote.** Q must itself be quoted in SOL, USDC or a listed quote mint
  (depth 0); a coin quoted in a pump coin cannot be a quote (`CurveDepthExceeded`, 6105); Q must not
  be mayhem mode (`QuoteBondingCurveNotEligible`, 6100); while Q's curve is complete but not yet
  migrated, creation fails (`QuoteCurveAwaitingMigration`, 6107). The new coin cannot be mayhem mode.
  Same rules on the Custom Pairs page ("One hop only", "Eligibility is fixed at launch").
- **Allowlist.** There is no allowlist of pump coins: any eligible pump coin works without listing.
  Separately, `Global.whitelisted_quote_mints` (mainnet: USDC only) and the `quote_control` account
  (mainnet: 200 listed mints, e.g. xStocks) admit non-pump quotes. The pump-coin path is gated by
  `Global.max_curve_depth` ("0 disables the path, 1 admits children of depth-0 coins only, up to 5
  planned", `idl/pump.json`). **Mainnet value read 2026-10-10: 1.**
- **Permissionless, and CPI.** No signer other than `mint` and `user`; `creator` is an argument, "Must
  not be `Pubkey::default()`", and need not sign (`PUMP_PROGRAM_README.md`: "`creator` pubkey is not
  required to be a signer"). `CPI_README.md` says to CPI into "any pump instruction" with
  `pump_rust_client` and `declare_program!(pump)`. I found no rule against creation by CPI, but every
  one of the 128 `create_v2` calls I decoded (300 most recent signatures on `quote_control`, 2026-10-10)
  was a top-level instruction, so creation by CPI is **not observed**; it must be proven on a fork.
- **Live use.** `getProgramAccounts` on Pump with `BondingCurve.depth == 1` returned **4,726** curves
  on mainnet, **62** of them complete (2026-10-10). Example: `EWsPDSLAEXfphXpAbPWbbiaPkneEhQSuVQy24tVqRHvZ`
  quoted in `75Lf77bdKGW2p6hxB8cWM2mxWzsnTUZMVjSBY1ycpump`, created 2026-10-10T18:31:00Z.
- **Curve parameters are not ours.** Supply and decimals come from `Global`: `token_total_supply`
  1,000,000,000,000,000 base units at 6 decimals (1 billion tokens), `initial_real_token_reserves`
  793,100,000,000,000 (mainnet, read 2026-10-10). The starting virtual quote reserves of a pump-coin
  pair are derived at creation from Q's live reserves: "take the amount a normal launch raises by the
  time its curve sells out (about 85 SOL for a SOL launch). Buy Q with that amount on Q's own curve or
  pool, with no fees. The Q tokens that buy returns are what the new coin will raise"
  (`CREATE_WITH_PUMP_COIN_QUOTE.md`). So the $LINE needed to graduate an agent coin changes with
  $LINE's price at the moment that coin launches, and we cannot set it.
- **Token program.** Agent mints are Token-2022 with `metadataPointer` and `tokenMetadata` only, mint
  and freeze authority none (read on `75Lf77...pump`). That matches the registry's `$LINE` mint
  allowlist (SPEC 14.5) if $LINE is a pump coin. The "pump" address suffix is not required on chain:
  several decoded depth-1 mints do not end in it (e.g. `EWsPDS...RHvZ`).
- **Metadata.** `name` at most 32 characters, `symbol` at most 13, `uri` at most 200
  (`COIN_CREATION.md`). Any URI is accepted on chain; pump.fun's own IPFS upload service is not in its
  official docs, so **not confirmed** as an API we may use. We keep our own metadata host.
- **Cost.** Fees Page: "Create a coin: No platform fee, for any pairing. You pay only the Solana
  network transaction fee and the small SOL deposit the network requires to create the token's
  on-chain accounts." The rent of a pump launch is **not measured** (fork step F3).

### 4.2 Creator fees (question 2)

- **Who receives them.** `BondingCurve.creator`, set from the `creator` argument. It can be any
  address, including a PDA we own. Fees accrue per creator, not per coin: the Pump vault is the PDA
  `["creator-vault", creator]` and the PumpSwap vault authority is `["creator_vault", coin_creator]`
  (`SWEEP_FEES.md`, `COLLECT_CREATOR_FEE.md`). One shared creator for all agents would mix every
  agent's fees, so each agent needs its own creator PDA.
- **Asset.** Fees Page: "Every fee is collected in the quote asset of the pool on which it is
  charged, never in the coin being traded." So agent coins pay creator fees in $LINE.
- **Claiming, all permissionless.** The new trades (`buy_v3`, `sell_v3`, PumpSwap `buy_v2`/`sell_v2`,
  `multi_hop_swap`) keep the creator fee on the curve or pool. Pump `sweep_creator_fee` moves it to the
  creator vault, then `collect_creator_fee_v2` moves the vault's quote tokens to the canonical ATA of
  `(creator, quote_mint)`. After migration: PumpSwap `sweep_creator_fee`, then `collect_coin_creator_fee`
  to a quote token account owned by `coin_creator`. No creator signature is needed for any of them;
  `creator` "must not be executable" and must not be owned by the Pump Fees program (a PDA with no
  data satisfies both). Older trade instructions still pay per trade into the same vault.
- **Fee sharing.** Pump Fees `create_fee_sharing_config` / `update_fee_shares_v2` (at most 10
  shareholders, shares sum to 10,000 bps, settable once) also works with non-SOL quotes. We do not need
  it: our program already splits fees (`agent_compute_bps`, `protocol_bps`), and `create_fee_sharing_config`
  needs the creator to sign and pay for a 1,024-byte account.
- **Rates.** Fees Page (2026-10-08): custom-pair coins pay a flat schedule, "Bonding curve 0.30%
  creator, 0.95% protocol, 0% LP, 1.25% total; PumpSwap canonical pool 0.05% creator, 0.05% protocol,
  0.20% LP, 0.30% total", and "The Creator fee on a Custom Pair coin is fixed and is not set by the
  creator", except that a Holder Rewards coin sets a flat holder rate from 0.01% to a platform maximum
  (3% at the time of writing). On chain (2026-10-10): `Global.creator_fee_configurable = true`,
  `max_configurable_creator_fee_bps = 300`; the IDL says `creator_fee_bps` sets "the coin's own creator
  fee rate for a quote mint admitted through quote-control or through a pump coin's curve". A live
  trade on `EWsPDS...RHvZ` (not a holder rewards coin, `creator_fee_bps = 150`), signature prefix
  `2UwYwMcgm4xnNeporqw9`, 2026-10-10T18:41:30Z, emitted `fee_basis_points 95`, `creator_fee_basis_points
  150`, `buyback_fee_basis_points 5000` (half of the protocol fee goes to a buyback recipient in the
  trade). **Conflict:** the program accepts a creator-set rate today; the Fees Page says it does not.
  The Fees Page governs (Terms 1.5) and pump.fun may change it with notice (Terms 14.1: at least 14
  days for a fee increase). Decision D4.
- **Fee tiers.** The Pump Fees `fee_config` for Pump (`8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`)
  read 2026-10-10: one tier, protocol 95, creator 30, LP 0 bps; `exotic_flat_fees` the same. For
  PumpSwap (`5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`): 25 SOL tiers, and `exotic_flat_fees` LP 20,
  protocol 5, creator 5 bps, matching the Fees Page's custom-pair row.
- **Who can change a creator.** Pump `admin_cto` (signer `Global.admin_set_creator_authority`) and
  `set_creator` (signer `Global.set_creator_authority`), PumpSwap `admin_cto_pool`. Terms 4.6: "CTOs
  are handled in the sole discretion of the Pump Entities". So the fee route to our PDA is locked
  against the launcher, not against pump.fun.

### 4.3 Graduation (question 3)

- A curve completes when its real tokens are sold out; `migrate`/`migrate_v2` are permissionless
  ("anyone can migrate a completed bonding curve", `PUMP_PROGRAM_README.md`) and create the canonical
  PumpSwap pool (index 0, creator = Pump's `["pool-authority", mint]` PDA). "The LP tokens received
  from the PumpSwap pool are then burnt." For three migrated depth-1 coins (pools
  `GrDRreeHzWDzcLwcLBs2Ti3DyFvU1ATbafAGKikPuznL`, `6C9jr1DbHQVzndzmUQeQpfb61Y9ia361MkbNmMWdburW`,
  `C3xopt4mxge1p16GKhzv2YqeU6q6CSg73eUuxroX9wZg`, migrated 2026-10-08 and 2026-10-09) the LP mint
  supply read 2026-10-10 is 0, and each pool's `quote_mint` is the pump coin.
- Migration fee: Fees Page, "0.015 SOL, for every coin regardless of the asset it is paired with ...
  for a coin paired with another asset it is paid in SOL by the account that performs the migration
  (normally pump.fun), unless a user's trade triggers the migration". No migration fee is taken from a
  token-paired coin's raised quote (`SYNTHETIC_MIGRATION.md`).
- Synthetic migration: with v3 buys, the buy that empties the curve can continue at the future
  pool's price, and the pool opens there (`SYNTHETIC_MIGRATION.md`).
- Creator fees after migration: `Pool.coin_creator` and `Pool.creator_fee_bps` carry over from the
  curve (`PUMP_SWAP_README.md`); fees left on the curve stay sweepable after migration
  (`SWEEP_FEES.md`). That `coin_creator` equals our PDA after a real migration is **not yet observed**
  for a PDA creator (fork step F5).
- The graduation threshold is not ours to set (section 4.1).

### 4.4 Trading (question 4)

- Curve: `buy_v3`, `buy_exact_quote_in_v3`, `sell_v3` (17 accounts) with `quote_mint` = $LINE; the
  user needs a $LINE token account; the buyback recipient's $LINE ATA must exist (anyone can create it
  first). PumpSwap: `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2` (`TRADE_V3.md`, `PUMP_SWAP_TRADE_V2.md`).
- SOL in one instruction: PumpSwap `multi_hop_swap` routes SOL to $LINE (its curve or pool) to the
  agent coin (curve or pool), with no $LINE account for the user; protocol fee charged once on the
  first hop, creator and LP fee once on the last hop (`MULTI_HOP_SWAP.md`). Fees Page warns that
  interfaces on older instructions "may charge Protocol, Creator and LP fees on every pool in the route".
- Jupiter (keyless quotes, 2026-10-10 19:10 UTC): a graduated pump-coin pair routed SOL to coin through
  two "Pump.fun Amm" hops (`9XF7h7vy469ufzky9Wt4LpU1TxW8VmVxwu3i6vVfpump`); curve-stage custom pairs
  routed for two coins (label "Pump.fun") and returned "No routes found" for two others
  (`EWsPDS...RHvZ`, `4ZZCbgJWkySEuLUfXhNzJiSMnEHybi41AjZ1miXFpump`). So Jupiter coverage of new agent
  coins on the curve is **not reliable**; our own instructions are.

### 4.5 Devnet (question 5)

- Pump, PumpSwap and Pump Fees are deployed on devnet at the mainnet ids (docs, and read 2026-10-10).
  The PumpSwap binary is byte-identical to mainnet (sha256 of the trimmed ELF `3ffd5e3b5a31ccc8...`);
  the Pump binary differs (devnet 1,896,745 bytes, mainnet 1,891,785 bytes), both contain the
  custom-pair error strings (`CurveDepthExceeded`, `QuoteCurveAwaitingMigration`,
  `CreatorFeeNotConfigurableForQuote`).
- Devnet `Global` (2026-10-10): `create_v2_enabled true`, `max_curve_depth 1`,
  `creator_fee_configurable false` (so `creator_fee_bps` must be 0 there), `quote_control` empty,
  whitelisted quote `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. So a devnet tLINE created with
  `create_v2` and SOL quote should be usable as a quote for devnet agent coins. **Not tried.**
- Because the devnet Pump binary is not mainnet's, the authoritative test is a mainnet fork as in the
  M1 rehearsal (section 8).

### 4.6 Terms, KYC, limits (question 6)

- No KYC or allowlist on chain for creating or trading. Terms 2.1 eligibility and the Prohibited
  Jurisdiction list (Section 32) apply to users of the "Pump Platform" and "Pump Services".
- Terms 6.1: "You may access the Pump Platform and Pump Services through such automated means
  (including bots) as we expressly permit from time to time"; 21(h) prohibits bots and scripts "to
  access, obtain, copy or monitor any part of the Pump Platform and/or Pump Services". Terms 4.2
  contemplates access "via a separate third-party interface". Whether direct program calls by a third
  party platform count as "Pump Services" access under 6.1 and 21(h) is a legal question; **not
  confirmed either way.**
- Terms 21(t) prohibits using the platform "in connection with any capital raise, pooled investment
  scheme, profit-sharing arrangement, revenue participation right ... or any other activity intended
  to represent an ownership, creditor, or investment interest in an ongoing business or enterprise".
  Agent token fees fund the agent's own compute, not holders; legal review should still read it.
- Rate limits: none on chain. We would not use pump.fun's web API.
- pump.fun lists coins on its own site from chain data; whether coins created through a third-party
  transaction appear there is **not confirmed**. Our hidden list cannot hide anything on pump.fun.
- Adjacent product, not used: pump.fun's "Tokenized Agent" setting (hourly buyback and burn by a
  pump.fun-controlled authority, `tokenized-agent-disclaimer`).

## 5. What pump.fun does not give us that we rely on today

| We rely on (Meteora, SPEC 14.2) | On pump.fun | Options |
|---|---|---|
| Admin-chosen curve, fee, supply, decimals, graduation threshold (`LaunchConfig` and the DBC config; launch values TBA) | Fixed by pump.fun's `Global`; graduation raise in $LINE derived from $LINE's price at each launch | Accept, or keep Meteora (D1) |
| All trading fees on the curve to our authority (TEST curve: flat 3% in the quote token, `standardDbcParams`) | Creator share only: 0.30% on the curve and 0.05% on the pool per the Fees Page (or a creator-set rate, D4); protocol fee to pump.fun | Accept a lower compute funding rate per unit of volume, or D4 (b) |
| After graduation the locked DAMM v2 position's fees (`crank_pool_fees`, 100% of LP locked to us) | LP burned; LP fee stays in the pool; we get only the creator fee | Accept |
| Fee route fixed by our program | pump.fun admins can reassign the creator (CTO) and change rates (Terms 14.1) | Monitor `creator` and rates in the indexer and alert; keep the fallback venue |
| Devnet tLINE minted by our faucet | Quote must be a pump coin (mint authority revoked) | D5 |
| Launch fits one transaction at 1,232 bytes (SPEC 14.5) | More accounts (16 fixed plus 5 to 8 quote accounts) | v0 with a lookup table, already built for prepay (plan C) |
| Graduation proof bound to the migration position (`graduate`, `repoint_position`, `graduate_by_admin`) | Not needed: no position to hold | Record graduation by reading `BondingCurve.complete` and the canonical pool |
| A venue that cannot switch off | `max_curve_depth = 0` disables new pump-coin pairs | Fallback (D1 b) |

## 6. Design

### 6.1 Launch (D2 option b, recommended)

One launcher transaction (v0 with the existing lookup table when it does not fit legacy):

1. compute budget;
2. Pump `create_v2` at the top level: `user` = launcher, `mint` = fresh keypair, `creator` =
   `pump_creator` PDA `["pump_creator", agent]` of `lineage_launch`, `is_mayhem_mode = false`,
   `is_cashback_enabled` omitted, `creator_fee_bps` = `LaunchConfig.pump_creator_fee_bps` (0 by
   default; must be 0 on devnet), `is_holder_reward = false`, remaining accounts for quote $LINE;
3. `lineage_launch::register_pump_launch(args)`: the agent key co-signs as today. The program checks
   the `bonding_curve` account: owner Pump, address = Pump PDA `["bonding-curve", mint]`, `quote_mint`
   = `LaunchConfig.line_mint`, `creator` = our `pump_creator` PDA for this agent, `is_mayhem_mode`,
   `is_cashback_coin`, `is_holder_reward` all false, `depth` 1, `complete` false, `creator_fee_bps`
   equal to the configured value, `real_quote_reserves` 0 (no trade has happened yet, so the record is
   made in the creation transaction). Then it creates the compute vault, the launch record and the
   registry `register_launched` CPI exactly as `launch_agent` does today;
4. the prepay deposit and `refresh_awake` (unchanged), the optional soul `set_profile` (unchanged).

Reading the curve instead of CPI-ing into pump means a pump.fun change to `create_v2`'s accounts
changes only the client builder, not the audited program. The fields read are fixed by
`idl/pump.json` and are appended-only ("read the missing trailing fields as 0").

Option (a), CPI into `create_v2`, puts Pump at stack height 2 and its Token-2022 and ATA calls at 3
and 4; that fits Solana's limit but must be measured on the fork, and ties the program to Pump's
account list.

### 6.2 Compute funding (creator fees to the compute vault)

New `crank_pump_fees` (anyone): before it, the keeper puts the permissionless pump calls in the same
transaction (Pump `sweep_creator_fee` and `collect_creator_fee_v2`; after migration also PumpSwap
`sweep_creator_fee` and `collect_coin_creator_fee`). They land $LINE in the `pump_creator` PDA's $LINE
ATA. `crank_pump_fees` moves that whole balance, signed by the `pump_creator` PDA, through the existing
`split_fees` path: `floor(fees x agent_compute_bps / 10,000)` to the compute vault, the rest to the
registry treasury, updating `fees_claimed`, `to_compute`, `to_protocol`, then `awake`. Our program never
calls pump in this path, so pump.fun account changes do not reach the program. $LINE anyone sends to
that ATA is treated as fees (a donation).

### 6.3 Records and config

- `LaunchConfig` gains `venue_default` (0 Meteora, 1 pump.fun), `pump_enabled`,
  `pump_creator_fee_bps`, all admin-editable through the Squads path (docs/MAINNET-RUNBOOK.md).
  `set_launch_config` grows; a `migrate_launch_config` step grows the account as before.
- `AgentLaunch` gains `venue`, `pump_bonding_curve`, `pump_pool` (set when graduation is recorded).
  The Meteora fields stay for Meteora launches. Either append to `AgentLaunch` with a migration, or add
  a separate `PumpLaunch` PDA; the choice belongs to the implementing lane, with a LiteSVM test either way.
- New `record_pump_graduation` (anyone): the curve is `complete` and the canonical PumpSwap pool exists
  with `base_mint` = the agent mint and `quote_mint` = $LINE; sets `graduated`, stores the pool.

### 6.4 Prepaid credits, bounties, sleep and wake, registry

Unchanged. They read and move $LINE in our compute vaults and never touch the venue.

### 6.5 Trading (users and agents)

- `packages/chain`: new `pump.ts` (builders for `create_v2` with the pump-coin quote accounts, `buy_v3`,
  `buy_exact_quote_in_v3`, `sell_v3`, PumpSwap `buy_v2`/`sell_v2`, `multi_hop_swap`, the four sweeps,
  the two collects; decoders for `Global`, `BondingCurve`, `Pool`, the `fee_config` accounts; quote
  math including the synthetic migration formula and signed `virtual_quote_reserves`), with tests
  against recorded mainnet accounts, as `meteora.ts` has today.
- `packages/trader` (`venue.ts`, `chain-venue.ts`, `policy.ts`, `analyst.ts`, `glue.ts`): a pump venue
  next to the DBC and DAMM v2 venues, chosen from the launch record. Agents hold $LINE, so they trade
  the curve or pool directly in $LINE.
- `apps/web/wallet/trade.ts` and the token page: pump instructions; paying in SOL uses
  `multi_hop_swap` (SOL to $LINE to the agent coin in one instruction) instead of Jupiter, since
  Jupiter does not route every new coin (section 4.4); USDC keeps the Jupiter swap to $LINE (SPEC 14.9),
  then `buy_exact_quote_in_v3`.

### 6.6 Indexer (`packages/indexer`)

Decode Pump `TradeEvent` (with `quote_mint`, `quote_amount`, `creator_fee`, `buyback_fee`),
`CompleteEvent`, `PostCompleteBuyEvent` (a completing buy's total is the `TradeEvent` plus this
event), `SweepBondingCurveFeeEvent`, and PumpSwap `BuyEvent`/`SellEvent`/`SweepPoolFeeEvent`, only for
mints that have a launch record. Fee income is counted at the trade event, payouts at sweep events,
never both (`SWEEP_FEES.md`). Pools are priced on effective quote reserves, `pool_quote_token_account
+ virtual_quote_reserves` as a signed value. New check: alert when a launch's `BondingCurve.creator`
or `Pool.coin_creator` stops being our PDA, or when `max_curve_depth` or the fee configs change.

### 6.7 Launch wizard (`apps/web`, `/launch`)

Same six steps. Changes: symbol limit 13 on pump (our program's limit stays the binding one, 10,
unless changed), the creator fee rate shown only as read from chain, the venue read from
`LaunchConfig`, and the curve explanation from `Global` values read live. No new fields for the
launcher.

### 6.8 Hidden list

Unchanged for our site and Core (SPEC 17.5 hidden filter). It cannot hide coins on pump.fun's own
site or other indexers, so mainnet test launches on pump.fun are public by nature; mainnet tests should
be done on the fork.

### 6.9 $LINE itself

$LINE launches on pump.fun (owner). For agent launches it must be SOL- or USDC-paired and not
mayhem (D3). $LINE's own creator fees are paid in its quote (SOL or USDC), not in $LINE, while the
registry vaults hold only $LINE (SPEC 14.1 "SOL is not held"); SPEC 14.1 already plans Creator Fee
Sharing for $LINE, whose open questions (a program PDA as shareholder, the shareholder cap) remain and
are tested in the same fork run. Between $LINE's curve completing and its migration, agent launches
fail with `QuoteCurveAwaitingMigration`; the wizard shows that state and retries.

### 6.10 Meteora as fallback

Keep `launch_agent`, `crank_fees`, `graduate*`, `repoint_position`, `crank_pool_fees` and their tests.
The venue for new launches is `LaunchConfig.venue_default`, so moving between venues is one config
change through the multisig. Existing Meteora launches keep working whatever the default. Cost of the
fallback: a larger audit scope (both venues stay in it).

## 7. Migration plan

1. **P1, client and fork proof without program change.** `packages/chain/src/pump.ts` with decoders
   and builders; a mainnet fork (`scripts/mainnet/fork.sh` pattern) cloning Pump, PumpSwap, Pump Fees,
   the Mayhem program and their global, fee, quote-control and event accounts; a stand-in $LINE created
   on the fork with `create_v2` (SOL-paired); create agent coins quoted in it with a PDA `creator`,
   trade, sweep and collect into the PDA's ATA, complete the curve, migrate, sweep the pool, collect.
   This answers every "not confirmed" item before any program change.
2. **P2, program change.** `register_pump_launch`, `crank_pump_fees`, `record_pump_graduation`,
   config and record fields (section 6). LiteSVM tests load the real Pump, PumpSwap, Pump Fees and
   Mayhem programs dumped from mainnet and pinned by sha256, as `onchain/vendor/meteora` does; attack
   tests: a curve with another creator, quote, depth, mayhem, cashback or holder flag, a curve that has
   already traded, a curve owned by another program, a fake pool at graduation.
3. **P3, offchain.** Indexer, trader, trade box, wizard (section 6).
4. **P4, rehearsal.** Rerun `scripts/mainnet/rehearsal.ts` with the pump venue on the fork; measure
   launch, crank and graduation-record costs into docs/MAINNET-COSTS.md.
5. **P5, devnet (optional, D5).** Upgrade devnet `lineage_launch`; a devnet tLINE as a pump coin if
   chosen.
6. **P6, audit package.** Regenerate docs/audit/SCOPE.md, ARCHITECTURE, THREAT-MODEL (pump.fun powers:
   CTO, `set_creator`, fee and `max_curve_depth` changes), POWERS, BUILD-AND-TEST, REVIEW-AREAS.

## 8. Exit criteria

- Fork run PASS with every check exact: a depth-1 coin quoted in a fork pump-coin $LINE created with
  our PDA as `creator`; `register_pump_launch` in the same transaction; buys and sells by a user and
  by an agent key through `buy_v3`/`sell_v3` and `multi_hop_swap` from SOL; the compute vault and
  treasury deltas of `crank_pump_fees` equal the creator fees in the trade events split by
  `agent_compute_bps`; the curve completes (including a synthetic migration buy), `migrate_v2` runs,
  `Pool.coin_creator` equals our PDA, pool creator fees reach the vault, LP mint supply is 0.
- If D2 option (a) is tried: `create_v2` by CPI from `lineage_launch` succeeds, with compute units and
  stack height recorded.
- LiteSVM: every attack test in P2 red then green; the existing suite still passes on both venues.
- Costs measured, not estimated: one pump launch, one `crank_pump_fees` with its sweeps and collects,
  one `record_pump_graduation`, the size change of `lineage_launch.so`.
- Indexer recount on the fork transactions equals chain balances; the creator-change alert fires on a
  fork `admin_cto` (fork only, using a fork-local admin key).
- docs/audit regenerated; SPEC 14.2 and 13.1 updated.

## 9. Audit scope

Any change to `onchain/programs/lineage-launch` changes its tree hash (`abd42ea5...` at `9f70357`,
docs/audit/SCOPE.md), so the scope table, line counts and BUILD-AND-TEST hashes are regenerated and
sent to the firm. New review areas: reading foreign program state (owner, PDA and discriminator
checks on `BondingCurve` and `Pool`), the same-transaction freshness rule, the PDA-signed transfer out
of the `pump_creator` ATA, and the trust placed in pump.fun's admin powers. If D2 option (a) is chosen,
also the CPI and its account list. Keeping Meteora (D1 b) keeps the current Meteora review areas.

## 10. Cost and effort

No cost or time figure here is estimated: costs come from the fork run (P1, P4). Measured inputs
available today: one Meteora launch on the fork cost 0.015996680 SOL (docs/MAINNET-COSTS.md); the
`lineage_launch.so` ProgramData rent was 3.786576120 SOL at 745,216 bytes; a larger program raises it
in proportion to the new size (measure after P2). pump.fun charges no creation fee (Fees Page);
migration's 0.015 SOL is paid by whoever migrates (normally pump.fun). Work, by lane:

| Lane | Scope |
|---|---|
| Fork proof (P1) | `packages/chain/src/pump.ts`, fork script additions, a proof script; no program change |
| Program (P2) | three instructions, config and record growth, vendor dumps, LiteSVM tests |
| Offchain (P3) | indexer decoders and alerts, trader venue, trade box and wizard hunks |
| Rehearsal and audit (P4, P6) | rehearsal rerun, MAINNET-COSTS, audit package regeneration |

## 11. Not confirmed (each closes in P1 unless noted)

- Creation of a pump coin by CPI from another program (no instance observed).
- `Pool.coin_creator` equals a PDA creator after a real migration.
- Whether pump.fun honours a creator-set `creator_fee_bps` on non-holder custom-pair coins going
  forward (the program does today; the Fees Page says no). Owner decision D4.
- Whether pump.fun's site lists coins created through third-party transactions.
- Whether pump.fun's IPFS upload may be used by a third party (not needed).
- The Terms' application to a third-party platform launching for its users (legal, D7).
- Lamport costs of a pump launch and of the sweeps (measured in P1).
- Jupiter routing for new curve-stage agent coins (observed partial; we do not depend on it).

## 12. Owner decisions (2026-10-10) and what was built

Decisions: (1) pump.fun only: the Meteora DBC and DAMM v2 launch, trade and graduation paths are
removed from the program and the clients (git history keeps them, no fallback). (2) Attach by the
same-transaction check (D2 b) with a creator PDA per agent; `crank_pump_fees` permissionless; the
launcher's initial buy (launch fronting, `initial_buy_bps`) delivered to the agent key. (3) `$LINE`
SOL- or USDC-paired, never mayhem: a hard requirement (docs/MAINNET-RUNBOOK.md go/no-go, checked by
`scripts/mainnet/initialize.ts`). (4) Creator fee: pump.fun's default (`pump_creator_fee_bps` 0),
admin-editable in `LaunchConfig`. (5) Devnet moves to pump.fun. (6) The program change lands before
the external audit; docs/audit regenerated.

| Phase | What | Evidence |
|---|---|---|
| a, fork proof, no program change | `packages/chain/src/pump.ts` (builders, decoders, events, quote math); `fork.sh` clones mainnet's Pump, PumpSwap, Pump Fees, Mayhem and their state | `scripts/mainnet/pump-fork-proof.ts` PASS 28/28 (`PUMP-FORK-LAST.json`): a SOL-paired stand-in `$LINE`; coins quoted in it on its curve and after its migration with a `pump_creator` PDA as creator; the 1% initial buy in the v0 launch transaction (989 bytes); v3 curve trades; `multi_hop_swap` from SOL through curve and pool hops (protocol fee once, creator fee once); sweeps and collects land exactly the trade events' creator fees in the PDA's account with no creator signature; synthetic-migration completions; `migrate_v2`; `Pool.coin_creator` = the PDA; LP supply 0; refusals 6105 (depth), 6071 (mayhem), 6107 (quote awaiting migration); `creator_fee_bps` 150 accepted on mainnet's `Global` |
| b, program | `register_pump_launch`, `crank_pump_fees`, `record_pump_graduation`, `src/pump.rs`; Meteora instructions and `src/meteora.rs` removed; `LaunchConfig` and `AgentLaunch` keep their sizes | LiteSVM on mainnet's pump.fun dumps (`onchain/vendor/pump`, sha256 pinned): launch suite 13 red on the old build then 13 green (9 spoofing attempts, exact splits on curve and pool, graduation, removed instructions, Meteora-era records), all suites 69/69; clippy clean for the programs; `lineage_launch.so` 745,216 to 685,240 bytes |
| c, clients | `pump-launch.ts` (launch main, initial buy into the agent key, quoted seed and buy quote, crank and graduation helpers, `MAX_LAUNCH_STRINGS` 327); `planLaunch` takes a `rest` group; indexer on Pump and PumpSwap events with creator and config alerts; trader on the curve or pool; launch wizard, initial buy builder, trade box, faucet | packages/chain 195, indexer 27, trader 72 tests; tsc clean (one unrelated JSX file) |
| d, devnet | new devnet tLINE `CiBfnTkDc1vgYbuMobMNEQaKSQXPYeTUbZGRZcug1L62` (pump.fun, SOL-paired, not mayhem; devnet treasury holds 460,000,000) and a devnet Pump proof (`scripts/devnet/pump-devnet-proof.ts` 6/6) | **Not switched:** devnet's registry and launch config bind the earlier tLINE mint at initialize (the registry's vaults are token accounts of that mint), so an upgrade of devnet `lineage_launch` cannot launch on pump.fun. Moving devnet needs a fresh devnet deployment of the three programs (new devnet ids) initialized with the new tLINE, or a mint-rebind path; owner decision pending. Devnet's Pump build also differs from mainnet's (it refused a coin quoted in the fresh tLINE with `QuoteReservesOutOfRange` until tLINE's price rose) |
| e, rehearsal | `scripts/mainnet/rehearsal.ts` steps 0, 3, 5, 7 on pump.fun | PASS 102/102 at the mainnet ids; costs in docs/MAINNET-COSTS.md (one launch 0.016255680 SOL plus the initial buy and credits in `$LINE`; crank 0.003032680 first; graduation 0.022519681 incl. pump.fun's 0.015000001 migration fee; deploy 8.956285840 spent, 10.690668280 peak) |
| f, audit | docs/audit regenerated, SPEC 14 (0.37) | launch tree `6fcfc385`, 1,377 code lines; pump.fun dependency, threat rows, powers and review areas |

Open: the devnet switch above; the creator-change alert has unit tests but no fork `admin_cto` run
(pump.fun's admin key cannot sign on a fork without editing its `Global`); Jupiter routing is not
used (SOL buys use `multi_hop_swap`; the trade box's SOL and USDC path still goes through Jupiter to
`$LINE` first); the hosted agents' launch holding (LAUNCH-FRONTING D3).

**Devnet switch done (2026-10-10, devnet pump.fun redeploy lane; owner decision option A).** A fresh devnet
deployment (registry `CJk3kw...`, launch `Axo38W...`, msg `5uUyWA...`) is initialized with the pump.fun
tLINE `CiBfnT...`; the v1 programs stay as read-only history. The site runs on it; the five listed hosted
agents and the 17 scripted authors are relaunched on pump.fun; devnet's Pump build seeds quoted coins at
tLINE's spot price, now the profile field `pump_quote_seed` (devnet spot, mainnet swap). Records:
onchain/DEVNET.md "Devnet v2".
