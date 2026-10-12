#!/usr/bin/env bash
# units site, a second instance on the same server (docs/DEPLOY-SITE.md "Second instance (mainnet
# test)"): server-side steps, run as root by instance.sh over ssh. Never prints a secret. It touches
# nothing of the first instance except: the `units` account joins the group units-e2b (the shared E2B
# day budget; used by its runtime from its next restart), and /etc/caddy/Caddyfile gains the line
# importing /etc/caddy/sites.d when it does not have it yet.
#
#   remote-instance.sh <name> install <sha>   accounts, directories, the release (cloned from the shipped
#                                bundle into /opt/units-<tag>/releases/<sha>), bun install, recipe pins,
#                                the instance's own site keys, state + profile overlay + env files from
#                                what instance.sh sent, configs, unit files (installed, not enabled)
#   remote-instance.sh <name> activate <sha>  refuses without the chain state, the profile overlay, the
#                                keyed RPC and (outside the dry run) the Core authority key, or when the
#                                endpoint is not the instance's network or the programs are not there;
#                                then the Caddy site block, the release link and the units, each public
#                                one health-checked (on a failure the instance is stopped again)
#   remote-instance.sh <name> chain [plan]    register and bond the instance's verifiers (site-chain.ts);
#                                with plan nothing is sent
#                                Needs the staged release, state, overlay and RPC only: run it before activate.
#   remote-instance.sh <name> sweep plan | check | send <recipient>   what the site owner key and the verifier
#                                keys hold, back to the recipient (site-sweep.ts); bonds stay in the registry
#   remote-instance.sh <name> stop | start | status
#   remote-instance.sh <name> remove [--purge [--force]]   stop, remove the unit files and the Caddy site block;
#                                --purge also deletes its directories (keys included) and accounts, and is
#                                refused while those keys hold more than dust unless --force
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
NAME="${1:-}"; CMD="${2:-}"; shift 2 || true
case "$NAME" in
  mainnet) TAG=main; NETWORK=mainnet; OFF=100 ;;
  *) echo "unknown instance '$NAME' (known: mainnet)" >&2; exit 2 ;;
esac
P="units-$TAG"
BASE="/opt/$P"; STATE="/var/lib/$P"; ETC="/etc/$P"; ETCCORE="/etc/$P-core"; UHOME="/home/$P"
LH="$UHOME/.config/lineage"
PORT_CORE=$((9660 + OFF)); PORT_WEB=$((9661 + OFF)); PORT_GATE=$((9662 + OFF)); PORT_ID=$((9665 + OFF)); PORT_BIND=$((9667 + OFF)); PORT_IDX=$((9668 + OFF))
SHARED=/var/lib/units-shared/e2b-spend
ENVF="$ETC/site.env"
[ -f "$ENVF" ] && . "$ENVF"
DRY_RUN="${DRY_RUN:-0}"
UNITS_RECIPES="${UNITS_RECIPES:-fixture-b58,base58-py,minbpe}"
PUBLIC_UNITS=("$P-core" "$P-indexer" "$P-web" "$P-gate")
WORKER_UNITS=("$P-reference" "$P-verifier@v1" "$P-verifier@v2")
SERVICE_USERS=("$P-core" "$P-web" "$P-gate" "$P-indexer")
HEALTH_WAIT="${HEALTH_WAIT:-300}"

as_user() { runuser -u "$P" -- env -i HOME="$UHOME" USER="$P" UNITS_HOME="$UHOME/.lineage" PATH=/usr/local/bin:/usr/bin:/bin UNITS_INSTANCE="$NAME" UNITS_NETWORK="$NETWORK" UNITS_PROFILE_LOCAL="$ETC/profile.local.json" bash -c "$1"; }
env_line() { [ -f "$1" ] && sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*/$3=/p" "$1" | head -1 || true; }
have_rpc() { [ -f "$ETC/rpc.env" ] && grep -qE '^UNITS_MAINNET_RPC=.+' "$ETC/rpc.env"; }

users_dirs() {
  id units >/dev/null 2>&1 || { echo "no units account: provision the first instance first (deploy.sh <host> provision)" >&2; exit 1; }
  if ! id "$P" >/dev/null 2>&1; then adduser --disabled-password --gecos "" "$P" >/dev/null; fi
  if id -nG "$P" | tr ' ' '\n' | grep -qx -E 'sudo|admin'; then echo "$P is in a sudo group; refusing" >&2; exit 1; fi
  local u
  for u in "${SERVICE_USERS[@]}"; do
    id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group "$u"
    if id -nG "$u" | tr ' ' '\n' | grep -qx -E 'docker|sudo|admin|adm|systemd-journal|units|units-core'; then echo "$u is in a privileged or first-instance group ($(id -nG "$u")); refusing" >&2; exit 1; fi
  done
  # Core reads the workers' git mirrors and the private canaries through the instance's own group
  id -nG "$P-core" | tr ' ' '\n' | grep -qx "$P" || usermod -aG "$P" "$P-core"
  # only the instance's main account runs containers (sandboxes, the hosted runtime), as on the first instance
  if getent group docker >/dev/null; then id -nG "$P" | tr ' ' '\n' | grep -qx docker || usermod -aG docker "$P"; fi
  # the E2B day budget both runtimes share: one directory, each runtime writes its own file
  getent group units-e2b >/dev/null || groupadd --system units-e2b
  for u in units "$P"; do id -nG "$u" | tr ' ' '\n' | grep -qx units-e2b || { usermod -aG units-e2b "$u"; echo "$u joined units-e2b (its runtime uses the shared E2B budget from its next restart)"; }; done
  install -d -m 755 /var/lib/units-shared
  install -d -m 0770 -o root -g units-e2b "$SHARED"
  chmod 750 "$UHOME"
  install -d -m 700 -o "$P" -g "$P" "$UHOME/.config" "$LH" "$LH/$NETWORK" "$LH/site"
  install -d -m 755 -o "$P" -g "$P" "$BASE" "$BASE/releases"
  install -d -m 700 -o "$P" -g "$P" "$BASE/incoming"
  install -d -m 751 -o "$P" -g "$P" "$STATE"
  install -d -m 750 -o "$P" -g "$P" "$STATE/site" "$STATE/canaries" "$STATE/runtime"
  install -d -m 0770 -o "$P-core" -g "$P" "$STATE/core"
  install -d -m 0770 -o "$P-indexer" -g "$P" "$STATE/indexer"
  install -d -m 700 -o "$P-web" -g "$P-web" "$STATE/web" "$STATE/web/.lineage" "$STATE/web/.lineage/web"
  install -d -m 755 "$ETC"
  install -d -m 700 -o "$P-core" -g "$P-core" "$ETCCORE"
}

# what instance.sh sent into $BASE/incoming: the chain state, the profile overlay, the keyed RPC
place_incoming() {
  local IN="$BASE/incoming"
  if [ -f "$IN/state.json" ]; then install -m 644 "$IN/state.json" "$ETC/state.json"; rm -f "$IN/state.json"; echo "chain state placed ($ETC/state.json)"; fi
  if [ -f "$IN/profile.local.json" ]; then
    # the overlay names the state file every service of this instance reads
    jq --arg f "$ETC/state.json" --arg n "$NETWORK" '.profiles[$n].state_file = $f' "$IN/profile.local.json" > "$ETC/profile.local.json.tmp"
    chmod 644 "$ETC/profile.local.json.tmp"; mv "$ETC/profile.local.json.tmp" "$ETC/profile.local.json"; rm -f "$IN/profile.local.json"
    echo "profile overlay placed ($ETC/profile.local.json)"
  fi
  if [ -f "$IN/rpc.env" ]; then install -m 600 -o root -g root "$IN/rpc.env" "$ETC/rpc.env"; shred -u "$IN/rpc.env" 2>/dev/null || rm -f "$IN/rpc.env"; echo "keyed RPC placed ($ETC/rpc.env, mode 600, $(wc -c < "$ETC/rpc.env" | tr -d ' ') bytes)"; fi
}

# per-role env files, mode 600 root (systemd reads them): the keyed RPC only where a service needs it
role_envs() {
  ( umask 077
    if have_rpc; then
      grep -E '^UNITS_MAINNET_RPC=' "$ETC/rpc.env" | head -1 > "$ETC/core.env"
      cp "$ETC/core.env" "$ETC/indexer.env"; cp "$ETC/core.env" "$ETC/runtime.env"
      { cat "$ETC/core.env"; env_line "$LH/model.env" ANTHROPIC_API_KEY ANTHROPIC_API_KEY; env_line "$LH/providers.env" OPENROUTER_API_KEY OPENROUTER_API_KEY; } > "$ETC/web.env"
    else
      : > "$ETC/core.env"; : > "$ETC/indexer.env"; : > "$ETC/runtime.env"; : > "$ETC/web.env"
    fi
    # the dashboard's upstreams on this instance's ports (no identity service here: nothing listens on its port)
    printf 'UNITS_MARKET=http://127.0.0.1:%s\nUNITS_RUNTIME=http://127.0.0.1:%s\nUNITS_IDENTITY=http://127.0.0.1:%s\n' "$PORT_IDX" "$PORT_BIND" "$PORT_ID" >> "$ETC/web.env" )
  chmod 600 "$ETC"/core.env "$ETC"/indexer.env "$ETC"/runtime.env "$ETC"/web.env
  chown root:root "$ETC"/core.env "$ETC"/indexer.env "$ETC"/runtime.env "$ETC"/web.env
}

site_config() {
  local REL="$1"
  as_user "cd $REL && UNITS_SITE_CORE_KEY=$([ -f "$ETCCORE/core-authority.json" ] && echo "$ETCCORE/core-authority.json") bun scripts/deploy/site-config.ts --out $STATE/site"
  [ -f "$STATE/site/network.json" ] && install -m 600 -o "$P-core" -g "$P-core" "$STATE/site/network.json" "$ETCCORE/network.json"
  [ -f "$LH/site/admin.json" ] && install -m 600 -o "$P-core" -g "$P-core" "$LH/site/admin.json" "$ETCCORE/admin.json"
  chmod -R g+rX "$STATE/canaries" 2>/dev/null || true
}

install_units() {
  local REL="$1" T
  T="$(mktemp -d)"; chown "$P" "$T"
  as_user "cd $REL && bun scripts/deploy/instance.ts units $NAME $REL/scripts/deploy/systemd $T"
  install -m 644 "$T"/*.service /etc/systemd/system/
  rm -rf "$T"
  systemctl daemon-reload
}

health_url() {
  case "$1" in
    "$P-core") echo "http://127.0.0.1:$PORT_CORE/v1/health" ;;
    "$P-indexer") echo "http://127.0.0.1:$PORT_IDX/market/summary" ;;
    "$P-web") echo "http://127.0.0.1:$PORT_WEB/live/status" ;;
    "$P-gate") echo "http://127.0.0.1:$PORT_GATE/gate/health" ;;
  esac
}
restart_checked() {
  local u="$1" url code="" until
  systemctl restart --job-mode=ignore-dependencies "$u" || { echo "  $u: restart failed" >&2; return 1; }
  url="$(health_url "$u")"; until=$(( $(date +%s) + HEALTH_WAIT ))
  while [ "$(date +%s)" -lt "$until" ]; do
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [ "$u" = "$P-indexer" ] && [ -n "$code" ] && [ "$code" != 000 ]; then break; fi
    [ "$code" = 200 ] && break
    sleep 0.5
  done
  if { [ "$u" = "$P-indexer" ] && [ -n "$code" ] && [ "$code" != 000 ]; } || [ "$code" = 200 ]; then echo "  $u up"; return 0; fi
  echo "  $u did not answer $url within ${HEALTH_WAIT} s (last HTTP ${code:-none})" >&2
  journalctl -u "$u" -n 15 -o cat --no-pager 2>/dev/null | sed 's/^/    /' >&2 || true
  return 1
}
all_units() { echo "$P-runtime" "$P-bootstrap" "${WORKER_UNITS[@]}" "${PUBLIC_UNITS[@]}"; }
stop_all() { systemctl disable -q --now $(all_units) 2>/dev/null || true; }

# the instance's Caddy site block, beside the first instance's Caddyfile (never rewriting its site)
caddy_site() {
  local REL="$1" SITES="${SITE_NAMES:?no SITE_NAMES in $ENVF}" TLS="" F="/etc/caddy/sites.d/$P.caddy" IMPORT='import /etc/caddy/sites.d/*.caddy'
  [ -f /etc/caddy/Caddyfile ] || { echo "no /etc/caddy/Caddyfile: the first instance must be deployed first" >&2; return 1; }
  [ "$DRY_RUN" = 1 ] && TLS="	tls internal"
  install -d -m 755 /etc/caddy/sites.d
  [ -f "$F" ] && cp -p "$F" "$F.prev"
  as_user "cd $REL && bun scripts/deploy/instance.ts caddy $NAME $REL/scripts/deploy/caddy/Caddyfile.tmpl '$SITES' '$TLS'" > "$F.new"
  mv "$F.new" "$F"; chmod 644 "$F"
  cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-$P
  grep -qxF "$IMPORT" /etc/caddy/Caddyfile || { printf '\n# other instances on this server (scripts/deploy/instance.ts)\n%s\n' "$IMPORT" >> /etc/caddy/Caddyfile; echo "caddy: import line added to /etc/caddy/Caddyfile"; }
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -5 >&2 || true
    # back to what was there: the first instance's site must never be left with a config that does not load
    cp -p /etc/caddy/Caddyfile.pre-$P /etc/caddy/Caddyfile
    if [ -f "$F.prev" ]; then mv "$F.prev" "$F"; else rm -f "$F"; fi
    echo "caddy: the new configuration does not validate; restored the previous one" >&2
    return 1
  fi
  chown -R caddy:caddy /var/log/caddy 2>/dev/null || true
  systemctl reload caddy || { echo "caddy reload failed" >&2; return 1; }
  echo "caddy: site block for $SITES ($F)"
}

# the release the chain tools run from: the active one, else the newest staged
release_dir() {
  local rel; rel="$(readlink -f "$BASE/current" 2>/dev/null || true)"
  [ -d "$rel" ] || rel="$BASE/releases/$(ls -1t "$BASE/releases" 2>/dev/null | head -1)"
  [ -d "$rel/scripts" ] || { echo "no release of the $NAME instance: stage it first" >&2; exit 1; }
  echo "$rel"
}
# a chain tool as the instance's main account, with the keyed RPC from its root-only env file (never printed)
run_chain_tool() {
  systemd-run --wait --pipe -q --collect --uid="$P" --gid="$P" -p EnvironmentFile="$ETC/rpc.env" -p WorkingDirectory="$REL" \
    -E HOME="$UHOME" -E BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 -E UNITS_INSTANCE="$NAME" -E UNITS_NETWORK="$NETWORK" -E UNITS_PROFILE_LOCAL="$ETC/profile.local.json" \
    /usr/local/bin/bun "$@"
}

case "$CMD" in
install)
  SHA="$1"; REL="$BASE/releases/$SHA"
  users_dirs
  [ -f "$BASE/incoming/units.bundle" ] || { echo "no bundle at $BASE/incoming/units.bundle" >&2; exit 1; }
  chown "$P:$P" "$BASE/incoming/units.bundle"
  if [ ! -d "$REL/.git" ]; then
    as_user "git clone -q --no-checkout $BASE/incoming/units.bundle $REL && cd $REL && git -c advice.detachedHead=false checkout -q $SHA"
    echo "release $SHA cloned"
  else
    as_user "cd $REL && git checkout -q -- . && git -c advice.detachedHead=false checkout -q $SHA"
    echo "release $SHA present, tracked files reset"
  fi
  [ "$(as_user "cd $REL && git rev-parse HEAD")" = "$SHA" ] || { echo "checkout is not $SHA" >&2; exit 1; }
  as_user "cd $REL && bun install --frozen-lockfile >/dev/null 2>&1 || bun install --frozen-lockfile" && echo "bun install ok"
  if [ "$DRY_RUN" != 1 ]; then
    # the sandbox images are the first instance's (one Docker daemon): reused when their build inputs
    # are unchanged, built otherwise, exactly as remote.sh does; the recipes are then pinned to them
    for r in ${UNITS_RECIPES//,/ }; do
      y="$REL/recipes/$r/recipe.yml"
      [ -f "$y" ] || { echo "no recipe $r" >&2; exit 1; }
      ref=$(sed -n 's/^image:[[:space:]]*"\{0,1\}\([^"@[:space:]]*\)@sha256.*/\1/p' "$y")
      cls=$(sed -n 's/^class:[[:space:]]*\([a-z0-9]*\).*/\1/p' "$y")
      echo "$ref $cls"
    done | sort -u | while read -r ref cls; do
      h=$(cd "$REL/images/$cls" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)
      have=$(docker image inspect --format '{{ index .Config.Labels "lineage.build-hash" }}' "$ref" 2>/dev/null || true)
      if [ "$have" = "$h" ]; then echo "reusing $ref (build inputs unchanged)"
      else echo "building $ref from images/$cls"; as_user "cd $REL && docker build -q --label lineage.build-hash=$h -t $ref images/$cls >/dev/null"; fi
    done
    as_user "cd $REL && bun scripts/deploy/arch-recipes.ts $UNITS_RECIPES" | tail -n +1
  else
    echo "dry run: sandbox images and recipe re-pinning skipped (no Docker)"
  fi
  as_user "cd $REL && bun scripts/deploy/site-keys.ts init" > "$STATE/site/pubkeys.json"
  chown "$P:$P" "$STATE/site/pubkeys.json"
  place_incoming
  role_envs
  site_config "$REL"
  install_units "$REL"
  echo "staged: $SHA in $REL; units installed, none enabled or started"
  echo "PUBKEYS $(cat "$STATE/site/pubkeys.json")"
  ;;
activate)
  SHA="$1"; REL="$BASE/releases/$SHA"
  [ -d "$REL" ] || { echo "no release $SHA: stage it first (instance.sh <host> stage)" >&2; exit 1; }
  miss=()
  [ -s "$ETC/state.json" ] || miss+=("the chain state ($ETC/state.json, from scripts/mainnet/mainnet.json)")
  [ -s "$ETC/profile.local.json" ] || miss+=("the profile overlay ($ETC/profile.local.json, from scripts/mainnet/profile.local.json)")
  have_rpc || miss+=("the keyed RPC ($ETC/rpc.env, UNITS_MAINNET_RPC)")
  if [ "$DRY_RUN" != 1 ]; then [ -f "$ETCCORE/core-authority.json" ] || miss+=("the Core authority key ($ETCCORE/core-authority.json)"); fi
  if [ ${#miss[@]} -gt 0 ]; then
    echo "NOT ACTIVATED: the $NAME instance is missing:" >&2; printf '  %s\n' "${miss[@]}" >&2
    echo "it stays staged and stopped" >&2; exit 1
  fi
  place_incoming; role_envs
  site_config "$REL"
  [ -f "$ETCCORE/network.json" ] && [ -f "$ETCCORE/admin.json" ] || { echo "site-config wrote no Core config; not activated" >&2; exit 1; }
  # the endpoint is this instance's network and the programs and the quote mint are there (read only; the URL is never printed)
  if ! systemd-run --wait --pipe -q --collect --uid="$P" --gid="$P" -p EnvironmentFile="$ETC/rpc.env" -p WorkingDirectory="$REL" \
      -E HOME="$UHOME" -E BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 -E UNITS_NETWORK="$NETWORK" -E UNITS_PROFILE_LOCAL="$ETC/profile.local.json" \
      /usr/local/bin/bun scripts/deploy/instance-preflight.ts "$NAME"; then
    echo "NOT ACTIVATED: the chain preflight failed (above); the $NAME instance stays staged and stopped" >&2; exit 1
  fi
  # its ports must be free, or held by its own units (a re-activate)
  for port in $PORT_CORE $PORT_WEB $PORT_GATE $PORT_BIND $PORT_IDX; do
    for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
      cg="$(cat "/proc/$pid/cgroup" 2>/dev/null || true)"
      case "$cg" in *"/$P-"*) ;; *) echo "port $port is held by pid $pid, which is not a $P unit; not activated" >&2; exit 1 ;; esac
    done
  done
  install_units "$REL"
  caddy_site "$REL" || { echo "NOT ACTIVATED: Caddy (above)" >&2; exit 1; }
  ln -sfn "$REL" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  systemctl enable -q "${PUBLIC_UNITS[@]}"
  echo "public units (Core first, each health-checked):"
  for u in "${PUBLIC_UNITS[@]}"; do
    if ! restart_checked "$u"; then
      stop_all
      echo "ACTIVATE FAILED: $u did not come up; every $P unit is stopped again (the first instance was not touched)" >&2
      exit 1
    fi
  done
  if [ "$DRY_RUN" = 1 ]; then
    echo "dry run: $P-bootstrap, $P-reference, $P-verifier@v1, $P-verifier@v2, $P-runtime SKIPPED (sandbox units need Docker)"
  else
    systemctl enable -q "${WORKER_UNITS[@]}"
    systemctl restart --no-block "$P-bootstrap"
    systemctl restart --no-block "${WORKER_UNITS[@]}"
    if [ "${WITH_RUNTIME:-0}" = 1 ]; then systemctl enable -q "$P-runtime"; systemctl restart --no-block "$P-runtime"; echo "runtime queued ($P-runtime)"
    else systemctl disable -q --now "$P-runtime" 2>/dev/null || true; echo "runtime off (WITH_RUNTIME=1 turns it on)"; fi
  fi
  echo "active: $NAME instance on $SHA"
  ;;
chain)
  # register and bond the instance's verifiers (site-chain.ts) with its own owner key. `plan` reads the
  # chain and prints what it would send and what the owner key must hold; without it transactions are
  # sent on the instance's network.
  # Needs only what `install` (stage) leaves: the release, the chain state, the overlay, the keyed RPC and
  # the site keys. Core does not have to run, so it comes before `activate`.
  REL="$(release_dir)"
  have_rpc || { echo "no keyed RPC ($ETC/rpc.env): stage again once UNITS_MAINNET_RPC is set on the owner's machine" >&2; exit 1; }
  [ -s "$ETC/state.json" ] && [ -s "$ETC/profile.local.json" ] || { echo "no chain state or profile overlay yet ($ETC): stage again once the programs are deployed and initialized" >&2; exit 1; }
  run_chain_tool scripts/deploy/site-chain.ts --caps "$STATE/site/caps.json" ${1:+--plan}
  ;;
sweep)
  # what the keys that live only here still hold (the site owner key and its verifiers), back to a recipient
  # (site-sweep.ts): `sweep plan` and `sweep check` read only, `sweep send <recipient>` sends
  REL="$(release_dir)"
  have_rpc || { echo "no keyed RPC ($ETC/rpc.env)" >&2; exit 1; }
  case "${1:-}" in
    plan) ARGS=(--plan) ;;
    check) ARGS=(--check) ;;
    send) [ -n "${2:-}" ] || { echo "sweep send <recipient address>" >&2; exit 2; }; ARGS=(--to "$2") ;;
    *) echo "sweep plan | check | send <recipient address>" >&2; exit 2 ;;
  esac
  run_chain_tool scripts/deploy/site-sweep.ts "${ARGS[@]}"
  ;;
stop)
  stop_all
  echo "stopped: every $P unit (disabled; Caddy and the first instance keep running)"
  ;;
start)
  [ -L "$BASE/current" ] || { echo "the $NAME instance was never activated" >&2; exit 1; }
  systemctl enable -q --now "${PUBLIC_UNITS[@]}"
  if [ "$DRY_RUN" != 1 ]; then
    systemctl enable -q --now "${WORKER_UNITS[@]}"
    [ "${WITH_RUNTIME:-0}" = 1 ] && systemctl enable -q --now "$P-runtime"
  fi
  echo "started"
  ;;
status)
  echo "instance  $NAME ($P, $NETWORK)"
  echo "release   $(basename "$(readlink "$BASE/current" 2>/dev/null || echo "none (staged: $(ls -1 "$BASE/releases" 2>/dev/null | paste -sd' ' - || true))")")"
  for u in "${PUBLIC_UNITS[@]}" "$P-bootstrap" "${WORKER_UNITS[@]}" "$P-runtime"; do
    st=$(systemctl is-active "$u" 2>/dev/null || true); en=$(systemctl is-enabled "$u" 2>/dev/null || true)
    printf '%-28s %-10s %s\n' "$u" "${st:-unknown}" "${en:-}"
  done
  echo "ports     core $PORT_CORE, web $PORT_WEB, gate $PORT_GATE, runtime bind $PORT_BIND, indexer $PORT_IDX"
  echo "site      ${SITE_NAMES:-not set}"
  echo "state     $([ -s "$ETC/state.json" ] && echo present || echo missing), overlay $([ -s "$ETC/profile.local.json" ] && echo present || echo missing), rpc $(have_rpc && echo present || echo missing), Core authority key $([ -f "$ETCCORE/core-authority.json" ] && echo present || echo missing), runtime authority key $([ -f "$LH/$NETWORK/runtime-authority.json" ] && echo present || echo missing)"
  h="$(curl -s -m 5 "http://127.0.0.1:$PORT_CORE/v1/health" 2>/dev/null || true)"; echo "core      ${h:-not answering}"
  for f in "$SHARED"/*.json; do if [ -f "$f" ]; then echo "e2b       $(basename "$f" .json): $(jq -c '{day, usd}' "$f" 2>/dev/null || echo unreadable)"; fi; done
  ;;
remove)
  if [ "${1:-}" = "--purge" ] && [ "${2:-}" != "--force" ] && [ -f "$LH/site/owner.json" ] && have_rpc && [ -s "$ETC/state.json" ] && [ -s "$ETC/profile.local.json" ]; then
    # --purge deletes the site owner key and the verifier keys: refuse while they still hold funds
    REL="$(release_dir)"; rc=0
    run_chain_tool scripts/deploy/site-sweep.ts --check || rc=$?
    if [ "$rc" != 0 ]; then
      echo "NOT PURGED: $([ "$rc" = 1 ] && echo "keys on this server still hold funds (above)" || echo "the keys' balances could not be read"). Sweep first (deploy.sh <host> sweep <recipient>), or remove --purge --force to delete the keys anyway" >&2
      exit 1
    fi
  fi
  stop_all
  for f in /etc/systemd/system/$P-*.service; do [ -f "$f" ] && rm -f "$f"; done
  systemctl daemon-reload
  if [ -f "/etc/caddy/sites.d/$P.caddy" ]; then
    rm -f "/etc/caddy/sites.d/$P.caddy" "/etc/caddy/sites.d/$P.caddy.prev"
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy || echo "caddy: check /etc/caddy/Caddyfile by hand" >&2
  fi
  rm -f "$SHARED/$NAME.json"
  echo "removed: the $P units and its Caddy site block"
  if [ "${1:-}" = "--purge" ]; then
    for p in "$ETCCORE/core-authority.json" "$LH/$NETWORK/runtime-authority.json"; do [ -f "$p" ] && { shred -u "$p" 2>/dev/null || rm -f "$p"; }; done
    rm -rf "$BASE" "$STATE" "$ETC" "$ETCCORE"
    for u in "${SERVICE_USERS[@]}"; do id "$u" >/dev/null 2>&1 && userdel "$u" 2>/dev/null || true; done
    id "$P" >/dev/null 2>&1 && userdel -r "$P" 2>/dev/null || true
    echo "purged: $BASE, $STATE, $ETC, $ETCCORE, $UHOME and the $P accounts (keys shredded)"
  else
    echo "kept: $BASE, $STATE, $ETC, $ETCCORE, $UHOME (remove --purge deletes them and the accounts)"
  fi
  ;;
*)
  echo "usage: remote-instance.sh <name> install <sha> | activate <sha> | chain [plan] | sweep plan|check|send <recipient> | stop | start | status | remove [--purge [--force]]" >&2
  exit 2
  ;;
esac
