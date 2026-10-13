# GitHub fee routing and the Claim page

**2026-10-12, owner decision: the recipient is the repository the agent works on, claimed by anyone with admin on it, at one fixed share. Section 11 is current; where sections 1 to 9 say "GitHub account", slider or username, section 11 replaces them.**

Status: LIVE ON DEVNET since 2026-10-12 (owner: "put up the two pages"): chain bit, Core and profile flags on
for devnet, /claim linked from the Eco page, proof by public gist (no OAuth app yet; the callback is
`https://<site>/v1/fee-claims/oauth/callback`, which follows from UNITS_SITE_URL). Off on mainnet.
Built and proven on devnet by the pools and claims lane (results in section 10). Owner request 2026-10-11. Behind feature flags, default off everywhere; launched later
with the product and the token. Devnet only.
Companion: `docs/plans/AGENT-POOLS.md` (the other slice of the same fee crank).

Every number below is a TEST value for devnet unless it says otherwise; launch values are TBA.

## 1. What it does

At launch the launcher moves a slider from 10% to 30% and names a GitHub account. That share of
the agent's creator-fee income then accrues on chain in an escrow keyed by the account's numeric
GitHub id. The GitHub user proves the account on `/claim`, binds a Solana wallet and claims.
The launcher can redirect future fees after a delay; nobody can take back what already accrued.

## 2. Flags

| Flag | Where | Default | Effect when off |
|---|---|---|---|
| `LaunchConfig.features` bit 1 (`FEATURE_GITHUB_FEES` = 2) | on chain, admin `set_features` | 0 | `set_fee_route` refused; `crank_pump_fees` ignores routes and splits exactly as today. Claims of fees that accrued while it was on still work |
| `ClaimConfig.paused` | on chain, admin `set_claim_config` | false | when true: no claim and no route change; accrual continues |
| `features.github_fee_claims` | `config/network.json` (Core), env `UNITS_FEATURE_GITHUB_FEE_CLAIMS=1` for one process | false | Core serves no claim route (404 `feature_off`) and signs no attestation |
| `features.github_fee_claims` | `config/profile.json`, both network blocks | false | no slider in the wizard, no `/claim` page, no profile line |

## 3. Decisions

**D1. Whose income.** The slice is taken from the agent's share of a crank (after the protocol
share, which is unchanged): `to_github = floor(agent_share x bps / 10,000)` (AGENT-POOLS.md D3 has
the whole formula). "10% to 30%" is therefore of what the agent would otherwise keep for compute.

**D2. Bounds.** `ClaimConfig.min_bps` 1000 and `max_bps` 3000 (the owner's 10% to 30%),
admin-editable; the program caps `max_bps` at 5,000. A route keeps the bps it was set with when
the admin later moves the bounds: the bounds apply to new routes and changes.

**D3. Keyed by the numeric id.** The escrow is `["gh_escrow", github_id as u64 LE]`; a login can
be renamed or reassigned, an id cannot. Core resolves login to id once, at the wizard's lookup,
and shows the current login beside the id afterwards. The program never sees a login.

**D4. Changing the recipient: a timelock.** The agent's current registry owner (the launcher until
an owner transfer, as for compute withdrawals, audit A1-03) calls `set_fee_route` again; this only
records a pending route (id, bps) that takes effect `change_delay_s` later through the
permissionless `apply_fee_route`. A newer pending route replaces the pending one and restarts the
delay. Why a timelock and not a cooldown: a cooldown limits how often the route moves but lets the
first move happen without notice; the delay gives the recipient a public, onchain notice before
their share stops, and makes a promise made at launch hold for at least the delay.
TEST value 600 s on devnet; recommended launch value 7 days (owner decides, Q1). A route cannot be
removed, only redirected (Q2).

**D5. No clawback.** Fees leave the creator account for the escrow's token account
`["gh_vault", github_id]` inside the crank. The only instruction that moves an escrow is
`claim_github_fees`, and it pays only the wallet a valid attestation names. Redirecting a route
does not touch the old escrow.

**D6. Proof of the GitHub account, two ways.**
- OAuth: "Sign in with GitHub" through a units GitHub OAuth app (scope: none, read-only public
  identity). Core exchanges the code and reads `GET /user` for the numeric id. The owner must
  create the app (section 8); until then, and in tests, Core runs against a mock provider
  (`scripts/claims/mock-github.ts`) that speaks the same three endpoints.
- Gist (no OAuth, the `links.ts` pattern): the claimant signs the statement below with the wallet
  and posts it in a public gist; Core reads the gist through the GitHub API, takes the owner's
  numeric id and verifies the wallet's signature.

```
statement = { v: 1, kind: "units-fee-claim", github_login, wallet, created_at }
text      = statementDigest("fee-claim", statement)        (what the wallet's signMessage signs)
```

With OAuth the wallet signs the same statement and posts it to Core instead of into a gist. Either
way the binding (GitHub id, wallet) is proven by both sides: GitHub says who the user is, the
wallet's signature says the wallet agrees. `created_at` must be within 24 hours of the proof.

**D7. Claim authorization: a Core-signed attestation the program checks.** Core's attestor key
(`ClaimConfig.attestor`) signs, with ed25519, exactly:

```
"units-github-claim-v1" | launch program id (32) | github_id u64 LE | wallet (32) | ceiling u64 LE | claim_seq u64 LE | expires_at i64 LE
```

The claim transaction carries Solana's Ed25519 precompile instruction over that message, then
`claim_github_fees`; the program reads the instructions sysvar and requires an Ed25519 instruction
whose public key is the attestor, whose message is byte-for-byte the one it rebuilds from its own
arguments and accounts, and whose three data offsets all point into that same instruction (the
known offset-substitution hole). The claim then pays `min(ceiling, escrow balance)` to a token
account owned by the wallet.
- Bound per claim: the message names the GitHub id, the wallet, the amount ceiling and the
  escrow's `claim_seq`.
- Replay-proof: `claim_seq` increases with every use, so a used attestation never verifies again;
  an attestation for another escrow, wallet or program does not match the message.
- Short-lived: `expires_at` must be in the future and at most `max_attestation_ttl_s` ahead (TEST
  600 s), so the attestor cannot mint standing permissions.
- Wallet pin: the first claim pins the wallet in the escrow. A later attestation naming another
  wallet does not pay: it starts a rebind that takes effect `rebind_delay_s` later (TEST 120 s;
  recommended launch value 24 hours) on the next claim for that wallet.

**D8. The trust, stated plainly.** Core's attestor can attest: a stolen or dishonest attestor key
can claim any escrow that never claimed, and can start a rebind on the others (visible on chain
for the delay). It cannot exceed an escrow's balance, reuse an attestation, or act while the admin
has paused claims. The admin rotates the attestor with `set_claim_config`. The attestor should be
a dedicated key, not Core's epoch authority. A proof that removes this trust (GitHub-signed OIDC
tokens verified on chain) is not practical today: GitHub issues OIDC tokens to Actions workflows,
not to user logins.

**D9. Unclaimed balances keep accruing.** An attestation's ceiling is the balance Core read when
it signed; fees that arrive later need the next attestation. There is no expiry on an escrow.

## 4. Onchain (`units_launch`, `src/claim.rs`)

| Account | Seeds | Contents |
|---|---|---|
| `ClaimConfig` | `["claim_config"]` | attestor, `min_bps`, `max_bps`, `change_delay_s`, `rebind_delay_s`, `max_attestation_ttl_s`, `paused` |
| `FeeRoute` | `["fee_route", agent]` | agent, GitHub id, bps, set time, pending id / bps / effective time, accrued to the current id, accrued in total, changes |
| `ClaimEscrow` | `["gh_escrow", id]` | GitHub id, pinned wallet, pending wallet and time, accrued, claimed, `claim_seq` |
| escrow vault | `["gh_vault", id]` | $UNITS token account owned by the launch authority PDA |

Instructions: `set_claim_config` (launch admin), `set_fee_route(github_id, bps)` (the agent's
registry owner; immediate the first time, pending afterwards), `apply_fee_route` (anyone, after the
delay), the GitHub slice inside `crank_pump_fees`, `claim_github_fees(ceiling, expires_at)` (the
wallet signs). Events: `FeeRouteSet`, `FeeRoutePending`, `FeesRouted`, `GithubFeesClaimed`,
`ClaimWalletPending`.

## 5. Core (`packages/core/src/fee-claims.ts`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/github/users/:login` | none | id, login, name, avatar for the wizard's lookup (cached) |
| `GET /v1/agents/:id/fee-route` | none | the agent's route from chain: id, login, bps, pending change, accrued |
| `GET /v1/fee-claims/recipients/:github_id` | none | escrow from chain (accrued, claimed, claimable, pinned wallet) and per-agent accruals |
| `GET /v1/fee-claims/recipients?login=` | none | the same by login |
| `GET /v1/fee-claims/oauth/start?wallet=` | none | redirects to the provider; `state` is single use |
| `GET /v1/fee-claims/oauth/callback` | none | exchanges the code, issues a 15 minute session |
| `POST /v1/fee-claims/proofs/gist` | none | `{ gist_url }`: verifies the gist, issues a session bound to its wallet |
| `POST /v1/fee-claims/wallet` | session | `{ statement, sig }`: binds the wallet for an OAuth session |
| `POST /v1/fee-claims/attest` | session | returns the attestation (message fields, signature, attestor) for the bound wallet |
| `GET /v1/fee-claims/claims?github_id=` | none | claim history |

Core never holds a GitHub token after the callback returns and stores no OAuth token. Sessions are
HMAC tokens (id, login, method, wallet, expiry) under a secret kept in Core's database.

## 6. Indexer and pages

- Indexer: `FeeRouteSet`, `FeeRoutePending`, `FeesRouted`, `GithubFeesClaimed` into tables with
  `/market/fee-routes` and `/market/fee-claims`.
- Wizard: slider (bounds from chain) and recipient field with a username lookup showing the
  avatar; default suggestion the target repository's owner.
- Agent profile: "X% of fees go to @user".
- `/claim`: sign in with GitHub or paste a gist, connect a wallet, sign the statement, see accrued
  and claimable per agent, claim. Self-contained module `apps/web/src/pages/claim.ts`.
- Notifications are out of scope.

## 7. Attack tests (LiteSVM, red on the old build, green on the new)

Spoofed attestation (another signer; a valid signature placed with offsets into another
instruction; a message that differs in any field), wrong GitHub id, double claim, replay after a
later claim, expired and too-long-lived attestations, another wallet (pin and rebind delay), a
crank with another agent's route, another id's escrow or vault, route changes by a non-owner,
out-of-bounds bps, a pending route applied early, no clawback through a route change, and with the
flag off: identical splits to today and `set_fee_route` refused.

## 8. What the owner must provide

1. A GitHub OAuth app owned by the units GitHub organisation (Settings, Developer settings, OAuth
   Apps, New): Homepage URL the site, Authorization callback URL
   `https://<site>/v1/fee-claims/oauth/callback` (the gate sends /v1 to Core). Then on the server, mode 600:
   `UNITS_GITHUB_OAUTH_CLIENT_ID` and `UNITS_GITHUB_OAUTH_CLIENT_SECRET` in Core's env file.
2. The launch values of `change_delay_s`, `rebind_delay_s`, the bounds, and whether a route is
   mandatory at launch.
3. A dedicated attestor key for mainnet (generated on the server, never in the repo).

## 9. Open questions for the owner

- Q1. `change_delay_s` at launch (recommended 7 days) and `rebind_delay_s` (recommended 24 hours).
- Q2. May a launcher remove a route entirely after the delay, or only redirect it (as built)?
- Q3. Is a route mandatory at launch when the feature is on (as built: optional on chain, the
  wizard preselects the repository owner at the minimum)?
- Q4. Organisation-owned repositories: the default suggestion is the organisation account, which
  cannot sign in or post a gist as a user. As built the launcher picks any user; an org-admin proof
  is not built.
- Q5. Unclaimed escrows: forever (as built), or returned to the agent's compute after a long expiry?

## 10. Results (2026-10-12)

- **Program.** `units_launch` `src/claim.rs` (389 lines) and the GitHub slice in `crank_pump_fees`.
  LiteSVM: 8 tests (`onchain/tests/tests/claims.rs`), all red on the pre-change build and green on
  the new one, covering every attack of section 7; whole suite 84/84.
- **Core.** `packages/core/src/fee-claims.ts`, 6 tests against the mock GitHub
  (`scripts/claims/mock-github.ts`) and a fake chain: flag off (404 everywhere), lookup and views,
  the mock OAuth round trip, single-use state, the gist proof and its refusals, the attestation
  verified with plain ed25519 over the bytes the program rebuilds, session tamper and expiry.
- **Devnet** (`scripts/pools/devnet-proof.ts` PASS 67/67, with the pools proof): routes set by the
  launcher at 20% and 10%; a non-owner and an out-of-bounds share refused; the slices exact in every
  crank; a claim attested by the claimant's own key, the same attestation replayed, and an
  attestation used on another GitHub id's escrow all refused on chain (`BadAttestation`); recipient
  A claimed 9.125926 UNITS after the mock sign-in and 8.296961 more after more fees accrued;
  recipient B claimed 4.148148 through a gist; then both claimed again through the Claim page in
  headless Chromium with a signing test wallet (B by the Sign in button: 4.148679; A by the page's
  gist path: 8.296296), the page showing the escrow balance and the per-agent accruals first, with
  no console error, no monospace, no em dash and no horizontal scroll; a route change stayed pending,
  was refused inside its delay and applied after it; an attestation for a second wallet was flagged
  as a rebind. The gist in this proof is served by the mock GitHub: a gist on github.com needs a
  real account and was not used (the lane has none it may use).
- **Mainnet fork** (`scripts/pools/fork-rehearsal.ts` 28/28): `set_fee_route` 0.003865800 SOL the
  first time for an account (route, escrow and its token account), `claim_github_fees` 31,843 CU and
  677 bytes with its Ed25519 instruction.
- **Pages.** `/claim` (`apps/web/wallet/claim.ts`), the wizard's share slider and username lookup
  with avatar (`apps/web/wallet/fee-route-step.ts`; rendered headless at 1280 and 390, light and
  dark, with the bits on for the check: bounds 10% to 30% read from chain, the repository owner
  prefilled and resolved to its id), the profile chip. A whole launch through the wizard with the
  fields on was not run; the proof set the routes with the same builders in its own transactions.
- **To enable on the site later:** the three flags (chain bit, Core, profile), `ClaimConfig` with
  the launch delays and a dedicated attestor key, the OAuth app (section 8), and three routes in the
  site gate (`scripts/deploy/gate.ts`): `GET /api/v1/fee-claims/*`, `GET /api/v1/github/users/*`
  and the three POSTs under `/api/fee-claims/` (not added: the deploy kit belongs to another lane
  and nothing is enabled).
- **Not built.** Indexer rows for route changes and claims (they carry no mint; Core reads routes
  and escrows from chain; the indexer records the routed slice of every crank as `fees_routed`);
  an org-admin proof (Q4).

## 11. Repository owners claim (owner decision 2026-10-12)

"The idea is that repo owners that actually own the repo (not the agent) are the ones to claim."
This section replaces the parts of sections 1, 3 (D2, D3, D4, D6), 5, 6, 8 and 9 it contradicts.
The program is unchanged and was not upgraded: it stores and signs over a `u64` and never knew what
the number meant.

### 11.1 The three answers

1. **Routing.** The launcher opts in with one tick. Ticked, the recipient is the repository the
   agent works on. Nothing is typed.
2. **Share.** One number for every agent: 20% of the agent's share. It lives on chain in
   `ClaimConfig`: the admin sets `min_bps = max_bps = 2000`, so the program itself refuses any other
   share, and `set_claim_config` changes it for later routes. The wizard reads the figure from
   `ClaimConfig.min_bps` and carries none of its own.
3. **Who claims.** Anyone GitHub says has admin on the repository, for a personal and an
   organisation repository alike.

### 11.2 What the escrow is keyed by

The REPOSITORY's numeric GitHub id (`GET /repos/{owner}/{repo}` field `id`): permanent across a
rename and a transfer. Seeds, accounts, instructions and the attested message are the ones of
section 4; only the meaning of `github_id` changed.

Account ids and repository ids are both small integers and overlap. They can never be confused,
for three reasons that hold together:

- **One kind, everywhere.** Core has no code path that turns an account into an escrow key. A
  session carries the account only as the claimant's identity, plus the list of repository ids that
  account was shown to administer; `attest` signs only for an id in that list. The account lookup
  (`GET /v1/github/users/:login`) is removed; the wizard gets its id from
  `GET /v1/github/repos/:owner/:repo`. `GET /v1/fee-claims/providers` says `recipient: "repository"`.
- **Bound to the repository on chain.** Core attests for an id only after it has seen an agent
  whose route names that id AND whose own `AgentLaunch.repo_url` on chain is a name GitHub resolved
  to that id (`fee_claim_bound`, recorded at first sight and kept, so a later redirect does not
  strand what accrued). A number of any other origin (an account id from the first devnet build, a
  route set by hand to an arbitrary number) is never bound, shows `claimable_by_admins: false`, is
  not named on a profile and pays nobody, even when some unrelated repository happens to carry the
  same number. Unit-tested with exactly that clash.
- **Mainnet starts clean.** The feature was never on there, so every mainnet escrow will be a
  repository's. Devnet holds test escrows keyed by account ids from the first build: they stay on
  chain, unbound and unclaimable (TEST tokens).

Names: Core keeps every owner/name GitHub ever resolved to an id (`fee_claim_repo_names`), so an
agent registered under a repository's earlier name still binds after a rename.

### 11.3 Proof of admin

At the OAuth callback, and only there, Core holds the visitor's token and asks GitHub:
`GET /user` (who), then `GET /repositories/{id}` for each routed repository (the same resource as
`GET /repos/{owner}/{repo}`), and counts a repository only when the answer says
`permissions.admin === true`. A missing or false field is a no. Above 60 routed repositories Core
reads the user's own list (`GET /user/repos`, up to 1,000) and intersects it, and a repository named
at the sign-in (`oauth/start?repo=owner/name`, the page's lookup) is always asked about by name. The
token is dropped when the callback returns: it is not in the session (an HMAC token holding account
id, login, method, wallet, repository ids, expiry), not in the database, and no later request uses
it (asserted in the tests against the mock's record of token calls). A session lasts 15 minutes, so
admin is as fresh as that.

**Scope: none.** The app requests no scope (`scope` is not sent). GitHub documents the empty scope
as read-only access to public information including repository info, and scopes never add to what
the user can already do; `permissions` on a public repository describes the signed-in user, not the
token's reach. Agents work on public repositories only, so no wider scope is needed, and `repo` or
`public_repo` (write access to code) would be far more than this page should ask for.
`UNITS_GITHUB_OAUTH_SCOPE` exists so the scope can be changed without a code change.

Organisations: a new GitHub organisation restricts third-party OAuth apps by default. Until one of
its owners approves the units app (GitHub offers the request on the sign-in screen), GitHub may not
report the member's admin role to the app, and the repository then does not appear. Core fails
closed in that case; the page says so in one sentence. No scope lifts that restriction; approval
does.

NOT PROVEN against github.com: this lane has no GitHub account it may use, so the two statements
above (an empty-scope token sees `permissions.admin` truthfully on a public personal repository, and
on a public organisation repository once the app is approved) rest on GitHub's documentation and
the mock. The owner's first sign-in on devnet settles both (section 11.8, step 5).

**The gist proof stays, narrowed.** A gist proves an account, not a role. It therefore opens only
routed repositories that account owns itself (`owner.type == "User"` and `owner.id` equal to the
gist owner's id, read from GitHub's public API): the personal owner of a repository always has
admin on it. It never opens an organisation's repository. It is the path that works with no OAuth
app at all, which is devnet's state today.

### 11.4 Several admins

Any one admin can claim the whole escrow to the wallet they bind; the page says so under every
repository ("Any one admin of owner/name can claim the whole balance to the wallet they bind.").
There is no split between admins and no vote: the people who run a repository settle that between
themselves, as they do for its other shared assets.

- Two admins ask at the same time, nothing claimed yet: both get an attestation for the whole
  balance at the same `claim_seq`; the first transaction to land is paid and pins its wallet, the
  other no longer verifies (`BadAttestation`).
- A second admin binds another wallet later: the attestation is flagged `rebind`, and their
  transaction records a pending move that takes effect `rebind_delay_s` later (D7). Until then the
  pinned wallet can keep claiming, which also cancels the pending move. After the delay the second
  admin claims again and is paid; their wallet becomes the pinned one. The page shows both states.
- Core records which account asked for each attestation (`fee_claim_attestations.login`).
- Someone who loses admin can still claim for at most the 15 minutes their session lasts.

### 11.5 Redirect and removal

- **Removal: impossible, and that stays.** `set_fee_route` requires a non-zero id and bps within
  the bounds; there is no instruction that clears a route. "Cannot be removed once set" is enforced
  by the program, and the wizard says it beside the tick.
- **Redirect: not offered, not impossible.** The site has no control for it. The program still
  lets the agent's registry owner call `set_fee_route` again by hand, which records a pending
  change that applies after `change_delay_s`. Forbidding that needs a program change, which this
  lane did not make. What bounds it without one: (a) an id that is not the agent's own repository
  is never bound, so a redirect cannot pay the launcher or a friend, it can only stop the
  repository's future share; (b) what accrued stays claimable (D5, and the binding is kept);
  (c) `change_delay_s` is admin-editable: set long, a redirect is a public notice of that length.
  Recommended launch value: 30 days (owner decides).
- With `min_bps = max_bps`, a redirect cannot change the share either.

### 11.6 Core and pages (changes to sections 5 and 6)

| Route | Change |
|---|---|
| `GET /v1/github/repos/:owner/:repo` | new: id, full name, owner (id, login, type, avatar) of a public repository; follows GitHub's redirect from a former name |
| `GET /v1/github/users/:login` | removed |
| `GET /v1/agents/:id/fee-route` | `repository` (null unless bound) instead of `login` |
| `GET /v1/fee-claims/recipients/:github_id`, `?repo=owner/name` | the id is a repository's; adds `repository` and `claimable_by_admins` |
| `GET /v1/fee-claims/oauth/start` | optional `repo=owner/name` |
| `GET /v1/fee-claims/session`, `POST /wallet`, `POST /proofs/gist` | answer `repositories` |
| `POST /v1/fee-claims/attest` | `{ session, repo_id }`; 403 `not_admin`, 403 `not_a_repository_escrow` |

New Core tables: `fee_claim_repos`, `fee_claim_repo_names`, `fee_claim_bound` (kept by a purge).

- **Wizard** (`apps/web/wallet/fee-route-step.ts`, rules in `fee-route-plan.ts`): one unticked box,
  "Route 20% of this agent's fees to the owners of owner/repo", the figure from chain. It cannot be
  ticked until Core has resolved the repository in the field, and changing the field clears it. The
  launch builds `set_fee_route` for the id looked up for exactly the repository the launch names.
- **Profile chip**: "20% of fees go to the owners of owner/repo", linking to `/claim?repo=`.
- **/claim**: Sign in with GitHub; bind a wallet; one panel per repository the account administers
  that has fees routed to it (claimable, claimed, routed in total, per agent, in US dollars with the
  coin amount beside each); claim. "Check any repository" shows any repository's balance and offers
  the sign-in for it.

### 11.7 Proven, and not

- `packages/core/test/fee-claims.test.ts` 10 tests (9 red on the previous module, 10 green): keying
  by repository id; the share from chain config; admin by sign-in on a personal and an organisation
  repository; a member without admin refused; an id that is not a repository's never attested (the
  account-id clash); two admins and the rebind; the large-set path and the named repository; the
  narrowed gist; token never kept; no scope sent.
- `apps/web/test/fee-route-plan.test.ts` 5 tests: nothing unticked; the route is for the checked
  repository only; a lookup for another repository refused; the figure follows the chain.
- `scripts/claims/repo-page-proof.ts` 34/34 in headless Chromium at 1280 and 390: `/claim` signed
  out, signed in as an organisation admin with two repositories, the dollar and coin amounts, the
  one-admin sentence, a non-admin member, the lookup, the account-id clash, and the wizard's tick.
  The chain Core reads there is staged in the script; the dollar price is the live reading.
- NOT proven: the sign-in against github.com (11.3); a claim transaction under the repository model
  on devnet (the program and the attested bytes are unchanged, and the bytes are unit-tested; the
  earlier devnet claims of section 10 used the same instruction). `scripts/pools/devnet-proof.ts`
  section 7 was written for account-keyed routes and now refuses to start; it needs a rewrite for
  one escrow per repository before it can run again.

### 11.8 To open claims on mainnet (nothing below was done)

1. GitHub OAuth app owned by the units organisation: Homepage URL `https://app.units.gg`,
   Authorization callback URL `https://app.units.gg/v1/fee-claims/oauth/callback`, no scope
   configured or requested, device flow off. On the server, mode 600, in Core's env file:
   `UNITS_GITHUB_OAUTH_CLIENT_ID`, `UNITS_GITHUB_OAUTH_CLIENT_SECRET`; `UNITS_SITE_URL` already
   yields the callback.
2. A dedicated attestor key generated on the server, named by `UNITS_FEE_CLAIMS_ATTESTOR_KEY`.
3. Admin transactions, by the launch admin: `set_claim_config { attestor, min_bps 2000,
   max_bps 2000, change_delay_s, rebind_delay_s, max_attestation_ttl_s 600, paused false }`, then
   `set_features` with bit 1 (value 2, or 3 with pools).
4. Flags: `features.github_fee_claims` true in `config/network.json` (Core) and in the mainnet
   block of `config/profile.json` (pages); the gate (`scripts/deploy/gate.ts`) must pass
   `GET /api/fee-claims/*`, `GET /api/github/repos/*`, the three POSTs and
   `GET /v1/fee-claims/oauth/callback`.
5. Before step 4 on mainnet, once on devnet with the real app: sign in as the admin of a personal
   repository and of an organisation repository that have a route, and see both listed. If the
   organisation's is missing after its owner approved the app, set `UNITS_GITHUB_OAUTH_SCOPE=read:org`
   and repeat.

Devnet needs its admin to send `set_claim_config` with `min_bps = max_bps = 2000` (it holds 1000 and
3000 today, so the tick there reads 10% until then), and its Core and pages redeployed.

## 12. Fees waiting for the owners (owner 2026-10-13)

"Unclaimed fees waiting for you." A public view, no sign-in, of what sits in each repository's escrow.

- **Core**: `GET /v1/fee-claims/waiting`, and `?repo=owner/name` for one repository (an empty list
  when nothing is routed to it; by every name GitHub ever gave the repository). Per repository:
  `waiting` (the escrow vault's balance on chain) and `claimed`, each in base units with `_usd`;
  `routed_total`; the `agents` whose route names it now with their share and `set_at`;
  `routed_since` (the earliest of those routes, a chain fact); `waiting_since`. Largest first.
  Only escrows bound to their repository (11.2) appear, so an account-keyed escrow of the first
  build is never listed; no wallet, claimant or attestation is in the answer. Held for 30 seconds.
- **Dollars**: the amount times the quote coin's current price, the rule for a figure of "now" at
  the top of `packages/indexer/src/api.ts`, from Core's copy of the indexer's reading
  (`revenue.ts`). With no reading every `_usd` is null with `usd_reason`, and the pages say so.
- **`waiting_since` is Core's observation, not a chain fact.** The escrow account holds no time.
  Core notes when it first saw a balance at the escrow's current claim number (table
  `fee_claim_waiting`), so the time starts again after a claim, and it is late by however long
  nobody had asked Core (the pages ask whenever someone opens them).
- **Pages** (`apps/web/src/fees-waiting.ts`): the list "Repositories with fees waiting" under the
  claim steps on `/claim`; a section on the repository's project page ("$X is waiting for the
  owners of owner/repo. Anyone with admin on the repository can claim it.", a Claim button to
  `/claim?repo=owner/repo`); and `/claim/<owner>/<name>`, the address to share, whose title and
  description the web server writes into the document it serves (`apps/web/claim-preview.ts`,
  `og:` and `twitter:` tags, the amount when something waits, read from Core and kept a minute).
  Empty states: no repository with fees waiting; a route that has earned nothing; nothing routed
  to this repository. Where the feature is off the list and the section are absent.
- A link to `/claim?repo=` from inside the app lost its query (the router carried only the path),
  so the profile chip never opened its repository; fixed for `/claim`.
- **Proven**: Core tests 3 (unclaimed with two agents, partly claimed, empty, the dollar rule, the
  account-id escrow left out, nothing private, no reading, the flag); page and preview tests 7;
  `bun scripts/claims/waiting-proof.ts` 44/44 in headless Chromium at 1280 and 390 on a staged
  chain, then on a chain with no route. **Not proven**: a real escrow (none holds anything on
  mainnet today: no agent has set a route), the preview as X or another site renders it, and the
  tags on a statically hosted copy of the app (they are written by `apps/web/server.ts`).

