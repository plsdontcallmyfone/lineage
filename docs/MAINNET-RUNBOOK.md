# Mainnet runbook (M5)

Written 2026-10-10. Nothing has been deployed to mainnet. Every step below has been run, in this
order, on a local fork of mainnet with mainnet's own pump.fun (Pump, PumpSwap, Pump Fees, Mayhem),
Token-2022 and Squads v4 builds (`scripts/mainnet/rehearsal.ts`, record `scripts/mainnet/REHEARSAL-LAST.json`,
102 of 102 checks on the `--features mainnet` pump.fun builds deployed at the mainnet ids, 2026-10-10).
Agent tokens launch on pump.fun only (owner decisions 2026-10-10, docs/plans/PUMPFUN-LAUNCHES.md section 12). Costs: [MAINNET-COSTS.md](MAINNET-COSTS.md). Powers: [AUDIT.md](AUDIT.md) "Powers" and the
section below. The owner runs the mainnet steps; this lane never sent a mainnet transaction.

## Go / no-go

Owner items stay unchecked until the owner checks them.

- [ ] External audit done, findings fixed and the fixed builds re-rehearsed (docs/audit/)
- [ ] Multisig signers set: members, threshold and time lock (`launch-params.json` `multisig`)
- [ ] Token parameters set: the `$UNITS` mint and decimals, every SPEC 13 parameter (`network_file`), rebate and debit caps, message caps, bounty and challenge values, `pump_creator_fee_bps` (0n: pump.fun's default, owner decision 2026-10-10)
- [ ] **The official `$UNITS` mint is `GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump`** (owner, 2026-10-12): a pre-generated pump.fun address, recorded in `config/profile.json` mainnet `quote.units_mint` with `units_mint_status` reserved. **It is not created yet** (no account at it on mainnet on 2026-10-12), so nothing uses it: the profile's quote in use stays the PYUSD stand-in and the parser refuses a reserved mint as the quote or as live. When the owner says it is live, run `bun scripts/mainnet/units-mint-check.ts` (read only; exit 0 only when the mint exists, is a pump.fun coin paired with SOL or USDC, not mayhem, and `Global.max_curve_depth` is 1 or more), then set `quote.mint` to it, `quote.status` and `units_mint_status` to live, `config/swap.json` `target_mint`, and `line_mint` in `$PARAMS`. `initialize.ts` on mainnet refuses any other `line_mint` than the profile's `units_mint` and refuses while the mint has no account.
- [ ] **Hard requirement: `$UNITS` is a pump.fun coin paired with SOL or USDC and never mayhem mode.** A mayhem coin, or a coin itself quoted in a pump coin, cannot be the quote of a pump.fun custom pair (`QuoteBondingCurveNotEligible`, `CurveDepthExceeded`), so no agent could launch. `initialize.ts` refuses any other `$UNITS` (it reads its bonding curve). While `$UNITS`'s curve is complete but not yet migrated, launches fail with `QuoteCurveAwaitingMigration` (anyone can run `migrate_v2`); after it migrates, add `line_pool` to `$PARAMS` and make a launch table that names it.
- [ ] pump.fun's `Global.max_curve_depth` still 1 or more on launch day (0 disables pump-coin quotes; read 1 on 2026-10-10), and pump.fun's governance and terms risk accepted (docs/plans/PUMPFUN-LAUNCHES.md D7)
- [ ] Legal review done
- [ ] Budgets set: SOL for the deploy (10.690668280 held at the peak with exact-size ProgramData, MAINNET-COSTS.md), the priority fee policy, the `--max-len` headroom, the Core and runtime hot keys' running SOL, the runtime's model spend caps
- [ ] Domain set
- [ ] Verifiers recruited (the minimum independent count is in the M4 server layout)
- [x] Program ids decided: fresh mainnet ids (owner decision 2026-10-10; see "Program ids" below)
- [ ] The three mainnet program id keypairs backed up offline by the owner (see "Program ids")
- [x] A1-08 per agent, per epoch slash cap decided and built (owner decision 2026-10-10, docs/AUDIT.md A1-08)
- [ ] The mainnet slash cap value (`set_slash_cap` through the vault; `initialize` sets strike_limit x the largest share)

Engineering items, with their evidence:

- [x] Fork rehearsal PASS 102/102 on the `--features mainnet` pump.fun builds, deployed at the mainnet ids with the mainnet id keypairs on the local fork only (`scripts/mainnet/REHEARSAL-LAST.json`, 2026-10-10; earlier 97/97 on the Meteora builds and 80/80 on devnet-id builds)
- [x] pump.fun flows on the fork with mainnet's programs: launches with `register_pump_launch` in the `create_v2` transaction and the 1% initial buy, curve and PumpSwap trades, `multi_hop_swap` from SOL, keeper cranks with exact splits, completion, `migrate_v2` + `record_pump_graduation` (`scripts/mainnet/pump-fork-proof.ts` 28/28 before the program change and the rehearsal after it)
- [x] The A1-08 slash cap on the fork: default 7,500 bps from `initialize`, set to 2,500 through the vault (propose, 2 approvals, time lock, execute), one slash landed, the next in the same chain epoch refused whole (`SlashCap`)
- [x] LiteSVM 69/69 against mainnet's pump.fun builds (dumps pinned by sha256, step 0 below)
- [x] Every onchain admin action proven through a 2-of-3 Squads vault with a time lock, including a program upgrade
- [x] The operator commands proven on the same fork after the rehearsal, under `UNITS_NETWORK=mainnet`: `propose.ts` proposed, approved (2 of 3), was refused before the time lock (6021) and executed a `registrySetSlashCap` 5,000 after it (proposal 13, read back 5,000); `initialize.ts init` re-ran on the initialized state and skipped every step (8 checks PASS, nothing sent) and `check` passed 7/7; under `UNITS_NETWORK=devnet` the same `check` refused (no program at the devnet registry id) (earlier, on the devnet-id run: a `msgSetConfig` through `propose.ts`, 16 checks PASS)
- [ ] The rehearsal re-run on launch day (pump.fun upgrades its programs often: `vendor/pump/fetch.sh` fails its hash check when they did; rerun the suite and the rehearsal on the new builds)
- [ ] Mainnet mode in the app and services (M3) and server hardening (M4)

## Roles after the handover

| Role | Holder | Notes |
|---|---|---|
| Upgrade authority, all three programs | Squads v4 vault | moved from the deployer right after initialization (step 6) |
| Registry admin (`Config.admin`) | the vault | set at `initialize`; the deployer never holds it |
| Launch admin (`LaunchConfig.admin`, also bounty config) | the vault | set at `initialize_launch` |
| Messages admin (`MsgConfig.admin`) | the vault | set at `units_msg::initialize` |
| Compute sink | the vault's `$UNITS` token account | audit A1-11: not the runtime's own account |
| Multisig config authority | none (autonomous) | member, threshold and time lock changes go through the same proposals and time lock |
| Multisig rent collector | the vault | executed proposals' rent can be reclaimed to it |
| Core authority (`Config.core_authority`) | hot key on the Core server | scoped below; the vault rotates it with `registrySetConfig` |
| Runtime authority (`LaunchConfig.runtime_authority`) | hot key on the runtime server | the vault rotates it with `launchSetConfig` |
| Deployer | hot key, temporary | pays the deploys and initializers; holds nothing after step 6 |
| Core's offchain admin key (`/v1/admin/*`) | hot key on the Core server | signs HTTP requests (hidden list, models, recipes, findings, epoch close); moves no funds and is not onchain, so it is not behind the multisig |

### The Core authority's scoped powers

From the A1 powers table, checked against the code paths the rehearsal ran:

- `post_epoch`: only the next epoch (exactly last + 1), clocked (epoch `anchor + k` not before
  `anchor_ts + (k - 1) x epoch_length_s`), paying at most the pool vault's balance plus a rebate of at
  most `max_rebate_per_epoch` from the reserve. It pays only through Merkle claims, which wait out the
  challenge window.
- `slash`: any agent, any offence, any epoch, each slash id once (`SlashReceipt`), at the configured
  shares; the slashed tokens go to the reserve, from where they leave only at the rates above.
- `resolve_challenge`: outcomes, bond returns, rewards capped at `max_rebate_per_epoch` per
  `epoch_length_s` (A1-05), slash reversals, and root corrections only while an epoch has no claim.
- It cannot change any config, pause, upgrade, move a bond directly, touch compute vaults, escrows or
  fee positions, or post out of sequence. If the key leaks, the vault rotates it (`registrySetConfig`
  naming a new Core authority) and can pause the registry (`registryPause`); worst case before that is
  bounded per epoch by the pool vault plus `max_rebate_per_epoch` (twice that with challenge rewards)
  and by slashes up to `max_slash_bps_per_epoch` of each agent's bond per chain epoch (A1-08).

## Program ids

Owner decision 2026-10-10: **fresh mainnet ids**, selected at build time (SPEC 14.11). The default
build declares the devnet ids; `cargo build-sbf --features mainnet` declares the mainnet ids, and
`units_launch` and `units_msg` forward the feature so all three agree. `onchain/Anchor.toml`
`[programs.mainnet]`, `packages/chain` `PROGRAM_IDS.mainnet` and `config/profile.json`
`profiles.mainnet.programs` carry them.

| Program | Mainnet id | Keypair (mode 600, never committed) |
|---|---|---|
| `units_registry` | `3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay` | `~/.config/lineage/mainnet/registry-program-keypair.json` |
| `units_launch` | `2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq` | `~/.config/lineage/mainnet/launch-program-keypair.json` |
| `units_msg` | `jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky` | `~/.config/lineage/mainnet/msg-program-keypair.json` |

Made 2026-10-10 with `solana-keygen new --no-bip39-passphrase` on the development machine; only the
public keys were printed. They exist only there: **the owner must back the three files up offline**
(for example on encrypted removable media kept apart from the machine) before anything depends on
them. A program id keypair has no power after the first deploy, but until then anyone holding it
could deploy first at that address, and losing it before the deploy means new ids and a new build. So
keep the copies offline and deploy soon after the audit.

`cargo build-sbf` writes throwaway `lineage_*-keypair.json` files into its `--sbf-out-dir` when none
exist there; those are not the mainnet ids. Delete them after a mainnet build and always deploy with
`--program-id ~/.config/lineage/mainnet/<p>-program-keypair.json`.

The devnet id keypairs stay in `onchain/target/deploy/` (copies in `onchain/keys-backup/`,
`~/.config/lineage/program-keys/` and `~/.config/lineage/devnet-program-keypairs-backup/`).

**Which ids the code uses.** Every `packages/chain` instruction builder, PDA helper and reader uses
the active network profile's ids (`packages/chain/src/programs.ts`): devnet until a profile is
applied, then the profile's `programs` (Core, the indexer, the runtime and the web server apply it at
start with `applyNetworkProfile`; the wallet applies the page's `/chain/config` profile). The
`scripts/mainnet` commands take the active profile too, so they run with `UNITS_NETWORK=mainnet`
(set once in "Steps" below); `initialize.ts` and `propose.ts` print the ids they use, refuse a
mainnet endpoint under any other profile, and refuse when the profile's programs are not deployed
at the endpoint. No script names an id.

The fork rehearsal deploys the `--features mainnet` builds (`onchain/target/mainnet`) at the mainnet
ids with these keypairs, by the same write-buffer and deploy commands as step 3, on the local fork
only (`fork.sh` no longer preloads any units program). The keypairs signed nothing anywhere else.

## Steps

Variables used below. Every key is passed explicitly; never `solana config set`; never print `RPC`.

```sh
cd ~/lineage
set -a; . ~/.config/lineage/mainnet-rpc.env; set +a   # RPC=<keyed mainnet URL>, mode 600, never printed
K=~/.config/lineage/mainnet                            # deployer.json, ms-create.json (mode 600)
PARAMS=scripts/mainnet/launch-params.json              # copied from launch-params.example.json, every TBA filled
FEE=--with-compute-unit-price=<owner's price>          # priority fee, TBA
export UNITS_NETWORK=mainnet                         # scripts/mainnet take the program ids from the mainnet profile
```

### 0. Preflight (no mainnet transaction)

```sh
df -h /                                                         # at least 5 GB free
cp onchain/target/deploy/*-keypair.json ~/.config/lineage/program-keys/   # devnet id keypairs: backup before any build
ls -l ~/.config/lineage/mainnet/*-program-keypair.json          # the mainnet id keypairs (and the owner's offline copies)
cd onchain
for p in units-registry units-launch units-msg; do
  cargo build-sbf --offline --manifest-path programs/$p/Cargo.toml --features mainnet --sbf-out-dir target/mainnet; done
rm -f target/mainnet/*-keypair.json                             # throwaway keypairs cargo build-sbf wrote; not the mainnet ids
shasum -a 256 target/mainnet/*.so && wc -c target/mainnet/*.so  # compare with the audited mainnet hashes (docs/audit/BUILD-AND-TEST.md)
vendor/pump/fetch.sh                                            # mainnet pump.fun programs and accounts; the suite fails its hash check if pump.fun redeployed
cargo test --offline -p lineage-onchain-tests                   # 69 tests on mainnet's pump.fun builds
cd .. && bun test packages/chain
# the full rehearsal on a fresh fork (throwaway keys; the mainnet id keypairs deploy the mainnet builds on the fork only;
# ports 9690-9693 and 9700-9730, checked free by fork.sh)
mkdir -p -m 700 /tmp/lin-fork-keys
scripts/mainnet/fork.sh /tmp/lin-fork-ledger > /tmp/lin-fork.log 2>&1 & echo $! > /tmp/lin-fork.pid
UNITS_NETWORK=mainnet MAINNET_FORK_KEYS=/tmp/lin-fork-keys bun scripts/mainnet/rehearsal.ts   # must end PASS
kill "$(cat /tmp/lin-fork.pid)" && rm -rf /tmp/lin-fork-ledger   # by its PID, then delete the ledger
bun scripts/mainnet/initialize.ts check --params $PARAMS --multisig 11111111111111111111111111111111 --rpc "$RPC" --mainnet 2>&1 | head -1   # refuses while any value is TBA
solana balance -u "$RPC" -k $K/deployer.json                     # at least the MAINNET-COSTS.md peak plus priority fees
for id in 3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay 2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky; do solana program show -u "$RPC" $id; done   # must not exist yet
```

### 1. Keys

The deployer and the multisig create key are fresh keys made on the machine
that sends (`solana-keygen new -o $K/<name>.json`, mode 600). The Core authority and runtime authority
are made on their servers; only their public keys go into `$PARAMS`. Multisig members bring their own
keys (hardware wallets through the Squads app work: the vault transactions are standard).

### 2. The multisig

```sh
bun scripts/mainnet/initialize.ts multisig --params $PARAMS --payer $K/deployer.json --create-key $K/ms-create.json --rpc "$RPC" --mainnet
# prints {"multisig": ..., "vault": ...}; MS=<multisig>, VAULT=<vault>
solana transfer -u "$RPC" -k $K/deployer.json --allow-unfunded-recipient $VAULT 0.01   # rent for the configs the vault creates (0.004221480 measured) plus margin
```

### 3. Deploy

```sh
for p in registry launch msg; do
  solana program deploy -u "$RPC" -k $K/deployer.json --fee-payer $K/deployer.json --upgrade-authority $K/deployer.json \
    --program-id ~/.config/lineage/mainnet/$p-program-keypair.json --max-len <owner's max-len for $p> $FEE onchain/target/mainnet/lineage_$p.so
done
# an interrupted deploy: solana program show -u "$RPC" --buffers -k $K/deployer.json; resume with --buffer, or close the buffer
for id in 3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay 2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky; do
  solana program dump -u "$RPC" $id /tmp/$id.so && shasum -a 256 /tmp/$id.so; done   # equal to the builds once trailing zero padding is trimmed
```

### 4. `$UNITS` on pump.fun

`$UNITS` launches on pump.fun before step 5 (the owner's launch): `create_v2` paired with SOL or USDC,
never mayhem mode, at the reserved mint `GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump` (the owner holds
its keypair). Check it with `bun scripts/mainnet/units-mint-check.ts`, then its mint goes into
`$PARAMS.line_mint` (Token-2022, 6 decimals) and the profile (go/no-go above). The curve, supply
and fees are pump.fun's. `$UNITS`'s own creator fees are paid in SOL or USDC, not in `$UNITS`
(PUMPFUN-LAUNCHES.md 6.9).

### 5. Initialize (admin = the vault from the first instruction)

```sh
bun scripts/mainnet/initialize.ts init --params $PARAMS --payer $K/deployer.json --multisig $MS \
  --priority-micro-lamports <price> --rpc "$RPC" --mainnet
# prints the launch lookup table address; re-running with --lookup-table <it> resumes without a second table
```

This checks `$UNITS` is a pump.fun coin paired with SOL or USDC and not mayhem, then runs `units_registry::initialize`, the compute sink account,
`initialize_launch`, `units_msg::initialize` and the launch lookup table (create, extend, freeze),
each read back.

### 6. Hand the upgrade authority to the vault

```sh
for id in 3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay 2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky; do
  solana program set-upgrade-authority -u "$RPC" -k $K/deployer.json $id --upgrade-authority $K/deployer.json \
    --new-upgrade-authority $VAULT --skip-new-upgrade-authority-signer-check; done
```

The vault is a PDA and cannot sign the checked variant, hence the flag; step 7 reads the result back.

### 7. Check the handover

```sh
bun scripts/mainnet/initialize.ts check --params $PARAMS --multisig $MS --rpc "$RPC" --mainnet
```

Every admin field and every upgrade authority must read as the vault.

### 8. First proposals: bounty and challenge configs

Each member proposes, approves and executes with `scripts/mainnet/propose.ts` or in the Squads app.
Argument files hold the action's argument object (u64 values as strings with an `n` suffix).

```sh
bun scripts/mainnet/propose.ts propose --multisig $MS --member <member key> bountySetConfig bounty.json --rpc "$RPC" --mainnet
bun scripts/mainnet/propose.ts approve --multisig $MS --member <member key> --index <i> --rpc "$RPC" --mainnet   # by threshold members
bun scripts/mainnet/propose.ts status  --multisig $MS --index <i> --rpc "$RPC" --mainnet                        # Approved since <time>
bun scripts/mainnet/propose.ts execute --multisig $MS --member <member key> --index <i> --rpc "$RPC" --mainnet   # after the time lock
# then challengeSetConfig with [mint, token program, args] in its file
```

`propose.ts print` shows the inner instructions without sending, for members who check them first.

### 9. Services

Switch Core, the indexer, the runtime and the app to the mainnet profile (M3), with the Core and
runtime authorities funded for their posts. The Core authority's first `post_epoch` sets the epoch
anchor.

### 10. First launch

One launch through `/launch` (0.016255680 SOL measured for the launcher on the fork, plus the 1%
initial buy and the prepaid credits in `$UNITS`; the wallet must sign v0 transactions), a buy, a
keeper crank (pump.fun sweep + collect, then `crank_pump_fees`), and the indexer and app reading them
back. Mainnet tests are public on pump.fun's own site: the hidden list cannot hide them, so test there
only what the fork cannot show.

## UNITS fee keeper

Owner decision 2026-10-12: "50% of creator fees goes to paying for compute and 50% buyback and
burns". This is about the `$UNITS` coin's own pump.fun creator fees, paid in SOL to the wallet that
creates the coin. It is separate from the split of each agent coin's fees, which `crank_pump_fees`
does on chain. No program is involved: `packages/fee-keeper` is an off-chain keeper that signs with
the `$UNITS` creator wallet's key.

One run (`units-fee-keeper.timer`, every 10 minutes once enabled):

1. **Collect.** On the curve the fee waits in the bonding curve: Pump `sweep_creator_fee` moves it to
   the creator vault and `collect_creator_fee` pays the wallet what the vault holds above its
   rent-exempt minimum. After graduation the pool's fee is wrapped SOL: PumpSwap `sweep_creator_fee`,
   then `collect_coin_creator_fee` into a temporary wrapped SOL account that the same transaction
   closes, so it arrives as SOL; what the curve still held is collected in the same transaction.
2. **Split.** What the collection brought the wallet (after its own fee and rent) first refills the
   fee reserve to `fee_reserve_lamports`; the rest is split by `compute_bps` and `burn_bps`. Each
   share is rounded down and an odd lamport stays in the reserve, so at 5000/5000 the shares are equal.
3. **Compute.** The compute share is sent as SOL to `compute_address`.
4. **Buy back and burn.** One buy of at most `max_buyback_lamports` (the curve, or the PumpSwap pool
   after graduation), for exactly the amount quoted from chain right before sending, capped at the
   budget, and burned in the same transaction. A larger share is spent over the next runs.

It never touches the wallet's own `$UNITS`. The creator wallet's associated token account holds the
owner's coins; the keeper buys into and burns from a token account of its own (the wallet's seeded
account `units-fee-keeper-burn`, created by the first buy, its rent paid from the fee reserve) and
names the associated account in no transaction. Right before signing, the keeper reads the
instructions of the transaction it built and refuses it (exit status 2, nothing signed) if any of
them names the wallet's own account, if anything but its own buy, burn or account creation touches
the burn account, if a burn in a buy's transaction is not of exactly what that buy asks for, or if
the wallet's own account holds less than `protected_units`. A burn sent apart from its buy is sent
only while the burn account holds at least what it held before those buys (`burn_floor` in the state
file) plus what is owed (`burn_owed`); otherwise it is skipped with the figures and the debt is kept.
A state file with a `burn_owed` and no `burn_floor` (written before the field existed) burns nothing
until an operator, with the timer stopped, adds `"burn_floor": "<n>n"` to the state file, `<n>` being
the base units in the burn account that the keeper did not buy (`"0n"` when there are none).

It never spends the wallet's own SOL: transaction fees and one-off account rent come out of the fee
reserve, and a transaction the reserve does not cover is not sent. Before a transaction is sent its
signed bytes are written to the state file; an interrupted run resends those bytes or books their
result, and never builds a second transaction for the same step.

Config (`/etc/units-fee-keeper/config.json`, from `config/fee-keeper.example.json`; public values
only; every field is the owner's and is read again on each run, none has a default):

| Field | Meaning |
|---|---|
| `enabled` | mainnet sends need `true` here and the `--send` flag |
| `rpc_url` | RPC endpoint, or `null` with `UNITS_FEE_KEEPER_RPC` in `/etc/units-fee-keeper/keeper.env` (a keyed URL is a secret; it is never printed) |
| `mint` | the `$UNITS` mint; on mainnet it must be the one in `config/profile.json` |
| `creator` | the wallet that created the coin; must be the curve's creator on chain |
| `key_path` | that wallet's Solana CLI keypair file; `null` allows dry runs only |
| `compute_address` | where the compute share goes; a wallet (System-owned), not the creator |
| `compute_bps`, `burn_bps` | the split; must sum to 10000 (5000 and 5000 by the owner's decision) |
| `fee_reserve_lamports` | the float kept from collected fees for the keeper's fees and rent |
| `min_collect_lamports` | a collection is sent only when it brings at least this much after its cost |
| `min_buyback_lamports`, `max_buyback_lamports` | the smallest and largest SOL amount of one buyback transaction |
| `slippage_bps` | the most a buy may pay above the price read from chain (refused above 1000) |
| `protected_units` | base units of `$UNITS` (6 decimals) in the wallet's own token account that are the owner's; the keeper signs nothing while that account holds less. `"25000000000000"` (25,000,000 coins) in `config/fee-keeper.official.json`; the owner changes it whenever the wallet's own holdings change. Required: a config without it does not load |
| `priority_fee` | percentile of recent fees, with a floor and a cap in micro-lamports per compute unit |
| `confirm_timeout_s` | how long a run waits for a transaction before the next run takes over |
| `state_path`, `log_path` | the private state and the public log |

The key: the keeper needs the `$UNITS` creator wallet's key because buying, burning and sending the
compute share are that wallet's transactions (pump.fun's collect itself needs no signature, and pays
only the creator). Whoever holds it can spend what is in the wallet, so the wallet should hold
nothing but the fees: the keeper sends the compute share out on the run that collects it. Refusals,
before anything is signed: the curve's creator, the key, the pair (SOL), the pool's coin creator, a
compute address that is a program or not a wallet, a state file of another coin or wallet, mainnet
without `enabled: true`.

Measured on a fork of mainnet (`scripts/mainnet/fee-keeper-fork.ts`, `FEE-KEEPER-FORK-LAST.json`,
33/33; mainnet's own Pump and PumpSwap builds), fees at 1 micro-lamport per compute unit. Compute
units move by a few thousand from one coin and wallet to another (address derivation); the keeper
sets each transaction's limit from its own simulation plus 20%, at most 400,000:

| Transaction | Bytes | Compute units | One-off cost paid by the wallet |
|---|---|---|---|
| collect on the curve | 610 | 49,990 first, 48,040 after | first sweep: 890,880 lamports stay in the creator vault as its rent |
| compute transfer | 267 | 450 | none |
| buy on the curve + burn | 801 first, 759 after | 80,494 first, 57,457 after | first buy: the wallet's `$UNITS` token account 2,074,080 and Pump's volume account 1,844,400 lamports |
| collect after graduation (curve leftover + pool) | 1,066 | 139,035 | first pool sweep: 2,039,280 lamports for the PumpSwap creator vault's token account |
| buy on the pool + burn | 916 | 75,623 | first pool buy: PumpSwap's volume account 1,844,400 lamports |

The two buy rows were measured before the keeper bought into its own burn account and have not been
measured again on the fork (rerun `scripts/mainnet/fee-keeper-fork.ts`). Since then the first buy
creates the burn account (a 165-byte token account, 2,039,280 lamports of rent) in place of the
associated account, and the transactions built from the recorded snapshots are 915 bytes (first curve
buy + burn), 759 (later curve buys), 1,072 (a pool buy that creates the burn account) and 916 (later
pool buys); their compute units are not measured yet.

So `fee_reserve_lamports` must cover the first buy's 3,918,480 lamports of rent plus fees, and
`min_collect_lamports` must exceed the first sweep's rent, or those steps wait. A pool buy also needs
the budget plus 2,039,280 lamports in the wallet for the length of the transaction (the temporary
wrapped SOL account's rent, returned when it closes).

Dry run (the default; reads the chain, simulates every transaction, prints the plan, signs and sends
nothing, writes nothing; works without the key). The later steps are simulated against the wallet as
it is now, before the collection lands: with a wallet that holds less than they move, their
simulations report insufficient funds while the collect's own simulation still shows what would come in:

```sh
bun packages/fee-keeper/src/main.ts --config /etc/units-fee-keeper/config.json          # add --json for the full plan
```

Turn it on, on the server, after `$UNITS` exists (step 4) and a release with the unit is deployed:

```sh
sudo bash /opt/units/current/scripts/deploy/fee-keeper-setup.sh      # account units-fee-keeper, /etc/units-fee-keeper, /var/lib/units/fee-keeper
# put config.json (creator, compute_address, limits), creator.json (the key) and keeper.env there, then run the setup again: it fixes owners and modes
sudo -u units-fee-keeper bash -c 'set -a; . /etc/units-fee-keeper/keeper.env; cd /opt/units/current && bun packages/fee-keeper/src/main.ts --config /etc/units-fee-keeper/config.json'   # dry run as the service account
# set "enabled": true in config.json, then:
sudo systemctl start units-fee-keeper.service && journalctl -u units-fee-keeper -n 40   # one run by hand
sudo systemctl enable --now units-fee-keeper.timer
```

`remote.sh` installs the unit and the timer with every release and enables neither. Turn it off with
`systemctl disable --now units-fee-keeper.timer` or `"enabled": false`. The public record is
`log_path`: one JSON line per run that moved something (time, lamports collected, compute lamports
and signature, SOL spent on the buyback, `$UNITS` bought and burned with signatures). Core serves its
sums and last runs read-only at `GET /v1/units-fees` (the log's path is `UNITS_FEES_LOG`, default
`/var/lib/units/fee-keeper/public/runs.jsonl`). No page shows it yet.

Limits to know: fees someone else collects to the wallet (pump.fun's collect is permissionless) are
outside the keeper's ledger and stay in the wallet; the keeper's own buys pay the creator fee like any
trade, which comes back in the next collection; a buy that would complete the bonding curve is not
sent, and no buy is sent between completion and migration; the builders trade `create_v2` (Token-2022)
coins. Not proven on mainnet: nothing was sent there. Exit status 2 means refused, 3 a transaction
still unconfirmed (the next run settles it).

## Later admin actions

Every onchain admin action is in `scripts/mainnet/admin.ts` `adminActions` and goes through propose,
approve to the threshold, wait out the time lock, execute:

| Action | Program | What it changes |
|---|---|---|
| `registrySetConfig` | registry | admin, Core authority, launch program, SPEC 13 parameters, `max_rebate_per_epoch` |
| `registryPause` | registry | pause or unpause |
| `registrySetSlashCap` | registry | the per agent, per epoch slash cap, `max_slash_bps_per_epoch` (A1-08; args `[<bps>]`) |
| `registrySetEpochCursor` | registry | the epoch sequence and clock anchor (repair only) |
| `challengeSetConfig` | registry | challenge window, bond, reward, timeout, pause of new challenges |
| `launchSetConfig` | launch | admin, runtime authority, compute sink, fee split, sleep and wake thresholds, pause, debit cap, `pump_creator_fee_bps` (the rate new pump.fun launches must carry; pump.fun accepts 1 to `Global.max_configurable_creator_fee_bps`, 300 on 2026-10-10, only while `creator_fee_configurable`) |
| `bountySetConfig` | launch | bounty caps, TTLs, grace, minimum, pause |
| `msgSetConfig` | messages | caps, sizes, pause, admin |
| `upgradeProgram` | loader | replaces a program's code from a buffer whose authority is the vault |
| `setUpgradeAuthority` | loader | moves the upgrade authority, or with null makes a program immutable |

Squads' own config (members, threshold, time lock) goes through `proposeConfig` in `admin.ts` (the
rehearsal changed the time lock this way). An upgrade:

```sh
solana program write-buffer -u "$RPC" -k $K/deployer.json --buffer-authority $K/deployer.json onchain/target/mainnet/lineage_<p>.so   # a --features mainnet build
solana program set-buffer-authority -u "$RPC" -k $K/deployer.json <buffer> --buffer-authority $K/deployer.json --new-buffer-authority $VAULT
# if the program grew: solana program extend <id> <bytes> (anyone may pay)
bun scripts/mainnet/propose.ts propose --multisig $MS --member <key> upgradeProgram upgrade.json --rpc "$RPC" --mainnet   # {"program":..., "buffer":..., "spill":...}
```

## Needs a program change (not done in this lane)

Both items listed here were done by the pre-audit program changes lane on 2026-10-10 (`9f70357`):

- **Fresh program ids**: built by cargo feature (see "Program ids"); the builders and the mainnet
  scripts take them from the active network profile, and the fork rehearsal ran on them (same section).
- **A1-08 slash cap**: `max_slash_bps_per_epoch` (docs/AUDIT.md A1-08). `initialize` sets
  `min(10,000, strike_limit x the largest slash share)`; the vault edits it with `set_slash_cap`
  (`registrySetSlashCap` in `scripts/mainnet/admin.ts`, a vault transaction like the other admin
  actions). The value is the owner's.

## Notes from the rehearsal

- The suites and the rehearsal run mainnet's own pump.fun builds; devnet's Pump build differs (it
  refused a coin quoted in a freshly launched UNITS with `QuoteReservesOutOfRange` until UNITS's price
  rose, scripts/devnet/pump-devnet-proof.ts), so devnet is not evidence for mainnet behaviour.
- pump.fun's `migrate_v2` needs two remaining accounts its docs do not list (the pool's boost vault
  authority and its quote account; pump-sdk 4.0.0); `packages/chain` passes them.
- The test validator charges more rent than mainnet (6,960 against 5,080 lamports per byte with the
  overhead); MAINNET-COSTS.md uses mainnet's own figures.
- `set_challenge_config` and `set_bounty_config` create accounts with the admin as payer, so the vault
  pays that rent; fund it before step 8.
- Squads v4's mainnet program config charges no multisig creation fee (read 2026-10-10) and the
  program is immutable (upgrade authority none).

## Go-live (single key, today)

Owner decisions 2026-10-12: no multisig today. The dev wallet `6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3`
is admin and upgrade authority of all three programs and the recipient wherever a wallet is
configurable (compute sink, units account payments, `$UNITS` creator fees). It creates `$UNITS`
(`GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump`) on pump.fun itself, paired with SOL, not mayhem mode:
that is the owner's last manual action. Everything else is `scripts/mainnet/golive.ts`, built so that
as much as possible happens BEFORE the coin exists. Every step is a dry run unless `--send` is given,
reads the chain first and skips what exists, so a stopped step is resumed by running it again.
Values: `scripts/mainnet/official-params.json` (the block `owner_decision` is the owner's; `--send`
refuses while `owner_confirmed` is false). Proof: `scripts/mainnet/golive-fork.ts` on a fork of
mainnet holding the three programs as deployed, record in `scripts/mainnet/GOLIVE-FORK-LAST.json`.
The steps of the multisig path above (2, 5 to 8) are not used today.

Rules built into the tooling: the dev wallet never buys or sells `$UNITS`; exactly one transfer of at
most 5,000,000 `$UNITS` (a constant in the code) leaves it, to the site's verifier owner key, checked
on the transaction's instructions before signing and recorded in `<out>/dev-wallet-transfer.json`
before it is sent, so no re-run can send a second one. The dev wallet must hold those 5,000,000
after creating the coin (5 registration burns of 200,000 and 4 bonds of 1,000,000: the site's
reference runner, v1, v2 and the two capacity server verifiers).

```sh
G="env UNITS_NETWORK=mainnet bun scripts/mainnet/golive.ts"; H=157.245.71.188
O=~/.config/units/mainnet/official          # golive's output directory (public values, the marker)
I="UNITS_INSTANCE=mainnet WITH_RUNTIME=1 WITH_IDENTITY=1 INSTANCE_STATE_FILE=$O/state.json INSTANCE_PROFILE_FILE=$O/profile.local.json INSTANCE_SIZING_FILE=$O/sizing.json"
GO="GO_SWITCH_RUNNING=yes GO_BACKUP_CORE=test-deployment GO_ARCHIVE_INDEXER=test-deployment"   # Core's database kept (copied first), the indexer's set aside

# ---- BEFORE the coin (repeatable; nothing here needs the mint account) ----------------------------------
$G pre --mainnet                    # read only, about 5 s: programs = builds, authority, pump.fun, balances, the site
$G pre --mainnet --send             # about 10 s, 4 transactions: units_msg initialize, the launch lookup table
                                    # (create + extend, freeze), SOL to the Core authority hot key. Writes $O/pre.json
$G switch --pre --mainnet           # 1 s, sends nothing: $O/state.json, profile.local.json, sizing.json at a new
                                    # pump.fun coin's starting price (replaced by the live price at go-live)
env $I STAGE_NEXT=1 scripts/deploy/instance.sh $H stage      # minutes: ships HEAD and the official files beside the
                                    # live ones (/etc/units-main/next); the test deployment keeps running
ssh -i ~/.ssh/lineage_site root@$H systemctl stop units-main-runtime   # shortly before the coin: `go` stops the runtime, the
                                    # indexer and Core, and a runtime with an attempt in flight may take up to 1500 s to stop
bun scripts/identity/ship-pool.ts plan --instance mainnet --all                      # local: which accounts qualify
IDENTITY_POOL_SEND=yes UNITS_INSTANCE=mainnet scripts/deploy/instance.sh $H identity-pool --all   # the GitHub account pool

# ---- the owner creates $UNITS with the dev wallet (and buys at least 5,000,000 with it) -------------------

# ---- AFTER the coin: one trigger, started before the coin is created ------------------------------------
$G watch --mainnet --send --run-site --go-cmd "env $I $GO scripts/deploy/instance.sh $H go"   # polls for the mint; then post-coin preflight, init (2 transactions) and the
                                    # one transfer in parallel, the instance files at the live price, `instance.sh chain`
                                    # (3 registrations, 2 bonds on the server) and `instance.sh go` (activation).
                                    # One "TIME <step>" line per step; on a failure it stops and prints the resume command
$G status --mainnet                 # everything in one screen

# ---- the capacity server's two verifiers (the site is already live on the reference runner, v1 and v2) -----
# 1. the OFFICIAL public overlay on the host before it co-signs, and the host on the instance's release:
scp $O/profile.local.json root@157.230.180.62:/etc/units-cap/profile.local.json
scripts/deploy/capacity-host/provision.sh 157.230.180.62 update        # as the scale-out lane documents (docs/DEPLOY-SITE.md "Adding capacity")
# 2. per verifier (kdhdDrZ8... with /etc/units-cap/verifier.json, HNaVHuqa... with verifier-2.json); R=3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay
#    on the machine that holds the verifier owner key (the site server, as the instance's account with its keyed RPC):
#      bun scripts/deploy/capacity-host/verifier-chain.ts --registry $R --register <agent> --caps-digest aebc08b52831e42cf0cc0abcc499057d883e3ebebfff7f4c14d354e4f124da7c
#    on the host, offline:   bun scripts/deploy/capacity-host/cosign-register.ts --key <key file> --tx <base64>
#    back, within about a minute:   ... verifier-chain.ts --registry $R --send <base64>   then   ... --bond <agent>
# 3. both host verifiers qualify again on every unit: 23 to 165 s per unit on the host (measured by the scale-out lane on the test deployment)
$G switch --mainnet --apply-config --commit && git push      # the repository's default becomes the official deployment
                                    # (config/profile.json mainnet_deployment official, the real quote; config/mainnet/state.json)
```

The same steps one by one, when `watch` is not used or stopped: `$G preflight --mainnet`,
`$G init --mainnet --send`, `$G bond --mainnet --send --wait-s 60`, `$G switch --mainnet`, then
`env $I scripts/deploy/instance.sh $H chain-plan`, `env $I MAINNET_SEND=yes scripts/deploy/instance.sh $H chain`,
`env $I $GO scripts/deploy/instance.sh $H go`.

| Step | Expected output | Measured | If it stops |
|---|---|---|---|
| `pre --send` | `PASS` lines, 4 signatures, `pre done` | 2.6 s on the fork | run it again: it skips what landed (the table address is in `pre.json` before the freeze) |
| `watch`: post-coin preflight | `READY` | under 1 s on the fork | fix what `FAIL` names, run `watch` again |
| `watch`: init + the one transfer | `init 1 of 2`, `init 2 of 2`, `the one transfer from the dev wallet` | about 3 s on the fork | `init --send` finishes whatever is missing (step by step path); `bond --send` reads the marker and the chain and never sends twice |
| `watch`: instance files | `wrote state.json, profile.local.json and sizing.json` | under 1 s | `switch` again |
| `watch`: `instance.sh chain` | 3 `register verifier`, 2 `bond` | about 4 s on the fork (the tool itself; ssh not included) | run `chain` again: registered and bonded verifiers are skipped |
| `watch`: `instance.sh go` | units up, each health-checked, seconds per phase | not measured (never run on the server) | `go` puts the previous state files back when the activation fails; run it again |

Costs measured on the fork at mainnet rent, base fee, no priority fee (`GOLIVE-FORK-LAST.json`
`wallets`): the dev wallet 0.005308360 SOL before the coin and 0.016916240 SOL for init, plus the
one transfer's fee and the owner key's token account, plus the Core authority top-up; the verifier
owner key 0.013506605 SOL for 5 registrations and 4 bonds; one launch through the wizard about 0.2 SOL
with 10 USD of credits.

What the switch does to the site: Core KEEPS its database, so nothing is calibrated or qualified
again. On its first sync against the official registry Core retires the test deployment in one
database transaction (`packages/core/src/deployments.ts`): the units, recipes, calibrations and the
verifiers' qualifications stay; the test agent, its coin (added to the hidden list), its generation
and its open epoch stay in the database with a `retired` marker and leave every listing; no unit,
payout or slash of the test deployment can reach the official registry; Core's first post there is
epoch 1; verifier bonds, vaults and parameters are read again from the new registry. The release
with that change MUST be the one staged: older code would post the test deployment's open epoch to
the official registry. The switch is one-way in the database, so `go` copies it first
(`GO_BACKUP_CORE`). The indexer's database is set aside (`GO_ARCHIVE_INDEXER`): its price samples are
not keyed by coin and it never drops a token. The runtime's state is kept. Rehearse it on the server,
read only, on a copy: `bun scripts/mainnet/golive-core-carry.ts --data /var/lib/units-main/core --chain <chain config>`.
Fallback with a fresh database (recalibration and qualification then take tens of minutes):
`instance.sh $H stop`, `instance.sh $H archive-state test-<date>`, then `go` without the `GO_*` archive variables.

Back to the test deployment, three lines: `UNITS_INSTANCE=mainnet scripts/deploy/instance.sh $H stop`,
`UNITS_INSTANCE=mainnet scripts/deploy/instance.sh $H restore-state test-deployment` (Core's database
from the copy, the indexer's from its archive, the state files and derived configs of before the
switch; what the official deployment wrote goes to `archive/pre-restore-<time>`), and
`UNITS_INSTANCE=mainnet scripts/deploy/instance.sh $H start`. Then `$G switch --rollback --apply-config`
plus a commit if the repository's default was already moved. A second `go` with a label that already
holds those parts is refused: after a failed `go`, retry without the two `GO_*` archive variables. Nothing on chain is undone by this: the official programs stay
initialized, the verifiers stay bonded.

After go-live: `$G switch --rate-only --mainnet` writes the price-dependent values again;
`$G retune --mainnet [--send]` re-resolves the dollar thresholds on chain at today's price. The fee
keeper config for the official coin is `config/fee-keeper.official.json` (creator = the dev wallet,
the owner's compute address, not enabled, no key).

Not proven off the fork: anything on the server (`stage` with `STAGE_NEXT=1`, `chain` there, `go`,
the identity unit on mainnet, the pool shipment), a real Jito bundle, the co-signed registration of
the two capacity server verifiers (their keys never leave that box; the fork used stand-in keys),
priority fees, and `$UNITS` graduating to PumpSwap (the launch lookup table then needs the pool's
addresses: `$G init --mainnet --send --new-table`, then `switch` and `go` again).

## Mainnet test (single key, throwaway quote coin)

Owner decisions 2026-10-11 and 2026-10-12: a small test on real mainnet, to test spawning agents, before
the launch above. It differs from the launch on purpose, and it does not touch the launch's ids or mint:

**It is what the repository runs by default (owner 2026-10-12).** `config/profile.json` says
`"network": "mainnet"` and `"mainnet_deployment": "test"`, which lays `config/mainnet-test/profile.json`
(this deployment's ids, quote coin, state file) over `profiles.mainnet`; a clone needs no environment
variable for it. The launch's own scripts (`scripts/mainnet/steps.ts` and what uses it) always mean the
official deployment, whatever that key says. **Moving the default to the official deployment** once the
launch above is done (programs deployed and initialized, `scripts/mainnet/mainnet.json` written): set
`"mainnet_deployment": "official"` in `config/profile.json`; then, per the note in that file, the quote
block when the official `$UNITS` mint exists, and `config/sites.json` `mainnet_site_url` if the official
backend is another host.

- **Program ids: the test's own.** The cargo feature `mainnet-test` declares three throwaway ids;
  `test.ts close` spends them when the test ends. The launch's mainnet ids (`3GeaTs...`, `2vwKsT...`,
  `jmcb7c...`) are never deployed at: the preflight checks they are still unused.

  | Program | Mainnet TEST id | Keypair (mode 600, never committed) |
  |---|---|---|
  | `units_registry` | `27Y2UyLkuBAdwriNtqro5CJ4MTKjWCoUQywDJKunYBni` | `~/.config/units/mainnet-test/registry-program-keypair.json` |
  | `units_launch` | `CxwvazD6EYoALLfFzBvJk5DWYacgAmrUGGxntmvPLkCT` | `~/.config/units/mainnet-test/launch-program-keypair.json` |
  | `units_msg` | `45TEx2pxSMCKPzLwZsatB62hX6SQndYL29ugcXJWa4ns` | `~/.config/units/mainnet-test/msg-program-keypair.json` |

  Only the `declare_id!` selection differs. Each test id sits at the end of its `lib.rs`, so no line above
  it moves (error sites carry line numbers): the default and `mainnet` builds rebuilt from that tree are
  byte-identical to the ones before the change (default: registry `f42e0586...`, launch `88f447ac...`,
  msg `69d02880...`; mainnet: `ead9e41f...`, `593dff1c...`, `90715f14...`). The test builds
  (`onchain/target/mainnet-test`, `cargo build-sbf --features mainnet-test`): registry `00dc47aa...`
  732,456 bytes, launch `5a7db257...` 685,224, msg `441f105a...` 342,600. A mainnet profile may carry the
  test row of the id table (`MAINNET_TEST_PROGRAM_IDS`, all three together); only the test's local overlay
  does. A closed program id can never be deployed again (on the fork the loader answered `Program ...
  has been closed, use a new Program Id`), which is why the test has its own.
- **Quote token**: a throwaway pump.fun coin created for the test (`create_v2`, SOL-paired, never mayhem
  mode), standing in for `$UNITS`. The official `$UNITS` mint (go/no-go above) is not involved.
- **Admin and upgrade authority**: one key, the deployer `Gb7WNkLH5SeNPbotc9Tn7VUzUfAsfQLZ2Y2fHjL997J4`
  (`~/.config/units/mainnet/deployer.json`), not the Squads vault, so the programs can be closed when
  the test ends and their rent returned.
- **Hot keys**: Core authority `AYsa2Pn2pzH5SeknsA8TZc3ndA9V3oNpau5oFex4yVtu`, runtime authority
  `CCt4EoNuYhVbk4cXUXBzMLQBfshfPF1f5rLyw22S2uXs` and the test coin's mint key
  `C5dYJH9gpLkPrmbWatMhFj2mWGx9pvyRoUenJmFhL6br` (made by `test.ts keys`, mode 600, in
  `~/.config/units/mainnet`; only public keys were printed). The seven key files of the test have
  identical copies in `~/.config/units/mainnet-backup` and `~/.config/units/mainnet-test-backup` (same
  disk: the owner keeps an offline copy too).
- **Site**: a second instance on the devnet server, own host (docs/DEPLOY-SITE.md "Second instance
  (mainnet test)"); the devnet site is not touched. It runs no identity service, so its Core names no
  units account recipient and the wizard does not offer "A units account" there.

Nothing has been sent to mainnet. What was proven, all on the mainnet fork:

- **The operator commands and every instruction** (`scripts/mainnet/test-rehearsal.ts`, record
  `TEST-REHEARSAL-LAST.json`, PASS 48 of 48, 2026-10-12 UTC): `test.ts keys`, `coin`, `deploy` at the test
  ids, `init`, `fund`, `check`; one launch as the wizard plans it (`create_v2` quoted in the test coin +
  `register_pump_launch` + the soul, 1,082 bytes v0; SOL to the test coin on its curve + the 1% initial
  buy + credits and wake + the Jito tip, 1,101 bytes v0; both signed on one blockhash before either is
  sent); a verifier registered and bonded by the site owner key; a SOL trade through both curves and a
  sell; a fee crank with the exact split; a split and an epoch post by the Core authority hot key; then
  `test.ts close`. Costs: [MAINNET-COSTS.md](MAINNET-COSTS.md) "Mainnet test".
- **The browser path in mainnet mode** (`scripts/mainnet/wizard-fork.ts`, record `WIZARD-FORK-LAST.json`,
  PASS 17 of 17): a local Core, indexer, dashboard and gate under the mainnet profile with the test
  overlay and the fork as RPC; headless Chromium with a mock Wallet Standard wallet holding only SOL
  went through the real Launch wizard: the units account option disabled, everything priced in SOL,
  no devnet or TEST wording, the simulation on the mainnet profile, **one approval carrying both
  transactions**, the bundle offered to the Jito endpoint first, and, when it was refused, **the same
  signed transactions sent in order** and the launch on chain (1% initial buy in the agent key's account,
  credits in the vault, awake, soul digest). Then the trade box bought with 0.02 SOL through pump.fun's
  `multi_hop_swap` and received exactly the simulated amount. For fork testing only, the overlay names
  the fork's genesis so every genesis check matches the fork; a wrong genesis on a real endpoint makes
  every check refuse. Jito was a local stand-in that refuses bundles, so no fork transaction went to
  Jito.
- **The instance's chain steps and key sweep** in the dry-run container against the fork
  (docs/DEPLOY-SITE.md; dry run 121 of 124, its fork section 16 of 16): `stage`, `chain-plan`, funding
  the owner key, `chain` (three registrations and two bonds, sent with Core stopped), `activate`, then
  `sweep` back to the deployer.

### The one path that cannot be proven off mainnet

A real Jito bundle (all or nothing in one slot). If Jito refuses the bundle or it does not land, the
wizard now says so and sends the same signed transactions one by one in order (a transaction that
already landed is found by its signature and never sent twice); they are then not all or nothing, and
Launch again sends only what is missing. That fallback is what the fork exercised. Also only on
mainnet: landing 1,747 deploy transactions under load (`test.ts deploy` resumes on the same buffer when
run again; `--use-rpc` sends through the RPC instead of TPU), and priority fees (the fork ran at the
base fee; the deploys used 4,141,740 compute units; `preflight.ts --priority-micro-lamports <p>` adds
the bound it uses, 200,000 units per transaction at `p`; the launch's two transactions carry limits of
450,000 and 400,000 units, at most 0.00017 SOL at the profile's cap).

### Preflight

`bun scripts/mainnet/preflight.ts` (read only). On 2026-10-12 UTC: NOT READY, 19 of 21 checks pass;
failing: `UNITS_MAINNET_RPC` is not set, and the deployer holds 0 SOL of the 10.755878239 it needs.
`test.ts` refuses to send on mainnet without `--mainnet` and without a READY preflight of the last 24
hours for the same builds and deployer.

### Phase B, only after the coordinator confirms with the owner

The owner funds the deployer (about 12 SOL: the peak is 10.755878239 at the base fee) and puts
`UNITS_MAINNET_RPC=<keyed mainnet URL>` into `~/.config/units/rpc.env` (mode 600). Then, in order; every
command reads the chain first and skips what is done, so a stopped run resumes:

```sh
cd ~/units
export UNITS_NETWORK=mainnet
P=<priority fee in micro-lamports per compute unit, the owner's choice>
H=157.245.71.188

# 0. no mainnet transaction: the rehearsal again on a fresh fork (pump.fun redeploys often), then the preflight
mkdir -p -m 700 /tmp/units-fork-keys
scripts/mainnet/fork.sh /tmp/units-fork-ledger > /tmp/units-fork.log 2>&1 & echo $! > /tmp/units-fork.pid
MAINNET_FORK_KEYS=/tmp/units-fork-keys bun scripts/mainnet/test-rehearsal.ts      # must end PASS
kill "$(cat /tmp/units-fork.pid)" && rm -rf /tmp/units-fork-ledger /tmp/units-fork-keys   # by its PID, then delete
bun scripts/mainnet/preflight.ts --priority-micro-lamports $P                      # must print READY

# 1. the test coin (name, symbol and metadata URI are the owner's; the buy is at most 0.05 SOL, fees included)
bun scripts/mainnet/test.ts coin --mainnet --name "<name>" --symbol <SYMBOL> --uri <metadata json url> --buy-sol 0.05 --priority-micro-lamports $P

# 2. the three mainnet-test builds at the TEST ids, upgrade authority = the deployer (resumes when run again; --use-rpc if TPU sends do not land)
bun scripts/mainnet/test.ts deploy --mainnet --priority-micro-lamports $P

# 3. initialize with admin = the deployer; writes scripts/mainnet/mainnet.json and profile.local.json (untracked)
bun scripts/mainnet/test.ts init --mainnet --symbol <SYMBOL> --priority-micro-lamports $P
bun scripts/mainnet/test.ts check --mainnet                                        # read only, every line PASS

# 4. the hot keys' running SOL (0.05 each was rehearsed; one epoch post costs 0.001493440)
bun scripts/mainnet/test.ts fund --mainnet --core 0.05 --runtime 0.05 --priority-micro-lamports $P

# 5. the site instance: stage AFTER step 3 (it ships the state file and the overlay), verifiers on chain BEFORE activate
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh $H stage
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh $H chain-plan                     # read only: prints the site owner key and what it must hold
bun scripts/mainnet/test.ts fund --mainnet --to <site owner key> --sol 0.05 --coin 20 --priority-micro-lamports $P   # chain-plan asks for at least 0.02 SOL and 13 test coins
MAINNET_SEND=yes UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh $H chain          # 3 registrations, 2 bonds; needs no running Core; safe to repeat
UNITS_INSTANCE=mainnet WITH_RUNTIME=1 scripts/deploy/deploy.sh $H activate

# 6. one agent through https://main-157-245-71-188.sslip.io/launch with a browser wallet holding about 0.15 SOL
#    (0.097173597 SOL on the fork, of which 0.076516242 buys the test coin for the credits and the 1% initial buy);
#    Identity: "Your own token" (the units account is not offered there). A buy in the trade box: Pay with SOL.

# 7. when the test ends
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh $H stop
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh $H sweep-plan                      # read only: what the server-held keys hold
MAINNET_SEND=yes UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh $H sweep Gb7WNkLH5SeNPbotc9Tn7VUzUfAsfQLZ2Y2fHjL997J4   # site owner and verifier keys back to the deployer
bun scripts/mainnet/test.ts close --mainnet --sell-coin --confirm 27Y2UyLkuBAdwriNtqro5CJ4MTKjWCoUQywDJKunYBni --priority-micro-lamports $P
bun scripts/mainnet/test.ts status --mainnet                                       # the three TEST programs read CLOSED
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh $H remove --purge                  # refused while a server key still holds funds
```

`deploy` checks the deployer's balance against the peak of each program at the endpoint's own rent
before it writes anything. `close` needs `--confirm` with the test registry id; it sweeps the two hot
keys back, sells the deployer's test coin on its curve, claims the coin's SOL creator fees when the
claim returns more than it costs (`test.ts claim-fees` does only that), closes the three programs and
any buffer to the deployer, and prints what came back.

What does not come back: the three program accounts (0.000833120 SOL each), every account the programs
own (configs, vaults, the agent's records: the rent stays there, and so do the test coins and the
verifiers' bonds in them), the frozen lookup table, fees, pump.fun's trade fees. pump.fun's creator
vault keeps its rent-exempt minimum: on the fork a first sweep of 0.000148149 SOL of creator fees cost
the payer 0.000742731 more and returned nothing, and after 4 SOL of volume a claim returned 0.011851852
SOL, so `close` claims only when it pays. The test coin and the agent's coin stay on pump.fun as public
coins.

### Still to keep in mind

- **The model spend is real**: credits are priced in a coin with no value, so the 800 USD per UTC day cap
  on all spend, the limit of 2 attempts at once and trading off (docs/DEPLOY-SITE.md) are what bound the
  cost, not the vault.
- **Everything is public**: the coin, the launch and the trades show on pump.fun and on explorers.
- **The hosted runtime must report a model that can run** before the wizard lets a launch through (step
  3 of the wizard says "Pick a model that can run" otherwise): activate with `WITH_RUNTIME=1` first.
- **The trade box's SOL route** works while the test coin and the agent's coin both trade on their
  curves; after a migration the box asks to pay in the test coin.
