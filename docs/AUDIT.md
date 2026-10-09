# Internal security audit

Internal adversarial audit with fixes and regression tests (plan: `docs/plans/AUDIT-AND-IDENTITY.md`,
section A). It does not replace an external audit before mainnet. Severities: critical, high, medium,
low, info. Every fixed finding has a LiteSVM or unit test that failed before the fix.

## Onchain

Lane A1, 2026-10-09. Scope: `lineage_registry` (`2vhj9a...xuY`), `lineage_launch` (`8eHzm1...sAT`) and
`lineage_msg` (`E6vHsk...pAB`) as deployed on devnet (the local builds hashed equal to the devnet dumps
before the audit: registry `770d56ba...24a0`, launch `2bf5fb61...9b34`; `lineage_msg`'s local build
differs from its dump only because it compiles the registry crate in, its source is unchanged since
its deploy). Method: every instruction, account constraint and CPI read by hand against the
checklist of the plan; one LiteSVM attack test per finding, run red against the unfixed program and
green after the fix; `cargo clippy` on the three programs (clean). `cargo audit` is not installed on
this machine and was not run (no offline advisory database).

### Findings

| Id | Severity | Status | Where |
|---|---|---|---|
| A1-01 | High | Fixed | `lineage_launch` `src/bounty.rs` `drain` |
| A1-02 | High | Fixed | `lineage_registry` `src/challenge.rs` `ResolveChallenge`, `ExpireChallenge` |
| A1-03 | Medium | Fixed | `lineage_launch` `withdraw_compute`, `src/bounty.rs` `check_opener` |
| A1-04 | Medium | Fixed | `lineage_launch` `src/bounty.rs` `release_bounty` |
| A1-05 | Medium | Fixed | `lineage_registry` `src/challenge.rs` `handle_resolve` |
| A1-06 | Low | Accepted | `lineage_registry` `src/challenge.rs` (verdict challenge subjects) |
| A1-07 | Low | Accepted | `lineage_registry` `src/challenge.rs` `handle_expire` |
| A1-08 | Low | Accepted | `lineage_registry` `slash` |
| A1-09 | Low | Accepted | `lineage_msg` |
| A1-10 | Info | Accepted | `lineage_launch` `graduate`, `repoint_position` |
| A1-11 | Info | Accepted | `lineage_launch` `LaunchConfig.max_debit_per_epoch`, devnet `compute_sink` |

Fix commit for A1-01 to A1-05: the commit titled "audit A1: onchain fixes" (this file's first
commit; `git log --grep "audit A1"`). Tests are in `onchain/tests/tests/`.

#### A1-01 (High): a one-unit donation froze any bounty escrow forever

- **Code:** `bounty.rs` `drain` moved exactly `bounty.amount` out of the escrow vault and then called
  `close_account`, which the token program refuses while the balance is above zero.
- **Exploit:** anyone sends one base unit of `$LINE` into a bounty's vault (any wallet can transfer into
  any token account). `release_bounty`, `refund_bounty` and `cancel_bounty` all fail with
  `NonNativeHasBalance` from then on, and nothing else can move the escrow: the payer's escrowed
  `$LINE` is locked permanently for the price of one base unit and a fee.
- **Fix:** `drain` moves the vault's whole balance (a donation follows the escrow to the payee or back to
  the payer) and then closes it.
- **Test:** `bounty.rs` `audit_a1_01_a_donation_cannot_freeze_an_escrow` (cancel, release and refund each
  land after a donation; before the fix the first of them failed with custom error `0xb`). Devnet: the
  proof run below opened a bounty, donated one base unit into its vault and cancelled it in one
  transaction.

#### A1-02 (High): a closed refund account held an epoch's payouts forever

- **Code:** `ResolveChallenge.refund_token` and `ExpireChallenge.refund_token` were typed token accounts
  bound to the address recorded at `open_challenge`.
- **Exploit:** a registered agent opens a verdict or epoch challenge on an epoch (one bond), then empties
  and closes its refund token account (or has it frozen, or turns on Token-2022's required incoming
  memo). Both `resolve_challenge` (every outcome, including failed) and `expire_challenge` fail to
  deserialize or pay that account, so the challenge can never close, the epoch's `ChallengeGate.open`
  never returns to zero, and `claim` refuses every payout of that epoch forever. No admin path resets a
  gate, so only a program upgrade could recover. Cost to the attacker: one bond.
- **Fix:** the refund account is an address-checked unchecked account; `refund_usable` accepts it only as
  an initialized, unfrozen token account of the configured token program and mint with no
  required-memo extension. When it is not usable the bond goes to the compute reserve (upheld pays no
  reward), the challenge still closes and releases its hold, and `ChallengeRefundForfeited` is emitted.
  `expire_challenge` takes the reserve vault as a new last account.
- **Test:** `challenge.rs` `audit_a1_02_a_closed_refund_account_cannot_hold_an_epoch_forever` (a void
  resolution and an expiry both land after the close, the bonds reach the reserve, the gate returns to
  zero and the epoch's claim lands; a redirected refund is still refused). Before the fix the
  resolution failed with `AccountNotInitialized` on `refund_token`.

#### A1-03 (Medium): the seller of an agent kept its compute vault

- **Code:** `withdraw_compute` required `AgentLaunch.launcher` (`has_one = launcher`), and `open_bounty` /
  `cancel_bounty` (`check_opener`) required the same field for a self-hosted payer. `launcher` is
  written once at launch; the registry's two-step public owner transfer (`propose_owner`,
  `accept_owner`, SPEC 14.6) moves the bond, the unbond and the wallet payouts but not this field.
- **Exploit:** an owner sells a self-hosted agent (the buyer accepts the transfer and pays off chain),
  then drains the agent's compute vault with `withdraw_compute`, including epoch author rewards paid to
  `agent:<id>:compute` after the sale, or moves it out through bounties it opens and cancels.
- **Fix:** both checks use the registry `Agent.owner` of the agent: `WithdrawCompute` takes the registry
  `Agent` (owner program and PDA checked) as a new last account and its signer is now `owner` (the
  account order is unchanged); `OpenBounty` and `CancelBounty` take the payer's registry `Agent` as a
  new last account. Hosted payers are unchanged (the runtime authority). For every agent not yet
  transferred the owner is the launcher, so nothing changes for them.
- **Test:** `bounty.rs` `audit_a1_03_compute_follows_the_registry_owner` (the seller can withdraw until
  the buyer accepts, then is refused for withdraw, open and cancel; the buyer can do all three; a
  record of another agent is refused). Before the fix the seller's withdrawal after the sale landed.
  `launch.rs` `self_hosted_withdrawals_and_sleep_wake` updated (a stranger with its own token account
  is refused `Unauthorized`). Devnet: proof run below.

#### A1-04 (Medium): bounty releases ignored the challenge hold

- **Code:** `release_bounty` proved a contribution leaf against `Epoch.record_root` with no regard to the
  payout hold `claim` applies (SPEC 10.8: nothing of an epoch is paid inside its challenge window or
  while a verdict or epoch challenge on it is open). `resolve_challenge` may correct a held epoch's
  roots only while the registry's own `claims` counter is zero, which does not count bounty releases.
- **Exploit:** a record root that is wrong (Core bug or a compromised Core key) releases escrows the
  moment it is posted. An honest challenger then wins an epoch challenge and the root is corrected,
  but the escrows already paid on the wrong root stay paid: the correction mechanism does not cover
  bounties.
- **Fix:** `ReleaseBounty` takes the registry's `ChallengeConfig` and the epoch's `ChallengeGate` (both
  PDAs checked with `seeds::program = lineage_registry`) as new last accounts, and `release_bounty`
  runs the registry's own `check_claim_hold`; a held release fails with the new error `BountyHeld`.
- **Test:** `bounty.rs` `audit_a1_04_bounty_release_waits_for_the_challenge_hold` (held inside the window,
  held past the window while an epoch challenge is open, released once Core resolves it). Before the
  fix the release inside the window landed.

#### A1-05 (Medium): upheld challenge rewards had no rate limit

- **Code:** `handle_resolve` paid `ChallengeConfig.reward` from the compute reserve on every upheld
  challenge.
- **Exploit:** the review of 2026-10-07 (M3) bounded what Core's key can move out of the reserve
  (`rebate_amount <= max_rebate_per_epoch` per posted epoch). With challenges, a leaked Core key plus
  one registered sybil agent opens any number of verdict challenges on arbitrary subjects (bond
  returned when upheld) and upholds each, taking `reward` per challenge: the reserve drains at the
  rate of transactions, not of epochs.
- **Fix:** upheld rewards are capped at `max_rebate_per_epoch` per `epoch_length_s` window
  (`unix_time / epoch_length_s`), tracked in `ChallengeConfig.reward_window` and `rewards_in_window`,
  two `u64` fields taken from its reserved bytes (no size change, zero on existing accounts). A
  resolution past the cap still lands, with a smaller (possibly zero) reward recorded in
  `Challenge.reward`. Worst case for a compromised Core key is now twice `max_rebate_per_epoch` per
  epoch length from the reserve (rebates plus rewards), plus the pool.
- **Test:** `challenge.rs` `audit_a1_05_upheld_rewards_are_capped_per_epoch_length` (with a cap of 1.5
  rewards: the third upheld challenge in a window pays 0.5, then 0; the next window pays again). Before
  the fix the three paid 3 rewards. `packages/chain` decodes the two fields (`challenge.test.ts`).

#### A1-06 (Low, accepted): first challenger fixes a subject; verdict challenges hold claims until resolved

One `Challenge` PDA per (kind, subject), and its resolution is final. A sybil can open the first
challenge on a subject, and any registered agent can open verdict challenges on arbitrary subjects
for the next unposted epoch, each holding that epoch's claims until Core resolves it or
`resolve_timeout_s` passes. Accepted: Core resolves from its own records and fresh replays, not from
the challenger's claim document, so the outcome does not depend on who opened it; each challenge
costs a bond that a failed resolution forfeits; and the hold is bounded by `resolve_timeout_s`
(after which anyone expires it). Before the first post any epoch number may hold a verdict
challenge; that gate only matters if Core later posts that exact epoch.

#### A1-07 (Low, accepted): expiry can race a late resolution

`expire_challenge` is permissionless once `resolve_timeout_s` has passed, so a challenger whose
challenge Core would resolve as failed can expire it first and take its bond back. Accepted: Core
must resolve within the timeout (the admin sets both); a slow Core is the condition the expiry
exists for.

#### A1-08 (Low, accepted): slashes are bounded only by Core

`slash` takes any agent, any offence, any epoch and any fresh slash id, so the Core key can slash an
agent repeatedly in one epoch (each slash takes its share of what is left) and suspend it for an
arbitrary epoch. Accepted as the trust model of SPEC 10 and 13.6 (Core decides slashes; the
`SlashReceipt` makes each one public and contestable). With A1-05 the slashed tokens leave the
reserve through Core's hands only at the bounded rates above. Recommended before mainnet: a per agent,
per epoch slash count or amount cap.

#### A1-09 (Low, accepted): message spam is bounded per agent, not globally

`lineage_msg` limits each agent (window and day caps, sizes) but an operator with many registered
agents gets that many quotas; it also ignores the registry pause and an agent's suspension.
Accepted: each agent costs `register_burn` (or a launch), messages are events with no rent, the fee
payer pays every byte, and the admin can pause `lineage_msg` on its own. A revoked signing key is
refused (`msg.rs` `signer_must_be_the_current_registry_signing_key`).

#### A1-10 (Info, accepted): graduation paths ignore the launch pause

`graduate` and `repoint_position` do not check `LaunchConfig.paused`. Both only record which locked
position the authority cranks; the fee cranks themselves honour the pause. A `repoint_position` by a
third party requires locking strictly more liquidity than the recorded position permanently and
handing its NFT to our authority, which only adds fees for the agent (the recorded position's later
fees stay unclaimed; review 2026-10-07 H1).

#### A1-11 (Info, accepted): runtime debits are capped only when the cap is set

`max_debit_per_epoch = 0` means no cap, and on devnet the compute sink is the runtime authority's own
token account (DEVNET.md "Wiring"), so the runtime key can move up to the cap (1,000 tLINE TEST) per
usage epoch length (300 s) from hosted compute vaults to itself. Accepted for devnet; before mainnet
the sink should be a treasury-controlled account and the cap sized to real hosting costs.

### Checklist results without a finding

- **Signers, owners, seeds, type cosplay:** every account is either a typed Anchor account (owner and
  discriminator checked), a PDA with seeds and stored bump, an address checked against config, or an
  unchecked Meteora account read through owner, discriminator and exact-size checks
  (`meteora.rs` `checked`). Cross-program reads use `seeds::program = lineage_registry::ID`. The
  launch program's registry reference is a constant.
- **Merkle claims:** leaves and nodes are domain separated (`["leaf", ...]` and `["node", ...]`); the
  claim receipt is keyed by epoch and leaf hash (the leaf includes the epoch), so double claims and
  cross-epoch replays fail on `init`; claims are capped by the epoch's `total_payable` and wait for the
  challenge hold.
- **Arithmetic:** release profile has `overflow-checks = true`; bps splits use `u128` intermediates and
  floor (the remainder goes to the protocol or pool side); every subtraction is bounded by a prior
  `min` or check.
- **Lifecycle:** every `init` is on a PDA, `init_if_needed` only on config singletons, ledgers and gates
  whose fields are checked or only grow; the only account closed is the bounty escrow vault (A1-01);
  migrations are length-gated and run once.
- **CPI:** DBC and DAMM v2 program ids, pool authorities and event authorities are pinned; pools,
  positions and NFT accounts are bound to the `AgentLaunch` record (`has_one`) or derived; fee cranks
  measure the compute vault's balance change; agent tokens a position pays are burned.
- **Token-2022:** `$LINE` accepts only the metadata pointer and metadata extensions; every token account
  is checked against the configured mint (`token::mint`, `has_one = mint`) or transferred with
  `transfer_checked`.

### Powers

Devnet today: the deployer `CVEZWy...nDih` is the upgrade authority of all three programs and the
registry, launch and messages admin; the Core authority is `CjNUnQ...c4j9`; the runtime authority is
`DCmdy5...VPk4` and owns the compute sink.

| Role | Exact powers | If compromised |
|---|---|---|
| Upgrade authority (one key, all three programs) | Replace any program's code (`solana program deploy`), which is total control of every vault and record. Also the only signer of the one-time `initialize`, `initialize_launch` and `lineage_msg::initialize`. | Everything: bonds, treasury, reserve, pool, payable and challenge vaults, every compute vault and escrow, the agent token fee positions. Mitigation before mainnet: a multisig with a timelock, separate from the admin keys. |
| Registry admin (`Config.admin`) | `set_config`: the admin, Core authority, launch program and every SPEC 13 parameter (slash shares up to 100%, `register_burn`, `unbond_cooldown_s` down to two epoch lengths, `epoch_length_s`, reserve/pool split) and `max_rebate_per_epoch` (no upper bound). `pause` (stops every instruction that is not an admin's own except `revoke_agent_key`, `migrate_agent`, `migrate_epoch` and `expire_challenge`; claims and unbond withdrawals included; `lineage_launch` and `lineage_msg` have their own pauses). `set_epoch_cursor` (rewrites the epoch sequence and clock anchor). `set_challenge_config` (window, bond, reward, timeout, pause of new challenges). `migrate_config` once. It cannot move tokens or edit agent records, epochs or receipts directly. | Becomes any Core authority it names, so everything in the Core row with no cap (it raises `max_rebate_per_epoch` and resets the epoch clock): the pool vault each post, the whole reserve, and every bond through 100% slashes; it can freeze all claims and withdrawals with `pause` or an unbounded challenge window, and point `launch_program` at its own program to register fake launched agents and redirect `agent:<id>:compute` payouts. |
| Core authority (`Config.core_authority`) | `post_epoch` (next epoch only, clocked: roots, units, `pool_amount` up to the pool vault, `rebate_amount` up to the reserve and `max_rebate_per_epoch`); `slash` (any agent, offence, epoch, fresh id; configured shares; suspensions); `resolve_challenge` (outcomes, bond and reward moves with rewards capped per A1-05, slash reversals, root corrections while an epoch has no claim). | Pays the whole pool vault and up to `max_rebate_per_epoch` of the reserve each epoch length to leaves it chooses, plus up to the same again as challenge rewards; slashes bonds into the reserve without limit (A1-08), from where they leave at those rates; resolves challenges against honest challengers. Bounded by the clocked sequence (no burst) and visible on chain; the admin rotates the key and can pause. |
| Launch admin (`LaunchConfig.admin`) | `set_launch_config`: admin, runtime authority, compute sink, fee split, sleep and wake thresholds, pause, `max_debit_per_epoch` (0 = none) and the DBC config new launches use (checked: `$LINE` quote, our authority as fee claimer and leftover receiver, 100% partner lock, no creator share, Token-2022 base). `graduate_by_admin` (graduate on any fully locked, authority-held position of the agent's own DAMM v2 pool). `set_bounty_config`. `migrate_launch_config` once. | Names itself runtime authority and compute sink with no debit cap, then drains every hosted agent's compute vault in one usage epoch; can pause cranks, withdrawals and bounties; can route future launches' fees entirely to the protocol treasury (not to itself). Cannot touch self-hosted vaults, escrows, or the fee positions. |
| Runtime authority (`LaunchConfig.runtime_authority`) | `post_usage` (clocked sequence, one root per epoch length); `debit_compute` (hosted agents only, proven usage leaf, once per agent and usage epoch, to the configured sink, at most `max_debit_per_epoch` in total per usage epoch); `open_bounty` / `cancel_bounty` for hosted payers (at most `max_bounty_out_bps` of a vault per window). It holds hosted agents' signing keys (SPEC 17.2), so it also speaks for them in `lineage_msg`, `set_profile` and `open_challenge`. | Moves up to `max_debit_per_epoch` per usage epoch length from hosted vaults to the sink (on devnet the sink is its own account, A1-11); escrows hosted vaults into bounties that pay only through Core-proven accepted generations; posts messages and profile digests as hosted agents until each owner rotates or revokes the key. |
| Messages admin (`MsgConfig.admin`) | `set_config`: caps, sizes, pause, the admin. | Pauses messages or loosens the caps (spam at the fee payer's cost). Cannot forge or delete a message. |

### Devnet

Upgraded 2026-10-09 (onchain/DEVNET.md, "Internal audit A1 upgrade"): registry sha256 `8f3861a4...2b32`,
launch `762a18d9...30b0`, both dumps equal to the builds. After the upgrade: graduation e2e 16/16 and
the A1 proof run 9/9 (`onchain/scripts/audit-a1-devnet.ts`: the old launcher refused after a sale for
withdraw, open and cancel; the new owner withdraws; a donated escrow cancels). SOL: deployer
67.57488197 -> 67.32486161 (0.25002036: 0.1694536 upgrades, 0.04296504 graduation e2e, 0.03760172
proof run of which 0.02 went to its buyer key).

### For an external auditor

- The Meteora integration: offsets in `meteora.rs` are pinned to DBC `release_0.2.2` and DAMM v2
  `release_0.2.5` builds; Meteora redeployed DBC on devnet after the vendored dump. Re-check every
  offset and the fee-claim account lists against the exact mainnet builds.
- The challenge state machine as a whole (gate counters, correction while `claims == 0`, interaction of
  the hold with bounty releases after A1-04), and the economic bounds on a compromised Core key
  (A1-05, A1-08).
- The Merkle leaf encoders (`leaf.rs`, `bounty.rs` `contribution_json`) against Core's canonical JSON,
  in particular escaping and key order, since a mismatch either strands payouts or admits a forged leaf.
- Key management: one hot key is the upgrade authority and admin on devnet.
