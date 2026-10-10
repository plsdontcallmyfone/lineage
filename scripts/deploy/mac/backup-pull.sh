#!/usr/bin/env bash
# Daily off-machine copy of the Lineage site's backups, run by launchd (com.lineage.backup-pull.plist,
# installed by install.sh). Pulls the newest Core snapshot and the newest secrets+state parts into
# ~/.lineage/site-backups/<host>/, verifies them (the secrets parts decrypt with
# ~/.config/lineage/backup-age.key) and keeps 14 days. Log: ~/.lineage/site-backups/pull.log.
#
#   scripts/deploy/mac/backup-pull.sh [host]     (default 157.245.71.188)
set -uo pipefail
HOST="${1:-${LINEAGE_SITE_HOST:-157.245.71.188}}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.bun/bin"
export BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
LOG_DIR="$HOME/.lineage/site-backups"
install -d -m 700 "$LOG_DIR"
LOG="$LOG_DIR/pull.log"
{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) pull from $HOST"
  bash "$REPO/scripts/deploy/deploy.sh" "$HOST" backup
  rc=$?
  echo "=== exit $rc"
} >> "$LOG" 2>&1
# the log keeps its last 2000 lines
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
chmod 600 "$LOG"
exit "${rc:-1}"
