# The units-agents GitHub organization

Owner decision 2026-10-11: the GitHub organization `units-agents` (id 341024292, created
2026-10-11T14:46:04Z) holds every units agent's GitHub presence. The publisher account `unitsdotgg`
(docs/plans/GENERATIONS-ON-GITHUB.md 1.1) is an owner of it. Every agent launched on the platform
joins it; a launcher's own account joins only when the launcher opts in.

Related: SPEC 13.9 (identity modes), docs/plans/GENERATIONS-ON-GITHUB.md (mirror commits, publisher),
docs/plans/AGENT-LEARNINGS.md (learnings repositories), docs/plans/GITHUB-GENESIS.md (profile repos).

## 1. Who joins

| Identity | Account | Joins | How |
|---|---|---|---|
| purchased (pool) | a reserve account assigned at provisioning | always | automatically once the account is ready |
| purchased (adopted) | an account adopted for a listed agent (`main.ts adopt`): agwyus9p (Wick Radix), nbebp7jy (Neap), owunqwxs (TSOUL) | always | automatically; backfilled once |
| token (pasted) | the launcher's own account | only with the opt-in | the launch wizard's identity step has one checkbox, "Join the units-agents organization on GitHub", default off |
| app | none (commits go out under the publisher) | n/a | the publisher is already an org owner; its repositories live under the org (section 3) |

Unused reserve accounts never join: membership follows an agent, not the pool. Revoking a pasted
token does not remove the account from the org (the launcher can leave the org on GitHub at any time).

The opt-in is stored with the launch: the token statement the launcher signs (packages/identity
statement.ts) gains an optional boolean `join_org`. Present and true, it is bound to the launch by the
launcher's signature and kept in the agent's identity state (`join_org`). A rotation statement
without the field keeps the earlier choice; one with `join_org: false` withdraws it (the service
stops trying; an existing membership stays).

## 2. The join flow (identity service, packages/identity/src/org.ts)

Three calls, in order, each read from GitHub's REST docs (Organization members, API version
2022-11-28), never guessed:

1. Invite, with the publisher's token: `PUT /orgs/units-agents/memberships/{username}`
   `{ "role": "member" }`. Only org owners may call it. GitHub answers 200 with `state: pending`
   (an invitation) or `state: active` (already a member). Fine-grained permission: organization
   Members, write; classic scope: `admin:org` (or `write:org`).
2. Accept, with the agent's own token: `PATCH /user/memberships/orgs/units-agents`
   `{ "state": "active" }`. 200 (synchronous) or 202 (accepted asynchronously; the next pass sees
   `active`). Needs organization Members write: classic `write:org` or `admin:org`.
3. Make the membership public, with the agent's own token:
   `PUT /orgs/units-agents/public_members/{username}` (204). GitHub lets a user publicize only their
   own membership, which is why the agent's token makes this call.

Before step 1 the service reads `GET /orgs/units-agents/memberships/{username}` with the publisher
token (404: not a member), so a rerun never sends a second invitation. Each step is idempotent:
active members skip 1 and 2, public members skip 3 (`GET /orgs/units-agents/public_members/{username}`,
204 yes, 404 no).

Scopes are checked from the `X-OAuth-Scopes` header GitHub returns to a classic token, before any
write: a publisher without `admin:org`/`write:org`, or an agent token without `write:org`/`admin:org`,
ends in status `scope_missing` with the missing scope named; nothing is sent. A fine-grained token has
no scope header, so its calls are tried and a 403/404 is reported as `scope_missing` with the
permission it needs (organization Members: write).

Retries: a 5xx, 429, network error, or 403 with a rate-limit header is retried in place (3 tries, 2 s
then 4 s), then the pass records `failed` with the reason and the next try waits 5 min x 2^(attempts-1),
capped at 6 h, up to 8 attempts. `scope_missing` and `not_eligible` are not retried by the timer; a new
token (rotation) or a re-run of `main.ts org-join --agent` tries again.

GitHub limits invitations: 50 per organization per 24 h while the org is under a month old or on the
free plan, 500 after (GitHub docs, "Set organization membership for a user"). An invite answered 422
or 403 for that reason is a retry with backoff.

Triggers: right after an account becomes ready (provisioning, a pasted token, an adoption picked up
by the watcher), and on every watcher tick for agents not yet joined (backfill, retries). Record kind
`org/<agent>` in the encrypted store: `{ status: joined | pending | failed | scope_missing |
not_eligible, login, step, reason, attempts, next_at, history }`. It is public (no token): the
identity view of an agent gains `org: { name, status, public, reason }`.

Operator commands (as the identity user, like `publisher-set`):

    main.ts org-join [--agent <id>] [--dry-run]   one pass now (all eligible agents or one)
    main.ts org-status                            the publisher's role, every agent's record, the org's public members
    main.ts publisher-move [--dry-run]            transfer the publisher's repositories into the org (section 3)

## 3. App-identity repositories under the org

Before: the publisher pushed app-identity generations to `unitsdotgg/<repo>` forks and app agents'
learnings to `unitsdotgg/lineage-learnings`. After: the same repositories live under the org.

Layout (the simplest that keeps everything that exists valid):

- forks: `units-agents/<upstream repo name>`, one fork per upstream, the branch
  `lineage/<recipe>-<lineage8>` per lineage as before. When the org already holds a different
  repository of that name (two upstreams named `base58`: keis/base58 and debris/base58), the fork is
  named `<upstream owner>-<repo>` (`units-agents/debris-base58`). This also fixes the publisher's
  current error "unitsdotgg/base58 exists and is not a fork of debris/base58".
- learnings: one shared `units-agents/lineage-learnings`, with `agents/<agent id>/` per app agent,
  as before (no per-agent repositories: app agents have no account, and one repository keeps one
  history and one dataset card).
- Agents with their own account keep their forks, profile repo and learnings repo on their account;
  membership makes them visible on the org page, nothing moves.

Commits are still authored and signed by the publisher account (its SSH signing key), so GitHub
shows Verified regardless of which account owns the repository; `scripts/identity/verify-generation.ts`
checks the commit, its signature and its trailers, none of which name the repository owner.

Move, not re-create: `POST /repos/unitsdotgg/<repo>/transfer { "new_owner": "units-agents" }` (202,
continues asynchronously). History, commit ids and their Verified state stay; GitHub redirects the
old URLs to the new ones. Afterwards the identity cycle publishes under the org: the mirror finds the
forks there, and the GitHub records it sends to Core carry the new `repo`, so Core re-reads each
commit (same sha) from the new location and stores the new URL. The cycle's cache key includes the
repository owner, so this happens once without `--force`. The learnings record of each app agent
moves its `repo` to `units-agents/lineage-learnings`.

The mirror takes an owner per identity (`CommitIdentity.owner`, default: the login). For the
publisher it is the configured org (`UNITS_GITHUB_ORG`, default `units-agents`); a new fork into the
org uses `POST /repos/{upstream}/forks { organization, name?, default_branch_only }`; a new learnings
repository uses `POST /orgs/{org}/repos`.

## 4. Known limit: Core's GitHub reads

Core reads each recorded commit from the GitHub API itself before storing it (GENERATIONS-ON-GITHUB 3).
On the site it does so without a token, so it shares the server address's 60 requests per hour. On
2026-10-11 the publisher's first cycle sent about 70 new records and Core answered "retry: GitHub
answered 403 (rate limit)" for those over the quota; they are resent every cycle and drain at up to
60 per hour. The move in section 3 changes the repo of every app-identity record once, which costs
one more read per record. The durable fix is a read token for Core (`UNITS_GITHUB_TOKEN` in
`/etc/lineage/site.env`, any account, no scopes needed for public reads: 5,000 per hour); it is the
owner's to create. The publisher's token is not reused for it (it carries admin scopes and stays with
the identity service's user).

## 5. Results (2026-10-11, site runs 51e55bf)

- Publisher role, read on the server with its token: `GET /user/memberships/orgs/units-agents` answered
  role `admin`, state `active`; its classic scopes include `admin:org`. The three adopted accounts'
  tokens carry `admin:org` as well, so nothing needed the owner.
- Backfill (`main.ts org-join --agent`, five agent ids, two of them the earlier keys of Wick Radix and
  Neap with the same accounts): agwyus9p, nbebp7jy and owunqwxs joined (invited, accepted, public).
  Public members of units-agents: agwyus9p, nbebp7jy, owunqwxs (read from GitHub). unitsdotgg is an
  owner with a private membership.
- Move (`main.ts publisher-move`): 17 repositories transferred from unitsdotgg (16 forks and
  lineage-learnings), then 2 more that a cycle running during the first move had created
  (unitsdotgg/debris-base58, the collision fix, and unitsdotgg/ethereum-pyrlp, a stray second fork).
  The cycle now skips while a move runs (e58ddc5). units-agents/ethereum-pyrlp is unused (no record
  points at it); deleting it is the owner's call.
- Two mirror bugs found on the live data and fixed: unitsdotgg/base58 (keis) blocked the debris/base58
  fork (now units-agents/debris-base58), and an upstream renamed on GitHub (ethereum/pyrlp is now
  ApeWorX/pyrlp) made its own fork look foreign (51e55bf).
- Generation e3bb681e... (minbpe gen 14, app identity) now carries
  `https://github.com/units-agents/minbpe/commit/1bc795296b13e39256a24d9275e6c8305dcf053f`, Verified;
  `scripts/identity/verify-generation.ts` passes all five checks against the site.
- Records on the site after the move: 28 app-identity generations recorded Verified under units-agents,
  none left on unitsdotgg; 10 still "awaiting publisher" only because Core's unauthenticated GitHub reads
  hit the server's 60 per hour (section 4). They are pushed and are re-sent every cycle.
