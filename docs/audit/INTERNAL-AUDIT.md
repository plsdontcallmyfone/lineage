# Internal audit results and their fixes

Everything here is from docs/AUDIT.md (internal audit lanes A1 onchain and A2 offchain, 2026-10-09) and
onchain/README.md (the earlier adversarial review of 2026-10-07). docs/AUDIT.md has the full exploit
scenario and rationale for each item; this file is the index an auditor can check against the code.
Every fixed item has a test that failed before the fix and passes after it (the "red then green" runs
are described in docs/AUDIT.md "Onchain" and "Offchain", "Method").

## Onchain, lane A1 (2026-10-09)

Fix commit for A1-01 to A1-05: `b855b4a`. Tests in `onchain/tests/tests/`. All five tests passed again
on 2026-10-10 (`BUILD-AND-TEST.md`). Devnet: both affected programs upgraded 2026-10-09; A1-01 and A1-03
reproved on devnet on 2026-10-09 and again on 2026-10-10 (`runs/DEVNET-2026-10-10.md`).

| Id | Severity | Status | Issue | Fix | Test |
|---|---|---|---|---|---|
| A1-01 | High | Fixed | `bounty.rs` `drain` moved exactly `bounty.amount` then closed the vault; a one-unit donation made every close fail (`NonNativeHasBalance`), freezing the escrow forever | `drain` moves the vault's whole balance, then closes it | `bounty.rs` `audit_a1_01_a_donation_cannot_freeze_an_escrow` |
| A1-02 | High | Fixed | `ResolveChallenge` / `ExpireChallenge` typed the refund token account; a challenger closing, freezing or memo-locking it blocked resolution and expiry, holding the epoch's claims forever | refund account address-checked only; `refund_usable` decides; if unusable the bond goes to the reserve, the challenge closes, `ChallengeRefundForfeited` is emitted; `expire_challenge` takes the reserve vault last | `challenge.rs` `audit_a1_02_a_closed_refund_account_cannot_hold_an_epoch_forever` |
| A1-03 | Medium | Fixed | `withdraw_compute` and bounty opener checks used `AgentLaunch.launcher`, fixed at launch, so the seller of an agent kept its compute vault | both use the registry `Agent.owner`; `WithdrawCompute`, `OpenBounty`, `CancelBounty` take the registry `Agent` last | `bounty.rs` `audit_a1_03_compute_follows_the_registry_owner` |
| A1-04 | Medium | Fixed | `release_bounty` ignored the challenge hold, so escrows paid on a root later corrected stayed paid | release runs the registry's `check_claim_hold` (`BountyHeld`); takes `ChallengeConfig` and the epoch's `ChallengeGate` last | `bounty.rs` `audit_a1_04_bounty_release_waits_for_the_challenge_hold` |
| A1-05 | Medium | Fixed | upheld challenge rewards had no rate limit; a leaked Core key plus a sybil agent could drain the reserve per transaction | rewards capped at `max_rebate_per_epoch` per `epoch_length_s` window (`reward_window`, `rewards_in_window` from reserved bytes) | `challenge.rs` `audit_a1_05_upheld_rewards_are_capped_per_epoch_length` |
| A1-06 | Low | Accepted | first challenger fixes a subject; verdict challenges on the next unposted epoch hold its claims until resolved or expired | rationale: Core resolves from its own records, bond per challenge, hold bounded by `resolve_timeout_s` | none |
| A1-07 | Low | Accepted | permissionless expiry can race a late resolution | rationale: Core must resolve within the timeout | none |
| A1-08 | Low | Fixed (2026-10-10, `9f70357`) | `slash` was bounded only by Core (repeat slashes in one epoch, arbitrary suspension epoch) | admin-editable `max_slash_bps_per_epoch`: per agent, per chain epoch (window `epochs_posted`), refused whole with `SlashCap`, never clamped; Core resends after the next post; residual: the suspension epoch argument | `onchain/tests/tests/slash_cap.rs` 5 tests; `packages/core/test/chain.test.ts` cap test |
| A1-09 | Low | Accepted | message caps are per agent, not global; `lineage_msg` ignores the registry pause and suspension | rationale: each agent costs a burn or launch; fee payer pays; own pause | `msg.rs` `signer_must_be_the_current_registry_signing_key` (revoked keys) |
| A1-10 | Info | Accepted | `graduate` and `repoint_position` ignore `LaunchConfig.paused` | rationale: they only record which locked position is cranked; cranks honour the pause | none |
| A1-11 | Info | Accepted | `max_debit_per_epoch = 0` means no cap; devnet compute sink is the runtime's own account | rationale: devnet only; before mainnet a treasury-controlled sink and a sized cap | none |

## Onchain, review of 2026-10-07

From onchain/README.md "Review fixes"; fixed in `0e808f3` and upgraded on devnet the same day
(onchain/DEVNET.md "Review-fix upgrade").

| Id | Fix | Test |
|---|---|---|
| H1 `graduate` could bind a forged dust position | strict majority of permanently locked liquidity; `repoint_position`; `graduate_by_admin` | `forged_dust_position_cannot_graduate`, `admin_graduates_past_a_larger_third_party_lock` |
| H2 curve fees and partner surplus stranded at migration | `crank_fees` before and after graduation | `curve_fees_left_at_migration_are_cranked_after_graduation` |
| M1 a retried slash could land twice | `SlashReceipt` per slash id | `slash_lands_once_per_id` |
| M2 runtime key could drain every compute vault | clocked usage sequence, hosted only, `max_debit_per_epoch` | `usage_sequence_hosted_only_and_debit_cap` |
| M3 Core key could post arbitrary epochs and amounts | clocked `post_epoch`, pool and rebate caps, `set_epoch_cursor` | `post_epoch_sequence_clock_and_caps` |
| M4 unbond cooldown had no floor | `>= 2 x epoch_length_s` | `config_floors_and_nonzero_keys` |
| L1 Core desync on a send reported failed but landed | read back `Epoch` / `SlashReceipt` before retry | `packages/core/test/chain.test.ts` |
| L2 `registry_program` admin-changeable | constant | `full_launch_records_everything` |
| L3 any Token-2022 `$LINE` accepted | extension allowlist | `line_mint_extension_allowlist` |
| L4 surplus threshold from the launch config | read from the pool's DBC config | crank tests |
| L5 long strings could not fit one transaction | `MAX_LAUNCH_STRINGS` 227 | `longest_launch_fits_one_transaction` |
| L6 a late strike reset the epoch count | restart only on a strictly newer epoch | `slash_strikes_and_suspension` |
| L7 failed slashes dropped after 5 attempts | retried with backoff until they land | `packages/core/test/chain.test.ts` |
| L8 config validation | nonzero keys, `min_bond <= bond_cap` | `config_floors_and_nonzero_keys`, `usage_sequence_hosted_only_and_debit_cap` |

## Offchain, lane A2 (2026-10-09)

Fix commits: Core `ef823c7`; web, wallet, embed, indexer `77b8144`; deploy kit and gate `fda0c0e`;
sandbox, worker, runtime, souls, mirror `b7b4e0f`. Test files: `packages/*/test/audit-a2.test.ts`,
`scripts/deploy/gate.test.ts` (OFF-D), `packages/indexer/test/{decode,ingest}.test.ts`,
`packages/embed/test/embed.test.ts`, `packages/chain/test/browser.test.ts` ("audit: co-sign guards"),
`apps/web/test/trade-decimals.test.ts`, plus named tests in existing suites. Test names below are as
docs/AUDIT.md gives them.

| Id | Severity | Status | Issue | Fix | Test |
|---|---|---|---|---|---|
| OFF-01 | High | Fixed | provenance POST answered "is X the author of this open candidate" to anyone | only the author or runtime gets past the first check | core `audit-a2.test.ts` OFF-01 |
| OFF-02 | High | Fixed | replay firewall refusal named the author to the replayer | such messages accepted with the same answer and held | `messages.test.ts` "replay firewall", `msgchain.test.ts` "preflight" |
| OFF-03 | High | Fixed | a canary was judged at each reveal, letting a replayer skip its reveal | canary replays judged when the group settles | OFF-03 |
| OFF-I1 | High | Fixed | indexer accepted `lineage_launch` events logged by any program | data lines count only inside `lineage_launch`'s invoke frame | `decode.test.ts` "audit: forged events" |
| OFF-S1 | High | Fixed | `prepare_outputs` followed symlinks out of the tree (keys into the deps layer) | `copyConfined` refuses symlinks and non-regular files | sandbox OFF-S1 (two) |
| OFF-S2 | High | Fixed | a FIFO in a result path froze the worker | O_NOFOLLOW, O_NONBLOCK, fstat | OFF-S2 |
| OFF-K1 | High (malicious Core) | Fixed | `materializeProposal` wrote outside its root from Core-supplied names | names validated before path use | worker OFF-K1 |
| OFF-R1 | High (malicious Core or chain) | Fixed | discovered agent ids used as file paths (overwrote a keypair) | base58 32-byte check | runtime OFF-R1 (two) |
| OFF-D10 | High (as filed) | Partly fixed | one user runs every service and is in the docker group | systemd hardening added; user split accepted until mainnet (M4) | none for the accepted part |
| OFF-04 | Medium | Partly fixed | final canary recognisable before its epoch closes | passing canary role reads `counted`; residual accepted | OFF-07, `canary-audit.test.ts` |
| OFF-05 | Medium | Fixed | released stacked candidate named its dependency's generation | one wording for every release | `series.test.ts` first test |
| OFF-06 | Medium | Partly fixed | sessions named a later sealed session's agent | only open or committed intents do; residual accepted | OFF-06 |
| OFF-07 | Medium | Fixed | shadows outlived their listing | retired once a canary is final in a closed epoch | OFF-07 |
| OFF-09 | Medium | Fixed | split fee debited at commit named the team | debited when final | `split-ports.test.ts` measured split |
| OFF-10 | Medium | Fixed | made-up split reports were paid | extra pay only when coalition reports agree | `split-ports.test.ts` "disagreeing coalition reports" |
| OFF-11 | Medium | Fixed | `limit=-1`, NaN, bad percent-encoding | validated, clamped, 400 | OFF-11, fuzzer |
| OFF-16 | Medium | Fixed | lazily built module tables rolled back inside a request | modules built outside transactions | OFF-16 |
| OFF-S3 | Medium | Fixed | quadratic junit regex | linear scan | OFF-S3 |
| OFF-S4 | Medium | Fixed | whole-file artifact hashing | streamed | OFF-S4 |
| OFF-S5 | Medium | Fixed | overlay copy wrote through symlinks | per-file confined copy | OFF-S5 |
| OFF-K3 | Medium | Fixed | an unparsable model turn was billed but not metered | metered from partial usage or worst case | worker "a turn whose tool JSON fails to parse is still metered" |
| OFF-K4 | Medium | Fixed | NaN or negative usage defeated spend caps | sanitized | worker "a usage block with missing or negative counts" |
| OFF-R3 | Medium | Fixed | NaN spend record reset the global cap | non-finite means nothing left | runtime "a NaN spend record" |
| OFF-R4 | Medium | Fixed | stale-lock takeover race (two runtimes) | O_EXCL takeover and re-read | OFF-R4 (two) |
| OFF-E1 | Medium | Fixed | embed bases accepted `javascript:`; demo `?api=` swapped data on our origin | http(s) only; same-origin `?api=` | `embed.test.ts` "resolveBases ignores javascript:" |
| OFF-E2 | Medium | Fixed | `repo_url` href without scheme check | non-http(s) rendered as text | `embed.test.ts` "a repository URL that is not http(s)" |
| OFF-C1 | Medium | Fixed | co-sign let the co-signing key pay fees with any compute budget | refused as fee payer or writable signer; budget limits | `browser.test.ts` "audit: co-sign guards" |
| OFF-C2 | Medium | Fixed | a rotation co-signed for agent A could rotate agent B | `expectAgent` checks the record PDA | "a rotation co-signed for agent A refuses a transaction that rotates agent B" |
| OFF-W1 | Medium | Fixed | trade box took decimals from the indexer | decimals from the mint account | `apps/web/test/trade-decimals.test.ts` |
| OFF-D1 | Medium | Fixed | stream cap raced | `StreamSlots` reserve first | `gate.test.ts` OFF-D1 |
| OFF-D2 | Medium | Fixed | rotating IPv6 addresses got fresh buckets | /64 keys | OFF-D2 |
| OFF-D3 | Medium | Fixed | unbounded bucket table | LRU above 50,000 | OFF-D3 |
| OFF-D5 | Medium | Fixed | bodies buffered whole, no deadline | `readCapped` 413 / 408 | OFF-D5 |
| OFF-D8 | Medium | Fixed | `/market/*` bypassed the gate | market class through the gate | OFF-D8 |
| OFF-D9 | Medium | Fixed | no CSP on the origin that builds wallet transactions | CSP and related headers | OFF-D9 |
| OFF-W3 | Medium | Accepted | slippage floor and devnet check rest on one RPC | rationale: devnet; before mainnet a second price source | none |
| OFF-D4 | Medium-low | Fixed | `/api/admin/*` reached Core admin routes through the proxy | refused, plus encoded slashes | OFF-D4 |
| OFF-S6 | Low-medium | Partly fixed | world-writable trees and deps layer | chmod only where needed; residual accepted | OFF-S6 |
| OFF-G2 | Low-medium | Fixed | `signedCommit` pushed into a non-fork repo, took any path | fork of expected parent; `safeCommitPath` | OFF-G2 (two) |
| OFF-I2 | Low-medium | Fixed | trade amounts from vault deltas (donation inflates) | Meteora swap event first | `decode.test.ts` "tokens donated into the quote vault" |
| OFF-08 | Low | Accepted | private session events leave gaps in `seq` | subsumed by OFF-06 | none |
| OFF-12 | Low | Fixed | 500 echoed exception text | generic message | OFF-12 |
| OFF-13 | Low | Fixed | `hotspot.replay_assigned` named the replayer | removed | OFF-13 |
| OFF-14 | Low | Fixed | usage records took NaN, negative, fractional counts; truncated refs | validated | OFF-14 |
| OFF-15 | Low | Fixed | `githubFullName` accepted `..` | dot-only names refused | OFF-15 |
| OFF-17 | Low | Accepted | unauthenticated upstream check and opt-in routes | gate refuses POST to `/v1`; per-repo cap | none |
| OFF-18 | Low | Accepted | public full scans | bounded; needed by verify and replicas | none |
| OFF-19 | Low | Accepted | DNS rebinding window on domain proofs | redirects refused; pass or fail only | none |
| OFF-S7 | Low | Fixed | protected-block checks read through a directory symlink | confined reads | OFF-S7 |
| OFF-K2 | Low | Fixed | key and pending-state file modes | O_EXCL 0600 | OFF-K2 (two) |
| OFF-K5 | Low | Fixed | Core's `split.n` drove 2^n evaluations | cap of 5 | OFF-K5 |
| OFF-R5 | Low | Fixed | redaction gaps | all logs through `redact` | OFF-R5 |
| OFF-G1 | Low | Fixed | basic-auth tokens escaped redaction; git tracing | extended redaction; tracing off | souls and mirror OFF-G1 |
| OFF-G3 | Low (malicious Core) | Fixed | Core-supplied sha and branch reached git argv | 40-hex sha, safe ref names | OFF-G3 (two) |
| OFF-I3 | Low | Fixed | one bad transaction wedged an indexer source | per-transaction errors, cursor moves on | `ingest.test.ts` "a malformed transaction does not wedge its source" |
| OFF-I4 | Low | Accepted | source spam | bounded by RPC and per-cycle work | none |
| OFF-W2 | Low | Fixed | `repo_url` href on the token page | `repoLink` | tsc only (no page harness) |
| OFF-W4 | Low | Accepted | faucet hourly cap race | devnet only; gate limit | none |
| OFF-D6 | Low | Fixed | same-origin routes passed requests with no Origin | listed Origin required | OFF-D6 |
| OFF-D7 | Low | Fixed | client forwarding and auth headers reached upstreams | stripped | OFF-D7 |
| OFF-D11 | Low | Fixed | `site.env` world-readable; key URL left after wipe | umask 077, scrub | none listed |
| OFF-D12 | Low | Accepted | Caddy admin API on localhost | moving it needs a server-tested reload path (M4) | none |
| OFF-S8 | Medium | Accepted | every worker runs `prepare` with network | rationale: deps digest must match; operator guidance | none |
| OFF-S9 | Low | Accepted | known measurement-forging residuals | covered by equivalence, canaries, audits | none |

After the A2 fixes (docs/AUDIT.md "Offchain"): `bun test packages` 567/567, `tsc` clean, `bun
scripts/e2e.ts` 83/83, `scripts/audit/fuzz-core.ts` 0 of 1,524 requests answered 500 (42 of 762
before).
