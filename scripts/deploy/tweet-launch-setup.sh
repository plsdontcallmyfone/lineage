#!/bin/bash
# The reply bot's account and directories on the server (docs/MAINNET-RUNBOOK.md "Launch from a
# tweet"). Run once as root, on the server, after a release that carries units-tweet-launch.service.
# Makes nothing run: the timer stays disabled until the owner enables it.
#
#   units-tweet-launch                      system account, no shell
#   /etc/units-tweet-launch/                750 root:units-tweet-launch
#     config.json                           640 root:units-tweet-launch  (settings; from config/tweet-launch.example.json)
#     x.env                                 600 units-tweet-launch       (the X credentials; the owner puts them here)
#   /var/lib/units/tweet-launch/            700 units-tweet-launch       (state.json, tokens.json, STOP, the readings' scratch)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
U=units-tweet-launch
id "$U" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/units/tweet-launch --shell /usr/sbin/nologin --user-group "$U"
install -d -m 750 -o root -g "$U" /etc/units-tweet-launch
install -d -m 755 /var/lib/units
install -d -m 700 -o "$U" -g "$U" /var/lib/units/tweet-launch
if [ -e /etc/units-tweet-launch/x.env ]; then chown "$U:$U" /etc/units-tweet-launch/x.env; chmod 600 /etc/units-tweet-launch/x.env; fi
if [ -e /etc/units-tweet-launch/config.json ]; then chown "root:$U" /etc/units-tweet-launch/config.json; chmod 640 /etc/units-tweet-launch/config.json; fi
echo "account and directories ready; the timer is $(systemctl is-enabled units-tweet-launch.timer 2>/dev/null || echo not-installed)"
for f in config.json x.env; do [ -e "/etc/units-tweet-launch/$f" ] || echo "missing: /etc/units-tweet-launch/$f"; done
