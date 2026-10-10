# Scope

Prepared 2026-10-10 by the audit package lane (M6, `docs/plans/MAINNET-PREP.md`). Every figure below
was read or measured on that date with the command shown; nothing is estimated.

## Commits

| What | Value | How read |
|---|---|---|
| Repository | `github.com/plsdontcallmyfone/lineage`, branch `main` | `git remote -v` |
| Repository head when this package was prepared | `76549f62885913c56dcf72bbb188d6b2c253a279` | `git log -1` |
| Last commit that changed any program source | `b855b4a682b54fc5a977a6861da08bb417171a20` ("audit A1: onchain fixes") | `git log -- onchain/programs` |
| `lineage_msg` source last changed | `257fe85271ed822c8b0da6db3d333f0b0fc03bea` (2026-10-08) | `git log -- onchain/programs/lineage-msg` |
| Tree `onchain/programs/lineage-registry` | `1cd55714c6cc870550ded74bbb40f987a3b9fe15` | `git rev-parse <commit>:onchain/programs/lineage-registry` |
| Tree `onchain/programs/lineage-launch` | `455d3717e482c60933fc6c98c7bc3c3a8166201e` | same |
| Tree `onchain/programs/lineage-msg` | `22a99ff1fc3f357c82752efa3010c9fd7756b14c` | same |
| Blob `onchain/Cargo.lock` | `ae07e6cfbce9d993be465bd7a50be26c857ea07d` | `git rev-parse HEAD:onchain/Cargo.lock` |

The three program trees and `Cargo.lock` hash the same at `b855b4a` and at `76549f6`
(`git diff --stat b855b4a 76549f6 -- onchain/programs onchain/Cargo.toml onchain/Cargo.lock` is empty).
An auditor may pin either commit; the tree hashes above are what must match. If any program changes
before the engagement starts, this table is regenerated and the new hashes are sent with it.

## Programs in scope

Anchor 0.31.1 workspace at `onchain/` (`Anchor.toml`, `Cargo.toml`). Release profile: `opt-level = "z"`,
`overflow-checks = true`, `lto = "fat"`, `codegen-units = 1`.

Lines counted with `awk` per file: blank lines, lines whose first non-space characters are `//`
(comments and doc comments), and the rest ("code"). Counted 2026-10-10 on the tree hashes above.

| Program | Id | File | Total | Blank | Comment | Code |
|---|---|---|---|---|---|---|
| `lineage_registry` | `2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY` | `programs/lineage-registry/src/lib.rs` | 1,293 | 70 | 127 | 1,096 |
| | | `programs/lineage-registry/src/challenge.rs` | 591 | 27 | 66 | 498 |
| | | `programs/lineage-registry/src/leaf.rs` | 272 | 18 | 38 | 216 |
| | | `programs/lineage-registry/Cargo.toml` | 27 | | | |
| | | **subtotal (Rust)** | **2,156** | **115** | **231** | **1,810** |
| `lineage_launch` | `8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT` | `programs/lineage-launch/src/lib.rs` | 1,089 | 57 | 131 | 901 |
| | | `programs/lineage-launch/src/bounty.rs` | 710 | 43 | 78 | 589 |
| | | `programs/lineage-launch/src/meteora.rs` | 308 | 17 | 35 | 256 |
| | | `programs/lineage-launch/Cargo.toml` | 28 | | | |
| | | **subtotal (Rust)** | **2,107** | **117** | **244** | **1,746** |
| `lineage_msg` | `E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB` | `programs/lineage-msg/src/lib.rs` | 451 | 36 | 50 | 365 |
| | | `programs/lineage-msg/Cargo.toml` | 27 | | | |
| **All three** | | **7 Rust files** | **4,714** | **268** | **525** | **3,921** |

Of these, two in-crate unit test modules are not program code: `leaf.rs` lines 251 to 272 and
`bounty.rs` lines 700 to 710.

`lineage_launch` depends on `lineage_registry` (feature `cpi`) for its CPI to `register_launched`, its
leaf encoder (`lineage_registry::leaf`) and the typed reads of registry accounts. `lineage_msg`
depends on `lineage_registry` to read `Agent` records. Neither writes registry state except through
the registry's own instructions.

### External programs the launch program calls (not in scope, but their interface is)

`lineage_launch` has no Meteora crate. `src/meteora.rs` pins program ids, PDAs, instruction and
account discriminators and fixed byte offsets, and makes raw CPIs:

| Program | Id | Build the LiteSVM suite runs | sha256 of the vendored dump |
|---|---|---|---|
| Meteora Dynamic Bonding Curve (DBC) | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | devnet dump, re-dumped 2026-10-09 | `5edf76d972abaf355048db5d9003bc4dfa843cd98a5f93785430dac371678ad3` |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | devnet dump 2026-10-07 | `82bb9375921bb8007551cb65f9ca43b191597496cc9922926468b36671081ec2` |
| DAMM v2 config account fixture | `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` | committed `.bin` | `988089b8bacd1967ad85e4acd2bb520c847c872a74fed0614b01a89c57ae73a5` |

Source: `onchain/vendor/meteora/README.md` (hashes re-checked with `shasum -a 256` on 2026-10-10). The
README records that mainnet ran older DBC builds when it was written, so the offsets must be
re-checked against the exact mainnet builds (see `REVIEW-AREAS.md`).

## Test code (supporting material, not in scope)

| File | Total lines | Code lines |
|---|---|---|
| `onchain/tests/src/lib.rs` (LiteSVM harness) | 873 | 804 |
| `onchain/tests/tests/registry.rs` | 561 | 485 |
| `onchain/tests/tests/launch.rs` | 732 | 648 |
| `onchain/tests/tests/identity.rs` | 235 | 201 |
| `onchain/tests/tests/bounty.rs` | 621 | 543 |
| `onchain/tests/tests/challenge.rs` | 416 | 336 |
| `onchain/tests/tests/msg.rs` | 411 | 354 |
| `onchain/tests/tests/client_vectors.rs` | 450 | 433 |

## Deployed on devnet

Read from devnet on 2026-10-10 at 13:14 UTC with `solana program show -u devnet <id>` and
`solana program dump -u devnet <id> <file>` followed by `shasum -a 256`. Nothing is deployed to mainnet.

| Program | ProgramData | Upgrade authority | Last deployed slot | Data length | sha256 of the dump | Equals |
|---|---|---|---|---|---|---|
| `lineage_registry` | `3YwmdjWmRuf6S1mQaWUQ43Fiu5rwdkhu6z81kLB2Whm2` | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` | 509,305,148 | 728,000 | `547eafe6...944c` whole account; the first 723,776 bytes hash `8f3861a414b6b13e6acf3d13f2222502f9c1d2b8f04485f880b1231b6fa62b32` and the remaining 4,224 bytes are zero | the local build `target/deploy/lineage_registry.so` (723,776 bytes, `8f3861a4...2b32`) |
| `lineage_launch` | `AuxNHnyVm4GSHQoScSBN8eY4BrcBTgGV5mSwWT6Bhbpa` | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` | 509,305,277 | 744,448 | `762a18d9942316140cca508dd3b3b49f062c5ed19c174ada67d9b15dbd9e30b0` | the local build (`762a18d9...30b0`) |
| `lineage_msg` | `5MyrfyAg9E5eSmvyxbfaiT7s2gAEsSeKjRjJjB7inX5R` | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` | 508,815,067 | 342,200 | `94de4765ab321743e71610d5b1eb589334834b01f0d08a4ae3f6a6bac1d90b62` | its build at deploy (onchain/DEVNET.md "Onchain messages"); see the note below |

The registry's ProgramData is longer than the build because the upgrade extended it by the loader's
10,240-byte minimum (onchain/DEVNET.md "Internal audit A1 upgrade").

`lineage_msg`: the local `target/deploy/lineage_msg.so` today hashes
`0d402e828f209bdd3f94fa10a637d940fce717076d426e1bc9d10136b780d085`, not the deployed `94de4765...0b62`.
`lineage_msg` compiles the registry crate in, and the registry source changed after `lineage_msg` was
deployed (W7 challenges, A1 fixes); `lineage_msg`'s own source is unchanged since `257fe85`
(docs/AUDIT.md "Onchain", first paragraph). The deployed binary therefore corresponds to
`lineage_msg` at `257fe85` built with the registry crate as of that commit. An audit of `lineage_msg`
should either review the deployed pairing or have it redeployed from the audited commit before
mainnet.

Devnet roles on 2026-10-10 (onchain/DEVNET.md "Wiring", docs/AUDIT.md "Powers"): the deployer
`CVEZWy...nDih` is the upgrade authority of all three programs and the registry, launch and messages
admin; the Core authority is `CjNUnQ3v2FRQJiMr16CfaFWCdzJ3nqq1VvY2zAgsc4j9`; the runtime authority is
`DCmdy5MoAfnN6fn3nVW27db62ZwtjoksqSqdjAc8VPk4` and owns the compute sink. The TEST quote mint is
`3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU` (Token-2022, mint authority revoked).

## Toolchain the figures above were produced with

anchor-cli 0.31.1, solana-cli 3.1.12 (Agave), `cargo-build-sbf` 3.1.12 with platform tools v1.52
(rustc 1.89.0 for SBF), host rustc 1.94.1, LiteSVM 0.6.1, Bun 1.3.13. `blake3` is pinned to 1.8.2 in
`Cargo.lock` (onchain/README.md "Build and test" explains why).

## Out of scope for the program audit, in scope for a wider review

The offchain system the programs trust (see `ARCHITECTURE.md`): Core (`packages/core`), the worker and
sandbox (`packages/worker`, `packages/sandbox`), the hosted runtime (`packages/runtime`), the
TypeScript client and co-sign guards (`packages/chain`), the wallet pages (`apps/web/wallet`), the
market indexer (`packages/indexer`) and the site deploy kit (`scripts/deploy`). docs/AUDIT.md
"Offchain" lists what the internal review found there; `REVIEW-AREAS.md` lists what we would like a
second look at if the engagement covers it.
