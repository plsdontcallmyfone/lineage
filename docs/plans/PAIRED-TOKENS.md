# Paired tokens: agents priced in, or attached to, coins that already exist (spec)

Written 2026-10-12 by the paired tokens spec lane. A spec, not a build: no code changed, nothing was
sent to mainnet, no key was used. Every figure is marked **measured** (read from mainnet or run here),
**read** (from code, config or a document, with its place), **setting** (a value someone chose and can
change), **computed** (arithmetic on measured figures, shown) or **estimate** (with its basis).

Chain reads: mainnet, slots 456,259,840 to about 456,260,600, 2026-10-13 01:26 to 01:50 UTC, through
the repo's decoders (`packages/chain`) over the keyed endpoint with the public endpoint as fallback.
Prices: Jupiter Price API V3 at the same time: $UNITS 0.0000452666 USD, CLAUDIA 0.004520172 USD,
SOL 104.081 USD (all measured).

## 1. What the owner asked

"Add another pairing mechanism where you can pair to tokens that already work on projects", with the
example CLAUDIA (`2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM`). The owner chose both mechanisms, for
tokens the owner approves only:

1. **Priced in an approved token.** A new agent coin is still created on pump.fun, but its curve is
   quoted in the approved token instead of $UNITS. Buying the agent means buying that token first.
2. **An approved token becomes the agent's coin.** No new coin. An agent is attached to the existing
   token and works on the project's repository.

## 2. Short answer

- pump.fun accepts it today. A `create_v2` quoted in CLAUDIA simulates clean on mainnet (measured).
- The official programs do not. `register_pump_launch` refuses any quote but $UNITS, and it is the only
  way an agent gets its registry record and compute vault. **Neither mechanism can ship with no
  program change.** The registry accepts exactly one launch program, so a new side program cannot
  register agents either, unless the agents become second class (section 5, option N).
- The smallest honest change is **one upgrade of `units_launch`**, additive, covering both mechanisms,
  with the approved list empty at deploy so nothing changes until the owner approves a token.
- Compute stays in $UNITS. Fee income in another token is converted to $UNITS by a keeper, then the
  existing crank splits it as today.
- CLAUDIA specifically: its creator fees are locked by pump.fun's fee sharing to the GitHub account
  `anabologyco-maker`, and that route can no longer be changed by its creator. An agent attached to
  CLAUDIA would run on prepaid credits and voluntary top-ups only.
- The example project has one repository an agent could work on today (`mem-sync`, Python, with tests).

## 3. Facts

### 3.1 The official deployment (measured)

| What | Value |
|---|---|
| `LaunchConfig.line_mint` and registry `Config.mint` | `GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump` ($UNITS, Token-2022, 6 decimals) |
| Admin of both configs, and upgrade authority of both programs | `6UhUBoVp...4jh3` (the dev wallet, one key) |
| Fee split of every crank | `agent_compute_bps` 7,000, `protocol_bps` 3,000 |
| `features` | 0 (agent pools and GitHub fee routes are off) |
| `pump_creator_fee_bps` | 0 (pump.fun's standard schedule) |
| Sleep and wake thresholds | 14,400 and 28,800 $UNITS (0.65 and 1.30 USD, computed) |
| `units_launch` ProgramData | 685,269 bytes: the exact build, no spare room |
| $UNITS | supply 944,243,029.91; about 42,743 USD market cap (computed); PumpSwap pool holds 71.69 SOL and 202,998,709 $UNITS |

### 3.2 pump.fun (measured unless marked)

- `Global`: `create_v2_enabled` true, `max_curve_depth` 1, `creator_fee_configurable` true, maximum 300 bps.
- **`create_v2` with CLAUDIA as the quote succeeds** in `simulateTransaction` (signature check off,
  nothing signed or sent; the same harness with $UNITS as the quote also succeeds, as the control).
  The curve it writes: quote mint CLAUDIA, depth 1, starting virtual quote reserves 644,372.79 CLAUDIA.
  Computed from that: starting market cap about 2,715 USD, about 1,825,838 CLAUDIA (8,253 USD) to
  graduate, and the 1% initial buy costs about 6,062 CLAUDIA (27 USD) before fees.
  With `creator_fee_bps` 100 it also succeeds.
- Rules for a quote coin (read, `PUMPFUN-LAUNCHES.md` 4.1): it must be a pump.fun coin of depth 0
  (itself quoted in SOL, USDC or a listed mint), never mayhem mode, not waiting for migration. One hop
  only: nothing can be quoted in an agent coin.
- Creator fees of a coin quoted in token T are paid in T (read, pump.fun Fees Page, 2026-10-08).
- Not proven for another quote than $UNITS, same instructions: trades, `multi_hop_swap` from SOL, the
  fee sweep and collect into a program address, migration. The $UNITS proofs are
  `scripts/mainnet/pump-fork-proof.ts` and `pool-launch-fork.ts`.

### 3.3 CLAUDIA (measured)

| What | Value |
|---|---|
| Mint | Token-2022, 6 decimals, extensions metadata pointer and token metadata only (the registry's allowed set), no mint or freeze authority, supply 946,238,199.12 |
| Market | curve complete, depth 0, SOL quote, not mayhem; canonical PumpSwap pool `Fe7bpDYC...ohFr` holds 1,258.10 SOL and 29,409,104 CLAUDIA; LP supply 0; about 4,277,160 USD market cap (computed); 24 hour change minus 45.2% |
| Creator (curve and pool) | `DRqWUscn...uii7`: a pump.fun **fee sharing config** of this mint (version 2, active) |
| Fee sharing | one shareholder at 10,000 bps; `admin_revoked` true; config admin `bwamJzzt...fSXa` |
| The shareholder | `CFS8prB7...E42x`: a pump.fun **social fee account**, platform 2, user id `254566721`. GitHub's API resolves that id to `anabologyco-maker` |
| Paid out so far | 1,048.17 SOL claimed from that account, last claim 2026-10-12 07:15 UTC; 83.06 SOL wait in the pool side creator vault |
| Metadata | name Claudia, website `https://github.com/anabologyco-maker` (off-chain JSON, changeable by its host) |

What this means for redirecting fees:

- pump.fun pays 100% of CLAUDIA's creator fees to whoever proves to pump.fun that they are the GitHub
  account `anabologyco-maker`. The developer already collects them.
- pump.fun's docs say the share list can be set once and the admin is revoked after
  (`CREATOR_FEE_SHARING.md`, read); the flag reads revoked. So **neither the original creator nor the
  developer can point CLAUDIA's fees at an agent on chain.** Only pump.fun can (`admin_cto_sharing_config`).
- Without anyone's cooperation: nothing reaches an agent. With the developer's cooperation: they claim
  on pump.fun to their wallet and send money on by hand. Per trade, automatic funding is not possible
  for this coin.
- Not established: who created the coin and who holds the config admin wallet. Neither repository
  mentions the coin (GitHub code search for the mint: 0 results).

For a pump.fun coin that has **no** fee sharing config yet, its creator can create one and set shares
once, naming up to 10 recipients (read). A recipient can be an address of ours, so such a creator can
route a share to an agent permanently. Not tried; a fork step.

### 3.4 The example project (measured)

`github.com/anabologyco-maker` is a user account with 2 public repositories, 0 stars each.

| Repository | What | Free reading (`readTree` of `unit-setup.ts`, run on a clone) |
|---|---|---|
| `mem-sync` (`c36be26`) | shared memory for coding agents; Python, 52,775 bytes; MIT; 6 commits, last push 2026-08-28; `tests/test_core.py`, `tests/test_migrate.py`, pytest configured | class python, 2 test files: **a unit is possible** |
| `square17-lower-bound` (`396da6f`) | a Lean proof with data and helper scripts; no license; 6 commits, last push 2026-08-17 | classed python by its helper scripts, 0 tests: **no unit** |

So an agent could be set up on `mem-sync` under the automatic unit setup, and Python is the class
mainnet runs today. Not run: the draft itself (a model call, at most 1.5 USD per draft and 4 USD per
repository, both settings), so whether a stable measure exists for this small, file and daemon heavy
tool is unknown until it is tried. The repository's tests were not executed here.

## 4. What the deployed programs assume

Everything on chain is single mint. `LaunchConfig.line_mint` and registry `Config.mint` are fixed at
initialize; the registry's five vaults are token accounts of that mint.

| Where | Assumption |
|---|---|
| `register_pump_launch` | `curve.quote_mint == line_mint` (`PumpWrongQuote`); `created_in_this_tx` (a `create_v2` for this mint earlier in the same transaction); creator is PDA `["pump_creator", agent]`; the compute vault is created with `token::mint = line_mint`. It is the only caller of the registry's `register_launched` |
| `crank_pump_fees` | splits the balance of the creator PDA's **$UNITS** account only. Fees paid in another token sit in a different account that no instruction can move |
| `record_pump_graduation` | the canonical pool is derived with `line_mint` as quote |
| `debit_compute`, `withdraw_compute`, `compute_sink` | $UNITS transfers out of the vault; `max_debit_per_epoch`, sleep and wake thresholds are $UNITS amounts |
| Bounties, GitHub fee escrow, agent pools | vaults of `line_mint`; pool buys derive pools with `line_mint` |
| Registry | verifier burn and bonds, slashes, treasury, reserve, epoch payouts and author rewards are all `Config.mint`; author rewards go to the compute vault derived under the one `launch_program`; Core lets only launched agents author |
| `packages/runtime/src/price.ts` | one mint's USD price converts model spend into vault debits |
| `packages/indexer/src/usd.ts` | one quote coin: one reading, one sample table with no mint column; every agent price is "price in the quote coin times the quote coin's USD price" |
| `packages/chain/src/pump-launch.ts` | `LineQuote`, `pumpLaunchMain`, `pumpQuotedCurve`, `pumpCrankIxs`, `pumpGraduateIxs` take the one quote; the string cap (321 bytes) is measured with a lookup table that holds $UNITS's pool accounts |
| `apps/web/wallet/main.ts` | `buildLaunch` buys $UNITS with SOL (`pumpSolToLinePool`), pays credits and the 1% buy from it |

Prepaid credits are a plain $UNITS transfer into the vault plus `refresh_awake`. Anyone can top up
any agent, today, with no program change.

## 5. The program change (shared by both mechanisms)

**Option U (recommended): one upgrade of `units_launch`.** Additive. The registry and messages
programs are untouched. Layout sizes do not change (one byte of `AgentLaunch.reserved` becomes a mode:
0 $UNITS, 1 paired, 2 attached), so no migration.

| New | What it does |
|---|---|
| `ApprovedToken` account, `set_approved_token` (admin) | the approved list, section 8 |
| `register_pump_launch`, one optional trailing account | with an enabled `ApprovedToken`, accepts a curve quoted in that token. Every other check unchanged. The vault is still $UNITS |
| `attach_token` | mechanism 2: creates the agent's record, vault and registry entry for an approved existing mint, with no `create_v2` check, signed by the wallet the list names |
| `sweep_paired_fees` | moves the approved token (or, for an attached coin, SOL) that arrived at the agent's fee address to the admin-set converter account, capped per call, counted per agent, with an event |
| `record_pump_graduation` | derives the pool with the curve's own quote |
| Agent pools | refuse paired and attached agents (the feature is off on mainnet) |

- Risk: this program's authority signs for every compute vault on mainnet, so a faulty upgrade puts
  all of them at risk. Mitigation: the diff adds instructions and one branch behind a list that starts
  empty; LiteSVM red then green; a mainnet fork run with CLAUDIA's real accounts; the audit scope
  regenerated; the owner signs the upgrade (the dev wallet key is never used by an agent lane).
- Cost (estimate). Basis: measured `docs/MAINNET-COSTS.md` (launch buffer 3.48 SOL refunded, 680
  transactions, 0.0034 SOL fees; 0.0520 SOL locked per 10,240 byte extension) and the build's 232
  bytes per source line (685,224 bytes over 2,949 lines). For 150 to 350 new lines: 35,000 to 81,000
  more bytes, so 0.21 to 0.42 SOL locked for good, about 3.9 to 4.3 SOL held at the peak, the rest
  returned. The dev wallet holds 10.89 SOL (measured). The real size is known only after a build.
- Admin-editable on chain: each token's flags, attach wallet, repository, converter and sweep cap; the
  split stays `LaunchConfig`'s.

**Option N: a new program with its own id**, leaving the official programs untouched. It cannot call
`register_launched`, so its agents would register as verifier kind (burning 200,000 $UNITS, measured
parameter) and keep their vault, usage roots and debits in the new program. Core, runtime, indexer and
wallet each get a second path; registry author rewards, bounties, pools and fee routes do not reach
these agents; a hosted agent could bond, which the registry forbids for launched ones. Risk is
isolated from existing vaults. Cost (estimate, basis `units_msg`: 342,600 bytes, 1.74 SOL spent, 3.49
peak): 1.5 to 2.3 SOL locked, about twice that held during the deploy.

**Recommendation: U, once, for both mechanisms together.** N buys isolation at the price of a parallel
launch system and second class agents.

## 6. Mechanism 1: an agent coin priced in an approved token

**Flow.** The wizard offers "Priced in" with $UNITS and the approved tokens. The launch transaction is
today's with the quote swapped: `create_v2` quoted in T, `register_pump_launch` with T's `ApprovedToken`,
the 1% initial buy paid in T, credits paid in $UNITS. The launcher still pays in SOL: one purchase of
T on T's pool for the initial buy, one purchase of $UNITS for credits. Buyers reach the coin from SOL
through T in one `multi_hop_swap`.

**Fees.** pump.fun pays the agent's creator fees in T to the agent's creator address. A keeper calls
pump.fun's sweep and collect, then `sweep_paired_fees`; converts T to $UNITS (section 9); deposits the
$UNITS into the creator address's $UNITS account; the unchanged `crank_pump_fees` splits it 7,000 /
3,000 (measured setting), fee routes included.

| | |
|---|---|
| (a) No program change | Nothing. pump.fun would create the coin; the official program cannot register it, so there is no agent, no vault and no fee path |
| (b) Program side | Option U: the list, the trailing account on `register_pump_launch`, `sweep_paired_fees`, the graduation fix |
| (c) Recommendation | Build it on U. Ship after the fork proof with a real approved coin |

**Risks.** The agent coin is repriced by T: CLAUDIA moved minus 45% in the measured 24 hours. The
graduation target is fixed in T at creation from T's price that minute. T is someone else's coin:
pump.fun can reassign its creator or change fee rates, and `max_curve_depth` 0 would stop new paired
launches (existing coins keep trading). The converter holds fees in flight (section 9). Each approved
token needs its own lookup table or the name, symbol and link budget shrinks by about 160 bytes
(computed: 5 accounts of 32 bytes).

**Owner decides:** which tokens to approve as a quote; the per-call sweep cap per token.

## 7. Mechanism 2: an approved token becomes the agent's coin

**Flow.** No coin is created. The owner approves the mint for attaching and names, on chain, the
wallet that may attach and the repository. That wallet runs a shorter wizard (repository fixed, soul,
runtime, credits) and signs `attach_token` with the agent key. The agent then works exactly like any
other: unit setup, verifiers, epochs. One agent per token (the record is keyed by the mint), and the
attachment is permanent on chain; a mistake is hidden, not undone.

**Who may attach.** The token is on the list, and the owner has seen, in the admin page:
- the repository admin proof that already exists (`packages/core/src/fee-claims.ts`: GitHub sign-in
  where GitHub answers `permissions.admin` true, or for a personal repository a gist holding a
  statement the wallet signed), binding a wallet to an admin of the repository; and
- one link from the token to that GitHub account, read from chain where it exists. For CLAUDIA it is
  the strongest kind: pump.fun itself pays the coin's creator fees to that GitHub account id (3.3).
  Otherwise the token's creator wallet signs, or the metadata website names the account (weakest: the
  metadata host can change it).

The chain enforces the owner's decision (the named wallet signs); the proofs are evidence for it.

**Credits.** The same prepaid minimum as any launch (setting, 10 USD in `config/network.json`), in
$UNITS, bought with SOL as today. Anyone can top up later.

**The 1% initial holding does not apply.** It is a buy on a fresh curve; here 1% of supply is
9,462,382 CLAUDIA, about 42,772 USD (computed), bought on the open market. Recommended: none. The
attacher may send the agent tokens voluntarily; agents never trade them.

**How fees reach the vault.**
- Creator cooperates and the coin has no fee sharing config yet: the creator sets shares once, naming
  the agent's fee address for a share. pump.fun then pays that share in SOL on every distribution;
  `sweep_paired_fees` hands it to the converter; it arrives as $UNITS and the crank splits it.
- Fee sharing already final (CLAUDIA): no on-chain route. The developer tops the vault up by hand
  ("Fund this agent": SOL in, $UNITS credits out, the existing prepay path, 100% to compute).
- Creator does not cooperate: prepaid credits only. The agent sleeps below 14,400 $UNITS (measured
  setting) and wakes when someone funds it.

| | |
|---|---|
| (a) No program change | Nothing attaches: no agent record without `register_pump_launch`. What works today on that project is an ordinary launch on `mem-sync` with a new $UNITS-priced coin, and credit top-ups |
| (b) Program side | Option U: `attach_token`, the attach fields of `ApprovedToken`, the SOL branch of `sweep_paired_fees` |
| (c) Recommendation | Build it on U in the same upgrade. For CLAUDIA, offer it as credits funded and say so on the page |

**Risks.** An attached agent earns the protocol nothing unless fees flow through its fee address.
The coin's holders did not ask for an agent: attach only with the repository admin's proof. The
agent's work does not change the coin's supply or fees; the page must not suggest it does.

**Owner decides:** whether to attach CLAUDIA knowing it is credits only; the repository (`mem-sync`
is the only one that can have a unit).

## 8. The approved list

On chain, in `units_launch`: one `ApprovedToken` account per mint (PDA `["approved_token", mint]`),
written only by `LaunchConfig.admin` through `set_approved_token`. Empty at deploy.

| Field | Meaning |
|---|---|
| `quote_enabled` | new agent coins may be priced in it (mechanism 1) |
| `attach_enabled`, `attach_wallet`, `attach_repo_id` | it may become an agent's coin, by this wallet, on this repository (mechanism 2) |
| `converter` | the account `sweep_paired_fees` pays |
| `max_sweep` | most one sweep may move |

Approval checks on chain: the mint passes the registry's extension rule; for a quote, its pump.fun
curve exists with depth 0 and no mayhem. Switching a flag off stops new launches and attaches; agents
that exist keep their sweeps. An admin page section edits every field; the public launch page reads
the list from chain.

## 9. Compute funding

**Decision: the vault stays in $UNITS. Fee income in any other asset is converted to $UNITS.**

Why not hold the other token and meter it at its own USD price: the vault mint, the debit, the sink,
the debit cap, the sleep and wake thresholds, bounties and escrows are all one mint (section 4). A
vault per token means new money paths through the whole program and a price feed per token in the
runtime. That is a rewrite, and it leaves the treasury holding coins the owner did not choose.

**Who swaps.** A conversion keeper: a new service with its own hot key, modelled on
`packages/fee-keeper` (which already buys $UNITS with SOL). Never an agent key; the agents' swap
firewall is untouched.

**When and how.** When an agent's swept balance is worth at least a minimum (setting), in chunks no
larger than a maximum (setting). Route: T to SOL on T's PumpSwap pool, SOL to $UNITS on $UNITS's pool.
Each leg has a slippage bound (setting; the fee keeper uses 100 bps and `config/swap.json` caps at 300
bps and 2% price impact) and fails closed. The $UNITS pool is thin: 71.69 SOL real plus 17.43 SOL
virtual quote reserves (measured), so a buy of about 0.45 SOL (46 USD) moves its price about 1%
(computed, constant product). Chunk size matters more than anything else here.

**Trust, plainly.** Between sweep and deposit the keeper's key holds the fees. The bound is one sweep
(`max_sweep`, on chain); sweeps and deposits are both on chain per agent, so anyone can reconcile
them. The alternative, a swap inside the program, removes the key but adds two pump.fun calls to the
program that signs for every vault; pump.fun changes its account lists often (read,
`PUMPFUN-LAUNCHES.md` D2). Recommended: the keeper.

**What this does to $UNITS, plainly.**
- Kept: every dollar of agent fee income, whatever the pairing, becomes a market buy of $UNITS before
  it is split 70% compute, 30% protocol.
- Lost: the pairing demand. Launchers and buyers of a coin priced in T buy T, and the curve and pool
  lock T, not $UNITS. Only credits still need $UNITS at launch.
- The "$UNITS fees: 50% compute, 50% buyback and burn" line is about $UNITS's own creator fees
  (`config/fee-keeper.official.json`, settings 5,000 / 5,000). Paired agents do not change that split.
  They do not feed it either: their trading volume goes through T's pool, not $UNITS's. The site must
  not imply that a coin priced in T burns $UNITS.
- Conversion costs two swap fees and slippage, so an agent priced in T keeps a little less of each fee
  dollar than one priced in $UNITS. Not measured.

## 10. Pages and wizard

Everything in USD, as now. No new fonts or type styles.

- **Wizard.** "Priced in": $UNITS or an approved token, each with its USD price and 24 hour change read
  live. Cost lines show the initial buy in T and credits in $UNITS, both in USD, with the two SOL
  purchases. For an approved attach wallet: "Attach an existing coin" replaces the coin step.
- **Coin page.** A plain label: "Priced in CLAUDIA" or "Existing coin, attached on its date, not created
  on units". Price, market cap and volume in USD through the coin's own quote. For an attached coin a
  funding panel: where its creator fees go as read from chain, what has reached the vault, and "Fund
  this agent".
- **Indexer.** Quote price readings keyed by mint (a mint column in the samples table); trades of
  curves and pools quoted in approved tokens; attached coins' SOL pools; sweeps, conversions and
  deposits per agent; the approved list.
- **Admin page.** The approved list editor, the attach evidence (repository proof, the coin's fee
  recipient read from chain), keeper limits and its reconciliation.
- **Unchanged.** Runtime pricing (`price.ts`), Core's credit minimum, debits, verifiers, bonds, epochs.

## 11. Build order

| Step | What | Needs |
|---|---|---|
| 0, now | Clients made quote-generic behind a flag: `pump-launch.ts`, the wizard purchase path, the indexer's per-mint prices | nothing; changes no behaviour |
| 1 | The program diff with LiteSVM tests; audit scope regenerated | owner go-ahead on U |
| 2 | Fork proof with CLAUDIA's real accounts: paired launch, trades, sweep and collect in CLAUDIA into the agent's address, `multi_hop_swap`, migration, attach, a fee share paid to a program address | step 1 |
| 3 | Conversion keeper, fork tested, dry run first | step 2 |
| 4 | The upgrade on mainnet, list empty | the owner signs; 0.21 to 0.42 SOL locked (estimate) |
| 5 | Mechanism 2 for one approved token, credits funded | steps 4, admin page |
| 6 | Mechanism 1 for one approved token | steps 3, 4 |

Nothing user-visible can ship before step 4. Mechanism 2 ships first after it: it needs no keeper
when the coin's fees cannot be routed anyway.

## 12. Open questions for the owner

1. **One upgrade of `units_launch` for both mechanisms (U), or a separate program with second class
   agents (N)?** Recommended: U, once, after the fork proof.
2. **Fee conversion by a keeper with an on-chain cap per sweep, or a swap inside the program?**
   Recommended: the keeper.
3. **CLAUDIA: attach it knowing the agent is funded by credits only, with the repository admin as the
   one who attaches, on `mem-sync`?** Recommended: yes for mechanism 2, labelled as credits funded.
   As a quote for mechanism 1 it works on pump.fun today, but its price fell 45% in a day: approve it
   as a quote only if the owner accepts that for every coin priced in it.
4. **The 1% initial holding on an attach: none?** Recommended: none.
