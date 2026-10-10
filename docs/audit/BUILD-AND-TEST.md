# Build and test

Every command below was run on 2026-10-10 by the audit package lane; the results are what was
observed, with the raw outputs in `runs/`. Machine: macOS (Darwin 25.5, arm64). Toolchain in
`SCOPE.md`.

## Prerequisites

- anchor-cli 0.31.1 (only for its conventions; `anchor deploy` is never used, and `anchor build` is
  not needed), solana-cli 3.1.12 with `cargo-build-sbf` (platform tools v1.52), a host Rust toolchain,
  Bun 1.3 for the TypeScript client and the devnet scripts.
- The Meteora program dumps the LiteSVM suite loads: `onchain/vendor/meteora/dbc.so` and `damm_v2.so`
  (not committed). `onchain/vendor/meteora/fetch.sh` dumps them read-only from devnet and checks the
  pinned sha256 values listed in `SCOPE.md`. If Meteora redeploys on devnet again the hash check fails;
  we can send the exact files on request.
- Disk: a full first build of the workspace and its host test dependencies needs several GB. Our
  existing `onchain/target` is 2.4 GB.

Never run `cargo clean` or delete `onchain/target` on our machines: `target/deploy` holds the program
id keypairs (backed up in `onchain/keys-backup/`, gitignored). An auditor's own clone generates its
own keypairs, which only matter for deploying.

## Build the programs

```sh
cd onchain
vendor/meteora/fetch.sh
cargo build-sbf --offline --manifest-path programs/lineage-registry/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-launch/Cargo.toml   --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-msg/Cargo.toml      --sbf-out-dir target/deploy
shasum -a 256 target/deploy/*.so
```

Drop `--offline` on a machine without a warm cargo cache. Expected hashes for the commit in `SCOPE.md`:
registry `8f3861a414b6b13e6acf3d13f2222502f9c1d2b8f04485f880b1231b6fa62b32`, launch
`762a18d9942316140cca508dd3b3b49f062c5ed19c174ada67d9b15dbd9e30b0` (both equal the devnet dumps).
Our `target/deploy` on 2026-10-10 held exactly these two, and `lineage_msg.so` hashing
`0d402e82...d085` (it differs from the deployed `94de4765...0b62` for the reason in `SCOPE.md`).
Reproducibility across machines has not been tested; `solana-verify` (Docker-based verifiable builds)
has not been set up yet.

## LiteSVM suites

```sh
cd onchain
cargo test --offline -p lineage-onchain-tests       # loads target/deploy/*.so and the Meteora dumps
cargo test --offline -p lineage-registry --lib      # leaf encoder unit tests
cargo test --offline -p lineage-launch --lib        # bounty target JSON unit test
```

The suites run the compiled `.so` files, so rebuild the programs after any source change.

Result on 2026-10-10 13:21 UTC (`runs/LITESVM-2026-10-10.txt`), against the `.so` files hashed above:

| Suite | Passed | What it covers |
|---|---|---|
| `tests/registry.rs` | 13/13 | config validation and floors, pause, register and launched-only registration, bond, unbond cooldown, slash once per id, strikes and suspension, split, clocked epoch posts with caps, claims with TypeScript-built roots, over-claim, mint extension allowlist, layout migration |
| `tests/launch.rs` | 13/13 | full launch on the real DBC, trades and the exact fee split, migration, graduation, forged dust position, admin graduation, fees left at migration, usage roots and debits, debit cap, self-hosted withdrawals, sleep and wake, pause, longest launch fits one transaction, DBC config offsets |
| `tests/identity.rs` | 7/7 | Agent v2, rotation, revocation, profile, two-step owner transfer, migrations |
| `tests/bounty.rs` | 13/13 | release with a Core proof, wrong payee or condition, proof reuse, forged record roots, refund and cancel rules, caps, config; A1-01, A1-03, A1-04 attack tests; Rust contribution leaf equals Core's |
| `tests/challenge.rs` | 8/8 | config, claim hold, root correction before any claim, verdict and slash challenges, expiry; A1-02, A1-05 attack tests |
| `tests/msg.rs` | 6/6 | signer is the current registry signing key, forged events, caps and pause, sizes, longest message, TypeScript-sealed DM round trip |
| `tests/client_vectors.rs` | 1/1 | instruction encodings and account bytes the TypeScript client is tested against |
| **LiteSVM total** | **61/61** | wall time 9.7 s on a warm build |
| `lineage-registry --lib` | 3/3 | leaf escaping, decimal and base58 encoding, program id |
| `lineage-launch --lib` | 2/2 | target JSON shapes, program id |

The five `audit_a1_*` tests were each run red against the unfixed programs and green after the fix by
the A1 lane (docs/AUDIT.md "Onchain"); this package reran them green only.

## TypeScript client and fixtures

From the repository root:

```sh
bun install --frozen-lockfile
bun test packages/chain                       # 129/129 on 2026-10-10
bun onchain/scripts/make-fixtures.ts --check  # "merkle.json current"
```

`packages/chain` holds the instruction builders, PDAs and account decoders the app, Core and scripts
use; its tests check them against `onchain/tests/fixtures/client-vectors.json`, which the LiteSVM
`client_vectors` test produces. `make-fixtures.ts` rebuilds the Merkle fixtures with the protocol
package and checks they equal the committed ones, which ties Core's leaf and root encoding to the
Rust encoder (`registry.rs` `leaves_match_the_typescript_protocol`).

## Devnet end to end

Devnet scripts need the devnet keys under `~/.config/lineage/` (not in the repository) and pass them
explicitly; they never change `solana config`. They append a transaction log to `onchain/DEVNET.md`.

| Script | What it proves | Uses | Run on 2026-10-10 |
|---|---|---|---|
| `scripts/devnet/graduation-e2e.ts` | launch, curve fill, `crank_fees` exact split, Meteora migration, `graduate`, `crank_pool_fees`, `repoint_position` to a larger locked position, totals | deployer | PASS 16/16, 0.042965 devnet SOL (`runs/DEVNET-2026-10-10.md`) |
| `onchain/scripts/audit-a1-devnet.ts` | A1-03 (seller refused after an owner transfer for withdraw, open and cancel; buyer allowed) and A1-01 (donation then cancel in one transaction) | deployer | PASS 9/9, 0.037602 devnet SOL (same file) |
| `scripts/devnet/e2e-devnet.ts` | a short network with a chain-mode Core: epochs posted, claims, slashes, credential | the live site's Core authority | not run: it would race the live site's epoch posts (docs/AUDIT.md "Devnet") |
| `scripts/devnet/challenge-e2e.ts` | an upheld verdict challenge and a failed slash challenge resolved on chain | the live site's Core authority | not run, same reason; last run 22/22 on 2026-10-08 (onchain/DEVNET.md "Contestable Core", `scripts/devnet/CHALLENGE-E2E-LAST.json`), before the A1 registry upgrade |
| `scripts/devnet/msg-e2e.ts` | `lineage_msg` boards, sealed DMs, key publication through the runtime path | runtime authority and a local Core on port 9662 | not run (shared runtime key and port); last run 17/17 on 2026-10-08 (onchain/DEVNET.md "Onchain messages", `scripts/devnet/MSG-E2E-LAST.json`) against the `lineage_msg` binary still deployed |

The two scripts run here were run from a scratch clone so their log did not touch the repository's
`onchain/DEVNET.md`; the sections they wrote are copied into `runs/DEVNET-2026-10-10.md`.

For an auditor without our keys: the LiteSVM suites are the complete, self-contained proof. The devnet
programs can be read (`solana program dump`) and exercised with fresh keys for every permissionless
instruction; admin and authority paths need a fresh deployment (`onchain/DEPLOY.md`,
`scripts/devnet/setup.ts`).

## Static checks

`cargo clippy` was clean on all three programs at the A1 commit (docs/AUDIT.md "Onchain").
`cargo audit` has not been run (no advisory database on the build machine); we would welcome its
output as part of the engagement.
