# Mainnet costs, measured on a mainnet fork (M1)

Measured 2026-10-10 by `scripts/mainnet/rehearsal.ts` on a local fork of mainnet
(`scripts/mainnet/fork.sh`), rerun after the pump.fun program change (owner decisions 2026-10-10,
docs/plans/PUMPFUN-LAUNCHES.md section 12) on the `--features mainnet` builds at the mainnet program ids. Nothing was sent to mainnet and no SOL was spent: every lamport was
a fork airdrop, every other key a throwaway, and the three mainnet program id keypairs
(`~/.config/lineage/mainnet`) signed only their deploys on the local fork. The full record, with every
transaction, its signature on the fork, its accounts and their sizes, is
`scripts/mainnet/REHEARSAL-LAST.json` (outcome PASS, 102 of 102 checks, 85 transactions measured, plus
the deploy transactions summed per program).
Builds (`onchain/target/mainnet`, the hashes in docs/audit/BUILD-AND-TEST.md): `lineage_registry.so`
732,472 bytes (`ea000f21...ecb6`) at `3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay`, `lineage_launch.so`
685,240 bytes (`b40c047b...349d`, the pump.fun build)
at `2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq`, `lineage_msg.so` 342,600 bytes (`f633adc2...287f`)
at `jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky`. Step 0 checks each build embeds the mainnet ids
only and each id keypair is its id.

## Method

- **The fork runs mainnet's own programs.** `fork.sh` clones pump.fun's Pump (`6EF8rr...F6P`), PumpSwap
  (`pAMMBa...XEA`), Pump Fees (`pfeeUx...VZ`) and Mayhem (`MAyhSm...MD4e`), Token-2022 and Squads v4
  (`SQDS4e...pCf`, upgrade authority none) with `--clone-upgradeable-program`, plus Pump's `Global`,
  quote control, both fee configs, PumpSwap's global config, Mayhem's global params and SOL vault, Pump's
  withdraw authority, buyback recipient 0 and its wrapped SOL account, the Squads program config
  `BSTq9w...cNZr` and its treasury, and mainnet's feature set (`--clone-feature-set`). Step 0 of the
  rehearsal hashes each program on the fork against the same program read from mainnet: all six equal.
  The stand-in `$LINE` is a pump.fun coin the rehearsal creates (step 3); the deployer buys 600,000,000
  of it on its own curve with fork SOL (38.533520432 SOL on the fork; not a launch cost).
- **Fees** are the network fee of each transaction as the fork recorded it (5,000 lamports per
  signature, the same base fee as mainnet). No priority fee was set. **Compute units** are recorded per
  transaction so a priority fee can be priced: priority cost = compute unit limit x price.
- **Rent is mainnet's, not the fork's.** The test validator's genesis charges 6,960 lamports per byte
  (with the 128-byte account overhead) where mainnet charges 5,080 (`solana rent -u mainnet-beta 1`
  prints 0.00065532 SOL; the fork prints 0.00089784). So the rehearsal reads every created account's
  size on the fork and asks mainnet's own `getMinimumBalanceForRentExemption` for that size. A payer's
  mainnet cost = fee + its share of the created accounts' mainnet rent + any other outflow (zero in
  every row but the vault's funding transfer).
- **Deploys** run the runbook's commands (`solana program write-buffer`, then `solana program deploy
  --buffer ... --program-id <mainnet id keypair> --max-len <exact>`) at the mainnet ids; the fork has no
  Lineage program before them. Fees are summed over every transaction that touched the buffer, and the
  deployer's balance change equals ProgramData rent + program account rent + those fees exactly
  (checked). The rest of the rehearsal runs on these deployments.
- Figures are lamports converted to SOL at 1e9, not rounded.

## The budget

| Item | Payer | SOL |
|---|---|---|
| Deploy all three programs, ProgramData sized to the exact build (rent locked) | deployer | 8.947520840 |
| Their transaction fees (726 + 680 + 341 transactions) | deployer | 0.008765000 |
| **Deploy, spent** | deployer | **8.956285840** |
| **Deploy, peak the deployer must hold** (registry, then launch, then messages: each buffer is funded while its ProgramData is created, then refunded) | deployer | **10.690668280** |
| Initialization (table below) | deployer | 0.020507080 |
| The two configs the vault creates at launch (set_bounty_config, set_challenge_config): proposal accounts and votes | a member | 0.010169520 |
| Rent the vault pays for the configs it creates, plus its own rent-exempt minimum | vault (funded once) | 0.004221480 |
| **Everything before the first launch** | | **8.991183920** spent, **10.690668280** held at the peak |

The deployer holding 10.690668280 SOL before the first deploy covers the initialization afterwards
(1.734382440 is left after the deploys). The pump.fun build of `lineage_launch` is 59,976 bytes smaller
than the Meteora build (745,216), so it locks 0.304678080 less ProgramData rent; the run before the
change measured 9.261258920 spent and 11.303959440 at the peak. Priority fees are not included; the owner sets them (TBA).
The earlier run on the devnet-id builds of commit `d9161de` (723,776, 744,448 and 342,200 bytes)
measured 9.211104800 spent and 11.251935880 at the peak; the pre-audit builds lock 0.050109120 more
rent, pay 0.000045000 more in fees (9 more write transactions) and raise the peak by 0.052023560.

## 1. Programs

| Program | `.so` bytes | ProgramData bytes | ProgramData rent | Program account | Buffer rent (refunded) | Transactions | Fees | Locked after | Spent | Peak during |
|---|---|---|---|---|---|---|---|---|---|---|
| lineage_registry | 732,472 | 732,517 | 3.721836600 | 0.000833120 | 3.721795960 | 726 | 0.003640000 | 3.722669720 | 3.726309720 | 7.448105680 |
| lineage_launch | 685,240 | 685,285 | 3.481898040 | 0.000833120 | 3.481857400 | 680 | 0.003410000 | 3.482731160 | 3.486141160 | 6.967998560 |
| lineage_msg | 342,600 | 342,645 | 1.741286840 | 0.000833120 | 1.741246200 | 341 | 0.001715000 | 1.742119960 | 1.743834960 | 3.485081160 |

Each deploy's last transaction carries two signatures (the deployer and the program id keypair), so
fees are one signature more than 5,000 x transactions. The rent figures equal the ones read with
`solana rent -u mainnet-beta` for these sizes before the rerun.

**Upgrade headroom.** A program that grows needs more ProgramData. Two ways, both measured:

| `--max-len` at deploy | registry ProgramData rent | launch | msg | Extra locked, all three |
|---|---|---|---|---|
| exact (as above) | 3.721836600 | 3.481898040 | 1.741286840 | 0 |
| x1.25 | 4.652076040 | 4.352152840 | 2.176388840 | 2.235596240 |
| x1.5 | 5.582315480 | 5.222407640 | 2.611490840 | 4.471192480 |
| x2 | 7.442794360 | 6.962917240 | 3.481694840 | 8.942384960 |

Or deploy exact and extend when an upgrade needs it: `solana program extend <id> 10240` (the loader's
minimum, onchain/DEVNET.md A1 notes) cost 0.000005000 in fees and locks 0.052019200 more rent per
10,240 bytes for each of the three programs (measured on the fork on a throwaway copy of the messages
build, so the real deployments stay as the runbook leaves them; rent read from mainnet). For scale,
devnet history: the registry grew from 516,936 to 732,472 bytes and the launch program from 526,224
to 745,216 between 2026-10-07 and 2026-10-10, then shrank to 685,240 with the pump.fun change. Each upgrade also writes a buffer (the write phase
above: the buffer's rent is held until the upgrade, then refunded to the spill account) and runs one
multisig proposal (section 3). The headroom choice is the owner's (TBA).

`solana program set-upgrade-authority` to the vault: 0.000005000 per program.

## 2. Initialization (once)

| Transaction | Accounts created (bytes) | Compute units | SOL |
|---|---|---|---|
| Squads `multisig_create_v2`, 2 of 3, time lock, autonomous (mainnet creation fee read 2026-10-10: 0 lamports) | multisig (231) | 22,630 | 0.001833720 |
| `lineage_registry::initialize` (admin = vault; sets the default slash cap) | Config (287, two bytes more for the A1-08 cap), five token vaults (165 each) | 114,786 | 0.009555400 |
| Compute sink: the vault's `$LINE` token account | token account (170) | 18,717 | 0.001518840 |
| `lineage_launch::initialize_launch` (admin = vault; checks `$LINE` is a pump.fun coin paired with SOL or USDC, not mayhem) | LaunchConfig (319) | 27,969 | 0.002275760 |
| `lineage_msg::initialize` (admin = vault) | MsgConfig (58) | 20,204 | 0.000949880 |
| Launch lookup table, create + extend (21 addresses: ours and pump.fun's fixed and `$LINE` quote accounts) | table (728) | 22,450 | 0.004353480 |
| Launch lookup table, freeze | | 1,517 | 0.000005000 |
| `set-upgrade-authority` x 3 | | | 0.000015000 |
| **Total (deployer)** | | | **0.020507080** |

There is no DBC config any more (0.005984080 in the Meteora run). Once `$LINE` has migrated to
PumpSwap a launch also names its pool and two vaults: a second table with those 3 more addresses
(24, 824 bytes) cost 0.004841160 on the fork.

Compute units differ from the run at the devnet ids (for example `lineage_registry::initialize`
125,141 there): PDA bump searches depend on the program id.

Paid by the vault inside its first two proposals: BountyConfig (76 bytes) 0.001036320, ChallengeConfig
(78) 0.001046480 and the challenge bond vault (165) 0.001488440; the vault itself must stay
rent-exempt (0 bytes, 0.000650240).

The stand-in `$LINE` is a pump.fun coin created on the fork with `create_v2` paired with SOL
(0.005689440 for its creator, with its curve and mint); the real `$LINE` launches on pump.fun (owner),
paired with SOL or USDC and never mayhem mode.

## 3. One admin action through the multisig

| Step | Who | SOL |
|---|---|---|
| Create the vault transaction and its proposal (one transaction) | proposing member | 0.003581320 to 0.005399960 measured (the vault transaction holds the whole message: 90 to 448 bytes; the proposal is 358 bytes) |
| Approve (each of 2) | member | 0.000005000 |
| Execute after the time lock | member | 0.000005000 (27,638 to 74,594 compute units) |

The multisig's rent collector is the vault, so the two proposal accounts' rent can be reclaimed to the
vault after execution with Squads' close instructions (not exercised in the rehearsal).

Measured per action (create transaction): set_bounty_config 0.004739560, set_challenge_config
0.005399960, registry set_config 0.005130720, set_launch_config 0.005029120, messages set_config
0.004475400, set_slash_cap 0.004236640 (vault transaction 219 bytes), pause and unpause 0.004231560
each, set_epoch_cursor 0.004389040, Squads time lock change 0.003581320, program upgrade 0.005044360
(the Meteora run's graduate_by_admin, 0.005399960, no longer exists).

**The slash cap (A1-08) on the fork.** `initialize` set the default, the largest slash share x
`strike_limit` = 2,500 x 3 = 7,500 bps; the deployer's `set_slash_cap` was refused (Unauthorized); the
vault set 2,500 bps through propose, two approvals, the time lock and execute; a canary slash then
took 2,500 bps of the verifier's bond (1,250,000 of 5,000,000 base units) into the reserve, a second
canary slash in the same chain epoch was refused whole (`SlashCap`, error 6029: bond, window total,
strikes and receipt unchanged), and a strike without an amount (abandon) still landed. After the
rehearsal, `propose.ts` set the cap to 5,000 bps on the same fork through the operator CLI (proposal
13: an execute before the time lock was refused with 6021, the one after it landed, read back 5,000).

## 4. Per use

| Action | Payer | Accounts created (bytes) | Compute units | SOL |
|---|---|---|---|---|
| **One launch on pump.fun** (as the wizard plans it, v0 with the launch table: `create_v2` + `register_pump_launch` + the 1% initial buy, then deposit + `refresh_awake` in a second transaction) | launcher | 8: agent mint (376), bonding curve (166), the curve's two token accounts (170), AgentLaunch (554), compute vault (165), Agent (401), the agent key's token account (170) | 350,172 and 16,658 | **0.016255680** (0.016250680 + 0.000005000), plus the `$LINE` of the initial buy and the deposit |
| The first launch on a `$LINE` also creates the `$LINE` buyback recipient's account (170) and the launcher's pump.fun volume account (137) | launcher | 2 more | 344,668 | 0.019110720 for the first transaction |
| A curve trade (`buy_exact_quote_in_v3`, `sell_v3`) | trader | the trader's pump.fun volume account (137) and token account (170) on a first buy | 85,026, 60,492 | 0.002865040 first buy, 0.000005000 after |
| `multi_hop_swap` SOL to `$LINE` (curve or pool) to an agent coin | trader | | 162,235 and 166,251 | 0.000005000 plus the SOL spent (and wrapped SOL account rent when new) |
| **Fee crank** (pump.fun `sweep_creator_fee` + `collect_creator_fee_v2`, then `crank_pump_fees`; anyone) | keeper | first time: the creator PDA's `$LINE` account and pump.fun's creator vault account (170 each) | 133,921 and 142,921 | **0.003032680** first, 0.000005000 after |
| After graduation the crank adds PumpSwap's sweep + `collect_coin_creator_fee` | keeper | first time: the AMM creator vault account (170) | 168,890 | 0.001518840 first |
| **Graduation**: pump.fun `migrate_v2` + `record_pump_graduation` (permissionless, one transaction) | whoever calls it | pool (287), LP mint (82), pool and authority token accounts | 386,144 | **0.022519681**, of which pump.fun's migration fee is 0.015000001 (`Global.pool_migration_fee`, read 2026-10-10) |
| A PumpSwap trade (`buy_exact_quote_in_v2`, `sell_v2`) | trader | | 58,347, 56,121 | 0.000005000 |
| Register a verifier (2 signatures) | owner | Agent (401) | 31,565 | 0.002697320 |
| `bond`, `split` | owner, anyone | | 27,463, 32,597 | 0.000005000 each |
| **One epoch post** (`post_epoch`) | Core authority | Epoch (165) | 49,440 | **0.001493440** |
| **One challenge** (`open_challenge`, 2 signatures) | challenger's payer | Challenge (252), ChallengeGate (30) | 64,489 | **0.002743040** plus the bond in `$LINE` (TBA) |
| `resolve_challenge` | Core authority | | 44,839 | 0.000005000 |
| **One claim** | anyone | ClaimReceipt (128) | 76,835 and 77,276 | **0.001305480** |
| **One slash** (`slash`, with or without an amount) | Core authority | SlashReceipt (97) | 46,782 (canary), 45,211 (abandon) | **0.001148000** |
| A slash refused by the cap | Core authority | | | 0 (refused in simulation, never sent) |

The Core authority's running cost is one epoch post per epoch (0.001493440 each), the resolutions it
sends and the slashes it posts (0.001148000 each); the hosted runtime's is its usage posts and debits
(not measured here). Both are hot keys funded separately from the multisig.

## What the owner still sets (TBA)

Priority fee policy; `--max-len` headroom; the real `$LINE` mint (a pump.fun coin paired with SOL or USDC,
never mayhem); every protocol parameter (the fork used the shape of `config/network.json` with
`epoch_length_s` 300 and the devnet TEST caps; pump.fun sets the curve); the multisig members, threshold and time lock (the fork used 2 of 3 with 20 s,
then 25 s, so the run finishes); the challenge window and bond.
