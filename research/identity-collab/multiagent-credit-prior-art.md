# Multi-agent co-collaboration and credit assignment: prior art for Lineage

Research lane notes, compiled 2026-10-07. Every claim carries a source number from the Sources list at the end. Where something could not be confirmed from a page actually read, it says "not verified". Numbers from papers are the papers' own reported results, quoted or closely paraphrased, not re-measured.

Lineage context assumed here: agents author bounded patches against a lineage tip; a patch is accepted only if independent replayers measure an improvement in a deterministic metric (for example instruction count), plus tests and equivalence pass; credit is paid in work units.

Ordering follows the brief's priority: human OSS coordination (5), credit assignment math (6), collusion/Sybil/duplicate rules (7), then the agent frameworks (1 to 4).

---

## 5. Coordination patterns from human open source

### 5a. Issue claiming and assignment

What it is:
- Rust: triagebot lets any user self-assign with `@rustbot claim`; `@rustbot release-assignment` or `@rustbot unclaim` removes the assignee, and "Only the current assignee or a team member can release an assignment." Only team members can assign other users. If GitHub will not let the user be assigned directly (no write permission), triagebot assigns `@rustbot` and edits the top comment to say the issue has been claimed. [S1]
- Rust compiler dev guide: abandoned PRs are "often eventually closed and they receive the `S-inactive` label"; anyone can rebase and reopen the work as a new PR if still wanted. Issue searches for newcomers filter to issues with no assignee. [S2]
- Kubernetes: comment `/assign` or `/assign @yourself` and the k8s-ci-robot assigns you; `help wanted` and `good first issue` labels mark claimable work. [S3]
- Kubeflow (explicit rules): "If an issue already has someone assigned to it, that person is actively working on it." "Simply commenting 'I'd like to work on this' without self-assigning doesn't reserve the issue." If several people express interest, "the first person to actually self-assign gets the issue." Stale claims: after 2 to 3 weeks of assignee inactivity you may politely ask; wait for a reply before taking over; maintainers can reassign; there is no automatic unassignment of issues. One assignee at a time. [S4]

Coordination pattern: a single-writer lease on a unit of work, recorded as shared state (the assignee field), granted first-come by a bot command, released by the holder or an admin, with a soft social timeout rather than an enforced expiry.

Limitations: claims are advisory. Nothing stops a second contributor from opening a PR; timeouts are social (2 to 3 weeks, Kubeflow) and require a human to adjudicate [S4]. Claim squatting is handled by maintainers, not by mechanism.

Implication for Lineage:
- A claim is cheap signalling, not exclusivity. In Lineage the acceptance test is objective (replayed metric), so claims should never block a competing patch; at most they should be a coordination hint that reduces wasted compute.
- If claims exist, give them an enforced expiry (lease with a deadline measured in tip advances or wall time) instead of the human "ask politely after 2 to 3 weeks" pattern [S4]; agents will not adjudicate socially.
- Claims should be releasable by the holder and by protocol timeout only, mirroring triagebot's "current assignee or team member" rule [S1].

### 5b. Stacked diffs / stacked PRs

What it is:
- Graphite guide: "Stacked diffs refer to a series of changes where each change depends on the previous one." Each diff is its own PR, reviewed independently, each "should pass all tests before merging"; tools "automatically rebase the stack as diffs are merged". The guide traces the practice to patch-series review in open source, later formalised in Phabricator (Differential) and Google's Critique. [S5]
- ghstack (Edward Yang): "Conveniently submit stacks of diffs to GitHub as separate pull requests", one PR per commit. Each commit pushes three branches: `gh/username/N/base` (never force-pushed), `gh/username/N/head` (PR merges head into base), `gh/username/N/orig` (the local commit). Updating = amend the commit and rerun. Conflicts "must be resolved in each PR in the stack". Stacked PRs cannot be merged via the normal GitHub UI; use `ghstack land`. Requires write access to the target repo. [S6]

Coordination pattern: a linear dependency chain of small, individually testable changes, each with an explicit base pointer; landing is ordered; downstream changes are rebased when upstream ones change.

Limitations: every rebase of an upstream diff invalidates downstream review/test results; conflicts are resolved per layer [S6]; tooling needs write access and leaves stale branches [S6].

Implication for Lineage:
- A Lineage patch is naturally a stack element: it names its base tip. A stack of patches by one or several agents maps to ghstack's base/head model [S6]. Each element must independently pass replay, tests and equivalence, like "each diff should pass all tests before merging" [S5].
- Credit for a stack element should be measured against its own base, not against the original tip, otherwise early elements absorb later gains. But this makes credit order-dependent (see section 6 on interactions).
- When an upstream element is rejected or changes, downstream measurements are stale and must be re-replayed; budget for this.

### 5c. Co-authored-by trailers

What it is: GitHub recognises one `Co-authored-by: NAME <email>` trailer per co-author at the end of the commit message, after a blank line. For the commit to count as a contribution, the email must be associated with the co-author's GitHub account; private users should use their GitHub no-reply address. [S7]

Coordination pattern: multi-party attribution recorded inside the immutable commit object as free-text trailers; attribution is binary (listed or not), with no weights.

Limitations: no shares or weights; anyone can add any trailer (the source describes no verification beyond email-to-account matching) [S7].

Implication for Lineage:
- Trailers are a good on-patch carrier for "who contributed" but are unauthenticated and unweighted. Lineage needs signed contributor entries plus explicit split fractions if it pays co-authored patches; a bare trailer would invite padding (Sybil co-authors).

### 5d. Developer Certificate of Origin (DCO)

What it is: DCO 1.1 (copyright 2004, 2006 The Linux Foundation and its contributors) is a per-contribution certification, signed off in the commit, that (a) the contributor created it and has the right to submit it under the indicated licence, or (b) it is based on appropriately licensed previous work, or (c) it was provided by someone else who certified (a), (b) or (c) and was not modified, and (d) the contributor agrees the contribution and sign-off record are public and kept indefinitely. [S8]

Coordination pattern: per-patch provenance attestation; the chain clause (c) lets work pass through intermediaries with the original certification intact.

Implication for Lineage:
- A DCO-like signed attestation per patch ("I authored this or relay a certified patch unmodified") gives a provenance chain that relayers and aggregators must preserve, which matters if agents forward or rebase each other's patches [S8]. It does not by itself prevent copying; acceptance-time duplicate rules (section 7) must do that.

---

## 6. Credit assignment

### 6a. Shapley value basics and exact cost

- Data Shapley (Ghorbani and Zou, arXiv 1904.02868, submitted 2019-04-05) treats each training source as a player and the trained model's score V(S) as the coalition value; equivalently phi_i = E over uniformly random permutations pi of [V(S_i^pi union {i}) - V(S_i^pi)], where S_i^pi is the set of players before i in pi. The paper says exact computation "requires exponentially large number of computations with respect to the number of train data sources". [S9]
- Leave-one-out is defined there as phi_i = V(D) - V(D - {i}) and rejected because it does not satisfy the equitable-valuation conditions (null player gets zero, symmetric players get equal value, additivity). [S9]
- Jia et al. (arXiv 1902.10275, 2019): evaluating the exact Shapley value "involves computing the marginal utility of every user to every coalition, which is O(2^N)"; in its most general form the Shapley value "can be #P-complete to compute". [S10]
- Jia et al. KNN paper (arXiv 1908.08619): "it requires O(2^N) model evaluations for exact computation and O(N log N) for (epsilon, delta)-approximation" for general bounded utilities; for unweighted KNN the exact value is computable in O(N log N) time. [S11]

### 6b. Approximations and their evaluation counts

| Method | Cost statement (quoted or close paraphrase) | Source |
|---|---|---|
| Exact Shapley | O(2^N) utility evaluations | [S10][S11] |
| Monte Carlo permutation sampling (baseline) | permutations needed for (epsilon, delta) approx: m_perm = (2 r^2 N / epsilon^2) log(2N/delta), r = utility range; each permutation costs N evaluations, so m_eval = O(N^2 log N); if the model is incrementally trainable, model trainings = O(N log N) | [S10] |
| Maleki et al. sampling (as summarised by Jia et al.) | O(N log N) samples for l-infinity error, O(N^2 log N) for l2 error | [S10] |
| Group-testing estimator (Jia et al.) | O(N (log N)^2) model evaluations with provable error; O(log log N) model trainings if utility is monotone, values are sparse and the model is incrementally maintainable | [S10] |
| Truncated Monte Carlo (TMC-Shapley) | scan a random permutation; once V(S) is within a "performance tolerance" of V(D) (set from bootstrap variation of V), set remaining marginal contributions to zero; repeat until convergence. Paper reports "substantial computational savings without introducing significant estimation bias" (no closed-form count given) | [S9] |
| Gradient Shapley | Monte Carlo plus one-epoch gradient updates instead of retraining (described as a second approximation in the abstract; details not extracted) | [S9] |
| Leave-one-out | N+1 evaluations (one per removed player plus the full set); follows from the definition phi_i = V(D) - V(D - {i}) in [S9]; the count itself is my arithmetic, not a quote | [S9] |
| KernelSHAP | Shapley values as the solution of a weighted linear regression; "requires fewer evaluations of the original model to obtain similar approximation accuracy" than Shapley sampling; exact regression form has complexity O(2^M + M^3) for M features. Max SHAP computes a max function's Shapley values in O(M^2) instead of O(M 2^M) | [S12] |
| Distributional Shapley | claims an estimator "two orders of magnitude faster" than prior data Shapley estimators, with formal guarantees | [S13] |

Reported Data Shapley results (quoted from abstract): Shapley "is more powerful than the popular leave-one-out or leverage score in providing insight on what data is more valuable"; "low Shapley value data effectively capture outliers and corruptions". [S9]

### 6c. Interactions between contributions

- Shapley interaction index (Grabisch and Roubens, International Journal of Game Theory 28, 1999, pp. 547 to 565): for a pair {i, j}, I(ij) = sum over T subset of N minus {i, j} of [t!(n - t - 2)! / (n - 1)!] * [v(T u {i, j}) - v(T u {i}) - v(T u {j}) + v(T)]. Positive means complementarity (synergy), negative means redundancy; on singletons it equals the Shapley value. Source for this formula: a web search summary pointing to Grabisch and Roubens and Marichal's papers; I did not open the original paper, so treat the exact normalisation as not verified. [S14]
- Compiler optimisation interaction is the classic domain where per-change contributions are order-dependent: Kulkarni, Whalley, Tyson, Davidson state that "different orders of applying optimization phases by a compiler typically result in different code generated, with potentially significant performance differences" and that "a single ordering of optimization phases will not produce the best code for all functions or applications"; they make exhaustive phase-order evaluation feasible for most functions by pruning the search space. Venue (ACM TACO 2008) inferred from the file name, not verified on the page. [S15] A KU thesis (Jantz, supervised by Kulkarni) states phases "interact with each other, enabling and disabling opportunities for successive phases" and that several interactions come from false register dependences (read via search summary only, not verified on the page). [S16]

### 6d. Attributing a change in a metric to individual commits

- git bisect: "uses a binary search algorithm to find which commit in your project's history introduced a bug", and "can be used to find the commit that changed any property of your project; e.g., ... the commit that caused a benchmark's performance to improve." Custom terms are supported (`--term-old fast --term-new slow`). `git bisect run` uses exit 0 for good/old, 1 to 127 except 125 for bad/new, and 125 to skip an untestable revision. Example output: "675 revisions left to test after this (roughly 10 steps)". [S17]
- Delta debugging (Zeller and Hildebrandt, "Simplifying and Isolating Failure-Inducing Input", IEEE TSE 28(2), Feb 2002): ddmin minimises a failure-inducing set of changes. Proposition 12 (worst case): the number of tests is |c|^2 + 3|c|. Proposition 13 (best case): if a single change induces the failure and every test containing it fails, tests t <= 2 log2 |c| (binary search). Determining a true local minimum requires 2^|c| tests, so ddmin targets 1-minimality: "removing any single change would cause the failure to disappear." Tests can return pass, fail, or UNRESOLVED (for inconsistent combinations of changes). The earlier dd algorithm (Zeller, "Yesterday, my program worked. Today, it does not. Why?", ESEC/FSE 1999) isolated failure-inducing code changes between two program versions and assumed monotonicity. Case study: Mozilla crash input reduced from 95 user actions to 3, 896 HTML lines to 1, in 139 automated test runs. [S18][S19]

### 6e. Shapley credit in multi-agent RL (brief)

- Shapley Q-value / SQDDPG (Wang et al., arXiv 1907.05707, 2019): argues the shared global reward "may give each agent an inaccurate reward on its contribution", proposes Shapley Q-value as a local reward. Exact form sums over coalitions C of N minus {i} with weight |C|!(|N| - |C| - 1)!/|N|!; to make it tractable it learns an "approximate marginal contribution" network and estimates the expectation by sampling M coalitions (sample size 1 is used in most experiments). Reported: "significant improvement on the convergence rate" vs MADDPG, COMA and independent baselines on Cooperative Navigation, Prey-and-Predator, Traffic Junction. [S20]

### Implication for Lineage (section 6 overall)

- Lineage's natural credit for a single accepted patch is its own marginal contribution against its base tip: delta = metric(base) - metric(base + patch). That is a leave-one-in marginal along one specific ordering (the acceptance order), which is exactly one sample of a Shapley permutation estimator [S9]. It is cheap (2 replays) but order-dependent: whoever lands first on an easy win gets it, and complementary patches that only help together are mispriced.
- Exact Shapley over n concurrent candidate patches costs O(2^n) replays [S10][S11]; even Monte Carlo with guarantees costs O(n^2 log n) replay evaluations [S10]. With deterministic replays the noise term is zero, which is the regime TMC-Shapley exploits (truncate once marginals fall below metric noise) [S9]; with an exact metric like instruction count the "performance tolerance" could be zero or one unit, so truncation saves less than in noisy ML.
- Practical design: pay the marginal against the base at acceptance (cheap, final), and only for bundles of interacting patches (patches that fail or regress alone but help together, i.e. positive pairwise interaction [S14]) run a small exact Shapley over the bundle (n <= 4 to 6 means 16 to 64 replays) to split the bundle's delta.
- Compiler phase-order results [S15][S16] warn that performance gains from code changes are order-dependent and can enable or disable each other. Expect that a later patch can erase an earlier patch's gain (negative interaction). Decide up front whether earlier credit is final (simple, gameable by front-running) or clawed back (fair, complex). Recommendation: final credit at acceptance; no clawback; but measure against the current tip so a patch that only "re-wins" a regression it caused earns nothing.
- Use bisect-style search [S17] for attribution after the fact (which accepted patch caused a later metric regression): O(log2 n) replays. Use ddmin [S18] to strip a large submitted patch down to the hunks that actually produce the gain (1-minimal patch), which both reduces review surface and exposes padding: worst case |c|^2 + 3|c| replays, best case 2 log2 |c|.
- Leave-one-out [S9] on a bundle detects free riders: a co-author hunk whose removal does not change the metric gets zero.

---

## 7. Collusion, Sybil resistance, duplicate rules

### 7a. Quadratic funding: pairwise coordination subsidies (Buterin, ethresear.ch, 2019-06-04)

- Standard CLR/QF subsidy for project p: k * [ (sum_i sqrt(c_ip))^2 - sum_i c_ip ], equivalently a sum over pairs of agents of 2 sqrt(c_ip) sqrt(c_jp). [S21]
- Problem: CLR assumes uncoordinated agents; two colluders each putting a large amount into a fake project extract nearly the whole subsidy. [S21]
- Fix: give each pair its own coefficient k_ij = M / (M + T_ij), T_ij = sum_p sqrt(c_ip) sqrt(c_jp); pairs that co-fund a lot get discounted. A pair's subsidy with large contribution W is 2MW/(M + W) < 2M, and a coalition of k agents extracts at most k(k - 1)M. [S21]
- Stated limitations: penalises genuine like-minded groups; not coordination-proof (colluders can avoid co-funding and instead run influence campaigns); requires identity; cannot distinguish real from fake public goods; M is set by binary search to hit a budget; suggested future M_ij = M_i * M_j where M_i reflects confidence the account is a unique human. [S21]

### 7b. Collusion-resistance properties and COCM

- "Collusion Resistance and Plurality in Quadratic Mechanisms" (Weyl, Erichsen, Miller; summary posted 2023-01-04) defines collusion resistance via three diminishing-returns properties: for an agent contributing x, matching is O(sqrt(x)); for a coordinating group contributing x, matching is O(sqrt(x)); adding new members (x agents each contributing y) gives matching that is both O(sqrt(x)) and O(sqrt(y)). Pairwise discounting lacks the third; cluster match lacks the first two; offset match can "completely eat an agent's donation" (fails individual rationality); Connection-Oriented Cluster Match (COCM) "combines ideas from both Pairwise Discounting and Cluster Match" and achieves all three; Eigen Match uses eigenvectors of the social graph. Limitation: assumes complete information about group membership. [S22]
- Gitcoin deployment of COCM: search-result summaries of Gitcoin's blog say COCM clusters donors by donation patterns, weights each user's cluster membership, and reduces matching for tightly connected donor sets; an illustrative Sybil case involved one project with 207 donation connections sharing similar amounts, wallet creation times and single-project donations. I could not load the Gitcoin pages (502 / DNS errors), so these details are not verified. [S23]

### 7c. Optimism RetroPGF

- Round 3 design (forum post 2023-09-12): each badgeholder allocates up to 30M OP, at most 5M OP per project; results use the median; a project needs votes from at least 17 badgeholders (quorum) to qualify; votes are private, visible only to the Foundation for Code of Conduct enforcement. A Foundation reply gives the quorum's purpose as preventing "a small number of badgeholders colluding to dictate the allocation of OP to a project". Round 2 learnings: low-quality data, too many projects per badgeholder, ambiguous impact definition so badgeholders used very different criteria, poor single-long-form voting UX. [S24]
- Yu et al., "Evaluating Voting Design Vulnerabilities for Retroactive Funding" (arXiv 2505.16068, 2025-05-21): Round 1 used quadratic voting, Round 2 mean, Rounds 3 and 4 median variants. Findings: under QV, two colluding voters can each raise voting power by a factor of sqrt(2); median voting is more vulnerable than mean to large-scale "phantom vote" attacks (many tiny non-zero votes shift the median), mean is about an order of magnitude more sensitive to a single outlier voter; in their 10,000-iteration simulations project-attack manipulation scores were about 9,150 to 9,300 for mean and median vs much lower for QV. Recommendations: QV with voter rotation and minimum allocation thresholds; capped-median or moving-phantoms rules as stopgaps. [S25]

### 7d. Bug bounty and audit-contest duplicate rules

- HackerOne: "When a hacker reports a vulnerability that has already been reported, it's considered a duplicate report." The program can add the later reporter as an external participant on the original report (access to the full original report) or just tell them the original report number; enabling participant-adding requires the program's Customer Success Manager. The docs page I read does not state the bounty rule for duplicates. [S26] HackerOne's reputation docs (per search summary): duplicates of a resolved report filed before public disclosure +2, after public disclosure -5; not verified on the page. [S27]
- Bugcrowd (2023-06-29): principles "Touch the code (or make a change), pay the bug", "Similar != same" (findings needing separate fixes are unique), "Many != systemic". For a systemic issue they "reward the first report, and mark all subsequent reports as duplicates"; instances the systemic fix misses are new unique findings. [S28]
- Code4rena: duplicates are defined by shared root cause: findings are duplicates "if fixing the Root Cause (in a reasonable manner) would cause the finding to no longer be exploitable"; the award "will be shared among those who submitted"; "multiple submissions from the same warden (or warden team) are treated as one by the awarding algorithm". [S29] Award slices: Medium = 3 * (0.85^(split - 1)) / split; High = 10 * (0.85^(split - 1)) / split, where split is the number of duplicates; payout per slice from award pool / pie. Partial-credit duplicates still count as 1 in split, with slice credit 0.25, 0.5 or 0.75; the selected-for-report submission gets a 30% slice bonus (new pie = previous pie + selected slice * 0.3). Partial credit applies when root cause or maximal impact is not identified. [S30][S29]
- Sherlock: issue points per submitter: Medium = 1 * 0.9^(n - 1) / n; High = 5 * 0.9^(n - 1) / n, n = submissions for the issue; the docs call these "sybil-resistant". Worked: a High found by 2 gives 5 * 0.9 / 2 = 2.25 points each; a Medium found by 5 gives 0.9^4 / 5, about 0.131 each (my arithmetic from the formula). [S31] First-blood pot: 3% of total payouts, shares = severity factor * 0.9^(n - 1) / n paid only to the first submitter of each valid issue family, ordered by the timestamp of the last modification of the GitHub issue. [S32]

Why the 0.9^(n-1)/n shape is Sybil-resistant: total payout for an issue with n reports is severity * 0.9^(n-1), strictly decreasing in n. One finder who splits into k fake identities collects k * (0.9^(k-1)/k) = 0.9^(k-1) of the unique-finder payout, so splitting always loses (my derivation from [S31]; Code4rena's 0.85 base gives the same property with a steeper decay [S30]).

### Implication for Lineage (section 7 overall)

- Duplicate patches will be common (many agents find the same easy win from the same tip). Pure first-reporter-wins (Bugcrowd systemic rule [S28]) is simplest and Sybil-neutral, but rewards latency and pushes agents to race rather than to improve. The Sherlock/Code4rena shape, severity * d^(n - 1) / n with d in (0, 1) [S30][S31], splits among duplicates while making self-duplication strictly unprofitable; a Lineage analogue: work_units_each = delta * d^(n - 1) / n for n patches with the same effect within an acceptance window, plus a small first-submitter bonus pot like Sherlock's 3% [S32].
- Lineage needs a machine-checkable definition of "same root cause" [S29]. Candidate: two patches are duplicates if applying either to the base yields the same measured delta and applying the second on top of the first yields no further improvement (a replay-based version of Code4rena's "fixing the root cause makes the other no longer exploitable"). This costs 2 to 3 extra replays per suspected pair.
- Treat all submissions from one controller (or cluster of linked keys) as one, as Code4rena does for a warden team [S29]; combine with 7a/7b ideas: discount payouts between keys that repeatedly co-submit or co-author (pairwise k_ij = M / (M + T_ij) style [S21], COCM-style cluster weighting [S22]).
- Avoid subjective voting for credit where a metric exists; RetroPGF shows each aggregation rule (QV, mean, median) has a known collusion attack [S25] and that ambiguous impact definitions make voters inconsistent [S24]. Lineage's replayed metric removes most of this, which is a key advantage; keep any human/agent voting only for scope decisions (which metrics count), not for payouts.
- Collusion between a patch author and replayers is the analogue of badgeholder collusion: require a quorum of independent replayers (RetroPGF's 17-vote quorum exists to stop a few colluders [S24]) and pick replayers randomly and rotate them (the QV analysis finds rotation reduces repeated-game collusion [S25]).

---

## 1. MetaGPT

What it is: "MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework", arXiv 2308.00352 (submitted 2023-08-01), ICLR 2024. Encodes Standardized Operating Procedures (SOPs) into prompt sequences with an assembly-line paradigm. [S33]

Coordination pattern:
- Roles: Product Manager, Architect, Project Manager, Engineer, QA Engineer, each with name, profile, goal, constraints and tools (PM can web-search; Engineer can execute code). [S33]
- Handoffs: sequential SOP: PM writes a structured PRD (user stories, requirement pool) -> Architect produces system design (file lists, data structures, interface definitions, sequence diagrams) -> Project Manager distributes tasks -> Engineers implement -> QA writes tests. [S33]
- Message passing: agents "communicate through documents and diagrams (structured outputs) rather than dialogue", each role has an output schema. [S33]
- Shared state: a global shared message pool; agents publish structured messages and subscribe by role-specific interests; "an agent activates its action only after receiving all its prerequisite dependencies." [S33]
- Conflict/error handling: executable feedback: the Engineer writes and runs unit tests and debugs until tests pass "or a maximum of 3 retries is reached". [S33]

Reported results (quoted): "achieves a new state-of-the-art (SoTA) with 85.9% and 87.7% in Pass@1" (HumanEval, MBPP); executable feedback adds "4.2% and 5.4% in Pass @1 on HumanEval and MBPP"; removing roles produced "unworkable codes". [S33]

Limitations: fixed sequential SOP; no mechanism for concurrent conflicting writers; credit is not modelled at all.

Implication for Lineage:
- Publish/subscribe over typed artefacts is the right shape for Lineage's shared state: the tip, benchmark results, rejected-patch records and claims are typed messages agents subscribe to, instead of agent-to-agent chat.
- "Activate only after prerequisites" maps to dependency-gated work: an agent should not start on a stack element until its base is accepted.
- MetaGPT's retry cap (3) [S33] is a useful precedent for bounding self-repair loops per patch attempt.

## 2. ChatDev and successors

What it is: "ChatDev: Communicative Agents for Software Development", arXiv 2307.07924 (submitted 2023-07-16). [S34]

Coordination pattern:
- Chat chain: waterfall phases design, coding (writing, completion), testing (code review, system testing), each split into subtasks. [S34]
- Role pairs: each subtask has two agents as instructor and assistant who exchange multi-turn dialogue "until they achieve consensus", and the extracted solution is handed to the next subtask. [S34]
- Memory: short-term memory within a phase, long-term memory across phases (only solutions carried forward). [S34]
- Inception prompting to avoid "role flipping, instruction repeating, and fake replies". [S34]
- Communicative dehallucination: a deliberate "role reversal" where the assistant asks the instructor for specifics (for example an exact dependency name) before giving a final answer. [S34]

Successors:
- Experiential Co-Learning (arXiv 2312.17025, 2023-12-28): instructor and assistant agents "gather shortcut-oriented experiences from their historical trajectories" and reuse them on new tasks. [S35]
- MacNet, "Scaling Large Language Model-based Multi-Agent Collaboration" (arXiv 2406.07155, 2024-06-11): agents organised as a DAG, interactive reasoning "topologically orchestrated"; supports "over a thousand agents"; "irregular topologies outperforming regular ones"; a "collaborative scaling law" with logistic growth in performance as agents scale. [S36]

Limitations: consensus-by-dialogue has no objective arbiter; correctness checks are themselves LLM-judged except where tests run.

Implication for Lineage:
- Lineage replaces "consensus via dialogue" with consensus via deterministic replay, which removes the main failure mode ChatDev patches over with prompt tricks.
- Dehallucination by asking questions maps to agents querying the lineage state (benchmarks, previous rejected attempts) before submitting.
- Experiential Co-Learning suggests a shared record of failed and successful patch attempts per tip is valuable to all agents; Lineage should publish rejection reasons, which also raises the question of whether shared negative results earn credit.

## 3. OpenHands (formerly OpenDevin)

What it is: "OpenHands: An Open Platform for AI Software Developers as Generalist Agents", arXiv 2407.16741 (submitted 2024-07-23). [S37]

Coordination pattern:
- Event stream: the agent state includes "the event stream, which is a chronological collection of past actions and observations, including the agent's own actions and user interactions", plus accumulated LLM cost and "metadata to track multi-agent delegation". [S37]
- Actions include IPythonRunCellAction, CmdRunAction, BrowserInteractiveAction; a sandbox runtime listens for action requests from the event stream and returns results to it. [S37]
- Delegation: "AgentDelegateAction ... enables an agent to delegate a specific subtask to another agent", e.g. CodeActAgent delegating browsing to BrowsingAgent. [S37]
- Micro agents: specialised agents that reuse a generalist agent's implementation with shared task-specific prompts. [S37]

Limitations: delegation is hierarchical within one session; the paper does not describe concurrent writers to one repository or conflict resolution between agents (not found in the text I searched).

Implication for Lineage:
- An append-only event stream of actions and observations, with cost accounting and delegation metadata in the same log [S37], is a ready template for Lineage's per-attempt audit trail, which replayers and credit rules can consume.
- Delegation chains imply sub-credit: if agent A delegates to B, the patch credit should be split by an explicit contract recorded at delegation time, not inferred afterwards.

## 4. SWE-agent and multi-agent SWE-bench systems

- SWE-agent (arXiv 2405.15793, 2024-05-06): single agent with a custom agent-computer interface (ACI); pass@1 12.5% on SWE-bench and 87.7% on HumanEvalFix (quoted abstract). [S38]
- Agentless (arXiv 2407.01489, 2024-07-01): no agent loop; fixed three-phase localisation, repair, patch validation; SWE-bench Lite "32.00%, 96 correct fixes" at "$0.70". [S39]
- AutoCodeRover (arXiv 2404.05427, 2024-04-08): AST-aware code search plus spectrum-based fault localisation; 19% on SWE-bench Lite at about $0.43 per issue. [S40]
- CodeR (arXiv 2406.01304, 2024-06-03): roles Manager (selects a plan, decides submit / replan / give up), Reproducer (writes a reproducing test), Fault Localizer, Editor, Verifier (runs tests); plans are a parseable "task graph" that is strictly executed. Motivation: free agent-to-agent communication "may lead to a non-progressing loop without termination", handoffs "may incur information loss", and complex plans are hard to follow. 28.33% on SWE-bench Lite with a single submission. [S41]
- MASAI (arXiv 2406.11638, 2024-06-17): five sub-agents: Test Template Generator, Issue Reproducer, Edit Localizer, Fixer (generates multiple candidate patches), Ranker (ranks patches using the generated test); 28.33% on SWE-bench Lite. [S42]
- SWE-Search (arXiv 2410.20285, 2024-10-26): MCTS over trajectories with a SWE-Agent, a Value Agent (numeric plus qualitative feedback) and a Discriminator Agent running "multi-agent debate"; "23% relative improvement" across five models vs agents without MCTS. [S43]
- Magentic-One (arXiv 2411.04468, 2024-11-07): an Orchestrator with an outer loop maintaining a Task Ledger (given/verified facts, facts to look up, educated guesses, plan) and an inner loop maintaining a Progress Ledger that answers five questions each step: is the task complete, is the team looping, is progress being made, which agent speaks next, what instruction to give. A stall counter (threshold <= 2) triggers reflection and replanning; agents' contexts are reset after each plan update. Ablations: without the full ledgers performance drops by 31%; removing any single worker agent drops it by 21% to 39%. [S44]

Patterns across these: (a) fixed pipelines beat free-form chat on cost (Agentless, CodeR); (b) generate many candidate patches then select with tests (MASAI Fixer/Ranker, SWE-Search discriminator); (c) an explicit ledger with progress and loop detection (Magentic-One).

Implication for Lineage:
- Lineage is structurally "MASAI at network scale": many independent fixers produce candidates; the ranker is deterministic replay, not an LLM. This avoids the LLM-judge collusion surface of SWE-Search's debate.
- Magentic-One's progress ledger and stall counter are a template for a tip-level ledger: which metric targets are open, which have stalled (k consecutive rejected attempts), triggering a replan (new target or larger patch budget).
- Ablation-style evidence (removing an agent drops performance 21% to 39% [S44]) is leave-one-out credit at the agent level; note the same LOO caveat from [S9] applies (it ignores redundancy and synergy).

---

## Cross-cutting summary for the design doc

1. Objective replay is Lineage's main advantage over every agent framework above (all rely on LLM consensus or LLM ranking except where tests run) and over RetroPGF-style voting [S25].
2. Default credit = marginal delta vs base tip, final at acceptance; exact Shapley only within small explicitly-bundled interacting sets (O(2^n) replays [S10]); ddmin to strip padding (|c|^2 + 3|c| worst case [S18]); bisect for after-the-fact attribution [S17].
3. Duplicates: split with severity * d^(n-1)/n (Sherlock d = 0.9, Code4rena d = 0.85) so Sybil-splitting loses [S30][S31]; same-controller submissions count as one [S29]; replay-based root-cause equivalence test.
4. Collusion: random rotating replayer quorum [S24][S25]; pairwise or cluster discounting for keys that repeatedly co-submit [S21][S22].
5. Claims: advisory leases with enforced expiry [S1][S4]; stack elements each independently validated [S5][S6]; signed, weighted contributor entries instead of bare Co-authored-by trailers [S7]; DCO-like provenance chain [S8].

---

## Sources (all accessed 2026-10-07)

1. Rust Forge, "Issue Assignment" (triagebot). https://forge.rust-lang.org/triagebot/issue-assignment.html
2. Rust Compiler Development Guide, "Getting Started". https://rustc-dev-guide.rust-lang.org/getting-started.html
3. Kubernetes contributor guide, "Making your First Contribution" (via search result summary). https://www.k8s.dev/docs/guide/first-contribution
4. Kubeflow, "Contributing to Kubeflow". https://www.kubeflow.org/docs/about/contributing/
5. Graphite, "Stacked diffs" guide. https://graphite.com/guides/stacked-diffs
6. ghstack README (ezyang). https://github.com/ezyang/ghstack
7. GitHub Docs, "Creating a commit with multiple authors". https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors
8. Developer Certificate of Origin 1.1. https://developercertificate.org/
9. Ghorbani and Zou, "Data Shapley: Equitable Valuation of Data for Machine Learning", arXiv 1904.02868 (2019). https://arxiv.org/abs/1904.02868 (full text read via https://export.arxiv.org/pdf/1904.02868v2)
10. Jia et al., "Towards Efficient Data Valuation Based on the Shapley Value", arXiv 1902.10275 (2019). https://arxiv.org/abs/1902.10275 (full text via export.arxiv.org)
11. Jia et al., "Efficient Task-Specific Data Valuation for Nearest Neighbor Algorithms", arXiv 1908.08619 (2019). https://arxiv.org/abs/1908.08619
12. Lundberg and Lee, "A Unified Approach to Interpreting Model Predictions" (SHAP), arXiv 1705.07874 (2017). https://arxiv.org/abs/1705.07874 (full text via export.arxiv.org)
13. Ghorbani, Kim, Zou, "A Distributional Framework for Data Valuation", arXiv 2002.12334 (2020). https://arxiv.org/abs/2002.12334
14. Shapley interaction index (Grabisch and Roubens 1999, IJGT 28:547-565), via search summary of https://orbilu.uni.lu/bitstream/10993/6897/2/ChainingInteractionIndex.pdf and https://arxiv.org/pdf/2405.10852 (original not opened; not verified)
15. Kulkarni, Whalley, Tyson, Davidson, "Practical Exhaustive Optimization Phase Order Exploration and Evaluation". https://ittc.ku.edu/~kulkarni/CARS/taco08/taco08.html
16. Jantz, KU thesis on phase interactions (via search summary only, not verified). https://kuscholarworks.ku.edu/bitstream/1808/6963/1/Jantz_ku_0099M_11095_DATA_1.pdf
17. git-bisect documentation. https://git-scm.com/docs/git-bisect
18. Zeller and Hildebrandt, "Simplifying and Isolating Failure-Inducing Input", IEEE TSE 28(2), 2002 (PDF mirror read). https://www.cs.purdue.edu/homes/xyzhang/spring07/Papers/delta-debugging.pdf
19. A. Colyer, "Simplifying and Isolating Failure-Inducing Input" (The Morning Paper, 2015-11-16). https://blog.acolyer.org/2015/11/16/simplifying-and-isolating-failure-inducing-input/
20. Wang et al., "Shapley Q-value: A Local Reward Approach to Solve Global Reward Games", arXiv 1907.05707 (2019). https://arxiv.org/abs/1907.05707
21. V. Buterin, "Pairwise coordination subsidies: a new quadratic funding design", ethresear.ch, 2019-06-04. https://ethresear.ch/t/pairwise-coordination-subsidies-a-new-quadratic-funding-design/5553
22. "Collusion Resistance and Plurality in Quadratic Mechanisms (paper summary)", ethresear.ch, 2023-01-04. https://ethresear.ch/t/collusion-resistance-and-plurality-in-quadratic-mechanisms-paper-summary/14545
23. Gitcoin, "Leveling the Field: How Connection-Oriented Cluster Matching Strengthens Quadratic Funding" and "WTF is cluster matching QF" (page did not load; search summary only, not verified). https://gitcoin.co/blog/leveling-the-field-how-connection-oriented-cluster-matching-strengthens-quadratic-funding ; https://gitcoin.co/blog/wtf-is-cluster-matching-qf
24. Optimism Governance Forum, "RetroPGF 3: Round Design", 2023-09-12. https://gov.optimism.io/t/retropgf-3-round-design/6802
25. Yu, Bennett, Gao, Joseph et al., "Evaluating Voting Design Vulnerabilities for Retroactive Funding", arXiv 2505.16068 (2025). https://arxiv.org/abs/2505.16068 (full text via export.arxiv.org)
26. HackerOne Help Center, "Duplicate Reports". https://docs.hackerone.com/en/articles/8514410-duplicate-reports
27. HackerOne docs, "Reputation" (via search summary only, not verified). https://docs.hackerone.com/hackers/reputation.html
28. Bugcrowd, "The three principles of bug bounty duplicates", 2023-06-29. https://www.bugcrowd.com/blog/the-three-principles-of-bug-bounty-duplicates/
29. Code4rena docs, "Judging criteria". https://docs.code4rena.com/competitions/judging-criteria
30. Code4rena docs, "Awarding". https://docs.code4rena.com/awarding
31. Sherlock docs, "Watson points example". https://docs.sherlock.xyz/audits/watsons/watson-points-example
32. Sherlock docs, "First submission pot". https://docs.sherlock.xyz/audits/watsons/first-submission-pot
33. Hong et al., "MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework", arXiv 2308.00352 (ICLR 2024). https://arxiv.org/abs/2308.00352 (full text via export.arxiv.org)
34. Qian et al., "ChatDev: Communicative Agents for Software Development", arXiv 2307.07924 (2023). https://arxiv.org/abs/2307.07924 (full text via export.arxiv.org)
35. Qian et al., "Experiential Co-Learning of Software-Developing Agents", arXiv 2312.17025 (2023). https://arxiv.org/abs/2312.17025
36. Qian et al., "Scaling Large Language Model-based Multi-Agent Collaboration" (MacNet), arXiv 2406.07155 (2024). https://arxiv.org/abs/2406.07155
37. Wang et al., "OpenHands: An Open Platform for AI Software Developers as Generalist Agents", arXiv 2407.16741 (2024). https://arxiv.org/abs/2407.16741 (full text via export.arxiv.org)
38. Yang et al., "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering", arXiv 2405.15793 (2024). https://arxiv.org/abs/2405.15793
39. Xia et al., "Agentless: Demystifying LLM-based Software Engineering Agents", arXiv 2407.01489 (2024). https://arxiv.org/abs/2407.01489
40. Zhang et al., "AutoCodeRover: Autonomous Program Improvement", arXiv 2404.05427 (2024). https://arxiv.org/abs/2404.05427
41. Chen et al., "CodeR: Issue Resolving with Multi-Agent and Task Graphs", arXiv 2406.01304 (2024). https://arxiv.org/abs/2406.01304 (full text via export.arxiv.org)
42. Arora et al., "MASAI: Modular Architecture for Software-engineering AI Agents", arXiv 2406.11638 (2024). https://arxiv.org/abs/2406.11638 (full text via export.arxiv.org)
43. Antoniades et al., "SWE-Search: Enhancing Software Agents with Monte Carlo Tree Search and Iterative Refinement", arXiv 2410.20285 (2024). https://arxiv.org/abs/2410.20285
44. Fourney et al., "Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks", arXiv 2411.04468 (2024). https://arxiv.org/abs/2411.04468 (full text via export.arxiv.org)

Note on author names in sources 33 to 44: first-author surnames come from my knowledge of these papers, not from the abstracts I retrieved (the arXiv API output I parsed did not include author fields, except for 1902.10275 and 2505.16068 where I read the title page). Treat first-author names as not verified; titles, IDs and dates are verified.
