#!/bin/sh
# Dumps the pump.fun programs and the accounts the LiteSVM suite runs them with, read-only, from
# mainnet (explicit -u; the machine-wide solana config is never read or changed). Programs are not
# committed (see ../../.gitignore); the account fixtures are. The suite checks every sha256 in
# README.md before it runs; a fresh dump with other hashes means pump.fun redeployed: re-pin after
# rerunning scripts/mainnet/pump-fork-proof.ts and the suite.
set -eu
cd "$(dirname "$0")"
U="${LINEAGE_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
solana program dump -u "$U" 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P pump.so
solana program dump -u "$U" pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA pump_amm.so
solana program dump -u "$U" pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ pump_fees.so
solana program dump -u "$U" MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e mayhem.so
for a in 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf:global 6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP:quote_control \
  8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt:fee_config 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx:amm_fee_config \
  ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw:amm_global_config 13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ:mayhem_global_params \
  5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD:buyback0; do
  solana account -u "$U" "${a%%:*}" --output json-compact --output-file "${a##*:}.json" >/dev/null
done
shasum -a 256 *.so *.json
