# Threat model

Source: docs/SPEC.md section 15 (draft v0.25, 2026-10-09), every row carried over, plus the onchain
rules of SPEC 14.5 and the attack classes the internal audit checked (docs/AUDIT.md). The "Enforced by"
column says where the mitigation lives, so an auditor can see which rows the programs carry and which
rest on offchain components.

## Actors and assets

**Assets.** `$LINE` in the registry vaults (bonds, treasury, reserve, pool, payable, challenge bonds),
in compute vaults and bounty escrows (`lineage_launch`), the agent tokens' creator fees on pump.fun
(the creator PDA `["pump_creator", agent]` of each agent and its `$LINE` ATA), the integrity of verdicts and epoch roots, the
author-blindness of open candidates, and the keys listed in `POWERS.md`.

**Adversaries considered.** Any wallet (permissionless instructions, donations, account substitution);
a registered agent (challenges, messages, bounties); a verifier operator with some fraction of bond;
an author trying to get a bad patch accepted; colluding authors and replayers; a launcher selling its
agent; a compromised hot key (Core authority, runtime authority); a compromised admin key; a
malicious or lying RPC or indexer; code under test inside the sandbox; a compromised Core as seen by
workers and runtimes. Out of scope: a compromised Solana validator majority, a compromised pump.fun
program (its interface and its admin powers are in scope as trust assumptions, its correctness is not), and the upgrade authority itself (which is
total control by design until it moves to a multisig with a timelock).

## Onchain threats (the programs carry these)

| Attack | Mitigation | Enforced by | Tests |
|---|---|---|---|
| Account substitution or type cosplay | typed Anchor accounts, PDAs with stored bumps, `seeds::program` for cross-program reads, owner, PDA, discriminator and minimum-length checks on pump.fun accounts (`pump.rs`) | all three programs | docs/AUDIT.md "Checklist results without a finding"; `forged_record_roots_are_refused` |
| Front-running `initialize` after deploy | only the upgrade authority, read through ProgramData | registry, launch, msg | `registry_initialize_only_by_upgrade_authority`, `launch_initialize_only_by_upgrade_authority`, `msg_initialize_only_by_upgrade_authority` (`tests/tests/init_auth.rs`, added 2026-10-10): another signer is refused with the real ProgramData (`Unauthorized`) and with a ProgramData that names it at the wrong address (`ConstraintSeeds`), nothing is created, then the upgrade authority initializes and a second initialize by anyone fails (`already in use`) with the config unchanged |
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
| Graduation bound to a forged dust position (Meteora venue) | removed with the Meteora venue (2026-10-10): there is no position to bind; `record_pump_graduation` reads the canonical PumpSwap pool | launch | `graduation_and_pool_fees` (a wrong pool address refused, recorded once) |
| Fees stranded at migration | pump.fun keeps the curve's creator fee sweepable after migration; one crank sweeps curve and pool | launch + keeper | `graduation_and_pool_fees` (curve leftover + pool fees split exactly) |
| A spoofed curve registered as an agent's launch (another creator, another quote, a SOL quote, holder rewards, another fee rate, a traded curve, a curve created in an earlier transaction, another mint's curve, a look-alike account) | the instructions sysvar must show an earlier top-level Pump `create_v2` for the same mint and curve; the curve is read with owner, PDA, discriminator and length checks and must be fresh, depth 1, quoted in `$LINE`, with the agent's creator PDA and the configured fee rate; the agent key co-signs | launch | `register_refuses_spoofed_curves`, `configured_creator_fee_rate_is_enforced` |
| `$LINE` sent straight to a creator PDA's ATA | treated as fees and split like them (a donation; it cannot raise anyone's share) | launch | `trades_and_an_exact_fee_split` |
| Crank with another agent's creator ATA, compute vault or a non-treasury destination | creator PDA by seeds and `has_one`, ATA by `associated_token` constraints, compute vault by seeds, treasury by address | launch | `crank_refuses_foreign_accounts` |
| The creator PDA's ATA closed, frozen or delegated | only its owner (the creator PDA) can close or delegate, and the program never does; `$LINE` has no freeze authority (allowlist) | launch, mint rules | by construction; pump.fun's collect needs the ATA, the keeper recreates it idempotently |
| A Meteora-era record (devnet) driven through the pump.fun paths | `crank_pump_fees` and `record_pump_graduation` require `venue` = Pump; layouts kept so its compute paths still work | launch | `meteora_era_records_stay_readable` |
| A hostile `$LINE` mint (transfer hooks, fees, permanent delegate, default freeze) | mint extension allowlist at initialize | registry, launch | `line_mint_extension_allowlist` |
| A DBC config that routes fees or LP elsewhere (Meteora venue) | removed with the Meteora venue (2026-10-10) | | |
| A message that cannot fit one transaction | length caps measured to exactly 1,232 bytes | msg | `longest_message_fits_one_transaction` (launch strings are a client cap now: `MAX_LAUNCH_STRINGS` 327, measured by `packages/chain` tests; a launch too long simply cannot be sent) |
| Forged onchain message events (SPEC 15) | events only from `lineage_msg`'s self-CPI signed by its event authority PDA; the signer must be the agent's current registry signing key | msg + indexers that read only that frame | `events_cannot_be_forged_from_outside`, `signer_must_be_the_current_registry_signing_key` |
| Onchain message spam (SPEC 15) | per-agent window and day caps, size caps, a fee per message, admin pause | msg | `rate_limits_pause_and_config` |
| Bounty released by a stale, foreign or forged proof | registry `Epoch` PDA owner and address checked; `min_epoch`; deadline; condition; payee credited; receipt per payer and leaf | launch | `bounty.rs` suite |
| Arithmetic overflow and rounding | `overflow-checks = true`; `u128` intermediates and floor for bps; remainders to the protocol or pool side | all | `trades_and_an_exact_fee_split`, `split_is_exact` |

## pump.fun as a dependency (trust assumptions, 2026-10-10)

The launch program reads pump.fun's accounts and relies on pump.fun's own instructions for creation,
trading, fees and migration. pump.fun's admins can change these (sources: pump.fun IDLs and docs at
pump-public-docs `2293f9a`, pump.fun Terms of Use and Fees Page read 2026-10-10; docs/plans/PUMPFUN-LAUNCHES.md 4.2, 4.6).

| Event | Effect on Lineage | Detection or mitigation |
|---|---|---|
| `admin_cto` / `set_creator` (Pump) or `admin_cto_pool` (PumpSwap) reassigns a coin's creator | that coin's future creator fees stop reaching the agent's creator PDA; nothing already in the compute vault is affected | the indexer alerts when a curve's `creator` or a pool's `coin_creator` is not our PDA (`GET /market/alerts`); `PumpGraduated.creator_is_ours` |
| Fee config or creator fee rate changes (Fees Page; Terms 14.1: at least 14 days' notice for a fee increase) | compute funding per unit of volume changes | the indexer alerts on a fee config change from its baseline; `LaunchConfig.pump_creator_fee_bps` is admin-editable to follow a rate pump.fun allows |
| `Global.max_curve_depth` set to 0 | new launches quoted in `$LINE` fail at `create_v2`; existing coins trade on | the indexer alerts; no fallback venue (owner decision: pump.fun only) |
| A pump.fun program upgrade changes an account layout read here | `register_pump_launch` or `record_pump_graduation` refuses (minimum lengths, discriminators) or misreads if offsets move | layouts are append-only per pump.fun's docs; re-run `vendor/pump/fetch.sh`, the suite and the fork rehearsal before mainnet and after any pump.fun upgrade |
| `$LINE`'s curve completes and awaits migration | launches fail (`QuoteCurveAwaitingMigration`) until anyone runs `migrate_v2` | the wizard shows the state; anyone may migrate |
| `$LINE` is bound at initialize | the registry vaults and the launch config are tied to one mint; moving to another `$LINE` needs a new deployment | `$LINE` must be a pump.fun coin paired with SOL or USDC and never mayhem (runbook, checked by `initialize.ts`) |

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
| Recognising canaries | shadow pool launched ahead through the real launch and fee paths; later-tick injection; realistic reveal gaps; private single-use library | Core (the shadow launches use the real launch path, now `register_pump_launch`) |
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
| Wash trading an agent token to fund compute | only moves fees from the trader to the agent's compute and pump.fun; no volume reward | launch fee split (onchain), economics |
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
late resolution), A1-08 (fixed 2026-10-10: per agent, per epoch slash cap; the suspension epoch argument stays Core's), A1-09 (message
caps per agent, not global; `lineage_msg` ignores the registry pause), A1-10 (the graduation record ignores
the launch pause), A1-11 (no debit cap when `max_debit_per_epoch = 0`; devnet sink is the runtime's
own account), and offchain OFF-04, OFF-06, OFF-D10, OFF-D12, OFF-S6, OFF-S8, OFF-S9, OFF-W3, OFF-W4,
OFF-08, OFF-17, OFF-18, OFF-19, OFF-I4. The biggest single residual is key management: one hot key is
the upgrade authority and every admin on devnet (`POWERS.md`).
