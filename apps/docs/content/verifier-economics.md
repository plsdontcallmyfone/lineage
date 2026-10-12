# Earnings and slashes

> A verifier earns work units for every valid replay, whatever the verdict, and is paid by Merkle claim at each epoch. Lying costs bond: accepting a known-bad canary, landing in the minority on a deterministic number, or revealing something other than what was committed are all slashed.

## What you earn

- Every valid replay: `u_replay` x the recipe's cost class in work units, whatever the verdict, plus a rebate of {{cfg:rebate_per_class}} per cost class from the compute reserve.
- Audit replays and correctly rejected canaries pay like replays.
- Paid to your wallet by Merkle claim at each epoch ([Challenges, epochs, claims](doc:challenges-and-epochs#claims)).
- You are drawn in proportion to `min(bond, bond_cap)` ({{cfg:bond_cap}}).

## What you can lose

:::warning Your bond is at risk
Every row below is charged against the bond you posted. The figures are read live from Core; on devnet they are test values.
:::

| Offence | Slash | Strike |
|---|---|---|
| Accepting a canary | {{cfg:canary_slash_bps}} of bond | yes |
| Minority on a deterministic number | {{cfg:minority_slash_bps}} | yes |
| Reveal does not match commitment | {{cfg:reveal_slash_bps}} | yes |
| Assignment abandoned (no commit in time) | none | yes |

{{cfg:strike_limit}} strikes in one epoch suspend you for the next. Within one chain epoch your slashes total at most the per-epoch slash cap; a slash past it waits for the next epoch. Unbonding stops new assignments at once, but the bond is released only after `unbond_cooldown_s` from your last involvement resolving. A wrong slash can be challenged.

## Why honesty is the best strategy

- **You are paid the same for accept and reject**, so there is no reward for saying yes.
- **You commit before anyone reveals**, so you cannot copy another verifier's answer.
- **Canaries look like real candidates.** {{cfg:canary_rate}} of assignments are known-bad changes from identities launched ahead of time through the real launch path. Passing one costs {{cfg:canary_slash_bps}} of your bond.
- **Audits come later.** {{cfg:audit_rate}} of accepted generations are replayed again on a fresh seed; a contradiction slashes the wrong side.
- **You never know the author** of a candidate you replay ([Sealing](doc:sealing)).

## The parameters, live

| Parameter | Value now |
|---|---|
| Registration burn | {{cfg:register_burn}} |
| Minimum bond | {{cfg:min_bond}} |
| Bond counted towards the draw, at most | {{cfg:bond_cap}} |
| Replays per candidate | {{cfg:quorum}} |
| Work units per replay | {{cfg:u_replay}} x the recipe's cost class |
| Rebate per cost class | {{cfg:rebate_per_class}} |
| Strikes before suspension | {{cfg:strike_limit}} |
| Unbond cooldown | {{cfg:unbond_cooldown_s}} |

These are devnet test values; launch values are TBA. How units become payouts, how claims work and how to contest a slash: [Challenges, epochs, claims](doc:challenges-and-epochs).
