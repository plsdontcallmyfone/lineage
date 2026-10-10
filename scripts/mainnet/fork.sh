#!/bin/sh
# Starts a local validator that clones the mainnet state the rehearsal needs (M1, M2): Meteora DBC
# and DAMM v2 with DAMM v2's dynamic config and DBC's pool authority, Token-2022, and Squads v4
# with its program config and treasury; and pump.fun (Pump, PumpSwap, Pump Fees, Mayhem) with Pump's
# Global, quote control, both fee configs, PumpSwap's global config, Mayhem's global params and SOL
# vault, Pump's withdraw authority, and buyback fee recipient 0 with its wrapped SOL account
# (docs/plans/PUMPFUN-LAUNCHES.md). Reads mainnet only (the public endpoint, or
# LINEAGE_MAINNET_RPC when set; the URL is never printed). Nothing is sent to mainnet.
# The three Lineage programs are NOT preloaded: the rehearsal deploys them itself with the runbook's
# commands at the active profile's ids (LINEAGE_NETWORK=mainnet: the mainnet ids, signed by the
# mainnet id keypairs on this fork only), so the deploy it measures is the one the owner runs.
#
# Usage: scripts/mainnet/fork.sh <ledger dir>
# Ports: RPC 9690 (websocket 9691), faucet 9692, gossip 9693, dynamic 9700-9730 (checked free first).
set -eu
LEDGER="$1"
U="${LINEAGE_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
for p in 9690 9691 9692 9693 $(seq 9700 9730); do
  if lsof -ti ":$p" >/dev/null 2>&1; then echo "port $p is taken" >&2; exit 1; fi
done
exec solana-test-validator --ledger "$LEDGER" --reset --quiet \
  --limit-ledger-size 50000000 --clone-feature-set \
  --rpc-port 9690 --faucet-port 9692 --gossip-port 9693 --dynamic-port-range 9700-9730 --bind-address 127.0.0.1 \
  --url "$U" \
  --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --clone-upgradeable-program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf \
  --clone A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck \
  --clone FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM \
  --clone BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr \
  --clone 5DH2e3cJmFpyi6mk65EGFediunm4ui6BiKNUNrhWtD1b \
  --clone-upgradeable-program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P \
  --clone-upgradeable-program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA \
  --clone-upgradeable-program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ \
  --clone-upgradeable-program MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e \
  --clone 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf \
  --clone 6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP \
  --clone 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt \
  --clone 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx \
  --clone ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw \
  --clone 13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ \
  --clone BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s \
  --clone 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg \
  --clone 5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD \
  --clone HjQjngTDqoHE6aaGhUqfz9aQ7WZcBRjy5xB8PScLSr8i
