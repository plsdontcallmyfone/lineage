# Admin and authority powers

The role table is docs/AUDIT.md "Onchain", "Powers" (lane A1, 2026-10-09), carried over unchanged. The
pause coverage and the permissionless list below were read from the program sources at the commit in
`SCOPE.md` on 2026-10-10.

## Who holds each role

| Role | Devnet holder (2026-10-10) | Planned for mainnet |
|---|---|---|
| Upgrade authority, all three programs | deployer `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` (read with `solana program show`, see `SCOPE.md`) | a Squads v4 multisig vault with a timelock, separate from the admin keys (docs/plans/MAINNET-PREP.md M2; docs/AUDIT.md powers mitigation) |
| Registry admin `Config.admin` | the deployer | multisig (M2) |
| Launch admin `LaunchConfig.admin` | the deployer | multisig (M2) |
| Messages admin `MsgConfig.admin` | the deployer | multisig (M2) |
| Core authority `Config.core_authority` | `CjNUnQ3v2FRQJiMr16CfaFWCdzJ3nqq1VvY2zAgsc4j9` | a hot key with the scoped powers below (M2: "stays a hot key with tightly scoped powers") |
| Runtime authority `LaunchConfig.runtime_authority` | `DCmdy5MoAfnN6fn3nVW27db62ZwtjoksqSqdjAc8VPk4`, which also owns the compute sink | hot key; the sink should be treasury-controlled and the debit cap sized (A1-11) |

Holders from onchain/DEVNET.md "Wiring" and docs/AUDIT.md "Powers"; nothing on mainnet exists yet.

## Exact powers

| Role | Exact powers | If compromised |
|---|---|---|
| Upgrade authority (one key, all three programs) | Replace any program's code (`solana program deploy`), which is total control of every vault and record. Also the only signer of the one-time `initialize`, `initialize_launch` and `lineage_msg::initialize`. | Everything: bonds, treasury, reserve, pool, payable and challenge vaults, every compute vault and escrow, the agent token fee positions. Mitigation before mainnet: a multisig with a timelock, separate from the admin keys. |
| Registry admin (`Config.admin`) | `set_config`: the admin, Core authority, launch program and every SPEC 13 parameter (slash shares up to 100%, `register_burn`, `unbond_cooldown_s` down to two epoch lengths, `epoch_length_s`, reserve/pool split) and `max_rebate_per_epoch` (no upper bound). `pause` (stops every instruction that is not an admin's own except `revoke_agent_key`, `migrate_agent`, `migrate_epoch` and `expire_challenge`; claims and unbond withdrawals included; `lineage_launch` and `lineage_msg` have their own pauses). `set_epoch_cursor` (rewrites the epoch sequence and clock anchor). `set_challenge_config` (window, bond, reward, timeout, pause of new challenges). `set_slash_cap` (A1-08, at least every single share). `migrate_config` and `migrate_config_slash_cap` once. It cannot move tokens or edit agent records, epochs or receipts directly. | Becomes any Core authority it names, so everything in the Core row with no cap (it raises `max_rebate_per_epoch` and resets the epoch clock): the pool vault each post, the whole reserve, and every bond through 100% slashes; it can freeze all claims and withdrawals with `pause` or an unbounded challenge window, and point `launch_program` at its own program to register fake launched agents and redirect `agent:<id>:compute` payouts. |
| Core authority (`Config.core_authority`) | `post_epoch` (next epoch only, clocked: roots, units, `pool_amount` up to the pool vault, `rebate_amount` up to the reserve and `max_rebate_per_epoch`); `slash` (any agent, offence, epoch, fresh id; configured shares; suspensions); `resolve_challenge` (outcomes, bond and reward moves with rewards capped per A1-05, slash reversals, root corrections while an epoch has no claim). | Pays the whole pool vault and up to `max_rebate_per_epoch` of the reserve each epoch length to leaves it chooses, plus up to the same again as challenge rewards; slashes bonds into the reserve up to `max_slash_bps_per_epoch` of each agent's bond per chain epoch (A1-08), from where they leave at those rates; resolves challenges against honest challengers. Bounded by the clocked sequence (no burst) and visible on chain; the admin rotates the key and can pause. |
| Launch admin (`LaunchConfig.admin`) | `set_launch_config`: admin, runtime authority, compute sink, fee split, sleep and wake thresholds, pause, `max_debit_per_epoch` (0 = none) and `pump_creator_fee_bps` (the `creator_fee_bps` every pump.fun launch must be created with; 0 = pump.fun's default schedule, at most 10,000, and pump.fun itself caps it). `set_bounty_config`. (`graduate_by_admin` was removed with the Meteora venue, 2026-10-10.) `migrate_launch_config` once. | Names itself runtime authority and compute sink with no debit cap, then drains every hosted agent's compute vault in one usage epoch; can pause cranks, withdrawals and bounties; can route future launches' fees entirely to the protocol treasury (not to itself) and can make new launches impossible with a creator fee rate pump.fun refuses. Cannot touch self-hosted vaults, escrows, or a creator PDA's `$LINE` (only `crank_pump_fees` moves it, by the configured split). |
| Runtime authority (`LaunchConfig.runtime_authority`) | `post_usage` (clocked sequence, one root per epoch length); `debit_compute` (hosted agents only, proven usage leaf, once per agent and usage epoch, to the configured sink, at most `max_debit_per_epoch` in total per usage epoch); `open_bounty` / `cancel_bounty` for hosted payers (at most `max_bounty_out_bps` of a vault per window). It holds hosted agents' signing keys (SPEC 17.2), so it also speaks for them in `lineage_msg`, `set_profile` and `open_challenge`. | Moves up to `max_debit_per_epoch` per usage epoch length from hosted vaults to the sink (on devnet the sink is its own account, A1-11); escrows hosted vaults into bounties that pay only through Core-proven accepted generations; posts messages and profile digests as hosted agents until each owner rotates or revokes the key. |
| Messages admin (`MsgConfig.admin`) | `set_config`: caps, sizes, pause, the admin. | Pauses messages or loosens the caps (spam at the fee payer's cost). Cannot forge or delete a message. |

## Owner and agent powers (not privileged, listed for completeness)

| Signer | Instructions |
|---|---|
| Agent owner (wallet) | `register` (with the agent key co-signing), `update_agent`, `bond`, `request_unbond`, `withdraw_unbonded`, `rotate_agent_key` (with the new key), `revoke_agent_key`, `propose_owner`; self-hosted: `withdraw_compute`, `open_bounty`, `cancel_bounty` (A1-03) |
| Proposed owner | `accept_owner` |
| Agent's current signing key | `set_profile`, `open_challenge`, every `lineage_msg` post and key publication |
| Launcher (any wallet, with the agent key co-signing; the fresh mint signs pump.fun's `create_v2`) | `register_pump_launch` |

## Permissionless instructions (any signer)

`split`, `claim` (tokens only to the leaf's destination), `migrate_agent`, `migrate_epoch`,
`expire_challenge` (after `resolve_timeout_s`), `crank_pump_fees`, `record_pump_graduation`,
`refresh_awake`, `release_bounty` (with a valid proof), `refund_bounty` (after
deadline plus grace). These are where an outside attacker starts; `REVIEW-AREAS.md` lists the ones we
care most about.

## Pause coverage

| Program | Pause flag | What still works while paused |
|---|---|---|
| `lineage_registry` | `Config.paused` (admin `pause`) | admin instructions (`set_config`, `pause`, `set_epoch_cursor`, `migrate_config`, `set_challenge_config`), `revoke_agent_key`, `migrate_agent`, `migrate_epoch`, `expire_challenge`. `ChallengeConfig.paused` separately stops new challenges. |
| `lineage_launch` | `LaunchConfig.paused` (in `set_launch_config`); `BountyConfig.paused` for new bounties | admin instructions, `record_pump_graduation` (A1-10), `refresh_awake`, `refund_bounty` and `cancel_bounty` (they only return funds, SPEC 14.7); `register_pump_launch` and `crank_pump_fees` stop |
| `lineage_msg` | `MsgConfig.paused` | admin `set_config`; it does not follow the registry pause (A1-09) |

The registry pause also stops `register_launched`, so launches stop with it (SPEC 14.1).

## External powers (pump.fun, not ours)

Read from pump.fun's IDLs (pump-public-docs `2293f9a`) and mainnet `Global` on 2026-10-10. They are
trust assumptions of the launch venue (`THREAT-MODEL.md`, "pump.fun as a dependency").

| Holder | Power | Effect here |
|---|---|---|
| Pump `Global.admin_set_creator_authority` (`admin_cto`), `Global.set_creator_authority` (`set_creator`), PumpSwap `admin_cto_pool` | reassign a coin's creator (community takeover) | the coin's creator fees leave the agent's creator PDA |
| Pump Fees `fee_config` admin | change fee tiers and the exotic flat row custom pairs pay | compute funding rate changes |
| Pump `Global.authority` | `set_max_curve_depth` (0 disables pump-coin quotes), `update_creator_fee_config` (whether and how much `creator_fee_bps` may be set), `toggle_create_v2` | new launches can stop; the configured fee rate may become invalid |
| pump.fun upgrade authorities | replace Pump, PumpSwap, Pump Fees or Mayhem | any behaviour above, and layouts `pump.rs` reads |
