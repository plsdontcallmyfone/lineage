#!/usr/bin/env bash
# units site, a second instance on the same server: run from this machine. docs/DEPLOY-SITE.md
# "Second instance (mainnet test)". deploy.sh hands over to this script when UNITS_INSTANCE is set.
#
#   UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> [mode]      (or scripts/deploy/instance.sh directly)
#
# Modes:
#   stage (default)  ship HEAD to /opt/units-main, install it, copy what exists here (chain state, profile
#                    overlay, keyed RPC, hot keys, with WITH_RUNTIME=1 the model and E2B key files), write
#                    configs and unit files. Starts nothing. Safe before the programs exist on mainnet.
#   activate         stage, then start the instance. Refused (here, and again on the server) unless the
#                    chain state, the profile overlay, the keyed RPC and both hot keys exist, the endpoint
#                    is mainnet and the programs are deployed and initialized there.
#   chain-plan       read only: what registering and bonding the instance's three verifiers would send, and
#                    the SOL and quote tokens its owner key (made on the server) must hold first
#   chain            the same, sent on mainnet by the server's owner key; refused without MAINNET_SEND=yes.
#                    Both need only a stage made with the chain state, the overlay and the RPC present: run
#                    them BEFORE activate, so the verifiers are registered when their units first start.
#   sweep-plan       read only: what the keys that live only on the server hold (site owner key, verifier keys)
#   sweep <recipient>  sends all of it (SOL, and the owner key's quote tokens) to <recipient>; refused without
#                    MAINNET_SEND=yes. Bonds stay in the registry.
#   status           units, ports, what is present, Core health, the shared E2B budget files
#   stop | start     stop and disable, or start, the instance's units (Caddy and the first instance stay)
#   remove [--purge [--force]]  stop it and remove its unit files and Caddy site block; --purge also deletes
#                    its directories, keys and accounts on the server, and is refused while the server-held
#                    keys hold more than dust (sweep first) unless --force
#
# What it reads here (never printed; keys are compared and reported by public key only):
#   scripts/mainnet/mainnet.json          the deployed chain state (untracked; INSTANCE_STATE_FILE overrides)
#   scripts/mainnet/profile.local.json    the profile overlay (untracked; INSTANCE_PROFILE_FILE overrides)
#   UNITS_MAINNET_RPC, or that key (or HELIUS_MAINNET_RPC) in ~/.config/units/rpc.env (INSTANCE_RPC_ENV_FILE overrides the file)
#   ~/.config/units/mainnet/core-authority.json and runtime-authority.json (checked against the state file)
#   WITH_RUNTIME=1: ~/.config/units/model.env, providers.env, e2b.env
#
# Environment: SSH_KEY, SSH_PORT, SSH_USER, DEPLOY_REF as in deploy.sh; SITE_NAMES (default
# main-<ip with dashes>.sslip.io, plus MAIN_DOMAIN when given); UNITS_RECIPES (default: the first
# instance's); WITH_RUNTIME=1 runs the hosted runtime (real model spend: 200 USD per UTC day, all spend);
# DRY_RUN=1 is the dry run (scripts/deploy/dryrun.sh): no Docker, no keys from here, internal TLS.
set -euo pipefail
HOST="${1:-}"; MODE="${2:-stage}"; EXTRA="${3:-}"
NAME="${UNITS_INSTANCE:-}"
[ -n "$HOST" ] && [ -n "$NAME" ] || { sed -n '2,39p' "$0"; exit 2; }
case "$NAME" in mainnet) TAG=main; NETWORK=mainnet ;; *) echo "unknown UNITS_INSTANCE '$NAME' (known: mainnet)" >&2; exit 2 ;; esac
P="units-$TAG"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/lineage_site}"
SSH_PORT="${SSH_PORT:-22}"
SSH_USER="${SSH_USER:-root}"
DRY_RUN="${DRY_RUN:-0}"
CFG_LOCAL="$HOME/.config/units"
KEYS_LOCAL="$CFG_LOCAL/$NETWORK"
STATE_FILE="${INSTANCE_STATE_FILE:-$REPO/scripts/$NETWORK/$NETWORK.json}"
PROFILE_FILE="${INSTANCE_PROFILE_FILE:-$REPO/scripts/$NETWORK/profile.local.json}"
SSH_OPTS=(-i "$SSH_KEY" -p "$SSH_PORT" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)
[ "${SSH_INSECURE_TEST:-0}" = 1 ] && SSH_OPTS+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
SCP_OPTS=("${SSH_OPTS[@]/#-p/-P}")
r() { env -u LC_CTYPE -u LC_ALL ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }
say() { printf '\n== %s\n' "$*"; }
RI="bash /root/lineage-deploy/remote-instance.sh $NAME"
cd "$REPO"

# the keyed RPC: from the environment, else ~/.config/units/rpc.env; held in a variable, never echoed
rpc_value() {
  local v="${UNITS_MAINNET_RPC:-}" k
  local f="${INSTANCE_RPC_ENV_FILE:-$CFG_LOCAL/rpc.env}"
  if [ -z "$v" ] && [ -f "$f" ]; then
    for k in UNITS_MAINNET_RPC HELIUS_MAINNET_RPC; do
      v="$(sed -n "s/^[[:space:]]*$k[[:space:]]*=[[:space:]]*//p" "$f" | head -1 | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')"
      [ -n "$v" ] && break
    done
  fi
  printf '%s' "$v"
}
RPC="$(rpc_value)"

if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SSLIP="main-${HOST//./-}.sslip.io"; else SSLIP=""; fi
if [ "$DRY_RUN" = 1 ]; then SITE_NAMES="${SITE_NAMES:-main.localhost}"; else SITE_NAMES="${SITE_NAMES:-$SSLIP${MAIN_DOMAIN:+,$MAIN_DOMAIN}}"; fi
SITE_NAMES="${SITE_NAMES#,}"
ORIGINS="$(echo "$SITE_NAMES" | tr ',' '\n' | sed 's|^|https://|' | paste -sd, -)"
[ "$DRY_RUN" = 1 ] && [ -n "${DRY_RUN_ORIGIN:-}" ] && ORIGINS="$ORIGINS,$DRY_RUN_ORIGIN"

write_env() {
  [ -n "$SITE_NAMES" ] || { echo "no site name: give the server's IPv4 address as <host>, or SITE_NAMES / MAIN_DOMAIN" >&2; exit 2; }
  # recipes left unset here: the first instance's (both use the same sandbox images)
  local recipes="${UNITS_RECIPES:-}"
  [ -n "$recipes" ] || recipes="$(r "sed -n 's/^UNITS_RECIPES=//p' /etc/$P/site.env 2>/dev/null | tail -1" || true)"
  [ -n "$recipes" ] || recipes="$(r "sed -n 's/^UNITS_RECIPES=//p' /etc/units/site.env 2>/dev/null | tail -1" || true)"
  recipes="${recipes:-fixture-b58,base58-py,minbpe}"
  local with_rt="${WITH_RUNTIME:-}"
  [ -n "$with_rt" ] || with_rt="$(r "sed -n 's/^WITH_RUNTIME=//p' /etc/$P/site.env 2>/dev/null | tail -1" || true)"
  r "install -d -m 755 /etc/$P && (umask 077; cat > /etc/$P/site.env) && chmod 600 /etc/$P/site.env && chown root:root /etc/$P/site.env" <<EOF
# written by scripts/deploy/instance.sh; read by remote-instance.sh and the $P-* units
UNITS_INSTANCE=$NAME
UNITS_NETWORK=$NETWORK
UNITS_PROFILE_LOCAL=/etc/$P/profile.local.json
SITE_NAMES=$SITE_NAMES
GATE_ORIGINS=$ORIGINS
UNITS_RECIPES=$recipes
UNITS_SITE_URL=https://${SITE_NAMES%%,*}
DRY_RUN=$DRY_RUN
WITH_RUNTIME=${with_rt:-0}
EOF
}

put_tools() {
  r "install -d -m 700 /root/lineage-deploy"
  env -u LC_CTYPE -u LC_ALL scp -q "${SCP_OPTS[@]}" "$REPO/scripts/deploy/remote-instance.sh" "$SSH_USER@$HOST:/root/lineage-deploy/"
}

pub_local() { bun "$REPO/scripts/deploy/site-keys.ts" pub "$1" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(Object.values(j)[0] ?? "")'; }
pub_remote() { # pub_remote <abs path> <owner>
  r "if [ -f $1 ]; then runuser -u $2 -- env HOME=/tmp BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 /usr/local/bin/bun /opt/$P/releases/$SHA/scripts/deploy/site-keys.ts pub $1; else echo '{}'; fi" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(Object.values(j)[0] ?? "")'
}
# put_key <local file> <remote abs path> <expected pubkey> <owner>
put_key() {
  local src="$1" dst="$2" want="$3" owner="$4" have there
  [ -f "$src" ] || { echo "key $(basename "$src"): not here yet ($src); not copied"; return 0; }
  have="$(pub_local "$src")"
  if [ -n "$want" ] && [ "$have" != "$want" ]; then echo "$src holds $have, the chain state names $want; not copied" >&2; return 1; fi
  there="$(pub_remote "$dst" "$owner")"
  if [ "$there" = "$have" ]; then echo "key $dst: already on the server ($have)"; return 0; fi
  if [ -n "$there" ]; then echo "key $dst: the server holds a different key ($there); not replaced" >&2; return 1; fi
  r "umask 077; install -d -m 700 -o $owner -g $owner \$(dirname $dst); cat > $dst.tmp && chown $owner:$owner $dst.tmp && chmod 600 $dst.tmp && mv $dst.tmp $dst" < "$src"
  echo "key $dst: copied ($have)"
}
put_secret() { # put_secret <local file> <name under ~/.config/lineage of the instance's account>
  local d="/home/$P/.config/lineage/$2"
  r "umask 077; cat > $d.tmp && chown $P:$P $d.tmp && chmod 600 $d.tmp && mv $d.tmp $d" < "$1"
  echo "secret $2: copied ($(wc -c < "$1" | tr -d ' ') bytes)"
}
state_field() { bun -e "console.log(JSON.parse(await Bun.file('$STATE_FILE').text()).$1 ?? '')"; }

do_stage() {
  SHA="$(git rev-parse "${DEPLOY_REF:-HEAD}^{commit}")"
  git merge-base --is-ancestor "$SHA" HEAD || { echo "DEPLOY_REF must be HEAD or one of its ancestors" >&2; exit 2; }
  say "stage $SHA for the $NAME instance on $HOST (nothing is started)"
  local t; t="$(mktemp -d)"; chmod 700 "$t"
  git bundle create -q "$t/units.bundle" HEAD
  put_tools
  r "id units >/dev/null 2>&1 || { echo 'no units account: deploy the first instance first' >&2; exit 1; }; install -d -m 755 /opt/$P && install -d -m 700 /opt/$P/incoming"
  env -u LC_CTYPE -u LC_ALL scp -q "${SCP_OPTS[@]}" "$t/units.bundle" "$SSH_USER@$HOST:/opt/$P/incoming/units.bundle"
  rm -rf "$t"
  if [ -f "$STATE_FILE" ]; then r "umask 077; cat > /opt/$P/incoming/state.json" < "$STATE_FILE"; echo "chain state: sent"; else echo "chain state: none here yet ($STATE_FILE)"; fi
  if [ -f "$PROFILE_FILE" ]; then r "umask 077; cat > /opt/$P/incoming/profile.local.json" < "$PROFILE_FILE"; echo "profile overlay: sent"; else echo "profile overlay: none here yet ($PROFILE_FILE)"; fi
  if [ -n "$RPC" ]; then printf 'UNITS_MAINNET_RPC=%s\n' "$RPC" | r "umask 077; cat > /opt/$P/incoming/rpc.env"; echo "keyed RPC: sent (not shown)"; else echo "keyed RPC: none here yet (UNITS_MAINNET_RPC in ~/.config/units/rpc.env)"; fi
  write_env
  r "$RI install $SHA < /dev/null" | grep -v '^PUBKEYS '
  if [ "$DRY_RUN" = 1 ]; then echo "keys: dry run, nothing copied from this machine"
  else
    say "keys"
    local ca="" rt=""
    if [ -f "$STATE_FILE" ]; then ca="$(state_field core_authority)"; rt="$(state_field runtime_authority)"; fi
    put_key "$KEYS_LOCAL/core-authority.json" "/etc/$P-core/core-authority.json" "$ca" "$P-core"
    put_key "$KEYS_LOCAL/runtime-authority.json" "/home/$P/.config/lineage/$NETWORK/runtime-authority.json" "$rt" "$P"
    if [ "${WITH_RUNTIME:-0}" = 1 ]; then runtime_secrets; fi
    # again, so the configs and env files name the keys and secrets that are now there
    local out
    out="$(r "$RI install $SHA < /dev/null")"
    printf '%s\n' "$out" | grep -E '^(network|runtime)\.json' | cut -c1-260 || true
  fi
}
runtime_secrets() {
  grep -qE '^[[:space:]]*ANTHROPIC_(API_KEY|AUTH_TOKEN)[[:space:]]*=' "$CFG_LOCAL/model.env" 2>/dev/null || { echo "model.env holds no ANTHROPIC_API_KEY; not copied" >&2; return 1; }
  put_secret "$CFG_LOCAL/model.env" model.env
  if grep -qE '^[[:space:]]*[A-Z0-9_]+_(API_KEY|MANAGEMENT_KEY)[[:space:]]*=[[:space:]]*[^[:space:]]' "$CFG_LOCAL/providers.env" 2>/dev/null; then put_secret "$CFG_LOCAL/providers.env" providers.env; fi
  # desktops are required and E2B only on this instance: without the key no attempt starts
  if grep -qE '^[[:space:]]*E2B_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$CFG_LOCAL/e2b.env" 2>/dev/null; then put_secret "$CFG_LOCAL/e2b.env" e2b.env
  else echo "e2b.env holds no E2B_API_KEY: desktops are required on this instance, so the runtime will start no attempt" >&2; fi
}

# refuse here first, with everything that is missing named at once
local_ready() {
  local miss=()
  [ -f "$STATE_FILE" ] || miss+=("the chain state $STATE_FILE (written once the programs are deployed and initialized)")
  [ -f "$PROFILE_FILE" ] || miss+=("the profile overlay $PROFILE_FILE")
  [ -n "$RPC" ] || miss+=("the keyed RPC (UNITS_MAINNET_RPC in ~/.config/units/rpc.env)")
  if [ "$DRY_RUN" != 1 ]; then
    [ -f "$KEYS_LOCAL/core-authority.json" ] || miss+=("$KEYS_LOCAL/core-authority.json")
    [ -f "$KEYS_LOCAL/runtime-authority.json" ] || miss+=("$KEYS_LOCAL/runtime-authority.json")
  fi
  if [ ${#miss[@]} -gt 0 ]; then
    echo "NOT ACTIVATED: missing on this machine:" >&2; printf '  %s\n' "${miss[@]}" >&2
    echo "stage works without them: UNITS_INSTANCE=$NAME scripts/deploy/deploy.sh $HOST stage" >&2
    exit 1
  fi
}

case "$MODE" in
  stage) do_stage; echo; echo "staged and stopped. Activate with: UNITS_INSTANCE=$NAME scripts/deploy/deploy.sh $HOST activate" ;;
  activate)
    local_ready
    do_stage
    say "activate the $NAME instance"
    r "HEALTH_WAIT=${DEPLOY_HEALTH_WAIT:-300} $RI activate $SHA < /dev/null"
    first="${SITE_NAMES%%,*}"
    if [ "$DRY_RUN" = 1 ]; then r "curl -fsS -m 10 --cacert /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt --resolve $first:443:127.0.0.1 https://$first/v1/health" && echo
    else for i in $(seq 1 30); do curl -fsS -m 10 "https://$first/v1/health" && { echo; break; }; sleep 5; done || true; fi
    echo "site: $(echo "$SITE_NAMES" | tr ',' '\n' | sed 's|^|https://|' | paste -sd' ' -)" ;;
  chain-plan) put_tools; r "$RI chain plan < /dev/null" ;;
  chain)
    # sends transactions on the instance's network with the instance's owner key (on the server)
    [ "${MAINNET_SEND:-}" = yes ] || { echo "chain sends ${NETWORK} transactions (3 registrations, 2 bonds): run chain-plan first, then MAINNET_SEND=yes with the owner's approval" >&2; exit 1; }
    put_tools; r "$RI chain < /dev/null" ;;
  sweep-plan) put_tools; r "$RI sweep plan < /dev/null" ;;
  sweep)
    # sends, on the instance's network, everything the server-held keys hold to <recipient>
    [[ "$EXTRA" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "sweep <recipient address>: where the site owner key's and the verifier keys' SOL and quote tokens go" >&2; exit 2; }
    [ "${MAINNET_SEND:-}" = yes ] || { echo "sweep sends ${NETWORK} transactions from the keys on the server to $EXTRA: run sweep-plan first, then MAINNET_SEND=yes with the owner's approval" >&2; exit 1; }
    put_tools; r "$RI sweep send $EXTRA < /dev/null" ;;
  status|stop|start) put_tools; r "$RI $MODE < /dev/null" ;;
  remove) put_tools; r "$RI remove $EXTRA ${4:-} < /dev/null" ;;
  *) echo "unknown mode $MODE (stage, activate, chain-plan, chain, sweep-plan, sweep, status, stop, start, remove)" >&2; exit 2 ;;
esac
