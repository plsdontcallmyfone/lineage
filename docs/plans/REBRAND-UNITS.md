# Rebrand: Lineage to units

Owner decision 2026-10-10: the project is renamed **units**, at full depth (code, packages, programs,
server, GitHub artifacts, copy). This file is the phase 0 inventory and plan; nothing is renamed by it.
Phase 1 executes it in reviewable commits by area (section 5).

## 1. Naming conventions

The owner writes the name in lowercase: `units`. One spelling per context:

| Context | Old | New |
|---|---|---|
| Wordmark, UI copy, docs prose, site title | Lineage, Lineage Network | units (lowercase, also at the start of a sentence, like a wordmark) |
| kebab identifiers (units, users, bins, elements, repos, Docker names) | `lineage-core` | `units-core` |
| snake identifiers (crates, Rust modules) | `lineage_registry` | `units_registry` |
| npm workspace scope | `@lineage/*` | `@units/*` (scope unclaimed on npm 2026-10-10; packages are workspace-only, nothing is published) |
| env vars | `LINEAGE_*` | `UNITS_*` |
| PascalCase (JS globals, types) | `window.Lineage`, `LineageConfig` | `window.Units`, `UnitsConfig` |
| commit trailers | `Lineage-Generation` | `Units-Generation` (new chains only, section 3.7) |
| Docker label / images | `lineage=1`, `lineage/<class>` | `units=1`, `units/<class>` (section 3.10) |

**The concept noun stays.** "lineage" is also the protocol's name for a repo's chain of accepted
generations: `lineage_id = H("lineage", snapshot_id, recipe_id)`, the `lineages` table, `/v1/lineages`,
`lineage_id` fields inside hashed bounty leaves (`onchain/programs/lineage-launch/src/bounty.rs`
`contribution_json`), the `Lineage-Lineage` trailer value. Renaming the noun would change ids, hashed
leaves and on-chain args, and "units" is a brand, not a better word for the data structure. Plan:
keep the noun in code, data and API ("a units lineage", "21 lineages on units"). If the owner wants
the noun gone from UI copy too, that is a copy-only change (section 3.13) and needs a replacement word
from the owner. **Owner question Q1.**

**Word collision.** "unit" is already common here: systemd units (`CORE_UNITS`, "public units" in
`scripts/deploy/remote.sh`), units of compute, units of measure. A blind `sed s/lineage/units/` makes
prose like "every lineage unit" into "every units unit". Mechanical renames are applied to identifiers
by pattern (section 5); prose is edited by hand and reviewed.

## 2. Inventory (measured at c41cc30, 2026-10-10)

Reproduce with `python3 -I scripts/rebrand/inventory.py` (counts every match in tracked text files,
first matching category wins).

Totals: 9,527 occurrences in 811 of 1,408 tracked files (lowercase `lineage` 8,282, `Lineage` 764,
`LINEAGE` 500, overlapping matches aside). 134 tracked paths contain the word; 41 of them outside
`recipes/`.

| Occurrences | Files | Category | Treatment |
|---:|---:|---|---|
| 3,776 | 532 | other identifiers, prose, copy, docs | rename (identifiers by pattern, prose by hand) |
| 2,072 | 214 | concept noun: `lineage_id`, `lineages`, `/v1/lineages`, `lineageId` | keep (section 1) |
| 981 | 134 | server and local paths (`/opt/lineage`, `/var/lib/lineage`, `/etc/lineage*`, `/home/lineage/.lineage`, `~/.config/lineage`) | rename with symlink fallbacks (3.8, 3.12) |
| 718 | 144 | `recipes/**` (recipe.yml, overlays, `lineage/` harness dirs, `LINEAGE_SEED` reads) | frozen (3.1) |
| 507 | 101 | program crates `lineage_registry`, `lineage_launch`, `lineage_msg` | rename crates, same program ids (3.5) |
| 388 | 215 | `@lineage/*` package scope (14 packages) | rename (3.2) |
| 365 | 118 | `LINEAGE_*` env vars (48 names) | rename, old names read as aliases (3.3) |
| 188 | 26 | embed `<lineage-*>` elements (11), `window.Lineage`, `LineageConfig`, `lineage-ready`, `lineage:event` | rename, old names registered as aliases (3.11) |
| 179 | 49 | Docker label `lineage=1`, images `lineage/<class>` | both during transition (3.10) |
| 113 | 14 | commit trailers `Lineage-*` (12 keys) | parsers accept both; existing chains frozen (3.7) |
| 111 | 41 | signed statement domain and kinds (`lineage-<purpose>-v1`, 12 kinds) | dual acceptance (3.6) |
| 82 | 25 | GitHub artifacts: `lineage-proof.json`, `lineage-learnings`, README markers, mirror branches `lineage/*`, `lineage-episode/1`, `lineage-app@lineage.invalid` | dual (3.9) |
| 26 | 17 | browser storage keys (`lineage-wallet`, `lineage-theme`, `lineage.deck.v1`, `lineage-gh:*`, ...) | rename with one-time read migration (3.11) |
| 21 | 11 | frozen hash and HKDF domains | keep forever (3.1) |

By file type: `.ts` 5,056, `.md` 1,770, shell/systemd/Caddy templates 1,079, `.json` 508, `.rs`/`.toml` 299.
Biggest areas: packages/core 2,011, scripts/deploy 1,294, apps/web 429, packages/embed 338, docs/SPEC.md 320.

Named lists (from the same scan):

- Packages: `@lineage/{protocol,chain,sandbox,souls,worker,mirror,runtime,core,web,trader,indexer,identity,embed,desktop}`; root workspace `lineage`.
- CLI bins: `lineage-identity`, `lineage-worker`, `lineage-runtime`, `lineage-souls`, `lineage-mirror`.
- systemd (`scripts/deploy/systemd/`, 19 files): `lineage-{core,web,gate,indexer,identity,runtime,monitor,bootstrap,reference,author,backup,backup-state,backup-identity}.service`, `lineage-author@`, `lineage-verifier@`, timers `lineage-{backup,monitor,identity-cycle}.timer`, `lineage-identity-cycle.service`.
- Service users and groups: `lineage` (home `/home/lineage`, `LINEAGE_HOME=/home/lineage/.lineage`), `lineage-core`, `lineage-web`, `lineage-gate`, `lineage-indexer`, `lineage-monitor`, `lineage-identity`; group `lineage`.
- Server paths: `/opt/lineage` (releases, `current`, `previous`), `/var/lib/lineage/{core,site,identity,backups,...}`, `/etc/lineage/{site.env,indexer.env,...}`, `/etc/lineage-core`, `/etc/lineage-identity`, `/var/log/caddy/lineage-access.log`, desktop image `/etc/lineage-desktop`.
- Desktop host gateway `scripts/deploy/desktop-host/lineage-desk-gw` (requires label `lineage=1`), containers `lineage-desk-<id>`.
- Statement kinds: `lineage-{follow,reaction,media,link,agent-follow,journal,upstream-optin,reputation,identity-token,identity-revoke,github-genesis,soul}`; digests `lineage-<purpose>-v1` (`packages/protocol/src/auth.ts statementDigest`), `lineage-identity-v1` (apps/web/wallet/identity.ts), `lineage-rotate-v1`, `lineage-github-genesis-v1`.
- Trailers: `Lineage-{Generation,Lineage,Height,Patch-Sha256,Verdict,Agent,Gen,Soul,Url,Reverts,Team,Identity}`.
- Embed elements: `lineage-{screen,stats,device,explorer,reel,leaderboard,terminal,token,feed,palette,how}`.
- Vercel: `lineage-garage.vercel.app`, `lineage-sable.vercel.app` (named in docs). Site host `157-245-71-188.sslip.io` (no brand in it).
- Devnet token metadata: "Lineage Test LINE (TEST)", symbol `tLINE` (onchain/DEVNET.md). The ticker `$LINE` (618 occurrences) is not the word "lineage"; whether it changes is **owner question Q2**.

Lanes whose files join the sweep when they land (the scan is rerun at execution, so their files are counted then): projects generations analytics lane (`apps/web/src/pages/{projects,project,generations,analytics}.ts`, `packages/core/src/analytics.ts`, its plan), docs expansion lane (`apps/docs/**`, `scripts/docs/**`), honest screen and chrome panel lanes (`apps/web/src/live-panel/**`, `packages/embed/src` screen/thumb/device).

## 3. Decisions per category

### 3.1 Frozen forever (keep, with a comment saying why)

- `recipes/**`: `loadRecipe` hashes recipe.yml plus the overlay digest into `recipe_id`, and
  `lineage_id = H("lineage", snapshot_id, recipe_id)`. Any byte changed in a recipe (including the
  `lineage/` harness directory names, `LINEAGE_SEED` reads, and `image: "lineage/<class>:<tag>@sha256:..."`)
  forks every lineage, generation, on-chain registration and mirror built on it. The sandbox keeps
  passing `LINEAGE_SEED` into containers (it may also pass `UNITS_SEED`). New recipes may use `units/`
  names.
- Id and key derivations: `H("lineage", ...)` (ids.ts), `lineage-x25519-v1` (agents' published
  encryption keys), `lineage-msg-seal-v1` (HKDF info: changing it makes sealed messages undecryptable),
  `lineage-episode-v1|` (episode ids), `lineage-soul-variety-v1` (soul generator determinism),
  `lineage-link-v1` (ERC-8004 service version string already published). Test fixtures that hash
  `"lineage"` (`onchain/scripts/make-fixtures.ts`, wallet-e2e) also stay: they pin committed fixtures.
- The sandbox container hostname `lineage` (`packages/sandbox/src/docker.ts`): environment size
  shifts instruction counts, so a different hostname would move every calibrated metric.
- On-chain seeds: none contain the word (checked: every `*_SEED` in the three programs), so nothing to
  freeze there.

### 3.2 Packages and code identifiers (rename)

`@lineage/*` to `@units/*` in every package.json, import, tsconfig path and `bun.lock` (regenerate with
`bun install`, review the diff is names only). Root package `lineage` to `units` (private). CLI bins
renamed; the old bin names stay as second entries in `bin` for one release cycle so scripts and the
owner's habits keep working. Code identifiers containing the brand (`as_lineage`, `lineage-publisher-`
temp prefixes, `lineage-app` committer name, user agents like `lineage-verify-generation`) rename;
identifiers about the concept noun stay.

### 3.3 Env vars (rename with aliases)

A single helper in `@units/protocol` (`env(name)`) reads `UNITS_X` and falls back to `LINEAGE_X`,
logging one deprecation line per process when only the old one is set. All 48 reads go through it.
Writers (deploy.sh, remote.sh, site.env, systemd `Environment=`, `images/worker/Dockerfile`) write
the new names; `/etc/lineage/site.env` keeps working because the reader accepts both. Remove the
fallback no earlier than one release after the site and the owner's local env files use the new names.
Exception: `LINEAGE_SEED` inside sandboxes stays (3.1).

### 3.4 Core database (keep tables)

Table and column names stay (`lineages`, `lineage_id`, everything else). Only user-visible strings
change (error messages and status reasons such as `'lineage retired'` are concept words and stay).
No schema migration, so no data migration and nothing for backup/restore to translate. Snapshots
taken before and after the rename restore into either release.

### 3.5 On-chain programs (rename crates, same ids)

- Crates and directories: `programs/lineage-{registry,launch,msg}` to `programs/units-{registry,launch,msg}`,
  lib names `units_{registry,launch,msg}`, `#[program] pub mod units_*`, Anchor.toml keys and
  workspace members, `use lineage_registry::...` paths, the `mainnet` feature wiring.
- What does not change: `declare_id!` values (devnet `CJk3kwUq...`, `Axo38WX6...`, `5uUyWAc9...`;
  mainnet `3GeaTsBU...`, `2vwKsTZm...`, `jmcb7cBA...`), seeds, account and instruction names, so Anchor
  discriminators (`sha256("account:<Name>")`, `sha256("global:<ix>")`, events) are identical and every
  client, indexer decoder and existing account keeps working. Error variant names may change (codes
  are positional); none needs to.
- Keypairs: the build looks for `target/deploy/<lib>-keypair.json` and **generates a new one if it is
  missing**. Before the first build under the new names: back up `onchain/target/deploy/*` to
  `~/.config/units/program-keys-backup-<date>/` (plus the existing `onchain/keys-backup/`), then COPY
  each `lineage_<x>-keypair.json` to `units_<x>-keypair.json` and check the pubkey of each copy equals
  its `declare_id!`. Never delete, regenerate, `cargo clean` or remove `target/`. Same for
  `~/.config/lineage/{program-keys,devnet-v2-program-keys,mainnet}` (copies, not moves).
- Build: `anchor build` (devnet ids) and `cargo build-sbf --features mainnet` as today. The `.so`
  bytes change (crate names are in symbols and panic paths), so: record new sha256 values; check each
  new size against the deployed ProgramData length and `solana program extend` first if it grew
  (onchain/DEVNET.md "Exact --max-len"); measure deployer balance and buffer rent before sending.
- Devnet upgrade in place: `solana program deploy --program-id <existing id> -k ~/.config/units/devnet-deployer.json -u devnet`
  (keypair path passed explicitly, never `solana config`), one program at a time, verify with
  `solana program dump` + sha256 against the local build. If IDLs were published on chain
  (`anchor idl init`), upgrade them with `anchor idl upgrade` (the IDL `metadata.name` changes; the
  layout does not). The site needs no change for this step (ids are the same).
- Mainnet: no transaction. Mainnet ids unchanged; the renamed build for mainnet is produced and hashed
  locally only.
- Audit: `docs/audit/SCOPE.md` tree hashes, line counts and binary hashes change because paths and
  names change. Regenerate SCOPE (new tree hashes, a note mapping old paths to new and stating the
  change is names only, with the `git diff -M` showing renames), BUILD-AND-TEST run log, ARCHITECTURE
  and REVIEW-AREAS paths. Rerun the LiteSVM suite (`onchain/tests`) and the mainnet fork rehearsal
  (`scripts/mainnet/fork.sh`, ports 9690-9693 / 9700+ as that lane defined) and record both runs.

### 3.6 Signed statements (versioned dual acceptance)

Every statement signature covers `H("lineage-<purpose>-v1", canonicalJson(statement))`, and many
statements carry `kind: "lineage-<x>"` inside the signed JSON. Changing either breaks every existing
signature (follows, reactions, media, links, journals, identity tokens, genesis proofs, opt-ins,
reputation credentials).

- Verifiers accept both: `verifyStatement` tries `units-<purpose>-v1` then `lineage-<purpose>-v1`;
  kind checks accept `units-<x>` or `lineage-<x>`, but the kind and the digest domain must agree
  (a `units-*` kind only under the `units-*` domain, so an old signature cannot be relabelled).
- Signers (Core, identity, runtime, souls, web wallet `apps/web/wallet/identity.ts` and
  `pages/social-ui.ts`, scripts) sign with `units-*` only after the verifiers that will read them are
  deployed: the site release with dual verify goes out first, signing switches in the next release.
- Stored statements are never rewritten; proofs and credentials already published stay valid.
- Tests: one fixture per statement kind signed under the old domain must still verify; a `units-*`
  kind under a `lineage-*` domain (and the reverse) must fail.

### 3.7 Commit trailers and mirror branches

The mirror builds a deterministic chain per lineage and force-pushes `lineage/<recipe>-<l8>` when the
tip differs; Core records commit shas; agents' signed commits show Verified. Changing trailer text or
branch names rebuilds every commit with new shas (all published history and Verified badges replaced).

- Existing chains: frozen format v1 (`Lineage-*` trailers, `lineage/*` branches). The chain builder
  takes the format from the chain's first commit on GitHub (or a per-lineage format field in Core),
  so a rerun never rewrites published history.
- Chains started after the cutover: format v2 with `Units-*` trailers and `units/*` branches.
- Parsers (`packages/mirror/src/verify.ts`, `packages/core/src/gen-github.ts`, the generation page's
  verify instructions) accept both prefixes, never a mix within one commit.
- Owner question Q3: if the owner prefers one look on GitHub over keeping history, a one-time rebuild
  of every chain under v2 is possible; it changes every mirrored sha and is not the default.

### 3.8 Server (zero data loss, zero downtime)

Order: compat release first, then names. Every step is in `remote.sh` (a `migrate-units` mode plus
hooks in `activate`), rehearsed on the dry-run container (`scripts/deploy/dryrun.sh`) before the site.

1. Compat release: code reads both env names (3.3), both statement domains (3.6), both trailer
   prefixes, both Docker labels; unit files still named `lineage-*`. Normal activate.
2. Paths, no gap: create `/opt/units -> /opt/lineage`, `/var/lib/units -> /var/lib/lineage`,
   `/etc/units -> /etc/lineage`, `/etc/units-core -> /etc/lineage-core`,
   `/etc/units-identity -> /etc/lineage-identity` as symlinks. Nothing moves; both names work.
3. Units release: unit files `units-*.service` reference the new paths and are installed next to the
   old ones. `User=` is substituted at install time with whichever account exists (`units-core` if
   renamed, else `lineage-core`), so unit files never name a missing user. Activate switches each
   public unit in the existing health-checked order: stop `lineage-X`, disable it, start `units-X`,
   health check, same port (seconds per unit; Caddy, the gate and web already retry refused dials).
   Background units: `units-verifier@.service` and `units-author@.service` carry
   `Conflicts=lineage-verifier@%i.service` and `After=lineage-verifier@%i.service`, so systemd starts
   the new instance only after the old one has drained and exited; they never run together on one
   `pending.json`. Rollback reinstalls the old unit files and reverses the switch (activate's rollback
   path, extended to know both names).
4. Users, when idle: `remote.sh migrate-users` renames accounts in place with `usermod -l` and
   `groupmod -n` (UIDs and GIDs unchanged, so file ownership needs no chown), only for an account with
   no running process (it checks and defers otherwise), then reinstalls the unit files so `User=`
   picks the new name. Home `/home/lineage` becomes `/home/units` with a symlink back;
   `LINEAGE_HOME`/`UNITS_HOME` point to the new path.
5. Directory flip (optional, any time after every unit uses the new names): make the real directory
   carry the new name with an atomic exchange (`renameat2(RENAME_EXCHANGE)` via `mv --exchange` when
   coreutils is 9.5 or later, else a small perl `syscall` helper), then atomically replace the old
   name with a symlink to the new one. The new name resolves at every instant. Old names stay as
   symlinks indefinitely; removing them is not part of this plan.
6. Caddy log file `lineage-access.log` to `units-access.log` (new file; the old one is kept).
   The Caddyfile has no brand in host names.
7. Backups: `backup.sh` and restore read either path (the symlinks guarantee that); snapshot names
   keep their format. A restore-test is run after steps 3 and 4.

Verify after each step: `deploy.sh status`, health of all public units, `monitor` checks, the e2e
verify count, and the site serving with no 5xx in the Caddy log for the switch window.

### 3.9 GitHub artifacts (accept both, write new)

- `lineage-proof.json` (genesis proof in agent profile repos): verifiers and the proof page accept
  `units-proof.json` or `lineage-proof.json`; new proofs are written as `units-proof.json`; existing
  ones are left in place (they verify under 3.6). The README markers `<!-- lineage:genesis v1 -->`,
  `<!-- lineage:status:start/end -->`: the updater finds either and writes `units:` markers on its
  next status update (replacing the block between whichever markers it found).
- `lineage-learnings` repos: rename each through the GitHub API (`PATCH /repos/{owner}/{repo}`), which
  keeps a redirect from the old URL; code uses `units-learnings` and falls back to the old name when
  the new one does not exist yet. The episode schema becomes `units-episode/1`; readers accept both;
  published episodes are not rewritten; episode ids keep the frozen derivation (3.1).
- Mirror branches and trailers: 3.7. App committer `lineage-app@lineage.invalid` becomes
  `units-app@units.invalid` for v2 chains only (v1 chains are deterministic and keep it).
- SSH signing key titles `lineage agent <id>`: new keys get `units agent <id>`; existing keys keep
  their title (renaming is cosmetic and not exposed by the API as an edit).
- The repo itself: owner action (section 4). After the rename, `git remote set-url` locally and in
  the server release fetch config; GitHub redirects the old URL meanwhile.

### 3.10 Docker

- Done in the compat step: sandbox and local desktop containers carry both labels and sandbox
  cleanup matches either; the desktop host gateway accepts either label. Remote desktop containers
  (`packages/desktop/src/remote.ts`) add `units=1` only after every desktop host runs the new gateway
  (an older gateway refuses unknown labels).
- Containers: new ones carry both `lineage=1` and `units=1` during the transition; every lookup
  (sandbox cleanup, desktop pool, the desk gateway's allow rule in `lineage-desk-gw`) matches either
  label, so containers started by an old release are still found and cleaned. After one release,
  new containers carry only `units=1`; lookups keep accepting both. Never prune; only labelled
  containers are touched.
- Images: `lineage/worker` and `lineage/desktop` rename to `units/*` (tagged under both names for a
  release). Sandbox class images (`python`, `rust`, `go`, `zig`, `cpp`, `cuda`, `solana`) keep their
  `lineage/<class>` names because recipes pin them (3.1); `scripts/local-images.ts` may also tag
  `units/<class>` aliases of the same image id. Image contents are not edited (a changed Dockerfile
  changes the pinned id).
- The desktop image's `/etc/lineage-desktop` becomes `/etc/units-desktop` with `DESK_ETC` already
  overridable; the image tag changes with it.

### 3.11 Web, embed, browser state

- Copy: site title "Lineage Network" becomes "units"; every visible brand string, meta tags, OG
  text, docs site, embed attribution. Chaitanya edits `apps/web` actively: pull before each commit,
  rename only brand strings in his files, never revert or reformat his work, and leave anything he is
  mid-change on for a follow-up.
- Embed: `<units-*>` elements defined; each `<lineage-*>` is also registered as an alias class so
  embeds already pasted on third-party pages keep rendering. `window.Units` with `window.Lineage`
  pointing to the same object; `units-ready` and `lineage-ready` both fired; `UnitsConfig` read
  first, `LineageConfig` as fallback. The `/embed` script URL keeps its path.
- Storage keys: on load, read the `units-*` key, else the `lineage-*` key and copy it over (the old
  key is left, so a rollback still finds it). Keys: `lineage-wallet`, `lineage-theme`,
  `lineage.deck.v1`, `lineage-gh:*`, `lineage.created`, `lineage.status`. In-page event
  `lineage:event` renames (same bundle, no compatibility needed).
- API paths: no brand in them (`/v1/lineages` is the concept noun). Cookies: none carry the name.
- Tests: `bun run test:ui` (Playwright) selectors and title assertions updated in the same commit.

### 3.12 Local machine

- `~/.config/lineage` holds secrets (deployer, program keys, mainnet program keys, model and
  provider env files, backup age key). Steps: make a backup copy first
  (`cp -Rp ~/.config/lineage ~/.config/lineage.bak-20261010`, mode 700, verified by file count and
  checksums, never printed), then `mv ~/.config/lineage ~/.config/units` and
  `ln -s units ~/.config/lineage` in one command so other sessions using the old path keep working.
  Code and docs use `~/.config/units`; the symlink stays.
- `~/.lineage` (local worker home): same move plus symlink, done while no local worker runs.
- The owner's review server on :9662 runs from a separate worktree that follows origin/main: not
  touched. It keeps working through the env aliases and path symlinks when it pulls the renamed code.
- `~/lineage` checkout itself: renaming the directory is an owner choice (Q4); other sessions and
  memory files reference the path, so the default is to leave it.

### 3.13 Docs and prose

Every doc (SPEC, RUNBOOK, DEPLOY-SITE, AUDIT, EMBED, plans, READMEs, CLAUDE.md title) gets the brand
renamed by hand, keeping the concept noun. Historical records (DEVNET.md signatures, audit run logs,
DRYRUN-LAST.json and PROOF-LAST.json outputs) keep what was true when written; they get a one-line
note that the project was named Lineage then. File names: `docs/plans/*` keep their names.

## 4. Owner actions (only the owner can do these)

1. Rename the GitHub repo `plsdontcallmyfone/lineage` to `plsdontcallmyfone/units` (Settings,
   Repository name). GitHub redirects the old URL for clones, pushes and links.
2. Rename the Vercel projects behind `lineage-garage.vercel.app` and `lineage-sable.vercel.app`
   (Project Settings, General, Project Name; the `.vercel.app` hostname follows the name, so add the
   old hostname as a redirect domain if links to it are out).
3. Domain: choose and buy one if wanted (the site is on `157-245-71-188.sslip.io`, no brand); then
   it goes into `SITE_NAMES` and Caddy issues the certificate.
4. The hookwars project (`~/hookwars`) was named "units" on 2026-10-09 and needs a new name. This lane
   does not touch `~/hookwars`.
5. Answers: Q1 (concept noun in UI copy), Q2 (`$LINE` ticker and the devnet test mint's metadata
   name "Lineage Test LINE (TEST)"), Q3 (keep mirrored GitHub history or rebuild under v2), Q4
   (rename the `~/lineage` directory).

## 5. Phase 1 execution order

Start only when the docs expansion lane, the agent efficiency lane (DONE f42c060) and the projects
generations analytics lane are DONE in CLAUDE.md; also pull and coordinate with the honest screen and
chrome panel lanes (apps/web/src/live-panel, packages/embed screen/thumb/device). Small parts that do
not overlap any open lane may go first. Each commit is one area, pulled with `--rebase` first, tests
green, pushed to main.

1. Compat layer (no visible change): env helper, dual statement verify, dual trailer parsing, both
   Docker labels in lookups, embed aliases, storage key migration helper. Deploy to the site.
2. Packages and code: `@units/*`, bins, identifiers; `bun install`; `tsc`, `bun test` every package,
   `scripts/e2e.ts`.
3. Programs: keypair backup and copies, crate renames, builds, LiteSVM, fork rehearsal, devnet upgrade
   in place, DEVNET.md and audit SCOPE refresh.
4. Deploy and server: systemd `units-*`, remote.sh migration modes, dry-run container rehearsal, then
   the site (3.8 steps 2 to 5), restore-test, monitor.
5. Web, embed, docs copy: wordmark, title, docs site, `bun run test:ui`, deploy, Vercel build.
6. Signing switch: signers move to `units-*` domains and kinds (after step 1 has been live).
7. GitHub artifacts: learnings repo renames, `units-proof.json`, markers, v2 chains for new lineages.
8. Local paths: `~/.config/units` with backup and symlink; Anchor.toml wallet path.
9. Final scan: `scripts/rebrand/inventory.py` must show only the keep/frozen/alias categories, each
   remaining occurrence explained by this plan.

Checks run before calling it done: tsc, bun test (all packages), LiteSVM, scripts/e2e.ts,
`bun run test:ui`, site deploy with end-to-end verify, restore-test, and a devnet dump hash match for
each upgraded program. Devnet only; no mainnet transaction at any step.
