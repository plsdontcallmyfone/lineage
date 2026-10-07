#!/bin/sh
# Re-dumps the Meteora programs the LiteSVM suite runs, read-only, from devnet (explicit -u devnet,
# the machine-wide solana config is never read or changed) and checks the pinned hashes.
# The DAMM v2 config account fixture (damm_v2_dynamic_config.*) is committed.
set -eu
cd "$(dirname "$0")"
solana program dump -u devnet dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN dbc.so
solana program dump -u devnet cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG damm_v2.so
shasum -a 256 -c <<SUMS
f5ccbb01e37165d16108bda0259fb3acbfca29305e23098c3b248e50c22979f0  dbc.so
82bb9375921bb8007551cb65f9ca43b191597496cc9922926468b36671081ec2  damm_v2.so
988089b8bacd1967ad85e4acd2bb520c847c872a74fed0614b01a89c57ae73a5  damm_v2_dynamic_config.bin
SUMS
