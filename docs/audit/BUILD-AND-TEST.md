# Build and test

Every command below was run on 2026-10-10 by the audit package lane; the results are what was
observed, with the raw outputs in `runs/`. Machine: macOS (Darwin 25.5, arm64). Toolchain in
`SCOPE.md`.

**Update, 2026-10-10 (pre-audit program changes lane, commit `9f70357`).** The programs changed after
this package was first prepared: the A1-08 slash cap and the mainnet program ids by cargo feature
(docs/AUDIT.md A1-08, SPEC 14.1 and 14.11). Every figure below that names a hash or a test count was
rerun on that commit and is marked "pre-audit"; the earlier runs stay in `runs/` for the record.

**Update, 2026-10-10 (pump.fun launches lane, commit `6b24162`).** `lineage_launch` moved to pump.fun
only (owner decisions of 2026-10-10). The registry and messages sources did not change (tree hashes in
`SCOPE.md`). Figures marked "pump.fun" below were measured on that commit; the Meteora-era figures stay
for the record.

## Prerequisites

- anchor-cli 0.31.1 (only for its conventions; `anchor deploy` is never used, and `anchor build` is
  not needed), solana-cli 3.1.12 with `cargo-build-sbf` (platform tools v1.52), a host Rust toolchain,
  Bun 1.3 for the TypeScript client and the devnet scripts.
- The pump.fun program dumps the LiteSVM suite loads: `onchain/vendor/pump/pump.so`, `pump_amm.so`,
  `pump_fees.so`, `mayhem.so` (not committed) and seven committed account fixtures.
  `onchain/vendor/pump/fetch.sh` dumps them read-only from mainnet (explicit `-u`); the suite checks
  every sha256 pinned in `onchain/tests/src/pumpfun.rs` (listed in `SCOPE.md`). If pump.fun redeploys
  the hash check fails; we can send the exact files on request. (Until `6b24162` the suite loaded
  Meteora DBC and DAMM v2 dumps from `onchain/vendor/meteora`, removed with the venue.)
- Disk: a full first build of the workspace and its host test dependencies needs several GB. Our
  existing `onchain/target` is 2.4 GB.

Never run `cargo clean` or delete `onchain/target` on our machines: `target/deploy` holds the program
id keypairs (backed up in `onchain/keys-backup/`, gitignored). An auditor's own clone generates its
own keypairs, which only matter for deploying.

## Build the programs

```sh
cd onchain
vendor/pump/fetch.sh
cargo build-sbf --offline --manifest-path programs/lineage-registry/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-launch/Cargo.toml   --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-msg/Cargo.toml      --sbf-out-dir target/deploy
shasum -a 256 target/deploy/*.so
```

Drop `--offline` on a machine without a warm cargo cache. Expected hashes (pre-audit, commit `9f70357`,
devnet build, the default): registry `7287a911843b531244d0c6e50923d38d850099800de153ea47dca6587d346ede`
(732,472 bytes), launch `d1ab4dbf15f3d7b2c1e5a7fc0791c4e56cd1f4b5979c5e2db06829a2a974f36e` (745,216
bytes), both equal to the devnet dumps read after the 2026-10-10 upgrade; `lineage_msg.so`
`ebdccd343a6cf57b5ad896609be41719a4f8b9850fb78a1488fe5ee2d8ad9b81` (342,600 bytes; differs from the
deployed `94de4765...0b62` for the reason in `SCOPE.md`).

pump.fun hashes (commit `6b24162`, `shasum -a 256` and `wc -c`): launch
`d8dfee8e83caa05b619e609e0cb8543abf814616540bcf2ea4ab7ec763c5f30a` (685,240 bytes); registry and msg
unchanged (`7287a911...6ede` 732,472 bytes, `ebdccd34...9b81` 342,600 bytes). Not deployed to devnet
(`SCOPE.md` "Deployed on devnet").

The mainnet build (same sources, cargo feature `mainnet`, SPEC 14.11):

```sh
for p in lineage-registry lineage-launch lineage-msg; do
  cargo build-sbf --offline --manifest-path programs/$p/Cargo.toml --features mainnet --sbf-out-dir target/mainnet; done
rm target/mainnet/*-keypair.json   # cargo build-sbf writes throwaway id keypairs; they are NOT the mainnet ids
```

Pre-audit hashes: registry `ea000f217db97ac7702f0cb8101838c741aa694ef3f140f2fa37f90f755decb6`, launch
`a9123cdd014a756b6862573811d5ce8ed34b2a51a4ca44311dc5c32e7de48f79`, msg
`f633adc2db6aa618bbad34f741254e91421858eb2c56ab3cf3daffecc2bf287f` (same sizes as the devnet builds). pump.fun: launch `b40c047be6eaf91fb8a5a50f6b7106d625af039c50883beab9a22db9a41b349d`
(685,240 bytes); registry and msg unchanged (`ea000f21...decb6`, `f633adc2...f287f`).
Checked by searching each `.so` for the 32-byte ids: every mainnet build embeds only the mainnet ids
(its own and the registry's), every devnet build only the devnet ids.
Reproducibility across machines has not been tested; `solana-verify` (Docker-based verifiable builds)
has not been set up yet.

## LiteSVM suites

```sh
cd onchain
cargo test --offline -p lineage-onchain-tests       # loads target/deploy/*.so and the pump.fun dumps
cargo test --offline -p lineage-registry --lib      # leaf encoder unit tests
cargo test --offline -p lineage-launch --lib        # bounty target JSON unit test
```

The suites run the compiled `.so` files, so rebuild the programs after any source change.

Result on 2026-10-10 13:21 UTC (`runs/LITESVM-2026-10-10.txt`), against the `.so` files hashed above:

| Suite | Passed | What it covers |
|---|---|---|
| `tests/registry.rs` | 13/13 | config validation and floors, pause, register and launched-only registration, bond, unbond cooldown, slash once per id, strikes and suspension, split, clocked epoch posts with caps, claims with TypeScript-built roots, over-claim, mint extension allowlist, layout migration |
| `tests/launch.rs` | 13/13 | (Meteora venue, before `6b24162`) full launch on the real DBC, trades and the exact fee split, migration, graduation, forged dust position, admin graduation, fees left at migration, usage roots and debits, debit cap, self-hosted withdrawals, sleep and wake, pause, longest launch fits one transaction, DBC config offsets |
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

Pre-audit rerun (commit `9f70357`, 2026-10-10): `runs/LITESVM-PREAUDIT-2026-10-10.txt` (devnet
Meteora pins) and `runs/LITESVM-PREAUDIT-MAINNET-METEORA-2026-10-10.txt` (`METEORA_BUILD=mainnet`):
**69/69 on each**, the suites above (`init_auth.rs` 3/3 from the spec drift lane included) plus
`tests/slash_cap.rs` 5/5 (A1-08: several slashes stop at the cap, one slash past the room left, reset
with the next epoch post and per agent, admin-only edits and bounds, `migrate_config_slash_cap`). The
five slash cap tests were run red against the previous build (all five failed) before the fix was
built. `lineage-registry --lib` 3/3 and `lineage-launch --lib` 2/2 pass with and without
`--features mainnet`; `cargo clippy` clean on all three programs with and without the feature.

pump.fun (commit `6b24162`, 2026-10-10): `cargo test --offline -p lineage-onchain-tests` **69/69** on
mainnet's pump.fun dumps (bounty 13, challenge 8, client_vectors 1, identity 7, init_auth 3, launch 13,
msg 6, registry 13, slash_cap 5). `tests/launch.rs` is new: create_v2 + register in one transaction,
9 spoofing attempts refused, the configured creator fee rate, exact fee splits on the curve and after
graduation (curve leftover plus pool), the removed Meteora instructions, Meteora-era records, usage,
debits, withdrawals, sleep and wake, pause, the config migration. `$LINE` in the suites that launch
agents is a real pump.fun coin (`LineKind::PumpCoin`). Red then green: the new suite ran against the
previous `lineage_launch.so` first (13 of 13 failed). `lineage-launch --lib` 2/2 and
`lineage-registry --lib` 3/3 rerun 2026-10-10; `cargo clippy` clean on the programs.

Fork rehearsal on pump.fun (2026-10-10, `LINEAGE_NETWORK=mainnet bun scripts/mainnet/rehearsal.ts` on a fresh `scripts/mainnet/fork.sh` fork with mainnet's Pump, PumpSwap, Pump Fees, Mayhem, Token-2022 and Squads v4 builds): PASS 102/102, 85 transactions measured (`scripts/mainnet/REHEARSAL-LAST.json`). The `--features mainnet` builds deployed at the mainnet ids (launch 685,240 bytes, `b40c047b...349d`); two agent launches as the wizard plans them (one quoted in the stand-in `$LINE` on its curve, one after `$LINE` migrated), the 1% initial buy at exactly the quoted cost, curve and PumpSwap trades, `multi_hop_swap` from SOL, three keeper cranks with exact 7,000/3,000 splits of the curve and pool creator fees, a synthetic-migration completion, `migrate_v2` + `record_pump_graduation` (Pool.coin_creator = the agent's PDA, LP supply 0), every admin action through the 2-of-3 vault, epochs, a challenge, claims and the slash cap. Before the program change: `scripts/mainnet/pump-fork-proof.ts` PASS 28/28 (`PUMP-FORK-LAST.json`).

## TypeScript client and fixtures

From the repository root:

```sh
bun install --frozen-lockfile
bun test packages/chain                       # 129/129 on 2026-10-10; pre-audit 173/173 (incl. programs.test.ts); 176/176 after the ids follow the profile
bun onchain/scripts/make-fixtures.ts --check  # "merkle.json current"
```

`packages/chain` holds the instruction builders, PDAs and account decoders the app, Core and scripts
use; its tests check them against `onchain/tests/fixtures/client-vectors.json`, which the LiteSVM
`client_vectors` test produces. `make-fixtures.ts` rebuilds the Merkle fixtures with the protocol
package and checks they equal the committed ones, which ties Core's leaf and root encoding to the
Rust encoder (`registry.rs` `leaves_match_the_typescript_protocol`).

Run log, 2026-10-10 (mainnet ids follow-up lane): the builders, PDAs and readers now take the active
network profile's program ids (`packages/chain/src/programs.ts`; devnet output byte-identical: a
snapshot of every PDA helper and a set of builders hashed `eec8290f...108b` before and after, and the
client vector tests unchanged). The mainnet fork rehearsal (`LINEAGE_NETWORK=mainnet
scripts/mainnet/rehearsal.ts`) deployed the three `target/mainnet` builds above, hashes unchanged, at
the mainnet ids and passed 97/97 including the slash cap (`scripts/mainnet/REHEARSAL-LAST.json`,
docs/MAINNET-COSTS.md). No program source changed.

## Devnet end to end

Devnet scripts need the devnet keys under `~/.config/lineage/` (not in the repository) and pass them
explicitly; they never change `solana config`. They append a transaction log to `onchain/DEVNET.md`.

| Script | What it proves | Uses | Run on 2026-10-10 |
|---|---|---|---|
| `scripts/devnet/graduation-e2e.ts` (Meteora venue; removed 2026-10-10, git history keeps it) | launch, curve fill, `crank_fees` exact split, Meteora migration, `graduate`, `crank_pool_fees`, `repoint_position` to a larger locked position, totals | deployer | PASS 16/16, 0.042965 devnet SOL (`runs/DEVNET-2026-10-10.md`) |
| `onchain/scripts/audit-a1-devnet.ts` | A1-03 (seller refused after an owner transfer for withdraw, open and cancel; buyer allowed) and A1-01 (donation then cancel in one transaction) | deployer | PASS 9/9, 0.037602 devnet SOL (same file) |
| (pre-audit) `scripts/devnet/graduation-e2e.ts` after the A1-08 registry and launch upgrade | as above | deployer | PASS 16/16, 0.042965 devnet SOL (onchain/DEVNET.md "Pre-audit program changes") |
| (pre-audit) `onchain/scripts/audit-a1-devnet.ts` after the same upgrade | as above | deployer | PASS 9/9, 0.037602 devnet SOL (same section) |
| (pre-audit) `onchain/scripts/slash-cap-devnet.ts` | grows the devnet Config by the cap (`migrate_config_slash_cap` 7,500 bps) and checks it reads back | deployer (registry admin) | PASS, 0.000015 devnet SOL |
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

`cargo clippy` was clean on all three programs at the A1 commit (docs/AUDIT.md "Onchain") and again at
the pre-audit commit `9f70357`, with and without the `mainnet` feature, and on `6b24162` (pump.fun).
`cargo audit` has not been run (no advisory database on the build machine); we would welcome its
output as part of the engagement.
