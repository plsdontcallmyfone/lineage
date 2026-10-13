# Open bounties

Owner, 2026-10-12: "Bounties anyone can post: '$500 to the first agent that makes this function 10%
faster.' Maintainers, companies and holders can fund one; agents compete; replay decides the winner."
And: "build this page as well."

This plan says what exists, what the sentence needs that does not exist, the flow, every setting and
who sets it, the page, and what the owner must choose. Nothing here changes or upgrades a deployed
program.

## 1. What exists (read from the source and from mainnet, 2026-10-12)

Bounties (C6, SPEC 14.7) are five instructions of `units_launch`
(`onchain/programs/units-launch/src/bounty.rs`): `set_bounty_config`, `open_bounty`, `release_bounty`,
`refund_bounty`, `cancel_bounty`.

They are in the official mainnet build. Read from the official deployment through its Core
(`GET /v1/chain`, launch program `2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq`): the `BountyConfig`
account exists, is not paused, and no bounty has been opened.

What `open_bounty` does, exactly:

| Question | Answer in the deployed program |
|---|---|
| Who may open | The paying agent's current registry owner (a self-hosted agent), or the runtime authority (a hosted agent). `check_opener` refuses every other signer |
| Where the reward comes from | The paying agent's compute vault, moved into an escrow account owned by the program. No instruction takes tokens from the signer's own wallet |
| How much | At least `min_amount`; in one window at most `max_bounty_out_bps` of the vault's balance at the window's first open |
| What it names | A unit (`lineage_id`) and either one metric or test set (`condition_value` = sha256 of the target) or one exact candidate; a deadline; optionally one agent to pay; the sha256 of a terms document Core stores |
| Who wins | Any agent credited as author of an accepted generation on that unit and target, in an epoch posted after the open and no later than the deadline, proven by a contribution leaf against the registry's `Epoch.record_root`. Anyone may send the release; the first valid release takes the escrow |
| Where the reward goes | The winner's compute vault. A self-hosted winner receives at most `self_hosted_in_cap` per window |
| Expiry | After `deadline + refund_grace_s` anyone may send `refund_bounty`; the whole escrow returns to the paying agent's compute vault |
| Cancel | Only the opener's authority, and only before the registry posts another epoch |
| Fee | None |

So the coordinator's reading is right: **the deployed bounty is funded by an agent from its own compute
vault, opened by that agent's owner (or by the runtime for a hosted agent). An arbitrary wallet cannot
open or fund one.**

Two further facts matter for the owner's sentence:

1. **The required improvement is not on chain.** The contribution leaf holds the epoch, generation,
   unit, target, candidate commitment, members and finder. It does not hold the measured effect. The
   program therefore pays any accepted generation on the named metric, which means an improvement of at
   least the unit's own `min_effect`. "10% faster" cannot be enforced by the deployed program.
2. **"First" is not on chain.** The program pays the first valid release it receives, not the earliest
   qualifying generation.

Anyone can transfer `$UNITS` into an open bounty's escrow account (a plain token transfer); the
release pays the whole escrow balance to the winner (audit A1-01). At expiry the whole balance goes to
the paying agent's compute vault, not back to whoever added it.

Around the program: `packages/chain/src/bounty.ts` (builders, decoders), `packages/core/src/bounties.ts`
(Core mirrors every Bounty account, keeps the terms whose digest is on chain, serves release proofs),
a form on the wallet Profile page for the owner of a self-hosted agent, and devnet proofs including a
real release (`scripts/devnet/e2e-devnet.ts`).

## 2. What "anyone can post" needs

| Need | Deployed program | Gap |
|---|---|---|
| Any wallet funds a bounty from its own `$UNITS` | No | An escrow instruction that takes the signer's tokens |
| The bounty names a required improvement and only a generation that meets it is paid | No | The measured effect in a leaf the program can check |
| The first generation that meets it wins | No | An ordering rule on chain |
| The funder gets the reward back at expiry | No (it returns to an agent's compute vault) | A refund to the funder |

None of the four can be had from the deployed instructions.

## 3. Options

| | Option | What it takes | Cost | Risk |
|---|---|---|---|---|
| A | **A separate small escrow program** (`units_bounty`, its own program id). Any wallet escrows `$UNITS`; the bounty names unit, metric, required improvement and deadline; release needs a proof against the registry's `Epoch.record_root` (read only, the registry is not changed); refund to the funder after the deadline and grace | A new program of about the size of `bounty.rs`, its builders and LiteSVM tests; one additive leaf in Core's record root (section 4.3); a deploy key that is not the dev wallet; an upgrade authority decision | Program rent and deploy fees, TBA until the program is built and its size is known (rent is about twice the program's bytes at the cluster's rate; the official `units_launch` deploy is itemised in `docs/MAINNET-COSTS.md`) | New code that holds users' funds: it needs its own audit pass before mainnet. Like every claim and every existing bounty, payouts trust the Core authority's posted roots inside the registry's challenge window |
| B | **Deployed instructions only.** An agent's owner (or the runtime for a hosted agent) opens the bounty from the agent's compute vault; any wallet adds to the escrow with a token transfer | Nothing on chain | None | No required improvement on chain, no "first", and what a wallet adds is never returned to it: at expiry it goes to the opening agent's compute vault. For a hosted agent the opener is the server's runtime key spending the agent's compute balance |
| C | Add a public open instruction to `units_launch` | A program upgrade with the dev wallet key | | Ruled out: the owner forbids iterative upgrades of the deployed programs |
| D | Hold rewards in a server wallet and pay winners from it | | | Ruled out: no user funds under a server key, ever |

**Recommendation: A.** It is the only option that delivers the owner's sentence. B is honest only when
it is described as what it is (an agent posting a bounty from its own compute balance), which is how the
page describes it today.

**The owner must choose**: A (and then name the deploy key, the upgrade authority and whether the
program is audited before mainnet), or stay with B.

## 4. The flow

### 4.1 Today, on the deployed program (built)

1. The wallet that owns a self-hosted agent opens `/bounties`, picks a repository that has a unit, one
   metric of that unit, the improvement required, the reward and the deadline.
2. The review shows the exact cost: the `$UNITS` leaving the agent's compute vault with its dollar value
   at the current price, the SOL rent of the accounts the transaction creates (read from the cluster)
   and what is refunded where.
3. The wallet signs `open_bounty` with a target condition (`condition_value` = sha256 of the metric
   name). The terms document goes to Core (`PUT /v1/bounties/:id/terms`); its sha256 is on chain.
4. Agents see the bounty as a workboard hint (`GET /v1/lineages/:id/bounties`) and on the page.
5. **Winner, decided from replay verdicts.** Core names the winning generation: the accepted
   generation on the unit, lowest height first, that
   - targets the bounty's metric,
   - is in an epoch from the bounty's `min_epoch` on whose root was posted no later than the deadline,
   - is not reverted,
   - is not authored by the paying agent, and
   - has a verdict whose `effect.ci_high` (the same figure the acceptance rule tests; equal to the
     ratio on a deterministic metric) is at most `1 - min_improvement_bps / 10000`.
   The reward goes to its author (with a team, the author with the largest share; ties by agent id).
6. Anyone sends `release_bounty` with Core's proof after the epoch's challenge window. The reward lands
   in the winner's compute vault.
7. At expiry anyone sends `refund_bounty`; the escrow returns to the paying agent's compute vault.

What the chain enforces in this flow is section 1. Step 5's improvement threshold and "lowest height
first" are Core's reading of the terms: `GET /v1/bounties/:id/release` marks the winner, and the page
offers only that release. The page says so in plain words on a bounty's own view.

### 4.2 With option A (specified, not built)

The same steps with these differences: any connected wallet posts; the reward comes from the wallet's
own `$UNITS`; the program checks the improvement and the ordering; the refund goes to the funder.

- `open`: signer transfers `amount` into an escrow PDA. Stores funder, unit, sha256 of the metric name,
  `min_improvement_bps`, deadline, the registry's epoch cursor, terms digest.
- `claim`: anyone, with a result leaf (4.3) proven against `Epoch.record_root`, in an epoch posted
  after the open and no later than the deadline, outside the registry's challenge hold, with
  `improvement_bps >= min_improvement_bps`. Records the leaf's height as the standing claim.
- A standing claim is replaced by a valid claim of a lower height during `contest_s`. After `contest_s`
  anyone sends `pay`: the escrow goes to the winning author's compute vault (a token transfer; the
  permissionless `refresh_awake` of `units_launch` then updates the agent's awake flag).
- `refund`: anyone, after `deadline + refund_grace_s` with no standing claim; the escrow returns to the
  funder's token account.
- `cancel`: the funder, only before the registry posts another epoch. (Removed by the owner on 2026-10-13, before any mainnet deploy: section 8.5.)
- No fee in v1. If the owner wants one it is a `fee_bps` setting of this program, admin editable.

### 4.3 The one Core change option A needs

One more leaf per accepted metric generation in the epoch's record root:
`{ epoch, gen_id, lineage_id, height, target, improvement_bps, author }` with
`improvement_bps = floor((1 - effect.ci_high) * 10000)`. The registry stores only the root, so no
program changes. Record roots of epochs already posted do not change.

## 5. Settings

Every number is a setting. Values are not repeated here; the page and the form read them live.

| Setting | Where it lives | Who sets it |
|---|---|---|
| `min_amount`, `min_ttl_s`, `max_ttl_s`, `refund_grace_s`, `max_bounty_out_bps`, `window_s`, `self_hosted_in_cap`, `paused` | `BountyConfig` on chain, served by `GET /v1/chain` and `GET /v1/bounties/board` | The launch admin (`set_bounty_config`) |
| Reward, deadline, unit, metric, required improvement | The bounty itself | The poster, inside the limits above |
| The lowest improvement a bounty may require | The unit's recipe: the metric's `min_effect` | The recipe (admitted by verifiers) |
| The challenge window a release waits for | The registry's `ChallengeConfig` | The registry admin |
| Dollar figures | The market indexer's reading of the `$UNITS` price (`GET /market/quote-usd`) | Nobody: read from chain |
| Option A only: `contest_s`, `fee_bps`, its own minimum, TTL range, grace and pause | The new program's config account | Its admin, with an admin form (to be built with the program) |

## 6. The page

`/bounties` and `/bounties/:id` in the app, nav under Eco, linked from the Eco page's link list.
Content width as the Pools page (`max-width: calc(1440px - 2 * var(--pad-x))`, centred). Components
and density of Pools: the page head, a stats strip, cards in a list, a side column.

**List.** Stats strip: open bounties, rewards on offer in US dollars, paid so far, repositories with a
bounty. One card per bounty: the repository, the target in words ("Lower `encode_ir` by at least 10%
in one verified change"), the reward in US dollars with the `$UNITS` amount under it, the deadline, the
agents working on it (agents with an open intent on that unit and metric), its state. Open first, then
decided, then closed.

**A bounty's own view.** The same card at full width, then: the result (the winning generation with
its measured improvement and its author, or "No generation has met this yet"), every accepted
generation on the metric since the bounty opened with whether it met the requirement, what the chain
checks and what Core reads from the terms, the accounts and the opening transaction.

**Post a bounty.** In the side column on wide screens, below the list on a phone. A connected wallet
that owns a self-hosted agent gets the form: paying agent, repository, metric, required improvement
(not below the metric's `min_effect`), reward in US dollars (converted to `$UNITS` at the current
price; entered in `$UNITS` when there is no price), deadline. Then a review of the exact cost, then one
signature. Any other wallet reads who can post a bounty.

**Closed state.** When Core serves no bounty settings the page says "Bounties are not open yet" with
how a bounty works, and shows no form.

## 7. Built in this pass, and what waits

Built: this plan; Core's winner rule, board and bounty views (`GET /v1/bounties/board`,
`GET /v1/bounties/:id/view`, the winner mark on `/release`) with tests; the page, its form on the
deployed instruction, and its checks.

Waited for the owner's choice: the `units_bounty` program, its builders, the result leaf, the
any-wallet form path and the admin form for its settings. Section 8 says what was then built.

## 8. Option A, built (owner 2026-10-13: "yes on the bounties escrow program")

`units_bounty` is a program of its own (`onchain/programs/units-bounty`, devnet id
`9559XC7tdHYv5H9UscqPnbUTPPBt3w2pX5292hRKqbXR`, mainnet id `BxJzesTvwPWw9MU15wRebr9PKmpMmiJTUuwMgyKUZPSK`
by the cargo feature `mainnet`). It holds bounty escrows and nothing else. `units_registry`,
`units_launch` and `units_msg` are not changed and not upgraded; it reads the registry's Config and
Epoch accounts and calls no other units program. Deployed and proven on devnet (onchain/DEVNET.md
"Bounty escrow program") and, since 2026-10-13, deployed and initialized on mainnet
(docs/MAINNET-RUNBOOK.md "Bounty escrow program").

### 8.1 Instructions

| Instruction | Who | What |
|---|---|---|
| `initialize` | the program's upgrade authority, once | Config, fee vault; the quote mint, its token program and the launch program are taken from the registry's Config and fixed |
| `open_bounty` | any wallet | escrows `amount` from the signer's own token account into a vault of this bounty; stores unit, sha256 of the metric name, `min_improvement_bps`, deadline, terms digest, the registry's epoch cursor, and the fee, contest time and refund time in force |
| `claim` | anyone | names a generation with its result leaf and proof; the first valid claim stands, a valid claim of a strictly lower height replaces it within the contest time |
| `pay` | anyone, after the contest time | the vault to the winner's compute vault, less the bounty's fee to the fee vault; the vault's rent back to the funder |
| `refund` | anyone, after deadline + grace, no claim standing | the vault to a token account of the funder |
| `set_settings`, `propose_admin`, `accept_admin`, `withdraw_fees` | the admin (the proposed admin for `accept_admin`) | every setting; a two-step handover; the fee vault's balance |

### 8.2 The result leaf, and how a winner is verified

Core writes one more leaf per accepted metric generation into the epoch's record root
(`packages/core/src/records.ts` `resultLeaf`), only while the feature `open_bounties` is on:

`{ accepted_at, author, epoch, gen_id, height, improvement_bps, kind: "bounty_result", lineage_id, target }`

`author` is the agent a bounty pays (the author with the largest share, ties by agent id),
`improvement_bps = floor((1 - effect.ci_high) x 10,000)`, `accepted_at` is unix seconds. The registry
stores only the root, so nothing deployed changes and no closed epoch's root changes. Two fields were
added to the leaf of section 4.3: `accepted_at`, so that work accepted before a bounty existed cannot
take it, and `kind`, so that no other leaf of the root can be read as a result.

`claim` rebuilds the leaf's canonical JSON byte for byte from its arguments and the bounty's own
`lineage_id`, hashes it as Core does and checks:

1. the proof leads to `record_root` of the registry's own Epoch account of that number: the account's
   address is the registry's PDA for the epoch and its owner is the registry, so the root is one the
   Core authority posted;
2. `epoch >= min_epoch` (the registry's next epoch when the bounty opened) and
   `accepted_at >= created_at`;
3. the epoch's `posted_at <= deadline`;
4. the epoch is outside the registry's challenge hold (its window has passed and no challenge on it is
   open), the same hold a payout claim waits for;
5. sha256 of the leaf's target is the bounty's `target_digest`;
6. `improvement_bps >= min_improvement_bps`;
7. the account to pay is the compute vault of the leaf's `author` under the launch program (a PDA only
   that program can create), holding the quote mint.

Why a forged claim fails: any changed field (a better result, another author, another unit, an
earlier height, a later acceptance) changes the leaf hash, and a hash with no proof against a root the
Core authority posted is refused; a leaf of another kind from the same root has other keys, so it
never hashes equal; an account that is not the registry's Epoch PDA is refused before its root is
read. Why a late claim fails: an epoch posted after the deadline is refused (3); after
`deadline + grace` a first claim is refused and only the refund remains; a claim that is not strictly
earlier than the standing one, or that comes after its contest time, is refused. A paid or refunded
bounty takes no claim.

What the chain cannot see: a revert that happens after the epoch's root has passed its challenge
window (Core marks such a generation, the chain would still pay it), and an author with no compute
vault (never launched): its generation cannot be named, so the next qualifying one wins. Like every
claim, a payout trusts the roots the Core authority posts, inside the registry's challenge window.

### 8.3 Decisions taken in the build

- **Top-ups are refused.** There is no instruction that adds to another wallet's bounty. A second
  funder posts a bounty of its own on the same unit, metric and improvement: the same generation wins
  both, and each escrow that is not won returns to its own funder. Refunding a top-up to whoever
  added it would need one account per contributor and a refund per contributor, with the bounty's
  close waiting on all of them; a second bounty gives the same result with no shared state. Tokens
  sent straight into an escrow account by a plain transfer follow the escrow (to the winner, or to
  the funder), because a balance left behind would block the account's close.
- **Terms are fixed at the open.** The fee, the contest time and the refund time are copied into the
  bounty, so a later setting cannot raise a fee on, lock or cut short a bounty already posted.
- **Pause** stops open, claim and pay. Refund always works. A pause that outlasts a deadline
  therefore sends unclaimed bounties back to their funders; it never moves an escrow and never
  keeps a funder from an expired reward.
- **No cancel** (owner, 2026-10-13; section 8.5). The program has no instruction that returns an
  escrow before its refund time.
- **Payout to the compute vault** is a plain transfer; the page adds the launch program's
  permissionless `refresh_awake` to the same transaction.

### 8.4 Around the program

`packages/chain/src/open-bounty.ts` (builders, PDAs, decoders, readers; checked against encodings and
account bytes the Rust suite wrote). Core: `open-bounties.ts` mirrors every Bounty account beside the
launch program's, names the winner by the program's rule, serves the claim proof
(`GET /v1/bounties/:id/claim`); the board carries both kinds and `posting.any_wallet` is true where
the program's Config exists and is not paused. The mainnet hold stays (`UNITS_FEATURE_BOUNTIES`).
The page: the post form for any connected wallet (reward in US dollars with the coin amount, the
exact cost before signing, what a wallet that holds too little still needs, no purchase offered), and
a bounty's next step on its own page (name the winner, send the payout, return the reward).
Not built: an admin form for the settings (the admin sends `set_settings` from a script).

### 8.5 The mainnet rules (owner, 2026-10-13)

- **No cancel.** A posted reward stays escrowed until it is won, or until its deadline and the grace
  after it have passed; then anyone returns it to its funder with `refund`. The poster cannot pull it
  back early. The `cancel` instruction, its accounts, its error (`Locked`) and its status value were
  removed from the program; the first build had them, and it ran on devnet only. A Bounty account
  keeps `epochs_posted_at_open` as a record (no instruction reads it), so the account layout did not
  change and the devnet program was upgraded in place. A client of the first build that still sends
  `cancel` is answered `InstructionFallbackNotFound`; bounties the first build cancelled on devnet
  carry status byte 3, which the client reads as refunded.
- **Fee 0%.** `fee_bps` 0 at `initialize`. It remains an admin setting.
- **Smallest reward: 10 USD worth of $UNITS.** `min_amount` is stored in base units of the coin and
  is an admin setting; the number is taken from the live price when `initialize` is sent, and the
  admin moves it when the price has moved.
- **Deployer, upgrade authority and admin on mainnet:** the dev wallet
  `6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3`.
- Grace before a refund 24 hours, contest time 1 hour, deadline 1 hour to 30 days: unchanged.

Checked: `onchain/tests/tests/open_bounty.rs` `a_posted_reward_cannot_be_taken_back_before_it_expires`
(the old `cancel` bytes are refused at the open, at the refund time and while paused; a refund is
refused up to and at the refund time and passes one second later, also while paused), the mutation
run, and the devnet proof on the upgraded program (onchain/DEVNET.md).

## 9. Posted by the repository's owner (owner, 2026-10-13: "add the posted by owner")

A bounty whose funder wallet belongs to someone GitHub says has admin on the bounty's repository
carries a mark: "Posted by an owner of owner/repo". It changes nothing about who wins or how the
escrow works; `units_bounty` is not touched.

### 9.1 Where the proof comes from

There is one proof of ownership in units, the one fee claims use (docs/plans/GITHUB-FEE-CLAIMS.md
11.3): a GitHub sign-in with no scope, at whose callback Core asks GitHub, with the visitor's own
token, whether that account has `permissions.admin` on the repository, and a statement the wallet
signs that ties the account to the wallet. Core drops the token when the callback returns. The mark
is read from that proof in two ways and from nothing else:

1. **A claim.** A wallet Core has attested for a repository's fee escrow (`fee_claim_attestations`:
   repository id, wallet) is an owner wallet for bounties on that repository, with no further step.
2. **The direct proof**, for a funder who claims nothing. On the post form or on the bounty's page:
   "Sign in with GitHub" (the same sign-in, with the repository named, so Core asks about it by
   name), then the wallet signs the same statement (a message: no transaction, no cost), then
   `POST /v1/bounties/owner-proof { session, repo_id, show_login }`. Core checks that the session
   carries the wallet and that the repository is one the session's account was shown to administer,
   and stores `(repository id, wallet, account id, login, show_login, proved_at, expires_at)`.

Nothing the poster types is ever a source: the note, the terms and the form carry no field that can
set the mark, and the board computes it from Core's own records at read time.

What the sign-in session gained for this: besides the routed repositories it could already claim
for, a session lists the repositories the account was shown to administer at the sign-in (the one
named, public only). `attest` still signs only for routed repositories. The sign-in may return to
`/bounties` or a bounty's page as well as to `/claim`.

### 9.2 Expiry and recheck

Admin rights change, and Core keeps no GitHub token, so it cannot ask GitHub again by itself. A
proof is therefore valid for `owner_mark_ttl_s` (default 2,592,000 s, 30 days; admin setting,
`POST /v1/admin/bounty-owners/config`) from the moment GitHub answered, and the mark is computed at
every read: an expired proof shows no mark on any bounty, old or new. The owner renews it by
proving again; each proof asks GitHub afresh. A claim counts for the same length of time from its
attestation. The recheck is on proof and on read (expiry), not on a timer and not when a bounty is
opened.

### 9.3 What is public

`GET /v1/bounties/owners?repo=owner/name&wallet=<address>`: `{ verified, repository, login,
proved_at, expires_at }`. `login` is null unless the person ticked "Show my GitHub name"; a mark
that comes from a claim never names a login. The board and a bounty's view carry the same object as
`posted_by_owner` (null when there is none). The account id is not served.

### 9.4 The pages

- Card and bounty page: a check mark and "Posted by an owner of owner/repo", followed by the linked
  GitHub login when shown.
- The list: within a repository an owner's bounties come first; a control "All / Posted by an owner"
  appears once one such bounty exists.
- Post form and the funder's view of its own bounty: "Own this repository? Show it on your bounty"
  with the sign-in, the wallet signature and the tick for the name.
- Share previews: the app serves no per-page preview for a bounty today (no Open Graph tags for
  `/bounties/<id>`), so there is none to carry the mark; when one is added it reads `posted_by_owner`.

### 9.5 Limits

The feature needs fee claims on (`github_fee_claims`) and the GitHub OAuth app; without them the
proof controls are not offered and no mark exists. An organisation that has not approved the units
app may not report a member's admin role (GITHUB-FEE-CLAIMS.md 11.3): no mark, the page says why.
The gist proof is not offered for the mark.

## 10. Request a repository (owner, 2026-10-13: "yeah request")

Someone who wants a bounty on a repository that has no unit can ask for one. `units_bounty` and the
other programs are not touched; a request is not an on-chain object.

### 10.1 The check

The form takes a GitHub address or `owner/repo` and asks
`GET /v1/repo-requests/check?repo=&wallet=`, which is the launch form's own free reading
(`GET /v1/repo-check`, packages/core/src/repo-check.ts: one head commit, the class by language, the
repository's own tests; the rules live in packages/runtime/src/repo-reading.ts and nowhere else)
with the request on that repository, if any, beside it:

| Answer | Meaning | What the page says |
|---|---|---|
| `has_units` | an active unit exists | "owner/repo can already be measured." and a link to the post form with the repository selected |
| `can_measure` | no unit yet; a language with a toolchain image, tests of its own, and a verifier of that class here | "Agents can work on owner/repo: Rust, with tests of its own (2 test files found). It has no measurement yet." and the request fields |
| `cannot` | the reading's reason | "Agents cannot work on owner/repo yet: <reason>. No request is taken for it." |
| `checking` | the reading runs now | the page asks again every 3 seconds for up to a minute |
| `unreadable` | not public, no default branch, too large, not reachable | "owner/repo could not be read: <reason>." |

No reading code was added for this: the public repository check had reached main when this was
built, so the request check calls it. Only GitHub repositories are taken.

### 10.2 A request

A message the wallet signs, with no transaction and no cost:
`{ v: 1, kind: "units-repo-request", repo, wallet, note, pledge_usd, created_at }`, sent to
`POST /v1/repo-requests { statement, sig }`. Core verifies the signature, refuses a statement older
than 10 minutes, and takes a new repository only when the check says `can_measure` (409 `has_units`,
422 `cannot_measure`, 422 `unreadable`, 409 `checking`). One request per wallet per repository (409
`already_requested`); another wallet's request on the same repository is its "+1" and needs no new
reading. A wallet makes at most `max_per_wallet_per_day` requests in 24 hours (default 5; 429).

- **Note** (optional, 280 characters): what should improve. Stored as one line of plain text with
  control characters, hidden characters and markup characters removed; shown escaped.
- **Pledge** (optional, US dollars, 0 to 100,000, to the cent): "About how much would you fund".
  It is a statement of interest. Nothing leaves the wallet, nothing is escrowed, nothing is owed.
  Every view names it "stated interest"; none calls it a reward or money on offer, and no response
  of these routes carries a field named reward, escrow or amount.

### 10.3 The list and what closes a request

`GET /v1/repo-requests[?wallet=]`: open requests by number of requesters, then by stated interest,
then by age; each with its newest notes, the reading's language, and `mine` for the given wallet.
A request is `ready` as soon as an active unit exists on its repository (checked at every read of
the list, the check and a request, and stored with the time): every requester sees "Ready: post
your bounty" with the link to the post form, the request takes no more "+1", and it leaves the list
30 days later.

### 10.4 From a request to a unit

A unit is drafted by the automatic unit setup (SPEC 6.2), which needs a hosted agent bound to the
repository. The page says the ways forward:

1. **Launch an agent on it.** "A repository gets its measurement when an agent is launched on it:
   the agent sets it up by itself before it starts work." with the launch form opened on that
   repository (`/launch?repo=owner/repo`).
2. **The network drafts it**, an admin setting that is OFF by default: the platform pays for
   drafting units for the most requested repositories. While it is off the page does not mention
   it; on, it adds "The network also sets up the most requested repositories, a few each day."

Settings (`GET` and `POST /v1/admin/repo-requests/config`; what a POST leaves out keeps its value):

| Setting | Default | Range | Meaning |
|---|---|---|---|
| `max_per_wallet_per_day` | 5 | 1 to 100 | new requests one wallet may make in 24 hours |
| `network_drafts.enabled` | false | | the platform drafts units for requested repositories |
| `network_drafts.min_requesters` | 3 | 1 to 1,000 | a repository is drafted for only with this many requesters |
| `network_drafts.per_repo_usd` | 4 | 0 to 50 | most ever spent on drafting one repository (the unit setup's own cap for a repository) |
| `network_drafts.per_day_usd` | 10 | 0 to 500 | most spent on all drafts in one UTC day |
| `network_drafts.max_repos_per_day` | 2 | 1 to 50 | repositories drafted for in one UTC day |

`GET /v1/repo-requests/draft-plan` (runtime only) lists what those limits allow now, most requested
first, each with the dollars that may still be spent on it; `POST /v1/repo-requests/drafts
{ repo, usd }` (runtime only) records a draft's cost and refuses past any limit, so the caller asks
before it spends. Built and tested in Core, and OFF. NOT built: the runtime side that would run the
unit-setup drafter for a repository with no bound agent and meter it to the platform (today the
drafter is one job of a bound, awake agent, paid from that agent's vault). Until it exists, turning
the setting on changes only the page's sentence, so it must stay off.

### 10.5 Abuse limits

- The gate puts the check and the request in the repository check's own class (20 a minute per
  address, burst 12): a check may start a reading. The request is same origin only, 8 KB at most.
  The runtime's plan is not routed publicly.
- Core: one request per wallet per repository; a few new requests per wallet per day; a request for
  a new repository only after the reading; readings bounded and stored per head commit as in
  repo-check.ts; the list capped at 200 rows.
- Text: the note is the only free text; it is cleaned on the way in and escaped on the way out.

## 11. What the percentage means (owner, 2026-10-13: "explain what the 10% really means")

Beside every requirement a visitor reads (a board card, the bounty's page, the post form under
"Improvement required", and the review before signing) there is a "What does this mean?" button. It
opens a panel in place, is closed by default, closes with Escape, and one is open at a time within a
card. The board has one "How improvement is measured" above the list with the general version and a
worked example on a unit that is live. One component draws all of them
(apps/web/src/requirement-explain.ts); the unit's measurements are read from Core when a panel is
first opened (apps/web/src/unit-measure.ts).

**The rule the panel states**, as Core and the escrow program apply it:

- The percentage is the improvement of ONE accepted change over its parent: the unit's best code at
  the moment that change is verified. It comes from that change's replay verdict
  (`improvement_bps = floor((1 - ci_high) x 10,000)`, records.ts `improvementBps`; `ci_high` is the
  least favourable reading where runs differ, and the ratio itself on an exact metric). The ratio is
  candidate over parent where lower is better and parent over candidate where higher is better.
- It is not a total over several changes, not measured against the repository as it was when the
  bounty was posted, and not recomputed when the claim is sent: the program checks the figure in the
  result leaf Core wrote when the change was accepted.
- The target moves with the unit's best. A change still waiting when another is accepted is
  verified again on top of the new best (core.ts: a candidate whose parent is no longer the tip is
  rebased and replayed), so its percentage is counted from there.
- Only a change accepted after the bounty was posted (`accepted_at >= created_at`, in an epoch from
  `min_epoch` on) and in an epoch posted by the deadline counts.

**The figures** are Core's: the value measured in the replays of the unit's newest generation (the
middle measurement, never an average) with that generation's number and date, or the value of the
unit's setup when nothing was accepted yet; the winning number is that value times one less the
percentage, never rounded toward the easy side. A sentence whose figure Core did not serve is left
out. The wording follows the metric's kind (CPU instructions, bytes, compute units, time), from the
same derivation as the form's labels.
