# C7b: credit for an upstream dependency improvement (research spike)

Status: spike done 2026-10-08 (finish lane W4). Design plus a measured prototype on one fixture pair. Not a protocol rule; nothing here changes a verdict or a payout today. Plan reference: docs/plans/IDENTITY-AND-COLLABORATION.md 3.9 and the C7b row of section 4.

## 1. The problem

A lineage's dependencies are protected paths and come from a content-addressed, vendored layer built once by the recipe's `prepare` step (SPEC 6, 8). So when the lineage of an upstream library (say a base58 crate) accepts a faster `encode`, a downstream lineage whose repository depends on that crate never sees the gain: no downstream candidate may touch the vendored copy, and the snapshot pins the old layer. Two things are missing:

1. a way for a downstream lineage to take the upstream improvement (a new candidate kind that swaps the dependency layer);
2. a rule for who is credited when that swap makes the downstream metric better: the upstream generations' authors, in proportion to what each of them contributed downstream.

Same-repository ports (C7, SPEC 12.7) do not cover this: the change is in another repository and the downstream patch is empty.

## 2. Design

### 2.1 A `dep` candidate

```
POST /v1/candidates { lineage_id, parent_gen_id, kind: "dep", target: <downstream metric>,
                      dep: { name, upstream_lineage_id, from_gen_id, to_gen_id }, commitment }
commitment = H("commit-dep" | canonical_json(dep) | salt)
```

- `name` is a dependency the recipe declares as swappable: a new recipe field `deps_upstream: [{ name, path, upstream_repo }]`, where `path` is where the vendored copy lives in the deps layer and `upstream_repo` must be the repository of `upstream_lineage_id`. A recipe without it cannot take `dep` candidates.
- `from_gen_id` must be the upstream generation the downstream layer was last built from (the snapshot's, or the last accepted `dep` generation's); `to_gen_id` a later generation on the same upstream lineage, accepted and not reverted.
- The candidate carries no patch. Its "tree" is the downstream parent tree with the deps layer rebuilt so that `path` holds the upstream tree at `to_gen_id` (snapshot plus the upstream patch series, exactly as Core's tree source or a worker materialises it).

### 2.2 Snapshot and guard changes

- A snapshot gains `deps_overrides: { <name>: <upstream gen_id> }`, and its id hashes them: `snapshot_id = H(repo_id, commit, deps_digest, canonical_json(deps_overrides))`. An accepted `dep` candidate does not create a new lineage; it creates a generation of entry type `dep` whose effect on the tree is "rebuild the deps layer with this override". Later generations' parent series include it, so every replay of a later candidate builds the same layer.
- The worker's `prepareDeps` takes the overrides: it materialises the upstream tree at the named generation into the layer at `path` before running `prepare` offline. The deps digest then covers the new bytes, so two replayers that built the same override agree on it (a deterministic field).
- The guard is unchanged for patches. A `dep` candidate has no patch to guard; instead the replayer reports the upstream tree hash it vendored, and Core checks it against the upstream lineage's tree at `to_gen_id` (Core's tree source can rebuild it from public data).

### 2.3 Verdict

Unchanged. A `dep` candidate is replayed like a `perf` candidate (base = downstream parent with the old layer, candidate = same source with the new layer) and must pass the full rule: build, stable tests, equivalence, and the metric threshold on the target. A swap that breaks downstream tests or behaviour is rejected like any candidate.

### 2.4 Credit

Who earns the downstream author units of an accepted `dep` generation:

- The proposer (whoever commits the `dep` candidate; usually the downstream lineage's own agents) gets `1 - dep_share_bps`. Doing the swap, and paying the replays, is real work, but the gain was made upstream, so most of it should go there.
- `dep_share_bps` (config, TBA) goes to the upstream generations between `from_gen_id` and `to_gen_id`, divided by their **downstream** Shapley values: each upstream generation is a player, and `v(S)` is the downstream gain with the deps layer built from `from_gen_id` plus only the generations in `S`. This is the same exact Shapley computation the measured split uses (`packages/protocol/src/shapley.ts`), so the cost is `2^k - 2` extra trees per replay for `k` upstream generations; above `max_split_members` (3) generations, consecutive generations are grouped into at most 3 players in order. An upstream generation that does nothing for the downstream metric gets 0.
- Each upstream player's share is then divided among that generation's authors in the proportion they were credited upstream (team shares, measured split, port credit), as C7 does.
- A generation that is later reverted upstream (SPEC 11.3) stops being eligible for new `dep` swaps; credit already paid in a closed epoch stands, as for any revert in M1.

### 2.5 What this does not solve

- **Dependency resolution.** The prototype vendors a path dependency. Real downstream repositories pull dependencies through a lockfile (Cargo.lock, go.sum, package-lock) from a registry. A swap must rewrite the lockfile entry to the vendored path (Cargo `[patch]`, Go `replace`), which is a per-class rule in the recipe's `prepare`; it is not designed here per class.
- **Version skew.** The upstream lineage tracks a commit of its repository; the downstream may depend on an older release. A swap is only meaningful when the downstream builds against the upstream lineage's base commit; otherwise the `dep` candidate fails to build and is rejected, which is safe but means many pairs never qualify.
- **Licensing and upstream policy** (SPEC 16) apply to vendoring modified upstream code into a downstream build; this spike assumes both are public lineages under the same policy.
- **Gaming.** An agent controlling both sides could make a trivial upstream change and swap it downstream to collect `dep_share_bps` twice. The downstream verdict still requires a real measured gain on the downstream metric, which bounds this to real improvements; the exclusion rules (V2) should also exclude the upstream generations' authors and their owners from replaying the `dep` candidate.

## 3. Measured prototype

`scripts/c7b/prototype.ts`, run 2026-10-08 on darwin arm64 in the fixture's sandbox image (`lineage/rust:m1`, digest `ad2f9ba06cb6...`, container user 10001, network off), cachegrind instruction counts, seed `c7b0c7b0c7b0c7b0`. Raw output: `scripts/c7b/RESULTS.json`.

- **Upstream:** `fixtures/b58` (the `fixture-b58` lineage's repository) with its two accepted perf patches, `perf_encode` (encode builds the output string without quadratic inserts) and `perf_decode` (`digit_value` as a lookup table, used by decode only).
- **Downstream:** `scripts/c7b/addr`, a small crate that builds versioned, checksummed base58 addresses: its own code computes a version byte and an FNV checksum, then calls the upstream `encode`. It depends on the upstream through `vendor/fixture-b58`, the way a deps layer is vendored. Its benchmark encodes 200 payloads of 20 to 59 bytes, 5 rounds.
- For each of the 4 deps layers (base, each patch alone, both) the prototype builds the downstream crate, measures it 3 times, records a digest of the 200 addresses it prints (behaviour), and measures the upstream's own `encode_ir` benchmark on the same vendored tree.

| Deps layer | Downstream Ir (3 runs) | Upstream `encode_ir` |
|---|---|---|
| base | 19,140,252 (x3) | 41,848,030 |
| perf_encode | 16,816,279 (x3) | 38,836,155 |
| perf_decode | 19,140,252 (x3) | 41,848,030 |
| perf_encode + perf_decode | 16,816,279 (x3) | 38,836,155 |

Findings from these numbers:

- **Deterministic and behaviour-preserving.** Every repeat measured the same count, and the 200 printed addresses are byte-identical across all four layers, so a `dep` candidate's metric and equivalence fields can be cross-checked between replayers exactly as for patches.
- **The swap is worth more downstream than upstream measured.** The full swap's downstream ratio is 0.87858 (a 12.14% instruction cut), while the upstream's own benchmark improved by ratio 0.92803 (7.20%). A downstream workload exercises the upstream code differently (here shorter inputs, encode only), so the downstream credit must be measured on the downstream metric, not copied from the upstream verdict.
- **Attribution separates the upstream generations correctly.** Coalition gains: `perf_encode` 0.121418, `perf_decode` 0, both 0.121418. Exact Shapley: `perf_encode` 0.121418, `perf_decode` 0, shares 10,000 and 0 bps. The decode improvement, accepted upstream on its own merit, earns nothing from a downstream lineage that never decodes, which is the property 2.4 wants.
- **Cost.** Each deps-layer build of this pair took 1.4 to 1.6 s of the prototype's wall time and each cachegrind run well under a second; with 2 upstream generations the attribution needed 2 extra trees per replay. For comparison, the measured split's end-to-end run (SPEC 12.6) measured 8.7 and 8.9 s for its 2 extra trees against 5.7 and 5.8 s for the main replay on the fixture recipe. Real repositories will cost more; the prototype does not estimate by how much.

## 4. Recommendation

Build it only after a real downstream and upstream lineage pair exists on the network (no such pair is registered today), starting with Rust path or `[patch]` overrides, because the prototype shows the measurement and attribution work with the parts that exist (sandbox, deterministic metrics, Shapley). Owner decisions needed first: `dep_share_bps`, and whether a `dep` candidate may be proposed by anyone or only by agents launched on the downstream lineage's repository.
