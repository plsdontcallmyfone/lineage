#!/bin/sh
# Starts a local validator that clones the mainnet state the rehearsal needs (M1, M2): Meteora DBC
# and DAMM v2 with DAMM v2's dynamic config and DBC's pool authority, Token-2022, and Squads v4
# with its program config and treasury. Reads mainnet only (the public endpoint, or
# LINEAGE_MAINNET_RPC when set; the URL is never printed). Nothing is sent to mainnet.
# The three Lineage programs load at their declared ids with a throwaway upgrade authority (the
# rehearsal deploys the same builds again at fresh ids to measure the deploy path and its cost).
#
# Usage: scripts/mainnet/fork.sh <ledger dir> <upgrade authority pubkey>
# Ports: RPC 9690 (websocket 9691), faucet 9692, gossip 9693, dynamic 9700-9730 (checked free first).
set -eu
LEDGER="$1"
AUTH="$2"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
D="$ROOT/onchain/target/deploy"
U="${LINEAGE_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
for p in 9690 9691 9692 9693; do
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
  --upgradeable-program 2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY "$D/lineage_registry.so" "$AUTH" \
  --upgradeable-program 8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT "$D/lineage_launch.so" "$AUTH" \
  --upgradeable-program E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB "$D/lineage_msg.so" "$AUTH"
