#!/bin/sh
# A local fork of mainnet for the pools and fee-claims rehearsal (scripts/pools/fork-rehearsal.ts):
# mainnet's own pump.fun programs and the accounts they read (the pump.fun lines of
# scripts/mainnet/fork.sh), and the three units programs preloaded at their mainnet ids from build
# files: units_registry and units_msg from onchain/target/mainnet (read, never written) and
# units_launch from the pools build (onchain/target/pools-mainnet, kept out of the default output).
# The upgrade authority is a throwaway key. Reads mainnet only; nothing is sent to mainnet.
#
# Usage: scripts/pools/fork.sh <ledger dir> <upgrade authority pubkey>
# Ports: the mainnet fork's (RPC 9690, faucet 9692, gossip 9693, dynamic 9700-9730), checked free
# first: this fork and the mainnet test lane's never run at the same time.
set -eu
LEDGER="$1"
AUTH="$2"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
U="${UNITS_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
for p in 9690 9691 9692 9693 $(seq 9700 9730); do
  if lsof -ti ":$p" >/dev/null 2>&1; then echo "port $p is taken" >&2; exit 1; fi
done
exec solana-test-validator --ledger "$LEDGER" --reset --quiet \
  --limit-ledger-size 50000000 --clone-feature-set \
  --rpc-port 9690 --faucet-port 9692 --gossip-port 9693 --dynamic-port-range 9700-9730 --bind-address 127.0.0.1 \
  --url "$U" \
  --upgradeable-program 3GeaTsBUsaXCJ7Dru9tDHiKnVBsoHE6yiTdqqj42JHay "$HERE/onchain/target/mainnet/units_registry.so" "$AUTH" \
  --upgradeable-program 2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq "$HERE/onchain/target/pools-mainnet/units_launch.so" "$AUTH" \
  --upgradeable-program jmcb7cBA8aJ5Zra8V6gUsEbgKAoG3h5d2CNpmKsRdky "$HERE/onchain/target/mainnet/units_msg.so" "$AUTH" \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
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
