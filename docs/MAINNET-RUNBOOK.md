# Mainnet runbook (M5)

Written 2026-10-10. Nothing has been deployed to mainnet. Every step below has been run, in this
order, on a local fork of mainnet with mainnet's own Meteora DBC, DAMM v2, Token-2022 and Squads v4
builds (`scripts/mainnet/rehearsal.ts`, record `scripts/mainnet/REHEARSAL-LAST.json`, 97 of 97
checks on the `--features mainnet` builds deployed at the mainnet ids, 2026-10-10). Costs: [MAINNET-COSTS.md](MAINNET-COSTS.md). Powers: [AUDIT.md](AUDIT.md) "Powers" and the
section below. The owner runs the mainnet steps; this lane never sent a mainnet transaction.

## Go / no-go

Owner items stay unchecked until the owner checks them.

- [ ] External audit done, findings fixed and the fixed builds re-rehearsed (docs/audit/)
- [ ] Multisig signers set: members, threshold and time lock (`launch-params.json` `multisig`)
- [ ] Token parameters set: the `$LINE` mint and decimals, every SPEC 13 parameter (`network_file`), the DBC curve, rebate and debit caps, message caps, bounty and challenge values
- [ ] Legal review done
- [ ] Budgets set: SOL for the deploy (11.303959440 held at the peak with exact-size ProgramData, MAINNET-COSTS.md), the priority fee policy, the `--max-len` headroom, the Core and runtime hot keys' running SOL, the runtime's model spend caps
- [ ] Domain set
- [ ] Verifiers recruited (the minimum independent count is in the M4 server layout)
- [x] Program ids decided: fresh mainnet ids (owner decision 2026-10-10; see "Program ids" below)
- [ ] The three mainnet program id keypairs backed up offline by the owner (see "Program ids")
- [x] A1-08 per agent, per epoch slash cap decided and built (owner decision 2026-10-10, docs/AUDIT.md A1-08)
- [ ] The mainnet slash cap value (`set_slash_cap` through the vault; `initialize` sets strike_limit x the largest share)

Engineering items, with their evidence:

- [x] Fork rehearsal PASS 97/97 on the exact pre-audit `--features mainnet` builds, deployed at the mainnet ids with the mainnet id keypairs on the local fork only (`scripts/mainnet/REHEARSAL-LAST.json`, 2026-10-10; the earlier 80/80 ran on devnet-id builds before the slash cap)
- [x] The A1-08 slash cap on the fork: default 7,500 bps from `initialize`, set to 2,500 through the vault (propose, 2 approvals, time lock, execute), one slash landed, the next in the same chain epoch refused whole (`SlashCap`)
- [x] LiteSVM 61/61 against the mainnet Meteora builds (`METEORA_BUILD=mainnet`, step 0 below)
- [x] Every onchain admin action proven through a 2-of-3 Squads vault with a time lock, including a program upgrade and `graduate_by_admin`
- [x] The operator commands proven on the same fork after the rehearsal, under `LINEAGE_NETWORK=mainnet`: `propose.ts` proposed, approved (2 of 3), was refused before the time lock (6021) and executed a `registrySetSlashCap` 5,000 after it (proposal 13, read back 5,000); `initialize.ts init` re-ran on the initialized state and skipped every step (8 checks PASS, nothing sent) and `check` passed 7/7; under `LINEAGE_NETWORK=devnet` the same `check` refused (no program at the devnet registry id) (earlier, on the devnet-id run: a `msgSetConfig` through `propose.ts`, 16 checks PASS)
- [ ] The rehearsal re-run on launch day (Meteora can redeploy DBC and DAMM v2 at any time: their mainnet upgrade authority is `JADaUV8k...uCVLd`)
- [ ] Mainnet mode in the app and services (M3) and server hardening (M4)

## Roles after the handover

| Role | Holder | Notes |
|---|---|---|
| Upgrade authority, all three programs | Squads v4 vault | moved from the deployer right after initialization (step 6) |
| Registry admin (`Config.admin`) | the vault | set at `initialize`; the deployer never holds it |
| Launch admin (`LaunchConfig.admin`, also bounty config) | the vault | set at `initialize_launch` |
| Messages admin (`MsgConfig.admin`) | the vault | set at `lineage_msg::initialize` |
| Compute sink | the vault's `$LINE` token account | audit A1-11: not the runtime's own account |
| Multisig config authority | none (autonomous) | member, threshold and time lock changes go through the same proposals and time lock |
| Multisig rent collector | the vault | executed proposals' rent can be reclaimed to it |
| Core authority (`Config.core_authority`) | hot key on the Core server | scoped below; the vault rotates it with `registrySetConfig` |
| Runtime authority (`LaunchConfig.runtime_authority`) | hot key on the runtime server | the vault rotates it with `launchSetConfig` |
| Deployer | hot key, temporary | pays the deploys and initializers; holds nothing after step 6 |
| Core's offchain admin key (`/v1/admin/*`) | hot key on the Core server | signs HTTP requests (hidden list, models, trading config, recipes, findings, epoch close); moves no funds and is not onchain, so it is not behind the multisig |

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
`lineage_launch` and `lineage_msg` forward the feature so all three agree. `onchain/Anchor.toml`
`[programs.mainnet]`, `packages/chain` `PROGRAM_IDS.mainnet` and `config/profile.json`
`profiles.mainnet.programs` carry them.

| Program | Mainnet id | Keypair (mode 600, never committed) |
|---|---|---|
| `lineage_registry` | `3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay` | `~/.config/lineage/mainnet/registry-program-keypair.json` |
| `lineage_launch` | `2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq` | `~/.config/lineage/mainnet/launch-program-keypair.json` |
| `lineage_msg` | `jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky` | `~/.config/lineage/mainnet/msg-program-keypair.json` |

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
`scripts/mainnet` commands take the active profile too, so they run with `LINEAGE_NETWORK=mainnet`
(set once in "Steps" below); `initialize.ts` and `propose.ts` print the ids they use, refuse a
mainnet endpoint under any other profile, and refuse when the profile's programs are not deployed
at the endpoint. No script names an id.

The fork rehearsal deploys the `--features mainnet` builds (`onchain/target/mainnet`) at the mainnet
ids with these keypairs, by the same write-buffer and deploy commands as step 3, on the local fork
only (`fork.sh` no longer preloads any Lineage program). The keypairs signed nothing anywhere else.

## Steps

Variables used below. Every key is passed explicitly; never `solana config set`; never print `RPC`.

```sh
cd ~/lineage
set -a; . ~/.config/lineage/mainnet-rpc.env; set +a   # RPC=<keyed mainnet URL>, mode 600, never printed
K=~/.config/lineage/mainnet                            # deployer.json, dbc-config.json, ms-create.json (mode 600)
PARAMS=scripts/mainnet/launch-params.json              # copied from launch-params.example.json, every TBA filled
FEE=--with-compute-unit-price=<owner's price>          # priority fee, TBA
export LINEAGE_NETWORK=mainnet                         # scripts/mainnet take the program ids from the mainnet profile
```

### 0. Preflight (no mainnet transaction)

```sh
df -h /                                                         # at least 5 GB free
cp onchain/target/deploy/*-keypair.json ~/.config/lineage/program-keys/   # devnet id keypairs: backup before any build
ls -l ~/.config/lineage/mainnet/*-program-keypair.json          # the mainnet id keypairs (and the owner's offline copies)
cd onchain
for p in lineage-registry lineage-launch lineage-msg; do
  cargo build-sbf --offline --manifest-path programs/$p/Cargo.toml --features mainnet --sbf-out-dir target/mainnet; done
rm -f target/mainnet/*-keypair.json                             # throwaway keypairs cargo build-sbf wrote; not the mainnet ids
shasum -a 256 target/mainnet/*.so && wc -c target/mainnet/*.so  # compare with the audited mainnet hashes (docs/audit/BUILD-AND-TEST.md)
vendor/meteora/mainnet/fetch.sh                                 # mainnet DBC and DAMM v2: hash check fails if Meteora redeployed
METEORA_BUILD=mainnet cargo test --offline -p lineage-onchain-tests   # 61 tests on mainnet's Meteora builds
cargo test --offline -p lineage-onchain-tests                   # and on the devnet pins
cd .. && bun test packages/chain
# the full rehearsal on a fresh fork (throwaway keys; the mainnet id keypairs deploy the mainnet builds on the fork only;
# ports 9690-9693 and 9700-9730, checked free by fork.sh)
mkdir -p -m 700 /tmp/lin-fork-keys
scripts/mainnet/fork.sh /tmp/lin-fork-ledger > /tmp/lin-fork.log 2>&1 & echo $! > /tmp/lin-fork.pid
LINEAGE_NETWORK=mainnet MAINNET_FORK_KEYS=/tmp/lin-fork-keys bun scripts/mainnet/rehearsal.ts   # must end PASS
kill "$(cat /tmp/lin-fork.pid)" && rm -rf /tmp/lin-fork-ledger   # by its PID, then delete the ledger
bun scripts/mainnet/initialize.ts check --params $PARAMS --multisig 11111111111111111111111111111111 --rpc "$RPC" --mainnet 2>&1 | head -1   # refuses while any value is TBA
solana balance -u "$RPC" -k $K/deployer.json                     # at least the MAINNET-COSTS.md peak plus priority fees
for id in 3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay 2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky; do solana program show -u "$RPC" $id; done   # must not exist yet
```

### 1. Keys

The deployer, the DBC config keypair and the multisig create key are fresh keys made on the machine
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

### 4. DBC config values

The DBC config is created in step 5 from `$PARAMS.dbc`; the curve, fee and threshold are owner values.
The config names the launch authority PDA as fee claimer and leftover receiver, `$LINE` as quote, 100%
partner lock and Token-2022 agent mints (the launch program checks all of these).

### 5. Initialize (admin = the vault from the first instruction)

```sh
bun scripts/mainnet/initialize.ts init --params $PARAMS --payer $K/deployer.json --dbc-config-key $K/dbc-config.json --multisig $MS \
  --priority-micro-lamports <price> --rpc "$RPC" --mainnet
# prints the launch lookup table address; re-running with --lookup-table <it> resumes without a second table
```

This runs `lineage_registry::initialize`, DBC `create_config`, the compute sink account,
`initialize_launch`, `lineage_msg::initialize` and the launch lookup table (create, extend, freeze),
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

One launch through `/launch` (0.015996680 SOL measured for the launcher), a buy, `crank_fees`, and the
indexer and app reading them back.

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
| `launchSetConfig` | launch | admin, runtime authority, compute sink, fee split, sleep and wake thresholds, pause, debit cap, DBC config for new launches |
| `bountySetConfig` | launch | bounty caps, TTLs, grace, minimum, pause |
| `graduateByAdmin` | launch | graduate on a fully locked, authority-held position (A1 review H1) |
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

- Meteora's mainnet DBC is a different build from the devnet pin the suites used
  (`4c26a8a5...848b` against `5edf76d9...8ad3`); every suite passes on both, and the rehearsal's
  launches, crank, migration and both graduation paths ran on the mainnet build.
- The test validator charges more rent than mainnet (6,960 against 5,080 lamports per byte with the
  overhead); MAINNET-COSTS.md uses mainnet's own figures.
- `set_challenge_config` and `set_bounty_config` create accounts with the admin as payer, so the vault
  pays that rent; fund it before step 8.
- Squads v4's mainnet program config charges no multisig creation fee (read 2026-10-10) and the
  program is immutable (upgrade authority none).
