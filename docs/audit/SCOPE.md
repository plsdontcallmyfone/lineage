# Scope

Prepared 2026-10-10 by the audit package lane (M6, `docs/plans/MAINNET-PREP.md`). Every figure below
was read or measured on that date with the command shown; nothing is estimated.

## Commits

| What | Value | How read |
|---|---|---|
| Repository | `github.com/plsdontcallmyfone/lineage`, branch `main` | `git remote -v` |
| Repository head when this package was regenerated | `39bb221d2af8140ecdf05aeeb4a29efa9ec00697` | `git log -1` |
| Last commit that changed any program source | `6b24162a14828da8f8269cdd4d9c474d58cd0c5e` ("lineage_launch on pump.fun only", owner decisions 2026-10-10) | `git log -- onchain/programs` |
| Previous program commits | `9f70357` (pre-audit: A1-08 slash cap, mainnet ids by cargo feature), `b855b4a` (audit A1 onchain fixes); `eb8ac23` and `daa07db` removed and restored `meteora.rs` by mistake and net to no change | same |
| Tree `onchain/programs/lineage-registry` | `fcdd35a605edd6db1df0b09afbf7bb7db775d277` (unchanged since `9f70357`) | `git rev-parse 6b24162:onchain/programs/lineage-registry` |
| Tree `onchain/programs/lineage-launch` | `6fcfc385040cff0ddc8922be0264c213d37ef76e` (was `abd42ea5...41b5` at `9f70357`) | same |
| Tree `onchain/programs/lineage-msg` | `35b655c66e886acc32222b7fd90754b98bff868c` (unchanged since `9f70357`) | same |
| Blob `onchain/Cargo.lock` | `ae07e6cfbce9d993be465bd7a50be26c857ea07d` (unchanged) | `git rev-parse 6b24162:onchain/Cargo.lock` |

Regenerated 2026-10-10 after the pump.fun venue change (owner decisions of 2026-10-10: pump.fun only,
Meteora removed, same-transaction attach; docs/plans/PUMPFUN-LAUNCHES.md), made before the audit
commit is frozen. The tree hashes above are what must match; an auditor pins `6b24162` or any later
commit whose program trees and `Cargo.lock` hash the same (`git diff --stat 6b24162 <commit> --
onchain/programs onchain/Cargo.toml onchain/Cargo.lock` empty; empty at `39bb221`). If any program
changes again before the engagement starts, this table is regenerated and the new hashes are sent with it.

## Programs in scope

Anchor 0.31.1 workspace at `onchain/` (`Anchor.toml`, `Cargo.toml`). Release profile: `opt-level = "z"`,
`overflow-checks = true`, `lto = "fat"`, `codegen-units = 1`.

Lines counted with `awk` per file: blank lines, lines whose first non-space characters are `//`
(comments and doc comments), and the rest ("code"). Recounted 2026-10-10 on the tree hashes above
(`6b24162`, `git show 6b24162:<file> | awk ...`).

| Program | Id | File | Total | Blank | Comment | Code |
|---|---|---|---|---|---|---|
| `lineage_registry` | devnet `2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY`, mainnet `3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay` | `programs/lineage-registry/src/lib.rs` | 1,388 | 75 | 151 | 1,162 |
| | | `programs/lineage-registry/src/challenge.rs` | 591 | 27 | 66 | 498 |
| | | `programs/lineage-registry/src/leaf.rs` | 272 | 18 | 38 | 216 |
| | | `programs/lineage-registry/Cargo.toml` | 29 | | | |
| | | **subtotal (Rust)** | **2,251** | **120** | **255** | **1,876** |
| `lineage_launch` | devnet `8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT`, mainnet `2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq` | `programs/lineage-launch/src/lib.rs` | 843 | 48 | 102 | 693 |
| | | `programs/lineage-launch/src/bounty.rs` | 710 | 43 | 78 | 589 |
| | | `programs/lineage-launch/src/pump.rs` | 126 | 9 | 22 | 95 |
| | | `programs/lineage-launch/Cargo.toml` | 30 | | | |
| | | **subtotal (Rust)** | **1,679** | **100** | **202** | **1,377** |
| `lineage_msg` | devnet `E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB`, mainnet `jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky` | `programs/lineage-msg/src/lib.rs` | 455 | 36 | 51 | 368 |
| | | `programs/lineage-msg/Cargo.toml` | 29 | | | |
| **All three** | | **7 Rust files** | **4,385** | **256** | **508** | **3,621** |

At `9f70357` (Meteora venue, `meteora.rs` 308 lines) the same count was 4,818 total and 3,993 code
lines; at `b855b4a` 4,714 and 3,921. The ids
are selected at build time: the default build declares the devnet ids, the cargo feature `mainnet`
the mainnet ids (SPEC 14.11); `lineage_launch` and `lineage_msg` forward the feature to the registry
crate. Both variants are in scope; they differ only in the declared ids.

Of these, two in-crate unit test modules are not program code: `leaf.rs` lines 251 to 272 and
`bounty.rs` lines 700 to 710.

`lineage_launch` depends on `lineage_registry` (feature `cpi`) for its CPI to `register_launched`, its
leaf encoder (`lineage_registry::leaf`) and the typed reads of registry accounts. `lineage_msg`
depends on `lineage_registry` to read `Agent` records. Neither writes registry state except through
the registry's own instructions.

### External programs the launch program reads (not in scope, but their interface is)

`lineage_launch` never calls pump.fun (no CPI, no pump.fun crate). `src/pump.rs` pins program ids,
PDAs, the `create_v2` instruction discriminator, account discriminators and fixed byte offsets, and
reads three foreign accounts: Pump `BondingCurve` (owner, PDA `["bonding-curve", mint]`,
discriminator, length at least 166), Pump `Global` (fixed address, owner, discriminator, length at
least 105) and PumpSwap `Pool` (canonical PDA, owner, discriminator, length at least 243). It also
reads the instructions sysvar to find the same transaction's top-level `create_v2`. The fee route runs
through pump.fun's own permissionless sweeps and collects, which the keeper puts in front of
`crank_pump_fees`.

| Program | Id | Build the LiteSVM suite runs | sha256 of the vendored dump |
|---|---|---|---|
| Pump | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | mainnet dump 2026-10-10 | `a4b32d322295a15666b1293e0028b9b75d688bfce10b574e1094f249f2ce9f16` |
| PumpSwap | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | mainnet dump 2026-10-10 | `a8d05e6927cc6e861d3052a9bf2258ce3a4588f47307d53d0c20ecbe0b86697e` |
| Pump Fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | mainnet dump 2026-10-10 | `73c679c8dae8d24153fdd0455b557b73662e93ab2ec88831a9e4be2b08a897a4` |
| Mayhem | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` | mainnet dump 2026-10-10 | `a87fa9f866272514e6acb852b668c4a08aeb173d56c883039991d114d1199bdb` |

Seven mainnet account fixtures run with them (Pump `Global`, quote control, both fee configs, PumpSwap
global config, Mayhem global params, buyback recipient 0), each pinned by sha256 in
`onchain/tests/src/pumpfun.rs` (`FIXTURES`). Source: `onchain/vendor/pump/fetch.sh` (dumps read with an
explicit `-u`; the `.so` files are not committed, the fixtures are). Layouts follow pump.fun's IDLs at
github.com/pump-fun/pump-public-docs commit `2293f9a` (read 2026-10-10); pump.fun appends fields only,
so the readers require a minimum length. pump.fun can upgrade these programs at any time: re-run
`fetch.sh`, the suite and the fork rehearsal before any mainnet deploy (`REVIEW-AREAS.md`).

The Meteora DBC and DAMM v2 interface (`src/meteora.rs`, `vendor/meteora`) was removed at `6b24162`;
git history keeps it.

## Test code (supporting material, not in scope)

| File | Total lines | Code lines |
|---|---|---|
| `onchain/tests/src/lib.rs` (LiteSVM harness) | 770 | 698 |
| `onchain/tests/src/pumpfun.rs` (pump.fun programs, fixtures, raw builders) | 292 | 263 |
| `onchain/tests/tests/registry.rs` | 561 | 485 |
| `onchain/tests/tests/launch.rs` (pump.fun venue) | 473 | 420 |
| `onchain/tests/tests/identity.rs` | 235 | 201 |
| `onchain/tests/tests/bounty.rs` | 619 | 541 |
| `onchain/tests/tests/challenge.rs` | 416 | 336 |
| `onchain/tests/tests/msg.rs` | 411 | 354 |
| `onchain/tests/tests/client_vectors.rs` | 429 | 412 |
| `onchain/tests/tests/init_auth.rs` | 135 | 108 |
| `onchain/tests/tests/slash_cap.rs` (pre-audit, A1-08) | 200 | 155 |

## Deployed on devnet

Devnet still runs the Meteora-venue builds below: the pump.fun `lineage_launch` (`6b24162`) is not
deployed there, because devnet's registry and launch config are bound to the earlier tLINE mint at
initialize and a pump.fun launch needs `$LINE` to be a pump.fun coin (owner decision pending,
docs/plans/PUMPFUN-LAUNCHES.md). The audit target is `6b24162`, not the devnet binaries.

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
