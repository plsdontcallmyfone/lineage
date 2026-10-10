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

Fix commit for A1-01 to A1-05: `b855b4a` ("audit A1: onchain fixes"). Tests are in
`onchain/tests/tests/`.

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

## Offchain

Lane A2, 2026-10-09. Scope: Core (auth, nonces, admin routes, author-blind views, the session gate,
rate limits, SQL, blobs, units and payouts), the sandbox and the worker's trust in Core, the hosted
runtime's spend caps, souls and GitHub token handling, the web pages, wallet and embed kit, the market
indexer, and the site deploy kit (gate, Caddy, systemd).

Method: four read-only reviews (Core leaks and economics; sandbox, worker, runtime and GitHub; web,
wallet, embed and indexer; deploy kit and gate), every finding checked against the code, then a
failing test, the fix, the test green. Red runs: the Core tests were run against the unfixed sources
(the fix reverse-applied) and failed; the sandbox, worker, runtime, souls and mirror tests against a
`git archive HEAD` copy; the indexer, embed, chain and gate tests against the unfixed files (gate:
D1 to D8 red with stubs reproducing the old behaviour, D9 written afterwards).

Fuzzing: `scripts/audit/fuzz-core.ts` sends every Core route hostile path parameters (malformed
percent-encoding, traversal, 3000-character ids), hostile query values (NaN, -1, 1e309, SQL fragments,
`__proto__`) and type-confused bodies, unsigned, agent-signed and admin-signed, with GitHub and proof
fetches stubbed. Before the fixes 42 of 762 requests answered 500; after them 0 of 1524. No route
builds SQL from request input (every value is bound; the two `${where}` joins are constants).

After all fixes: `bun test packages` 567/567, `bunx tsc --noEmit -p .` clean, `bun scripts/e2e.ts` 83/83
(two e2e checks rewritten for OFF-02 and OFF-09), `bun test apps/web/test` 2/2.

Fix commits: Core `ef823c7`; web, wallet, embed, indexer `77b8144`; deploy kit and gate `fda0c0e`;
sandbox, worker, runtime, souls, mirror `b7b4e0f`. Test files: `packages/*/test/audit-a2.test.ts`,
`scripts/deploy/gate.test.ts` (OFF-D tests), `packages/indexer/test/{decode,ingest}.test.ts` and
`packages/embed/test/embed.test.ts` ("audit" describes), `packages/chain/test/browser.test.ts`
("audit: co-sign guards"), `apps/web/test/trade-decimals.test.ts` (run with `bun test apps/web/test`;
`bun test packages` does not pick it up), plus assertions added to existing Core suites as named below.

### Findings

| Id | Severity | Status | Where |
|---|---|---|---|
| OFF-01 | High | Fixed | Core `hosted.ts` `submit` (provenance) |
| OFF-02 | High | Fixed | Core `messages.ts` replay firewall, `msgchain.ts` |
| OFF-03 | High | Fixed | Core `core.ts` `revealReplay`, `finalizeCanary` |
| OFF-I1 | High | Fixed | indexer `decode.ts` `programData` |
| OFF-S1 | High | Fixed | sandbox `evaluate.ts` `prepare_outputs`, `recipe.ts`, Core `recipe-proposals.ts` |
| OFF-S2 | High | Fixed | sandbox `evaluate.ts` `readRegularFile`, worker `discovery.ts` |
| OFF-K1 | High (malicious Core) | Fixed | worker `recipe-proposer.ts` `materializeProposal` |
| OFF-R1 | High (malicious Core) | Fixed | runtime `backend.ts`, `state.ts`, `runtime.ts` |
| OFF-D10 | High (as filed) | Fixed (M4, 2026-10-10) | systemd units, `provision.sh`, `remote.sh` |
| OFF-04 | Medium | Partly fixed, rest accepted | Core `core.ts` candidate view |
| OFF-05 | Medium | Fixed | Core `series.ts` `route` |
| OFF-06 | Medium | Partly fixed, rest accepted | Core `sessions.ts` |
| OFF-07 | Medium | Fixed | Core `hardening.ts` `retireExposedShadows` |
| OFF-09 | Medium | Fixed | Core `split.ts` `onCommit`, `onFinal` |
| OFF-10 | Medium | Fixed | Core `split.ts` `onCounted` |
| OFF-11 | Medium | Fixed | Core `http.ts` query and path parsing |
| OFF-16 | Medium | Fixed | Core `http.ts` (lazy module tables) |
| OFF-S3 | Medium | Fixed | sandbox `parsers.ts` `parseJunit` |
| OFF-S4 | Medium | Fixed | sandbox `evaluate.ts` `dirDigest` |
| OFF-S5 | Medium | Fixed | sandbox `repo.ts` overlay copy |
| OFF-K3 | Medium | Fixed | worker `proposers/anthropic.ts` |
| OFF-K4 | Medium | Fixed | worker `proposers/anthropic.ts` `addUsage` |
| OFF-R3 | Medium | Fixed | runtime `state.ts`, `runtime.ts` caps |
| OFF-R4 | Medium | Fixed | runtime `state.ts` lock |
| OFF-E1 | Medium | Fixed | embed `client.ts` `resolveBases`, `demo/demo.html` |
| OFF-E2 | Medium | Fixed | embed `render.ts`, `terminal.ts` |
| OFF-C1 | Medium | Fixed | chain `cosign.ts` `inspectForCosign` |
| OFF-C2 | Medium | Fixed | chain `cosign.ts`, runtime and worker `cosign` |
| OFF-W1 | Medium | Fixed | web `wallet/trade.ts` |
| OFF-D1 | Medium | Fixed | `scripts/deploy/gate.ts` stream cap |
| OFF-D2 | Medium | Fixed | `gate.ts` client key |
| OFF-D3 | Medium | Fixed | `gate.ts` `Limiter` |
| OFF-D5 | Medium | Fixed | `gate.ts` body read |
| OFF-D8 | Medium | Fixed | `Caddyfile.tmpl` `/market` |
| OFF-D9 | Medium | Fixed | `Caddyfile.tmpl`, `apps/web/server.ts` (CSP) |
| OFF-W3 | Medium | Accepted | web trade box slippage and devnet check (one RPC) |
| OFF-D4 | Medium-low | Fixed | `gate.ts` `classify` |
| OFF-08 | Low | Accepted | Core `sessions.ts` sequence numbers |
| OFF-12 | Low | Fixed | Core `http.ts` 500 body |
| OFF-13 | Low | Fixed | Core `findings.ts` |
| OFF-14 | Low | Fixed | Core `core.ts` `usage` |
| OFF-15 | Low | Fixed | Core `upstream.ts` `githubFullName` |
| OFF-17 | Low | Accepted | Core `upstream.ts` unauthenticated checks |
| OFF-18 | Low | Accepted | Core public full scans |
| OFF-19 | Low | Accepted | Core `links.ts` domain proofs |
| OFF-S6 | Low-medium | Partly fixed | sandbox `repo.ts`, `evaluate.ts` permissions |
| OFF-S7 | Low | Fixed | sandbox `evaluate.ts` `changedProtectedBlocks` |
| OFF-K2 | Low | Fixed | worker `main.ts` keygen, `worker.ts` pending state |
| OFF-K5 | Low | Fixed | worker `split.ts` |
| OFF-R5 | Low | Fixed | runtime `state.ts` `redact`, `main.ts` |
| OFF-G1 | Low | Fixed | souls `github/api.ts`, mirror `git.ts` |
| OFF-G2 | Low-medium | Fixed | souls `github/commit.ts` `signedCommit` |
| OFF-G3 | Low (malicious Core) | Fixed | mirror `chain.ts`, `prbot.ts` |
| OFF-I2 | Low-medium | Fixed | indexer `decode.ts` trades |
| OFF-I3 | Low | Fixed | indexer `indexer.ts`, `main.ts` |
| OFF-I4 | Low | Accepted | indexer source spam |
| OFF-W2 | Low | Fixed | web `pages/token.ts` |
| OFF-W4 | Low | Accepted | web `wallet/faucet.ts` hourly cap race |
| OFF-D6 | Low | Fixed | `gate.ts` same-origin routes |
| OFF-D7 | Low | Fixed | `gate.ts` forwarded headers |
| OFF-D11 | Low | Fixed | `deploy.sh`, `remote.sh`, `DEPLOY-SITE.md` |
| OFF-D12 | Low | Fixed (M4, 2026-10-10) | Caddy admin API |
| OFF-S8 | Medium | Accepted | sandbox: every worker runs `prepare` with network |
| OFF-S9 | Low | Accepted | sandbox: valgrind summary race, junit counts, equivalence truncation, container uid |

### Core

**OFF-01 (High): POST provenance answered "is X the author of this open candidate?" for anyone.**
`hosted.ts` compared `record.agent` with the author (400) before checking the caller (403), so any
signer (no registration needed) could probe every agent id against an open candidate, and find a
canary's shadow author. Fix: only the author or the runtime authority gets past the first check.
Test: `core/test/audit-a2.test.ts` OFF-01.

**OFF-02 (High): the replay firewall named the author to the replayer.** A replayer's message to a
party of its candidate was refused `403 replaying` before rate caps, so a replayer could DM every
launched agent and learn the author (and that a shadow author means a canary). Fix: such messages are
accepted with the same answer as any other and held until the work is over, in both directions; refs
to the candidate are still refused (that names only the sender's own work). SPEC 12.3 and 15 updated.
Tests: `messages.test.ts` "replay firewall", `msgchain.test.ts` "preflight".

**OFF-03 (High): a canary was judged at each reveal.** The first reveal of a canary published
`units.awarded` or a canary slash at once, while a real candidate pays only when its group settles.
A replayer that committed "accept" saw it, skipped its own reveal and took the smaller unrevealed
penalty instead of the canary slash. Fix: canary replays are judged when the group settles
(`finalizeCanary`). Test: OFF-03.

**OFF-04 (Medium, partly fixed): a final canary is recognisable before its epoch closes.** Fixed: a
passing canary replay's public role reads `counted` until the canary is listed (test OFF-07,
`canary-audit.test.ts`). Accepted: a canary the replayers accepted ends `rejected` with reason
`canary` and an accepted verdict, which no real candidate can show, and its slash is public. Rationale:
this exists only after every commit and (with OFF-03) every reveal of that canary, so it cannot change
any replay of it; the shadow retires (SPEC 10.5 residue).

**OFF-05 (Medium): a released stacked candidate's public `detail` named its dependency's generation**
(and so that generation's author) while open, and read differently from a canary's release. Fix: one
wording for every release; the outcome stays in the series record, public once both ends are final.
Test: `series.test.ts` first test.

**OFF-06 (Medium, partly fixed): sessions and author-blindness.** Fixed: any intent ever filed on the
lineage (withdrawn, stale, expired) named the agent of a later sealed session; now only an open or
committed intent does (test OFF-06). Accepted: a live session names its agent and turns `sealed` at
the commit, and shadows record no sessions, so sealed sessions time a commit to an agent seen live and
open candidates minus sealed sessions bounds the canaries on a lineage. Rationale: SPEC 17.3 accepts the
live naming as no worse than activity; the counting signal needs shadow sessions (parity) to close and
is noisy while self-hosted authors record no sessions. Recommended before mainnet.

**OFF-07 (Medium): shadows outlived their listing.** A shadow whose canary was listed at its epoch's
close kept authoring; its public intents then announced its next canary. Fix: retired once any of its
canaries is final in a closed epoch. Test: OFF-07.

**OFF-08 (Low, accepted): private session events leave gaps in `seq`.** Subsumed by OFF-06: the
same moment is already public as the `sealed` flip.

**OFF-09 (Medium): the split fee was debited at commit** from each author member's compute vault,
and balances are public, so the drop at `candidate.committed` named an open candidate's team. Fix:
balances are checked at commit and the fee is debited when the candidate is final (capped by the
vault then; nothing if never replayed). Test: `split-ports.test.ts` measured split tests.

**OFF-10 (Medium): made-up split reports were paid.** Any well-formed report matching its commitment
earned the extra trees' units and rebate. Fix: the extra pay goes only to counted replays whose
reports agree on every coalition (the measured split's own check); one dissenting report voids it for
all, so lying gains nothing. Test: `split-ports.test.ts` "disagreeing coalition reports".

**OFF-11 (Medium): query and path parsing.** `limit=-1` became SQLite's "no limit" (a whole
candidate list built view by view, the whole event log: the case that OOM-killed the gate), NaN
reached `LIMIT NULL` (500), and malformed percent-encoding threw (500). Fix: numeric query values must
be non-negative integers (400 otherwise), event log limit clamped to 1..5000, a bad path is 400. Test:
OFF-11 and the fuzzer.

**OFF-12 (Low): a 500 echoed the exception text** (SQL and paths). Fix: generic message; the text
stays in Core's log. Test: OFF-12.

**OFF-13 (Low): `hotspot.replay_assigned` named the replayer** before the claim was decided (12.8).
Fix: removed from the event. Test: OFF-13 (asserts on the emitting line).

**OFF-14 (Low): usage records took NaN, negative or fractional token counts and silently truncated
refs** (two long refs could collide). Runtime or admin key only. Fix: validated, 400. Test: OFF-14.

**OFF-15 (Low): `https://github.com/../user` passed `githubFullName`,** walking Core's token-bearing
GitHub calls to other API paths. Fix: dot-only names refused. Test: OFF-15.

**OFF-16 (Medium): a module's tables could be rolled back.** Modules built lazily inside a request's
transaction created their tables there; on a fresh Core the first request (GET of an unknown session)
failed, rolled the `CREATE TABLE` back, and the cached module answered 500 for sessions until a
restart. Found by the fuzzer. Fix: every module is built when the routes are, outside any
transaction. Test: OFF-16.

**OFF-17 (Low, accepted): `POST /v1/upstream/check` and `/optin` are unauthenticated** and spend
Core's GitHub quota per distinct repository. The site gate refuses every POST to `/v1`, so only local
callers reach them; Core keeps a per-repository minute cap.

**OFF-18 (Low, accepted): public full scans** (`/v1/ledger/reconcile`, `/v1/agents`). Bounded by the
database size and the gate's per-client limits; needed by `scripts/verify.ts` and replicas.

**OFF-19 (Low, accepted, speculative): domain link proofs resolve then fetch** (a DNS rebinding
window to a private address). Redirects are refused and only the proof text is read; the window gives
a GET to an internal address with no response shown beyond pass or fail.

### Sandbox, worker, runtime, souls and mirror

**OFF-S1 (High): `prepare_outputs` followed symlinks.** A proposal repo shipping
`out -> ../../../../.config/lineage` made every calibrating verifier copy its model key or agent keys
into the deps layer, where the code under test could print them as test ids. Fix: `fsafe.ts`
`copyConfined` refuses a symlink anywhere on either path and anything not a regular file or directory;
recipes and proposals must give clean relative paths. Tests: sandbox OFF-S1 (two).

**OFF-S2 (High): a FIFO froze the worker.** A FIFO planted where a result file is read blocked the
synchronous open forever (reveal timers included, so every replayer took unrevealed strikes). Fix:
O_NOFOLLOW plus O_NONBLOCK, then fstat. Test: OFF-S2 (subprocess with a timeout).

**OFF-S3 (Medium): quadratic junit regex** (40k unclosed testcases: 12.8 s, the cap allows far more).
Fix: a linear scan with identical results. Test: OFF-S3.

**OFF-S4 (Medium): artifacts hashed by reading whole files** (2.2 GB file: 1.6 GB peak RSS). Fix:
streamed hashing, peak 40 MB. Test: OFF-S4.

**OFF-S5 (Medium): the recipe overlay copy wrote through repository symlinks.** Fix: per-file
confined copy. Test: OFF-S5.

**OFF-S6 (Low-medium, partly fixed): world-writable work trees and deps layer.** Fixed: `chmod a+rwX`
only where containers really run as uid 10001 (macOS, a root worker). Accepted: the deps layer's
`.lineage-digest` cache is not re-verified; on Linux the layer is no longer writable by others, on
macOS it is a single-user machine. Test: OFF-S6.

**OFF-S7 (Low): protected-block checks read through a candidate's directory symlink** (a yes/no
signal about a host file). Fix: confined reads. Test: OFF-S7.

**OFF-S8 (Medium, accepted): every worker runs a proposal's `prepare` with network,** where SPEC 15
has the reference runner prepare once. Rationale: the resulting deps digest must equal the snapshot's,
so a divergent prepare is caught; the reachable surface is the host's bridge network. Operators must
run workers on hosts with no cloud metadata endpoint and no services on the docker bridge, or under
gVisor (M3). Listed for the external audit.

**OFF-S9 (Low, accepted): known SPEC 15 residuals confirmed.** A forked child can race a forged
valgrind summary line in before the kill (covered by equivalence on holdout seeds, canaries, audits;
separate-uid helper on M3); junit has no count or plan check (in-process runners, same coverage);
equivalence output truncated at 4 MB hashes equal (harness is recipe-owned and protected; a recipe
review rule); on Linux containers run as the worker's uid, not 10001 (build outputs must stay owned
by the worker; cap-drop, no-new-privileges and the read-only root still apply).

**OFF-K1 (High, malicious Core): `materializeProposal` deleted and wrote outside its root** from a
Core-supplied recipe name or id. Fix: both validated before any path use. Test: worker OFF-K1.

**OFF-K2 (Low): key and pending-state files.** keygen wrote then chmodded (a 0644 window, and a
check-then-write race); `pending.json` (salts, unrevealed results) had the default mode. Fix:
`secret-file.ts` (O_EXCL 0600, atomic 0600). Tests: OFF-K2 (two).

**OFF-K3 (Medium): a model turn that failed to parse was billed but never metered,** bypassing every
spend cap. Fix: meters the stream's partial usage, else a worst case. Test: worker "a turn whose tool
JSON fails to parse is still metered".

**OFF-K4 (Medium): NaN or negative usage turned the spend into NaN,** and no cap stopped the attempt.
Fix: sanitized; a bad block is charged the rest of the cap. Test: worker "a usage block with missing
or negative counts".

**OFF-K5 (Low): Core's `split.n` drove 2^n local evaluations.** Fix: local cap of 5 and a subs count
check. Test: OFF-K5.

**OFF-R1 (High, malicious Core or chain): discovered agent ids were used as file paths**
(`../../.config/solana/id` read and then overwrote the machine's keypair). Fix: ids must be base58
32-byte keys; bad ones are skipped. Tests: runtime OFF-R1 (two).

**OFF-R3 (Medium): a NaN spend total was saved as null and reset the global cap** after a restart.
Fix: a non-finite or negative record means nothing is left. Test: runtime "a NaN spend record".

**OFF-R4 (Medium): stale-lock takeover race** (6 concurrent starts produced two runtimes, whose saves
overwrite each other's spend). Fix: O_EXCL takeover file and a re-read. Tests: OFF-R4 (two, one a
6-process race).

**OFF-R5 (Low): redaction gaps** (backend and messenger logs, the top-level error, keys in RPC URL
paths, GitHub tokens, Authorization values, `cfg.rpc_url`). Fix: all log lines through `redact`,
patterns extended. Test: OFF-R5.

**OFF-G1 (Low): base64 basic-auth values escaped `redactTokens`,** and an inherited `GIT_TRACE` or
`GIT_CURL_VERBOSE` could print them. Fix: redaction extended, git runs with tracing off. Tests: souls
and mirror OFF-G1.

**OFF-G2 (Low-medium): `signedCommit` force-pushed into an existing same-name repository that is not
a fork, and took any file path** (a `.git/config` entry could run code with the token in env). Fix:
requires a fork of the expected parent; `safeCommitPath`. Tests: OFF-G2 (two).

**OFF-G3 (Low, malicious Core): Core-supplied `commit_sha` and `default_branch` reached git argv.**
Fix: 40-hex sha, safe ref names. Tests: OFF-G3 (two).

### Web, wallet, embed and indexer

**OFF-I1 (High): the indexer accepted lineage_launch events logged by any program.** A program
logging `FeesCranked`, `Graduated` or `AgentLaunched` data naming a victim mint (in a transaction that
mentions the mint) added fake fee cranks and launch or graduation events. Fix: data lines count only
inside `lineage_launch`'s own invoke frame. Tests: `decode.test.ts` "audit: forged events" (two).

**OFF-I2 (Low-medium): trade amounts came from vault deltas,** so a donation to the quote vault in
the same transaction inflated amount, price and volume. Fix: Meteora's swap event first. Test:
`decode.test.ts` "tokens donated into the quote vault".

**OFF-I3 (Low): one undecodable transaction wedged its source; a bad WebSocket frame could throw.**
Fix: per-transaction failures logged to `sources.last_error`, the cursor moves on; frames parsed in a
try. Test: `ingest.test.ts` "a malformed transaction does not wedge its source".

**OFF-I4 (Low, accepted): source spam.** Any transaction mentioning a mint is fetched; on devnet this
is free to produce. Bounded by the RPC and the per-cycle work; revisit with a mainnet RPC budget.

**OFF-E1 (Medium): embed bases accepted any string, and the demo's `?api=` swapped the data source on
the site's own origin** (`javascript:` links, foreign data under the site's name). Fix: http(s)
overrides only, `?api=` same origin only (and the site CSP blocks the demo's inline script, OFF-D9).
Test: `embed.test.ts` "resolveBases ignores javascript:".

**OFF-E2 (Medium): `repo_url` became an href without a scheme check in the embed kit.** Fix:
`extLink` renders non-http(s) URLs as text. Test: `embed.test.ts` "a repository URL that is not
http(s)".

**OFF-W2 (Low): the same on the token page.** Fix: `repoLink`. Checked by tsc (no page harness);
the chain already requires `https://` for `repo_url`, so only a lying indexer could exploit it.

**OFF-C1 (Medium): co-sign let the co-signing key be the fee payer, with any compute budget,** so an
owner could spend the runtime's or worker's SOL. Fix: refuse when the key is the fee payer or a
writable signer; compute limit at most 1,400,000, price at most 1,000,000 micro-lamports, no other
ComputeBudget instruction. Tests: `browser.test.ts` "audit: co-sign guards" (two).

**OFF-C2 (Medium): a rotation co-signed "for agent A" could rotate agent B's record.** Fix:
`expectAgent` checks the agent record PDA; the runtime passes it, the worker with `--agent`. Test:
"a rotation co-signed for agent A refuses a transaction that rotates agent B".

**OFF-W1 (Medium): the trade box took token decimals from the indexer,** so a lying indexer turned
"1" into 1000 tokens with a matching review screen. Fix: decimals from the mint account read with
the venue. Test: `apps/web/test/trade-decimals.test.ts`.

**OFF-W3 (Medium, accepted): the slippage floor and the devnet check rest on the site's one RPC.**
A lying upstream RPC could lower `minOut` or fake the genesis hash. Rationale: devnet tokens, and the
RPC is the operator's keyed endpoint; before mainnet, cross-check the simulated output against a quote
from the pool's onchain price read separately.

**OFF-W4 (Low, accepted): the faucet's hourly cap counts finished drips,** so concurrent requests
can pass it together. Devnet tLINE only; the gate now limits the faucet to 3 per hour per client (/64
for IPv6) and requires a listed Origin.

Checked without a finding: the `html` template escapes every interpolation and no `raw()` takes agent
or chain data; the live panel escapes all session, file and run text; program ids are compiled in and
trade venues, pools and configs are derived from PDAs; claims and bounty proofs are recomputed
locally against onchain roots; `signAndSend` refuses a message the wallet altered; Meteora events
count only from the pool program; no `postMessage` handlers; static serving uses fixed paths. The
docs and manual markdown renderers allow protocol-relative links and raw HTML: safe only because their
sources are bundled repository files.

### Deploy kit and gate

**OFF-D1 (Medium): the stream cap could be raced** (parallel opens passed the check before any was
counted; about 60 streams per IP against a cap of 4). Fix: `StreamSlots` reserves before the upstream
fetch. Test: `gate.test.ts` OFF-D1.

**OFF-D2 (Medium): rotating IPv6 addresses got fresh buckets.** Fix: `clientKey` keys IPv6 by /64,
IPv4-mapped by IPv4. Test: OFF-D2.

**OFF-D3 (Medium): the bucket table grew without bound.** Fix: LRU above 50,000 keys. Test: OFF-D3.

**OFF-D4 (Medium-low): `/api/admin/*` reached Core's admin routes** through the dashboard proxy (safe
only because the proxy sends no signature). Fix: refused, along with encoded slashes, `//` and
backslashes. `POST /souls/*` stays refused (drafts spend the model key; owner decision). Test: OFF-D4.

**OFF-D5 (Medium): bodies were buffered whole before the 64 KB check, with no deadline.** Fix:
`readCapped` (413 past the cap, 408 after 10 s). Test: OFF-D5.

**OFF-D6 (Low): same-origin routes passed requests with no Origin.** Fix: `/chain/rpc` and
`/chain/faucet` need a listed Origin. Test: OFF-D6.

**OFF-D7 (Low): client `Forwarded`, `X-Real-IP`, `Cookie`, `Authorization` reached upstreams.** Fix:
stripped, one X-Forwarded-For; upstream `set-cookie` dropped; `/gate/health` no longer shows counts.
Test: OFF-D7.

**OFF-D8 (Medium): `/market/*` bypassed the gate.** Fix: a `market` class and an `--indexer` upstream;
Caddy sends everything to the gate. Test: OFF-D8.

**OFF-D9 (Medium): no CSP on the origin that builds wallet transactions.** Fix: `script-src 'self'`
plus the hash of the one inline theme script, `object-src 'none'`, `base-uri 'none'`,
`frame-ancestors 'none'`, Permissions-Policy and COOP, from Caddy and from `apps/web/server.ts`. The
Vercel front gets the other headers but no CSP (its export uses inline scripts). Test: OFF-D9 (checks
both against the actual hash).

**OFF-D10 (High as filed, partly fixed): one user runs every service and is in the docker group.**
Fixed: gate, web and indexer units gain PrivateDevices, ProtectKernel*, ProtectControlGroups,
RestrictNamespaces, RestrictSUIDSGID, LockPersonality, an empty CapabilityBoundingSet,
RestrictAddressFamilies and `SystemCallFilter=@system-service`; the gate also ProtectHome. Accepted:
splitting users (a web user that reads only the faucet key and RPC env, DynamicUser for gate and
indexer, docker group for workers only) changes provisioning and key paths and can only be tested on
the server; this is a devnet site without real funds. Required before mainnet.
**Fixed in M4 (2026-10-10):** Core, the gate, the dashboard, the indexer, the monitor and backups run as their
own system users (no shell, no home, no docker); only `lineage` (sandboxes, verifiers, runtime) is in the
docker group; the Core authority key and the faucet key moved to their users (docs/DEPLOY-SITE.md "Service
users"). Residual on the one-box devnet site: `lineage` is root-equivalent through Docker and owns the
release directory, so the split protects the services from each other and from Docker, not from `lineage`;
the recommended mainnet layout (same doc) separates the boxes.

**OFF-D11 (Low): site.env was world-readable; `wipe-keys` left the keyed RPC URL in network.json;
the docs said the gate had 256 MB.** Fixed (umask 077 and 600, scrub, docs).

**OFF-D12 (Low, accepted): Caddy's admin API on localhost:2019** lets any local process rewrite the
proxy config. The packaged unit reloads through it; moving it to a 0600 unix socket needs a reload
path tested on the server. **Fixed in M4 (2026-10-10):** the admin API is a 0600 unix socket owned by
caddy, and the unit's reload talks to whichever address the running Caddy is on (tested on the site in
both directions and over two consecutive deploys).

### What the site needs

The identity service lane deployed the site at `b7b4e0f`, which carries every A2 fix commit. Read-only
probes afterwards (2026-10-09, about 21:05 UTC): `/v1/health` 200; `/v1/candidates?limit=-1` 400
(OFF-11); `/api/admin/ledger` 404 from the gate (OFF-D4); a malformed percent-encoded path is refused
before Core (HTTP/2 stream error, no 500); `/market/status` answers through the gate (OFF-D8); `/`
carries the CSP, Permissions-Policy and COOP (OFF-D9). Still to check on the server:

- `systemd-analyze security` for lineage-gate, lineage-web and lineage-indexer, and `journalctl` for
  `226/NAMESPACE`, `SIGSYS` or `EPERM` after a restart (the new hardening was not tried in the local
  dry run); drop `SystemCallFilter`, then `PrivateDevices`, on a failing unit.
- With the browser console open, the CSP on `/`, `/wallet`, `/tokens/:mint`, `/docs` and a session
  page (wallet extensions, fonts, the dynamic wallet bundle import), and a POST to `/chain/rpc` from
  the Wallet page. A Vercel front calling `/chain/*` needs its origin in the gate's `--origin` list.
- No data migration: OFF-09 changes when the split fee moves, and measured splits are refused in chain
  mode, which the site runs (a simulated-mode Core holding an open split candidate committed before
  this release would charge its fee a second time at the end).
- Before mainnet: OFF-D10 and OFF-D12 fixed in M4 (2026-10-10); still open: OFF-06 (shadow sessions),
  OFF-W3 (second price source for slippage).

### For an external auditor

- Author-blindness as a whole (SPEC 10.7): it is a property of every public byte, and this audit
  found five independent oracles. OFF-06's residual (sessions without shadow parity) and OFF-04's
  (a canary the replayers accepted is recognisable once final) are open by design; any new public
  field or event can reopen it. `hardening.test.ts` "author-blind replay" sweeps routes, not timing.
- Economic incentives around canaries after OFF-03: whether any other signal tells a replayer,
  between its commit and its reveal, that the candidate is a canary.
- The sandbox against a determined candidate: the measurement forging residuals (OFF-S9), `prepare`
  with network on every worker (OFF-S8), and the container running as the worker's uid on Linux.
- The worker, runtime and mirror against a compromised Core: this audit fixed the path and argv
  cases found; every other Core-supplied value should be treated as hostile too.
- The site host: one user with docker access runs every internet-facing service (OFF-D10), Caddy's
  admin API (OFF-D12), and the identity service route `/identity/*`, which bypasses the gate and
  receives pasted GitHub tokens (lane B, not reviewed here).
- The wallet's trust in the site RPC (OFF-W3) and the co-sign flows (OFF-C1, OFF-C2).
