# Scope

Prepared 2026-10-10 by the audit package lane (M6, `docs/plans/MAINNET-PREP.md`). Every figure below
was read or measured on that date with the command shown; nothing is estimated.

## Commits

| What | Value | How read |
|---|---|---|
| Repository | `github.com/plsdontcallmyfone/lineage`, branch `main` | `git remote -v` |
| Repository head when this package was prepared | `76549f62885913c56dcf72bbb188d6b2c253a279` | `git log -1` |
| Last commit that changed any program source | `9f7035789fdc2f9c076b3d1af299a38e7cf28112` ("pre-audit program changes": A1-08 slash cap, mainnet ids by cargo feature, 2026-10-10) | `git log -- onchain/programs` |
| Previous program commit (the first version of this table) | `b855b4a682b54fc5a977a6861da08bb417171a20` ("audit A1: onchain fixes") | same |
| `lineage_msg` source last changed | `9f70357` (only its `declare_id!` per feature and its `mainnet` feature; before that `257fe85`, 2026-10-08) | `git log -- onchain/programs/lineage-msg` |
| Tree `onchain/programs/lineage-registry` | `fcdd35a605edd6db1df0b09afbf7bb7db775d277` (was `1cd55714...fe15`) | `git rev-parse 9f70357:onchain/programs/lineage-registry` |
| Tree `onchain/programs/lineage-launch` | `abd42ea54d3ad76f458a4a7fb506dd760f8e41b5` (was `455d3717...201e`) | same |
| Tree `onchain/programs/lineage-msg` | `35b655c66e886acc32222b7fd90754b98bff868c` (was `22a99ff1...b14c`) | same |
| Blob `onchain/Cargo.lock` | `ae07e6cfbce9d993be465bd7a50be26c857ea07d` (unchanged) | `git rev-parse 9f70357:onchain/Cargo.lock` |

Regenerated 2026-10-10 after the pre-audit program changes (owner decisions of 2026-10-10, both
before the audit commit is frozen). The tree hashes above are what must match; an auditor pins
`9f70357` or any later commit whose program trees and `Cargo.lock` hash the same (`git diff --stat
9f70357 <commit> -- onchain/programs onchain/Cargo.toml onchain/Cargo.lock` empty). If any program
changes again before the engagement starts, this table is regenerated and the new hashes are sent with it.

## Programs in scope

Anchor 0.31.1 workspace at `onchain/` (`Anchor.toml`, `Cargo.toml`). Release profile: `opt-level = "z"`,
`overflow-checks = true`, `lto = "fat"`, `codegen-units = 1`.

Lines counted with `awk` per file: blank lines, lines whose first non-space characters are `//`
(comments and doc comments), and the rest ("code"). Recounted 2026-10-10 on the tree hashes above
(`9f70357`).

| Program | Id | File | Total | Blank | Comment | Code |
|---|---|---|---|---|---|---|
| `lineage_registry` | devnet `2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY`, mainnet `3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay` | `programs/lineage-registry/src/lib.rs` | 1,388 | 75 | 151 | 1,162 |
| | | `programs/lineage-registry/src/challenge.rs` | 591 | 27 | 66 | 498 |
| | | `programs/lineage-registry/src/leaf.rs` | 272 | 18 | 38 | 216 |
| | | `programs/lineage-registry/Cargo.toml` | 29 | | | |
| | | **subtotal (Rust)** | **2,251** | **120** | **255** | **1,876** |
| `lineage_launch` | devnet `8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT`, mainnet `2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq` | `programs/lineage-launch/src/lib.rs` | 1,094 | 57 | 133 | 904 |
| | | `programs/lineage-launch/src/bounty.rs` | 710 | 43 | 78 | 589 |
| | | `programs/lineage-launch/src/meteora.rs` | 308 | 17 | 35 | 256 |
| | | `programs/lineage-launch/Cargo.toml` | 30 | | | |
| | | **subtotal (Rust)** | **2,112** | **117** | **246** | **1,749** |
| `lineage_msg` | devnet `E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB`, mainnet `jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky` | `programs/lineage-msg/src/lib.rs` | 455 | 36 | 51 | 368 |
| | | `programs/lineage-msg/Cargo.toml` | 29 | | | |
| **All three** | | **7 Rust files** | **4,818** | **273** | **552** | **3,993** |

Before the pre-audit changes (`b855b4a`) the same count was 4,714 total and 3,921 code lines. The ids
are selected at build time: the default build declares the devnet ids, the cargo feature `mainnet`
the mainnet ids (SPEC 14.11); `lineage_launch` and `lineage_msg` forward the feature to the registry
crate. Both variants are in scope; they differ only in the declared ids.

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
| `onchain/tests/tests/registry.rs` | 562 | 486 |
| `onchain/tests/tests/launch.rs` | 732 | 648 |
| `onchain/tests/tests/identity.rs` | 235 | 201 |
| `onchain/tests/tests/bounty.rs` | 621 | 543 |
| `onchain/tests/tests/challenge.rs` | 416 | 336 |
| `onchain/tests/tests/msg.rs` | 411 | 354 |
| `onchain/tests/tests/client_vectors.rs` | 457 | 440 |
| `onchain/tests/tests/slash_cap.rs` (pre-audit, A1-08) | 200 | 155 |

## Deployed on devnet

Read from devnet on 2026-10-10 at 16:06 UTC, after the pre-audit upgrade, with `solana program show -u
devnet <id>` and `solana program dump -u devnet <id> <file>`; the dump's first bytes (as many as the
build) hashed with sha256 and the rest checked to be zero. Nothing is deployed to mainnet.

| Program | ProgramData | Upgrade authority | Last deployed slot | Data length | Dump | Equals |
|---|---|---|---|---|---|---|
| `lineage_registry` | `3YwmdjWmRuf6S1mQaWUQ43Fiu5rwdkhu6z81kLB2Whm2` | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` | 509,594,590 | 738,240 | first 732,472 bytes hash `7287a911843b531244d0c6e50923d38d850099800de153ea47dca6587d346ede`, the remaining 5,768 bytes are zero | the local devnet build at `9f70357` |
| `lineage_launch` | `AuxNHnyVm4GSHQoScSBN8eY4BrcBTgGV5mSwWT6Bhbpa` | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` | 509,594,746 | 754,688 | first 745,216 bytes hash `d1ab4dbf15f3d7b2c1e5a7fc0791c4e56cd1f4b5979c5e2db06829a2a974f36e`, the remaining 9,472 bytes are zero | the local devnet build at `9f70357` |
| `lineage_msg` | `5MyrfyAg9E5eSmvyxbfaiT7s2gAEsSeKjRjJjB7inX5R` | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` | 508,815,067 | 342,200 | `94de4765ab321743e71610d5b1eb589334834b01f0d08a4ae3f6a6bac1d90b62` | its build at deploy (onchain/DEVNET.md "Onchain messages"); see the note below |

The devnet Config was grown by `migrate_config_slash_cap` with 7,500 bps (onchain/DEVNET.md
"Pre-audit program changes"). The previous version of this table (13:14 UTC) read registry
`8f3861a4...2b32` and launch `762a18d9...30b0`, the builds of `b855b4a`.

Both ProgramData accounts are longer than the builds because each upgrade that outgrew them extended
them by the loader's 10,240-byte minimum (onchain/DEVNET.md "Internal audit A1 upgrade" and
"Pre-audit program changes").

`lineage_msg`: the local `target/deploy/lineage_msg.so` at `9f70357` hashes
`ebdccd343a6cf57b5ad896609be41719a4f8b9850fb78a1488fe5ee2d8ad9b81`, not the deployed `94de4765...0b62`
(it was not upgraded on 2026-10-10).
`lineage_msg` compiles the registry crate in, and the registry source changed after `lineage_msg` was
deployed (W7 challenges, A1 fixes); `lineage_msg`'s own source is unchanged since `257fe85` except the per-feature `declare_id!` of `9f70357`
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
