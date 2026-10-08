#!/usr/bin/env bash
# Lineage site: server-side steps, run as root by deploy.sh over ssh. Never prints a secret.
#
#   remote.sh install <sha>      clone the shipped bundle into /opt/lineage/releases/<sha> (as lineage),
#                                bun install, build the sandbox images the recipes need, re-pin the
#                                recipes to this machine (arch-recipes.ts), make the site's keys, write configs
#   remote.sh chain <sha> [plan] register and bond the site's verifiers on devnet (site-chain.ts)
#   remote.sh activate <sha>     back up Core's data, point /opt/lineage/current at <sha>, install units and
#                                the Caddyfile, restart, start the bootstrap and the workers
#   remote.sh rollback [--with-data]   back to the previous release (with --with-data: also the data backup
#                                taken when the current release was activated)
#   remote.sh stop | start       stop (and disable) or start every lineage unit and Caddy
#   remote.sh status             units, memory, health, balances (site-status.ts), disk
#   remote.sh wipe-keys          delete the keys copied from the owner's machine (before destroying the box)
#
# Settings come from /etc/lineage/site.env, which deploy.sh writes: SITE_NAMES, LINEAGE_RECIPES,
# GATE_ORIGINS, DRY_RUN, WITH_RUNTIME, WITH_AUTHOR.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
CMD="${1:-}"; shift || true
BASE=/opt/lineage
ENVF=/etc/lineage/site.env
[ -f "$ENVF" ] && . "$ENVF"
DRY_RUN="${DRY_RUN:-0}"
LINEAGE_RECIPES="${LINEAGE_RECIPES:-fixture-b58,base58-py,minbpe}"
CORE_UNITS=(lineage-core lineage-web lineage-gate)
WORKER_UNITS=(lineage-reference lineage-verifier@v1 lineage-verifier@v2)

as_lineage() {
  runuser -u lineage -- env -i HOME=/home/lineage USER=lineage LINEAGE_HOME=/home/lineage/.lineage PATH=/usr/local/bin:/usr/bin:/bin bash -c "$1"
}
optional_units() {
  local u=()
  [ "${WITH_RUNTIME:-0}" = 1 ] && u+=(lineage-runtime)
  [ "${WITH_AUTHOR:-0}" = 1 ] && u+=(lineage-author)
  echo "${u[@]:-}"
}

case "$CMD" in
install)
  SHA="$1"; REL="$BASE/releases/$SHA"
  [ -f "$BASE/incoming.bundle" ] || { echo "no bundle at $BASE/incoming.bundle" >&2; exit 1; }
  chown lineage:lineage "$BASE/incoming.bundle"
  if [ ! -d "$REL/.git" ]; then
    as_lineage "git clone -q --no-checkout $BASE/incoming.bundle $REL && cd $REL && git -c advice.detachedHead=false checkout -q $SHA"
    echo "release $SHA cloned"
  else
    # a re-run of the same commit: reset tracked files (arch-recipes.ts re-pins them again below)
    as_lineage "cd $REL && git checkout -q -- . && git -c advice.detachedHead=false checkout -q $SHA"
    echo "release $SHA present, tracked files reset"
  fi
  [ "$(as_lineage "cd $REL && git rev-parse HEAD")" = "$SHA" ] || { echo "checkout is not $SHA" >&2; exit 1; }
  as_lineage "cd $REL && bun install --frozen-lockfile >/dev/null 2>&1 || bun install --frozen-lockfile" && echo "bun install ok"
  if [ "$DRY_RUN" != 1 ]; then
    # sandbox images for the recipes in use, built here (never --pull: the image id stays stable across deploys)
    for r in ${LINEAGE_RECIPES//,/ }; do
      y="$REL/recipes/$r/recipe.yml"
      [ -f "$y" ] || { echo "no recipe $r" >&2; exit 1; }
      ref=$(sed -n 's/^image:[[:space:]]*"\{0,1\}\([^"@[:space:]]*\)@sha256.*/\1/p' "$y")
      cls=$(sed -n 's/^class:[[:space:]]*\([a-z0-9]*\).*/\1/p' "$y")
      echo "$ref $cls"
    done | sort -u | while read -r ref cls; do
      echo "building $ref from images/$cls"
      as_lineage "cd $REL && docker build -q -t $ref images/$cls >/dev/null"
      echo "  $ref $(docker image inspect --format '{{.Id}}' "$ref" | cut -c1-19) $(docker image inspect --format '{{.Architecture}}' "$ref")"
    done
    as_lineage "cd $REL && bun scripts/deploy/arch-recipes.ts $LINEAGE_RECIPES" | tail -n +1
  else
    echo "dry run: sandbox images and recipe re-pinning skipped (no Docker)"
  fi
  as_lineage "cd $REL && bun scripts/deploy/site-keys.ts init" > /var/lib/lineage/site/pubkeys.json
  chown lineage:lineage /var/lib/lineage/site/pubkeys.json
  as_lineage "cd $REL && bun scripts/deploy/site-config.ts --out /var/lib/lineage/site"
  echo "PUBKEYS $(cat /var/lib/lineage/site/pubkeys.json)"
  ;;
chain)
  SHA="$1"; REL="$BASE/releases/$SHA"
  as_lineage "cd $REL && bun scripts/deploy/site-chain.ts --caps /var/lib/lineage/site/caps.json ${2:+--plan}"
  ;;
activate)
  SHA="$1"; REL="$BASE/releases/$SHA"
  [ -d "$REL" ] || { echo "no release $SHA" >&2; exit 1; }
  OLD="$(readlink "$BASE/current" 2>/dev/null || true)"
  as_lineage "cd $REL && bun scripts/deploy/site-config.ts --out /var/lib/lineage/site"
  if [ -n "$OLD" ] && [ "$OLD" != "$REL" ]; then
    systemctl stop lineage-runtime lineage-author "${WORKER_UNITS[@]}" "${CORE_UNITS[@]}" 2>/dev/null || true
    B="/var/lib/lineage/backups/$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$OLD")"
    install -d -o lineage -g lineage "$B"
    if [ -f /var/lib/lineage/core/core.db ]; then
      sqlite3 /var/lib/lineage/core/core.db ".backup '$B/core.db'"
      chown lineage:lineage "$B/core.db"
    fi
    echo "$OLD" > "$BASE/previous"
    echo "$B" > "$BASE/previous-backup"
    echo "data backup $B"
    ls -1dt /var/lib/lineage/backups/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
  fi
  ln -sfn "$REL" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  install -m 644 "$REL"/scripts/deploy/systemd/*.service /etc/systemd/system/
  # Caddy
  SITES="${SITE_NAMES:-localhost}"
  if [ "$DRY_RUN" = 1 ]; then TLS="	tls internal"; GLOBAL="	local_certs"; else TLS=""; GLOBAL="${ACME_EMAIL:+	email $ACME_EMAIL}"; fi
  install -d -o caddy -g caddy /var/log/caddy
  sed -e "s|@SITES@|${SITES//,/, }|" -e "s|@TLS@|$TLS|" -e "s|@GLOBAL@|$GLOBAL|" "$REL/scripts/deploy/caddy/Caddyfile.tmpl" > /etc/caddy/Caddyfile.new
  caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile; exit 1; }
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl daemon-reload
  systemctl enable -q "${CORE_UNITS[@]}" caddy
  systemctl restart "${CORE_UNITS[@]}"
  systemctl reload-or-restart caddy
  if [ "$DRY_RUN" = 1 ]; then
    echo "dry run: lineage-bootstrap, lineage-reference, lineage-verifier@v1, lineage-verifier@v2, lineage-runtime, lineage-author SKIPPED (sandbox units need Docker)"
  else
    systemctl enable -q "${WORKER_UNITS[@]}"
    systemctl restart --no-block lineage-bootstrap
    systemctl restart "${WORKER_UNITS[@]}"
    for u in lineage-runtime lineage-author; do systemctl disable -q --now "$u" 2>/dev/null || true; done
    for u in $(optional_units); do systemctl enable -q "$u"; systemctl restart "$u"; done
  fi
  echo "active: $SHA"
  ;;
rollback)
  PREV="$(cat "$BASE/previous" 2>/dev/null || true)"
  [ -n "$PREV" ] && [ -d "$PREV" ] || { echo "no previous release recorded" >&2; exit 1; }
  CUR="$(readlink "$BASE/current")"
  systemctl stop lineage-runtime lineage-author "${WORKER_UNITS[@]}" "${CORE_UNITS[@]}" 2>/dev/null || true
  if [ "${1:-}" = "--with-data" ]; then
    BK="$(cat "$BASE/previous-backup")"
    [ -f "$BK/core.db" ] || { echo "no data backup at $BK" >&2; exit 1; }
    M="/var/lib/lineage/backups/$(date -u +%Y%m%dT%H%M%SZ)-before-rollback"
    install -d -o lineage -g lineage "$M"
    mv /var/lib/lineage/core/core.db* "$M"/ 2>/dev/null || true
    install -o lineage -g lineage -m 640 "$BK/core.db" /var/lib/lineage/core/core.db
    echo "data restored from $BK (the replaced data is in $M)"
  fi
  ln -sfn "$PREV" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  echo "$CUR" > "$BASE/previous"
  install -m 644 "$PREV"/scripts/deploy/systemd/*.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl start "${CORE_UNITS[@]}"
  [ "$DRY_RUN" = 1 ] || systemctl start "${WORKER_UNITS[@]}" $(optional_units)
  echo "rolled back to $(basename "$PREV")"
  ;;
stop)
  systemctl disable -q --now lineage-runtime lineage-author lineage-bootstrap "${WORKER_UNITS[@]}" "${CORE_UNITS[@]}" caddy 2>/dev/null || true
  echo "stopped: every lineage unit and Caddy (disabled; 'start' brings them back)"
  ;;
start)
  systemctl enable -q --now "${CORE_UNITS[@]}" caddy
  [ "$DRY_RUN" = 1 ] || systemctl enable -q --now "${WORKER_UNITS[@]}" $(optional_units)
  echo "started"
  ;;
status)
  echo "release   $(basename "$(readlink "$BASE/current" 2>/dev/null || echo none)") (previous $(basename "$(cat "$BASE/previous" 2>/dev/null || echo none)"))"
  for u in "${CORE_UNITS[@]}" caddy lineage-bootstrap "${WORKER_UNITS[@]}" lineage-runtime lineage-author; do
    st=$(systemctl is-active "$u" 2>/dev/null || true)
    mem=$(systemctl show -p MemoryCurrent --value "$u" 2>/dev/null || echo "")
    [[ "$mem" =~ ^[0-9]+$ ]] && mem="$((mem / 1048576)) MiB" || mem="-"
    printf '%-24s %-10s %s\n' "$u" "${st:-unknown}" "$mem"
  done
  echo "--"
  [ -d "$BASE/current" ] && as_lineage "cd $BASE/current && bun scripts/deploy/site-status.ts" || true
  echo "--"
  df -h / | tail -1 | awk '{print "disk      " $4 " free of " $2 " (" $5 " used)"}'
  free -m | awk '/Mem:/ {print "memory    " $7 " MiB available of " $2}'
  command -v docker >/dev/null && docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | sed 's/^/docker    /' || true
  ;;
wipe-keys)
  for f in core-authority faucet runtime-authority agent-minbpe; do
    p="/home/lineage/.config/lineage/devnet/$f.json"
    [ -f "$p" ] && { shred -u "$p" 2>/dev/null || rm -f "$p"; echo "removed $f"; }
  done
  rm -f /home/lineage/.config/lineage/model.env /home/lineage/.config/lineage/rpc.env
  echo "copied keys removed; the site's own keys stay in /home/lineage/.config/lineage/site"
  ;;
*)
  echo "usage: remote.sh install|chain|activate <sha> | rollback [--with-data] | stop | start | status | wipe-keys" >&2
  exit 2
  ;;
esac
