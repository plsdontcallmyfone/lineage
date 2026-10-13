# Swarms: one coin, several agents

Spec only (swarms spec lane, 2026-10-12). Nothing here is built. No program change is proposed for
the first build.

Owner, 2026-10-12: "One coin, several agents. Today one coin funds one agent on one repository. A
swarm is a coin whose vault funds a group of agents working the same repository at once: each takes
a different target, possibly on a different model, and they share one vault, one coin page and one
record." And: "exactly. many screens, etc. roles can differ if you choose to select different models
for members in the swarm."

Every figure below is marked **measured** (with its file), **read** (from source or a config file),
**setting** (a value that is configuration), **calculated** (arithmetic on the former, shown) or
**estimate** (with its basis). Names: a swarm's members are called **seats** in this document (seat
1 to N); the page calls them agents.

## 0. The short answer

- **Shape (recommended, no program change):** the swarm is ONE registered agent: one registry
  record, one coin, one `AgentLaunch`, one compute vault, one signing key, exactly as today. Its
  members are seats of that agent, declared in the agent's signed soul (whose digest the launch
  already commits on chain with `set_profile`). Every candidate is authored by the swarm's agent id;
  the seat that wrote it is recorded beside it and shown once the candidate is final.
- **Why not N registered agents:** the deployed programs cannot do it. A launched record is created
  only inside `register_pump_launch`, which requires a new pump.fun coin in the same transaction
  (read: `onchain/programs/units-launch/src/lib.rs` 108 to 150), so N launched agents are N coins.
  A compute vault leaves only through `debit_compute` (to the compute sink, by leaf for that vault's
  own agent) and `withdraw_compute` (self-hosted, owner): there is no instruction that moves one
  vault's balance to another agent (read: same file, 296 to 362). Details in section 1.
- **The real limit is verification, not authoring.** A unit accepts one candidate at a time: an
  accepted candidate becomes a generation only on the current tip, gets one rebase replay if the tip
  moved, and is rejected `stale` if it moved again (read: `packages/core/src/core.ts` 1883 to 1899).
  On the site a verdict took 16 to 81 minutes, median 64, while authors committed 6 candidates an
  hour (measured: `docs/plans/AGENT-EFFICIENCY.md` 6.5). More seats on one unit produce a queue, not
  more accepted changes. A swarm pays off across several units and targets of the repository, and
  section 2 says how seats are placed so they do not invalidate each other.
- **Bind:** stays one signature after launch whatever N is, because all seats speak with the one
  runtime key. Section 7 also shows how to fold that one into the launch approval.
- **Money (calculated from measured figures):** a seat working without a pause on the heavier
  recipes draws about 1.57 USD an hour from the vault; four seats 6.27 USD an hour. Ten USD of
  credits lasts one agent 6.4 hours and four seats 1.6 hours. Section 4.

## 1. The on-chain shape

### What the deployed programs allow (read from source)

| Fact | Where |
|---|---|
| An agent record is created by `register` (a tokenless verifier: owner and agent key sign, `register_burn` is burned) or by `register_launched`, which only `units_launch`'s authority PDA may call | `onchain/programs/units-registry/src/lib.rs` 169 to 202 |
| `register_pump_launch` needs pump.fun `create_v2` for the coin in the same transaction, creates the `AgentLaunch` at `["agent_launch", mint]` and the vault at `["compute", agent]`: one coin, one agent, one vault | `units-launch/src/lib.rs` 108 to 177, 674 to 698 |
| `debit_compute` pays from the vault of `agent_launch.agent` against a leaf `{ agent, amount, epoch, model_tokens, sandbox_s }`; one receipt per epoch and agent | same, 296 to 334, 782 |
| The record has one `signing_key`; `rotate_agent_key` needs the owner and the new key | `units-registry/src/lib.rs` 416 to 428, 1023 to 1030 |
| The soul's digest is `Agent.profile_digest`, committed by `set_profile` in the launch transaction | `docs/SPEC.md` 14.8 |
| Core lets only launched agents author; hosted agents are never drawn as verifiers | `packages/core/src/core.ts` 1149, `docs/SPEC.md` 10.3 |

### Option A (recommended): one registered agent, seats under it. No program change.

What a seat is, exactly:

| To | A seat is |
|---|---|
| The registry and `units_launch` | Nothing of its own. The swarm is one `Agent`, one `AgentLaunch`, one vault. The roster exists on chain only inside `profile_digest` |
| The soul | An entry of a new optional block: `swarm: { v: 1, members: [{ seat, name, role, model: { provider, id } }] }`, seats numbered 1 to N. The existing `model` field stays and equals seat 1's model, so today's readers keep working. No `swarm` block means a solo agent, as today |
| Core | Not an agent. A number carried beside the swarm's agent id on sessions, heartbeats, intents, candidates, spend lines and journal entries. No agent row, no key, no bond, no token |
| The signing key and the firewall | The same single runtime key signs for every seat. The firewall's identity map (key to agent) is unchanged (`packages/runtime/src/firewall.ts`). Desktops hold no secrets today and seats do not change that |
| Verifiers | Invisible. `candidate_id`, `commit_id` and `author_tag` hash the swarm's agent id as today; the seat is in no id and no commitment. While a candidate is open the seat is withheld exactly like the author (SPEC 10.7) |
| Credit | None of its own. Author units go to the swarm's agent, so to the one vault. No split between seats |
| The public record | Once a candidate is final: "by <seat name> (<model>) of <swarm>", from the provenance record the runtime authority already signs per candidate (`packages/core/src/hosted.ts`), which gains `seat` |

Trust: which seat and model wrote a change is the hosted runtime's statement, the same trust as the
model attribution today (SPEC 17.4). The usage leaf's shape is fixed by the program, so the vault is
debited one summed amount per epoch under the swarm's id; the per-seat breakdown is published by
Core from the runtime's spend report and is not provable on chain.

What changes, none of it a program:

- `packages/souls`, Core's soul check: the `swarm` block, validated (1 to `swarm_max_members` seats,
  contiguous numbers, exactly one `lead`, unique safety-checked names, every model priced and offered
  by the registry). After launch the block may change only with a statement signed by the agent's
  registry owner wallet (section 4); the runtime key alone, which signs memory folds, cannot change it.
- `packages/runtime`: `running`, `attempts`, `holds`, `lastStarted` are keyed by agent today
  (`runtime.ts` 776 to 804); they become keyed by agent and seat. Model routing per seat. One
  desktop per seat.
- Core: per-agent caps that would otherwise block a swarm get a seat dimension (section 2).

### Option B (rejected): each member a registered agent, one shared vault

Not possible as launched agents (N coins, above). Possible only as N tokenless `register` records:
each burns `register_burn` (setting: 200,000 $UNITS on mainnet, `scripts/mainnet/official-params.json`),
each needs its own key to co-sign, the chain shows them as kind verifier, they have no vault, and
Core would have to let non-launched records author. Their work could only be paid by summing their
usage into the lead's leaf, which is what option A does without the records. They would then be N
ids on leaderboards, follows and pools, with author units paid per id to the owner's wallet instead
of the vault. Worse on every point this spec must settle.

### Option C (only if an on-chain roster is wanted later): a new small program

A separate `units_swarm` program holding `["swarm", agent]` with the roster, written by the agent's
registry owner. It holds no funds and the two deployed programs are not touched, so no upgrade and no
dev wallet key in the loop for the existing programs. It buys one thing: the roster readable on
chain instead of a digest. Cost, **estimate**: 1.4 to 2.4 SOL of program rent, recoverable on close.
Basis: rent is 6,960 lamports per byte (890,880 lamports for an empty account, read:
`docs/MAINNET-RUNBOOK.md` 326); the smallest program here, `units_msg`, is 342,600 bytes (read:
`onchain/target/deploy/units_msg.so`), 2.39 SOL; a two-instruction program without CPI should be
smaller. Risk: a third program to audit and to keep an upgrade authority for. An upgrade of
`units_launch` instead (member sub-records, per-seat receipts) is ruled out by the owner's rule.

**Recommendation: option A.** C can be added later without touching A.

## 2. Integrity

**Seats never judge each other.** They are one agent id, and every exclusion keys on it. Further,
hosted agents are never in the replayer pool at all (SPEC 10.3), and the same-owner rule excludes
every other agent of the launcher wallet or registry owner from replaying, disputing and auditing
(`packages/core/src/collab.ts` 585 to 598, called for replay draws in `core.ts` 1457, audits 1500 and
challenges `challenges.ts` 452). Confirmed: it covers this, and under option A it is not even needed.

**Seats never count as independent agents.**

| Place | Rule |
|---|---|
| Leaderboards, agent lists, analytics counts | One row, one agent. Seats are a second figure where useful ("12 agents, 31 seats"), never added to the agent count |
| Follows, posts, journal, GitHub account | One of each per swarm. Posting frequency is per swarm, not per seat |
| Pools (SPEC 14.14) | One pool member, one `PoolMember`, one weight (its author units). `max_members` counts coins |
| Team candidates (SPEC 12.2) | A seat cannot be a team member: members are agents. Team size never added units anyway |
| Rate limits | Per-agent limits scale with the declared seats, bounded by `swarm_max_members`; nothing else scales |

Core limits that need the seat dimension (read; all are settings):

| Limit today | Value | For a swarm |
|---|---|---|
| live sessions per agent (`packages/core/src/sessions.ts` 43) | 4 | max(4, seats) |
| `max_intents_per_agent`, `intent_rate_per_hour` (`packages/core/src/config.ts` 188 to 190) | 3, 20 | 3 per seat, 20 per seat |
| heartbeat row, one per agent (`packages/core/src/store.ts` 371) | 1 | one per agent and seat |
| `max_open_candidates_per_agent`, per unit (`config/network.json`) | 3 | unchanged: it is what bounds a swarm on one unit |
| `max_series_depth` (`config.ts` 194) | 3 | unchanged |

**Stale conflicts between seats.** Measured: 31% of candidates were lost to `stale_conflict` on the
site baseline, and after target spread 4 of 10 final candidates were still lost to order, because an
intent lived 10 minutes while a verdict took an hour (`docs/plans/AGENT-EFFICIENCY.md` section 1 and
6.5). Target spread is advisory and reads other agents' intents (`packages/worker/src/target-spread.ts`).
Inside a swarm the runtime knows everything, so assignment is a rule, not a suggestion:

1. **A swarm ledger** in the runtime's state: per unit, the ordered list of the swarm's open
   candidates with their patches, and per seat its unit, target and base. A target belongs to one
   seat until that seat's candidate on it is final or its attempt ended without one. Not a TTL.
2. **Units first.** Seats are spread over the repository's active units before a second seat goes to
   any unit (the existing `rankUnits` order). Different units have different tips, so they cannot
   invalidate each other.
3. **One stack per unit.** A seat that works on a unit where the swarm has an open candidate starts
   from the tip plus the swarm's open patches there, and commits with `depends_on` the newest one
   (stacked series, SPEC 12.4, `efficiency.series`, built). Stacked candidates are judged in order,
   each on a tip that includes the one before, so there is no rebase replay and no `stale`.
4. **Commits are serialized per unit** by the runtime: before a seat commits, its patch is applied to
   the tip plus the stack as it is at that moment; if it no longer applies the seat gets one repair
   turn inside its attempt cap, else the attempt ends without a candidate (no model spend is lost to
   a rejected replay).
5. **At most 3 open candidates per unit** (the two settings above). A seat that would be the fourth
   is placed on another unit, or waits with its screen on "Waiting for verdicts" and spends nothing.
6. Other agents on the same unit can still move the tip; that is unchanged from today (intents stay
   public and advisory; each seat still files one under the swarm's id).

Consequence the owner should know (**calculated** from the rule, not measured): on a repository with
one unit, at most 3 seats have work in flight, and accepted changes per hour are bounded by verdicts
per hour on that unit, whatever N is. Verdict time on the mainnet instance with the capacity host's
verifiers is not measured yet. The later unlock is replaying a stacked candidate while the one under
it is still being replayed (build order, phase 3); it changes scheduling, not the verdict rule, and
needs the owner's approval.

Author-blindness: no new signal about an open candidate. That an agent is a swarm is public by
design; which seat wrote an open candidate is withheld like the author. The unmasked live video
already lets a viewer watch a change being written (owner decision 2026-10-12, SPEC 17.3); N screens
do not change that trade.

## 3. Roles through models

A small fixed set, picked beside the model with a default derived from it.

| Role | How many | Job | Default |
|---|---|---|---|
| Lead | exactly 1 | Before each round, one planning call: reads the units, targets, shared findings (`packages/core/src/shared-findings.ts`) and the ledger, and assigns each builder a unit and target with a two-line brief. Then authors like a builder. Its screen is the large one | The seat whose model has the highest output price in the registry (`config/models.json`); ties to seat 1 |
| Builder | 0 to N-1 | Today's authoring attempt, on the assigned target. The target is fixed for the attempt (today the model may switch target; inside a swarm that causes collisions) | Every other seat |
| Scout | later (phase 3) | Drafts further units for the repository with the existing drafter (`packages/runtime/src/unit-setup.ts`, today only for a repository with no unit), so the swarm has more room | Not in the first build |

If the lead's planning call fails or would pass its cap, seats fall back to the counts-only pick
(`pickTarget`), restricted by the ledger. A swarm of one is exactly today's agent: no planning call.

What a role changes: one fixed paragraph per role in the prompt (versioned with `prompt_version`),
placed after the rules and before the soul, plus the assignment line. Optional lead review of a
builder's patch before commit is a setting, off by default: it costs a model call and the replay is
the judge.

What stays identical for every seat: the proposer's rules word for word, the toolbox, guard limits,
`attempt_max_usd`, the safety checks, and the soul. **One soul for the swarm** (the owner's rule as
given to this lane: every agent on the same fixed soul, only names differing): one document, one
digest on chain, one memory; the seats differ only by `name`, `role` and `model` in the `swarm`
block. The candidate's rationale and patch never carry the voice, as today (SPEC 14.8).

A model is never substituted (SPEC 17.4): a seat whose model is unavailable waits and says so; its
work is not given to another model.

## 4. Money

Inputs:

| Figure | Value | Kind and source |
|---|---|---|
| Model spend, one agent without a pause, heavier recipes | 1.27 USD per hour | measured, `docs/plans/SCALE-OUT.md` section 2 (4 vCPU site, one model, 6.9 attempts an hour) |
| Same, lighter units | 3.96 USD per hour | measured, same table |
| Sandbox seconds per attempt, cycle length | 432 s of 521 s | measured, `scripts/deploy/sizing.ts` `MEASURED` |
| Sandbox price | 0.0001 USD per second | setting, `scripts/mainnet/official-params.json` |
| Credits minimum | 10 USD | setting, same file (`credits_min_usd`) |
| Sleep and wake thresholds | 0.50 and 1.00 USD | setting, same file |
| Attempt cap | 1 USD | setting, `config/network.json` `prepay.attempt_max_usd` |
| Desktop, running | 0.1656 USD per hour, 3.97 USD per day | measured rate, `docs/plans/AGENT-DESKTOPS.md` amendment section 4 |
| Who pays the desktop | the platform, inside `desktop_usd_per_day`; the vault is charged model USD and sandbox seconds only | read, `packages/runtime/src/runtime.ts` 468 to 497 |

Burn (**calculated**): sandbox 432 / 521 x 3600 x 0.0001 = 0.30 USD an hour, so one seat draws
1.27 + 0.30 = 1.57 USD an hour from the vault at full pace on the heavier recipes.

| Seats | Vault burn, USD per hour | 10 USD lasts | Credits for the same 6.4 hours | Desktops, platform USD per day |
|---|---|---|---|---|
| 1 | 1.57 | 6.4 h | 10 | 3.97 |
| 2 | 3.14 | 3.2 h | 20 | 7.95 |
| 4 | 6.27 | 1.6 h | 40 | 15.90 |
| 8 | 12.55 | 0.8 h | 80 | 31.80 |

These are upper bounds per seat: seats waiting for verdicts (section 2) spend nothing on models. They
were measured with one model on a contended server; a seat on a cheaper model burns less, and faster
sandbox hosts mean more attempts an hour and more spend, neither measured per model.

Proposed rules, each a setting and admin-editable:

| Setting | Proposed | Meaning |
|---|---|---|
| `swarm_max_members` | 4 | Largest swarm (section 5) |
| `swarm_min_usd_per_seat` | 10 | Credits at launch are at least this times N. The wizard shows the total and the hours it buys at the measured rate |
| `swarm_seat_reserve_usd` | `attempt_max_usd` | A seat starts an attempt only when the vault covers its cap beside the caps of seats already running (the reservation the runtime already makes per attempt, `reservedLine`) |
| `swarm_epoch_max_usd`, `seat_epoch_max_usd` | none | Optional caps per usage epoch for the swarm and per seat; the existing `agent_epoch_max_usd` becomes the swarm's |
| `seat_desktop_usd_per_s` | open question 4 | Desktop time of seats 2 to N charged to the vault, folded into the debited amount (the leaf's amount is the runtime's sum, so no program change) |

**Sleep and wake** are per vault on chain (`update_awake`): the whole swarm sleeps at 0.50 USD and
wakes at 1.00 USD together. Before that the swarm shrinks by itself: with the reserve rule a vault
holding less than k attempt caps runs at most k seats, lowest seat number first, so the lead works
longest. Paused seats' desktops pause and their tiles read "Paused: vault low".

**Changing size or models after launch.** The roster lives in the soul, so a change is a new soul
version. Core accepts a changed `swarm` block only with a statement `{ v: 1, kind:
"units-swarm-roster", agent, prev_digest, members, created_at }` signed by the registry owner's
wallet (an off-chain signature, no transaction, the pattern the fee-claim wallet statement uses),
within `swarm_max_members` and capacity. So the launcher (or whoever now owns the agent) decides,
inside limits the admin sets. Automatic growth with fee income is not proposed for the first build:
shrinking when the vault is low is automatic and free, growing commits platform desktops and should
stay a person's decision. Recommended as phase 2.

## 5. Capacity

Mainnet instance today (read: `scripts/deploy/site-config.ts` 222 to 262,
`scripts/mainnet/official-params.json`):

| Limit | Value | Carries |
|---|---|---|
| E2B plan | 100 sandboxes at once, shared by every instance on the account (the devnet site's `e2b_max` is 6) | 94 seats if the mainnet setting were raised to the plan |
| `e2b_max`, `desktop_usd_per_day` | 50 desktops, 200 USD a day | 50 seats with a live screen, all day |
| Attempts at once (`sizing.attempts`) | 16 | 16 seats working at the same moment; the rest queue |
| Model day cap (`global_max_usd`, every dollar counted) | 800 USD | 26 seats' worth of full-pace work on the heavier recipes (calculated in `docs/plans/SCALE-OUT.md`: 800 / 24 / 1.27) |
| Verification | 1.76 of the 2.59 vCPUs a full-pace agent needs are its replays (measured, same doc); the site's reference runner and 2 bonded verifiers, plus 2 on the capacity host, are listed | each seat adds replay load like an agent; whether the 2 capacity-host verifiers are registered and bonded was not checked by this lane |

So today the network carries **50 seats in all** (solo agents count as one seat each), 16 working
at once. A seat costs the network exactly what a solo agent costs; a swarm of 4 is 8% of the screens.

- **Maximum size:** `swarm_max_members`, proposed 4. Reasons: section 2 (3 in flight per unit), and
  one coin should not take a large share of 50 screens. The validator's hard bound is 16 so the
  setting has room.
- **At launch, capacity full** (bound seats plus N would pass `e2b_max`, read from the runtime's
  spend report): the wizard says how many seats are free and offers that size. It never takes money
  for seats that cannot start. A launch that lands anyway (a race) binds; seats without a desktop
  wait with the existing reason "waiting for a desktop".
- **Attempt slots scarce:** slots go round robin by coin first, then by seat (today: by agent,
  `fairOrder`), so a swarm's second seat starts only after every funded coin has a slot. A setting
  (`swarm_slot_fairness: "coin"`).

## 6. The page

Existing components and content width only; no new visual language, no monospace, no em dashes.
Tested at 1280 and 390 px like the other pages (`tests/ui`).

**Coin page** (`apps/web/src/pages/token.ts`). The three-column grid stays. A solo coin is unchanged.

- Centre panel: the segment reads Chart / Computers. Computers shows one large screen (the existing
  live panel mount, `mountLivePanel`, given a seat) and under it a row of tiles, one per other seat,
  each the existing thumbnail painter with the seat's name and state. A click on a tile makes it the
  large one. Default large screen: the lead. Only the large screen plays video; tiles are thumbnails,
  because streams have viewer caps (50 per stream, 300 in all, read: SPEC 17.7).
- Stream ids: seat 1 keeps today's id `sha256("units-desktop-stream\n" + agent id)`; seat k adds
  `"\n" + k`. A solo coin's links do not change.
- Under the screens, a list in the existing row style (`tk-rows`, main line and sub line), one row
  per seat: name, role badge, model with its provider logo, current target, last result (accepted
  with its effect, rejected with its reason, no candidate, or waiting with the reason).
- "What the agent is building" becomes "What the swarm is building": same panel, one line per unit
  in work.
- The record (`#mk-commits`): one list of accepted changes for the coin, each row naming the seat
  and its model. Nothing is listed per seat on separate pages.
- 390 px: the large screen is full width; tiles wrap two per row under it (no sideways scroll); each
  seat row is two lines; the trade box stays where it is today.

**Explorer card** (`apps/web/src/pages/explorer.ts`). One card per coin. Its screen is the seat that
is working now (else the lead); a badge in the existing outline style reads "4 agents". Hover plays
that seat's desktop as today.

**Agent profile.** One profile for the swarm, with the same seat list and one soul.

**Launch wizard** (`apps/web/wallet/main.ts`, steps "The coin", "The work", "The agent", "Identity",
"Funding", "Review"). No new step.

- "The agent": a size control, 1 to the maximum the network can take now. Size 1 is today's form.
  Above 1, one row per seat: name (prefilled from the swarm's name with a number, editable), the
  existing model picker with registry prices, role (prefilled by the rule in section 3).
- "Funding": the credits minimum becomes 10 USD x N; under it one line with the measured burn per
  hour for N seats and the hours the credits buy, labelled as measured on the heavier recipes.
- "Review": a row "Swarm: N agents" with each seat's name, role and model, and the total in USD,
  before the one signature. The launch transaction is unchanged in shape: the roster rides in the
  soul whose digest `set_profile` already commits.

## 7. Bind

Today: after the launch the owner signs one `rotate_agent_key` to the runtime's key and the runtime
co-signs (`packages/runtime/src/bind.ts`, `bindHosted` in the wizard). Under option A that is still
**one** signature for any N, because every seat uses that one key. Nothing per seat is signed, at
launch or later.

Proposal to remove that one as well, for solo launches too (not built, needs a fork proof):

1. Before building the launch, the page asks the runtime for the key it will use for this agent id
   (a new pre-bind request; rate limited; an unclaimed key is dropped after a few minutes).
2. The launch bundle gets one more transaction, `rotate_agent_key(owner, agent, runtime key)`, after
   the launch transaction. The wallet signs all of them in the one approval it gives today
   (`packages/chain/src/launch-bundle.ts`).
3. The runtime co-signs that transaction with the check it already has (`checkBindTx`: exactly one
   rotation, to its own key, for this agent; the key never pays) and returns it; the page sends the
   bundle. On mainnet it is a Jito bundle, all or nothing. The measured launch is 2 transactions
   (`packages/chain/src/launch-costs.ts`), so a third fits.
4. Where transactions are sent in order (devnet) and the last one fails, the existing Bind button
   remains the fallback.

The firewall already allows `rotate_agent_key` as the new key (SPEC 14.13). The chain still requires
the signer to be the record's owner.

## 8. Other features

| Feature | Interaction |
|---|---|
| Pools (`docs/plans/AGENT-POOLS.md`) | A swarm is one member. `409 pool_target_claimed` and the measured-split rule apply to it as to any agent. Its larger output raises its weight honestly: weight is author units, which only accepted work earns |
| GitHub fee claims (`docs/plans/GITHUB-FEE-CLAIMS.md`) | Unchanged: the route is per agent, so one route per swarm. Worth showing in the wizard: with the route on, 20% of the coin's agent share goes to the repository's admins while the vault feeds N seats |
| Bounties (`docs/plans/OPEN-BOUNTIES.md`) | The winner is an agent, so the swarm; the reward lands in its one vault. "Agents working on it" counts the swarm once and may show its seats |
| Tweet launch (`docs/plans/TWEET-LAUNCH.md`) | Optional word after `launch`: `swarm <n>`, carried in the link as `swarm=<n>`; the wizard opens with that size, default models and roles, everything editable, and the person still approves there. Out of range: left out of the link, as for other fields. The reply sentences are unchanged. Needs the owner's approval of the wording like the rest of that grammar |
| Paired tokens (`docs/plans/PAIRED-TOKENS.md`, another lane, not in the tree when this was written) | Independent as long as a paired coin still has one agent record and one compute vault: a swarm changes who works, not what the coin is quoted in or paired with. If that spec lets an existing token fund agents, a swarm is the natural way to attach several to it; the two specs should be read together before either is built |
| Shared findings, journal, learnings | One stream per swarm; entries carry the seat's name. Seats read the swarm's own unfinished notes from the ledger at once, without waiting for Core's final-only shared items |

## 9. Build order

Everything in phases 0 to 2 is Core, runtime and pages. No program change, no upgrade.

**Phase 0, behind a Core feature flag `swarms` (off), proven in sim then on devnet with a TEST swarm:**

1. Soul `swarm` block and its checks (`packages/souls`, Core souls module); settings block `swarm`
   in Core's network config and in `runtime.json`, written by `scripts/deploy/site-config.ts`.
2. Core's seat dimension: sessions, heartbeats, intents caps, candidate `seat` (private until
   final), provenance `seat`, spend lines, the agent and candidate views.
3. Runtime seats: state keyed by agent and seat, model per seat, one desktop per seat, the ledger,
   units-first placement, one stack per unit with serialized commits, the reserve rule, slot
   fairness by coin. Roles: lead planning call and the fixed role paragraphs.
4. Pages: wizard size and seat rows with the USD line, coin page Computers view and seat list, the
   record naming seats, Explorer badge. UI tests at 1280 and 390.
5. Proof on devnet: a 3-seat swarm on a repository with two units; read the stale counts, verdict
   times and spend per seat, and replace the calculated figures here with measured ones.

**Phase 1:** switch on for mainnet at `swarm_max_members` 2, then 4, watching verdict times.

**Phase 2:** roster changes by the owner's wallet statement; desktop charge if chosen (question 4);
the bind folded into the launch approval (section 7), after a mainnet fork proof.

**Phase 3, each needing its own approval:** the scout role (more units per repository); replaying a
stacked candidate while its dependency is still being replayed; `units_swarm` (option C) only if an
on-chain roster is wanted.

## 10. Open questions for the owner

1. **Option A (seats under one registered agent, no program change)?** Recommended: yes. The cost is
   that seat attribution is the runtime's statement, like the model today.
2. **Largest swarm at the start?** Recommended: 4, as a setting. Three have work in flight on one
   unit today; larger sizes mostly add idle screens until repositories have more units or phase 3.
3. **Credits at launch: 10 USD per seat, or 10 USD flat?** Recommended: per seat. Flat, a 4-seat
   swarm is asleep in about 1.6 hours at full pace.
4. **Who pays the extra screens?** The platform pays every desktop today (3.97 USD a day each when
   always on). Recommended: seat 1 as today; seats 2 to N charged to the vault at cost (0.1656 USD
   an hour), as a setting that can be set to zero.
5. **Fold the bind into the launch approval (no signature after launch, solo launches too)?**
   Recommended: yes, in phase 2 after a fork proof.
6. **Tweet wording `swarm <n>`?** Recommended: yes, with the size capped by the setting.

## 11. Build status: phase 0 (swarms build lane, 2026-10-13)

The owner approved this spec on 2026-10-13 with: option A (no program change), 4 seats at the start
(`max_members`, a setting), credits at launch 10 USD per seat (the network's own prepay minimum times
the seats, read from Core, never repeated in code), and screens: the first seat's desktop free, seats
2 and up charged to the swarm's vault at cost.

Phase 0 is built behind Core's feature flag `swarms`, **off everywhere**. Nothing is deployed, no
mainnet transaction was sent, no program was touched.

### What is where

| Part | Where |
|---|---|
| The soul's `swarm` block, its checks, default lead, role paragraphs | `packages/souls/src/swarm.ts` (+ `schema.ts`, `safety.ts`) |
| The flag and the settings | `packages/core/src/features.ts`, `config.ts` (`SwarmSettings`), `config/network.json` (`features.swarms`, `swarm`) |
| Core's seat dimension, routes, views, admin settings | `packages/core/src/swarms.ts`; hooks in `sessions.ts`, `collab.ts`, `live.ts`, `hosted.ts`, `souls.ts`, `http.ts`; tables in `purge.ts` RULES; routes in `scripts/docs/api-notes.ts` |
| The ledger, seat keys, the lead's plan | `packages/runtime/src/swarm.ts` |
| Seats as workers of the one key, budgets, slots, desktops, reports | `packages/runtime/src/runtime.ts`, `providers.ts` (model per seat), `provenance.ts`, `state.ts` |
| A seat's attempt (placement, stacked and serialized commits) | `packages/worker/src/seat.ts`, `worker.ts` |
| A desktop per seat, its stream id, its running time | `packages/desktop/src/agent-desktops.ts`, `pool.ts`, `publish.ts` |
| Pages | `apps/web/src/swarm.ts`, `pages/token-swarm.ts` (+ hunks in `token.ts`, `explorer.ts`, `agent-profile.ts`, `commits.ts`), `apps/web/wallet/swarm-step.ts` (+ hunks in `main.ts`, `pages.ts`, `prepay.ts`) |
| Tests | `packages/souls/test/swarm.test.ts`, `packages/core/test/swarms.test.ts`, `packages/runtime/test/swarm.test.ts`, `apps/web/test/swarm-step.test.ts`, `tests/ui/swarms.spec.ts` |
| The local proof | `scripts/swarms/proof.ts`, results in `scripts/swarms/PROOF-LAST.json`, spend in `scripts/swarms/RUNS.md` |

### While the flag is off

A soul with a `swarm` block is refused as an unknown field (the answer before this build). The
`x-units-seat` header is ignored. Every per-agent limit is what it was. None of the swarm routes
exists and none of the swarm tables is created. The runtime asks Core for `/v1/swarms/config` once a
minute, gets `feature_off`, and keeps every agent solo: the same keys, budgets, attempt order,
desktops and usage records. The coin page and the Explorer ask for no swarm route (they read
`network.features.swarms` from the config they already load); the launch form asks once for
`/v1/swarms/config`, gets a miss and shows no Agents field. Proven by the untouched existing tests,
by `swarms: the flag is off` (Core), `Core's flag off` (runtime), `launch form, swarms off` (web) and
the default run of `tests/ui/swarms.spec.ts` against the mainnet site's live data.

### What differs from sections 1 to 9, and why

- **Core keeps no seat on a candidate row.** The seat is in the runtime's signed provenance record
  only (`record.seat`), which Core already publishes only once the candidate is final. Nothing about
  the hot candidate path changes, and author-blindness needs no new rule.
- **A seat's public state is narrower than section 6 lists.** While it works: its unit and target
  (what its intent and session already say). Its result: its newest FINAL candidate. "No candidate"
  per attempt is not shown, because it would tell a viewer which sessions led to a commit.
- **Credits per seat are asked by the launch form, not enforced by Core's prepay check.** The
  deployed program does not enforce the minimum either; a swarm funded below it runs fewer seats by
  the reserve rule. Core's prepay module (live on mainnet) was not touched.
- **The measured burn line on the Funding step is left out.** Its figure (1.57 USD an hour per seat)
  is from a plan document, not from Core, the chain or a config file. The form shows the credits per
  agent, the total and the screen charge, all from Core.
- **The one repair turn of rule 4 is not built.** A seat's change that no longer merges onto the tip
  plus the stack as they are at commit time ends the attempt without a candidate. The check is a real
  merge (cherry-pick in the attempt's own repository), so it fails only on a true conflict.
- **The lead's planning call runs only for a Claude lead** (the runtime's single-call model client
  routes Claude models only). Another lead model places seats from counts, restricted by the ledger.
  It is made again only when the ledger changed.
- **Roster changes after launch, tweet wording, the bind folded into the launch** stay phase 2 as
  written. Core refuses any change of the block after the first soul version.
- **The pages' switch is the config file's flag.** `UNITS_FEATURE_SWARMS=1` turns the API on for one
  process, but the coin page and the Explorer read `features.swarms` from `GET /v1/config`, which
  shows the file's value.

### Opening on mainnet at size 2 (owner 2026-10-13: at 2 seats, after one test swarm from a throwaway wallet works; nothing here was done)

Corrected by the swarms mainnet open prep lane (2026-10-13) against the deploy kit and the server.

**What the switch is.** Deploy-time, in the instance's chain state file, not an admin call: Core reads
`features.swarms` from the `network.json` that `scripts/deploy/site-config.ts` writes from the state
file's `network_overrides`, and `POST /v1/admin/swarms/config` answers `feature_off` until the flag is
on. The file is the official deployment's `~/.config/units/mainnet/official/state.json` on the owner's
machine (shipped as `/etc/units-main/state.json`), NOT `config/mainnet/state.json` (the repository's
copy for local reads, which carries no prepay overrides) and NOT the kit's default
`scripts/mainnet/mainnet.json` (the retired test deployment's state: a stage or activate without
`INSTANCE_STATE_FILE` would put it in place of the live one). There is no `code` mode for the mainnet
instance: the modes are `stage`, `activate` and `go`.

**A list of launcher wallets (`swarm.launchers`).** null (the default) opens swarms to every wallet. A
list (at most 64 addresses) opens them to those wallets only: `GET /v1/swarms/config?wallet=<address>`
answers `launch: { restricted, open }` for that wallet (the list is in no public answer, `GET
/v1/config` included); the launch form asks with the connected wallet and shows the Agents field only
when `open`; an agent launched by any other wallet is one agent to Core and to the hosted runtime
whatever its soul declares (the runtime asks Core's `GET /v1/agents/:id/swarm` before it runs seats);
a swarm soul for an agent Core already read as another wallet's is refused (`403 swarm_not_open`). A
soul stored before Core read its launch is taken and decided by the launcher once read. Removing the
list later makes a stored swarm soul of another wallet a swarm from then on (bounded by `max_members`).
The coin page and the Explorer of a launched swarm are public either way; hide a test with
`POST /v1/admin/hidden`.

1. In `~/.config/units/mainnet/official/state.json`, under `network_overrides` (beside `prepay` and
   `guard_max_regression`; top-level keys replace those of `config/network.json`, so both blocks are
   written whole), add
   `"features": { "agent_pools": false, "github_fee_claims": false, "swarms": true }` and
   `"swarm": { "max_members": 2, "seat_desktop_usd_per_h": 0.1656, "seat_desktop_free_seats": 1, "swarm_epoch_max_usd": null, "seat_epoch_max_usd": null, "slot_fairness": "coin", "lead_plan": true, "lead_plan_max_usd": null, "launchers": ["<the test launcher's address>"] }`.
   Keep the two other flags at whatever they are on that day. Without `launchers` the form offers
   several agents to everyone at once.
2. Ship HEAD with the official files (the runbook's `$I` line):
   `O=~/.config/units/mainnet/official; env UNITS_INSTANCE=mainnet WITH_RUNTIME=1 WITH_IDENTITY=1 INSTANCE_STATE_FILE=$O/state.json INSTANCE_PROFILE_FILE=$O/profile.local.json INSTANCE_SIZING_FILE=$O/sizing.json scripts/deploy/instance.sh 157.245.71.188 activate`,
   then the capacity host's usual `provision.sh ... update`. Core, the runtime and the app come from
   the same release; the runtime follows Core's flag within a minute, the pages read it on load. The
   deploy log prints `network.json: features swarms on (largest swarm 2)`.
3. Check: `GET /v1/swarms/config?wallet=<the test launcher>` answers `enabled: true`, `max_members 2`,
   `launch: { restricted: true, open: true }`, `min_usd_per_seat` equal to `prepay.min_usd`; the same
   route without a wallet answers `open: false`, `max_now 1`; the runtime log says `swarms: on`. Then
   `bun scripts/swarms/mainnet-test.ts` (simulate only: the whole swarm launch up to the signing
   prompt, with the page's exact total), `--send`, and `--phase checks` until nothing waits.
4. Open to everyone, no deploy: `POST /v1/admin/swarms/config { "launchers": null }` with the admin
   key. Later, to 4: `{ "max_members": 4 }` the same way. The admin's patch is kept in Core's database
   over the file's block; put the same values into the state file with the next release.
5. To close again: set `swarms` false and ship. Swarms already launched keep their soul; the runtime
   runs each as a solo agent on seat 1's model from the next attempt.

Capacity to look at first: every seat takes one of the runtime's `e2b_max` desktops (50 on the
official instance) and one attempt slot; the form offers only as many seats as the runtime reports
free.

Read on the instance, 2026-10-13: the on-chain sleep and wake thresholds are amounts of the quote coin
(14,400 and 28,800 UNITS), about 3.4 and 6.8 USD at that day's price. A swarm's vault below the sleep
threshold is asleep, and with network compute on (`platform_funding`) only its first seat works then,
one attempt per interval, with the vault not charged; seats 2 and up rest with "Paused: vault low" and
their screens pause. With `desktop_idle_pause` false a funded swarm's second screen runs, and is
charged, all the time the swarm is awake, working or not (0.1656 USD an hour, 3.97 USD a day).

### The local proof (scripts/swarms/proof.ts, 2026-10-13)

A local simulated Core with the flag on, a reference runner and two bonded verifiers replaying in real
sandboxes, the two units of keis/base58 (`base58-py`, `base58-py-heavy`), one hosted TEST agent whose
signed soul declares three seats (Claude Sonnet 5.5 as lead, Claude Haiku 4.5, GPT-5 mini), bound with
one key rotation. Every model call went through OpenRouter. Figures are the runs' own
(`scripts/swarms/PROOF-RUN1.json`, `PROOF-RUN2-DESKTOPS.json`, `RUNS.md`).

| | Run 1 (80 minutes, vault 4.6 USD) | Run 2 (30 minutes, one real E2B desktop per seat) |
|---|---|---|
| Checks | 22 of 23 | 25 of 27 |
| Candidates | 23: 22 accepted, 1 rejected `no_improvement`, 0 `stale` or `stale_conflict` | 8: 8 accepted, 0 stale |
| Accepted by seat | seat 1: 15 of 16 final; seat 2: 6 of 6; seat 3: 1 of 1 | seat 1: 7 of 7; seat 3: 1 of 1 |
| Candidates committed beside an open one of the swarm on their unit | 2, both stacked on it | 0 |
| Model spend, as metered | 3.4584 USD (seat 1 1.7781, seat 2 1.3485, seat 3 0.3318) | 1.0690 USD (0.8218, 0.2131, 0.0341) |
| Vault debits | 8 records, one per usage epoch; the seats' lines add up to each | 3 records, the same |
| Shrink | seat 3 paused at 2 of 3 seats, then seat 2 at 1 of 3; lower seats kept working | the same, and each paused seat's desktop paused with "Paused: vault low" |
| Screens | none (no desktop service in this run) | three E2B desktops under the one agent; seat 1 keeps the agent's stream id; seat 2 charged 829 s = 0.0381 USD, seat 3 267 s = 0.0123 USD at 0.1656 USD an hour, seat 1 nothing; all three removed at the end |

The checks that did not pass, and why:

- Run 1, "then the agent sleeps": the run reached its 80 minute limit with 14.36 UNITS still in the
  vault, so the agent was still awake. The script now logs this instead of checking it.
- Run 2 was started with a vault that carried only two seats (1.3 USD against 0.53 USD per seat
  reservation), so 12 UNITS of test fees were added to the vault by hand three seconds after the bind.
  Two checks compare against the vault at launch and so failed: "the vault paid exactly the posted
  amounts" (26 UNITS at launch plus the 12 added, less the 13.50792 left, is the 24.49208 debited, to
  the base unit) and "a low vault shrinks ... while lower seats keep working" (seat 3 was paused at
  the start, then started after the deposit, which is the swarm growing back when the vault is
  funded).

Run 3 (2026-10-13 12:11 UTC, 30 minutes, vault 2.4 USD, no desktops, with the launcher list in the
tree and none set): 22 of 22 checks, 10 candidates, 10 accepted, none stale, 1.3340 USD of model spend
(seat 1 0.5791, seat 2 0.7110, seat 3 0.0439), 4 vault debits (`scripts/swarms/PROOF-LAST.json`).

Not proven: the live video of a seat in the Computers view (the proof's runtime served no stream
port; the page showed each seat's state in words), anything on devnet or mainnet, a swarm of 4, and
the wizard's launch transaction with a swarm soul (the form was checked up to Review, nothing signed).
