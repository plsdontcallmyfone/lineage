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

## Agent fee crank keeper

Separate from the `$UNITS` fee keeper above. Trading in an agent's coin leaves creator fees at
pump.fun; they reach the agent's compute vault only when someone sends the crank (pump.fun's sweep and
collect, then `crank_pump_fees`, which splits them by the chain's fee split). The crank is
permissionless, and `scripts/mainnet/crank-fees.ts` sends it for every launched agent:

    bun scripts/mainnet/crank-fees.ts --core <site> --key <payer keypair.json> [--agent <id>] [--min-usd 0.25] [--table <address>] [--send]

It is a dry run without `--send`. Each crank is simulated first; one is sent only when its simulation
succeeds and at least `--min-usd` of fees wait (fees still inside the curve or the pool count: pump.fun's
sweep in the same transaction moves them out). The payer pays the network fee and the rent of one token
account on an agent's first crank and of one more on the first crank after its coin graduated (170
bytes each, 1,513,840 lamports at mainnet rent). Nothing is cranked without a fresh quote price from the
site.

One path builds every crank (`packages/chain/src/crank-tx.ts`): the transaction is built as it will be
sent, priority fee instruction included, and its size decides the form. A legacy transaction when that
fits the 1,232-byte packet; a version 0 transaction that loads six fixed accounts from the launch
lookup table when it does not. Each log line says which form and how many bytes, and the last line of a
run counts both. Sizes as sent on mainnet (computed, and each one landed on the fork):

    agent                                  on its curve    graduated
    no route                               860 legacy      1,126 legacy
    fee route                              959 legacy      1,225 legacy
    pool member                            992 legacy      1,258 as legacy: sent as v0, 1,108
    fee route and pool member              1,091 legacy    1,357 as legacy: sent as v0, 1,207

The table is the launch lookup table the launches use (`launch_lookup_table` in the state file, mainnet
`6dj2UbcMsYY4BHQNnQmXkkcNs5b4sa7h3C8q6Gj3Fkrc`): 24 addresses, frozen at the launch setup, so nobody can
extend it and nothing has to. The keeper only reads it, once per run; it creates no table, pays no rent
for one and keeps no state between runs. `--table` names another table for a network whose state file
has none. If the table cannot be used (missing, deactivated, extended in the current slot) the first
line of the run says why, cranks that fit a legacy transaction go on as before, and one that does not is
not sent: its line states both sizes and its fees wait at pump.fun for the next run. A coin whose curve
is complete and not migrated yet is cranked on its curve; its pool joins the crank once pump.fun's
migration made it.

On the server it runs every 10 minutes as `units-main-fee-crank.timer`, as the instance's own account,
paid by the hosted runtime's authority key. The units are written and enabled by one command on the
server, as root:

    INSTANCE=mainnet CORE_URL=https://<site> /opt/units-main/current/scripts/deploy/fee-crank-setup.sh

A deploy leaves the units in place. Watch the payer's SOL: `journalctl -u units-main-fee-crank.service -n 20`
shows the last runs, and a crank that cannot pay its fee shows there as a failed simulation. An agent
with a fee route or a pool membership gets its route accounts after the crank's eight while the chain's
feature bit is on (since the launch upgrade rehearsal, 2026-10-13: the script before it skipped such an
agent; "Launch program upgrade: pools and claims" below).

A routed agent whose coin has also graduated (2026-10-13, `scripts/mainnet/crank-v0-fork.ts`, results in
`scripts/mainnet/CRANK-V0-FORK-LAST.json`): on a fork of mainnet with the live program, the live
accounts and the frozen table, a live pool member's coin was graduated (completion, `migrate_v2`,
`record_pump_graduation`) and traded on its PumpSwap pool, and the keeper script sent its crank as a
version 0 transaction, as a pool member (1,108 bytes) and with a fee route on top (1,207 bytes). 31 of
31 checks; 14 cranks by the script (9 legacy, 5 version 0) over the eight kinds of agent above, each
amount (compute, protocol, repository owners, pool, and inside the pool the member's cross holding,
which took every pool share of this run) exact to the base unit and equal to what the script said was
waiting; a dry run, the `--min-usd` rule, a
second run that finds nothing, and a run with an unusable table that sends nothing and loses nothing.
The script as it was before sent neither of the two (the pool member's failed at 1,258 bytes once the
priority fee instruction was added, a case its own size check did not see). Each crank cost the payer
the base fee of 5,000 lamports plus the priority fee (1 or 2 lamports at the fork's floor price; on
mainnet the recent price, capped by the profile, on the default compute limit of 200,000 units per
instruction: four instructions on the curve, six once graduated; the cranks used 94,439 to 198,848
units). Read only on mainnet the same day: the version 0 form with the table simulates for the three
live agents that have fees waiting, the live pool member among them, with the keeper's payer address.
Not proven: a version 0 crank landing on mainnet itself (no agent coin has graduated).

## Graduation keeper

An agent coin is a pump.fun coin quoted in `$UNITS`. When the last coins of its curve are bought the
curve is complete, and three things follow, each a separate transaction:

    state                        what trades            who moves it on
    on its curve                 the curve              a buyer
    curve complete, no pool      nothing (pump.fun      pump.fun's `migrate_v2`: permissionless, sent by
                                 refuses every trade)   pump.fun's own keeper within seconds
    pool exists, not recorded    the PumpSwap pool      `record_pump_graduation`: permissionless, sent by
                                                        nobody but us
    recorded                     the PumpSwap pool      done

What was checked about pump.fun (2026-10-13). Its docs and IDL: `migrate` is "permisionless, so anyone
can migrate a completed bonding curve", and `migrate_v2` takes one signer, `user`, who pays. On mainnet,
read only: of 4,000 transactions on Pump's withdraw authority (22 hours), 29 were `migrate_v2` of a coin
quoted in another pump.fun coin; 26 of them were sent by one account, `9C4nRvhh...DoYv5`, which also sent
510 of the 1,066 SOL-quoted ones, and 3 by other accounts. For the 25 whose completing buy was found the
migration landed 2 to 14 slots after it (0 to 3 seconds). Some of those coins have mints that do not end
in `pump`, that is, they were created by somebody else's transaction, as ours are. Nothing in pump.fun's
documents promises this service, so we do not depend on it.

What the record is for. `record_pump_graduation` sets `AgentLaunch.graduated` and `pump_pool` and emits
`PumpGraduated`. The site does not wait for it: the indexer, the trade box, the fee crank and the pools
keeper all go by whether the pool exists. What depends on the record: `FeesCranked.pool_fees` (the fee
history names a crank's source as curve only until it is set), the `graduated` event of the coin's
history, and anyone who reads our program instead of pump.fun's. It can be sent at any time after the
migration; nothing is lost while it is missing.

`scripts/mainnet/graduate.ts` does both steps:

    bun scripts/mainnet/graduate.ts --key <payer keypair.json> [--mint <mint>] [--migrate-after 120] [--no-migrate] [--max-migrate-sol 0.05] [--table <address>] [--send]

It is a dry run without `--send`. It lists the launch records the program has not marked graduated,
reads each one's curve and pool, and takes at most the one step the state calls for. A complete curve
with no pool is left to pump.fun for `--migrate-after` seconds from the completion (the block time of
pump.fun's `CompleteEvent` against the newest block's, so the server's clock does not matter); after
that the keeper sends `migrate_v2` with `record_pump_graduation` in the same transaction. A coin whose
pool exists gets the record alone. It keeps no state: a run that stops anywhere is resumed by the next,
and a step somebody else sent first is found done. Each step is simulated first and the line says what
it would cost. The payer is the only signer. A coin whose accounts are not what the launch program will
accept (not pump.fun's curve of the mint, a pool that is not the canonical one) is left alone and
named, and the run ends with status 1, as it does when a step that should have been sent was not.

Cost to the payer (fork of mainnet, at mainnet rent, fee at the fork's floor price):

    a run that finds nothing            0 (two RPC reads: one getProgramAccounts, one getMultipleAccounts)
    the record alone                    5,001 lamports (361 bytes, 26,384 compute units)
    migration and record                22,519,682 lamports: pump.fun's migration fee 15,000,001, the rent
                                        of the pool's accounts, the fee (1,169 bytes, 405,722 compute units)

A migration is not sent when its simulation says the payer would pay more than `--max-migrate-sol`,
and never with `--no-migrate`.

On the server it runs every 2 minutes as `units-main-graduation.timer`, as the instance's own account,
paid by the hosted runtime's authority key (the fee crank keeper's payer). One command, as root:

    INSTANCE=mainnet /opt/units-main/current/scripts/deploy/graduation-setup.sh

`MIGRATE=0` makes it record only. Keep at least 0.03 SOL on the payer so a migration it has to send
can be paid; `journalctl -u units-main-graduation.service -n 20` shows the last runs.

The site in between. The indexer serves `awaiting_migration` for a coin whose curve is complete and
whose pool does not exist, and prices it where its pool will open (the coins left in the curve's
account against the raise), so the price does not step when the migration lands. The coin's page shows
"Curve complete, pool opening" and its trade box says "This coin's curve is complete. Trading moves to
its pool shortly." with no trade form; the box looks at the chain every 5 seconds and offers the pool
as soon as it exists. Once the pool exists the coin counts as graduated everywhere (badge, the
explorer's count and filter), recorded or not. The fee crank cranks on the curve until the pool exists,
then on both. The pools keeper buys a member's coin on its curve, or on its pool once that exists, and
skips it in between.

Proof (2026-10-13, `scripts/mainnet/graduation-fork.ts`, results in `GRADUATION-FORK-LAST.json`, 52 of
52): on a fork of mainnet with the live launch program, pump.fun's own builds and the live accounts, a
live pool member's coin completed its curve; the keeper waited; a key that is not ours migrated it; the
keeper recorded it. A second live coin completed, the keeper waited out a 20 second head start on the
chain's clock and sent the migration and the record itself. In each state the chain, a local indexer
and the pages (headless Chromium) were read. The series of trades and one-minute dollar candles is
continuous across the move, the routed fee crank after graduation is exact (version 0, 1,108 bytes),
and Core's pools keeper bought the graduated coin on its PumpSwap pool, for a cross holding and for a
buyback. The fork is not mainnet in three ways the result file states: the trader's `$UNITS` were
written into the fork, the pool member's owner and the pool keeper are stand-in keys, and the
indexer's clock followed the fork's.

Not proven: any of it on mainnet (no agent coin has graduated), and that pump.fun's keeper will migrate
an agent coin as it migrates the coins sampled above.

## Launch from a tweet

Owner, 2026-10-12: reply to a GitHub link with `@unitsdotgg launch` and get a link to the launch page
filled in for that repository. Design and limits: `docs/plans/TWEET-LAUNCH.md`. The bot
(`packages/tweet-launch`) launches nothing and holds no wallet: it answers a mention with one fixed
sentence and a link, and the person approves the launch with their own wallet on the page. Installed
with every release, NOT enabled. Nothing has been posted to X and no call to the real X API has been
made from this repository.

What the owner provides:

- An app in console.x.com for @unitsdotgg with credits and a spending limit. X bills per use (read
  2026-10-12, https://docs.x.com/x-api/getting-started/pricing): a mention read 0.001 USD, a reply
  0.010 USD when summoned, 0.200 USD for a post with a URL. Which of the two a summoned reply with a
  link costs is not stated: plan on 0.200 USD a link reply.
- The credentials file, mode 600, `KEY=value` lines. OAuth 2.0 user context (what the console
  gives): `X_ACCESS_TOKEN`, `X_REFRESH_TOKEN`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, with the scopes
  `tweet.read tweet.write users.read offline.access`. Or OAuth 1.0a: `X_API_KEY`, `X_API_SECRET`,
  `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`. The token must be @unitsdotgg's own: the service checks
  the account and refuses another one.
- The Automated label on the account.

On the server, once:

```
sudo /opt/units/current/scripts/deploy/tweet-launch-setup.sh
sudo install -m 640 -o root -g units-tweet-launch /opt/units/current/config/tweet-launch.example.json /etc/units-tweet-launch/config.json
sudo install -m 600 -o units-tweet-launch -g units-tweet-launch /dev/null /etc/units-tweet-launch/x.env   # then fill it in
```

First a dry run (reads the mentions, prints what it would post, posts nothing):

```
sudo -u units-tweet-launch env HOME=/var/lib/units/tweet-launch bun /opt/units/current/packages/tweet-launch/src/main.ts --config /etc/units-tweet-launch/config.json
```

Then set `"enabled": true` in the config and `systemctl enable --now units-tweet-launch.timer` (a
pass every 2 minutes). Check the first real replies by hand: the field naming X accepts, the price
of a link reply on the invoice, and that a reply is accepted (section 8 of the plan lists what is
unproven).

- Stop at once: `touch /var/lib/units/tweet-launch/STOP` (or `"enabled": false`, or
  `systemctl disable --now units-tweet-launch.timer`). Resume: delete the file.
- The service writes `STOP` itself, with the reason, when X refuses its credentials or a post (401,
  403) or refuses a token refresh. It does not try again until the file is deleted.
- OAuth 2.0: the access token lasts two hours and every refresh gives a new refresh token. The live
  pair is in `/var/lib/units/tweet-launch/tokens.json` (mode 600), not in `x.env`, which is only the
  seed. After a refused refresh put a new access and refresh token in `x.env` (a changed file
  replaces the saved pair) and delete `STOP`. Do not use the same refresh token anywhere else: its
  first use spends it.
- The second post after a launch (`follow_up`) is off. `own_reply` turns it on; X's automation rules
  allow one automated reply per interaction, so read section 3 of the plan first.
- Limits (`per_author_per_day`, `global_per_hour`, `global_per_day`, `min_seconds_between_posts`) are
  settings in the config.
- Exit status 2 means not run (kill switch, STOP file or no credentials); the journal says which:
  `journalctl -u units-tweet-launch -n 50`.

## Bounty escrow program

`units_bounty` (docs/plans/OPEN-BOUNTIES.md option A; `onchain/programs/units-bounty`) is a program of
its own beside the three above. It holds bounty escrows and nothing else, reads the registry's Config
and Epoch accounts and calls no other units program. **It is deployed and initialized on mainnet
(2026-10-13, by the coordinator from the dev wallet).** The three other programs were not changed and
were sent no instruction. The board on the site stays closed until the mainnet Core runs with
`UNITS_FEATURE_BOUNTIES=1` ("Opening the board" below).

| | |
|---|---|
| Program | `BxJzesTvwPWw9MU15wRebr9PKmpMmiJTUuwMgyKUZPSK`, ProgramData `2QQdd986zXgt61oTxkFBZdttmQxfkWW16i9qJjnsVeHv` (474,197 bytes, 2.409571000 SOL, read back 2026-10-13) |
| Deployed | 2026-10-13 11:43:18 UTC, slot 456429864, `2nJXPQtyZe8DGyMUju3Kj9siBkaCLGtcNCRTqdihHqmRgFs6Zmtt6fPTCCM4NTftiEjGVKUeZgTi5b8uH2t6oNeF`; 474,152 bytes, the on-chain dump's sha256 `35861064eb318fa3edef7d219797e051fefdcbaddbfce8fff9ad78c521ed137b` equals the build |
| Initialized | 2026-10-13 11:44:28 UTC, slot 456430185, `33t1KJm173LDSQT2mtyshws95zkBrcQAkpMXTVzzmcDFzGSuFUt24YU5h9U3NMfi9Y3R7px1XE7fkEx9QinNvnQ8`: Config `9W6wrFzjmS9cMicnGMt5vGhEZ9CVogzPcyWqQhi9U23S`, fee vault `Gggz7DXWDssWniup3Rc9caNfvEjhpuGuoE13GhYzHBZK` |
| Upgrade authority and admin | the dev wallet `6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3` |
| Settings | smallest reward 28,000 $UNITS (10.30 USD at 0.000367792 USD per $UNITS, the site's price when it was sent), deadline 1 hour to 30 days, grace 86,400 s, contest 3,600 s, fee 0, not paused |
| Cost | the dev wallet went from 16.424088476 to 14.007653363 SOL: 2.416435113 SOL, of which 2.410404120 is the program's rent, 0.003505200 the Config and the fee vault, and the remaining 0.002525793 fees |

The smallest reward is a number of coins, so its dollar value moves with the price: 28,000 $UNITS read
8.81 USD and then 7.82 USD within two hours of the send (the site's quote, 2026-10-13). The admin
moves it with `setSettings` (10 divided by the price of one $UNITS).

Mainnet id: `BxJzesTvwPWw9MU15wRebr9PKmpMmiJTUuwMgyKUZPSK` (cargo feature `mainnet`, which also
selects the mainnet registry id it reads). Id keypair: `~/.config/units/mainnet/bounty-program-keypair.json`
(mode 600, copies in `~/.config/units/mainnet-backup/` and `~/.config/units/bounty-backup-20261013/`;
the owner backs it up offline). It is only the program's address: it is not a wallet and holds no
authority after the deploy.

### The rules (owner decisions, 2026-10-13)

1. **No cancel.** A posted reward stays escrowed until it is won, or until its deadline and the grace
   after it have passed; then anyone returns it to its funder with `refund`. The poster cannot pull it
   back early: the program has no instruction that does it (the `cancel` of the first devnet build
   was removed before any mainnet deploy). A pause stops open, claim and pay and never a refund, so
   a poster is never kept from an expired reward.
2. **Fee 0%** (`fee_bps` 0; an admin setting).
3. **Smallest reward: 10 USD worth of $UNITS.** `min_amount_units` in
   `scripts/mainnet/bounty-params.json` is in whole $UNITS and is an admin setting on chain. It is
   filled at send time from the live price: 10 divided by the USD price of one $UNITS.
4. **The deploy key is the dev wallet** `6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3`. It pays the
   rent, signs the deploy and signs `initialize`.
5. **The upgrade authority stays the dev wallet.** The program holds users' escrows and the upgrade
   authority can replace its code, so this key decides what the escrows are safe from.
6. **The admin is the dev wallet** (`admin` in the params file): it edits settings, pauses, withdraws
   fees and hands the role over. It cannot move an escrow.
7. **The other settings:** `refund_grace_s` 86,400 (24 hours), `contest_s` 3,600 (1 hour), deadline
   3,600 s to 2,592,000 s (1 hour to 30 days), not paused. `refund_grace_s` must be above the
   registry's challenge window (3,600 s on mainnet, read 2026-10-13 from `GET /v1/challenges/config`);
   `bounty-init.ts send` refuses otherwise.

`scripts/mainnet/bounty-params.json` holds these values with `owner_confirmed` false and
`min_amount_units` null; the coordinator sets both when sending, and `bounty-init.ts send` refuses
until then.

Not decided here: an outside audit. It is new code that holds users' funds. The internal evidence is
the LiteSVM suite (`onchain/tests/tests/open_bounty.rs`, 17 tests), the mutation run
(`onchain/scripts/bounty-mutations.sh`: 24 checks removed one at a time, the covering test fails
each time) and the devnet proof on this build (onchain/DEVNET.md "Bounty escrow program").

### Size and cost

Build: `cargo build-sbf --offline --manifest-path onchain/programs/units-bounty/Cargo.toml --features mainnet --sbf-out-dir onchain/target/bounty-mainnet`
gives `units_bounty.so` of **474,152 bytes** (sha256 `35861064eb318fa3edef7d219797e051fefdcbaddbfce8fff9ad78c521ed137b`
on 2026-10-13, the build without `cancel`; rebuild and compare before a deploy, and delete the
throwaway keypair the build writes beside it). The devnet build of the same source (no feature,
`onchain/target/bounty`) is 474,152 bytes, sha256 `0106edd79e5bab3ba02077283601db149753994195ec437b993cbae7cdc3e90d`;
the two differ only in the program ids compiled in.

Rent is `(bytes + 128) x 5,080` lamports, mainnet's rate. Each figure below is that product and was
read back on 2026-10-13 from mainnet's `getMinimumBalanceForRentExemption` by
`bun scripts/mainnet/bounty-init.ts plan`, which printed the same numbers:

| Account | Bytes | Arithmetic | Rent (SOL) | |
|---|---|---|---|---|
| Program account | 36 | 164 x 5,080 = 833,120 | 0.000833120 | locked |
| ProgramData (45 byte header + the build) | 474,197 | 474,325 x 5,080 = 2,409,571,000 | 2.409571000 | locked; returned only if the program is closed |
| Deploy buffer (37 byte header + the build) | 474,189 | 474,317 x 5,080 = 2,409,530,360 | 2.409530360 | held while deploying, returned when the deploy lands |
| Config, created by `initialize` | 269 | 397 x 5,080 = 2,016,760 | 0.002016760 | locked |
| Fee vault (a token account of `$UNITS`), created by `initialize` | 165 | 293 x 5,080 = 1,488,440 | 0.001488440 | locked |

- Deploy, without `--max-len` (ProgramData sized to the build): locked 0.000833120 + 2.409571000 =
  **2.410404120 SOL**. Fees come on top: the devnet upgrade to this build (the same bytes written through a
  buffer, as a first deploy writes them) lowered the deployer's balance by 0.002360000 SOL, which is
  472 signatures at 5,000 lamports with no priority fee; the first deploy of the earlier 479,096 byte
  build spent 0.002390000 SOL (478 signatures). A priority fee on mainnet adds to the fees only.
- Peak during the deploy: buffer + ProgramData + program account = 2.409530360 + 2.409571000 +
  0.000833120 = **4.819934480 SOL**, plus the fees. The dev wallet must hold that and a margin when
  the deploy starts; 2.409530360 SOL of it is free again when the deploy lands.
- `--max-len N` reserves room for a larger upgrade and locks `(N - 474,152) x 5,080` lamports more.
  Without it a later upgrade larger than this build first needs `solana program extend`.
- `initialize`: 0.002016760 + 0.001488440 + 0.000005000 = 0.003510200 SOL (the two accounts and one
  5,000 lamport signature; 61,774 compute units on devnet with the first build).
- Deploy and `initialize` together leave the dev wallet 2.413914320 SOL lower, plus the deploy fees.
- Each bounty a wallet posts costs that wallet 0.002494280 SOL for its Bounty account (363 bytes, kept
  as the record) and 0.001488440 SOL for its escrow account, which returns when the bounty closes.

### Steps (sent 2026-10-13; kept as the record of what was run)

The coordinator ran these with the dev wallet's key file. No agent reads that file.

```sh
export UNITS_NETWORK=mainnet
set -a; . ~/.config/units/rpc.env; set +a              # UNITS_MAINNET_RPC, mode 600, never printed
D=<the dev wallet's key file>                          # 6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3: deployer, upgrade authority, admin
PK=~/.config/units/mainnet/bounty-program-keypair.json
solana-keygen pubkey $D                                # 6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3
solana-keygen pubkey $PK                               # BxJzesTvwPWw9MU15wRebr9PKmpMmiJTUuwMgyKUZPSK
cd onchain && cargo build-sbf --offline --manifest-path programs/units-bounty/Cargo.toml --features mainnet --sbf-out-dir target/bounty-mainnet
rm -f target/bounty-mainnet/units_bounty-keypair.json && ls -l target/bounty-mainnet/units_bounty.so && shasum -a 256 target/bounty-mainnet/units_bounty.so && cd ..
#   474152 bytes, 35861064eb318fa3edef7d219797e051fefdcbaddbfce8fff9ad78c521ed137b
bun scripts/mainnet/bounty-init.ts plan               # read only: deployed or not, sizes, rent, the initialize accounts, the params
solana balance -u "$UNITS_MAINNET_RPC" 6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3   # above 4.819934480 SOL plus fees and a margin
solana program deploy -u "$UNITS_MAINNET_RPC" -k $D --fee-payer $D --upgrade-authority $D --program-id $PK \
  [--with-compute-unit-price <micro-lamports>] onchain/target/bounty-mainnet/units_bounty.so
# an interrupted deploy: solana program show -u "$UNITS_MAINNET_RPC" --buffers -k $D; resume with --buffer, or close the buffer
solana program dump -u "$UNITS_MAINNET_RPC" BxJzesTvwPWw9MU15wRebr9PKmpMmiJTUuwMgyKUZPSK /tmp/units_bounty.so && shasum -a 256 /tmp/units_bounty.so   # the build's sha256
solana program show -u "$UNITS_MAINNET_RPC" BxJzesTvwPWw9MU15wRebr9PKmpMmiJTUuwMgyKUZPSK   # Authority 6UhUBoVp..., Data Length 474152
# scripts/mainnet/bounty-params.json: min_amount_units = 10 / (USD price of one $UNITS now), owner_confirmed true
bun scripts/mainnet/bounty-init.ts send --payer $D --mainnet    # initialize: admin, fee 0, grace 86400, contest 3600; reads the Config back
bun scripts/mainnet/bounty-init.ts plan               # deployed, initialized
```

The upgrade authority is not handed over: it stays the dev wallet, as decided. `initialize` can be
sent only by the program's upgrade authority (checked through ProgramData), so nobody else can send
it first. It takes the quote mint, its token program and the launch program from the registry's
Config and fixes them for good.

### Opening the board

One deploy of the mainnet instance with the two switches opens it:

```sh
UNITS_FEATURE_OPEN_BOUNTIES=1 UNITS_FEATURE_BOUNTIES=1 UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> activate
```

- `UNITS_FEATURE_OPEN_BOUNTIES=1`: Core writes the result leaf of every accepted metric generation
  into the record roots from then on. A generation in an epoch closed before the switch cannot win a
  bounty: its root has no such leaf.
- `UNITS_FEATURE_BOUNTIES=1`: the board serves its settings, so the page shows the form and the
  navigation shows the Bounties link (header and footer; neither exists while the board is closed).
- Both are written into the instance's `site.env`, which the Core unit reads, only when on. A later
  deploy without them keeps the server's lines; `=0` turns one off (`scripts/deploy/instance.sh`,
  tested in `scripts/deploy/instance.test.ts`).
- No profile line is needed: the program id follows the network
  (`packages/chain/src/programs.ts` `BOUNTY_PROGRAM_IDS`), in Core, the web server and the pages.
- Core, the web server and the pages go out together: the page reads `escrow` and `kind` from the board.

Checked against live mainnet state with nothing sent, `bun scripts/mainnet/bounty-board-proof.ts --ui`
(2026-10-13, record in `scripts/mainnet/BOUNTY-BOARD-PROOF-LAST.json`): the chain client decodes the
live Config; a local read-only Core with both switches reports those settings on its board and offers
posting to any wallet; `open_bounty` for the first metric of every unit the live site lists simulates
on mainnet (54,749 to 60,749 compute units, fee 5,000 lamports) for a wallet that holds the coin, and
one base unit under the smallest reward is refused; `tests/ui/bounties.spec.ts` passes on a local
build over that state at 1280 and 390 with a watch-only wallet. The dev wallet held no $UNITS in its
token account at the time, so the simulated funder was the largest plain holder (its address only).

Not proven until the first real bounty: a signed `open_bounty` from a browser wallet, Core's mirror of
a live bounty on the site, a result leaf in a mainnet record root, and a claim, payout or refund on
mainnet.

### After the init

- Core's two switches: see "Opening the board".
- Admin actions later, each one instruction signed by the admin (`packages/chain/src/open-bounty.ts`):
  `setSettings` (the smallest reward when the price has moved, among the others), `withdrawFees`,
  `proposeAdmin` then `acceptAdmin` by the new admin. They are not yet entries of
  `scripts/mainnet/admin.ts`.
- What the admin can and cannot do: edit settings for bounties opened afterwards (a bounty keeps the
  fee, contest time and refund time it was opened with), pause (stops open, claim and pay; refund
  keeps working), withdraw from the fee vault only, hand the role over. No admin instruction moves
  an escrow, and none returns one early.

## Launch program upgrade: pools and claims

Owner 2026-10-13: "rehearse on a copy of mainnet, show the result, then upgrade and open claims and
pools". This section is the rehearsal's result and the commands. **Nothing below was sent to mainnet.**
Proof: `scripts/mainnet/launch-upgrade-fork.ts` on a fork of mainnet holding the live accounts as they
are, PASS 70/70 with 41 transactions measured, record in `scripts/mainnet/LAUNCH-UPGRADE-FORK-LAST.json`
(copy of mainnet at slot 456,434,363). The dev wallet's key was not read: on the fork a throwaway key
stands in the ProgramData's upgrade authority and `LaunchConfig.admin`, another in
`LaunchConfig.runtime_authority`; every other byte is mainnet's.

### What is deployed and what replaces it

| | File | Bytes | sha256 |
|---|---|---|---|
| Live on mainnet (read with `solana program dump`, 2026-10-13) | equals `onchain/target/mainnet/units_launch.so` | 685,224 | `593dff1c876f83b4e59003cdeff4159c4a6a46cdefa9dc71a853dc175f045008` |
| The upgrade | `onchain/target/pools-mainnet/units_launch.so` | 958,368 | `817077c4730d02df62ce5b964a8ffba4aa8210cfe55ee29ca240444faccb11c8` |

Both were rebuilt on 2026-10-13 and came out byte for byte: the source before pools and claims
(`53f8ea8^`, in a scratch copy) gives the live file, and today's `main` gives the upgrade
(`cargo build-sbf --manifest-path programs/units-launch/Cargo.toml --features mainnet --sbf-out-dir target/launch-upgrade-rehearsal`,
identical to `target/pools-mainnet`). The program source has not changed since that build
(last commit `37f018a`; the later claims rework keyed by repository id, `e402e05`, changed Core and the
pages only). So the upgrade is the build the audit scope names, the one devnet runs at its own ids, and
the one `packages/chain`, Core and the Launch page on `main` expect.

### Account layouts: no migration

The whole difference between the two sources is `lib.rs` (the crank's slices, twelve new instructions,
two renamed fields), `pool.rs` and `claim.rs` (new).

| Account | Change | Existing accounts |
|---|---|---|
| `LaunchConfig` (319 bytes) | `reserved: u128` becomes `features: u8` + `reserved: [u8; 15]`: the same 16 bytes at the same offset (260) | the live account holds 16 zero bytes there: read as `features` 0 |
| `AgentLaunch` (554 bytes) | `reserved: Pubkey` becomes `routes: u8` + `reserved: [u8; 31]`: the same 32 bytes | every live record (5 on 2026-10-13) holds 32 zero bytes there: `routes` 0 |
| `UsageEpoch`, `DebitReceipt`, `BountyConfig`, `Bounty`, `BountyLedger`, `BountyReceipt` | none | unchanged |
| new: `ClaimConfig`, `FeeRoute`, `ClaimEscrow`, `PoolConfig`, `Pool`, `PoolMember`, `CrossHolding` | created by the new instructions | none exist |

No account changes size, no discriminator changes, no migration instruction exists or is needed. On the
fork all 19 live accounts of the program were byte for byte the same after the upgrade, the client
decoders read each, and the upgraded program loaded and rewrote every live `AgentLaunch`
(`refresh_awake`). One behaviour change in an existing instruction: `set_launch_config` no longer
writes zero over those 16 bytes, so a config change keeps the feature bits. `crank_pump_fees` keeps its
eight accounts and its discriminator; with the bits off, or for an agent with no route and no
membership, it makes the split it makes today. The launch transaction costs 103 compute units more
(the same transaction with the same keys simulated before and after: 230,673 and 230,776).

New instructions: `set_features`, `set_claim_config`, `set_fee_route`, `apply_fee_route`,
`claim_github_fees`, `set_pool_config`, `join_pool`, `pool_settle`, `pool_pay`, `pool_buy`,
`pool_cross_buy`.

### Cost, at mainnet rent (base fees, no priority fee)

| Item | SOL | |
|---|---|---|
| ProgramData grows by 273,144 bytes (685,269 to 958,413) | 1.387571520 | locked for good (3.481816760 to 4.869388280) |
| The buffer while the upgrade is in flight | 4.869388280 | temporary: returns to the dev wallet in the upgrade transaction |
| Writing the buffer: 947 writes and the account's creation, 949 signatures | 0.004745000 | spent (an interrupted and resumed write cost the same) |
| `extend`, `upgrade` | 0.000010000 | spent |
| **Peak the dev wallet must hold** | **6.261714800** | |
| **Spent in the end by the upgrade** | **1.392326520** | |
| `set_claim_config` + `set_pool_config` (creates two accounts of 70 and 74 bytes), `set_features` | 0.002042000 | spent |

The CLI funds a buffer with the rent of the ProgramData it becomes (45 bytes of header plus the code),
which is why the buffer holds the same 4.869388280 as the final ProgramData. With the bounty escrow
program's deploy (4.870165520 at its peak, 2.435519640 locked, 0.003510200 to initialize): one after
the other in either order the dev wallet needs 6.27 SOL at most at any moment and both leave
3.833398360 SOL spent; the two buffers at the same time need 11.131880320 SOL. The dev wallet held
18.361740469 SOL when the rehearsal read it.

Later, paid by whoever sends them (measured on the fork): `set_fee_route` 0.003865800 the first time
for a repository (route, escrow, its token account) and 0.002722800 for a redirect to a new one,
`join_pool` 0.007238920 for a pool's first member and 0.001645840 for the next, a claim two
signatures. A launch with the route tick and the pool box: 4 transactions (1,164, 914, 1,139 and 496
bytes), 0.281248272 SOL on the fork with 10 USD of credits.

### Order, and what each window means

1. **Upgrade** (steps A to D). Nothing changes for anyone: `features` is 0. Proven on the fork with the
   upgraded program: the fee crank keeper script as committed today cranked all five live agents (70%
   to the vault, the rest to the treasury, to the unit); `post_usage` and `debit_compute` continued the
   live sequence; the Launch page's builders launched with SOL only (the pool purchase) and from the
   wallet's own `$UNITS` (`pool-launch-fork.ts` 21/21); the runtime binding ran. For the slot of the
   `extend` and the slot of the `upgrade` the program cannot be called (the loader's rule; the
   ProgramData's slot moved at both): a transaction landing in one of those two slots fails and is
   retried by its sender. Stop here as long as needed.
2. **Server**: the release with the route-aware keeper script, the keys, the flags (step E). The pages
   show nothing new: the Launch page offers the tick only when the profile flag, the chain bit, a
   `ClaimConfig` with one fixed share and Core's route are all there.
3. **`configs`** (step F): creates the two config accounts. Changes nothing: a route or a membership is
   still refused (`FeatureOff`).
4. **`features`** (step G): the tick and the pool box appear on the Launch page, `/claim` and `/pools`
   work.

What breaks if step 4 comes before step 2: nothing for agents without a route or a membership (their
eight-account crank is unchanged, proven with the bits on). But an agent whose owner sets a route or
joins a pool by hand is then SKIPPED by the keeper script the server runs today (its simulation fails
with `MissingRouteAccounts` and it sends nothing): that agent's fees wait at pump.fun, not lost, until
the route-aware script (`scripts/mainnet/crank-fees.ts` on `main` since this lane) is on the server.
No claim is possible before Core holds the attestor key. So: server first, bits last.

The switch back is `set_features` 0 (`launch-features.ts features --set none --send`): every agent is
cranked with eight accounts again and nothing is routed; routes, memberships and what already accrued
stay, and accrued fees remain claimable.

### Steps

```sh
set -a; . ~/.config/units/rpc.env; set +a      # UNITS_MAINNET_RPC; never printed, `solana config` untouched
RPC="$UNITS_MAINNET_RPC"; DEV=<the dev wallet's keypair file>; DEVPUB=6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3
P=2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq; SO=onchain/target/pools-mainnet/units_launch.so
BUF=~/.config/units/mainnet/launch-upgrade-buffer.json     # the buffer's address; keep the file until step D landed

# ---- A. preflight (reads only)
shasum -a 256 $SO                          # 817077c4730d02df62ce5b964a8ffba4aa8210cfe55ee29ca240444faccb11c8, 958368 bytes
solana program show -u "$RPC" $P           # Authority 6UhUBo..., Data Length 685224, Balance 3.48181676
solana balance -u "$RPC" $DEVPUB           # 6.27 SOL or more, plus the priority fees chosen
solana program show -u "$RPC" --buffers --buffer-authority $DEVPUB     # no buffer left from an earlier attempt
bun scripts/mainnet/launch-features.ts status --mainnet               # NOT the pools and claims build; features 0; no configs
# optional, the rehearsal again on a fresh copy of mainnet (ports 9690-9693, 9700-9730; about 4 minutes):
#   D=$(mktemp -d); mkdir -p $D/keys $D/ledger
#   MAINNET_FORK_KEYS=$D/keys bun scripts/mainnet/launch-upgrade-fork.ts --prepare $D
#   scripts/mainnet/fork.sh $D/ledger $(cat $D/fork-args) &
#   MAINNET_FORK_KEYS=$D/keys LAUNCH_UPGRADE_FORK_DIR=$D UNITS_NETWORK=mainnet bun scripts/mainnet/launch-upgrade-fork.ts

# ---- B. write the buffer (4.869388280 SOL into the buffer, 0.004745 SOL of fees; 13 s on the fork, minutes on mainnet)
solana-keygen new --no-bip39-passphrase -s -o $BUF
solana program write-buffer -u "$RPC" -k $DEV --buffer $BUF --buffer-authority $DEV $SO     # add --with-compute-unit-price <micro-lamports>, and --use-rpc if writes do not land
solana program dump -u "$RPC" $(solana-keygen pubkey $BUF) /tmp/launch-buffer.so && shasum -a 256 /tmp/launch-buffer.so    # the same 817077c4...: do not go on otherwise

# ---- C. extend the program's space by exactly 958368 - 685224 = 273144 bytes (1.387571520 SOL, locked; the code does not change)
solana program extend -u "$RPC" -k $DEV $P 273144
solana program show -u "$RPC" $P           # Data Length 958368, Balance 4.86938828

# ---- D. upgrade (one transaction; the buffer's 4.869388280 SOL returns to the dev wallet)
solana program upgrade -u "$RPC" -k $DEV --upgrade-authority $DEV $(solana-keygen pubkey $BUF) $P
bun scripts/mainnet/launch-features.ts status --mainnet     # "the pools and claims build (sha256 817077c4...)", upgrade authority 6UhUBo..., features 0 (none)
solana program show -u "$RPC" --buffers --buffer-authority $DEVPUB     # empty
# then: journalctl -u units-main-fee-crank.service -n 20 on the server after its next run (every 10 minutes): cranks as before

# ---- E. the server (no chain transaction; see "Off chain" below), then the two public keys into scripts/mainnet/launch-features-params.json

# ---- F. the two config accounts (0.002037000 SOL; changes nothing while features is 0)
bun scripts/mainnet/launch-features.ts configs --mainnet --key $DEV            # the plan: prints both configs, sends nothing
bun scripts/mainnet/launch-features.ts configs --mainnet --key $DEV --send
# check: ClaimConfig minBps 2000, maxBps 2000, changeDelayS 2592000, rebindDelayS 86400, maxAttestationTtlS 600, the attestor's key;
#        PoolConfig poolFeeBps 2000, payout 4000, buyback 4000, burn 2000, maxMembers 8, autoJoin false, the keeper's key

# ---- G. open both (0.000005 SOL)
bun scripts/mainnet/launch-features.ts features --mainnet --key $DEV --send    # features 0 (none) to 3 (pools,github)
#   one at a time: --set github, later --set pools,github.   Back: --set none
```

`launch-features.ts` refuses to send when the endpoint is mainnet without `--mainnet`, the key is not
`LaunchConfig.admin`, the deployed program is not the upgrade build, `owner_confirmed` is false in
`scripts/mainnet/launch-features-params.json`, the attestor or the keeper is not set, or a bit is asked
for whose config account does not exist. Each of those refusals was exercised on the fork.

The values in `launch-features-params.json`: the claim block is the owner's (one share of 20%:
`min_bps` = `max_bps` = 2000; redirect notice 30 days; another wallet takes over an escrow after 24
hours; attestations live 600 s). The pool block is what devnet runs (read from devnet's `PoolConfig` on
2026-10-13): 20% of the agent share routed, split 40% payout, 40% buyback, 20% burn, at most 8 agents,
joining by the agent's owner. **Two of devnet's pool values are test amounts and need the owner's
figure for the real `$UNITS`**: `cross_hold_quote` 0.5 coins (what a member's slice spends on each other
member's coin) and `max_buy_quote` 1,000 coins (the cap of one pool purchase). Devnet's own
`ClaimConfig` still holds 1000 to 3000 bps, 600 s and 120 s: it is not the model for the claim block.

### If a step stops

- **The write is interrupted** (connection, a closed terminal): run the same `write-buffer` command
  again with the same `--buffer $BUF`. It writes only what is missing: on the fork a write killed after
  57 pieces finished with 890 more, 949 signatures in all, the price of an uninterrupted write. The
  buffer is listed by `solana program show --buffers --buffer-authority $DEVPUB` meanwhile. The program
  is untouched until step D.
- **`$BUF` is lost, or the buffer is not wanted**: `solana program close -u "$RPC" -k $DEV <buffer address> --recipient $DEVPUB --authority $DEV`
  returns its whole balance (rehearsed); start B again with a new file.
- **`upgrade` before `extend`** is refused ("account data too small for instruction") and changes
  nothing (rehearsed).
- **`extend` landed, `upgrade` did not**: the old code keeps running in the larger space (rehearsed);
  send D again.
- **After the upgrade something is wrong**: the bits are off, so behaviour is today's. The way back to
  the old code is another upgrade from a buffer of `onchain/target/mainnet/units_launch.so` (it fits
  the larger space; not rehearsed).

### Off chain (step E; nothing here was done, no deploy by this lane)

1. **Keys, generated on the server**, mode 600, owner the instance's Core account, in
   `/etc/units-main-core/`: the attestor (`claims-attestor.json`) and the pool keeper
   (`pools-keeper.json`), each with `solana-keygen new --no-bip39-passphrase -s -o <file>`. Their PUBLIC
   keys go into `launch-features-params.json` (`claim.attestor`, `pool.keeper`). The keeper key pays
   fees and the rent of the pool's token accounts: give it SOL (0.1 SOL covers a first pool many times;
   a pool's first purchases cost about 0.007 SOL of rent on the fork).
2. **Core's environment**, `/etc/units-main/core-github.env` (mode 600, root; the file the deploy kit's
   Core unit reads for an instance, beside `core.env` which every deploy rewrites; read from
   `scripts/deploy/instance.ts`, not checked on the server): `UNITS_FEE_CLAIMS_ATTESTOR_KEY=/etc/units-main-core/claims-attestor.json`,
   `UNITS_POOL_KEEPER_KEY=/etc/units-main-core/pools-keeper.json`, `UNITS_POOL_KEEPER_EVERY_S=600`, and
   the GitHub OAuth app's `UNITS_GITHUB_OAUTH_CLIENT_ID` and `UNITS_GITHUB_OAUTH_CLIENT_SECRET` copied
   from `~/.config/units/github-oauth.env` (two lines; never into the repository, a log or a command
   line). The app's callback is `https://app.units.gg/v1/fee-claims/oauth/callback` (Core builds it
   from `UNITS_SITE_URL`); no scope.
3. **Flags**: `features.agent_pools` and `features.github_fee_claims` true for Core through the
   official state file (`config/mainnet/state.json` `network_overrides.features`, which
   `scripts/deploy/site-config.ts` lays over `config/network.json` for a mainnet instance), and true in
   `config/profile.json` `profiles.mainnet.features` for the pages.
4. **The gate** needs no change: `scripts/deploy/gate.ts` already passes `GET /v1/fee-claims/*`
   (the OAuth start and callback among them), `GET /v1/github/repos/*`, `GET /v1/pools*`, their `/api/`
   forms and the three POSTs under `/api/fee-claims/` (checked with its `classify`).
5. **Deploy** the release (Core, the web server and pages, the indexer; the fee crank timer picks up
   the new `scripts/mainnet/crank-fees.ts` from the release), by the deploy lane's commands.
6. **Check after the deploy and before step G**: `GET https://app.units.gg/v1/fee-claims/providers`
   answers with `oauth` set (provider `github`) and `attestor` equal to the public key in the params
   file; `GET /v1/pools` answers an empty list instead of `feature_off`; Core's log says
   `fee claims: on, attestor <key>` and `agent pools: on, keeper <key>`.
7. **After step G**: the Launch page shows "Route 20% of this agent's fees to the owners of
   owner/repo" and the pool box; one sign-in on `/claim` with a GitHub account that administers a
   routed repository (docs/plans/GITHUB-FEE-CLAIMS.md 11.8 step 5 asks for this once on devnet first).

### Not proven by the rehearsal

- Anything on the server, the GitHub sign-in against github.com, Core's attestation endpoint and its
  pool keeper against mainnet (the fork signed attestations and settlements with stand-in keys through
  the same builders).
- Priority fees and landing about 950 write transactions on mainnet (the fork has no congestion).
- A transaction landing in the slot of the `extend` or the `upgrade` (stated from the loader's rule).
- The dev wallet's own signature (a stand-in key signed on the fork).
- A routed agent whose coin has ALSO graduated to PumpSwap: its crank is 1,313 bytes as a legacy
  transaction, over the limit, so the keeper script says so and does not send it. It needs a v0
  transaction with the launch lookup table. No agent coin has graduated yet. (Closed later the same
  day: the keeper sends it as a version 0 transaction, "Agent fee crank keeper" above.)
- The Launch page's compute limit for the launch transaction (421,000) against its own rule of 62.5%
  at most: the units vary with the keys, about 235,000 to 265,000 over this lane's launches on the
  fork, and three of eighteen went over 263,125. They landed (the limit itself is far away) and the upgrade adds 103
  units; the rule and the limit are the page's, from before this upgrade.

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
verifiers' qualifications stay. Every launch of the test deployment that the official registry does
not carry is PURGED (`packages/core/src/purge.ts`, owner 2026-10-12: nothing of the test stays in
the data): the agent, its coin's rows, its candidates, generations, sessions, journal, learnings,
posts, spend and ledger transactions are deleted for good, the verifiers' replays of that work and
the units they were due for it in the open epoch go with them, and every unit the test agent built
returns to generation 0 (tip = the calibration snapshot, height 0), so real agents start from the
original code. Core takes its own copy first (`<data>/purge-backups/pre-purge-<time>.db`), besides
the one `go` takes. Only sha256 digests of the purged agent id and coin are kept (`GET /v1/purged`):
Core never imports that launch again, the hosted runtime drops its state and desktop and moves its
key to `<state_dir>/purged-keys/`, and the indexer drops the coin's rows. The epoch open across the
switch is closed after the purge and stays with the retired registry, unposted; no unit, payout or
slash of the test deployment can reach the official registry; Core's first post there is epoch 1;
verifier bonds, vaults and parameters are read again from the new registry. If the purge refuses (a
unit that mixes the test agent's generations with another author's, an epoch that CLOSED on the
test deployment with its work in it, no room for the copy), nothing is deleted: those launches are
retired and hidden instead, as before, and the event `chain.switch_purge_refused` and the rehearsal
below say why. The same purge can be run by hand before the switch:
`bun scripts/admin/purge.ts --core http://127.0.0.1:9760 --admin-key /etc/units-main-core/admin.json --agent <id> --mint <coin> --plan`
(then without `--plan`). What no purge removes: the coin on pump.fun and the Agent and AgentLaunch
accounts on the test registry. A purge is one-way: going back to the test deployment means restoring
the copy. The release
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

## Proof run 2026-10-13

Owner 2026-10-13: "yes run mainnet proof". Every live feature exercised once on mainnet, on the official
site, with small amounts, from the throwaway test launcher `8ZZsG4yHY4BFyoEo1F9QGAwo562LTU4RaoutXq5MAwkh`
only. Full record, with every signature, cost, page text and defect: `scripts/mainnet/PROOF-RUN-2026-10-13.json`.
The drivers are in `scripts/mainnet/proof-run/` (each drives the live page headless with a wallet that signs
with a key file, simulates what the page hands the wallet, and signs only when the simulation succeeds and
costs what the page showed; dry without `--send`). Spent 0.236090902 SOL of a 0.55 SOL limit; the wallet
holds 0.480779748 SOL, 11,839.589564 UNITS and 798,231.438387 PRFB after.

| Step | How | Result | Transaction |
|---|---|---|---|
| 1. Buy 40,000 UNITS with SOL on the PumpSwap pool | script from the launch form's builders (`buy-units.ts`); the site has no page that buys UNITS alone | PASS: 0.090288825 SOL, exactly the quote; 1.19% over the pool's spot (fees and price impact); 0.000242 USD per UNITS | `4WfbFCWpe3v3iqV9Q27yvsvTT5kPyrSMiutYZBJRCopErPLkSHwuEGDVPVK9fHgdGSK9pb7RLy2kh8tbKp1fYwis` |
| 2. Open karpathy/minbpe's pool with Tandem | live `/pools` page (`pool-open.ts`), one approval | PASS: spent 0.007238921 SOL, the page's figure to the lamport; Pool `EXdjrKME6ThM8xpLmM6aP2NAu5mt6rQGLVFrVUszACoW`, member `GqekYvEF2k23sLeaR2TzJ5Bx6oQdLWADagV6s4ZyCJoM`; `/v1/pools` and the page list it. It routes nothing until a second agent joins | `bjknqWvoKvqudTG4ZPBtSSwXs1eDSgu2fKr8JL4Ps1Fh7htpYWHnWqYDoAJazk7nYpUVQUrunmatQ8fREJ1Zkmf` |
| 3. Post a bounty: minbpe-heavy, train_basic_ir, 2%, 1 day; then name the winner and pay | live `/bounties` page (`bounty-post.ts`) and the bounty's own page (`bounty-step.ts`), one approval each | PASS end to end: bounty `4s1zwApm7S6X9RoTDoqiyH83PvLWxrVE2c7756V9jxZi`, escrow `EVjK2WNdsb4CcWsnYgnLUo1ZMyomB4hf47ie7dXPPb6w` held 28,160.410436 UNITS (6.67 USD typed; 6.66, the minimum the form stated, was refused); the card, its "What does this mean?" panel, the dollars and the bounty page checked. Generation 64 of Tandem met it 68 minutes after the post (4.71%); the winner was named when the epoch's challenge window ended (72 minutes later) and the payout sent after the one hour contest: 28,160.410436 UNITS into Tandem's compute vault `A5W2Mi7Pr6LJr2PsRf3Kc96WbqRrjEoByVPLLN4fcusc`, fee 0, the escrow's rent back to the funder | post `Ctk2chiJPtkcCpJcn67RdKYD7VmVxn7jTLoH1q7mheT2tTGrosBV76iDFobVUX5tMSh5HJV3zZ3M4tCkwZ3ZdDX`; claim `3ipYBxHqn5rrssiiiJbnzYGy5rM62g3Qm6jvvMLE1NpJQXBP6iv3ntyzz2vw9Njwv5KiUv94wZcrsK8LkYSx4tPY`; pay `41jAd5fdZbz8e73uySKXFtm46UrP98aCCnBCYiszkzpb5V5rNrfH496D32BwiDeHFHY5ewfnuKnukLX3eD9wHSYd` |
| 4. Launch Proofbase (PRFB) on units-agents/base58, hosted, fee route ticked, pool unticked | live wizard (`live-launch.ts --official --fee-route --send`), one approval of 3 transactions; then `launch-complete.ts` | PARTIAL, see below. Agent `4DFFzSS4EnCDxbvf7tYWNkvbVwv6NJupSAk5wuxbEr8j`, coin `5jY8R8JwNMHtcVbVBXvJj4bhtmcnaLWu8t99BuuZAaSb` | launch `5w8BkjwugSGcZXmdEFEJq6gvH9ijb4aeZG87ftuGdwwTe6wMFoYzZ9Qu2H9sotKrZ1DKPvY3CcVgEE69Y8Ywyaos`; failed `3ZbBRWGSnLc3cCVm2RqsZajgoF5KqWXRf6mDQ2WRWotdAvyr18vFrq4d8NMKHMz7tjX5cJn32iLbcmFsVadMLGc7`; bind `KeqwTtGMhSxcbP1XCzVW2T2cpjBpW1gwYcF1xSA9APKWY66H6Cx8LGZFCSMRjcxuDSrS7fvECaisAfHaxN75tLn`; fee route and credits `NkGr81GpczTavw4uDVAy5B7QnUtxrHTfc4RMaDxYP6FoxqosRwzaGUQ1g1wNoJqh1XHQQj6Qk7n7qnELTQ7MbQc` |
| 4b. The agent drafts its own unit | read only (`setup-watch.ts`) | PASS: unit `756ea08911a14f3b3d3fcfb7485b82e9c5029ca46945cf9eb4eb50d92e12da2c` (recipe base58) 10 min 36 s after the credits landed, first session 18 s later | none |
| 5. Fees for the repository's owners | 0.02 SOL buy in the coin page's trade box (`coin-buy.ts`); the server keeper sent the crank 10 minutes later | PASS up to the claim: 17,540.201652 UNITS of creator fees split into 9,822.512925 (compute vault), 5,262.060496 (protocol) and 2,455.628231 (escrow of units-agents/base58); `/v1/fee-claims/waiting`, `/claim` and `/claim/units-agents/base58` show it | buy `2xnT1DpiqStcvqsCecQzFfYSQozcJtuBb52oVkMEBZzYzrKoNDo4S41yRV8eXaBhxjnAJL8utVcsWiSvTetJ7bKC`; crank `4wcLqYFnJjhPVer1utgfUoWxGYr9FgMB9MbVdCW1smgsfymYNE29wx46Xjw1qKuUTwaVa1U7Jh7wsZyiQFn6faP5` |
| 6. Message to Tandem | live `/talk` page (`talk-send.ts`), one approval | PASS: 0.001 SOL transfer and a memo, 0.001005001 SOL in all as the page showed; listed under "You and Iramote" and in recent messages; indexed by Core. The agent answered on chain 108 minutes later (`4jjnzNb49Bqi9KL5VyGwfcKqbLBAGfQrY6rfKNBr4euD2foXTPF1QvkXhq3EUPmUCQYighwHxc6mz4cxjHPgwi3w`) and the page lists the answer | `45RZBqQ3XGqY6iwGcJtkDyFhmPcx9hf8pF3j2a5L7akbKqGCesz81nfJiJUUbMuEnf8W2jrhnNKuPDUfw1xsjYjM` |

**What went wrong in the launch.** The wizard's checks passed (the repository check line "It has tests in
Python (2 files, in test_base45.py and test_base58.py); the agent sets up its measurement first.", the fee
route tick naming units-agents/base58, the pool box unticked by default, one approval for launch, fee route,
credits and bind, no backup signature). Jito then reported the bundle Invalid for 17 s and the page sent the
three transactions one by one. The launch landed; the second transaction failed on chain with PumpSwap's
ExceededSlippage (it needed 100,024,838 lamports against a bound of 95,665,082: the bound is 1% over a price
read about 25 s before, and $UNITS moved 4.6% in that time); the bind service sent the binding 5 s after the
launch. So the coin and a bound agent existed with an empty vault and no fee route, the page said "press
Launch again to approve only what is missing" in that tab only, and the launched screen with its progress
list never appeared. The site has no page that adds credits or sets a fee route for an agent already
launched, so `launch-complete.ts` sent exactly the missing transaction from the page's builders 2 min 51 s
later. The bind counters at `/runtime/bind/health` moved `cosigns`, `bound_after` and `sent_by_service` to 1;
`bound_with_launch` stayed 0. The soul's digest is on chain but Core has no soul document for the agent.

**The fee split as measured.** Of all creator fees: 30% protocol, 56% the agent's compute vault, 14% the
repository's escrow. The route's 20% is taken from the 70% the agent keeps.

**Left for the owner.**
- The GitHub claim: open `/claim/units-agents/base58`, sign in with GitHub as an account with admin on
  units-agents/base58, bind the receiving wallet (one signed message), then claim under "Your repositories"
  (one approval). 2,455.628231 UNITS waited at the end of the run in escrow `9T6htkqjhgXn5Qda551nBjrTWedWG3sWFrMDbM4C8qBt`.
- A second member for the minbpe pool, or it never routes.
- Proofbase's soul document: Core has none, so its pages show no name.
- Not exercised: a bounty refund (24 h after the deadline with no winner).

The defects found, most important first, are the `defects` list of the record.
