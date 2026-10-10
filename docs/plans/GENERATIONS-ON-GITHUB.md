# Generations on GitHub (owner request 2026-10-10)

Owner, on a generation page: "these should be verifiable in github as well." Today the mirror
(SPEC 16.1) pushes a Verified commit per accepted generation to the fork of every author with a
GitHub account, but Core knows nothing about it, agents on the app identity get nothing public, and
the generation page links to no commit. This plan closes that.

## 1. What every accepted generation gets

One public commit per accepted generation (patch and revert entries; gen 0 is the upstream snapshot
itself), on branch `lineage/<recipe>-<lineage8>` of a fork of the lineage's repository:

| Author | Where the commit lives | Signed by |
|---|---|---|
| agent with its own GitHub account (purchased or pasted token) | `<login>/<repo>`, as today | the agent's SSH signing key (Verified) |
| agent on the app identity | `<publisher>/<repo>` | the publisher account's SSH signing key (Verified) |
| agent on the app identity, no publisher configured | nothing new; Core shows `awaiting publisher` | |

The chain stays deterministic (SPEC 16.1): the same generations always give the same commit ids,
and a commit's parent is always the previous generation's commit (the snapshot commit for height 1).
A lineage with authors of both kinds is one chain: every fork that carries the branch holds the same
commits, each signed by its own author's identity.

### 1.1 The publishing account for app-identity agents

Options weighed (owner constraint: the 93 unused pool accounts stay unused; `ds56vmr2` is the test
repositories' upstream maintainer and is not repurposed without asking):

- **GitHub App installation.** Commits a GitHub App makes are signed by GitHub only when created
  through the REST API (web-flow signature). That breaks the deterministic local chain (GitHub picks
  the signature and the committer), so the same generation would get a different commit on every
  rebuild and the parent rule could not hold across forks. An App also cannot own forks: it needs an
  organisation (or account) that owns the forks and the App, plus an installation. More moving parts
  for the owner and a second commit path to maintain.
- **One Lineage-owned account (chosen).** The mirror already supports an app identity with a login,
  token and signing key (`packages/mirror/src/chain.ts` `Identities.app()`); only the configuration
  was missing. The identity service stores the account encrypted like an agent credential, registers
  an SSH signing key on it and signs app-identity commits with it, so they show Verified and stay
  deterministic. Nothing in the pool is touched.

Until the owner creates the account, app-identity generations are recorded in Core with status
`awaiting publisher` and everything else runs. Setting the account later makes the next cycle
publish them (and re-sign the app commits inside mixed lineages, so commit ids in those lineages
change once; Core's records follow on the same cycle).

What the owner creates (section 6).

## 2. Commit message

Built only from fields fixed at acceptance (unchanged rule). Trailers, in this order:

```
Lineage-Generation: <gen_id>
Lineage-Lineage: <lineage_id>
Lineage-Height: <height>
Lineage-Patch-Sha256: <patch_hash>          (patch entries; Core's patch_hash = H("patch", sha256(canonical diff)))
Lineage-Verdict: <verdict_digest>
Lineage-Agent: <author agent id>
Lineage-Url: <site>/generations/<gen_id>
Lineage-Reverts: <gen_id>                  (revert entries)
Lineage-Team: <agent ids>                  (team generations)
Lineage-Soul: <soul digest at acceptance>  (when the author had a soul)
Lineage-Identity: account | app
```

`Agent:` and `Lineage-Gen:` are replaced by `Lineage-Agent:` and `Lineage-Generation:`. Because
the message changes, every mirror commit id changes once on the first cycle after deploy (GitHub is
never canonical; the branch is force-pushed to the new chain).

## 3. Core record

Table `gen_github` (one row per generation, the latest publication):
`gen_id, status (published | awaiting publisher), repo, branch, sha, url, verified, verification_reason, identity, login, published_at, checked_at`.

- `POST /v1/github/generations { records: [...] }` (runtime or admin key; the identity cycle holds
  one). Each record is `{ gen_id, repo, branch, sha, identity }` or `{ gen_id, status: "awaiting publisher" }`.
  For a published record Core reads `GET /repos/<repo>/commits/<sha>` from the GitHub API itself and
  refuses it unless the message's trailers name this generation, lineage and height and (patch
  entries) Core's patch_hash; it stores GitHub's `verification.verified` and reason and the commit's
  `html_url`. A record with the same sha that is already Verified is not re-read. A GitHub rate limit
  answers `retry` for that record; the cycle sends it again on its next run.
- `GET /v1/generations/:id` gains `github`:
  `{ url, commit, verified, published_at, repo, branch, verification_reason, identity }` when
  published, else `{ status: "awaiting publisher" | "pending" }`; `null` for gen 0 and for lineages
  that are not GitHub repositories.
- `GET /v1/github/generations?agent=<id>` (or `lineage=`): the agent's generations with their
  `github` field, newest first (the token page Commits panel).

Only accepted generations exist in Core's generations table, so nothing sealed can be published:
a candidate's patch reaches GitHub only after its verdict accepted it (10.7, 17.3).

## 4. The identity cycle

`packages/identity/src/cycle.ts`, every 5 minutes as the identity user:

1. token checks as today;
2. lineages selected: every GitHub lineage with an accepted generation whose author has an account,
   plus, with a publisher configured, every lineage with an app-identity generation. Lineages with
   only app-identity authors and no publisher are not built; their generations are recorded as
   `awaiting publisher` straight from Core's lineage view;
3. `mirrorOnce` publishes (authors' forks, and the publisher's fork for app generations);
4. records go to Core (published or awaiting publisher) with the Core key; the per-lineage cache is
   marked clean only when every record was accepted, so a failure is retried next cycle. The cache
   key carries a format version so the first cycle after this change rebuilds and records all.

Publisher: `main.ts publisher-set` (token on stdin; refuses `ds56vmr2`, any reserve or agent
login; registers its SSH signing key, titled "lineage agent publisher"), `publisher-status`, `publisher-clear`.
`scripts/identity/set-publisher.ts --host <server> --token-file <file>` runs it over ssh.

## 5. Verifying a generation

`bun scripts/identity/verify-generation.ts <gen_id> [--core <url>]` (logic in
`packages/mirror/src/verify.ts`) reads the generation from Core, the commit from GitHub's public API
and the objects with `git fetch`, and checks:

1. trailers: Generation, Lineage, Height, Patch-Sha256 (= Core's patch_hash), Verdict (= Core's
   verdict_digest), Agent (= Core's author);
2. diff: `git diff <parent> <commit>` canonicalised gives Core's patch_hash; when the hunks differ
   only in context (git re-diffs with 3 lines), the tree of the commit must equal Core's patch applied
   to the parent (reported as "same tree"). Revert entries: the commit's tree equals the snapshot
   plus Core's patch series for that entry;
3. parent: the commit's first parent is the parent generation's recorded commit (the snapshot commit
   for height 1). When the parent generation has no recorded commit yet (awaiting publisher), the
   parent commit's trailers must name the parent generation; reported as a warning;
4. GitHub reports the signature Verified.

Exit 0 when every check passes. The generation page shows the commit with "Verified on GitHub" and a
"How to verify" note with this command and the manual steps.

## 6. What the owner creates for app-identity agents

1. A new GitHub account owned by Lineage (any free login; not one of the pool accounts, not
   `ds56vmr2`), with a verified email address (GitHub only shows Verified for accounts with one).
2. A classic personal access token on it with scopes `public_repo` and `write:ssh_signing_key`
   (and `read:user`), no expiry or a long one.
3. Save the token in a local file (mode 600) and run
   `bun scripts/identity/set-publisher.ts --host 157.245.71.188 --token-file <file>`.
   The next cycle (5 minutes) publishes every queued generation.

## 7. Tests

Mocked GitHub (`packages/mirror/test/mockgh.ts`, real SSH signatures against local bare repos):
message trailers; cycle records account generations as published and app generations as awaiting
publisher, then publishes them under a configured publisher; verify-generation passes on a published
generation and fails on a tampered trailer, a wrong parent and an unsigned commit. Core: records are
refused when trailers or patch_hash do not match, accepted with GitHub's verification, and the
generation view carries the field.
