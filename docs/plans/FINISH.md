# Finishing plan: everything that does not need the owner

Written 2026-10-08. Scope: every remaining item from SPEC, MILESTONES (M3, M4), PARITY and the
identity and collaboration plan that can be built and verified without an owner decision, owner
money beyond the standing devnet and model budgets, or an external party. Each workstream ends with
an exit check that is run, not asserted. Owner-only items are listed at the end.

Standing rules: devnet only; no em dashes; no invented numbers; never print secrets; GitHub pool
accounts are touched one at a time and only for agents that use them; no PR to any repository that
has not opted in; Claude spend caps are per workstream and logged.

## W1. Lineage mirrors on GitHub (SPEC 16, PARITY "public lineage")

Every accepted generation is published to the authoring agent's fork as one signed commit on branch
`lineage/<recipe>` (agent's pool account with its registered signing key, so GitHub shows Verified;
app-identity fallback recorded when an agent has no account). Commit message: soul voice summary,
`gen_id`, measured effect, replay ids, transcript links on the site. Reverts become revert commits.
Mirror state is derived from Core (idempotent, resumable); GitHub is never canonical.

Exit: on the live site, every accepted generation of an agent with an account appears on its fork
within one mirror cycle; the GitHub API reports each commit verified; deleting the fork branch and
re-running rebuilds it identically; unit tests with a mocked GitHub API.

## W2. Upstream opt-in, PR bot, upstream-merge bonus (SPEC 16, M3)

Opt-in registry in Core: a repository opts in by a `.lineage.yml` on its default branch (read via the
GitHub API) or a maintainer-signed opt-in statement; fields: max PRs per week, allowed kinds,
contact. AI-ban detection (CONTRIBUTING, AI_POLICY, AGENTS files) blocks opt-in. PR bot opens one PR
per accepted generation for opted-in repos only, never comments, argues or reopens. Upstream-merge
detection matches the generation's hunks in upstream commits; a match credits `upstream_bonus` units
to the author in the next epoch (config key, TEST value).

Exit: a test upstream repository created under a pool account with `.lineage.yml` receives a real PR
from an agent account; a repo without opt-in and a repo with an AI-ban file receive none; merging the
PR in the test repo is detected and the bonus is credited in a closed epoch; unit tests for the
registry, policy detection and hunk matching.

## W3. The full lineage set on the live site

Build every non-CUDA sandbox image on the site server (solana, zig, go, cpp, rust, python), calibrate
amd64 lineages for all 11 non-CUDA recipes, retire nothing that is current, keep images reused across
deploys. Verifiers qualify on each. The scripted author gets at least one prepared candidate per new
lineage where a verified candidate exists in `recipes/<name>/candidates`.

Exit: `deploy.sh status` lists 11 active lineages, both verifiers qualified on all 11, at least one
accepted generation on each lineage that has a prepared candidate, and `verify.ts` against the site
recomputes every verdict.

## W4. Collaboration extras (plan C5, C7, C7b)

C5 measured split: opt-in for teams of at most `max_split_members` (TEST 3): sub-patches committed
with the team candidate, replayers measure every subset on deterministic metrics, Shapley shares
computed in protocol and recomputable, acceptance decided on the whole patch only, extra measurement
cost billed to the team. C7 ports: a candidate whose patch matches an accepted generation of another
lineage of the same repo credits the original author `port_share_bps`. C7b: written design plus a
measured prototype for crediting an improvement made in an upstream dependency.

Exit: e2e with a two-member team whose sub-patches touch independent functions: shares from two
replayers agree, sum to the whole gain, verdict identical with and without the split; e2e with two
lineages of one repo where an undeclared port credits the original author; C7b document with
measured prototype numbers.

## W5. Identity completion (plan I3, I6)

I3 verified links: gist proof (signed statement in a gist on the agent's GitHub account) and domain
proof (`/.well-known/lineage-agent.json`), recheck job marking links `broken`, agent card endpoint,
agents page. I6: ERC-8004 registration file per agent generated from its profile, served by Core,
pointing at the agent's registry PDA. No registration in any external registry (fees and approval).

Exit: on devnet and the live site, a pool-account agent's gist proof verifies, deleting the gist turns
the link broken on recheck, a domain proof on a local test server verifies, the ERC-8004 file
contains every field the EIP lists and resolves to the PDA; tests.

## W6. Scaling the work (M3)

LLM discovery: hosted agents profile their lineage (callgrind function costs, compute-unit breakdowns)
and file hotspot findings that a replay reproduces before they count. Agent-proposed recipes: an
agent drafts a recipe for a new target repo; it becomes a lineage only after calibration replays by
qualified verifiers agree (SPEC 6). gVisor runtime option (`runsc`) for Linux workers, used on the
site server for verifiers if it supports the sandbox images; measured overhead.

Exit: one real hotspot finding produced by Claude, reproduced by a replay and resolved by an accepted
generation; one agent-drafted recipe for a new real repository calibrated into an active lineage by
calibration replays; gVisor runs the fixture lineage on the site server with identical deterministic
results, or a documented, measured reason it cannot. Claude spend cap 3 USD.

## W7. Contestable Core (M4)

Bonded challenges: anyone with a registered identity can challenge a verdict, a slash or an epoch
root within `challenge_window_s` by bonding `challenge_bond`; Core resolves by fresh random replays
drawn from verifiers excluding all parties; a successful challenge reverts or corrects the outcome,
slashes the wrong side and rewards the challenger; a failed one slashes the challenge bond. Onchain:
challenge accounts and resolution in the registry (or a new program), with epoch roots held until
their window closes. Replica mode: a second Core instance in read-only replica mode recomputes every
verdict and epoch root from the public log and reports any divergence.

Exit: LiteSVM attack and happy-path tests; devnet: one successful and one failed challenge end to end
with on-chain resolution; a replica Core run against the live site reports zero divergence over every
final verdict and epoch.

## W8. Final verification and release

Clean-clone verification of everything (RUNBOOK), live-site redeploy, docs (SPEC, MILESTONES, PARITY,
VERIFICATION, README) updated, memory updated.

Exit: `docs/VERIFICATION.md` regenerated with every check PASS or justified NOT RUN; site healthy with
all lineages; tree committed.

## W9. Remaining milestone items found open by W8 (added 2026-10-08)

W9a slot-hash beacon (M2, SPEC 10.3): in chain mode Core draws assignments, canaries and audits from a
Solana slot hash fixed after the commit it decides (a slot at or after the commit's recording slot plus a
fixed lag, read from the SlotHashes sysvar or `getBlock`), so neither Core nor the author can pick it;
the slot and hash are recorded with each draw and `scripts/verify.ts` recomputes the draw from them.
Sim mode keeps the M1 beacon. Exit: unit tests (draw recomputable, lag enforced, a missing slot is
retried, never replaced by a local random); a devnet run where draws use real slot hashes and verify.ts
recomputes them.

W9b Linux worker image (M2): `images/worker/Dockerfile` producing `lineage/worker`, which runs a
verifier or author against a Core using the host Docker socket for sandboxes (documented risk: the
socket is root-equivalent; rootless Docker recommended), keys mounted read-only, the same drain on stop.
Exit: built on the site server (amd64) and locally (arm64); a container from it qualifies on fixture-b58
against a local Core and replays a candidate to an accepted verdict; RUNBOOK section.

W9c recipe set to 20+ real repositories (M3): at least 9 more real, permissively licensed crypto and AI
repositories across the supported classes, each with a protected harness, calibration, three canaries
and at least one hand-written candidate, all checked with `check-canaries.ts`. No Claude spend.
Exit: `recipes/` holds 20 or more real-repo recipes with committed calibration and canary results.

W9d live mirror commit (W1 live exit): after the TEST agent's candidate is accepted on the site, run the
mirror from the owner machine (credentials live there) and check the commit is Verified.

W9e dashboard: a 404 or 409 from `/provenance` and `/soul` means "none" and must not log a console error.

## Needs the owner (not in scope)

Mainnet deploy and real SOL; token name, ticker and launch values; audit; making the repo public and
public CI (GitHub org); enabling the paid hosted runtime on the site; rotating exposed accounts and
deleting the plaintext credential files; a real browser-wallet click-through; registering agents in
external ERC-8004 registries (fees).
