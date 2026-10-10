# Priority review areas

What we most want an external reviewer to spend time on, in order. Items 1 to 6 come from docs/AUDIT.md
"Onchain", "For an external auditor" (lane A1); items 7 to 9 from the same section's accepted items and
the powers table; the offchain list from docs/AUDIT.md "Offchain", "For an external auditor" (lane A2).
The doc drift at the end was found while preparing this package and fixed on 2026-10-10 (SPEC v0.27).

## Onchain (the requested scope)

1. **The Meteora integration** (`lineage_launch/src/meteora.rs`, `crank_fees`, `crank_pool_fees`,
   `graduate`, `repoint_position`, `graduate_by_admin`). No Meteora crate: fixed offsets,
   discriminators and account lists for DBC `release_0.2.2` and DAMM v2 `release_0.2.5` builds.
   Meteora redeployed DBC on devnet after the first vendored dump, and mainnet ran older DBC builds
   when the vendor README was written. Please re-check every offset and every fee-claim account list
   against the exact mainnet builds, and the "strict majority of permanently locked liquidity" rule
   for graduation (review H1).
2. **The challenge state machine as a whole** (`lineage_registry/src/challenge.rs`): `ChallengeGate`
   counters, the claim hold, root correction only while `claims == 0`, the interaction of the hold
   with bounty releases after A1-04, refund handling after A1-02, expiry racing resolution (A1-07),
   and whether any path can leave a gate open forever.
3. **Economic bounds on a compromised Core key**: rebates plus challenge rewards (A1-05) at most twice
   `max_rebate_per_epoch` per epoch length from the reserve, plus the pool each post; slashes up to
   `max_slash_bps_per_epoch` of each agent's bond per chain epoch (A1-08, fixed 2026-10-10). Is there a path that beats these bounds?
4. **The Merkle leaf encoders** (`lineage_registry/src/leaf.rs`, `lineage_launch/src/bounty.rs`
   `contribution_json`, `target_json`) against Core's canonical JSON (`packages/protocol`,
   `packages/core/src/records.ts`), especially escaping and key order: a mismatch either strands
   payouts or admits a forged leaf. Proofs use sorted pairs with no index; replay protection is the
   `ClaimReceipt` per (epoch, leaf) and the `BountyReceipt` per (payer, leaf).
5. **Compute vault custody** (`withdraw_compute`, `debit_compute`, `post_usage`, bounties): who can
   move a vault after an owner transfer (A1-03), the hosted versus self-hosted split, the per-window
   bounty caps, and `drain` closing vaults (A1-01).
6. **Key management**: one hot key is the upgrade authority and every admin on devnet. We plan a Squads
   v4 multisig with a timelock (docs/plans/MAINNET-PREP.md M2); a review of that plan and of which
   powers should sit behind the timelock is welcome.
7. **Admin parameter ranges**: `set_config` accepts slash shares up to 100% and an unbounded
   `max_rebate_per_epoch`; `set_epoch_cursor` rewrites the sequence; `launch_program` is admin-set and
   decides where `agent:<id>:compute` claims go (`POWERS.md`). Which of these need onchain bounds?
8. **Initialization and migrations**: initializers checked through ProgramData (negative tests for all
   three programs added 2026-10-10 in `tests/tests/init_auth.rs`, `THREAT-MODEL.md`; LiteSVM 64/64 with them), and the run-once, length-gated
   migrations (`migrate_config`, `migrate_launch_config`, `migrate_agent`, `migrate_epoch`).
9. **Token-2022 handling**: the `$LINE` extension allowlist, the A1-02 `refund_usable` checks
   (initialized, unfrozen, right mint and program, no required memo), `transfer_checked` everywhere,
   and agent mints created by DBC.
10. **`lineage_msg`**: the event authority and self-CPI pattern, rate-limit arithmetic, and the deployed
    binary pairing noted in `SCOPE.md`.

## Offchain (if the engagement covers it)

- **Author-blindness as a whole** (SPEC 10.7): a property of every public byte; the A2 lane found
  five independent oracles. OFF-04 and OFF-06 residuals are open by design.
- **Canary incentives** after OFF-03: any other signal that tells a replayer between commit and reveal
  that a candidate is a canary.
- **The sandbox against a determined candidate**: OFF-S9 measurement-forging residuals, `prepare` with
  network on every worker (OFF-S8), containers as the worker's uid on Linux.
- **Workers, runtime and mirror against a compromised Core**: every Core-supplied value as hostile.
- **The site host**: one user with docker access runs every internet-facing service (OFF-D10), the
  Caddy admin API (OFF-D12), the identity service route `/identity/*` (not reviewed by A2).
- **The wallet's trust in the site RPC** (OFF-W3) and the co-sign flows (OFF-C1, OFF-C2).

## Documentation drift (fixed 2026-10-10)

Where docs/SPEC.md v0.25 and onchain/README.md disagreed with the code at the commit in `SCOPE.md`. Each
item was checked against the program sources and fixed in SPEC v0.27 and onchain/README.md on 2026-10-10
(spec drift + init test lane); no program code changed. Line numbers are those of v0.25.

| Where | Said | Code since | Status |
|---|---|---|---|
| SPEC 14, first paragraph (line 813) | the programs are "not deployed anywhere" | deployed to devnet since 2026-10-07 (onchain/DEVNET.md) | fixed |
| SPEC 14.1 `pause` (line 827) | "while paused every other instruction but `set_config` fails" | several more work while paused (`POWERS.md` "Pause coverage") | fixed |
| SPEC 14.2 `ComputeVault` row and instruction list (lines 846, 851) | withdrawn by "the launcher of a self-hosted agent" | the registry `Agent.owner` (A1-03) | fixed |
| SPEC 14.7 `open_bounty` and `cancel_bounty` (lines 903, 906) | signed by the payer agent's launcher when self-hosted | the registry `Agent.owner` (A1-03) | fixed |
| SPEC 14.7 `release_bounty` | no mention of the challenge hold | release waits for the hold, `BountyHeld` (A1-04) | fixed |
| SPEC 10.8 "Residuals" (line 477) | "Bounty releases (14.7) read `Epoch.record_root` without the hold" | no longer true after A1-04 | fixed |
| SPEC 10.8 "Onchain accounts" (line 471) | `expire_challenge`: "bond back" | the bond goes to the reserve when the refund account is unusable (A1-02) | fixed |
| onchain/README.md line 3 | "two programs" | three (`lineage_msg` added 2026-10-08) | fixed |
