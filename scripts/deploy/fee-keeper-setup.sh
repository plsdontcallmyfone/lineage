#!/bin/bash
# The $UNITS fee keeper's account and directories on the server (docs/MAINNET-RUNBOOK.md "UNITS fee
# keeper"). Run once as root, on the server, after a release that carries units-fee-keeper.service.
# Makes nothing run: the timer stays disabled until the owner enables it.
#
#   units-fee-keeper                         system account, no shell, no home
#   /etc/units-fee-keeper/                   750 root:units-fee-keeper
#     config.json                            640 root:units-fee-keeper  (public values; from config/fee-keeper.example.json)
#     creator.json                           600 units-fee-keeper       (the $UNITS creator wallet's key; the owner puts it here)
#     keeper.env                             600 units-fee-keeper       (UNITS_FEE_KEEPER_RPC=...)
#   /var/lib/units/fee-keeper/state/         700 units-fee-keeper       (what is owed, the transaction in flight)
#   /var/lib/units/fee-keeper/public/        755 units-fee-keeper       (runs.jsonl, served by Core at GET /v1/units-fees)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
U=units-fee-keeper
id "$U" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group "$U"
install -d -m 750 -o root -g "$U" /etc/units-fee-keeper
install -d -m 755 -o root -g root /var/lib/units
install -d -m 755 -o "$U" -g "$U" /var/lib/units/fee-keeper
install -d -m 700 -o "$U" -g "$U" /var/lib/units/fee-keeper/state
install -d -m 755 -o "$U" -g "$U" /var/lib/units/fee-keeper/public
for f in creator.json keeper.env; do
  if [ -e "/etc/units-fee-keeper/$f" ]; then chown "$U:$U" "/etc/units-fee-keeper/$f"; chmod 600 "/etc/units-fee-keeper/$f"; fi
done
if [ -e /etc/units-fee-keeper/config.json ]; then chown "root:$U" /etc/units-fee-keeper/config.json; chmod 640 /etc/units-fee-keeper/config.json; fi
echo "account and directories ready; the timer is $(systemctl is-enabled units-fee-keeper.timer 2>/dev/null || echo not-installed)"
for f in config.json creator.json keeper.env; do [ -e "/etc/units-fee-keeper/$f" ] || echo "missing: /etc/units-fee-keeper/$f"; done
