# Deploying the Lineage programs (devnet deployed 2026-10-07, see DEVNET.md)

Deployed to devnet on 2026-10-07 and upgraded the same day with the review fixes (DEVNET.md).
The text below is the original plan, kept for the measured figures. Mainnet is out of scope until launch values exist
(SPEC 20).

## Keys

| Key | Path | Public key |
|---|---|---|
| Devnet deployer, upgrade authority, payer | `~/.config/lineage/devnet-deployer.json` (mode 600, generated 2026-10-07, never printed) | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` |
| `lineage_registry` program id | `onchain/target/deploy/lineage_registry-keypair.json` (copies: `onchain/keys-backup/`, `~/.config/lineage/program-keys/`) | `2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY` |
| `lineage_launch` program id | `onchain/target/deploy/lineage_launch-keypair.json` (same copies) | `8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT` |

Every command passes the key and the cluster explicitly. Never `solana config set`, never rely
on `~/.config/solana/id.json`: both are shared by every session on this machine.

## Measured sizes and rent (2026-10-07)

Built with `cargo build-sbf` (platform tools v1.52, release profile `opt-level = "z"`, fat LTO,
stripped) from commit-time sources:

| Program | `.so` bytes | sha256 |
|---|---|---|
| `lineage_registry.so` | 516,936 | `14b534cc2165e9888426b8a9de0c4d3c7bd69cbe704715cfc7c9af086407c2b4` |
| `lineage_launch.so` | 526,224 | `fae228465be7b037156e9efb960a009c4cb53db7b3fb53ba6b239a6a1b25a86b` |

Rent is `(bytes + 128) x 5,080` lamports on devnet (checked with the read-only
`solana rent -u devnet <bytes>`, which printed the same figures). An upgradeable program's
ProgramData account is 45 bytes of header plus `--max-len`:

| Program | `--max-len` | ProgramData bytes | Rent (SOL) |
|---|---|---|---|
| registry | 516,936 (exact, the CLI default) | 516,981 | 2.62691372 |
| registry | 620,323 (+20%) | 620,368 | 3.15211968 |
| launch | 526,224 (exact, the CLI default) | 526,269 | 2.67409676 |
| launch | 631,468 (+20%) | 631,513 | 3.20873628 |
| each program account | | 36 | 0.00083312 |

Deploy writes the program into a buffer account first, which needs about the same rent as the
ProgramData; the final deploy instruction funds the ProgramData from the payer and only then
closes the buffer back to the payer. So the payer must hold buffer rent plus ProgramData rent at
once. Deploying the registry and then the launch program, the peak is during the second deploy:
2.62691372 (registry, locked) + about 2.674 (launch buffer) + 2.67409676 (launch ProgramData),
about 7.98 SOL. Net after both deploys at the exact size: 5.30101048 SOL of rent plus the two
program accounts (0.00166624 SOL) plus write-transaction fees (about 1,050 transactions of about
1 KB at 5,000 lamports, about 0.0053 SOL). Ask for 8.5 SOL on devnet (peak plus margin); about
3.19 SOL of that is left in the deployer after both deploys.

With the exact size, any upgrade that grows a program first needs `solana program extend`
(rent for the added bytes). The +20% rows trade about 1.06 SOL more locked rent for room to grow.

Initialization rent, measured from the LiteSVM accounts (paid once by the deployer):
`Config` 261 bytes (0.00197612), five `$LINE` vaults of 165 bytes each for a classic mint
(0.00148844 each; Token-2022 vaults are larger), `LaunchConfig` 279 bytes (0.00206756). Per use,
paid by the caller: `Agent` 249 bytes (0.00191516, by the registering owner or the launcher),
`AgentLaunch` 554 bytes (0.00346456) plus a compute vault and Meteora's own pool accounts (by the
launcher), `Epoch` 133 bytes (0.00132588, by Core), `ClaimReceipt` (0.00130048, by the claimer),
`UsageEpoch` and `DebitReceipt` (by the runtime).

## Preconditions to measure before sending anything

1. `df -h /` and rebuild both programs; compare the sizes and hashes above (`wc -c`, `shasum -a 256`). A changed size changes the rent.
2. `cargo test --offline -p lineage-onchain-tests` passes against those exact `.so` files.
3. `solana balance -u devnet CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` covers the table above.
4. The program ids are unused on devnet: `solana program show -u devnet 2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY` (and the launch id) report no account.
5. Meteora on devnet is still the pinned build: `vendor/meteora/fetch.sh` passes its hash check.

## Commands (devnet; not run)

```sh
cd ~/lineage/onchain
K=~/.config/lineage/devnet-deployer.json
cargo build-sbf --offline --manifest-path programs/lineage-registry/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-launch/Cargo.toml --sbf-out-dir target/deploy
solana program deploy -u devnet -k "$K" --upgrade-authority "$K" \
  --program-id target/deploy/lineage_registry-keypair.json --max-len 516936 target/deploy/lineage_registry.so
solana program deploy -u devnet -k "$K" --upgrade-authority "$K" \
  --program-id target/deploy/lineage_launch-keypair.json --max-len 526224 target/deploy/lineage_launch.so
solana program show -u devnet 2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY
solana program show -u devnet 8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT
```

If a deploy is interrupted, `solana program show -u devnet --buffers -k "$K"` lists the buffer
holding the SOL; resume with `--buffer <address>` or close it with
`solana program close -u devnet -k "$K" <buffer>`.

## After the deploy (needs values from the owner)

1. A devnet `$LINE` mint (the real one is TBA; a Pump.fun-style Token-2022 test mint matches what the suites cover).
2. `lineage_registry::initialize`, signed by the deployer (the upgrade authority): admin, Core authority, `launch_program = 8eHzm1...`, and every SPEC 13 parameter (test values from `config/network.json` via `packages/chain` `paramsFromNetworkJson`).
3. One DBC config for agent launches, created with DBC `create_config` naming the launch `authority` PDA as fee claimer and leftover receiver (the suite's `encode_params` in `tests/src/lib.rs` is the encoding; its curve numbers are test values).
4. `lineage_launch::initialize_launch`, signed by the deployer: admin, runtime authority, compute sink, `agent_compute_bps`, `protocol_bps`, sleep and wake thresholds, the DBC config.

`packages/chain` builds every one of these instructions. It has no transaction sender yet, so a
small devnet script (sign, send, confirm) is the next piece of work once the owner approves.

## Review-fix upgrade (2026-10-07, measured)

| Program | `.so` bytes | sha256 | Added bytes (`solana program extend`) | Added rent (SOL) |
|---|---|---|---|---|
| `lineage_registry.so` | 543,408 | `1e64323fbe379a97e7761aa9f43a132628addbe92a53e41178a7ddd268a9cc2c` | 26,472 | 0.13447776 |
| `lineage_launch.so` | 563,864 | `847af59104b16cabc224a04215a5964c36ab86c8761abc2252d065b424be14da` | 37,640 | 0.1912112 |

Devnet rent is 5,080 lamports per byte (`solana rent -u devnet 1` prints 0.00065532 for the 128-byte
overhead plus one byte). Order: extend both ProgramData accounts by exactly the growth, then
`solana program deploy -u devnet -k "$K" --upgrade-authority "$K" --program-id <keypair> <so>` (the CLI
writes a buffer funded for the whole program, about 2.87 SOL for the launch program, and closes it
back to the payer), then `bun scripts/devnet/setup.ts --only b,d` runs `migrate_config` and
`migrate_launch_config` and syncs the TEST params. Instructions that read the configs fail between
the upgrade and the migration, so run them back to back.

## Bounties upgrade (2026-10-08, measured)

| Program | `.so` bytes | sha256 | Added bytes (`solana program extend`) | Added rent (SOL) |
|---|---|---|---|---|
| `lineage_launch.so` | 722,768 | `2bf5fb614bda53d5c1c55d88652c404e71c146e752546bbee5f65bb4bde89b34` | 158,904 | 0.80723232 |

Added rent measured as `solana rent -u devnet 722768` (3.67231168) minus `solana rent -u devnet 563864` (2.86507936); the deployer's balance fell by 0.80723732 SOL on the extend (rent plus its fee). The registry is unchanged (its devnet dump hashes `030766bc...22aa`, equal to the local build). Order: extend by exactly the growth, deploy, dump and compare the hash, then `bun scripts/devnet/setup.ts` (step h sets `BountyConfig`; nothing to migrate, every bounty account is new).
