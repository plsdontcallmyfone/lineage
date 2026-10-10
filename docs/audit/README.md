# External audit package

Prepared 2026-10-10 (docs/plans/MAINNET-PREP.md, M6) for an external security review of the Lineage
Solana programs before any mainnet deployment. Nothing is deployed to mainnet. Every claim in these
files points to a source in the repository, a command we ran, or a page we read, with the date.

| File | What |
|---|---|
| [SCOPE.md](SCOPE.md) | exact commits and tree hashes, per-program files and lines of code, devnet program ids, ProgramData, upgrade authority and bytecode hashes, toolchain |
| [ARCHITECTURE.md](ARCHITECTURE.md) | components, what the programs enforce onchain, what Core, the runtime and verifiers decide offchain, the trust anchors, one epoch end to end |
| [THREAT-MODEL.md](THREAT-MODEL.md) | SPEC 15 in full, split into onchain and offchain enforcement, with the test for each onchain row, and the known residuals |
| [INTERNAL-AUDIT.md](INTERNAL-AUDIT.md) | every A1 (onchain) and A2 (offchain) internal audit item and the 2026-10-07 review items, each with its fix, commit and test |
| [POWERS.md](POWERS.md) | the admin and authority powers table, holders, owner powers, permissionless instructions, pause coverage |
| [BUILD-AND-TEST.md](BUILD-AND-TEST.md) | how to build and run the LiteSVM suites, the TypeScript client tests and the devnet end to end scripts, with our results of 2026-10-10 |
| [REVIEW-AREAS.md](REVIEW-AREAS.md) | where we most want review time, and known drift between SPEC and the code |
| [firms.md](firms.md) | shortlist of established Solana audit firms: what each asks for, its process and contact, read from each firm's own site |
| [runs/](runs/) | raw outputs: `LITESVM-2026-10-10.txt`, `DEVNET-2026-10-10.md` |

## Headline figures (all from the files above)

- Three Anchor 0.31.1 programs, 3,921 lines of Rust code (4,714 lines with comments and blanks):
  `lineage_registry` 1,810, `lineage_launch` 1,746, `lineage_msg` 365.
- LiteSVM 61/61 against the real Meteora DBC and DAMM v2 builds; program unit tests 5/5;
  `packages/chain` 129/129 (2026-10-10).
- Devnet: `lineage_registry` and `lineage_launch` bytecode equals the local build of the audited
  commit; `lineage_msg` is the build of its own unchanged source from 2026-10-08 (see `SCOPE.md`).
  Graduation e2e 16/16 and the A1 proof 9/9 rerun on devnet on 2026-10-10.
- Internal audit: onchain 2 high and 3 medium fixed, 6 low or info accepted; offchain 8 high and
  42 medium or low fixed, 4 partly fixed, 10 accepted (docs/AUDIT.md).

## Background reading in the repository

docs/SPEC.md (sections 10, 13, 14, 15 for the programs), docs/AUDIT.md, onchain/README.md,
onchain/DEPLOY.md, onchain/DEVNET.md, docs/plans/MAINNET-PREP.md.
