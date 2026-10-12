# GitHub fee routing and the Claim page

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
