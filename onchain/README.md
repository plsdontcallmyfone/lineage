# Lineage onchain programs (SPEC 14)

One Anchor 0.31.1 workspace, two programs, one LiteSVM test crate. Deployed to devnet only
([DEVNET.md](DEVNET.md)); see [DEPLOY.md](DEPLOY.md).

| Path | What |
|---|---|
| `programs/lineage-registry` | `lineage_registry` (`2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY`): config, agents, burn, bond, unbond, slash, split, epochs, Merkle claims. `src/leaf.rs` is protocol `H`/`leafHash`/`nodeHash` byte for byte. |
| `programs/lineage-launch` | `lineage_launch` (`8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT`): agent tokens on Meteora DBC quoted in `$LINE`, fee cranks, graduation to DAMM v2, compute vaults, usage debits, bounties (`src/bounty.rs`, SPEC 14.7). `src/meteora.rs` holds Meteora addresses, account readers and raw CPIs (no Meteora crate, offline build). |
| `tests` | LiteSVM harness (`src/lib.rs`) and suites: `registry.rs`, `launch.rs`, `identity.rs`, `bounty.rs`, `client_vectors.rs` |
| `tests/fixtures/merkle.json` | roots, leaves and proofs built by `@lineage/protocol` (`scripts/make-fixtures.ts`) |
| `tests/fixtures/client-vectors.json` | instruction encodings and live account bytes that `packages/chain` is tested against |
| `vendor/meteora` | DBC and DAMM v2 dumped from devnet (`fetch.sh`, sha256 pinned; the `.so` files are not committed) |
| `keys-backup/` | copies of the program id keypairs (gitignored; also in `~/.config/lineage/program-keys/`). Never delete `target/` without them. |

The pattern (program PDA as DBC creator and fee claimer, 100% partner-locked LP, raw CPIs,
LiteSVM against dumped Meteora builds) follows the read-only reference at
`~/instance-network/onchain/launch`.

## Build and test

Toolchain: anchor-cli 0.31.1, solana-cli 3.1.12 (`cargo-build-sbf`, platform tools v1.52), rustc
for host tests. `blake3` is pinned to 1.8.2 in `Cargo.lock` (1.8.7 pulls `digest` 0.11, whose
unused functions exceed the SBF stack limit at build time). Nothing touches the machine-wide
`solana config`.

```sh
cd onchain
vendor/meteora/fetch.sh                      # once: read-only dumps from devnet, hashes checked
cargo build-sbf --offline --manifest-path programs/lineage-registry/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-launch/Cargo.toml --sbf-out-dir target/deploy
cargo test --offline -p lineage-onchain-tests              # LiteSVM suites (load target/deploy/*.so)
cargo test --offline -p lineage-registry --lib             # leaf encoder unit tests
bun scripts/make-fixtures.ts --check                       # from the repo root: bun onchain/scripts/make-fixtures.ts --check
bun test packages/chain                                    # from the repo root
```

`cargo build-sbf` builds; `anchor deploy` does not. Rebuild both programs before the LiteSVM
suites after any program change. `UPDATE_VECTORS=1 cargo test -p lineage-onchain-tests --test client_vectors`
regenerates the client vectors after an instruction or account layout change.

## Leaf encoding

No binary encoding was needed: the registry hashes the payout leaf exactly as Core does,
`sha256('["leaf","{\"agent\":\"<A>\",\"amount\":\"<N>\",\"dest\":\"<D>\",\"epoch\":<E>}"]')`, and
nodes as `sha256('["node","<lo hex>","<hi hex>"]')`. The agent and wallet keys are base58-encoded
onchain from their 32 bytes; the destination string is rebuilt from a kind and a key. See SPEC 14.3.

## Review fixes (2026-10-07, onchain fixes lane)

An adversarial review found these; each is fixed and covered by a LiteSVM test (`tests/tests/*.rs`).

| Finding | Fix | Test |
|---|---|---|
| H1 `graduate` could be bound to a forged dust position (third party locks dust, hands its NFT to our authority, graduates first) | `graduate` requires the position to hold a strict majority of the pool's permanently locked liquidity (only DBC's migration position does); `repoint_position` (anyone) moves to an authority-held, fully locked position with strictly more locked liquidity; `graduate_by_admin` skips the majority rule for a pool where a third party locked more and kept its NFT (every other check stays) | `forged_dust_position_cannot_graduate` (the 4-step attack fails), `admin_graduates_past_a_larger_third_party_lock` |
| H2 curve fees and partner surplus left at migration were stranded | `crank_fees` works before and after graduation | `curve_fees_left_at_migration_are_cranked_after_graduation` |
| M1 a retried slash could land twice | `slash(offence, epoch, slash_id)` creates a `SlashReceipt` PDA `["slash", slash_id]`; Core sends `sha256(["lineage-slash", id, agent, reason, ref, epoch])` | `slash_lands_once_per_id` |
| M2 a runtime key could drain every compute vault | `post_usage` is one sequence (exactly last + 1) at most one epoch (registry `epoch_length_s`) ahead of its clock anchor; `debit_compute` only for hosted agents; `max_debit_per_epoch` (0 = no cap) | `usage_sequence_hosted_only_and_debit_cap` |
| M3 a Core key could post arbitrary epochs and amounts | `post_epoch`: exactly last + 1 (the first post may be any epoch and sets the anchor), epoch `anchor + k` not before `anchor_ts + (k - 1) x epoch_length_s`, `pool_amount` <= pool vault, `rebate_amount` <= reserve and <= `max_rebate_per_epoch` (config); admin `set_epoch_cursor` repairs the sequence | `post_epoch_sequence_clock_and_caps` |
| M4 unbond cooldown had no floor | `unbond_cooldown_s >= 2 x epoch_length_s` (chosen over "two post_epochs after the request", which would freeze unbonds whenever Core stops posting) | `config_floors_and_nonzero_keys` |
| L1 Core desync when a send reported failure but landed | the bridge reads back the `Epoch` PDA (same root) or `SlashReceipt` PDA and records the send as landed | `packages/core/test/chain.test.ts` |
| L2 `registry_program` admin-changeable | a constant (`lineage_registry::ID`); the field stays in the layout | `full_launch_records_everything` |
| L3 any Token-2022 `$LINE` accepted | both initializers allow only metadata pointer and metadata extensions | `line_mint_extension_allowlist` |
| L4 surplus threshold from the launch config | read from the pool's own DBC config | covered by the crank tests |
| L5 long URI and URL could not fit one transaction | name + symbol + URI + URL <= `MAX_LAUNCH_STRINGS` (227): the longest accepted launch is exactly 1,232 bytes with three signers and both compute budget instructions | `longest_launch_fits_one_transaction` |
| L6 a late strike reset the epoch count | the per-epoch count restarts only for a strictly newer epoch | `slash_strikes_and_suspension` |
| L7 failed slashes were dropped after 5 attempts | pending until they land, retried with backoff (5 s doubling to 10 min); same for epochs | `packages/core/test/chain.test.ts` |
| L8 config validation | nonzero admin, Core authority, launch program, compute sink; `min_bond <= bond_cap`. `bond_cap` is the assignment-weight cap (SPEC 10.1, `min(bond, bond_cap)`), not a cap on the bond, so it is not enforced on `bond` | `config_floors_and_nonzero_keys`, `usage_sequence_hosted_only_and_debit_cap` |

Layouts: `Config` gained `max_rebate_per_epoch`, `epoch_anchor`, `epoch_anchor_ts` (24 bytes) and
`LaunchConfig` gained `max_debit_per_epoch` and the usage sequence (40 bytes), appended at the end.
`migrate_config` and `migrate_launch_config` (admin, once) grow accounts the first layout wrote;
`packages/chain` decodes both layouts (new fields null on the old one).


## Agent identity and records (2026-10-07, identity onchain lane)

Identity plan I1 and I2 (`docs/plans/IDENTITY-AND-COLLABORATION.md`, SPEC 14.6). `lineage_registry` only; `lineage_launch` is unchanged.

| Change | Rule | Test (`tests/tests/identity.rs` unless noted) |
|---|---|---|
| `Agent` v2: `signing_key`, `key_seq`, `key_changed_at`, `profile_digest`, `profile_seq`, `pending_owner`, `owner_since`, 32 reserved bytes (152 bytes appended) | new records start with `signing_key` = the agent key and `owner_since` = `registered_at` | `new_records_start_as_v2_with_the_agent_key` |
| `rotate_agent_key` | owner and the new key both sign; refused while paused | `rotate_needs_the_owner_and_the_new_key` |
| `revoke_agent_key` | owner only, allowed while paused; `set_profile` and Core refuse the revoked key until a rotation | `revoke_blocks_until_a_rotation` |
| `set_profile(digest, seq)` | the current signing key, `seq` strictly increasing | `profile_is_set_by_the_current_signing_key_with_increasing_seq` |
| `propose_owner` / `accept_owner` | two steps; the old owner loses bond, unbond and rotation rights at acceptance; `owner_since` restarts | `owner_transfer_is_two_step_and_public` |
| `migrate_agent` | anyone (payer adds rent), once, only a program-owned Agent at its PDA with the v1 length | `migrate_agent_grows_v1_records` |
| `Epoch.record_root` (32 bytes appended), `post_epoch` takes it, `migrate_epoch` grows older epochs (zero root) so their claims keep working | | `migrate_epoch_keeps_old_epochs_claimable`, `epoch_post_and_claim_with_a_typescript_root` (registry.rs) |

`packages/chain`: `registry.rotateAgentKey`, `revokeAgentKey`, `setProfile`, `proposeOwner`, `acceptOwner`, `migrateAgent`, `migrateEpoch`, `postEpoch({ recordRoot })`; `decodeAgent` and `decodeEpoch` read both layouts (`version` 1 or 2; v1 fields read as `migrate_*` will write them; a revoked key and a zero root decode as null); `ChainReader.epochs()`. `cosign` accepts a `rotate_agent_key` for the new key it names. Client vectors regenerated.

Devnet: upgraded and migrated in place on 2026-10-07 (DEVNET.md, "Identity upgrade"); `scripts/devnet/setup.ts` step g migrates any v1 record left (idempotent).

## Bounties (2026-10-08, bounties lane)

Identity plan C6, SPEC 14.7. `lineage_launch` only (`src/bounty.rs`); the registry is unchanged and is read through its own types (`Account<lineage_registry::Epoch>` and `Config` with `seeds::program`, so owner and address are checked). New accounts only (`BountyConfig`, `Bounty`, `BountyVault`, `BountyLedger`, `BountyReceipt`): no existing account changes layout, so no migration. `contribution_leaf` rebuilds Core's contribution leaf (packages/core records.ts) with `lineage_registry::leaf`; `make-fixtures.ts` builds the fixture leaves with records.ts itself, and `rust_contribution_leaf_matches_core` checks the JSON and the leaf byte for byte.

| Rule | Test (`tests/tests/bounty.rs`) |
|---|---|
| a Core-built record root releases the escrow into the payee's compute vault once; double release and refund after release refused | `release_with_a_core_proof_pays_the_payee_compute_vault_once` |
| wrong payee (named payee not credited, the payer itself, a non-author on an open bounty), wrong condition (other commitment, other target, other lineage), forged leaf fields | `wrong_payee_and_wrong_condition_are_refused` |
| a leaf releases one bounty of each payer (receipt); a generation from before the bounty opened (epoch below `min_epoch`) does not qualify | `proof_reuse_and_stale_generations_are_refused` |
| forged record roots: a registry-owned Epoch at another address (seeds), the PDA owned by another program (owner), the attacker's own tree against the real root (proof) | `forged_record_roots_are_refused` |
| early refund refused until deadline plus grace; an epoch posted after the deadline does not qualify | `refund_only_after_deadline_and_grace_and_late_epochs_do_not_qualify` |
| hosted payer: runtime only; self-hosted payer: launcher only; TTL bounds, minimum, payee not payer; `max_bounty_out_bps` per window (cap breach refused, next window allowed) | `caps_and_opener_rules` |
| self-hosted payees capped per window, cap 0 pays none | `self_hosted_payees_are_capped` |
| cancel by the opener's authority only, only before the registry posts another epoch | `cancel_only_by_the_opener_before_the_next_epoch` |
| config admin-only and validated | `config_is_admin_only_and_validated` |

`packages/chain`: `bounty.setConfig`, `open`, `release` (from a Core contribution), `refund`, `cancel`; `bountyPdas`; `decodeBountyConfig`, `decodeBounty`, `decodeBountyLedger`, `decodeBountyReceipt`; `contributionLeaf`, `targetDigest`, `termsDigest`, `releaseFromContribution`; `ChainReader.bountyConfig()`, `bounties()`, `bounty()`, `bountyLedger()`. Client vectors regenerated (five instructions, four accounts).

Devnet: `lineage_launch` extended and upgraded in place on 2026-10-08 (DEVNET.md, "Bounties upgrade"); `scripts/devnet/setup.ts` step h sets the TEST `BountyConfig`, step i launches a hosted TEST bounty payer agent and funds its compute vault.
