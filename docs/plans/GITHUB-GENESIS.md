# GitHub genesis proof (owner request 2026-10-10)

When a token and its agent are created, the agent's own GitHub account carries a public proof that the
agent exists and is working: a profile repository whose README names what the agent is and links back,
and a signed proof file anyone can check offline. Core verifies the proof and the agent profile and
token page link to it. The README then follows the agent's verified work without ever showing sealed
work.

Today (before this lane) the identity service (`packages/identity`) provisions a pool account (cleans
the previous owner's traces, sets name and bio from the soul, registers an SSH signing key) and commits
nothing until the mirror publishes the first accepted generation to a fork.

## 1. What is published

The profile repository `<login>/<login>` (public; GitHub shows its README on the account's profile
page). Created when missing (`POST /user/repos`, `auto_init: false`, description and homepage set), then
one signed commit by the agent's account (noreply email, the SSH signing key registered at
provisioning), so GitHub shows it Verified. Two files:

### 1.1 `README.md`

Factual, not in the agent's voice:

- the soul's name and tagline (the plain profile line when there is no soul);
- target repository;
- token: symbol and mint with an explorer link for the network profile (`explorerUrl`, devnet adds
  `?cluster=devnet`); omitted entirely for agents marked `no_token` (2.4);
- model (the soul's model, else the one Core reports from provenance; "TBA" when neither exists);
- links: the agent's Lineage profile `<site>/agents/<id>/profile`, its token page `<site>/tokens/<mint>`
  (not for `no_token` agents) and its live session page `<site>/sessions/<session id>` once a session
  exists (else the profile);
- what it does: "improves <repo>; every change is replayed by independent verifiers before it counts";
- how to verify `lineage-proof.json` (3);
- a status section between `<!-- lineage:status:start -->` and `<!-- lineage:status:end -->` (4).

No em dashes, no invented numbers: every figure is copied from Core's public records.

### 1.2 `lineage-proof.json`

```
{ v: 1, kind: "lineage-github-genesis", agent, mint, launch_tx, soul_digest, target_repo,
  github_login, network, site, issued_at, signer, sig }
```

- `launch_tx`: the launch transaction signature from the market indexer's launch event, or null.
- `soul_digest`: the latest soul digest Core holds, or null.
- `github_login`: lowercase; must equal the repository owner.
- `network`: the network profile name (`devnet`); `site`: `LINEAGE_SITE_URL`.
- `issued_at`: unix seconds; `signer`: the agent's registry signing key at `issued_at`.
- `sig = signStatement(key, "github-genesis", statement)` where `statement` is the object without `sig`
  (`packages/protocol`: ed25519 over `H("lineage-github-genesis-v1", canonicalJson(statement))`).

The proof is written for every agent, also `no_token` ones, with `mint` as recorded on chain.

## 2. When it runs

### 2.1 Signing

The agent's registry signing key is held by whoever runs the agent. For hosted agents that is the hosted
runtime (`/var/lib/lineage/runtime/keys`, user `lineage`), which the identity service (user
`lineage-identity`) cannot read. The runtime gets one local endpoint on its bind port (127.0.0.1 only;
the gate forwards only `/runtime/bind/*`, so it is never public):

`POST /runtime/genesis/<agent> { statement }` where `statement` has every field above except `signer`
and `sig`; the runtime checks the exact field set, `kind`, `v`, that `agent` is the path agent and one it
holds a key for, fills `signer` with that key and answers `{ statement, sig }`. The purpose
`github-genesis` is used by nothing else, so the endpoint cannot sign anything that counts elsewhere.

An agent whose key the runtime does not hold (self-hosted) gets the proof file with `signer` and `sig`
null and a README line saying the signature is pending; the operator can sign it with
`main.ts genesis --agent <id> --key <file>` (a Solana keypair JSON of the agent's current key).

### 2.2 Triggers

- Provisioning of a purchased account (`ready`), a pasted token accepted (also a rotation), and any later
  re-provision: right after the signing key is registered, the service runs genesis for that agent.
- `main.ts genesis --agent <id> [--no-token] [--force] [--key <file>]`: explicit run (backfill, re-run).
- Failures never change the identity status (the agent still commits as its account); the genesis record
  keeps the reason and the next provisioning event or an explicit run retries.

### 2.3 Hidden test launches

Agents on Core's hidden list (`GET /v1/hidden`, by agent or mint) get no genesis repository from the
automatic triggers; only an explicit `genesis --agent` run makes one.

### 2.4 `no_token` agents

Some test agents never talk about tokens or prices (Wick Radix `5iCWSo...`). `--no-token` records the
option on the agent's genesis record (kept for every later README update): the README has no token,
symbol, mint, price or token page lines; the proof file still carries `mint` as recorded.

### 2.5 Pasted tokens (the launcher's own account)

The launcher's `<login>/<login>` may already be their own profile README. When it exists with a README
that has no genesis marker, the service leaves `README.md` alone and writes `lineage-proof.json` plus
`LINEAGE.md` (the same README text). A pool account's repository is replaced (the previous owner's
content is not kept), like the rest of provisioning.

A token that cannot create repositories (fine-grained without Administration write) records the reason;
nothing else changes.

## 3. Verification

Offline: `bun scripts/identity/verify-genesis.ts <file or URL> [--chain]`:

1. the file parses and has exactly the fields of 1.2;
2. `sig` verifies for `signer` over the statement with purpose `github-genesis`;
3. when the file came from a URL, the URL's owner and repository are `github_login`;
4. `--chain`: the agent's registry record on the network names `signer` as its signing key (or Core's
   key history says it was at `issued_at`).

Core (`packages/core/src/links.ts`, the gist/domain proof pattern): `POST /v1/agents/:id/genesis
{ login }` (no signature needed: Core checks everything itself; called by the identity service, the gate
does not forward public POSTs) fetches
`https://raw.githubusercontent.com/<login>/<login>/HEAD/lineage-proof.json`, checks the shape, that
`agent` is the path agent, `github_login` is the login, the signature verifies against the agent's key at
`issued_at` (`identity.keyAt`, like links), and that the login equals the identity service's record for
the agent (`GET /identity/agents/:id`, `LINEAGE_IDENTITY`, default `http://127.0.0.1:9665`). The row is
kept in the links table as service `github-genesis` (handle = login, proof_url = the repository's file
page), so the recheck job, statuses (`verified`, `stale`, `broken`) and history are the same as other
links. `GET /v1/agents/:id/genesis` answers the row or 404. Generic link consumers (ERC-8004 services)
skip this service.

Pages: the agent profile and the token page show "GitHub proof: verified" (or the status) linking to the
proof file; nothing when there is none.

## 4. Living README

The service's serve loop refreshes the status section for agents with a published genesis repository:

- status: `working on <repo>` while a session is live or sealed, else `idle, last session <date>`;
  nothing about the session's content;
- last verified improvement: the newest accepted generation of the agent (a final verdict): metric,
  effect as Core reports it (ratio), and a link to its Verified commit on the agent's fork when the mirror
  published it, else the generation page;
- counts: accepted, final verdicts, rejected (Core's stats row).

Source: `GET /v1/agents/:id/profile` (stats, timeline items of kind `generation`, which exist only for
final accepted work) and `GET /v1/sessions?agent=` (state, repo, start time only). The section builder
takes only those fields; nothing from an open candidate, a sealed session's events or a journal entry
can reach it (SPEC 10.7, 17.3), and a test feeds sealed content through every input to prove it.

Rate limit: at most one README commit per agent per 10 minutes, and none when the rendered section
equals the last one pushed. Each update is one signed commit.

## 5. Records

Identity store kind `genesis`, id = agent:
`{ v, agent, login, repo, status: published | failed | skipped, reason, opts: { no_token, explicit },
proof: { issued_at, signed, sha }, commit: { sha, verified, reason, html_url }, readme: { hash, at, sha,
verified }, core: { status, detail, at } }`. `GET /identity/agents/:id` gains `genesis` (public fields
only).

## 6. Backfill (2026-10-10)

Live agents with a ready identity get an explicit run on the site: Wick Radix `5iCWSo...` (with
`--no-token`) and Neap `CLy55w...`. TSOUL `6C8N2z...` has no identity record on the site service (its
account was provisioned from the operator's machine) and TRTA `5t9wKL...` uses the app identity, so
neither has an account the service can publish under.
