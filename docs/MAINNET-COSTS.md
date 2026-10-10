# Mainnet costs, measured on a mainnet fork (M1)

Measured 2026-10-10 by `scripts/mainnet/rehearsal.ts` on a local fork of mainnet
(`scripts/mainnet/fork.sh`). Nothing was sent to mainnet, no real key signed anything and no SOL was
spent: every key was a throwaway and every lamport a fork airdrop. The full record, with every
transaction, its signature on the fork, its accounts and their sizes, is
`scripts/mainnet/REHEARSAL-LAST.json` (outcome PASS, 67 of 67 checks, 82 transactions measured).
Builds: `lineage_registry.so` 723,776 bytes (`8f3861a4...2b32`), `lineage_launch.so` 744,448 bytes
(`762a18d9...30b0`), `lineage_msg.so` 342,200 bytes (`0d402e82...d085`), built from commit `d9161de`
(program sources unchanged since `b855b4a`), the same hashes as the devnet registry and launch.

## Method

- **The fork runs mainnet's own programs.** `fork.sh` clones Meteora DBC
  (`dbcij3...aqN`, mainnet last deployed in slot 445,503,633), DAMM v2 (`cpamdp...sGG`, slot
  445,230,614), Token-2022 and Squads v4 (`SQDS4e...pCf`, upgrade authority none) with
  `--clone-upgradeable-program`, plus DAMM v2's dynamic config `A8gMrE...Ctck`, DBC's pool authority,
  the Squads program config `BSTq9w...cNZr` and its treasury, and mainnet's feature set
  (`--clone-feature-set`). Step 0 of the rehearsal hashes each program on the fork against the same
  program read from mainnet: all four equal.
- **Fees** are the network fee of each transaction as the fork recorded it (5,000 lamports per
  signature, the same base fee as mainnet). No priority fee was set. **Compute units** are recorded per
  transaction so a priority fee can be priced: priority cost = compute unit limit x price.
- **Rent is mainnet's, not the fork's.** The test validator's genesis charges 6,960 lamports per byte
  (with the 128-byte account overhead) where mainnet charges 5,080 (`solana rent -u mainnet-beta 1`
  prints 0.00065532 SOL; the fork prints 0.00089784). So the rehearsal reads every created account's
  size on the fork and asks mainnet's own `getMinimumBalanceForRentExemption` for that size. A payer's
  mainnet cost = fee + its share of the created accounts' mainnet rent + any other outflow (zero in
  every row).
- **Deploys** run the runbook's commands (`solana program write-buffer`, then `solana program deploy
  --buffer ... --max-len <exact>`) at fresh throwaway program ids. Fees are summed over every
  transaction that touched the buffer, and the deployer's balance change equals ProgramData rent +
  program account rent + those fees exactly (checked). The functional copies the rest of the rehearsal
  uses sit at the declared ids with a throwaway upgrade authority.
- Figures are lamports converted to SOL at 1e9, not rounded.

## The budget

| Item | Payer | SOL |
|---|---|---|
| Deploy all three programs, ProgramData sized to the exact build (rent locked) | deployer | 9.202089800 |
| Their transaction fees (718 + 738 + 341 transactions) | deployer | 0.009015000 |
| **Deploy, spent** | deployer | **9.211104800** |
| **Deploy, peak the deployer must hold** (registry, then launch, then messages: each buffer is funded while its ProgramData is created, then refunded) | deployer | **11.251935880** |
| Initialization (table below) | deployer | 0.024855400 |
| The two configs the vault creates at launch (set_bounty_config, set_challenge_config): proposal accounts and votes | a member | 0.010169520 |
| Rent the vault pays for the configs it creates, plus its own rent-exempt minimum | vault (funded once) | 0.004221480 |
| **Everything before the first launch** | | **9.250351200** spent, **11.251935880** held at the peak |

The deployer holding 11.251935880 SOL before the first deploy covers the initialization afterwards
(2.040831080 is left after the deploys). Priority fees are not included; the owner sets them (TBA).

## 1. Programs

| Program | `.so` bytes | ProgramData bytes | ProgramData rent | Program account | Buffer rent (refunded) | Transactions | Fees | Locked after | Spent | Peak during |
|---|---|---|---|---|---|---|---|---|---|---|
| lineage_registry | 723,776 | 723,821 | 3.677660920 | 0.000833120 | 3.677620280 | 718 | 0.003600000 | 3.678494040 | 3.682094040 | 7.359714320 |
| lineage_launch | 744,448 | 744,493 | 3.782674680 | 0.000833120 | 3.782634040 | 738 | 0.003700000 | 3.783507800 | 3.787207800 | 7.569841840 |
| lineage_msg | 342,200 | 342,245 | 1.739254840 | 0.000833120 | 1.739214200 | 341 | 0.001715000 | 1.740087960 | 1.741802960 | 3.481017160 |

**Upgrade headroom.** A program that grows needs more ProgramData. Two ways, both measured:

| `--max-len` at deploy | registry ProgramData rent | launch | msg | Extra locked, all three |
|---|---|---|---|---|
| exact (as above) | 3.677660920 | 3.782674680 | 1.739254840 | 0 |
| x1.25 | 4.596856440 | 4.728123640 | 2.173848840 | 2.299238480 |
| x1.5 | 5.516051960 | 5.673572600 | 2.608442840 | 4.598476960 |
| x2 | 7.354443000 | 7.564470520 | 3.477630840 | 9.196953920 |

Or deploy exact and extend when an upgrade needs it: `solana program extend <id> 10240` (the loader's
minimum, onchain/DEVNET.md A1 notes) cost 0.000005000 in fees and locks 0.052019200 more rent per
10,240 bytes (measured on the fork, rent read from mainnet). For scale, devnet history: the registry
grew from 516,936 to 723,776 bytes and the launch program from 526,224 to 744,448 between 2026-10-07
and 2026-10-09. Each upgrade also writes a buffer (the write phase above: the buffer's rent is held
until the upgrade, then refunded to the spill account) and runs one multisig proposal (section 3).
The headroom choice is the owner's (TBA).

`solana program set-upgrade-authority` to the vault: 0.000005000 per program.

## 2. Initialization (once)

| Transaction | Accounts created (bytes) | Compute units | SOL |
|---|---|---|---|
| Squads `multisig_create_v2`, 2 of 3, time lock, autonomous (mainnet creation fee read 2026-10-10: 0 lamports) | multisig (231) | 18,001 | 0.001833720 |
| `lineage_registry::initialize` (admin = vault) | Config (285), five token vaults (165 each) | 125,141 | 0.009545240 |
| Meteora DBC `create_config` | DBC config (1,048) | 31,414 | 0.005984080 |
| Compute sink: the vault's `$LINE` token account | token account (170) | 17,217 | 0.001518840 |
| `lineage_launch::initialize_launch` (admin = vault) | LaunchConfig (319) | 36,276 | 0.002275760 |
| `lineage_msg::initialize` (admin = vault) | MsgConfig (58) | 27,704 | 0.000949880 |
| Launch lookup table, create + extend (11 addresses) | table (408) | 19,509 | 0.002727880 |
| Launch lookup table, freeze | | 1,517 | 0.000005000 |
| `set-upgrade-authority` x 3 | | | 0.000015000 |
| **Total (deployer)** | | | **0.024855400** |

Paid by the vault inside its first two proposals: BountyConfig (76 bytes) 0.001036320, ChallengeConfig
(78) 0.001046480 and the challenge bond vault (165) 0.001488440; the vault itself must stay
rent-exempt (0 bytes, 0.000650240).

The stand-in quote mint (Token-2022 with metadata, 398 bytes, 0.002682080, and its holder's token
account 0.001518840) stands in for `$LINE`, which does not exist yet. The real mint's creation cost
depends on how it is minted (TBA).

## 3. One admin action through the multisig

| Step | Who | SOL |
|---|---|---|
| Create the vault transaction and its proposal (one transaction) | proposing member | 0.003581320 to 0.005399960 measured (the vault transaction holds the whole message: 90 to 448 bytes; the proposal is 358 bytes) |
| Approve (each of 2) | member | 0.000005000 |
| Execute after the time lock | member | 0.000005000 (27,698 to 71,475 compute units) |

The multisig's rent collector is the vault, so the two proposal accounts' rent can be reclaimed to the
vault after execution with Squads' close instructions (not exercised in the rehearsal).

Measured per action (create transaction): set_bounty_config 0.004739560, set_challenge_config
0.005399960, registry set_config 0.005130720, set_launch_config 0.005029120, messages set_config
0.004475400, pause and unpause 0.004231560 each, set_epoch_cursor 0.004389040, Squads time lock change
0.003581320, program upgrade 0.005044360, graduate_by_admin 0.005399960.

## 4. Per use

| Action | Payer | Accounts created (bytes) | Compute units | SOL |
|---|---|---|---|---|
| One launch (`launch_agent`, one transaction, 3 signatures) | launcher | 7: Agent (401), AgentLaunch (554), DBC pool (424), agent mint (376), three token accounts (165: the pool's two vaults and the compute vault) | 167,600 and 158,600 | **0.015996680** |
| A trader's token account for an agent token | trader | token account (170) | 37,333 for two | 0.001513840 each |
| A DBC buy or sell | trader | | 34,055 to 38,803 | 0.000005000 |
| `crank_fees` | anyone | | 70,087 to 71,587 | 0.000005000 |
| Meteora `migration_damm_v2` (permissionless, 3 signatures) | whoever calls it | 6: DAMM v2 pool (1,112), position (408), position NFT mint (465), three token accounts (165: the NFT account and the pool's two vaults) | 147,581 and 162,581 | **0.016514840** |
| `graduate` | anyone | | 21,341 | 0.000005000 |
| A DAMM v2 trade | trader | | 19,241 | 0.000005000 |
| `crank_pool_fees` | anyone | | 74,343 | 0.000005000 |
| Register a verifier (2 signatures) | owner | Agent (401) | 29,669 | 0.002697320 |
| `bond`, `split` | owner, anyone | | 25,567, 41,439 | 0.000005000 each |
| **One epoch post** (`post_epoch`) | Core authority | Epoch (165) | 52,221 | **0.001493440** |
| **One challenge** (`open_challenge`, 2 signatures) | challenger's payer | Challenge (252), ChallengeGate (30) | 58,194 | **0.002743040** plus the bond in `$LINE` (TBA) |
| `resolve_challenge` | Core authority | | 43,160 | 0.000005000 |
| **One claim** | anyone | ClaimReceipt (128) | 75,173 and 76,960 | **0.001305480** |

The Core authority's running cost is one epoch post per epoch (0.001493440 each), the resolutions it
sends and the slashes it posts; the hosted runtime's is its usage posts and debits (not measured
here). Both are hot keys funded separately from the multisig.

## What the owner still sets (TBA)

Priority fee policy; `--max-len` headroom; the real `$LINE` mint; every protocol parameter (the fork
used the shape of `config/network.json` with `epoch_length_s` 300, the devnet TEST caps and the
standard TEST curve); the multisig members, threshold and time lock (the fork used 2 of 3 with 20 s,
then 25 s, so the run finishes); the challenge window and bond.
