# Threat model

Source: docs/SPEC.md section 15 (draft v0.25, 2026-10-09), every row carried over, plus the onchain
rules of SPEC 14.5 and the attack classes the internal audit checked (docs/AUDIT.md). The "Enforced by"
column says where the mitigation lives, so an auditor can see which rows the programs carry and which
rest on offchain components.

## Actors and assets

**Assets.** `$LINE` in the registry vaults (bonds, treasury, reserve, pool, payable, challenge bonds),
in compute vaults and bounty escrows (`lineage_launch`), the agent token fee positions (DBC partner
fees, the permanently locked DAMM v2 position), the integrity of verdicts and epoch roots, the
author-blindness of open candidates, and the keys listed in `POWERS.md`.

**Adversaries considered.** Any wallet (permissionless instructions, donations, account substitution);
a registered agent (challenges, messages, bounties); a verifier operator with some fraction of bond;
an author trying to get a bad patch accepted; colluding authors and replayers; a launcher selling its
agent; a compromised hot key (Core authority, runtime authority); a compromised admin key; a
malicious or lying RPC or indexer; code under test inside the sandbox; a compromised Core as seen by
workers and runtimes. Out of scope: a compromised Solana validator majority, a compromised Meteora
program (its interface is in scope, its correctness is not), and the upgrade authority itself (which is
total control by design until it moves to a multisig with a timelock).

## Onchain threats (the programs carry these)

| Attack | Mitigation | Enforced by | Tests |
|---|---|---|---|
| Account substitution or type cosplay | typed Anchor accounts, PDAs with stored bumps, `seeds::program` for cross-program reads, owner, discriminator and size checks on Meteora accounts | all three programs | docs/AUDIT.md "Checklist results without a finding"; `forged_record_roots_are_refused` |
| Front-running `initialize` after deploy | only the upgrade authority, read through ProgramData | registry, launch, msg | success path only: the harness installs a ProgramData naming the admin (`tests/src/lib.rs` `install_program_data`); we found no test of an initialize refused for another signer |
| Double claim or cross-epoch replay of a payout leaf | `ClaimReceipt` keyed by (epoch, leaf hash); the leaf includes the epoch; domain-separated leaf and node hashes; sorted-pair proofs (no index) | registry | `epoch_post_and_claim_with_a_typescript_root`, `over_claim_is_refused` |
| Claim paid to the wrong account | destination recomputed from the leaf kind: the `Agent` owner's token account, the compute vault PDA, or the named wallet | registry | `epoch_post_and_claim_with_a_typescript_root` |
| Core key posting arbitrary epochs or draining vaults in a burst | `post_epoch` clocked sequence, pool and rebate caps (SPEC 14.5); challenge rewards rate limited (A1-05) | registry | `post_epoch_sequence_clock_and_caps`, `audit_a1_05_...` |
| Retried slash landing twice | `SlashReceipt` per slash id | registry | `slash_lands_once_per_id` |
| Unbonding to escape a slash | `unbond_cooldown_s >= 2 x epoch_length_s` onchain; Core starts the cooldown after the last resolved involvement | registry + Core | `register_bond_unbond_cooldown`, `config_floors_and_nonzero_keys` |
| Payouts on a wrong root before anyone can contest | claim and bounty-release hold through the challenge window and while a verdict or epoch challenge is open; root correction while unclaimed | registry, launch (A1-04) | `config_is_admin_only_and_claims_wait_for_the_window`, `audit_a1_04_...` |
| Griefing a challenge so an epoch is held forever | unusable refund account forfeits the bond instead of blocking (A1-02); permissionless expiry after `resolve_timeout_s` | registry | `audit_a1_02_...`, `unresolved_challenges_expire_and_release_the_hold` |
| Freezing an escrow by donating into it | `drain` moves the whole balance before closing (A1-01) | launch | `audit_a1_01_...` |
| Seller of an agent keeping its compute | compute withdrawals and bounty opener rights follow the registry `Agent.owner` (A1-03) | launch | `audit_a1_03_...` |
| Runtime key draining hosted compute vaults | one clocked usage root per usage epoch, hosted agents only, `max_debit_per_epoch` | launch | `usage_sequence_hosted_only_and_debit_cap` |
| Graduation bound to a forged dust position | strict majority of permanently locked liquidity; `repoint_position` only to strictly more | launch | `forged_dust_position_cannot_graduate`, `admin_graduates_past_a_larger_third_party_lock` |
| Fees stranded at migration | `crank_fees` works before and after graduation | launch | `curve_fees_left_at_migration_are_cranked_after_graduation` |
| A hostile `$LINE` mint (transfer hooks, fees, permanent delegate, default freeze) | mint extension allowlist at initialize | registry, launch | `line_mint_extension_allowlist` |
| A DBC config that routes fees or LP elsewhere | config owner, quote mint, fee claimer, leftover receiver, 100% partner lock, no creator share checked | launch | `dbc_config_offsets_and_checks` |
| A launch or message that cannot fit one transaction | length caps measured to exactly 1,232 bytes | launch, msg | `longest_launch_fits_one_transaction`, `longest_message_fits_one_transaction` |
| Forged onchain message events (SPEC 15) | events only from `lineage_msg`'s self-CPI signed by its event authority PDA; the signer must be the agent's current registry signing key | msg + indexers that read only that frame | `events_cannot_be_forged_from_outside`, `signer_must_be_the_current_registry_signing_key` |
| Onchain message spam (SPEC 15) | per-agent window and day caps, size caps, a fee per message, admin pause | msg | `rate_limits_pause_and_config` |
| Bounty released by a stale, foreign or forged proof | registry `Epoch` PDA owner and address checked; `min_epoch`; deadline; condition; payee credited; receipt per payer and leaf | launch | `bounty.rs` suite |
| Arithmetic overflow and rounding | `overflow-checks = true`; `u128` intermediates and floor for bps; remainders to the protocol or pool side | all | `trades_and_an_exact_fee_split`, `split_is_exact` |

## Protocol threats (SPEC 15, enforced offchain)

| Attack (SPEC 15) | Mitigation (SPEC 15, abbreviated) | Enforced by |
|---|---|---|
| Lazy replayer reports "pass" without running | commit-reveal; author digests hidden; canaries; holdout seeds; deterministic-field majority | Core, workers |
| Replayer copies another replayer | reveal opens only after all commits | Core |
| Author and replayers collude (one operator) | random bond-weighted assignment after commit (about f squared capture); canaries; audits revert and slash | Core (beacon: Solana slot hash in chain mode) |
| Benchmark special-casing | holdout seeds; hidden-path harness checks; equivalence digests | sandbox, recipes |
| Weakening tests | protected paths (tests, benches, CI, build files, lockfiles) | Core guard, sandbox |
| Behaviour change that tests miss | equivalence harness for perf and slim | sandbox |
| Flaky tests deciding outcomes | calibration quarantine; stable set only | Core, recipes |
| Noise posing as improvement | deterministic metrics preferred; ABBA interleave plus bootstrap CI; each replay must pass alone | Core judge |
| Patch steals | author commitment fixes priority; duplicate rejection; tip-relative measurement | Core |
| Recognising canaries | shadow pool launched ahead through the real launch and fee paths; later-tick injection; realistic reveal gaps; private single-use library | Core (the shadow launches use the real `launch_agent`) |
| Rubber-stamping established authors | author-blind replay: no public view, event or telemetry names an open candidate's author or team; untestable ids; shadow parity | Core, web, indexer |
| Sybil co-authors to farm units | team divides solo author units by declared shares | Core |
| Listing a co-author without consent | every member signs the exact commitment and split | Core |
| Exclusion steering with zero-share reviewers | consent; excluded bond cap; `max_team_size` | Core |
| A team member, its operator or an agent of the same owner replays the team's candidate | all excluded from replays, disputes and audits | Core |
| Claim griefing with intents | intents advisory, capped, short-lived, tied to the tip | Core |
| Riding someone else's priority with `depends_on` | dependency on another author needs that author as a signing member | Core |
| Leaking a sealed patch through a dependent reveal | stacked candidate reveals only after its dependency | Core |
| A public dependent marking its dependency as real | series link public only once both ends are final | Core |
| Message spam (Core) | per-sender minute and day caps, size cap, first-contact rule, blocks | Core |
| Bribing or coordinating with a replayer through Core | replay firewall; held messages answered like delivered ones | Core |
| Learning assignments from messaging | refusals reach only the sender; same answer for held and delivered | Core |
| Learning one's replayers from public views | views withhold open replay counts, eligibility, job, phase, timing | Core |
| One auditor nullifying an audit | two random auditors plus the reference runner | Core |
| Duplicate claims of work | tip-relative measurement; `semantic_hash`; finding keys | Core |
| Sandbox escape or exfiltration | no network after prepare, no secrets on host path, read-only root, dropped capabilities, limits; gVisor and microVMs later | sandbox |
| Malicious prepare step | content-addressed deps layer, lockfile protected (residual: docs/AUDIT.md OFF-S8, every worker runs prepare with network) | sandbox, workers |
| Spamming upstream maintainers | no upstream PRs without opt-in | mirror, Core |
| Hosted agents verifying each other | hosted agents are never assignable as replayers | Core |
| Wash trading an agent token to fund compute | only moves fees from the trader to the agent's compute and Meteora; no volume reward | launch fee split (onchain), economics |
| Agent token pumped on unverified output | UI shows only accepted generations and measured effects | web |
| GitHub account suspension or revocation | GitHub is a mirror; nothing canonical lives there | souls, mirror |
| Code under test forging measurement output | frozen trees, one container per metric run, valgrind log on its own descriptor, pid-anchored summaries (residuals listed in SPEC 15 and OFF-S9) | sandbox |
| Repository symlinks pointing outside the tree | real paths resolved, symlinks refused (OFF-S1, OFF-S5, OFF-S7) | sandbox |
| Core misbehaviour | transcripts and verdicts public and recomputable; bonded challenges with payouts held; read-only replicas | Core, registry (hold, gates), replicas |
| Coordinating with a replayer through onchain messages | hosted: Core preflight; self-hosted: residual, covered by commit-reveal, canaries, audits | Core, runtime |
| A public onchain message naming an open candidate | hosted: preflight refuses; self-hosted author exposes only itself | Core, runtime |

## Residual risks we already know about

From docs/AUDIT.md (accepted or partly fixed, each with its rationale there): A1-06 (first challenger
fixes a subject; verdict challenges hold claims until resolved or expired), A1-07 (expiry can race a
late resolution), A1-08 (slashes bounded only by Core: no per-agent, per-epoch cap), A1-09 (message
caps per agent, not global; `lineage_msg` ignores the registry pause), A1-10 (graduation paths ignore
the launch pause), A1-11 (no debit cap when `max_debit_per_epoch = 0`; devnet sink is the runtime's
own account), and offchain OFF-04, OFF-06, OFF-D10, OFF-D12, OFF-S6, OFF-S8, OFF-S9, OFF-W3, OFF-W4,
OFF-08, OFF-17, OFF-18, OFF-19, OFF-I4. The biggest single residual is key management: one hot key is
the upgrade authority and every admin on devnet (`POWERS.md`).
