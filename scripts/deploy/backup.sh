#!/usr/bin/env bash
# Lineage site: Core snapshots (plan M4). Runs on the server as lineage-core (lineage-backup.timer, hourly)
# and, for `verify` and `extract`, also on the owner's machine after deploy.sh pulls a snapshot.
#
#   backup.sh snapshot [--data /var/lib/lineage/core] [--out /var/lib/lineage/core-backups] [--keep 24]
#   backup.sh verify <snapshot.tar.zst>            checksum, archive and database integrity, table counts
#   backup.sh extract <snapshot.tar.zst> <dir>     core.db and blobs/ into an empty <dir> (a Core --data dir)
#
# A snapshot is one file core-<UTC time>.tar.zst holding core.db (an online `.backup` copy, consistent
# while Core writes), blobs/ (Core's blob store) and manifest.json (time, sizes, sha256 of core.db, the
# row count of every table, the open epoch). Its sha256 sits next to it in core-<UTC time>.tar.zst.sha256.
# Nothing here prints a secret; core.db itself holds unrevealed epoch secrets and sealed sessions, so
# snapshots are mode 600 and an off-machine copy must be kept as private as the server.
set -euo pipefail
umask 077
CMD="${1:-}"; shift || true
die() { echo "backup: $*" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
unzst() { zstd -q -d -c "$1"; }

# table -> row count, as JSON, for a database file
counts() {
  local db="$1" t first=1 ro="${RO--readonly}"
  printf '{'
  for t in $(sqlite3 $ro "$db" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"); do
    [ $first = 1 ] || printf ','
    first=0
    printf '"%s":%s' "$t" "$(sqlite3 $ro "$db" "select count(*) from \"$t\"")"
  done
  printf '}'
}

case "$CMD" in
snapshot)
  DATA=/var/lib/lineage/core OUT=/var/lib/lineage/core-backups KEEP=24
  while [ $# -gt 0 ]; do
    case "$1" in
      --data) DATA="$2"; shift 2 ;;
      --out) OUT="$2"; shift 2 ;;
      --keep) KEEP="$2"; shift 2 ;;
      *) die "unknown argument $1" ;;
    esac
  done
  [ -f "$DATA/core.db" ] || die "no $DATA/core.db"
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  T="$OUT/.tmp-$TS"
  rm -rf "$OUT"/.tmp-*
  mkdir -p "$T"
  trap 'rm -rf "$T"' EXIT
  sqlite3 "$DATA/core.db" ".timeout 60000" ".backup '$T/core.db'"
  # a plain rollback-journal file, so the copy opens anywhere without -wal or -shm files
  sqlite3 "$T/core.db" "pragma journal_mode=delete" >/dev/null
  [ "$(sqlite3 -readonly "$T/core.db" 'pragma integrity_check')" = ok ] || die "integrity_check failed on the copy"
  # contents only (no owner, group or mode bits: the snapshot directory has its own group)
  if [ -d "$DATA/blobs" ]; then cp -R "$DATA/blobs" "$T/blobs"; else mkdir "$T/blobs"; fi
  EPOCH="$(sqlite3 -readonly "$T/core.db" "select coalesce(max(n),-1) from epochs" 2>/dev/null || echo -1)"
  printf '{"v":1,"at":"%s","host":"%s","core_db_bytes":%s,"core_db_sha256":"%s","blobs":%s,"open_epoch":%s,"tables":%s}\n' \
    "$TS" "$(hostname)" "$(stat -c %s "$T/core.db")" "$(sha "$T/core.db")" "$(find "$T/blobs" -type f | wc -l)" "$EPOCH" "$(counts "$T/core.db")" > "$T/manifest.json"
  F="$OUT/core-$TS.tar.zst"
  tar -C "$T" -cf - manifest.json core.db blobs | zstd -q -T2 -10 -o "$F.part"
  mv "$F.part" "$F"
  sha "$F" > "$F.sha256"
  chmod 600 "$F" "$F.sha256"
  # retention: the newest KEEP snapshots
  ls -1t "$OUT"/core-*.tar.zst 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old" "$old.sha256"; done
  echo "snapshot $F $(du -h "$F" | cut -f1) (core.db $(stat -c %s "$T/core.db") bytes, open epoch $EPOCH)"
  ;;
verify)
  F="${1:-}"; [ -f "$F" ] || die "no snapshot $F"
  if [ -f "$F.sha256" ]; then [ "$(sha "$F")" = "$(cat "$F.sha256")" ] || die "sha256 mismatch for $F"; echo "sha256 ok"; else echo "no .sha256 next to $F; checksum not checked"; fi
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  unzst "$F" | tar -C "$T" -xf -
  [ -f "$T/manifest.json" ] && [ -f "$T/core.db" ] || die "archive lacks manifest.json or core.db"
  WANT="$(sed -n 's/.*"core_db_sha256":"\([0-9a-f]*\)".*/\1/p' "$T/manifest.json")"
  [ "$(sha "$T/core.db")" = "$WANT" ] || die "core.db does not match the manifest"
  [ "$(sqlite3 "$T/core.db" 'pragma integrity_check')" = ok ] || die "integrity_check failed"
  # every table count equals the manifest (the manifest's tables object, reformatted for comparison)
  GOT="$(RO= counts "$T/core.db")"
  WANTC="$(sed -n 's/.*"tables":\({.*}\)}$/\1/p' "$T/manifest.json")"
  [ "$GOT" = "$WANTC" ] || die "table counts differ from the manifest"
  echo "verified $(basename "$F"): core.db sha256 and integrity ok, $(echo "$GOT" | tr ',' '\n' | wc -l | tr -d ' ') tables match the manifest, $(find "$T/blobs" -type f | wc -l | tr -d ' ') blobs"
  ;;
extract)
  F="${1:-}" DIR="${2:-}"
  [ -f "$F" ] && [ -n "$DIR" ] || die "usage: backup.sh extract <snapshot> <dir>"
  mkdir -p "$DIR"
  [ -z "$(ls -A "$DIR")" ] || die "$DIR is not empty"
  unzst "$F" | tar -C "$DIR" -xf - core.db blobs
  echo "extracted into $DIR"
  ;;
*)
  sed -n '2,14p' "$0"; exit 2 ;;
esac
