#!/usr/bin/env bash
# Lineage site: server-side steps, run as root by deploy.sh over ssh. Never prints a secret.
#
#   remote.sh install <sha>      clone the shipped bundle into /opt/lineage/releases/<sha> (as lineage),
#                                bun install, build the sandbox images the recipes need, re-pin the
#                                recipes to this machine (arch-recipes.ts), make the site's keys, write configs
#   remote.sh chain <sha> [plan] register and bond the site's verifiers on devnet (site-chain.ts)
#   remote.sh activate <sha>     back up Core's data (online), install units and the Caddyfile, start the
#                                background units draining (no wait), point /opt/lineage/current at <sha>,
#                                restart the public units one by one with health checks (rollback on a
#                                failed check), queue the bootstrap and workers on <sha>, report drains
#                                still running after DRAIN_WAIT s (default 120)
#   remote.sh rollback [--with-data]   back to the previous release (with --with-data: also the data backup
#                                taken when the current release was activated)
#   remote.sh stop | start       stop (and disable) or start every lineage unit and Caddy
#   remote.sh status             units, memory, health, balances (site-status.ts), disk
#   remote.sh backup             a Core snapshot and both secrets+state parts now (lineage-backup.service
#                                and the units it wants; hourly by its timer)
#   remote.sh secrets-facts <state|identity>   public facts of the live data (public keys, key file hash,
#                                record names), for deploy.sh restore-test (scripts/deploy/backup-facts.ts)
#   remote.sh restore-secrets <state|identity> [--replace] [--root DIR]   write one decrypted part (a tar
#                                on stdin, sent by deploy.sh restore-secrets) into place for its owner
#   remote.sh monitor            run the monitor now and print every check
#   remote.sh restore-test [f]   restore a snapshot (default the newest) into a scratch Core on 127.0.0.1:9669
#                                and check it serves the snapshot's data; the live Core is not touched
#   remote.sh restore <f>        replace Core's data with a snapshot (the replaced data is kept); on a
#                                server with no release yet (disaster recovery) it only places the data
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
# Unit names (rebrand, docs/plans/REBRAND-UNITS.md 3.8): releases from before the rebrand install
# lineage-* units, later ones units-*. UP is the prefix of the release being started; the unit of the
# other prefix is stopped and disabled when its counterpart starts (other_unit), so the two never run
# together. Service users and paths are not renamed by this step.
unit_set() {
  UP="$1"
  CORE_UNITS=("$UP-core" "$UP-web" "$UP-gate" "$UP-indexer" "$UP-identity")
  IDENTITY_TIMER="$UP-identity-cycle.timer"
  # Core snapshots for off-machine backups, and the monitor (docs/DEPLOY-SITE.md "Backups", "Monitoring")
  HARDEN_TIMERS=("$UP-backup.timer" "$UP-monitor.timer")
  WORKER_UNITS=("$UP-reference" "$UP-verifier@v1" "$UP-verifier@v2")
  PUBLIC_UNITS=("$UP-core" "$UP-indexer" "$UP-identity" "$UP-web" "$UP-gate")
}
# the prefix a release's unit files use
release_prefix() { if [ -f "$1/scripts/deploy/systemd/units-core.service" ]; then echo units; else echo lineage; fi; }
other_unit() { case "$1" in units-*) echo "lineage-${1#units-}" ;; lineage-*) echo "units-${1#lineage-}" ;; esac; }
unit_set units
all_authors() { systemctl list-units --all --plain --no-legend 'units-author@*' 'lineage-author@*' 2>/dev/null | awk '{print $1}'; echo "$UP-author"; }

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

# Service users (audit OFF-D10, plan M4). Only `lineage` (sandbox, verifier, reference, bootstrap,
# authors, hosted runtime) is in the docker group. The internet-facing services and Core run as their
# own system users with no login shell, no home and no docker:
#   lineage-gate     the gate (reads nothing but the release)
#   lineage-web      the dashboard: the faucet key (moved here from lineage's home), the keyed RPC
#                    URL and the soul drafter's model key (in /etc/lineage/web.env, read by systemd)
#   lineage-indexer  the market indexer: its database, the keyed RPC URL (/etc/lineage/indexer.env)
#   lineage-core     Core: its database, the Core authority key (moved here), a copy of the admin key
#                    and its network.json, all in /etc/lineage-core (700); member of group lineage only to
#                    read the workers' git mirrors (the tree view) and the private canaries
#   lineage-monitor  the monitor timer (reads health endpoints, unit states, backup ages)
# Core's and the indexer's data stay group `lineage` (dirs 0770, Core runs as group lineage with UMask 0007), so a release
# from before the split still runs on the same data if one is activated; it then has no Core authority
# key (Core reads the chain without posting) and no faucet until this release is activated again.
SERVICE_USERS=(lineage-core lineage-web lineage-gate lineage-indexer lineage-monitor)
ensure_users() {
  local u
  for u in "${SERVICE_USERS[@]}"; do
    id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group "$u"
  done
  id -nG lineage-core | tr ' ' '\n' | grep -qx lineage || usermod -aG lineage lineage-core
  for u in "${SERVICE_USERS[@]}" lineage-identity; do
    id "$u" >/dev/null 2>&1 || continue
    if id -nG "$u" | tr ' ' '\n' | grep -qx -E 'docker|sudo|admin|adm|systemd-journal'; then echo "$u is in a privileged group ($(id -nG "$u")); refusing" >&2; exit 1; fi
  done
  install -d -m 700 -o lineage-core -g lineage-core /etc/lineage-core
  install -d -m 755 /etc/lineage
}
# The caddy.service drop-in. `caddy reload` sends the new config to the admin address named IN the new
# config, so a reload that moves the admin endpoint (localhost:2019 <-> the unix socket, in either
# direction, including a release from before the socket being activated) would ask a Caddy that is not
# listening there yet and fail (site deploy f701f6a, 2026-10-10). ExecReload therefore talks to the
# address the running Caddy is on: the socket when it answers there, else the default localhost:2019.
# provision.sh writes the same file.
caddy_dropin() {
  install -d /etc/systemd/system/caddy.service.d
  cat > /etc/systemd/system/caddy.service.d/lineage.conf <<'EOF'
[Service]
MemoryMax=256M
RuntimeDirectory=caddy
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=restart
ExecReload=
ExecReload=/bin/sh -c '/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force --address unix//run/caddy/admin.sock || /usr/bin/caddy reload --config /etc/caddy/Caddyfile --force --address localhost:2019'
EOF
  systemctl daemon-reload
}
# site-config.ts runs as lineage; the Core key it names is the service user's copy when there is one
site_config() {
  as_lineage "cd $1 && LINEAGE_SITE_CORE_KEY=$([ -f /etc/lineage-core/core-authority.json ] && echo /etc/lineage-core/core-authority.json) bun scripts/deploy/site-config.ts --out /var/lib/lineage/site"
}
# move_secret <from> <to> <owner>: a key leaves lineage's home for the one service that uses it
move_secret() {
  local from="$1" to="$2" owner="$3"
  [ -f "$from" ] || return 0
  if [ ! -f "$to" ] || ! cmp -s "$from" "$to"; then install -m 600 -o "$owner" -g "$owner" "$from" "$to.tmp" && mv "$to.tmp" "$to"; fi
  shred -u "$from" 2>/dev/null || rm -f "$from"
  echo "moved $(basename "$from") to $owner"
}
# env_line <file> <key in file> <key out>: one KEY=value line, nothing printed
env_line() { [ -f "$1" ] && sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*/$3=/p" "$1" | head -1 || true; }
users_setup() {
  local REL="$1" LH=/home/lineage/.config/lineage WEB=/var/lib/lineage/web
  ensure_users
  # Core: data, keys, config
  # group lineage (Core's primary group; no setgid directories: RestrictSUIDSGID refuses creating them)
  install -d -m 0770 -o lineage-core -g lineage /var/lib/lineage/core
  chown -R lineage-core:lineage /var/lib/lineage/core
  chmod -R g+rwX,g-s /var/lib/lineage/core
  move_secret "$LH/devnet/core-authority.json" /etc/lineage-core/core-authority.json lineage-core
  [ -f "$LH/site/admin.json" ] && install -m 600 -o lineage-core -g lineage-core "$LH/site/admin.json" /etc/lineage-core/admin.json
  # site-config.ts (run as lineage) renders network.json; Core reads its own copy
  site_config "$REL"
  install -m 600 -o lineage-core -g lineage-core /var/lib/lineage/site/network.json /etc/lineage-core/network.json
  # private canaries: Core reads them through group lineage
  chmod -R g+rX /var/lib/lineage/canaries 2>/dev/null || true
  # indexer
  install -d -m 0770 -o lineage-indexer -g lineage /var/lib/lineage/indexer
  chown -R lineage-indexer:lineage /var/lib/lineage/indexer
  chmod -R g-s /var/lib/lineage/indexer
  # web: its own home with the faucet key and log and the soul drafts' state; RPC and model key by env
  install -d -m 700 -o lineage-web -g lineage-web "$WEB" "$WEB/.config" "$WEB/.config/lineage" "$WEB/.config/lineage/devnet" "$WEB/.lineage" "$WEB/.lineage/web"
  move_secret "$LH/devnet/faucet.json" "$WEB/.config/lineage/devnet/faucet.json" lineage-web
  if [ -f "$LH/devnet/faucet-log.jsonl" ]; then install -m 600 -o lineage-web -g lineage-web "$LH/devnet/faucet-log.jsonl" "$WEB/.config/lineage/devnet/faucet-log.jsonl" && rm -f "$LH/devnet/faucet-log.jsonl"; fi
  local sd=/home/lineage/.lineage/web/soul-drafts.jsonl
  if [ -f "$sd" ] && [ ! -f "$WEB/.lineage/web/soul-drafts.jsonl" ]; then install -m 600 -o lineage-web -g lineage-web "$sd" "$WEB/.lineage/web/soul-drafts.jsonl"; fi
  ( umask 077
    { env_line "$LH/rpc.env" HELIUS_DEVNET_RPC LINEAGE_DEVNET_RPC; env_line "$LH/model.env" ANTHROPIC_API_KEY ANTHROPIC_API_KEY; } > /etc/lineage/web.env
    env_line "$LH/rpc.env" HELIUS_DEVNET_RPC LINEAGE_DEVNET_RPC > /etc/lineage/indexer.env )
  chmod 600 /etc/lineage/web.env /etc/lineage/indexer.env
  # monitor: what to watch (public keys and names only; alert sinks are the owner's /etc/lineage/alert.env)
  local pk=/var/lib/lineage/site/pubkeys.json
  if [ -f "$pk" ]; then
    ( umask 022
      printf 'MONITOR_SITE=https://%s\n' "${SITE_NAMES%%,*}"
      printf 'MONITOR_VERIFIERS=%s\n' "$(jq -r '[.site["verifier-ref"], .site["verifier-v1"], .site["verifier-v2"]] | map(select(.)) | join(",")' "$pk")"
      printf 'MONITOR_BALANCES=core-authority:%s,owner:%s\n' "$(jq -r '.core_authority // empty' "$REL/scripts/devnet/devnet.json")" "$(jq -r '.site.owner // empty' "$pk")"
      printf 'MONITOR_RUNTIME=%s\n' "${WITH_RUNTIME:-0}"
      printf 'MONITOR_CORE_SIGNING=%s\n' "$([ -f /etc/lineage-core/core-authority.json ] && echo 1 || echo 0)"
      printf 'MONITOR_DRY_RUN=%s\n' "$DRY_RUN" ) > /etc/lineage/monitor.env
  fi
  install -d -m 0750 -o lineage-core -g lineage-monitor /var/lib/lineage/core-backups
  chmod g-s /var/lib/lineage/core-backups
  echo "service users: $(for u in "${SERVICE_USERS[@]}" lineage-identity lineage; do id "$u" >/dev/null 2>&1 && printf '%s(%s) ' "$u" "$(id -nG "$u" | tr ' ' ',')"; done)"
}

# Secrets+state snapshots (docs/DEPLOY-SITE.md "Backups"): age, and one directory per part owned by the
# user that writes it (lineage, lineage-identity), group lineage-monitor so the monitor sees their age.
# The public recipient in /etc/lineage/backup-recipient.txt is written by deploy.sh; without it the two
# part units are skipped (ConditionPathExists) and the monitor warns.
backup_tools() {
  local t miss=()
  for t in age zstd sqlite3; do command -v "$t" >/dev/null || miss+=("$t"); done
  [ ${#miss[@]} = 0 ] || { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${miss[@]}" >/dev/null && echo "installed ${miss[*]}"; }
}
backup_setup() {
  backup_tools
  install -d -m 0750 -o lineage -g lineage-monitor /var/lib/lineage/state-backups
  install -d -m 0750 -o lineage-identity -g lineage-monitor /var/lib/lineage/identity-backups
  chmod g-s /var/lib/lineage/state-backups /var/lib/lineage/identity-backups
  [ -s /etc/lineage/backup-recipient.txt ] || echo "no /etc/lineage/backup-recipient.txt: secrets+state snapshots off (deploy.sh copies it when ~/.config/lineage/backup-age.key exists on the owner's machine)"
}

# the user the installed Core unit runs as (lineage before the service users, lineage-core after)
core_user() { sed -n 's/^User=//p' "/etc/systemd/system/$UP-core.service" 2>/dev/null | head -1; }

optional_units() {
  local u=()
  [ "${WITH_RUNTIME:-0}" = 1 ] && u+=("$UP-runtime")
  if [ "${WITH_AUTHOR:-0}" = 1 ]; then for n in ${AUTHORS:-minbpe}; do u+=("$UP-author@$n"); done; fi
  echo "${u[@]:-}"
}

# ---- zero-downtime activate (docs/DEPLOY-SITE.md "Zero-downtime activate") ----------------------------
# Incident 2026-10-10 19:42 to about 20:28 UTC: activate ran one `systemctl stop` over the workers and the
# public units together, and systemctl waited for lineage-verifier@v2 to finish a long replay
# (TimeoutStopSec 45 min) before Core, web and the gate came back: the whole site answered 502 for about
# 45 minutes. Now the two sets never share a stop:
#   public units      restarted one at a time, each health-checked before the next (seconds each); a
#                     failed check rolls the release back. Caddy retries a refused dial to the gate, the
#                     gate retries a refused upstream, web's /api proxy retries a refused Core, so a
#                     request during a restart waits instead of failing.
#   background units  told to stop with --no-block (each drains as before: a verifier finishes and commits
#                     its current replay and reveals what it committed), and a start is queued behind each
#                     stop; systemd never runs two processes of one unit, so the new release's verifier
#                     starts only after the old one has exited and then reveals from the same pending.json.
#                     The deploy waits at most DRAIN_WAIT seconds for them, then names what is still
#                     draining and returns.
# PUBLIC_UNITS (unit_set above): Core first, then the indexer, identity, web and the gate
DRAIN_WAIT="${DRAIN_WAIT:-120}"     # seconds activate waits for background units to finish draining
HEALTH_WAIT="${HEALTH_WAIT:-180}"   # seconds each public unit has to answer after its restart (a fresh Core reads the chain first)
health_url() {
  case "${1#*-}" in
    core) echo http://127.0.0.1:9660/v1/health ;;
    indexer) echo http://127.0.0.1:9668/market/summary ;;
    identity) echo http://127.0.0.1:9665/identity/health ;;
    web) echo http://127.0.0.1:9661/live/status ;;
    gate) echo http://127.0.0.1:9662/gate/health ;;
  esac
}
now_ms() { date +%s%3N; }
# restart_checked <unit>: restart one public unit and wait until it answers (200; the indexer: any HTTP
# answer, it may still be catching up). 1 when it does not within HEALTH_WAIT seconds.
restart_checked() {
  local u="$1" t0 code url o
  t0=$(now_ms)
  # the same service under the other prefix (rebrand) holds the port: stop and disable it first; the
  # restart below follows within the same second, and the callers retry a refused dial meanwhile
  o="$(other_unit "$u")"
  # (also when it is only activating: a failed unit of the other prefix in its Restart= loop would come
  # back and, through Conflicts=, stop this one; dry run 2026-10-10)
  if [ -n "$o" ]; then case "$(systemctl is-active "$o" 2>/dev/null)" in active|activating|reloading|deactivating) systemctl stop --job-mode=ignore-dependencies "$o"; echo "  $o stopped (replaced by $u)" ;; esac; fi
  [ -n "$o" ] && systemctl disable -q "$o" 2>/dev/null || true
  # ignore-dependencies: a worker unit is ordered After=lineage-core, so a plain restart of Core waits
  # until every draining worker has stopped (stop jobs run in reverse order) and the release switch waits
  # with it; the dry run's simulated verifier drain showed exactly that. Boot and shutdown keep the order.
  systemctl restart --job-mode=ignore-dependencies "$u" || { echo "  $u: restart failed" >&2; return 1; }
  if [ "$(systemctl show -p ConditionResult --value "$u")" = no ]; then echo "  $u skipped (unit condition not met)"; return 0; fi
  url="$(health_url "$u")"
  local until=$(( $(date +%s) + HEALTH_WAIT ))
  while [ "$(date +%s)" -lt "$until" ]; do
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [ "${u#*-}" = indexer ] && [ -n "$code" ] && [ "$code" != 000 ]; then break; fi
    [ "$code" = 200 ] && break
    sleep 0.25
  done
  if [ "${u#*-}" = indexer ] && [ -n "$code" ] && [ "$code" != 000 ] || [ "$code" = 200 ]; then
    echo "  $u up in $(( ($(now_ms) - t0) )) ms"
    return 0
  fi
  echo "  $u did not answer $url within ${HEALTH_WAIT} s (last HTTP ${code:-none})" >&2
  journalctl -u "$u" -n 15 -o cat --no-pager 2>/dev/null | sed 's/^/    /' >&2 || true
  return 1
}
# public_restart: every public unit in order (Core first: the others read it), then nothing else.
# Prints the failed unit and returns 1 on the first failed health check.
public_restart() {
  local u
  for u in "${PUBLIC_UNITS[@]}"; do restart_checked "$u" || { FAILED_UNIT="$u"; return 1; }; done
}
# the background units running now (they drain on stop): hosted runtime, authors, reference, every
# verifier instance (incl. any beyond v1/v2)
active_background() {
  local u
  for u in units-runtime units-reference lineage-runtime lineage-reference $(all_authors) units-author lineage-author $(systemctl list-units --all --plain --no-legend 'units-verifier@*' 'lineage-verifier@*' 2>/dev/null | awk '{print $1}'); do
    case "$(systemctl is-active "$u" 2>/dev/null)" in active|activating|reloading|deactivating) echo "${u%.service}" ;; esac
  done | sort -u
}
# drain_report <seconds> <unit...>: wait for the given units to finish stopping, at most <seconds>; prints
# each one as it finishes and a DRAINING line for each one still stopping when the time is up
drain_report() {
  local wait="$1"; shift
  local left=("$@") t0 u st next=()
  [ ${#left[@]} = 0 ] && { echo "background: nothing was running"; return 0; }
  t0=$(date +%s)
  while :; do
    next=()
    for u in "${left[@]}"; do
      st="$(systemctl is-active "$u" 2>/dev/null || true)"
      if [ "$st" = deactivating ]; then next+=("$u"); else echo "  $u drained in $(( $(date +%s) - t0 )) s (now $st)"; fi
    done
    left=("${next[@]}")
    [ ${#left[@]} = 0 ] && { echo "background: every unit drained"; return 0; }
    [ $(( $(date +%s) - t0 )) -ge "$wait" ] && break
    sleep 2
  done
  for u in "${left[@]}"; do
    printf 'DRAINING %s: still stopping after %s s (stop timeout %s); the queued start runs this release when it exits\n' \
      "$u" "$wait" "$(systemctl show -p TimeoutStopUSec --value "$u")"
  done
}

case "$CMD" in
install)
  SHA="$1"; REL="$BASE/releases/$SHA"
  [ -f "$BASE/incoming.bundle" ] || { echo "no bundle at $BASE/incoming.bundle" >&2; exit 1; }
  ensure_users   # the keys step may copy keys straight to a service user before activate
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
  site_config "$REL"
  echo "PUBKEYS $(cat /var/lib/lineage/site/pubkeys.json)"
  ;;
chain)
  SHA="$1"; REL="$BASE/releases/$SHA"
  as_lineage "cd $REL && bun scripts/deploy/site-chain.ts --caps /var/lib/lineage/site/caps.json ${2:+--plan}"
  ;;
activate)
  SHA="$1"; REL="$BASE/releases/$SHA"
  [ -d "$REL" ] || { echo "no release $SHA" >&2; exit 1; }
  unit_set "$(release_prefix "$REL")"
  OLD="$(readlink "$BASE/current" 2>/dev/null || true)"
  T_ACT=$(date +%s)
  # 1. stage everything while the old release keeps serving: configs, users, keys, the Caddyfile
  site_config "$REL"
  # the new units first, so the stops below already use their drain allowance (TimeoutStopSec)
  install -m 644 "$REL"/scripts/deploy/systemd/*.service "$REL"/scripts/deploy/systemd/*.timer /etc/systemd/system/ && systemctl daemon-reload
  PREV_SAVED="$(cat "$BASE/previous" 2>/dev/null || true)" PREVB_SAVED="$(cat "$BASE/previous-backup" 2>/dev/null || true)"
  if [ -n "$OLD" ] && [ "$OLD" != "$REL" ]; then
    B="/var/lib/lineage/backups/$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$OLD")"
    install -d -o lineage -g lineage "$B"
    if [ -f /var/lib/lineage/core/core.db ]; then
      # online copy while the old Core keeps serving: VACUUM INTO is one read transaction (consistent;
      # WAL writers are not blocked), where `.backup` restarts on every write (backup.sh)
      sqlite3 /var/lib/lineage/core/core.db ".timeout 60000" "vacuum into '$B/core.db'"
      sqlite3 "$B/core.db" "pragma journal_mode=delete" >/dev/null
      chown lineage:lineage "$B/core.db"
    fi
    echo "$OLD" > "$BASE/previous"
    echo "$B" > "$BASE/previous-backup"
    echo "data backup $B (taken with the old Core serving; writes in the seconds before its restart are not in it)"
    ls -1dt /var/lib/lineage/backups/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
  fi
  identity_setup "$REL"
  users_setup "$REL"
  backup_setup
  # Caddy. Its admin API listens on a unix socket in /run/caddy (mode 0600, owner caddy) instead of
  # localhost:2019, so other local users cannot rewrite the proxy (audit OFF-D12).
  caddy_dropin
  SITES="${SITE_NAMES:-localhost}"
  if [ "$DRY_RUN" = 1 ]; then TLS="	tls internal"; GLOBAL="	local_certs"; else TLS=""; GLOBAL="${ACME_EMAIL:+	email $ACME_EMAIL}"; fi
  install -d -o caddy -g caddy /var/log/caddy
  sed -e "s|@SITES@|${SITES//,/, }|" -e "s|@TLS@|$TLS|" -e "s|@GLOBAL@|$GLOBAL|" "$REL/scripts/deploy/caddy/Caddyfile.tmpl" > /etc/caddy/Caddyfile.new
  # Caddy before 2.8 (Ubuntu's package, provision.sh's fallback when the Caddy apt repository refuses)
  # takes the `|0600` socket mode as part of the file name, and its reloads then reach no admin socket;
  # /run/caddy is 0750 caddy:caddy either way, so no other local user can reach the socket
  read -r CMAJ CMIN < <(caddy version | sed -n 's/^v\{0,1\}\([0-9]*\)\.\([0-9]*\).*/\1 \2/p') || true
  if [ "${CMAJ:-2}" = 2 ] && [ "${CMIN:-99}" -lt 8 ]; then sed -i 's#admin.sock|0600#admin.sock#' /etc/caddy/Caddyfile.new; echo "caddy $CMAJ.$CMIN: admin socket without a mode suffix"; fi
  caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile; exit 1; }
  [ -f /etc/caddy/Caddyfile ] && cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  chown -R caddy:caddy /var/log/caddy   # `caddy validate` above ran as root and may have created the log file
  systemctl daemon-reload
  systemctl enable -q "${CORE_UNITS[@]}" caddy
  # Caddy first: the new config's dial retries cover the gate's restart below (graceful reload; a
  # restart only when the running Caddy cannot be reached to reload, about a second of refused connections)
  systemctl reload-or-restart caddy || { echo "caddy reload failed; restarting it"; systemctl restart caddy; }
  # 2. background units start draining now, in parallel, and never hold the public restart
  mapfile -t BG < <(active_background)
  [ ${#BG[@]} -gt 0 ] && { systemctl stop --no-block "${BG[@]}"; echo "background draining (no wait): ${BG[*]}"; }
  # 3. switch the release and restart the public units one by one, each health-checked
  ln -sfn "$REL" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  echo "public units (Core first, each health-checked):"
  FAILED_UNIT=""
  if ! public_restart; then
    if [ -z "$OLD" ] || [ "$OLD" = "$REL" ] || [ ! -d "$OLD" ]; then
      echo "ACTIVATE FAILED: $FAILED_UNIT did not come up and there is no other release to go back to" >&2
      exit 1
    fi
    echo "ACTIVATE FAILED: $FAILED_UNIT did not come up on $(basename "$REL"); rolling back to $(basename "$OLD")" >&2
    unit_set "$(release_prefix "$OLD")"
    ln -sfn "$OLD" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
    if [ -n "$PREV_SAVED" ]; then echo "$PREV_SAVED" > "$BASE/previous"; else rm -f "$BASE/previous"; fi
    if [ -n "$PREVB_SAVED" ]; then echo "$PREVB_SAVED" > "$BASE/previous-backup"; else rm -f "$BASE/previous-backup"; fi
    install -m 644 "$OLD"/scripts/deploy/systemd/*.service /etc/systemd/system/
    ls "$OLD"/scripts/deploy/systemd/*.timer >/dev/null 2>&1 && install -m 644 "$OLD"/scripts/deploy/systemd/*.timer /etc/systemd/system/
    systemctl daemon-reload
    site_config "$OLD" >/dev/null 2>&1 || true
    [ -f /var/lib/lineage/site/network.json ] && install -m 600 -o lineage-core -g lineage-core /var/lib/lineage/site/network.json /etc/lineage-core/network.json
    if [ -f /etc/caddy/Caddyfile.prev ]; then cp -p /etc/caddy/Caddyfile.prev /etc/caddy/Caddyfile; systemctl reload-or-restart caddy || true; fi
    public_restart || echo "the previous release did not come up either ($FAILED_UNIT); see journalctl -u $FAILED_UNIT" >&2
    [ ${#BG[@]} -gt 0 ] && systemctl start --no-block "${BG[@]}"
    echo "rolled back to $(basename "$OLD") (background units restart on it when their drain ends)" >&2
    exit 1
  fi
  for u in "$IDENTITY_TIMER" "${HARDEN_TIMERS[@]}"; do systemctl disable -q --now "$(other_unit "$u")" 2>/dev/null || true; done
  systemctl enable -q --now "$IDENTITY_TIMER" "${HARDEN_TIMERS[@]}"
  echo "public units on $(basename "$REL") $(( $(date +%s) - T_ACT )) s after activate began"
  # 4. queue the background units' starts on the new release: a unit still draining starts when its old
  # process exits (systemd waits for the stop; never two processes of one unit)
  WANT=()
  if [ "$DRY_RUN" = 1 ]; then
    echo "dry run: $UP-bootstrap, $UP-reference, $UP-verifier@v1, $UP-verifier@v2, $UP-runtime, $UP-author@* SKIPPED (sandbox units need Docker)"
  else
    for u in $(for w in "${WORKER_UNITS[@]}" "$UP-bootstrap" "$UP-runtime"; do other_unit "$w"; done); do systemctl disable -q "$u" 2>/dev/null || true; done
    systemctl enable -q "${WORKER_UNITS[@]}"
    systemctl restart --no-block "$UP-bootstrap"
    WANT+=("${WORKER_UNITS[@]}")
    OPT=" $(optional_units) "
    for u in units-runtime lineage-runtime $(all_authors); do
      u="${u%.service}"
      case "$OPT" in *" $u "*) ;; *) systemctl disable -q "$u" 2>/dev/null || true ;; esac
    done
    for u in $(optional_units); do systemctl enable -q "$u"; WANT+=("$u"); done
  fi
  # any other verifier instance that was running goes back up too (it drained above)
  for u in "${BG[@]}"; do case "$u" in *-verifier@*) WANT+=("$UP-verifier@${u#*@}") ;; esac; done
  if [ ${#WANT[@]} -gt 0 ]; then
    mapfile -t WANT < <(printf '%s\n' "${WANT[@]}" | sort -u)
    # --no-block: the workers are ordered after lineage-bootstrap, which can calibrate for an hour or more
    systemctl start --no-block "${WANT[@]}"
    echo "background starts queued: ${WANT[*]}"
  fi
  # 5. bounded wait for the drains, then name what is still draining
  drain_report "$DRAIN_WAIT" "${BG[@]}"
  echo "active: $SHA"
  ;;
rollback)
  PREV="$(cat "$BASE/previous" 2>/dev/null || true)"
  [ -n "$PREV" ] && [ -d "$PREV" ] || { echo "no previous release recorded" >&2; exit 1; }
  CUR="$(readlink "$BASE/current")"
  # background units drain without holding the public units (as in activate); with --with-data, or back
  # to a release from before the service users, the public units are stopped here (data or owners change)
  mapfile -t BG < <(active_background)
  systemctl stop "$IDENTITY_TIMER" 2>/dev/null || true
  [ ${#BG[@]} -gt 0 ] && { systemctl stop --no-block "${BG[@]}"; echo "background draining (no wait): ${BG[*]}"; }
  unit_set "$(release_prefix "$PREV")"
  PREV_USER="$(sed -n 's/^User=//p' "$PREV/scripts/deploy/systemd/$UP-core.service" 2>/dev/null | head -1)"
  if [ "${1:-}" = "--with-data" ] || [ "$PREV_USER" = lineage ]; then systemctl stop "${CORE_UNITS[@]}" $(for u in "${CORE_UNITS[@]}"; do other_unit "$u"; done) 2>/dev/null || true; fi
  if [ "${1:-}" = "--with-data" ]; then
    BK="$(cat "$BASE/previous-backup")"
    [ -f "$BK/core.db" ] || { echo "no data backup at $BK" >&2; exit 1; }
    M="/var/lib/lineage/backups/$(date -u +%Y%m%dT%H%M%SZ)-before-rollback"
    install -d -o lineage -g lineage "$M"
    mv /var/lib/lineage/core/core.db* "$M"/ 2>/dev/null || true
    install -o "$(core_user)" -g lineage -m 660 "$BK/core.db" /var/lib/lineage/core/core.db
    echo "data restored from $BK (the replaced data is in $M)"
  fi
  ln -sfn "$PREV" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  echo "$CUR" > "$BASE/previous"
  install -m 644 "$PREV"/scripts/deploy/systemd/*.service /etc/systemd/system/
  ls "$PREV"/scripts/deploy/systemd/*.timer >/dev/null 2>&1 && install -m 644 "$PREV"/scripts/deploy/systemd/*.timer /etc/systemd/system/
  systemctl daemon-reload
  if [ "$(core_user)" = lineage ]; then
    # back to a release from before the service users: it runs everything as lineage and finds its
    # keys in lineage's home, so they are copied back there (the data is group lineage already)
    LH=/home/lineage/.config/lineage
    [ -f /etc/lineage-core/core-authority.json ] && install -m 600 -o lineage -g lineage /etc/lineage-core/core-authority.json "$LH/devnet/core-authority.json"
    [ -f /var/lib/lineage/web/.config/lineage/devnet/faucet.json ] && install -m 600 -o lineage -g lineage /var/lib/lineage/web/.config/lineage/devnet/faucet.json "$LH/devnet/faucet.json"
    chown -R lineage:lineage /var/lib/lineage/core /var/lib/lineage/indexer
    as_lineage "cd $PREV && bun scripts/deploy/site-config.ts --out /var/lib/lineage/site"
    systemctl disable -q --now "${HARDEN_TIMERS[@]}" 2>/dev/null || true
    echo "previous release predates the service users: keys copied back to lineage, backup and monitor timers off"
  fi
  echo "public units (Core first, each health-checked):"
  FAILED_UNIT=""
  public_restart || echo "$FAILED_UNIT did not come up on $(basename "$PREV"); see journalctl -u $FAILED_UNIT" >&2
  for u in "$IDENTITY_TIMER" "${HARDEN_TIMERS[@]}"; do systemctl disable -q --now "$(other_unit "$u")" 2>/dev/null || true; done
  for u in $(for w in "${WORKER_UNITS[@]}" "$UP-bootstrap" "$UP-runtime"; do other_unit "$w"; done); do systemctl disable -q "$u" 2>/dev/null || true; done
  systemctl enable -q "${CORE_UNITS[@]}" 2>/dev/null || true
  systemctl start "$IDENTITY_TIMER" 2>/dev/null || true
  WANT=()
  [ "$DRY_RUN" = 1 ] || WANT+=("${WORKER_UNITS[@]}" $(optional_units))
  for u in "${BG[@]}"; do case "$u" in *-verifier@*) WANT+=("$UP-verifier@${u#*@}") ;; esac; done
  [ ${#WANT[@]} -gt 0 ] && systemctl start --no-block $(printf '%s\n' "${WANT[@]}" | sort -u)
  drain_report "$DRAIN_WAIT" "${BG[@]}"
  echo "rolled back to $(basename "$PREV")"
  [ -z "$FAILED_UNIT" ]
  ;;
stop)
  for P in units lineage; do
    unit_set "$P"
    systemctl disable -q --now "${HARDEN_TIMERS[@]}" "$IDENTITY_TIMER" "$P-identity-cycle" "$P-runtime" $(all_authors) "$P-bootstrap" "${WORKER_UNITS[@]}" "${CORE_UNITS[@]}" 2>/dev/null || true
  done
  systemctl disable -q --now caddy 2>/dev/null || true
  echo "stopped: every units (and lineage) unit and Caddy (disabled; 'start' brings them back)"
  ;;
start)
  unit_set "$(release_prefix "$(readlink -f "$BASE/current")")"
  systemctl enable -q --now "${CORE_UNITS[@]}" caddy "$IDENTITY_TIMER" "${HARDEN_TIMERS[@]}"
  [ "$DRY_RUN" = 1 ] || systemctl enable -q --now "${WORKER_UNITS[@]}" $(optional_units)
  echo "started"
  ;;
status)
  unit_set "$(release_prefix "$(readlink -f "$BASE/current")")"
  echo "release   $(basename "$(readlink "$BASE/current" 2>/dev/null || echo none)") (previous $(basename "$(cat "$BASE/previous" 2>/dev/null || echo none)"))"
  for u in "${CORE_UNITS[@]}" "$IDENTITY_TIMER" "${HARDEN_TIMERS[@]}" caddy "$UP-bootstrap" "${WORKER_UNITS[@]}" "$UP-runtime" $(all_authors | sort -u); do
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
  echo "--"
  N="$(ls -1t /var/lib/lineage/core-backups/core-*.tar.zst 2>/dev/null | head -1)"
  [ -n "$N" ] && echo "backup    $(basename "$N") $(du -h "$N" | cut -f1), $(ls -1 /var/lib/lineage/core-backups/core-*.tar.zst | wc -l) kept" || echo "backup    none yet"
  for p in state identity; do
    N="$(ls -1t /var/lib/lineage/$p-backups/$p-*.tar.zst.age 2>/dev/null | head -1)"
    [ -n "$N" ] && echo "backup    $(basename "$N") $(du -h "$N" | cut -f1), $(ls -1 /var/lib/lineage/$p-backups/$p-*.tar.zst.age | wc -l) kept (encrypted)" || echo "backup    no $p snapshot yet"
  done
  M=/var/lib/lineage-monitor/state.json
  if [ -f "$M" ]; then
    echo "monitor   $(jq -r '.worst + " at " + .at' "$M")"
    jq -r '.checks[] | select(.level != "ok") | "  " + .level + " " + .id + ": " + .msg' "$M"
  else echo "monitor   no run yet"; fi
  for u in lineage "${SERVICE_USERS[@]}" lineage-identity; do id "$u" >/dev/null 2>&1 && printf '%-16s %s\n' "$u" "$(id -nG "$u" | tr ' ' ',')"; done | sed 's/^/user      /'
  ;;
backup)
  # the hourly timer's job now: the two secrets+state parts (each as its data's owner), then Core
  # one transaction: lineage-backup.service wants the two parts, so each runs once
  rc=0
  unit_set "$(release_prefix "$(readlink -f "$BASE/current")")"
  systemctl start "$UP-backup-state.service" "$UP-backup-identity.service" "$UP-backup.service" || rc=1
  for u in "$UP-backup-state" "$UP-backup-identity" "$UP-backup"; do
    l="$(journalctl -u "$u" -n 12 -o cat --no-pager | grep -E '^snapshot|^backup:' | tail -1 || true)"
    echo "${l:-$u: no snapshot line (journalctl -u $u)}"
  done
  [ -s /etc/lineage/backup-recipient.txt ] || echo "secrets+state parts skipped: no /etc/lineage/backup-recipient.txt"
  exit $rc
  ;;
secrets-facts)
  # public facts only (public keys, the identity key file's sha256, record names), read by the data's owner
  P="${1:-}"; REL="$(readlink -f "$BASE/current")"
  case "$P" in state) U=lineage H=/home/lineage ;; identity) U=lineage-identity H=/var/lib/lineage/identity/home ;; *) echo "usage: remote.sh secrets-facts state|identity" >&2; exit 2 ;; esac
  runuser -u "$U" -- env -i HOME="$H" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 PATH=/usr/local/bin:/usr/bin:/bin \
    bash -c "cd $REL && bun scripts/deploy/backup-facts.ts facts --part $P --root /"
  ;;
restore-secrets)
  # One decrypted secrets+state part on stdin (a tar of paths from /, sent by deploy.sh restore-secrets,
  # which decrypts on the owner's machine). Only that part's paths are accepted; each file lands owned
  # by its owner with the mode it was saved with. A file that exists and differs is a refusal (nothing is
  # written) unless --replace, which keeps the replaced files in /var/lib/lineage/backups and stops the
  # part's services while writing. --root writes under another directory (tests). Nothing is printed
  # from the files; only their names and counts.
  P="${1:-}"; shift || true
  REPLACE=0 RR=""
  while [ $# -gt 0 ]; do case "$1" in --replace) REPLACE=1; shift ;; --root) RR="$2"; shift 2 ;; *) echo "unknown argument $1" >&2; exit 2 ;; esac; done
  case "$P" in
    state) OWNER=lineage; ALLOW='^(var/lib/lineage/runtime/|home/lineage/\.config/lineage/site/)'; UNITS=(units-runtime lineage-runtime) ;;
    identity) OWNER=lineage-identity; ALLOW='^(var/lib/lineage/identity/records/|etc/lineage-identity/master\.key$)'; UNITS=(units-identity-cycle.timer units-identity lineage-identity-cycle.timer lineage-identity)
      id lineage-identity >/dev/null 2>&1 || useradd --system --home-dir /var/lib/lineage/identity/home --no-create-home --shell /usr/sbin/nologin --user-group lineage-identity ;;
    *) echo "usage: remote.sh restore-secrets state|identity [--replace] [--root DIR] < part.tar" >&2; exit 2 ;;
  esac
  id lineage >/dev/null 2>&1 || { echo "no lineage user: run deploy.sh <host> provision first" >&2; exit 1; }
  T="$(mktemp -d /root/restore-secrets.XXXXXX)"; trap 'rm -rf "$T"' EXIT
  tar -C "$T" --no-same-owner -xpf -
  mapfile -t FILES < <(cd "$T" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
  [ ${#FILES[@]} -gt 0 ] || { echo "no files on stdin" >&2; exit 1; }
  [ -z "$(find "$T" -type l)" ] || { echo "links in the archive; refusing" >&2; exit 1; }
  BAD="$(printf '%s\n' "${FILES[@]}" | grep -vE "$ALLOW" || true)"
  [ -z "$BAD" ] || { echo "paths outside the $P part; refusing: $(echo "$BAD" | head -3 | paste -sd' ' -)" >&2; exit 1; }
  DIFF=()
  for f in "${FILES[@]}"; do [ -e "$RR/$f" ] && ! cmp -s "$T/$f" "$RR/$f" && DIFF+=("$f"); done
  if [ ${#DIFF[@]} -gt 0 ] && [ "$REPLACE" != 1 ]; then
    echo "refusing: ${#DIFF[@]} file(s) exist and differ (nothing written; --replace keeps the old ones aside):" >&2
    printf '  %s\n' "${DIFF[@]}" | head -20 >&2
    exit 1
  fi
  WAS=()
  if [ -z "$RR" ] && [ ${#DIFF[@]} -gt 0 ]; then
    for u in "${UNITS[@]}"; do systemctl is-active -q "$u" 2>/dev/null && WAS+=("$u"); done
    [ ${#WAS[@]} -gt 0 ] && systemctl stop "${WAS[@]}"
    M="/var/lib/lineage/backups/$(date -u +%Y%m%dT%H%M%SZ)-before-restore-secrets-$P"
    install -d -m 700 "$M"
    for f in "${DIFF[@]}"; do install -d -m 700 "$M/$(dirname "$f")"; mv "$RR/$f" "$M/$f"; done
    echo "replaced files kept in $M"
  fi
  # directories: the existing ones keep their mode and owner; new ones are made for the owner, mode 700
  # (the runtime's state dir 750, as provision.sh makes it)
  for f in "${FILES[@]}"; do
    d="$(dirname "$f")"
    parts=()
    while [ "$d" != . ] && [ ! -d "$RR/$d" ]; do parts=("$d" "${parts[@]}"); d="$(dirname "$d")"; done
    for d in "${parts[@]}"; do
      m=700; [ "$d" = var/lib/lineage/runtime ] && m=750
      case "$d" in var|var/lib|var/lib/lineage|etc|home|home/lineage) install -d -m 755 "$RR/$d" ;; *) install -d -m "$m" -o "$OWNER" -g "$OWNER" "$RR/$d" ;; esac
    done
    install -m "$(stat -c %a "$T/$f")" -o "$OWNER" -g "$OWNER" "$T/$f" "$RR/$f.restore-tmp" && mv "$RR/$f.restore-tmp" "$RR/$f"
  done
  [ ${#WAS[@]} -gt 0 ] && systemctl start "${WAS[@]}"
  echo "restored $P: ${#FILES[@]} files${RR:+ under $RR} for $OWNER (${#DIFF[@]} replaced)"
  ;;
monitor)
  unit_set "$(release_prefix "$(readlink -f "$BASE/current")")"
  systemctl start "$UP-monitor.service" || true
  jq -r '"monitor " + .worst + " at " + .at, (.checks[] | "  " + (.level | . + "    "[0:(5 - length)]) + .id + ": " + .msg)' /var/lib/lineage-monitor/state.json
  ;;
restore-test)
  # restores a snapshot into a scratch Core on 127.0.0.1:9669 (read-only chain bridge, no Core key) and
  # checks that it serves the snapshot's data; the live Core and its data are not touched
  F="${1:-$(ls -1t /var/lib/lineage/core-backups/core-*.tar.zst 2>/dev/null | head -1)}"
  [ -f "$F" ] || { echo "no snapshot" >&2; exit 1; }
  REL="$(readlink -f "$BASE/current")" D=/var/lib/lineage/restore-test PORT=9669
  [ -z "$(lsof -ti ":$PORT" 2>/dev/null)" ] || { echo "port $PORT is in use" >&2; exit 1; }
  systemctl stop units-restore-test 2>/dev/null || true
  rm -rf "$D"; install -d -m 0770 -o lineage-core -g lineage "$D"
  RC() { runuser -u lineage-core -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$D" bash -c "cd $D && $1"; }
  trap 'systemctl stop units-restore-test 2>/dev/null || true; systemctl reset-failed units-restore-test 2>/dev/null || true; rm -rf "$D"' EXIT
  RC "bash $REL/scripts/deploy/backup.sh verify '$F'"
  RC "bash $REL/scripts/deploy/backup.sh extract '$F' $D/data && tar -xOf <(zstd -q -d -c '$F') manifest.json > $D/manifest.json"
  jq 'del(.chain.core_authority_key) | .canaries_dir = "'"$D"'/no-canaries"' /etc/lineage-core/network.json > "$D/network.json"
  chown lineage-core:lineage-core "$D/network.json"; chmod 600 "$D/network.json"
  T0=$(date +%s)
  systemd-run -q --unit units-restore-test --uid=lineage-core --gid=lineage-core -p UMask=0007 -p WorkingDirectory="$REL" \
    -p Environment="HOME=$D LINEAGE_HOME=/home/lineage/.lineage BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*" \
    /usr/local/bin/bun packages/core/src/main.ts --data "$D/data" --port $PORT --host 127.0.0.1 --config "$D/network.json" \
      --admin-key /etc/lineage-core/admin.json --runtime-key /var/lib/lineage/site/runtime-authority.pub --canaries-dir "$D/no-canaries"
  ok=0; for i in $(seq 1 60); do curl -fsS -m 3 "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  if [ "$ok" = 1 ]; then
    # hidden=1: the stats count every agent row (hidden launches are left out of the default count)
    S="$(curl -fsS -m 10 "http://127.0.0.1:$PORT/v1/stats?hidden=1")"
    E="$(curl -fsS -m 10 "http://127.0.0.1:$PORT/v1/epochs/current" | jq .n)"
    pass=0 fail=0
    chk() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  ok   $1 $2"; else fail=$((fail + 1)); echo "  FAIL $1: restored Core $2, snapshot $3"; fi; }
    echo "restored Core up in $(( $(date +%s) - T0 )) s"
    chk lineages "$(echo "$S" | jq .lineages)" "$(jq .tables.lineages "$D/manifest.json")"
    chk agents "$(echo "$S" | jq .agents)" "$(jq .tables.agents "$D/manifest.json")"
    chk candidates "$(echo "$S" | jq .candidates)" "$(jq .tables.candidates "$D/manifest.json")"
    chk open_epoch "$E" "$(jq .open_epoch "$D/manifest.json")"
    L1="$(curl -fsS -m 10 "http://127.0.0.1:$PORT/v1/lineages" | jq -c '[.[].lineage_id] | sort')"
    L2="$(runuser -u lineage-core -- sqlite3 -readonly "$D/data/core.db" 'select lineage_id from lineages' | jq -R . | jq -sc 'sort')"
    chk lineage_ids "$(echo "$L1" | sha256sum | cut -c1-16)" "$(echo "$L2" | sha256sum | cut -c1-16)"
  else
    fail=1; echo "restored Core did not answer on $PORT"; journalctl -u units-restore-test -n 20 -o cat --no-pager
  fi
  echo "restore test $(basename "$F"): $([ "$fail" = 0 ] && echo PASS || echo FAIL) ($pass ok, $fail failed)"
  [ "$fail" = 0 ]
  ;;
restore)
  # replaces Core's live data with a snapshot (the replaced data is kept in /var/lib/lineage/backups)
  F="${1:-}"; [ -f "$F" ] || { echo "usage: remote.sh restore <snapshot.tar.zst>" >&2; exit 2; }
  REL="$(readlink -f "$BASE/current" 2>/dev/null || true)"
  if [ -z "$REL" ] || [ ! -d "$REL" ]; then
    # disaster recovery on a fresh server (deploy.sh restore-core before the first activate): place the
    # data only; the activate step that follows sets owners and modes (users_setup) and starts Core
    [ -f /var/lib/lineage/core/core.db ] && { echo "/var/lib/lineage/core/core.db exists and no release is active; refusing" >&2; exit 1; }
    backup_tools
    bash /root/lineage-deploy/backup.sh verify "$F"
    install -d -m 0770 /var/lib/lineage/core
    bash /root/lineage-deploy/backup.sh extract "$F" /var/lib/lineage/core/.restore
    mv /var/lib/lineage/core/.restore/core.db /var/lib/lineage/core/.restore/blobs /var/lib/lineage/core/ && rmdir /var/lib/lineage/core/.restore
    echo "placed $(basename "$F") in /var/lib/lineage/core (no release yet; deploy.sh <host> full activates it)"
    exit 0
  fi
  runuser -u lineage-core -- env -i PATH=/usr/local/bin:/usr/bin:/bin bash "$REL/scripts/deploy/backup.sh" verify "$F"
  unit_set "$(release_prefix "$REL")"
  systemctl stop "$UP-backup.timer" "$UP-runtime" $(all_authors) "${WORKER_UNITS[@]}" "${CORE_UNITS[@]}" 2>/dev/null || true
  M="/var/lib/lineage/backups/$(date -u +%Y%m%dT%H%M%SZ)-before-restore"
  install -d -o lineage -g lineage "$M"
  mv /var/lib/lineage/core/core.db* /var/lib/lineage/core/blobs "$M"/ 2>/dev/null || true
  install -d -m 0770 -o lineage-core -g lineage /var/lib/lineage/core/.restore
  runuser -u lineage-core -- env -i PATH=/usr/local/bin:/usr/bin:/bin bash "$REL/scripts/deploy/backup.sh" extract "$F" /var/lib/lineage/core/.restore
  mv /var/lib/lineage/core/.restore/core.db /var/lib/lineage/core/.restore/blobs /var/lib/lineage/core/ && rmdir /var/lib/lineage/core/.restore
  chown -R "$(core_user)":lineage /var/lib/lineage/core; chmod -R g+rwX /var/lib/lineage/core
  systemctl start "${CORE_UNITS[@]}" "$UP-backup.timer"
  [ "$DRY_RUN" = 1 ] || systemctl start "${WORKER_UNITS[@]}" $(optional_units)
  echo "restored $(basename "$F") (the replaced data is in $M)"
  ;;
wipe-keys)
  for p in /home/lineage/.config/lineage/devnet/{core-authority,faucet,runtime-authority}.json /home/lineage/.config/lineage/devnet/agent-*.json; do
    [ -f "$p" ] && { shred -u "$p" 2>/dev/null || rm -f "$p"; echo "removed $(basename "$p" .json)"; }
  done
  rm -f /home/lineage/.config/lineage/model.env /home/lineage/.config/lineage/rpc.env /home/lineage/.config/lineage/e2b.env /home/lineage/.config/lineage/providers.env
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
  # the service users' copies (users_setup): Core authority, faucet, keyed RPC and model key env files
  for p in /etc/lineage-core/core-authority.json /var/lib/lineage/web/.config/lineage/devnet/faucet.json; do
    [ -f "$p" ] && { shred -u "$p" 2>/dev/null || rm -f "$p"; echo "removed $p"; }
  done
  rm -f /etc/lineage/web.env /etc/lineage/indexer.env
  [ -f /etc/lineage-core/network.json ] && jq '.chain.rpc_url = "https://api.devnet.solana.com" | del(.chain.core_authority_key)' /etc/lineage-core/network.json > /etc/lineage-core/network.json.tmp && mv /etc/lineage-core/network.json.tmp /etc/lineage-core/network.json && chown lineage-core:lineage-core /etc/lineage-core/network.json && chmod 600 /etc/lineage-core/network.json
  echo "copied keys removed; the site's own keys stay in /home/lineage/.config/lineage/site"
  echo "the identity store /var/lib/lineage/identity and its key /etc/lineage-identity/master.key stay; delete both before destroying the box"
  ;;
*)
  echo "usage: remote.sh install|chain|activate <sha> | rollback [--with-data] | stop | start | status | backup | monitor | restore-test [snapshot] | restore <snapshot> | secrets-facts <part> | restore-secrets <part> [--replace] | wipe-keys" >&2
  exit 2
  ;;
esac
