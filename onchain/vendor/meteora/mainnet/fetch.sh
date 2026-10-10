#!/bin/sh
# Read-only dumps of the Meteora builds deployed on mainnet (explicit public endpoint, or
# LINEAGE_MAINNET_RPC when set; the machine-wide solana config is never read or changed), hash
# checked. `METEORA_BUILD=mainnet cargo test --offline -p lineage-onchain-tests` runs the suites on them.
set -eu
cd "$(dirname "$0")"
U="${LINEAGE_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
solana program dump -u "$U" dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN dbc.so >/dev/null
solana program dump -u "$U" cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG damm_v2.so >/dev/null
shasum -a 256 -c <<SUMS
4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b  dbc.so
4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b  damm_v2.so
SUMS
