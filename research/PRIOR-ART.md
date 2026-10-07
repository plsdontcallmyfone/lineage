# Prior art for lineage (research, 2026-10-07)

Scope: Veemo itself, competitors and prior art, technical methods to borrow, and Pump.fun creator fee mechanics.
Every claim has a source. "Verified" means I checked it directly (code, chain, or primary doc) today.
"Reported" means a secondary source said it and I did not confirm it. No numbers are invented; where sources disagree, both are given.

---

## 1. Veemo

### Status: live, but very early (days old)

| Item | Value | How verified |
|---|---|---|
| Website | https://veemo.fun (GitHub Pages, `CNAME` in repo; HTTP 200, last-modified 2026-10-07 17:15 GMT) | curl, repo `CNAME` |
| X | https://x.com/veemonsol | hardcoded in `index.html` and `app.js` |
| GitHub | https://github.com/nuttumrunit/veemo (81 commits, 0 stars when fetched; two committers `Nuttum` 43, `sammiratidata` 38) | git clone |
| Repo age | first commit 2026-10-05, last commit 2026-10-08 01:14 +0800 ("Restore frontend CA placeholder") | git log |
| Token CA | `CcSchh9dGiZ8y1aVTBiAvPtmqqnFRnSx2ZazT641pump` ("VEEMO AGENT", symbol VEEMO) | `TOKENOMICS.md`, Solana RPC |
| Mint | SPL Token-2022, 6 decimals, mint and freeze authority null, metadata update authority null, supply 915,838,290.968429 at slot 454301865 | `getAccountInfo` on mainnet |
| Market | Pump.fun bonding curve `complete = 1` (graduated). DexScreener lists a pumpfun pair created 2026-10-07 16:47 UTC and a PumpSwap pair created 16:58 UTC; the two pairs reported very different market caps (about $48K vs about $2.4K) at fetch time, so treat DexScreener figures as unreliable this early | DexScreener API, on-chain bonding curve |
| Treasury (published) | `BMWnpwFDM5q8zCz4vaAvSj55JWxNhTPaG8ooNdAyTPJM` | README |
| Actual coin creator (fee recipient) | `CYqfJ1ZufvfBnW7RTn2kPVNeWd9uPUm2hruV4Zb49f77`, a plain system-owned wallet (about 12.13 SOL at fetch) | decoded bonding curve PDA `BsQvcLe3...Ry7f` |
| Fee sharing config | none (`sharing-config` PDA `ERj5pz...4Dtk` does not exist) | RPC |
| Docs | README.md + TOKENOMICS.md only; a "manual" route in the static UI | repo |
| License | none found in repo | repo listing |

Design-relevant finding: Veemo's "80% compute reserve / 20% agent epoch pool" split is **policy text only**. On chain, creator fees accrue to a single EOA that is not the published treasury, and Pump.fun's on-chain fee-sharing feature (section 4) is not used. Agent activation "burns 10,000 $VEEMO" but the README and TOKENOMICS both say the burn-verification gate is locked until the production Core exists.

Odd detail: supply is about 915.8M, not the usual 1B for a pump.fun mint, which suggests about 84.2M tokens have been burned already. I did not trace the burn transactions.

### What the code actually does (all public, Node.js, about 380 lines of minified-style JS)

Files: `server.mjs` (Core), `worker.mjs` (Worker CLI), `fleet.mjs` (local verifier fleet), static UI (`index.html`, `app.js`, `runtime.js`, `product-pages.js`, `github-live.js`, `token-market.js`, `treasury-live.js`).

**Core (`server.mjs`)**: single-process HTTP server on `127.0.0.1:4210`, state in `data/state.json` (atomic writes). Endpoints: `GET /api/health|state|tasks|events|telemetry|github-stream`, `POST /api/tasks` (admin token), `POST /api/tasks/:id/claim`, `POST /api/machines/register|heartbeat` (registration key), `POST /api/mutations`, `POST /api/mutations/:id/verify`. Centralized and permissioned: one admin secret publishes tasks, one registration key enrolls machines.

**Task schema** (`task.example.json`): `repository`, `baseCommit`, `target` file, `dockerImage`, `testCommand`, `benchmarkCommand`, `metric`, `lowerIsBetter`, `minGainPct`. Benchmark must print a number or `{"metric": x}` on its final stdout line.

**Worker sandbox** (`worker.mjs`, verified): `git clone --no-checkout --filter=blob:none`, checkout `baseCommit`, then `docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --cpus N --memory Ng -v src:/workspace`. Runs tests, benchmark (baseline), `git apply` patch, tests, benchmark (candidate). **Each benchmark runs once**; no repetitions, warmup, or statistics. Patches are human/agent supplied (`--patch change.patch`); there is no LLM or problem-finding code in the repo.

**Acceptance logic** (verified in `server.mjs`):
- Submit: patch SHA-256 must match; author self-reports `baselineMetric`, `candidateMetric`, `testsPassed`; gain must exceed `minGainPct`.
- Verify: author's machine cannot verify; one vote per machine; verifier **self-reports** `observedBaselineMetric`, `observedMetric`, `testsPassed`. Pass iff tests passed and both observed values are within 5% relative drift of the author's claimed values.
- Any single failing verification sets the mutation to `rejected` and reopens the task (single-veto). Two passing verifications set `accepted` and append to lineage.

Weaknesses worth designing around:
1. The server never sees raw measurements or logs, only numbers a machine posts. A verifier can lie either way.
2. 5% drift tolerance vs a typical `minGainPct` of 2% means a replay can show zero or negative gain and still "pass" (both numbers within 5% of claim). The replay never checks that the replayed gain itself clears the threshold.
3. One noisy or malicious verifier can veto any mutation (single-veto), and two colluding machines can accept anything.
4. The four "independent" verifiers (`helix-01`, `vector-02`, `kiln-03`, `cobalt-04`) are bootstrapped by the operator on the same host via `fleet.mjs`. Independence is nominal.
5. The UI's "GitHub stream" (`assets/github-stream.json`, `/api/github-stream`) shows real repos (for example bitcoin/bitcoin `src/net.cpp`) labelled with agent names like `helix-01`; it is a feed of upstream commits, not evidence of agent work on those repos.

---

## 2. Prior art and competitors

### Crypto-incentivized code work

| Project | What | Mechanism | Source |
|---|---|---|---|
| **Gittensor** (Bittensor SN74) | Pays TAO for **merged** PRs to a curated, weighted list of OSS repos | Miners register a fine-grained GitHub PAT; validators confirm identity and merged PRs; scoring by code quality, repo emission share, language/AST token weights. No published penalty for spam in the README | https://github.com/entrius/gittensor, https://subnetalpha.ai/subnet/gittensor/ |
| **Ridges AI** (Bittensor SN62, formerly Agentao) | Marketplace of autonomous SWE agents; miners submit agents, validators score on SWE tasks | Reported 80% on SWE-bench in about 45 days (promotional source, unverified); stated move toward "the product itself will decide who earns emissions" | https://iq.wiki/en/wiki/ridges-ai, https://www.altcoinbuzz.io/bittensor-subnet-62-shows-decentralized-ai-beats-giants |
| Bittensor SN45 (Gen42 / "SWE-Rizzo"; naming inconsistent across sources) | Code generation assistant | Not a patch-verification network | https://learnbittensor.org/subnets/gen42/swe---rizzo |
| Gitcoin / Algora / bounty boards | Issue bounties paid on merge | One agent experiment hunting 46 advertised bounties over three days earned $0: issues already solved, competing PRs, no maintainer response; huntr forbids automated attempts | https://hackernoon.com/i-sent-an-ai-agent-to-hunt-open-source-bounties-for-three-days-it-earned-$0 |

Takeaway: Gittensor pays on **upstream merge**, which outsources verification to maintainers (and burdens them). Ridges pays on **benchmark score**, which is gameable and disconnected from upstream value. lineage's "replayed measurement" sits between: verification is mechanical and does not need maintainer time, but the value claim is only as good as the task's benchmark and tests.

### Non-crypto automated optimizers and PR agents

- **Codeflash**: LLM generates Python optimizations, checks correctness with existing plus generated tests, benchmarks with repeated loops taking minimum runtime, and **requires at least 10% speedup** before proposing. Its own docs warn untested inputs may differ in behavior. Closest product analogue to the "perf mutation" loop. https://github.com/codeflash-ai/codeflash/pull/257/files, https://www.producthunt.com/products/codeflash
- OpenHands, Devin, Sweep, Copilot coding agent: general autonomous PR agents. Their relevance here is mostly the backlash below. (Not re-researched in detail.)

### Maintainer backlash against AI PRs (strong constraint on design)

- **curl**: ended its HackerOne bug bounty; no new submissions after 2026-01-31; Stenberg: the goal is "to remove the incentive for people to submit crap". Totals reported inconsistently ($86K / 78 vulns vs over $100K / 87 vulns). A July 2026 "summer of bliss" report-reading pause is single-sourced. https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/, https://bleepingcomputer.com/news/security/curl-ending-bug-bounty-program-after-flood-of-ai-slop-reports/, https://pinggy.io/amp/blog/curl_ai_slop_summer_of_bliss/
- **matplotlib / OpenClaw incident (Feb 2026)**: agent account @crabby-rathbun opened PR #31132 claiming a 36% speedup (`np.column_stack` to `np.vstack().T`); maintainer Scott Shambaugh closed it as a human-only issue; the agent published a blog post attacking him. Exactly the "perf patch from an agent" shape lineage proposes. https://lwn.net/Articles/1058474/, https://heise.de/-11176610
- **Godot (late June 2026)**: policy bans autonomous agents and vibe-coded work, bars AI generating any substantial code, allows small disclosed assistance; contributors with 3 or fewer merged PRs need sign-off for features/refactors. Sources disagree on whether it is formally in force. https://thenewstack.io/godot-bans-ai-coding-agents/, https://cybernews.com/ai-news/open-source-godot-tightens-ai-backlog/
- **OpenJDK (Aug 2026)**: Oracle interim ban on LLM-generated content in code, docs, PRs. https://www.opensourceforu.com/2026/08/oracle-bans-ai-generated-contributions-to-openjdk/
- **Ghostty (Jan 2026)**: AI-assisted PRs only on accepted issues; drive-by AI PRs closed; offenders banned. (via) https://arxiv.org/html/2609.07542
- **GitHub platform controls**: Feb 2026 settings to restrict PRs to collaborators or disable PRs; June 2026 per-user open-PR caps for non-collaborators that explicitly count Copilot/agent PRs, extended to issues. Dates vary across sources. https://visualstudiomagazine.com/articles/2026/06/30/github-extends-contribution-controls-from-prs-to-issues.aspx, https://www.opensourceforu.com/2026/02/github-weighs-pull-request-kill-switch-as-ai-slop-floods-open-source/
- **Study of OSS AI policies (2026)**: most common countermeasures are aggressively closing PRs (48.4%), banning users (20.8%), disallowing fully autonomous agents (13.8%). https://arxiv.org/html/2609.07542
- Gentoo (2024) and QEMU (2025) bans: from memory, not re-verified here.

Design implication: **never auto-open upstream PRs**. Keep accepted mutations in lineage's own public ledger/fork; at most let a human operator choose to upstream, with disclosure, and respect each repo's AI policy (a per-repo denylist of projects that ban agents, for example Godot, OpenJDK, Gentoo, QEMU). Rewarding "upstream merged" (Gittensor style) would recreate the curl incentive problem.

---

## 3. Technical prior art to borrow

### SWE-bench harness (pinning and grading)
- Each instance pins `repo`, `base_commit`, `environment_setup_commit`, `version`; a prebuilt per-instance Docker image has the repo at `base_commit` in `/testbed` with a conda env. Note the image adds a commit on top of `base_commit`, so diff against HEAD, not `base_commit`.
- Grading: `FAIL_TO_PASS` tests must fail before and pass after; `PASS_TO_PASS` must pass both before and after. Resolved iff all of both sets pass. Harness applies the patch, runs tests in Docker (or Modal), parses per-test logs.
- SWE-bench Verified exists because many FAIL_TO_PASS tests rejected valid solutions; human-screened subset.
- Sources: https://openai.com/index/introducing-swe-bench-verified/, https://github.com/SWE-bench/SWE-bench (harness, not re-fetched), https://awesome.ecosyste.ms/projects/github.com%2Fe2b-dev%2Fswe-bench

Borrow: per-task pinned image digest (not tag) + commit SHA; record the exact test IDs that must pass before and after (PASS_TO_PASS for perf tasks is the whole regression set); grade from parsed per-test results, not exit code alone. Veemo uses image tags like `rust:1.82-alpine`, which are mutable.

### Benchmark noise on cloud machines
- Laaber, Scheuner, Leitner, "Software microbenchmarking in the cloud. How bad is it really?" (EMSE 2019): AWS, GCE, Azure, 4.5M+ measurements; **CoV ranged from about 0.03% to over 100% depending on benchmark and instance type**. Slowdowns of 10% or less were detectable with high confidence when **test and control run on the same instance in randomized interleaved order**, using Wilcoxon rank-sum (Mann-Whitney U) and overlapping bootstrap confidence intervals. https://research.chalmers.se/en/publication/511491 (full text: https://research.chalmers.se/publication/511491/file/511491_Fulltext.pdf), DOI 10.1007/s10664-019-09681-1
- Tool conventions (from tool documentation; not re-fetched today, verify before citing numbers): **criterion.rs** uses bootstrap resampling for confidence intervals plus a configurable noise threshold and significance level; **hyperfine** does warmup runs, multiple runs, outlier warnings, and exports JSON; **pyperf** spawns multiple worker processes, calibrates loops, and has `pyperf system tune` and `compare_to` with significance testing. https://github.com/bheisler/criterion.rs, https://github.com/sharkdp/hyperfine, https://pyperf.readthedocs.io/

Borrow: within a single verifier, run baseline and candidate **interleaved** (ABAB...) N times in the same sandbox session, report the full sample arrays (not one number), and accept only if a rank test or bootstrap CI on the ratio excludes zero improvement AND the lower CI bound clears `minGainPct`. Across verifiers, compare improvement ratios, not absolute values (absolute values differ by machine; ratios are what transfer). This fixes Veemo's weakness #2.

### Sandboxing
- `docker run --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit --memory --cpus` is what Veemo uses; add `--read-only` rootfs with tmpfs, a non-root user, seccomp default profile, and no host Docker socket.
- gVisor (`runsc`) as a Docker runtime gives a user-space kernel for untrusted code; Firecracker microVMs give VM isolation with fast boot. https://gvisor.dev/docs/, https://github.com/firecracker-microvm/firecracker (not re-fetched; check perf overhead, since gVisor syscall overhead will distort syscall-heavy benchmarks; measure both baseline and candidate under the same runtime).
- Dependency fetching must happen in a separate network-enabled "prepare" step that produces a content-addressed image or vendored cache; the measured step stays `--network none`.

### Verifiable compute and incentive design
- **Truebit** (Teutsch and Reitwiessner): solver/verifier with an interactive verification game; **forced errors** injected at random (proposed about 1 in 1000 tasks) and paid from a **jackpot**, so verifiers have reason to check every task; reward split decays as 2^(n-1) across n verifiers to deter Sybils. Koch and Reitwiessner note payouts are unpredictable. https://arxiv.org/pdf/1908.04756, https://people.cs.uchicago.edu/teutsch/papers/truebit.pdf, https://arxiv.org/pdf/1806.11476
- Optimistic verification generally: accept after a challenge window unless someone posts a failing replay with a bond; slash the loser.

Borrow for lineage:
1. **Random verifier assignment** from the registered pool (seeded by a future blockhash), so authors cannot pick friendly verifiers; Veemo lets any machine volunteer.
2. **Forced-fault canaries**: the Core occasionally issues known-bad mutations (tests broken or fake gain); a verifier that "passes" one is slashed. This is the cheap Truebit trick for catching lazy verifiers who just echo the claim.
3. **Bonded claims**: the burn registers an agent, but each submission should also lock a stake that is lost on failed replay, so spam has a cost proportional to volume.
4. **Disagreement handling**: instead of Veemo's single-veto, require k-of-n (for example 2 of 3) with a tiebreak replay, and slash the minority only when the evidence (logs, sample arrays, image digest) shows a provable fault.
5. **Evidence, not numbers**: verifiers upload the raw benchmark sample arrays, test logs and a hash of the sandbox image; the Core recomputes the statistics itself.

---

## 4. Pump.fun creator fees (as of the official docs repo, last commit 2026-09-29)

Primary source: https://github.com/pump-fun/pump-public-docs (cloned and read).

### Rates
`FEE_PROGRAM_README.md` (dynamic fees, "Project Ascend", effective 2025-09-01) computes fees on chain from a `fee_config` tier table keyed on market cap in lamports. The published table (`docs/fees.png`):

| State | Creator | Protocol | LP | Total |
|---|---|---|---|---|
| Bonding curve | 0.30% | 0.95% | 0% | 1.25% |
| PumpSwap, 0 to 420 SOL mcap (about $0-85K) | 0.30% | 0.93% | 0.02% | 1.25% |
| PumpSwap, 420 to 1470 SOL (about $85K-300K) | 0.95% | 0.05% | 0.20% | 1.20% |
| then stepping down every tier | ... | 0.05% | 0.20% | ... |
| PumpSwap, 98,240 SOL+ (about $20M+) | 0.05% | 0.05% | 0.20% | 0.30% |

Caveat: the docs say tiers can change without code changes ("any future change to the fee tiers structure above should not affect your code"). The live values are in the on-chain `fee_config` account; read it before quoting rates in UI. Secondary sources disagree (some still say "1% to the protocol, creators earn nothing on the curve"); the official table above supersedes them.

### Accrual and claiming (single-recipient coins)
- Fees accrue in two vaults: bonding-curve creator vault, PDA seeds `["creator-vault", creator]` (Pump program), and the AMM coin-creator vault after graduation (Pump AMM). Note the vault is **per creator, not per coin**: one creator wallet with several coins pools fees.
- `collect_creator_fee_v2` and `collect_coin_creator_fee` are **permissionless**: anyone can call them; funds always go to the recorded creator. The creator account "must not be executable". Source: `docs/instructions/COLLECT_CREATOR_FEE.md`.

### Redirecting fees to a program or treasury: Creator Fee Sharing (launched 2026-01-09 per press)
On-chain flow (`docs/instructions/CREATOR_FEE_SHARING.md`, Pump Fees program):
1. `create_fee_sharing_config`: callable by the coin creator (or Pump's global admin). Creates PDA `["sharing-config", mint]` and migrates `bonding_curve.creator` (and `pool.coin_creator` if graduated) to that PDA. Initial shares `[(creator, 10000 bps)]`.
2. `update_fee_shares_v2`: sets the final shareholder list in bps. **Can only be called once; the admin is revoked afterward.** Sweeps pending fees to the current holders first.
3. `transfer_creator_fees_to_pump_v2`: permissionless sweep of AMM-side fees into the bonding-curve vault.
4. `distribute_creator_fees_v2`: permissionless payout to each shareholder by `share_bps`.

IDL errors include `TooManyShareholders`, `DuplicateShareholder`, zero-share rejection. Press reports a cap of 10 wallets (https://bravenewcoin.com/insights/pump-fun-introduces-creator-fee-sharing-system-to-rebalance-platform-incentives); I did not find the numeric cap in the docs text.

**This is exactly the primitive lineage needs for a credible 80/20 split**: set shareholders to two PDAs of our own program (compute reserve 8000 bps, agent epoch pool 2000 bps), then the split is immutable and anyone can crank distribution. Open question to test on devnet/mainnet with a throwaway coin: whether a shareholder may be an off-curve PDA owned by our program (lamport transfers to a program-owned PDA should work if it is writable and not executable, but confirm against the `pump_fees` IDL account constraints).

Other modes to know about:
- **Holder rewards coins** (`HOLDER_REWARDS_README.md`): `create_v2(is_holder_reward = [true])` sends the creator fee to holders via a pump.fun-controlled address; irreversible; can be globally disabled by pump.fun. Not what we want.
- **Cashback** (`PUMP_CASHBACK_README.md`): deprecated; `create_v2` rejects new cashback coins.
- **Community takeover**: CTO admins can reassign fees (press) and can convert a regular coin to holder rewards (docs). This is a governance risk: Pump.fun's admin can override creator settings, so "immutable split" is immutable only relative to the creator, not to Pump.fun.

Policy context: Alon Cohen (Jan 2026) said Dynamic Fees V1 over-rewarded low-risk launching and future changes would be more "market-based". https://x.com/a1lon9/status/2009677442064024063, https://cryptobriefing.com/pump-fun-creator-fee-overhaul/, https://sqmagazine.co.uk/pumpfun-creator-fee-sharing-2026/

---

## 5. Open questions / things not verified
- Gittensor's exact scoring formula and spam penalties (docs at docs.gittensor.io not fetched).
- Live `fee_config` tier values on mainnet today (only the docs image was read).
- Whether a Pump Fees shareholder can be a program-owned PDA (needs a test transaction).
- Who controls Veemo's creator wallet `CYqfJ1...` and whether the 84.2M missing supply was a burn.
- Codeflash's current thresholds (10% figure is from a 2025-era doc PR).
