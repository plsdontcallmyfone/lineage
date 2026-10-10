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
# GATE_ORIGINS, DRY_RUN, WITH_RUNTIME, WITH_AUTHOR, AUTHORS.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
CMD="${1:-}"; shift || true
BASE=/opt/lineage
ENVF=/etc/lineage/site.env
[ -f "$ENVF" ] && . "$ENVF"
DRY_RUN="${DRY_RUN:-0}"
LINEAGE_RECIPES="${LINEAGE_RECIPES:-fixture-b58,base58-py,minbpe}"
AUTHORS="${AUTHORS:-minbpe}"; AUTHORS="${AUTHORS//,/ }"
# every author unit present (running or not), so stop and status also reach authors dropped from AUTHORS
all_authors() { systemctl list-units --all --plain --no-legend 'lineage-author@*' 2>/dev/null | awk '{print $1}'; echo lineage-author; }
CORE_UNITS=(lineage-core lineage-web lineage-gate lineage-indexer lineage-identity)
IDENTITY_TIMER=lineage-identity-cycle.timer
WORKER_UNITS=(lineage-reference lineage-verifier@v1 lineage-verifier@v2)

as_lineage() {
  runuser -u lineage -- env -i HOME=/home/lineage USER=lineage LINEAGE_HOME=/home/lineage/.lineage PATH=/usr/local/bin:/usr/bin:/bin bash -c "$1"
}
# The GitHub identity service (packages/identity, docs/DEPLOY-SITE.md "GitHub identity service"):
# a dedicated user, its encrypted store (mode 700) and key file (made once on the server, never
# copied anywhere), the RPC URL and the Core key it records PRs with. Idempotent.
identity_setup() {
  local REL="$1" ID=/var/lib/lineage/identity
  if ! id lineage-identity >/dev/null 2>&1; then
    useradd --system --home-dir "$ID/home" --no-create-home --shell /usr/sbin/nologin --user-group lineage-identity
  fi
  if id -nG lineage-identity | tr ' ' '\n' | grep -qx -E 'docker|sudo|admin|lineage'; then echo "lineage-identity is in a privileged group; refusing" >&2; exit 1; fi
  chmod o+x /var/lib/lineage   # traverse only (no listing); every other directory under it stays 750
  install -d -m 700 -o lineage-identity -g lineage-identity "$ID" "$ID/home" /etc/lineage-identity
  # keyed RPC for the launch watcher (lineage's rpc.env is not readable by this user)
  local rpcenv=/home/lineage/.config/lineage/rpc.env
  if [ -f "$rpcenv" ]; then
    ( umask 077; sed -n 's/^[[:space:]]*HELIUS_DEVNET_RPC[[:space:]]*=[[:space:]]*/LINEAGE_DEVNET_RPC=/p' "$rpcenv" > /etc/lineage-identity/identity.env.tmp )
    chown lineage-identity:lineage-identity /etc/lineage-identity/identity.env.tmp && mv /etc/lineage-identity/identity.env.tmp /etc/lineage-identity/identity.env
  fi
  # Core accepts PR records from its runtime or admin key; the site's admin key is the one on this box
  local ck=/home/lineage/.config/lineage/site/admin.json
  if [ -f "$ck" ] && ! cmp -s "$ck" /etc/lineage-identity/core-key.json; then
    install -m 600 -o lineage-identity -g lineage-identity "$ck" /etc/lineage-identity/core-key.json
  fi
  runuser -u lineage-identity -- env -i HOME="$ID/home" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/local/bin/bun "$REL/packages/identity/src/main.ts" init --dir "$ID" --key /etc/lineage-identity/master.key
}

optional_units() {
  local u=()
  [ "${WITH_RUNTIME:-0}" = 1 ] && u+=(lineage-runtime)
  if [ "${WITH_AUTHOR:-0}" = 1 ]; then for n in ${AUTHORS:-minbpe}; do u+=("lineage-author@$n"); done; fi
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
      # reuse the existing image when its build inputs are unchanged: a rebuild re-runs apt and
      # yields a new image id, hence new recipe ids and duplicate lineages (site deploy 2026-10-08)
      h=$(cd "$REL/images/$cls" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)
      have=$(docker image inspect --format '{{ index .Config.Labels "lineage.build-hash" }}' "$ref" 2>/dev/null || true)
      if [ "$have" = "$h" ]; then
        echo "reusing $ref (build inputs unchanged)"
      else
        echo "building $ref from images/$cls"
        as_lineage "cd $REL && docker build -q --label lineage.build-hash=$h -t $ref images/$cls >/dev/null"
      fi
      echo "  $ref $(docker image inspect --format '{{.Id}}' "$ref" | cut -c1-19) $(docker image inspect --format '{{.Architecture}}' "$ref")"
    done
    as_lineage "cd $REL && bun scripts/deploy/arch-recipes.ts $LINEAGE_RECIPES" | tail -n +1
    # agent desktops (SPEC 17.7): the hosted runtime's desktop image, rebuilt only when images/desktop changed
    if [ "${WITH_RUNTIME:-0}" = 1 ]; then
      h=$(cd "$REL/images/desktop" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)
      have=$(docker image inspect --format '{{ index .Config.Labels "lineage.build-hash" }}' lineage/desktop 2>/dev/null || true)
      if [ "$have" = "$h" ]; then echo "reusing lineage/desktop (build inputs unchanged)"
      else
        echo "building lineage/desktop from images/desktop"
        as_lineage "cd $REL && docker build -q --label lineage=1 --label lineage.build-hash=$h -t lineage/desktop images/desktop >/dev/null"
      fi
      echo "  lineage/desktop $(docker image inspect --format '{{.Id}}' lineage/desktop | cut -c1-19)"
    fi
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
  # the new units first, so the stop below already uses their drain allowance (TimeoutStopSec)
  install -m 644 "$REL"/scripts/deploy/systemd/*.service "$REL"/scripts/deploy/systemd/*.timer /etc/systemd/system/ && systemctl daemon-reload
  if [ -n "$OLD" ] && [ "$OLD" != "$REL" ]; then
    systemctl stop lineage-runtime $(all_authors) "${WORKER_UNITS[@]}" "${CORE_UNITS[@]}" 2>/dev/null || true
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
  install -m 644 "$REL"/scripts/deploy/systemd/*.service "$REL"/scripts/deploy/systemd/*.timer /etc/systemd/system/
  identity_setup "$REL"
  # Caddy
  SITES="${SITE_NAMES:-localhost}"
  if [ "$DRY_RUN" = 1 ]; then TLS="	tls internal"; GLOBAL="	local_certs"; else TLS=""; GLOBAL="${ACME_EMAIL:+	email $ACME_EMAIL}"; fi
  install -d -o caddy -g caddy /var/log/caddy
  sed -e "s|@SITES@|${SITES//,/, }|" -e "s|@TLS@|$TLS|" -e "s|@GLOBAL@|$GLOBAL|" "$REL/scripts/deploy/caddy/Caddyfile.tmpl" > /etc/caddy/Caddyfile.new
  caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile; exit 1; }
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  chown -R caddy:caddy /var/log/caddy   # `caddy validate` above ran as root and may have created the log file
  systemctl daemon-reload
  systemctl enable -q "${CORE_UNITS[@]}" caddy
  systemctl restart "${CORE_UNITS[@]}"
  systemctl reload-or-restart caddy
  systemctl enable -q --now "$IDENTITY_TIMER"
  if [ "$DRY_RUN" = 1 ]; then
    echo "dry run: lineage-bootstrap, lineage-reference, lineage-verifier@v1, lineage-verifier@v2, lineage-runtime, lineage-author@* SKIPPED (sandbox units need Docker)"
  else
    systemctl enable -q "${WORKER_UNITS[@]}"
    systemctl restart --no-block lineage-bootstrap
    # --no-block: the workers are ordered after lineage-bootstrap, which can calibrate for an hour or more
    systemctl restart --no-block "${WORKER_UNITS[@]}"
    for u in lineage-runtime $(all_authors); do systemctl disable -q --now "$u" 2>/dev/null || true; done
    for u in $(optional_units); do systemctl enable -q "$u"; systemctl restart --no-block "$u"; done
  fi
  echo "active: $SHA"
  ;;
rollback)
  PREV="$(cat "$BASE/previous" 2>/dev/null || true)"
  [ -n "$PREV" ] && [ -d "$PREV" ] || { echo "no previous release recorded" >&2; exit 1; }
  CUR="$(readlink "$BASE/current")"
  systemctl stop "$IDENTITY_TIMER" lineage-runtime $(all_authors) "${WORKER_UNITS[@]}" "${CORE_UNITS[@]}" 2>/dev/null || true
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
  ls "$PREV"/scripts/deploy/systemd/*.timer >/dev/null 2>&1 && install -m 644 "$PREV"/scripts/deploy/systemd/*.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl start "${CORE_UNITS[@]}"
  [ "$DRY_RUN" = 1 ] || systemctl start "${WORKER_UNITS[@]}" $(optional_units)
  echo "rolled back to $(basename "$PREV")"
  ;;
stop)
  systemctl disable -q --now "$IDENTITY_TIMER" lineage-identity-cycle lineage-runtime $(all_authors) lineage-bootstrap "${WORKER_UNITS[@]}" "${CORE_UNITS[@]}" caddy 2>/dev/null || true
  echo "stopped: every lineage unit and Caddy (disabled; 'start' brings them back)"
  ;;
start)
  systemctl enable -q --now "${CORE_UNITS[@]}" caddy "$IDENTITY_TIMER"
  [ "$DRY_RUN" = 1 ] || systemctl enable -q --now "${WORKER_UNITS[@]}" $(optional_units)
  echo "started"
  ;;
status)
  echo "release   $(basename "$(readlink "$BASE/current" 2>/dev/null || echo none)") (previous $(basename "$(cat "$BASE/previous" 2>/dev/null || echo none)"))"
  for u in "${CORE_UNITS[@]}" "$IDENTITY_TIMER" caddy lineage-bootstrap "${WORKER_UNITS[@]}" lineage-runtime $(all_authors | sort -u); do
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
  for p in /home/lineage/.config/lineage/devnet/{core-authority,faucet,runtime-authority}.json /home/lineage/.config/lineage/devnet/agent-*.json; do
    [ -f "$p" ] && { shred -u "$p" 2>/dev/null || rm -f "$p"; echo "removed $(basename "$p" .json)"; }
  done
  rm -f /home/lineage/.config/lineage/model.env /home/lineage/.config/lineage/rpc.env /home/lineage/.config/lineage/e2b.env
  # the keyed RPC URL was also resolved into the rendered network config (audit A2)
  NETCFG=/var/lib/lineage/site/network.json
  if [ -f "$NETCFG" ] && grep -q '"rpc' "$NETCFG"; then
    python3 - "$NETCFG" <<'PY' && echo "cleared the RPC URL from $NETCFG (Core falls back to public devnet until the next install)"
import json, sys
p = sys.argv[1]
c = json.load(open(p))
def scrub(o):
    if isinstance(o, dict):
        for k in list(o):
            if "rpc" in k.lower() and isinstance(o[k], str): o[k] = "https://api.devnet.solana.com"
            else: scrub(o[k])
    elif isinstance(o, list):
        for x in o: scrub(x)
scrub(c)
json.dump(c, open(p, "w"), indent=2)
PY
  fi
  rm -f /etc/lineage-identity/core-key.json /etc/lineage-identity/identity.env
  echo "copied keys removed; the site's own keys stay in /home/lineage/.config/lineage/site"
  echo "the identity store /var/lib/lineage/identity and its key /etc/lineage-identity/master.key stay; delete both before destroying the box"
  ;;
*)
  echo "usage: remote.sh install|chain|activate <sha> | rollback [--with-data] | stop | start | status | wipe-keys" >&2
  exit 2
  ;;
esac
