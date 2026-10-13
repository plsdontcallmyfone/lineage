#!/bin/bash
# The agent fee crank keeper's units on the server (docs/MAINNET-RUNBOOK.md "Agent fee crank keeper").
# Run as root, on the server, for one instance. It writes the service and its timer and enables the
# timer: every 10 minutes scripts/mainnet/crank-fees.ts moves each launched agent coin's pump.fun
# creator fees into the agent's compute vault. The crank is permissionless; the payer only pays the
# network fee and, once per agent, the rent of one token account, so its key holds a little SOL and
# nothing else depends on it.
#
#   INSTANCE=mainnet CORE_URL=https://<site> [KEY=<payer keypair.json>] [MIN_USD=0.25] scripts/deploy/fee-crank-setup.sh
#
# Defaults follow scripts/deploy/instance.ts: the instance "mainnet" is the prefix units-main, its
# release is /opt/units-main/current, its keyed RPC is /etc/units-main/rpc.env, and the payer is the
# hosted runtime's authority key. A deploy does not remove these units; remote-instance.sh removes
# them with the instance (it deletes every unit of the prefix).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
INSTANCE="${INSTANCE:?INSTANCE is required (for example mainnet)}"
CORE_URL="${CORE_URL:?CORE_URL is required (the public origin of the site)}"
case "$INSTANCE" in
  mainnet) P=units-main ;;
  *) P="units-$INSTANCE" ;;
esac
KEY="${KEY:-/home/$P/.config/lineage/$INSTANCE/runtime-authority.json}"
MIN_USD="${MIN_USD:-0.25}"
REL="/opt/$P/current"
[ -f "$REL/scripts/mainnet/crank-fees.ts" ] || { echo "$REL carries no scripts/mainnet/crank-fees.ts: deploy a release that has it first" >&2; exit 1; }
[ -f "$KEY" ] || { echo "payer key $KEY not found" >&2; exit 1; }
[ -f "/etc/$P/rpc.env" ] || { echo "/etc/$P/rpc.env not found" >&2; exit 1; }

cat > "/etc/systemd/system/$P-fee-crank.service" <<EOF
[Unit]
Description=units fee crank keeper: agent coins creator fees into their compute vaults [instance $INSTANCE]
After=network-online.target $P-core.service

[Service]
Type=oneshot
User=$P
WorkingDirectory=$REL
EnvironmentFile=/etc/$P/rpc.env
Environment=UNITS_NETWORK=$INSTANCE UNITS_PROFILE_LOCAL=/etc/$P/profile.local.json HOME=/home/$P
ExecStart=/usr/local/bin/bun scripts/mainnet/crank-fees.ts --core $CORE_URL --key $KEY --min-usd $MIN_USD --send
TimeoutStartSec=240
EOF
cat > "/etc/systemd/system/$P-fee-crank.timer" <<EOF
[Unit]
Description=units fee crank keeper every 10 minutes [instance $INSTANCE]

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF
chmod 644 "/etc/systemd/system/$P-fee-crank.service" "/etc/systemd/system/$P-fee-crank.timer"
systemctl daemon-reload
systemctl enable -q --now "$P-fee-crank.timer"
echo "fee crank keeper on: $P-fee-crank.timer is $(systemctl is-enabled "$P-fee-crank.timer"), payer key $KEY, smallest crank $MIN_USD USD"
echo "last runs: journalctl -u $P-fee-crank.service -n 20"
