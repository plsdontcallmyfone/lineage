#!/usr/bin/env bash
# Installs the daily backup pull as a launchd agent for this user (macOS):
#   scripts/deploy/mac/install.sh [host] [--run]     (default 157.245.71.188; --run also runs it once now)
#   scripts/deploy/mac/install.sh --uninstall
# Needs: age (brew install age), zstd, bun, the site ssh key (~/.ssh/lineage_site) and the age identity
# ~/.config/lineage/backup-age.key (mode 600; made once with `age-keygen -o`, never copied anywhere).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
LABEL=com.lineage.backup-pull
DST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ "${1:-}" = --uninstall ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$DST"
  echo "uninstalled $LABEL (the pulled backups in ~/.lineage/site-backups stay)"
  exit 0
fi
HOST="157.245.71.188"; RUN=0
for a in "$@"; do case "$a" in --run) RUN=1 ;; *) HOST="$a" ;; esac; done
for t in age zstd bun; do PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }; done
K="$HOME/.config/lineage/backup-age.key"
[ -f "$K" ] || { echo "no $K: make it once with 'age-keygen -o $K' (then chmod 600); keep a copy offline" >&2; exit 1; }
[ "$(stat -f %Lp "$K")" = 600 ] || { echo "$K must be mode 600" >&2; exit 1; }
install -d -m 700 "$HOME/.lineage/site-backups"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|@REPO@|$REPO|g" -e "s|@HOME@|$HOME|g" -e "s|@HOST@|$HOST|g" "$REPO/scripts/deploy/mac/$LABEL.plist" > "$DST.tmp"
plutil -lint "$DST.tmp" >/dev/null
mv "$DST.tmp" "$DST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DST"
echo "installed $LABEL: daily at 09:20 local, pulls $HOST into ~/.lineage/site-backups/$HOST (log ~/.lineage/site-backups/pull.log)"
if [ "$RUN" = 1 ]; then
  launchctl kickstart "gui/$(id -u)/$LABEL"
  echo "started once now (launchctl kickstart); follow ~/.lineage/site-backups/pull.log"
fi
