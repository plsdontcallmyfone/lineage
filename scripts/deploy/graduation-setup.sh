#!/bin/bash
# The graduation keeper's units on the server (docs/MAINNET-RUNBOOK.md "Graduation keeper"). Run as
# root, on the server, for one instance. It writes the service and its timer and enables the timer:
# every 2 minutes scripts/mainnet/graduate.ts looks at every agent coin the launch program has not
# recorded as graduated. A coin whose curve is complete and whose PumpSwap pool pump.fun has not made
# after MIGRATE_AFTER seconds gets pump.fun's migrate_v2 from this keeper; a coin whose pool exists
# gets record_pump_graduation. Both are permissionless. A run that finds nothing sends nothing and
# costs two RPC reads.
#
#   INSTANCE=mainnet [KEY=<payer keypair.json>] [MIGRATE_AFTER=120] [MAX_MIGRATE_SOL=0.05] [MIGRATE=1] scripts/deploy/graduation-setup.sh
#
# The payer is the hosted runtime's authority key, as for the fee crank keeper. A record costs it the
# network fee; a migration it has to send itself costs about 0.0225 SOL (pump.fun's migration fee and
# the pool's rent), never more than MAX_MIGRATE_SOL. MIGRATE=0 makes it record only and leave every
# migration to pump.fun. A deploy does not remove these units; remote-instance.sh removes them with
# the instance (it deletes every unit of the prefix).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
INSTANCE="${INSTANCE:?INSTANCE is required (for example mainnet)}"
case "$INSTANCE" in
  mainnet) P=units-main ;;
  *) P="units-$INSTANCE" ;;
esac
KEY="${KEY:-/home/$P/.config/lineage/$INSTANCE/runtime-authority.json}"
MIGRATE_AFTER="${MIGRATE_AFTER:-120}"
MAX_MIGRATE_SOL="${MAX_MIGRATE_SOL:-0.05}"
NO_MIGRATE=""
[ "${MIGRATE:-1}" = 0 ] && NO_MIGRATE=" --no-migrate"
REL="/opt/$P/current"
[ -f "$REL/scripts/mainnet/graduate.ts" ] || { echo "$REL carries no scripts/mainnet/graduate.ts: deploy a release that has it first" >&2; exit 1; }
[ -f "$KEY" ] || { echo "payer key $KEY not found" >&2; exit 1; }
[ -f "/etc/$P/rpc.env" ] || { echo "/etc/$P/rpc.env not found" >&2; exit 1; }

cat > "/etc/systemd/system/$P-graduation.service" <<EOF
[Unit]
Description=units graduation keeper: a complete curve to its pool and its graduation record [instance $INSTANCE]
After=network-online.target

[Service]
Type=oneshot
User=$P
WorkingDirectory=$REL
EnvironmentFile=/etc/$P/rpc.env
Environment=UNITS_NETWORK=$INSTANCE UNITS_PROFILE_LOCAL=/etc/$P/profile.local.json HOME=/home/$P
ExecStart=/usr/local/bin/bun scripts/mainnet/graduate.ts --key $KEY --migrate-after $MIGRATE_AFTER --max-migrate-sol $MAX_MIGRATE_SOL$NO_MIGRATE --send
TimeoutStartSec=110
EOF
cat > "/etc/systemd/system/$P-graduation.timer" <<EOF
[Unit]
Description=units graduation keeper every 2 minutes [instance $INSTANCE]

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
chmod 644 "/etc/systemd/system/$P-graduation.service" "/etc/systemd/system/$P-graduation.timer"
systemctl daemon-reload
systemctl enable -q --now "$P-graduation.timer"
echo "graduation keeper on: $P-graduation.timer is $(systemctl is-enabled "$P-graduation.timer"), payer key $KEY, migrates after $MIGRATE_AFTER s${NO_MIGRATE:+ (never: records only)}, at most $MAX_MIGRATE_SOL SOL per migration"
echo "last runs: journalctl -u $P-graduation.service -n 20"
