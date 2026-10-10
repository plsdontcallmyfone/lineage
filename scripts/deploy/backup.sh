#!/usr/bin/env bash
# Lineage site: Core snapshots (plan M4). Runs on the server as lineage-core (lineage-backup.timer, hourly)
# and, for `verify` and `extract`, also on the owner's machine after deploy.sh pulls a snapshot.
#
#   backup.sh snapshot [--data /var/lib/lineage/core] [--out /var/lib/lineage/core-backups] [--keep 24]
#   backup.sh verify <snapshot.tar.zst>            checksum, archive and database integrity, table counts
#   backup.sh extract <snapshot.tar.zst> <dir>     core.db and blobs/ into an empty <dir> (a Core --data dir)
#
# Secrets+state snapshots (the second kind; age-encrypted to the owner's public recipient):
#   backup.sh secrets <state|identity> [--out DIR] [--keep 24] [--recipient FILE] [--stage DIR] [--root /]
#   backup.sh verify-secrets <file.tar.zst.age> --identity <age key> [--facts OUT]   (owner's machine)
#   backup.sh extract-secrets <file.tar.zst.age> <dir> --identity <age key>         (owner's machine)
#
# A snapshot is one file core-<UTC time>.tar.zst holding core.db (an online `.backup` copy, consistent
# while Core writes), blobs/ (Core's blob store) and manifest.json (time, sizes, sha256 of core.db, the
# row count of every table, the open epoch). Its sha256 sits next to it in core-<UTC time>.tar.zst.sha256.
# Nothing here prints a secret; core.db itself holds unrevealed epoch secrets and sealed sessions, so
# snapshots are mode 600 and an off-machine copy must be kept as private as the server.
#
# A secrets+state snapshot is <part>-<UTC time>.tar.zst.age, encrypted with `age` to the recipient in
# /etc/lineage/backup-recipient.txt (a public key; the private identity stays on the owner's machine,
# ~/.config/lineage/backup-age.key, and never reaches the server). Each part is written by the user that
# owns its data, so no service user gains read access to another's files:
#   state     (lineage, lineage-backup-state.service) the hosted runtime's agent signing keys (keys/),
#             state.json, posts.json, trader/, bind-requests/, worker/, the desktop session records and
#             pending recording list (not the live stream dir or the recordings themselves), and the
#             site's own keys made on the server (~lineage/.config/lineage/site: admin, owner, verifiers)
#   identity  (lineage-identity, lineage-backup-identity.service) the identity service's encrypted
#             records (GitHub pool credentials, cycle state) and its key file /etc/lineage-identity/master.key
# Inside: manifest.json (part, time, file count, bytes), SHA256SUMS and files/<path from />. The files are
# staged in a RAM directory (the unit's RuntimeDirectory), checksummed and piped through zstd into age,
# so no new plaintext copy is written to disk. The indexer's market.db is not included: it is rebuilt
# from the chain (docs/DEPLOY-SITE.md "Disaster recovery").
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
  # VACUUM INTO: one read transaction, so the copy is consistent while Core writes (WAL: writers are not
  # blocked). The shell's `.backup` restarts whenever another connection writes the source, and on the
  # site Core writes more often than a 500 MB copy takes: it never finished (timed out at 30 min,
  # 2026-10-10); VACUUM INTO took 6 s on the same database.
  sqlite3 "$DATA/core.db" ".timeout 60000" "vacuum into '$T/core.db'"
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
secrets)
  PART="${1:-}"; shift || true
  OUT="" KEEP=24 RCPT=/etc/lineage/backup-recipient.txt STAGE="${RUNTIME_DIRECTORY:-}" ROOT=/
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) OUT="$2"; shift 2 ;;
      --keep) KEEP="$2"; shift 2 ;;
      --recipient) RCPT="$2"; shift 2 ;;
      --stage) STAGE="$2"; shift 2 ;;
      --root) ROOT="$2"; shift 2 ;;
      *) die "unknown argument $1" ;;
    esac
  done
  case "$PART" in
    state) PATHS=(var/lib/lineage/runtime/keys var/lib/lineage/runtime/state.json var/lib/lineage/runtime/posts.json
                  var/lib/lineage/runtime/trader var/lib/lineage/runtime/bind-requests var/lib/lineage/runtime/worker
                  var/lib/lineage/runtime/desktops/sessions var/lib/lineage/runtime/desktops/recordings/pending.json
                  home/lineage/.config/lineage/site)
           OUT="${OUT:-/var/lib/lineage/state-backups}" ;;
    identity) PATHS=(var/lib/lineage/identity/records etc/lineage-identity/master.key)
           OUT="${OUT:-/var/lib/lineage/identity-backups}" ;;
    *) die "secrets: part must be state or identity" ;;
  esac
  command -v age >/dev/null || die "age is not installed (apt-get install age)"
  [ -s "$RCPT" ] || die "no recipient in $RCPT (deploy.sh copies the owner's public age recipient there)"
  grep -qE '^age1[0-9a-z]{58}$' "$RCPT" || die "$RCPT does not hold one age public recipient"
  [ -n "$STAGE" ] && [ -d "$STAGE" ] || die "no staging directory (--stage, or the unit's RuntimeDirectory)"
  HAVE=()
  for p in "${PATHS[@]}"; do [ -e "$ROOT/$p" ] && HAVE+=("$p"); done
  [ ${#HAVE[@]} -gt 0 ] || die "nothing to back up for $PART under $ROOT"
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  S="$STAGE/$PART-$TS"
  rm -rf "$STAGE/$PART"-*
  mkdir -p "$S/files"
  trap 'rm -rf "$S"' EXIT
  # a file rewritten while it is copied makes tar fail ("file changed as we read it"): copy again
  for try in 1 2 3; do
    rm -rf "$S/files"; mkdir -p "$S/files"
    if tar -C "$ROOT" -cf - "${HAVE[@]}" | tar -C "$S/files" -xpf -; then break; fi
    [ "$try" = 3 ] && die "could not copy a consistent set of $PART files"
    sleep 2
  done
  ( cd "$S/files" && find . -type f | LC_ALL=C sort | sed 's|^\./||' | while read -r f; do printf '%s  %s\n' "$(sha "$f")" "$f"; done ) > "$S/SHA256SUMS"
  N="$(wc -l < "$S/SHA256SUMS" | tr -d ' ')"
  B="$(find "$S/files" -type f -exec cat {} + | wc -c | tr -d ' ')"
  printf '{"v":1,"kind":"secrets+state","part":"%s","at":"%s","host":"%s","files":%s,"bytes":%s,"paths":[%s]}\n' \
    "$PART" "$TS" "$(hostname)" "$N" "$B" "$(printf '"%s",' "${HAVE[@]}" | sed 's/,$//')" > "$S/manifest.json"
  mkdir -p "$OUT"
  F="$OUT/$PART-$TS.tar.zst.age"
  tar -C "$S" -cf - manifest.json SHA256SUMS files | zstd -q -T2 -10 | age -R "$RCPT" -o "$F.part"
  mv "$F.part" "$F"
  sha "$F" > "$F.sha256"
  chmod 600 "$F" "$F.sha256"
  rm -rf "$S"
  ls -1t "$OUT/$PART"-*.tar.zst.age 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old" "$old.sha256"; done
  echo "snapshot $F $(wc -c < "$F" | tr -d ' ') bytes ($PART: $N files, $B bytes before compression, encrypted to $(cut -c1-12 "$RCPT")...)"
  ;;
verify-secrets|extract-secrets)
  F="${1:-}"; shift || true
  DIR=""; [ "$CMD" = extract-secrets ] && { DIR="${1:-}"; shift || true; }
  KEY="" FACTS=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --identity) KEY="$2"; shift 2 ;;
      --facts) FACTS="$2"; shift 2 ;;
      *) die "unknown argument $1" ;;
    esac
  done
  [ -f "$F" ] || die "no snapshot $F"
  [ -f "$KEY" ] || die "no age identity (--identity, e.g. ~/.config/lineage/backup-age.key)"
  if [ -f "$F.sha256" ]; then [ "$(sha "$F")" = "$(cat "$F.sha256")" ] || die "sha256 mismatch for $F"; fi
  T="$(mktemp -d)"; chmod 700 "$T"; trap 'rm -rf "$T"' EXIT
  age -d -i "$KEY" "$F" | unzst - | tar -C "$T" -xpf - || die "could not decrypt $(basename "$F") with $KEY"
  [ -f "$T/manifest.json" ] && [ -f "$T/SHA256SUMS" ] && [ -d "$T/files" ] || die "archive lacks manifest.json, SHA256SUMS or files/"
  ( cd "$T/files" && while read -r h f; do [ "$(sha "$f")" = "$h" ] || { echo "checksum mismatch: $f" >&2; exit 1; }; done < "$T/SHA256SUMS" ) || die "a file differs from SHA256SUMS"
  WANT="$(sed -n 's/.*"files":\([0-9]*\).*/\1/p' "$T/manifest.json")"
  GOT="$(find "$T/files" -type f | wc -l | tr -d ' ')"
  [ "$GOT" = "$WANT" ] && [ "$(wc -l < "$T/SHA256SUMS" | tr -d ' ')" = "$WANT" ] || die "file count $GOT differs from the manifest ($WANT)"
  PART="$(sed -n 's/.*"part":"\([a-z]*\)".*/\1/p' "$T/manifest.json")"
  if [ -n "$FACTS" ]; then
    bun "$(dirname "$0")/backup-facts.ts" facts --part "$PART" --root "$T/files" > "$FACTS"
  fi
  if [ "$CMD" = extract-secrets ]; then
    [ -n "$DIR" ] || die "usage: backup.sh extract-secrets <file> <dir> --identity <key>"
    mkdir -p "$DIR"; chmod 700 "$DIR"
    [ -z "$(ls -A "$DIR")" ] || die "$DIR is not empty"
    ( cd "$T/files" && tar -cf - . ) | tar -C "$DIR" -xpf -
    echo "extracted $(basename "$F") ($PART, $GOT files) into $DIR (paths from /; mode 700)"
  else
    echo "verified $(basename "$F"): decrypts with $(basename "$KEY"), $PART, $GOT files match SHA256SUMS and the manifest"
  fi
  ;;
*)
  sed -n '2,33p' "$0"; exit 2 ;;
esac
