# Lineage onchain programs (SPEC 14)

One Anchor 0.31.1 workspace, two programs, one LiteSVM test crate. Nothing here is deployed;
see [DEPLOY.md](DEPLOY.md).

| Path | What |
|---|---|
| `programs/lineage-registry` | `lineage_registry` (`2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY`): config, agents, burn, bond, unbond, slash, split, epochs, Merkle claims. `src/leaf.rs` is protocol `H`/`leafHash`/`nodeHash` byte for byte. |
| `programs/lineage-launch` | `lineage_launch` (`8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT`): agent tokens on Meteora DBC quoted in `$LINE`, fee cranks, graduation to DAMM v2, compute vaults, usage debits. `src/meteora.rs` holds Meteora addresses, account readers and raw CPIs (no Meteora crate, offline build). |
| `tests` | LiteSVM harness (`src/lib.rs`) and suites: `registry.rs`, `launch.rs`, `client_vectors.rs` |
| `tests/fixtures/merkle.json` | roots, leaves and proofs built by `@lineage/protocol` (`scripts/make-fixtures.ts`) |
| `tests/fixtures/client-vectors.json` | instruction encodings and live account bytes that `packages/chain` is tested against |
| `vendor/meteora` | DBC and DAMM v2 dumped from devnet (`fetch.sh`, sha256 pinned; the `.so` files are not committed) |
| `keys-backup/` | copies of the program id keypairs (gitignored; also in `~/.config/lineage/program-keys/`). Never delete `target/` without them. |

The pattern (program PDA as DBC creator and fee claimer, 100% partner-locked LP, raw CPIs,
LiteSVM against dumped Meteora builds) follows the read-only reference at
`~/instance-network/onchain/launch`.

## Build and test

Toolchain: anchor-cli 0.31.1, solana-cli 3.1.12 (`cargo-build-sbf`, platform tools v1.52), rustc
for host tests. `blake3` is pinned to 1.8.2 in `Cargo.lock` (1.8.7 pulls `digest` 0.11, whose
unused functions exceed the SBF stack limit at build time). Nothing touches the machine-wide
`solana config`.

```sh
cd onchain
vendor/meteora/fetch.sh                      # once: read-only dumps from devnet, hashes checked
cargo build-sbf --offline --manifest-path programs/lineage-registry/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --offline --manifest-path programs/lineage-launch/Cargo.toml --sbf-out-dir target/deploy
cargo test --offline -p lineage-onchain-tests              # LiteSVM suites (load target/deploy/*.so)
cargo test --offline -p lineage-registry --lib             # leaf encoder unit tests
bun scripts/make-fixtures.ts --check                       # from the repo root: bun onchain/scripts/make-fixtures.ts --check
bun test packages/chain                                    # from the repo root
```

`cargo build-sbf` builds; `anchor deploy` does not. Rebuild both programs before the LiteSVM
suites after any program change. `UPDATE_VECTORS=1 cargo test -p lineage-onchain-tests --test client_vectors`
regenerates the client vectors after an instruction or account layout change.

## Leaf encoding

No binary encoding was needed: the registry hashes the payout leaf exactly as Core does,
`sha256('["leaf","{\"agent\":\"<A>\",\"amount\":\"<N>\",\"dest\":\"<D>\",\"epoch\":<E>}"]')`, and
nodes as `sha256('["node","<lo hex>","<hi hex>"]')`. The agent and wallet keys are base58-encoded
onchain from their 32 bytes; the destination string is rebuilt from a kind and a key. See SPEC 14.3.
