# Meteora programs for the LiteSVM suite

Dumped read-only from devnet on 2026-10-07 (devnet slot about 508,582,547) by `./fetch.sh`.
The `.so` files are not committed (about 2 MB and 1.5 MB, see `../../.gitignore`); the suite
checks their sha256 before it runs.

| File | What | sha256 |
|---|---|---|
| `dbc.so` | Meteora Dynamic Bonding Curve `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `5edf76d972abaf355048db5d9003bc4dfa843cd98a5f93785430dac371678ad3` |
| `damm_v2.so` | Meteora DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | `82bb9375921bb8007551cb65f9ca43b191597496cc9922926468b36671081ec2` |
| `damm_v2_dynamic_config.bin` / `.json` | DAMM v2 config `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`, the dynamic config (pool creator authority = DBC's pool authority) DBC migrates Customizable-fee pools into; same address on mainnet | `988089b8bacd1967ad85e4acd2bb520c847c872a74fed0614b01a89c57ae73a5` |

The hashes are the same builds the read-only reference (`~/instance-network/onchain/launch/vendor/meteora`)
pinned on 2026-09-29 (DBC `release_0.2.2`, DAMM v2 `release_0.2.5`). Mainnet ran older builds
then (DBC 0.2.1; re-dumped 2026-10-09 after Meteora redeployed DBC on devnet, LiteSVM 56/56 on it); re-run the suite against fresh mainnet dumps before any mainnet deploy.

LiteSVM also needs DBC's pool authority `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` to hold SOL:
DBC lends rent from it during migration. The suite airdrops 1 SOL to it.
