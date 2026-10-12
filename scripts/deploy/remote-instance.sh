#!/usr/bin/env bash
# units site, a second instance on the same server (docs/DEPLOY-SITE.md "Second instance (mainnet
# test)"): server-side steps, run as root by instance.sh over ssh. Never prints a secret. It touches
# nothing of the first instance except: the `units` account joins the group units-e2b (the shared E2B
# day budget; used by its runtime from its next restart), and /etc/caddy/Caddyfile gains the line
# importing /etc/caddy/sites.d when it does not have it yet.
# WITH_IDENTITY=1 in /etc/units-<tag>/site.env (default 0) adds the instance's own GitHub identity
# service: account units-<tag>-identity, store /var/lib/units-<tag>/identity, key directory
# /etc/units-<tag>-identity, port 9665 + offset, the /identity/* route in the instance's Caddy block.
# No GitHub account is ever placed by install or activate: the reserve starts empty (identity-pool).
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
#   remote-instance.sh <name> activate-staged [local head sha]   go-live: activate on the release that is
#                                already staged (the last `install`, else the current one). No bundle, no bun
#                                install, no image work. First moves /etc/units-<tag>/next/{state.json,
#                                profile.local.json,sizing.json} into place when they are there (refused while
#                                units of the instance run, unless GO_SWITCH_RUNNING=yes), then everything
#                                `activate` does, with every refusal it has; prints the time of each phase.
#                                GO_SWITCH_RUNNING=yes stops the runtime, the indexer and Core (in that order)
#                                first; GO_BACKUP_CORE=<label> then copies Core's stopped database to
#                                archive/<label>/core-backup; GO_ARCHIVE_INDEXER=<label> moves the indexer's
#                                database to archive/<label>/indexer and leaves it empty. Start order: Core,
#                                indexer, (identity,) web, gate, then the background units.
#   remote-instance.sh <name> place-next      what instance.sh sent as the NEXT deployment's chain state, overlay
#                                and sizing goes to /etc/units-<tag>/next/ (no running unit reads that directory)
#   remote-instance.sh <name> chain [plan]    register and bond the instance's verifiers (site-chain.ts);
#                                with plan nothing is sent. With a next/ state and overlay it works on THOSE
#                                (the registry the instance is about to switch to), the live files untouched.
#                                Needs the staged release, state, overlay and RPC only: run it before activate.
#   remote-instance.sh <name> sweep plan | check | send <recipient>   what the site owner key and the verifier
#                                keys hold, back to the recipient (site-sweep.ts); bonds stay in the registry
#   remote-instance.sh <name> stop | start | status
#   remote-instance.sh <name> identity-pool           WITH_IDENTITY=1 only: {"login","token"} JSON lines on stdin
#                                into the identity service's encrypted reserve (main.ts reserve-add; logins
#                                printed, never a token). Run by nothing else: scripts/identity/ship-pool.ts
#                                sends it, after writing the owner's ledger.
#   remote-instance.sh <name> identity-pool-list      WITH_IDENTITY=1 only, read only: logins, statuses and
#                                assignments of the reserve (no tokens)
#   remote-instance.sh <name> archive-state <label> [--only core,indexer,runtime]   every unit of the instance
#                                must be stopped: moves the deployment's state (all three parts, or the ones named;
#                                with --only the label may exist when it does not hold that part yet) into
#                                /var/lib/units-<tag>/archive/<label>/ and leaves them empty with their owners
#                                and modes; copies state.json, profile.local.json and the configs made from
#                                them. Keeps site keys, caps.json, canaries, releases, env files.
#   remote-instance.sh <name> restore-state <label>   the reverse, for the parts the label holds: the current ones go to
#                                archive/pre-restore-<utc time> first, then the archived one comes back
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
WITH_IDENTITY="${WITH_IDENTITY:-0}"
UNITS_RECIPES="${UNITS_RECIPES:-fixture-b58,base58-py,minbpe}"
PUBLIC_UNITS=("$P-core" "$P-indexer" "$P-web" "$P-gate")
# the GitHub identity service (WITH_IDENTITY=1): started and health-checked after the indexer, as on the first instance
IDU="$P-identity"; ID_STORE="$STATE/identity"; ID_ETC="/etc/$P-identity"; ID_TIMER="$P-identity-cycle.timer"
[ "$WITH_IDENTITY" = 1 ] && PUBLIC_UNITS=("$P-core" "$P-indexer" "$IDU" "$P-web" "$P-gate")
# what belongs to one deployment (program ids, quote mint) and is moved by archive-state: Core's database,
# the indexer's, the hosted runtime's state (agent keys, attempts, bind requests)
DEPLOYMENT_DIRS=(core indexer runtime)
WORKER_UNITS=("$P-reference" "$P-verifier@v1" "$P-verifier@v2")
SERVICE_USERS=("$P-core" "$P-web" "$P-gate" "$P-indexer")
HEALTH_WAIT="${HEALTH_WAIT:-300}"

as_user() { runuser -u "$P" -- env -i HOME="$UHOME" USER="$P" UNITS_HOME="$UHOME/.lineage" PATH=/usr/local/bin:/usr/bin:/bin UNITS_INSTANCE="$NAME" UNITS_NETWORK="$NETWORK" UNITS_PROFILE_LOCAL="$ETC/profile.local.json" bash -c "$1"; }
env_line() { [ -f "$1" ] && sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*/$3=/p" "$1" | head -1 || true; }
have_rpc() { [ -f "$ETC/rpc.env" ] && grep -qE '^UNITS_MAINNET_RPC=.+' "$ETC/rpc.env"; }

# one deployment state directory with the owner and mode its service needs (users_dirs, archive-state)
mk_state_dir() {
  case "$1" in
    core) install -d -m 0770 -o "$P-core" -g "$P" "$STATE/core" ;;
    indexer) install -d -m 0770 -o "$P-indexer" -g "$P" "$STATE/indexer" ;;
    runtime) install -d -m 750 -o "$P" -g "$P" "$STATE/runtime" ;;
    *) echo "mk_state_dir: unknown directory $1" >&2; return 1 ;;
  esac
}
# archives hold the old deployment's hosted agent keys: root only
mk_archive_root() { install -d -m 700 -o root -g root "$STATE/archive"; }
# every loaded unit of this instance that is not stopped (running, starting, or still draining)
active_units() {
  systemctl list-units --all --plain --no-legend "$P-*" 2>/dev/null | awk '$3 != "inactive" && $3 != "failed" { print $1 "(" $3 ")" }'
}

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
  install -d -m 750 -o "$P" -g "$P" "$STATE/site" "$STATE/canaries"
  local d
  for d in "${DEPLOYMENT_DIRS[@]}"; do mk_state_dir "$d"; done
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

# The NEXT deployment's files (a switch of program ids or quote mint, prepared while the current
# deployment still runs): they wait in $ETC/next. Every unit reads $ETC/state.json and the overlay at
# each start, and units restart by themselves (Restart=always, a reboot), so the live files are never
# replaced under a deployment that may still start: a unit coming up on the new program ids with the
# old database would be wrong. `chain` reads next/ through its own environment; `activate-staged` moves
# next/ into place.
# >>> next-deployment (instance.test.ts runs this block in a temporary directory)
NEXT="$ETC/next"
have_next() { [ -s "$NEXT/state.json" ] && [ -s "$NEXT/profile.local.json" ]; }
place_next() {
  local IN="$BASE/incoming" got=0
  install -d -m 755 "$NEXT"
  if [ -f "$IN/next.state.json" ]; then
    jq -e 'type == "object"' "$IN/next.state.json" >/dev/null || { echo "the next chain state is not a JSON object; not placed" >&2; return 1; }
    install -m 644 "$IN/next.state.json" "$NEXT/state.json.new"; mv -f "$NEXT/state.json.new" "$NEXT/state.json"; mv -f "$IN/next.state.json" "$IN/placed.state.json"; got=1
    echo "next chain state placed ($NEXT/state.json, $(wc -c < "$NEXT/state.json" | tr -d ' ') bytes)"
  fi
  if [ -f "$IN/next.profile.local.json" ]; then
    # while it waits, the overlay names the state file beside it (what the chain tool reads)
    jq --arg f "$NEXT/state.json" --arg n "$NETWORK" '.profiles[$n].state_file = $f' "$IN/next.profile.local.json" > "$NEXT/profile.local.json.new"
    chmod 644 "$NEXT/profile.local.json.new"; mv -f "$NEXT/profile.local.json.new" "$NEXT/profile.local.json"; mv -f "$IN/next.profile.local.json" "$IN/placed.profile.local.json"; got=1
    echo "next profile overlay placed ($NEXT/profile.local.json)"
  fi
  if [ -f "$IN/next.sizing.json" ]; then
    jq -e 'type == "object"' "$IN/next.sizing.json" >/dev/null || { echo "the sizing file is not a JSON object; not placed" >&2; return 1; }
    install -m 644 "$IN/next.sizing.json" "$NEXT/sizing.json.new"; mv -f "$NEXT/sizing.json.new" "$NEXT/sizing.json"; mv -f "$IN/next.sizing.json" "$IN/placed.sizing.json"; got=1
    echo "next sizing placed ($NEXT/sizing.json)"
  fi
  [ "$got" = 1 ] || echo "nothing new was sent for $NEXT"
}
# next/ into place (activate-staged): the previous files are kept beside them as *.prev, and come back
# (rollback_next) when the activation does not complete; the waiting files leave next/ only once it did
# (finish_next), so a failed go can simply be run again.
PROMOTED=0; PREV_STATE=0; PREV_PROFILE=0
# what would refuse promote_next, without changing anything
promote_check() {
  if [ -s "$NEXT/state.json" ] || [ -s "$NEXT/profile.local.json" ]; then
    have_next || { echo "REFUSED: $NEXT holds only one of state.json and profile.local.json; both belong to one deployment" >&2; return 1; }
    local up; up="$(active_units | paste -sd' ' -)"
    if [ -n "$up" ] && [ "${GO_SWITCH_RUNNING:-}" != yes ]; then
      echo "REFUSED: the next deployment's state would replace the live one while units of the $NAME instance run: $up" >&2
      echo "stop it first (instance.sh <host> stop; a fresh database: archive-state <label>), or GO_SWITCH_RUNNING=yes when Core keeps its database across the switch" >&2
      return 1
    fi
  fi
}
promote_next() {
  [ -s "$NEXT/state.json" ] || [ -s "$NEXT/profile.local.json" ] || [ -s "$NEXT/sizing.json" ] || { echo "next: nothing waiting in $NEXT; the files in $ETC are used as they are"; return 0; }
  promote_check || return 1
  if [ -s "$NEXT/state.json" ] || [ -s "$NEXT/profile.local.json" ]; then
    if [ -f "$ETC/state.json" ]; then cp -p "$ETC/state.json" "$ETC/state.json.prev"; PREV_STATE=1; fi
    if [ -f "$ETC/profile.local.json" ]; then cp -p "$ETC/profile.local.json" "$ETC/profile.local.json.prev"; PREV_PROFILE=1; fi
    jq --arg f "$ETC/state.json" --arg n "$NETWORK" '.profiles[$n].state_file = $f' "$NEXT/profile.local.json" > "$ETC/profile.local.json.new"
    chmod 644 "$ETC/profile.local.json.new"
    install -m 644 "$NEXT/state.json" "$ETC/state.json.new"
    mv -f "$ETC/state.json.new" "$ETC/state.json"
    mv -f "$ETC/profile.local.json.new" "$ETC/profile.local.json"
    PROMOTED=1
    echo "next: chain state and profile overlay placed in $ETC (the previous ones are *.prev)"
  fi
  if [ -s "$NEXT/sizing.json" ]; then
    [ -f "$ETC/sizing.json" ] && cp -p "$ETC/sizing.json" "$ETC/sizing.json.prev"
    mv -f "$NEXT/sizing.json" "$ETC/sizing.json"; echo "next: sizing moved into $ETC/sizing.json"
  fi
}
# the activation completed: nothing waits any more (chain reads the live files again)
finish_next() {
  [ "$PROMOTED" = 1 ] || return 0
  mv -f "$NEXT/state.json" "$NEXT/state.json.placed"
  mv -f "$NEXT/profile.local.json" "$NEXT/profile.local.json.placed"
  PROMOTED=0
}
# the activation did not complete: the files the instance had are live again
rollback_next() {
  [ "$PROMOTED" = 1 ] || return 0
  if [ "$PREV_STATE" = 1 ]; then cp -p "$ETC/state.json.prev" "$ETC/state.json"; fi
  if [ "$PREV_PROFILE" = 1 ]; then cp -p "$ETC/profile.local.json.prev" "$ETC/profile.local.json"; fi
  PROMOTED=0
  if [ "$PREV_STATE" = 1 ] && [ "$PREV_PROFILE" = 1 ]; then echo "next: not activated, so the previous chain state and overlay are back in $ETC; the next ones still wait in $NEXT" >&2
  else echo "next: not activated; $ETC had no earlier chain state to put back, the next one stays placed and still waits in $NEXT" >&2; fi
}
# <<< next-deployment
now_ms() { date +%s%3N; }
# activate-staged only: how long the phase since the last mark took
phase() {
  if [ "$CMD" = activate-staged ]; then
    local t; t="$(now_ms)"
    printf 'time      %-28s %5d.%03d s\n' "$1" $(( (t - T_PHASE) / 1000 )) $(( (t - T_PHASE) % 1000 ))
    T_PHASE="$t"
  fi
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
  # the identity service's launch watcher reads the chain: the keyed RPC the same way, only with the flag
  if [ "$WITH_IDENTITY" = 1 ]; then
    ( umask 077; if have_rpc; then grep -E '^UNITS_MAINNET_RPC=' "$ETC/rpc.env" | head -1 > "$ETC/identity.env"; else : > "$ETC/identity.env"; fi )
    chmod 600 "$ETC/identity.env"; chown root:root "$ETC/identity.env"
  elif [ -f "$ETC/identity.env" ]; then
    : > "$ETC/identity.env"   # the flag is off: the file stays (root, 600) without the endpoint
  fi
}

# The instance's own GitHub identity service (WITH_IDENTITY=1; packages/identity, docs/DEPLOY-SITE.md
# "GitHub identity service"), as remote.sh identity_setup does it for the first instance: a dedicated
# account in no privileged or instance group, its encrypted store (mode 700) and a key file made once
# on this server and never copied anywhere, the Core key it records with. Idempotent. It places no
# GitHub account: the reserve is empty until the owner ships one (identity-pool).
identity_setup() {
  local REL="$1"
  if ! id "$IDU" >/dev/null 2>&1; then
    useradd --system --home-dir "$ID_STORE/home" --no-create-home --shell /usr/sbin/nologin --user-group "$IDU"
  fi
  if id -nG "$IDU" | tr ' ' '\n' | grep -qx -E "docker|sudo|admin|adm|systemd-journal|units|units-core|units-identity|$P|$P-core"; then echo "$IDU is in a privileged or instance group ($(id -nG "$IDU")); refusing" >&2; exit 1; fi
  # $STATE is mode 751 (users_dirs): traverse only for this account, every directory under it keeps its own mode
  install -d -m 700 -o "$IDU" -g "$IDU" "$ID_STORE" "$ID_STORE/home" "$ID_ETC"
  # Core accepts GitHub records from its runtime or admin key; the instance's admin key is the one on this box
  local ck="$LH/site/admin.json"
  if [ -f "$ck" ] && ! cmp -s "$ck" "$ID_ETC/core-key.json"; then
    install -m 600 -o "$IDU" -g "$IDU" "$ck" "$ID_ETC/core-key.json"
  fi
  runuser -u "$IDU" -- env -i UNITS_NETWORK="$NETWORK" UNITS_PROFILE_LOCAL="$ETC/profile.local.json" HOME="$ID_STORE/home" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/local/bin/bun "$REL/packages/identity/src/main.ts" init --dir "$ID_STORE" --key "$ID_ETC/master.key"
}
# an identity service command as its own account, with the keyed RPC from the root-only env file (main.ts
# resolves the mainnet endpoint for every command but init); stdin passes through, tokens are never printed
run_identity_tool() {
  systemd-run --wait --pipe -q --collect --uid="$IDU" --gid="$IDU" -p EnvironmentFile="$ETC/identity.env" -p WorkingDirectory="$REL" -p UMask=0077 \
    -E HOME="$ID_STORE/home" -E BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 -E UNITS_INSTANCE="$NAME" -E UNITS_NETWORK="$NETWORK" -E UNITS_PROFILE_LOCAL="$ETC/profile.local.json" \
    -E UNITS_IDENTITY_DIR="$ID_STORE" -E UNITS_IDENTITY_KEY="$ID_ETC/master.key" -E UNITS_IDENTITY_RUN="$ID_STORE/home/run-tool" -E UNITS_CORE="http://127.0.0.1:$PORT_CORE" \
    /usr/local/bin/bun packages/identity/src/main.ts "$@"
}
identity_ready() {
  [ "$WITH_IDENTITY" = 1 ] || { echo "the $NAME instance does not run the identity service (WITH_IDENTITY=1 on stage or activate turns it on)" >&2; return 1; }
  [ -f "$ID_ETC/master.key" ] && id "$IDU" >/dev/null 2>&1 || { echo "the identity service of the $NAME instance is not set up yet: stage with WITH_IDENTITY=1 first" >&2; return 1; }
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
  as_user "cd $REL && bun scripts/deploy/instance.ts units $NAME $REL/scripts/deploy/systemd $T$([ "$WITH_IDENTITY" = 1 ] && echo ' --identity')"
  install -m 644 "$T"/*.service /etc/systemd/system/
  if [ "$WITH_IDENTITY" = 1 ]; then install -m 644 "$T"/*.timer /etc/systemd/system/
  elif [ -f "/etc/systemd/system/$IDU.service" ]; then
    # the flag was turned off: its units are stopped, disabled and masked out of the way by name (the
    # files are kept as *.off, so nothing starts them; the store, the key file and the account stay)
    systemctl disable -q --now "$ID_TIMER" "$IDU-cycle" "$IDU" 2>/dev/null || true
    local uf
    for uf in "$IDU.service" "$IDU-cycle.service" "$ID_TIMER"; do
      if [ -f "/etc/systemd/system/$uf" ]; then mv -f "/etc/systemd/system/$uf" "/etc/systemd/system/$uf.off"; fi
    done
    echo "identity service off: its units are stopped and set aside (store $ID_STORE and key $ID_ETC kept)"
  fi
  rm -rf "$T"
  systemctl daemon-reload
}

health_url() {
  case "$1" in
    "$P-core") echo "http://127.0.0.1:$PORT_CORE/v1/health" ;;
    "$P-indexer") echo "http://127.0.0.1:$PORT_IDX/market/summary" ;;
    "$P-web") echo "http://127.0.0.1:$PORT_WEB/live/status" ;;
    "$P-gate") echo "http://127.0.0.1:$PORT_GATE/gate/health" ;;
    "$IDU") echo "http://127.0.0.1:$PORT_ID/identity/health" ;;
  esac
}
restart_checked() {
  local u="$1" url code="" until t0
  t0="$(now_ms)"
  systemctl restart --job-mode=ignore-dependencies "$u" || { echo "  $u: restart failed" >&2; return 1; }
  url="$(health_url "$u")"; until=$(( $(date +%s) + HEALTH_WAIT ))
  while [ "$(date +%s)" -lt "$until" ]; do
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [ "$u" = "$P-indexer" ] && [ -n "$code" ] && [ "$code" != 000 ]; then break; fi
    [ "$code" = 200 ] && break
    sleep 0.5
  done
  if { [ "$u" = "$P-indexer" ] && [ -n "$code" ] && [ "$code" != 000 ]; } || [ "$code" = 200 ]; then
    if [ "$CMD" = activate-staged ]; then echo "  $u up ($(( ($(now_ms) - t0) / 1000 )).$(printf '%03d' $(( ($(now_ms) - t0) % 1000 ))) s)"; else echo "  $u up"; fi
    return 0
  fi
  echo "  $u did not answer $url within ${HEALTH_WAIT} s (last HTTP ${code:-none})" >&2
  journalctl -u "$u" -n 15 -o cat --no-pager 2>/dev/null | sed 's/^/    /' >&2 || true
  return 1
}
# the identity units whenever their files are installed (also right after the flag was turned off)
identity_units() { if [ -f "/etc/systemd/system/$IDU.service" ]; then echo "$ID_TIMER" "$IDU-cycle" "$IDU"; fi; }
all_units() { echo $(identity_units) "$P-runtime" "$P-bootstrap" "${WORKER_UNITS[@]}" "$P-core" "$P-indexer" "$P-web" "$P-gate"; }
stop_all() { systemctl disable -q --now $(all_units) 2>/dev/null || true; }

# the instance's Caddy site block, beside the first instance's Caddyfile (never rewriting its site)
caddy_site() {
  local REL="$1" SITES="${SITE_NAMES:?no SITE_NAMES in $ENVF}" TLS="" F="/etc/caddy/sites.d/$P.caddy" IMPORT='import /etc/caddy/sites.d/*.caddy'
  [ -f /etc/caddy/Caddyfile ] || { echo "no /etc/caddy/Caddyfile: the first instance must be deployed first" >&2; return 1; }
  [ "$DRY_RUN" = 1 ] && TLS="	tls internal"
  install -d -m 755 /etc/caddy/sites.d
  [ -f "$F" ] && cp -p "$F" "$F.prev"
  as_user "cd $REL && bun scripts/deploy/instance.ts caddy $NAME $REL/scripts/deploy/caddy/Caddyfile.tmpl '$SITES' '$TLS'$([ "$WITH_IDENTITY" = 1 ] && echo ' --identity')" > "$F.new"
  mv "$F.new" "$F"; chmod 644 "$F"
  # a password on the whole site until the owner opens it (owner 2026-10-12): when
  # /etc/$P/site-auth.caddy exists (a basic_auth block with a hashed password), every request needs it.
  # Remove that file and deploy (or run this mode) again to open the site.
  if [ -f "/etc/$P/site-auth.caddy" ]; then
    sed -i "0,/{[[:space:]]*\$/s##{\n\timport /etc/$P/site-auth.caddy#" "$F"
    echo "caddy: the site asks for the password of /etc/$P/site-auth.caddy"
  fi
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
# the release activate-staged runs: the last one `install` staged, else release_dir's
staged_release() {
  local s; s="$(cat "$BASE/staged" 2>/dev/null || true)"
  if [ -n "$s" ] && [ -d "$BASE/releases/$s/scripts" ]; then echo "$BASE/releases/$s"; else release_dir; fi
}
# a chain tool as the instance's main account, with the keyed RPC from its root-only env file (never printed).
# CHAIN_STATE and CHAIN_PROFILE name another deployment's files (next/); unset: the live ones.
run_chain_tool() {
  local extra=()
  [ -n "${CHAIN_STATE:-}" ] && extra=(-E UNITS_INSTANCE_STATE="$CHAIN_STATE")
  systemd-run --wait --pipe -q --collect --uid="$P" --gid="$P" -p EnvironmentFile="$ETC/rpc.env" -p WorkingDirectory="$REL" \
    -E HOME="$UHOME" -E BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 -E UNITS_INSTANCE="$NAME" -E UNITS_NETWORK="$NETWORK" -E UNITS_PROFILE_LOCAL="${CHAIN_PROFILE:-$ETC/profile.local.json}" \
    ${extra[@]+"${extra[@]}"} /usr/local/bin/bun "$@"
}

# >>> state-archive (instance.test.ts runs this block in a temporary directory with the helpers stubbed)
# A deployment switch (new program ids or quote mint) starts from empty Core, indexer and runtime state.
# Moved: DEPLOYMENT_DIRS. Copied: the chain state, the profile overlay and the configs site-config.ts
# made from them. Not touched: site keys, caps.json, canaries, releases, env files, the workers' home
# (git mirrors and dependency layers are caches by content; a worker drops local results its Core no
# longer lists as open on its first pass), the web server's draft log, the identity store (its reserve
# and publisher belong to no deployment; its per-agent records are keyed by agent id).
# Nothing here deletes: every step is a move or a copy inside $STATE/archive.
ARCHIVE_ETC=(state.json profile.local.json)
dir_size() { du -sh "$1" 2>/dev/null | cut -f1; }
label_ok() { [[ "$1" =~ ^[a-z0-9-]{1,40}$ ]]; }
derived_files() { echo "$ETCCORE/network.json" "$STATE/site/network.json" "$STATE/site/runtime.json"; }
derived_name() { echo "${1#/}" | tr '/' '_'; }
require_stopped() {
  local up; up="$(active_units | paste -sd' ' -)"
  if [ -n "$up" ]; then
    echo "REFUSED: units of the $NAME instance are not stopped: $up" >&2
    echo "stop it first (instance.sh <host> stop) and wait until the workers have drained" >&2
    return 1
  fi
}
# the parts a label holds (a Core backup made by activate-staged counts as its core part)
label_parts() {
  local D="$STATE/archive/$1" d
  for d in "${DEPLOYMENT_DIRS[@]}"; do
    if [ -d "$D/$d" ] || { [ "$d" = core ] && [ -d "$D/core-backup" ]; }; then echo "$d"; fi
  done
}
holds_part() { label_parts "$1" | grep -qx "$2"; }
# "core,indexer" -> one part per line; fails on a name that is not a deployment directory
parts_of() {
  local p arr
  IFS=',' read -r -a arr <<< "$1"
  [ ${#arr[@]} -gt 0 ] || return 1
  for p in "${arr[@]}"; do
    case " ${DEPLOYMENT_DIRS[*]} " in *" $p "*) echo "$p" ;; *) return 1 ;; esac
  done
}
# whether one unit of the instance is stopped (core, indexer, runtime, ...)
unit_stopped() { ! active_units | grep -q "^$P-$1\.service("; }
# the label's directory with its note and the copies of the chain state, the overlay and the configs made
# from them, as they are NOW (made once per label: a later part added to the label keeps the first copies)
archive_notes() {
  local D="$STATE/archive/$1" f
  mk_archive_root
  [ -d "$D" ] || mkdir -m 700 "$D"
  [ -d "$D/etc" ] || mkdir -m 700 "$D/etc"
  [ -d "$D/derived" ] || mkdir -m 700 "$D/derived"
  for f in "${ARCHIVE_ETC[@]}"; do
    if [ -f "$ETC/$f" ] && [ ! -e "$D/etc/$f" ]; then cp -p "$ETC/$f" "$D/etc/$f"; echo "copied   $ETC/$f ($(dir_size "$ETC/$f")) -> $D/etc/$f"; fi
  done
  # what site-config.ts wrote from them: restored as they were, so a restore needs no new stage
  for f in $(derived_files); do
    if [ -f "$f" ] && [ ! -e "$D/derived/$(derived_name "$f")" ]; then cp -p "$f" "$D/derived/$(derived_name "$f")"; echo "copied   $f ($(dir_size "$f")) -> $D/derived/"; fi
  done
  [ -f "$D/ARCHIVE" ] || printf 'label %s\ninstance %s\narchived_at %s\nrelease %s\n' "$1" "$NAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$(readlink "$BASE/current" 2>/dev/null || echo none)")" > "$D/ARCHIVE"
}
# archive_into <label> <recreate|norecreate> <part>...: the moves and copies, after the checks
archive_into() {
  local label="$1" mode="$2" D="$STATE/archive/$1" d
  shift 2
  archive_notes "$label"
  for d in "$@"; do
    if [ -d "$STATE/$d" ]; then
      echo "moved    $STATE/$d ($(dir_size "$STATE/$d")) -> $D/$d"
      mv "$STATE/$d" "$D/$d"
      printf 'part %s %s\n' "$d" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$D/ARCHIVE"
    else
      echo "absent   $STATE/$d (nothing to move)"
    fi
    [ "$mode" = norecreate ] || mk_state_dir "$d"
  done
}
# archive_state <label> [--only core,indexer,runtime]
archive_state() {
  local label="$1" parts d
  label_ok "$label" || { echo "archive-state <label> [--only core,indexer,runtime]: the label is 1 to 40 characters of a-z, 0-9 and -" >&2; return 2; }
  if [ -n "${2:-}" ]; then
    [ "$2" = "--only" ] && parts="$(parts_of "${3:-}")" || { echo "archive-state <label> [--only <parts>]: parts are a comma-separated list of ${DEPLOYMENT_DIRS[*]}" >&2; return 2; }
    # an existing label may gain a part it does not hold yet
    for d in $parts; do
      if holds_part "$label" "$d"; then echo "REFUSED: the archive $label already holds a $d part ($STATE/archive/$label)" >&2; return 1; fi
    done
  else
    parts="${DEPLOYMENT_DIRS[*]}"
    [ ! -e "$STATE/archive/$label" ] || { echo "REFUSED: an archive named $label exists ($STATE/archive/$label)" >&2; return 1; }
  fi
  require_stopped || return 1
  archive_into "$label" recreate $parts
  echo "archived: $(echo $parts | tr ' ' ',') of the $NAME instance in $STATE/archive/$label (root only); left empty here"
  echo "kept: site keys, caps.json, canaries, releases, env files, the identity store"
}
# A copy of Core's database directory into the label (activate-staged GO_BACKUP_CORE): Core must be
# stopped, so a plain copy is consistent. restore-state brings it back as the label's core part.
backup_core() {
  local label="$1" D="$STATE/archive/$1" t0
  t0="$(date +%s)"
  unit_stopped core || { echo "REFUSED: $P-core runs; its database is copied only while it is stopped" >&2; return 1; }
  if holds_part "$label" core; then echo "REFUSED: the archive $label already holds a core part" >&2; return 1; fi
  archive_notes "$label"
  cp -a "$STATE/core" "$D/core-backup"
  printf 'part core-backup %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$D/ARCHIVE"
  echo "copied   $STATE/core ($(dir_size "$D/core-backup")) -> $D/core-backup in $(( $(date +%s) - t0 )) s"
}
# The indexer's database set aside into the label (activate-staged GO_ARCHIVE_INDEXER): the same move as
# archive-state --only indexer, with only the indexer required to be stopped.
set_aside_indexer() {
  local label="$1"
  unit_stopped indexer || { echo "REFUSED: $P-indexer runs; its database is moved only while it is stopped" >&2; return 1; }
  if holds_part "$label" indexer; then echo "REFUSED: the archive $label already holds an indexer part" >&2; return 1; fi
  archive_into "$label" recreate indexer
}
# activate-staged: everything that could refuse the two steps above, checked before anything is stopped or moved.
# go_precheck <backup label or ""> <indexer label or ""> <units will be stopped first: yes or "">
go_precheck() {
  local bl="$1" il="$2" stops="$3"
  if [ -n "$bl" ]; then
    label_ok "$bl" || { echo "GO_BACKUP_CORE: the label is 1 to 40 characters of a-z, 0-9 and -" >&2; return 2; }
    if holds_part "$bl" core; then echo "REFUSED: the archive $bl already holds a core part" >&2; return 1; fi
    [ "$stops" = yes ] || unit_stopped core || { echo "REFUSED: GO_BACKUP_CORE needs $P-core stopped (stop the instance, or GO_SWITCH_RUNNING=yes)" >&2; return 1; }
  fi
  if [ -n "$il" ]; then
    label_ok "$il" || { echo "GO_ARCHIVE_INDEXER: the label is 1 to 40 characters of a-z, 0-9 and -" >&2; return 2; }
    if holds_part "$il" indexer; then echo "REFUSED: the archive $il already holds an indexer part" >&2; return 1; fi
    [ "$stops" = yes ] || unit_stopped indexer || { echo "REFUSED: GO_ARCHIVE_INDEXER needs $P-indexer stopped (stop the instance, or GO_SWITCH_RUNNING=yes)" >&2; return 1; }
  fi
}
# restore_state <label>: whatever parts the label holds come back; the others are not touched
restore_state() {
  local label="$1" D d f a auto parts src
  label_ok "$label" || { echo "restore-state <label>: the label is 1 to 40 characters of a-z, 0-9 and -" >&2; return 2; }
  D="$STATE/archive/$label"
  [ -f "$D/ARCHIVE" ] || { echo "REFUSED: no archive named $label ($D)" >&2; return 1; }
  parts="$(label_parts "$label" | paste -sd' ' -)"
  [ -n "$parts" ] || { echo "REFUSED: the archive $label holds no part (${DEPLOYMENT_DIRS[*]})" >&2; return 1; }
  require_stopped || return 1
  auto="pre-restore-$(date -u +%Y%m%d-%H%M%S)"
  [ ! -e "$STATE/archive/$auto" ] || { echo "REFUSED: $STATE/archive/$auto exists; run it again in a second" >&2; return 1; }
  echo "the current $(echo $parts | tr ' ' ',') go to archive/$auto first:"
  archive_into "$auto" norecreate $parts
  echo "restoring $label ($(echo $parts | tr ' ' ',')):"
  for d in $parts; do
    src="$D/$d"; [ -d "$src" ] || src="$D/core-backup"
    echo "moved    $src ($(dir_size "$src")) -> $STATE/$d"
    mv "$src" "$STATE/$d"
  done
  for f in "${ARCHIVE_ETC[@]}"; do
    if [ -f "$D/etc/$f" ]; then cp -p "$D/etc/$f" "$ETC/$f"; echo "restored $ETC/$f"; fi
  done
  for f in $(derived_files); do
    a="$D/derived/$(derived_name "$f")"
    if [ -f "$a" ]; then cp -p "$a" "$f"; echo "restored $f"; fi
  done
  # the label is free again; what is left of it (its note and the config copies) stays beside what it replaced
  mv "$D" "$STATE/archive/$auto/restored-from-$label"
  echo "restored: the $NAME instance runs on $(echo $parts | tr ' ' ',') and the chain state of $label at its next start; what they replaced is in $STATE/archive/$auto"
  echo "before the next stage or activate: scripts/mainnet/mainnet.json and profile.local.json on the owner's machine must be this deployment's (stage ships them again)"
}
# <<< state-archive

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
  if [ "$WITH_IDENTITY" = 1 ]; then identity_setup "$REL"; fi
  install_units "$REL"
  echo "$SHA" > "$BASE/staged"   # what activate-staged runs
  echo "staged: $SHA in $REL; units installed, none enabled or started"
  echo "PUBKEYS $(cat "$STATE/site/pubkeys.json")"
  ;;
place-next)
  place_next
  ;;
activate|activate-staged)
  T_PHASE="$(now_ms)"; T_ALL="$T_PHASE"
  if [ "$CMD" = activate-staged ]; then
    # go-live: the release that is already staged; nothing is shipped, installed or built
    REL="$(staged_release)"; SHA="$(basename "$REL")"
    echo "release   $SHA (already staged)"
    if [ -n "${1:-}" ] && [ "$1" != "$SHA" ]; then echo "NOTE: the staged release $SHA is not the local HEAD $1; continuing with the staged one"; fi
    # everything that can refuse the switch, before anything is stopped, copied or moved
    go_precheck "${GO_BACKUP_CORE:-}" "${GO_ARCHIVE_INDEXER:-}" "${GO_SWITCH_RUNNING:-}" && promote_check || { echo "NOT ACTIVATED: the $NAME instance is as it was" >&2; exit 1; }
    SWITCHED=0
    if [ "${GO_SWITCH_RUNNING:-}" = yes ]; then
      # Core keeps its database across the switch: the three services that hold deployment state stop first
      # (the workers, web and the gate keep running and are restarted below), then the files change
      echo "switch: stopping $P-runtime, then $P-indexer, then $P-core; they start again as Core, the indexer, then the rest"
      systemctl stop "$P-runtime" 2>/dev/null || true
      systemctl stop "$P-indexer"
      systemctl stop "$P-core"
      SWITCHED=1
      phase "runtime, indexer, Core stopped"
    fi
    # any exit before the end puts the previous state files back, and the configs made from them
    trap 'rc=$?; if [ "$rc" != 0 ]; then
      if [ "$PROMOTED" = 1 ]; then rollback_next; site_config "$REL" >/dev/null 2>&1 || true; fi
      if [ "$SWITCHED" = 1 ]; then echo "NOT ACTIVATED: $P-runtime, $P-indexer and $P-core are stopped. Back to the previous deployment: instance.sh <host> stop, then restore-state <label> when a Core backup or the indexer was set aside (${GO_BACKUP_CORE:-none} / ${GO_ARCHIVE_INDEXER:-none}), then start" >&2; fi
    fi' EXIT
    if [ -n "${GO_BACKUP_CORE:-}" ]; then backup_core "$GO_BACKUP_CORE"; phase "Core database copy"; fi
    if [ -n "${GO_ARCHIVE_INDEXER:-}" ]; then set_aside_indexer "$GO_ARCHIVE_INDEXER"; phase "indexer database set aside"; fi
    promote_next
    phase "next files into place"
  else
    SHA="$1"; REL="$BASE/releases/$SHA"
  fi
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
  if [ "$WITH_IDENTITY" = 1 ]; then identity_setup "$REL"; fi
  phase "configs"
  # the endpoint is this instance's network and the programs and the quote mint are there (read only; the URL is never printed)
  if ! systemd-run --wait --pipe -q --collect --uid="$P" --gid="$P" -p EnvironmentFile="$ETC/rpc.env" -p WorkingDirectory="$REL" \
      -E HOME="$UHOME" -E BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 -E UNITS_NETWORK="$NETWORK" -E UNITS_PROFILE_LOCAL="$ETC/profile.local.json" \
      /usr/local/bin/bun scripts/deploy/instance-preflight.ts "$NAME"; then
    echo "NOT ACTIVATED: the chain preflight failed (above); the $NAME instance stays staged and stopped" >&2; exit 1
  fi
  phase "chain preflight"
  # its ports must be free, or held by its own units (a re-activate)
  for port in $PORT_CORE $PORT_WEB $PORT_GATE $PORT_BIND $PORT_IDX $([ "$WITH_IDENTITY" = 1 ] && echo "$PORT_ID"); do
    for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
      cg="$(cat "/proc/$pid/cgroup" 2>/dev/null || true)"
      case "$cg" in *"/$P-"*) ;; *) echo "port $port is held by pid $pid, which is not a $P unit; not activated" >&2; exit 1 ;; esac
    done
  done
  install_units "$REL"
  caddy_site "$REL" || { echo "NOT ACTIVATED: Caddy (above)" >&2; exit 1; }
  ln -sfn "$REL" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  phase "unit files and Caddy"
  systemctl enable -q "${PUBLIC_UNITS[@]}"
  echo "public units (Core first, each health-checked):"
  for u in "${PUBLIC_UNITS[@]}"; do
    if ! restart_checked "$u"; then
      stop_all
      echo "ACTIVATE FAILED: $u did not come up; every $P unit is stopped again (the first instance was not touched)" >&2
      exit 1
    fi
  done
  if [ "$WITH_IDENTITY" = 1 ]; then
    systemctl enable -q --now "$ID_TIMER"
    echo "identity service on ($IDU, port $PORT_ID, cycle timer $ID_TIMER); pool: $(curl -s -m 5 "http://127.0.0.1:$PORT_ID/identity/pool" 2>/dev/null || echo unknown)"
  else
    echo "identity service off (WITH_IDENTITY=1 turns it on)"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "dry run: $P-bootstrap, $P-reference, $P-verifier@v1, $P-verifier@v2, $P-runtime SKIPPED (sandbox units need Docker)"
  else
    systemctl enable -q "${WORKER_UNITS[@]}"
    systemctl restart --no-block "$P-bootstrap"
    systemctl restart --no-block "${WORKER_UNITS[@]}"
    if [ "${WITH_RUNTIME:-0}" = 1 ]; then systemctl enable -q "$P-runtime"; systemctl restart --no-block "$P-runtime"; echo "runtime queued ($P-runtime)"
    else systemctl disable -q --now "$P-runtime" 2>/dev/null || true; echo "runtime off (WITH_RUNTIME=1 turns it on)"; fi
  fi
  phase "background units queued"
  finish_next
  if [ "$CMD" = activate-staged ]; then T_PHASE="$T_ALL"; phase "ALL (on the server)"; fi
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
  if have_next; then
    # the deployment the instance is about to switch to: its registry, through the tool's own environment
    CHAIN_STATE="$NEXT/state.json"; CHAIN_PROFILE="$NEXT/profile.local.json"
    echo "chain: working on the NEXT deployment ($NEXT/state.json and profile.local.json); the live files in $ETC are not read"
  else
    [ -s "$ETC/state.json" ] && [ -s "$ETC/profile.local.json" ] || { echo "no chain state or profile overlay yet ($ETC): stage again once the programs are deployed and initialized" >&2; exit 1; }
  fi
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
  if [ "$WITH_IDENTITY" = 1 ]; then systemctl enable -q --now "$ID_TIMER"; fi
  if [ "$DRY_RUN" != 1 ]; then
    systemctl enable -q --now "${WORKER_UNITS[@]}"
    [ "${WITH_RUNTIME:-0}" = 1 ] && systemctl enable -q --now "$P-runtime"
  fi
  echo "started"
  ;;
status)
  echo "instance  $NAME ($P, $NETWORK)"
  echo "release   $(basename "$(readlink "$BASE/current" 2>/dev/null || echo "none (staged: $(ls -1 "$BASE/releases" 2>/dev/null | paste -sd' ' - || true))")")"
  for u in "${PUBLIC_UNITS[@]}" "$P-bootstrap" "${WORKER_UNITS[@]}" "$P-runtime" $([ "$WITH_IDENTITY" = 1 ] && echo "$ID_TIMER"); do
    st=$(systemctl is-active "$u" 2>/dev/null || true); en=$(systemctl is-enabled "$u" 2>/dev/null || true)
    printf '%-28s %-10s %s\n' "$u" "${st:-unknown}" "${en:-}"
  done
  echo "ports     core $PORT_CORE, web $PORT_WEB, gate $PORT_GATE, runtime bind $PORT_BIND, indexer $PORT_IDX"
  echo "site      ${SITE_NAMES:-not set}"
  echo "state     $([ -s "$ETC/state.json" ] && echo present || echo missing), overlay $([ -s "$ETC/profile.local.json" ] && echo present || echo missing), rpc $(have_rpc && echo present || echo missing), Core authority key $([ -f "$ETCCORE/core-authority.json" ] && echo present || echo missing), runtime authority key $([ -f "$LH/$NETWORK/runtime-authority.json" ] && echo present || echo missing)"
  h="$(curl -s -m 5 "http://127.0.0.1:$PORT_CORE/v1/health" 2>/dev/null || true)"; echo "core      ${h:-not answering}"
  if [ "$WITH_IDENTITY" = 1 ]; then
    # counts only: accounts by status and the low-water flag; never a login of a free account, never a token
    h="$(curl -s -m 5 "http://127.0.0.1:$PORT_ID/identity/pool" 2>/dev/null || true)"; echo "identity  port $PORT_ID, pool ${h:-not answering}"
  else
    echo "identity  off (WITH_IDENTITY=1 on stage or activate turns it on)"
  fi
  if [ -d "$STATE/archive" ]; then echo "archives  $(ls -1 "$STATE/archive" 2>/dev/null | paste -sd' ' - || true)"; fi
  for f in "$SHARED"/*.json; do if [ -f "$f" ]; then echo "e2b       $(basename "$f" .json): $(jq -c '{day, usd}' "$f" 2>/dev/null || echo unreadable)"; fi; done
  ;;
identity-pool)
  # {"login","token"} JSON lines on stdin into the encrypted reserve (packages/identity main.ts reserve-add:
  # an account already there is left as it is, so a re-run adds nothing twice). Prints logins only.
  identity_ready || exit 1
  REL="$(release_dir)"
  run_identity_tool reserve-add
  ;;
identity-pool-list)
  identity_ready || exit 1
  REL="$(release_dir)"
  run_identity_tool reserve-list < /dev/null
  ;;
archive-state)
  archive_state "${1:-}" "${2:-}" "${3:-}"
  ;;
restore-state)
  restore_state "${1:-}"
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
  for f in /etc/systemd/system/$P-*.service /etc/systemd/system/$P-*.timer /etc/systemd/system/$P-*.off; do [ -f "$f" ] && rm -f "$f"; done
  systemctl daemon-reload
  if [ -f "/etc/caddy/sites.d/$P.caddy" ]; then
    rm -f "/etc/caddy/sites.d/$P.caddy" "/etc/caddy/sites.d/$P.caddy.prev"
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy || echo "caddy: check /etc/caddy/Caddyfile by hand" >&2
  fi
  rm -f "$SHARED/$NAME.json"
  echo "removed: the $P units and its Caddy site block"
  if [ "${1:-}" = "--purge" ]; then
    for p in "$ETCCORE/core-authority.json" "$LH/$NETWORK/runtime-authority.json"; do [ -f "$p" ] && { shred -u "$p" 2>/dev/null || rm -f "$p"; }; done
    # the identity service's key file and encrypted store go too: its reserve and credentials cannot be read again
    for p in "$ID_ETC/master.key" "$ID_ETC/core-key.json"; do [ -f "$p" ] && { shred -u "$p" 2>/dev/null || rm -f "$p"; }; done
    rm -rf "$BASE" "$STATE" "$ETC" "$ETCCORE" "$ID_ETC"
    for u in "${SERVICE_USERS[@]}" "$IDU"; do id "$u" >/dev/null 2>&1 && userdel "$u" 2>/dev/null || true; done
    id "$P" >/dev/null 2>&1 && userdel -r "$P" 2>/dev/null || true
    echo "purged: $BASE, $STATE (archives and the identity store included), $ETC, $ETCCORE, $ID_ETC, $UHOME and the $P accounts (keys shredded)"
  else
    echo "kept: $BASE, $STATE, $ETC, $ETCCORE, $UHOME (remove --purge deletes them and the accounts)"
  fi
  ;;
*)
  echo "usage: remote-instance.sh <name> install <sha> | activate <sha> | activate-staged [local head] | place-next | chain [plan] | sweep plan|check|send <recipient> | stop | start | status | identity-pool | identity-pool-list | archive-state <label> [--only <parts>] | restore-state <label> | remove [--purge [--force]]" >&2
  exit 2
  ;;
esac
