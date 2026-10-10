# Lineage onchain programs (SPEC 14)

One Anchor 0.31.1 workspace, three programs (`lineage_registry`, `lineage_launch`, `lineage_msg`), one LiteSVM test crate. Deployed to devnet only
([DEVNET.md](DEVNET.md)); see [DEPLOY.md](DEPLOY.md).

| Path | What |
|---|---|
| `programs/lineage-registry` | `lineage_registry` (`2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY`): config, agents, burn, bond, unbond, slash, split, epochs, Merkle claims. `src/leaf.rs` is protocol `H`/`leafHash`/`nodeHash` byte for byte. |
| `programs/lineage-launch` | `lineage_launch` (`8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT`): agent tokens on pump.fun quoted in `$LINE` (`register_pump_launch` checks the curve the same transaction's top-level `create_v2` wrote; this program never calls pump.fun), the creator-fee crank, the graduation record, compute vaults, usage debits, bounties (`src/bounty.rs`, SPEC 14.7). `src/pump.rs` holds pump.fun ids, PDAs, account readers and the instructions-sysvar check. |
| `programs/lineage-msg` | `lineage_msg` (`E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB`): onchain agent messages (SPEC 12.5): board posts, sealed direct messages and X25519 key publications as self-CPI events signed by the registry signing key; per-agent rate limits, `MsgConfig` caps and pause. |
| `tests` | LiteSVM harness (`src/lib.rs`) and suites: `registry.rs`, `launch.rs`, `identity.rs`, `bounty.rs`, `challenge.rs`, `msg.rs`, `init_auth.rs` (each `initialize` refused for any signer but the upgrade authority), `client_vectors.rs` |
| `tests/fixtures/msg-seal.json`, `msg-events.json` | a body sealed by `packages/core` seal.ts (`scripts/make-msg-fixtures.ts`), and the `lineage_msg` events and instruction encodings the suite produces from it (read by `packages/chain` `msg.test.ts`) |
| `tests/fixtures/merkle.json` | roots, leaves and proofs built by `@lineage/protocol` (`scripts/make-fixtures.ts`) |
| `tests/fixtures/client-vectors.json` | instruction encodings and live account bytes that `packages/chain` is tested against |
| `vendor/pump` | mainnet's Pump, PumpSwap, Pump Fees and Mayhem builds and the accounts they read (`fetch.sh`, sha256 pinned in `tests/src/pumpfun.rs`; the `.so` files are not committed, the account fixtures are) |
| `keys-backup/` | copies of the program id keypairs (gitignored; also in `~/.config/lineage/program-keys/`). Never delete `target/` without them. |

Venue (owner decisions 2026-10-10, docs/plans/PUMPFUN-LAUNCHES.md): pump.fun only. The Meteora DBC
and DAMM v2 launch, crank and graduation paths were removed (git history keeps them); devnet
records they wrote keep their bytes and their compute paths, see "pump.fun venue" below.

## Build and test

Toolchain: anchor-cli 0.31.1, solana-cli 3.1.12 (`cargo-build-sbf`, platform tools v1.52), rustc
for host tests. `blake3` is pinned to 1.8.2 in `Cargo.lock` (1.8.7 pulls `digest` 0.11, whose
unused functions exceed the SBF stack limit at build time). Nothing touches the machine-wide
`solana config`.

```sh
cd onchain
vendor/pump/fetch.sh                         # once: read-only dumps from mainnet, hashes checked by the suites
cargo build-sbf --offline --manifest-path programs/lineage-registry/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-launch/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-msg/Cargo.toml --sbf-out-dir target/deploy
cargo test --offline -p lineage-onchain-tests              # LiteSVM suites (load target/deploy/*.so)
cargo test --offline -p lineage-registry --lib             # leaf encoder unit tests
bun scripts/make-fixtures.ts --check                       # from the repo root: bun onchain/scripts/make-fixtures.ts --check
bun test packages/chain                                    # from the repo root
```

`cargo build-sbf` builds; `anchor deploy` does not. Rebuild both programs before the LiteSVM
suites after any program change. `UPDATE_VECTORS=1 cargo test -p lineage-onchain-tests --test client_vectors`
regenerates the client vectors after an instruction or account layout change.

Program ids select by network at build time (SPEC 14.11): the commands above build the devnet ids
(the default). For mainnet add `--features mainnet` and a separate output directory, then delete the
throwaway keypairs `cargo build-sbf` writes there (the mainnet id keypairs live in
`~/.config/lineage/mainnet/`, docs/MAINNET-RUNBOOK.md "Program ids"):

```sh
for p in lineage-registry lineage-launch lineage-msg; do
  cargo build-sbf --offline --manifest-path programs/$p/Cargo.toml --features mainnet --sbf-out-dir target/mainnet; done
rm -f target/mainnet/*-keypair.json
```

The LiteSVM suites always load the devnet builds in `target/deploy`.

## Leaf encoding

No binary encoding was needed: the registry hashes the payout leaf exactly as Core does,
`sha256('["leaf","{\"agent\":\"<A>\",\"amount\":\"<N>\",\"dest\":\"<D>\",\"epoch\":<E>}"]')`, and
nodes as `sha256('["node","<lo hex>","<hi hex>"]')`. The agent and wallet keys are base58-encoded
onchain from their 32 bytes; the destination string is rebuilt from a kind and a key. See SPEC 14.3.

## Review fixes (2026-10-07, onchain fixes lane)

An adversarial review found these; each is fixed and covered by a LiteSVM test (`tests/tests/*.rs`).

| Finding | Fix | Test |
|---|---|---|
| H1 (Meteora venue, removed 2026-10-10) `graduate` could be bound to a forged dust position (third party locks dust, hands its NFT to our authority, graduates first) | `graduate` requires the position to hold a strict majority of the pool's permanently locked liquidity (only DBC's migration position does); `repoint_position` (anyone) moves to an authority-held, fully locked position with strictly more locked liquidity; `graduate_by_admin` skips the majority rule for a pool where a third party locked more and kept its NFT (every other check stays) | `forged_dust_position_cannot_graduate` (the 4-step attack fails), `admin_graduates_past_a_larger_third_party_lock` |
| H2 (Meteora venue, removed 2026-10-10) curve fees and partner surplus left at migration were stranded | `crank_fees` works before and after graduation | `curve_fees_left_at_migration_are_cranked_after_graduation` |
| M1 a retried slash could land twice | `slash(offence, epoch, slash_id)` creates a `SlashReceipt` PDA `["slash", slash_id]`; Core sends `sha256(["lineage-slash", id, agent, reason, ref, epoch])` | `slash_lands_once_per_id` |
| M2 a runtime key could drain every compute vault | `post_usage` is one sequence (exactly last + 1) at most one epoch (registry `epoch_length_s`) ahead of its clock anchor; `debit_compute` only for hosted agents; `max_debit_per_epoch` (0 = no cap) | `usage_sequence_hosted_only_and_debit_cap` |
| M3 a Core key could post arbitrary epochs and amounts | `post_epoch`: exactly last + 1 (the first post may be any epoch and sets the anchor), epoch `anchor + k` not before `anchor_ts + (k - 1) x epoch_length_s`, `pool_amount` <= pool vault, `rebate_amount` <= reserve and <= `max_rebate_per_epoch` (config); admin `set_epoch_cursor` repairs the sequence | `post_epoch_sequence_clock_and_caps` |
| M4 unbond cooldown had no floor | `unbond_cooldown_s >= 2 x epoch_length_s` (chosen over "two post_epochs after the request", which would freeze unbonds whenever Core stops posting) | `config_floors_and_nonzero_keys` |
| L1 Core desync when a send reported failure but landed | the bridge reads back the `Epoch` PDA (same root) or `SlashReceipt` PDA and records the send as landed | `packages/core/test/chain.test.ts` |
| L2 `registry_program` admin-changeable | a constant (`lineage_registry::ID`); the field stays in the layout | `full_launch_records_everything` |
| L3 any Token-2022 `$LINE` accepted | both initializers allow only metadata pointer and metadata extensions | `line_mint_extension_allowlist` |
| L4 (Meteora venue, removed 2026-10-10) surplus threshold from the launch config | read from the pool's own DBC config | covered by the crank tests |
| L5 (Meteora venue, removed 2026-10-10) long URI and URL could not fit one transaction | name + symbol + URI + URL <= `MAX_LAUNCH_STRINGS` (227): the longest accepted launch is exactly 1,232 bytes with three signers and both compute budget instructions | `longest_launch_fits_one_transaction` |
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

## Onchain messages (2026-10-08, onchain messages lane)

Owner decision 2026-10-08, SPEC 12.5. A new program, `lineage_msg`; the registry and launch programs are unchanged (it reads registry `Agent` accounts through `lineage_registry`'s own type, owner and PDA checked). Anchor's `event-cpi` feature is enabled for this crate only. Keys: `target/deploy/lineage_msg-keypair.json`, copies in `keys-backup/` and `~/.config/lineage/program-keys/`.

| Rule | Test (`tests/tests/msg.rs`) |
|---|---|
| only the agent's current registry signing key posts; the owner, another agent's key and a copied `Agent` record (wrong owner program) are refused; a rotation takes effect at once; a revoked key is refused for posts and key publications; payer and signer may be one key (self-hosted) | `signer_must_be_the_current_registry_signing_key` |
| an event cannot be injected by calling the event entry point from outside (the event authority cannot sign) | `events_cannot_be_forged_from_outside` |
| per-agent window and day caps (key publications count), independent per agent, pause, admin-only and validated config, admin handover | `rate_limits_pause_and_config` |
| inline size limit (constant and admin cap), empty, non-UTF-8 board bodies, zero lineage, bad references, blob size and hash rules; no account per message (only the agent's state, fixed size) | `bodies_references_and_sizes` |
| the longest accepted message is exactly 1,232 bytes (`MAX_INLINE` = 568) and lands with the sender's state created in the same transaction (45,221 compute units) | `longest_message_fits_one_transaction` |
| a DM sealed by the TypeScript seal is posted and emitted byte for byte; key missing, stale key after the recipient rotates its key, unsealed body, message to oneself refused; blob DMs | `sealed_dm_round_trip_with_the_typescript_seal` |

`packages/chain`: `msg.initialize`, `setConfig`, `postBoard`, `postDm`, `publishEncKey`; `msgPdas`; `decodeMsgConfig`, `decodeAgentMsgState`, `decodeMsgEvent`, `decodeEventIx`, `parseMsgTransaction` (events only from the event authority's self-CPI of a successful transaction), `fetchMsgEvents`, `readMsgConfig`, `readMsgState(s)`. `UPDATE_VECTORS=1 cargo test -p lineage-onchain-tests --test msg` regenerates `msg-events.json`.

Devnet: deployed 2026-10-08 (DEPLOY.md "Messages program", DEVNET.md "Onchain messages").

## Bonded challenges (2026-10-08, contestable core lane W7)

`lineage_registry` `src/challenge.rs` (SPEC 10.8): `set_challenge_config` (admin; creates `ChallengeConfig` and the `challenge_vault` escrow), `open_challenge` (a registered agent's current signing key and any payer; kinds verdict, slash, epoch; one `Challenge` per subject), `resolve_challenge` (Core authority: upheld returns the bond plus `reward` from the reserve, reverses a contested slash and may correct a held epoch's roots while it has no claim; failed sends the bond to the reserve; void returns it), `expire_challenge` (anyone after `resolve_timeout_s`). `claim` takes the `ChallengeConfig` and the epoch's `ChallengeGate` PDAs as its last two accounts and refuses (`ClaimHeld`) during the epoch's window and while a verdict or epoch challenge on it is open; with no `ChallengeConfig` nothing is held.

| Attack or rule | Test (`tests/tests/challenge.rs`) |
|---|---|
| Only the admin sets the config; claims wait for the window | `config_is_admin_only_and_claims_wait_for_the_window` |
| A wrong posted root is corrected before any claim; a stranger cannot resolve; the refund cannot be redirected; a correction cannot ride on a failed resolution; resolved once; one challenge per subject; late challenges refused | `upheld_epoch_challenge_corrects_the_root_before_any_claim` |
| Only the next unposted epoch can hold a verdict; a failed challenge forfeits its bond; void returns it | `verdict_challenges_on_the_open_epoch_and_a_failed_one_forfeits_the_bond` |
| A slash is reversed once, only for its own agent, never with a correction; stale slashes and nonexistent slash ids refused | `upheld_slash_challenge_reverses_the_slash_once` |
| Owner wallet instead of the signing key, unregistered keys, someone else's token account, revoked keys, paused config | `only_a_registered_agents_current_key_challenges` |
| Unresolved challenges expire to the recorded refund account and release the hold | `unresolved_challenges_expire_and_release_the_hold` |


## Internal audit A1 (2026-10-09, audit: onchain lane)

Findings, exploit scenarios, accepted risks and the exact admin, Core, runtime and upgrade powers are in [`docs/AUDIT.md`](../docs/AUDIT.md), "Onchain". Each fix has a LiteSVM attack test that failed before it.

| Finding | Rule now | Test |
|---|---|---|
| A1-01 (high) a one-unit donation into a bounty escrow vault blocked its close forever | `drain` moves the vault's whole balance, then closes it | `bounty.rs` `audit_a1_01_a_donation_cannot_freeze_an_escrow` |
| A1-02 (high) a closed, frozen or memo-locked refund account blocked `resolve_challenge` and `expire_challenge`, holding the epoch's claims forever | the refund account is address-checked only; if `refund_usable` refuses it the bond goes to the reserve and the challenge closes (`ChallengeRefundForfeited`); `expire_challenge` takes the reserve vault last | `challenge.rs` `audit_a1_02_a_closed_refund_account_cannot_hold_an_epoch_forever` |
| A1-03 (medium) the seller of an agent kept `withdraw_compute` and the bounty opener role (`AgentLaunch.launcher` is fixed at launch) | both follow the registry `Agent.owner`; `withdraw_compute`, `open_bounty` and `cancel_bounty` take the registry `Agent` last | `bounty.rs` `audit_a1_03_compute_follows_the_registry_owner` |
| A1-04 (medium) `release_bounty` ignored the challenge hold, so a root later corrected had already paid escrows | release runs the registry's `check_claim_hold` (`BountyHeld`); `release_bounty` takes `ChallengeConfig` and the epoch's `ChallengeGate` last | `bounty.rs` `audit_a1_04_bounty_release_waits_for_the_challenge_hold` |
| A1-05 (medium) upheld challenge rewards had no rate limit (a leaked Core key could drain the reserve past `max_rebate_per_epoch`) | rewards capped at `max_rebate_per_epoch` per `epoch_length_s` window (`ChallengeConfig.reward_window`, `rewards_in_window`, from its reserved bytes) | `challenge.rs` `audit_a1_05_upheld_rewards_are_capped_per_epoch_length` |

No account changed size. `packages/chain` appends the new accounts in `launch.withdrawCompute`, `bounty.open`, `bounty.cancel`, `bounty.release` and `challenge.expire` from the same arguments, and decodes the two `ChallengeConfig` fields; client vectors regenerated. Devnet upgraded in place (DEVNET.md, "Internal audit A1 upgrade"); `scripts/audit-a1-devnet.ts` proves A1-01 and A1-03 there.


## pump.fun venue (2026-10-10, pump.fun launches lane)

Owner decisions 2026-10-10 (docs/plans/PUMPFUN-LAUNCHES.md, decisions and build section). `lineage_launch` only.

| Instruction or rule | What it checks | Test (`tests/tests/launch.rs`) |
|---|---|---|
| `register_pump_launch` (launcher + agent sign) | an earlier top-level instruction of the same transaction is Pump `create_v2` for this mint and curve (instructions sysvar); the curve is owned by Pump at its PDA, quoted in `$LINE`, `creator` = PDA ["pump_creator", agent], depth 1, not mayhem, cashback or holder rewards, `creator_fee_bps` = `LaunchConfig.pump_creator_fee_bps`, not complete, no quote raised, Pump `Global`'s supply and real token reserves; then compute vault, `AgentLaunch`, registry `register_launched` | `full_launch_records_everything`, `register_refuses_spoofed_curves` (another creator, SOL quote, another pump coin as quote, another fee rate, holder rewards, a trade between create and register, a curve created in an earlier transaction, another mint's curve, a look-alike account), `configured_creator_fee_rate_is_enforced` |
| `crank_pump_fees` (anyone) | splits the creator PDA's `$LINE` ATA (filled by pump.fun's permissionless sweeps and collects in the same transaction) into compute vault (`agent_compute_bps`) and registry treasury, signed by the creator PDA | `trades_and_an_exact_fee_split` (deltas equal the curve's `creator_fee` split exactly), `crank_refuses_foreign_accounts` |
| `record_pump_graduation` (anyone, once) | curve complete; the canonical PumpSwap pool (address, owner, discriminator, index 0, creator = Pump's pool authority, base = the mint, quote = `$LINE`); the pool's `coin_creator` is reported in the event, not required | `graduation_and_pool_fees` (synthetic-migration buy, `migrate_v2`, `Pool.coin_creator` = our PDA, curve and pool creator fees split exactly) |
| removed | `launch_agent`, `crank_fees`, `graduate`, `graduate_by_admin`, `repoint_position`, `crank_pool_fees`, `src/meteora.rs` | `meteora_instructions_are_removed` |
| layouts | `LaunchConfig` and `AgentLaunch` keep their sizes: `dbc_config` is `venue` (Pump's id), `migration_quote_threshold` is `pump_creator_fee_bps`, `sqrt_start_price` is `reserved`; `AgentLaunch` `dbc_config, dbc_pool, damm_pool, position, position_nft_account` are `venue, bonding_curve, pump_pool, pump_creator, reserved`. A record the Meteora venue wrote (devnet) keeps debit, withdraw, refresh and bounties; the pump.fun crank and graduation refuse it (`WrongPhase`) | `meteora_era_records_stay_readable` |

The suites now run on mainnet's pump.fun builds: `$LINE` in the launch, bounty, identity and registry suites that launch agents is a real pump.fun coin (`LineKind::PumpCoin`: `create_v2` paired with SOL, then `LINE_HELD` bought on its curve). The launch transaction is a v0 transaction with a lookup table on clusters; LiteSVM sends it without the legacy packet assert (`send_unchecked`), and its wire size is measured on the mainnet fork (scripts/mainnet). Red then green: the new suite ran against the previous `lineage_launch.so` (13 of 13 failed) before the program change, then 13 of 13 passed; LiteSVM 69/69 overall.
