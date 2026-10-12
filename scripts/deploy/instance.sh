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
#                    STAGE_NEXT=1: the chain state and the overlay are for the NEXT deployment and go to
#                    /etc/units-main/next (the instance keeps running the current one on its own files);
#                    `go` moves them into place. Without it stage replaces the live state.json and
#                    overlay, which a running or restarting unit of the current deployment would read.
#   activate         stage, then start the instance. Refused (here, and again on the server) unless the
#                    chain state, the profile overlay, the keyed RPC and both hot keys exist, the endpoint
#                    is mainnet and the programs are deployed and initialized there.
#   go               go-live as an activation, not a deploy: ships only the chain state, the profile overlay
#                    and, with INSTANCE_SIZING_FILE, a sizing file (a JSON object, to /etc/units-main/sizing.json)
#                    when they exist here, then activates the release that is ALREADY staged on the server
#                    (no bundle, no bun install, no image build, no recipe pinning). Every refusal of
#                    activate holds (state, overlay, RPC, Core key, chain preflight, ports). Prints the
#                    seconds each phase took. Refused while units of the instance still run and a new
#                    state would replace theirs, unless GO_SWITCH_RUNNING=yes (Core keeps its database: the
#                    runtime, the indexer and Core are stopped in that order, the files change, and the units
#                    start as Core, indexer, then the rest). GO_BACKUP_CORE=<label> copies Core's stopped
#                    database to archive/<label>/core-backup first; GO_ARCHIVE_INDEXER=<label> moves the
#                    indexer's database to archive/<label>/indexer and leaves it empty (one label may serve
#                    both; restore-state <label> brings both and the previous state files back). With
#                    WITH_IDENTITY=1 in the server's site.env the identity unit starts too.
#   chain-plan       read only: what registering and bonding the instance's three verifiers would send, and
#                    the SOL and quote tokens its owner key (made on the server) must hold first
#   chain            the same, sent on mainnet by the server's owner key; refused without MAINNET_SEND=yes.
#                    Both need only a stage made with the chain state, the overlay and the RPC present: run
#                    them BEFORE activate, so the verifiers are registered when their units first start.
#                    With INSTANCE_STATE_FILE and INSTANCE_PROFILE_FILE both set, the two files are sent to
#                    /etc/units-main/next/ first and chain works on THAT deployment: the live state.json
#                    and overlay are not touched, so a unit of the running deployment that restarts by
#                    itself still comes up on its own state. `go` moves next/ into place.
#   sweep-plan       read only: what the keys that live only on the server hold (site owner key, verifier keys)
#   sweep <recipient>  sends all of it (SOL, and the owner key's quote tokens) to <recipient>; refused without
#                    MAINNET_SEND=yes. Bonds stay in the registry.
#   status           units, ports, what is present, Core health, the shared E2B budget files
#   stop | start     stop and disable, or start, the instance's units (Caddy and the first instance stay)
#   remove [--purge [--force]]  stop it and remove its unit files and Caddy site block; --purge also deletes
#                    its directories, keys and accounts on the server, and is refused while the server-held
#                    keys hold more than dust (sweep first) unless --force
#   archive-state <label> [--only core,indexer,runtime]  a deployment switch: with every unit of the instance stopped, moves Core's, the
#                    indexer's and the runtime's state into /var/lib/units-main/archive/<label>/ and leaves
#                    them empty; copies state.json and profile.local.json there. Keeps site keys, caps.json,
#                    canaries, releases, env files. Label: a-z, 0-9 and -, at most 40. Refused when it exists;
#                    with --only just those parts move, and the label may exist when it lacks them.
#   restore-state <label>  the reverse (stopped only) for the parts the label holds: the current ones go to
#                    archive/pre-restore-<time> first, then the archived directories and the two files come back
#   identity-pool-plan [--count N | --all]   read only, sends nothing: which accounts of the local pool may
#                    go to this instance by the owner's ledger (counts and logins; without any ssh:
#                    bun scripts/identity/ship-pool.ts plan --instance mainnet)
#   identity-pool --count N | --all   WITH_IDENTITY instances only, run by no other mode: sends accounts no
#                    instance ever had into the identity service's encrypted reserve, each written to the
#                    ledger first (scripts/identity/ship-pool.ts). Refused without IDENTITY_POOL_SEND=yes.
#   identity-pool-sync   read only on the server: what the reserve assigned, copied into the ledger
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
# instance's); WITH_RUNTIME=1 runs the hosted runtime (real model spend: 800 USD per UTC day, all spend);
# WITH_IDENTITY=1 runs the instance's own GitHub identity service (default off; kept in the server's
# site.env like WITH_RUNTIME, so a later deploy without the variable keeps it; WITH_IDENTITY=0 turns it
# off again). It ships no GitHub account: the reserve is empty until identity-pool is run.
# DRY_RUN=1 is the dry run (scripts/deploy/dryrun.sh): no Docker, no keys from here, internal TLS.
set -euo pipefail
HOST="${1:-}"; MODE="${2:-stage}"; EXTRA="${3:-}"
NAME="${UNITS_INSTANCE:-}"
[ -n "$HOST" ] && [ -n "$NAME" ] || { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; exit 2; }
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
# other front ends allowed to use this instance's same-origin routes (the /chain proxy, writes): a static
# build on another host, a developer's local server. EXTRA_ORIGINS overrides; unset keeps the server's.
if [ -z "${EXTRA_ORIGINS+x}" ] && [ "$DRY_RUN" != 1 ]; then
  EXTRA_ORIGINS="$(r "sed -n 's/^GATE_EXTRA_ORIGINS=//p' /etc/$P/site.env 2>/dev/null | tail -1" || true)"
fi
if [ -n "${EXTRA_ORIGINS:-}" ]; then
  echo "$EXTRA_ORIGINS" | tr ',' '\n' | grep -qvE '^(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1):\*)$' && { echo "EXTRA_ORIGINS: comma-separated https://host origins, http://localhost:* or http://127.0.0.1:*" >&2; exit 2; }
  ORIGINS="$ORIGINS,$EXTRA_ORIGINS"
fi
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
  # the identity service: only when asked for, or when the server already has it on (unset keeps, 0 turns off)
  local with_id="${WITH_IDENTITY:-}" id_line=""
  [ -n "$with_id" ] || with_id="$(r "sed -n 's/^WITH_IDENTITY=//p' /etc/$P/site.env 2>/dev/null | tail -1" || true)"
  case "${with_id:-0}" in 0|1) ;; *) echo "WITH_IDENTITY must be 1 or 0" >&2; exit 2 ;; esac
  # written only when on: without it site.env is what it always was
  if [ "${with_id:-0}" = 1 ]; then id_line="WITH_IDENTITY=1"; fi
  local nl=$'\n'
  r "install -d -m 755 /etc/$P && (umask 077; cat > /etc/$P/site.env) && chmod 600 /etc/$P/site.env && chown root:root /etc/$P/site.env" <<EOF
# written by scripts/deploy/instance.sh; read by remote-instance.sh and the $P-* units
UNITS_INSTANCE=$NAME
UNITS_NETWORK=$NETWORK
UNITS_PROFILE_LOCAL=/etc/$P/profile.local.json
SITE_NAMES=$SITE_NAMES
GATE_ORIGINS=$ORIGINS
GATE_EXTRA_ORIGINS=${EXTRA_ORIGINS:-}
UNITS_RECIPES=$recipes
UNITS_SITE_URL=https://${SITE_NAMES%%,*}
DRY_RUN=$DRY_RUN
WITH_RUNTIME=${with_rt:-0}${id_line:+$nl$id_line}
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
  if [ "${STAGE_NEXT:-0}" = 1 ]; then
    # the instance still runs another deployment: its live state and overlay stay, these wait in next/ for `go`
    [ -f "$STATE_FILE" ] && [ -f "$PROFILE_FILE" ] || { echo "STAGE_NEXT=1 needs both $STATE_FILE and $PROFILE_FILE" >&2; exit 2; }
    echo "STAGE_NEXT=1: the chain state and the overlay go to /etc/$P/next; the live ones are not replaced"
    ship_next "$STATE_FILE" "$PROFILE_FILE" "${INSTANCE_SIZING_FILE:-}"
  else
  if [ -f "$STATE_FILE" ]; then r "umask 077; cat > /opt/$P/incoming/state.json" < "$STATE_FILE"; echo "chain state: sent"; else echo "chain state: none here yet ($STATE_FILE)"; fi
  if [ -f "$PROFILE_FILE" ]; then r "umask 077; cat > /opt/$P/incoming/profile.local.json" < "$PROFILE_FILE"; echo "profile overlay: sent"; else echo "profile overlay: none here yet ($PROFILE_FILE)"; fi
  fi
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

# The NEXT deployment's files, to the server's incoming directory and from there to /etc/$P/next
# (remote-instance.sh place-next). ship_next <state file or ""> <overlay or ""> <sizing or "">
ship_next() {
  local st="$1" pf="$2" sz="$3" f
  if [ -z "$st$pf$sz" ]; then echo "chain state, overlay, sizing: none here; the server's are used"; return 0; fi
  for f in "$st" "$pf" "$sz"; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || { echo "no file $f" >&2; exit 2; }
    bun -e 'const j = JSON.parse(await Bun.file(process.argv[1]).text()); if (!j || typeof j !== "object" || Array.isArray(j)) process.exit(1)' "$f" 2>/dev/null || { echo "$f is not a JSON object; nothing was sent" >&2; exit 2; }
  done
  r "install -d -m 755 /opt/$P && install -d -m 700 /opt/$P/incoming"
  if [ -n "$st" ]; then r "umask 077; cat > /opt/$P/incoming/next.state.json" < "$st"; echo "chain state: sent ($(basename "$st"), $(wc -c < "$st" | tr -d ' ') bytes)"; fi
  if [ -n "$pf" ]; then r "umask 077; cat > /opt/$P/incoming/next.profile.local.json" < "$pf"; echo "profile overlay: sent ($(basename "$pf"))"; fi
  if [ -n "$sz" ]; then r "umask 077; cat > /opt/$P/incoming/next.sizing.json" < "$sz"; echo "sizing: sent ($(basename "$sz"))"; fi
  r "$RI place-next < /dev/null"
}
# chain and chain-plan: the pair named explicitly goes to next/ (never over the live files)
chain_next() {
  if [ -n "${INSTANCE_STATE_FILE:-}" ] || [ -n "${INSTANCE_PROFILE_FILE:-}" ]; then
    [ -n "${INSTANCE_STATE_FILE:-}" ] && [ -n "${INSTANCE_PROFILE_FILE:-}" ] || { echo "INSTANCE_STATE_FILE and INSTANCE_PROFILE_FILE go together (one deployment's state and overlay)" >&2; exit 2; }
    ship_next "$INSTANCE_STATE_FILE" "$INSTANCE_PROFILE_FILE" ""
  fi
}
secs() { echo "$(( $(date +%s) - $1 )) s"; }

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
  go)
    for v in "${GO_ARCHIVE_INDEXER:-}" "${GO_BACKUP_CORE:-}"; do
      [ -z "$v" ] || [[ "$v" =~ ^[a-z0-9-]{1,40}$ ]] || { echo "GO_ARCHIVE_INDEXER and GO_BACKUP_CORE are archive labels: 1 to 40 characters of a-z, 0-9 and -" >&2; exit 2; }
    done
    t0=$(date +%s); t=$t0
    say "go: activate the staged $NAME instance on $HOST (nothing is built or installed)"
    put_tools
    ship_next "$([ -f "$STATE_FILE" ] && echo "$STATE_FILE")" "$([ -f "$PROFILE_FILE" ] && echo "$PROFILE_FILE")" "${INSTANCE_SIZING_FILE:-}"
    # site.env is the server's (WITH_IDENTITY and WITH_RUNTIME as staged); written again only when one is given now
    if [ -n "${WITH_IDENTITY:-}${WITH_RUNTIME:-}${UNITS_RECIPES:-}" ]; then write_env; echo "site.env: written again"; else echo "site.env: the server's, unchanged"; fi
    echo "time      shipping (this machine)       $(secs $t)"; t=$(date +%s)
    r "HEALTH_WAIT=${DEPLOY_HEALTH_WAIT:-300} GO_SWITCH_RUNNING=${GO_SWITCH_RUNNING:-} GO_BACKUP_CORE=${GO_BACKUP_CORE:-} GO_ARCHIVE_INDEXER=${GO_ARCHIVE_INDEXER:-} $RI activate-staged $(git rev-parse HEAD 2>/dev/null || true) < /dev/null"
    echo "time      activation (over ssh)         $(secs $t)"; t=$(date +%s)
    first="${SITE_NAMES%%,*}"
    if [ "$DRY_RUN" = 1 ]; then r "curl -fsS -m 10 --cacert /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt --resolve $first:443:127.0.0.1 https://$first/v1/health" && echo
    else for i in $(seq 1 30); do curl -fsS -m 10 "https://$first/v1/health" && { echo; break; }; sleep 2; done || true; fi
    echo "time      public health answer          $(secs $t)"
    echo "time      ALL                           $(secs $t0)"
    echo "site: $(echo "$SITE_NAMES" | tr ',' '\n' | sed 's|^|https://|' | paste -sd' ' -)" ;;
  chain-plan) put_tools; chain_next; r "$RI chain plan < /dev/null" ;;
  chain)
    # sends transactions on the instance's network with the instance's owner key (on the server)
    [ "${MAINNET_SEND:-}" = yes ] || { echo "chain sends ${NETWORK} transactions (3 registrations, 2 bonds): run chain-plan first, then MAINNET_SEND=yes with the owner's approval" >&2; exit 1; }
    put_tools; chain_next; r "$RI chain < /dev/null" ;;
  sweep-plan) put_tools; r "$RI sweep plan < /dev/null" ;;
  sweep)
    # sends, on the instance's network, everything the server-held keys hold to <recipient>
    [[ "$EXTRA" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "sweep <recipient address>: where the site owner key's and the verifier keys' SOL and quote tokens go" >&2; exit 2; }
    [ "${MAINNET_SEND:-}" = yes ] || { echo "sweep sends ${NETWORK} transactions from the keys on the server to $EXTRA: run sweep-plan first, then MAINNET_SEND=yes with the owner's approval" >&2; exit 1; }
    put_tools; r "$RI sweep send $EXTRA < /dev/null" ;;
  status|stop|start) put_tools; r "$RI $MODE < /dev/null" ;;
  archive-state|restore-state)
    # moves the instance's deployment state on the server; the server refuses unless every unit is stopped
    [[ "$EXTRA" =~ ^[a-z0-9-]{1,40}$ ]] || { echo "$MODE <label>: 1 to 40 characters of a-z, 0-9 and -" >&2; exit 2; }
    ONLY=""
    if [ -n "${4:-}" ]; then
      [ "$MODE" = archive-state ] && [ "$4" = "--only" ] && [[ "${5:-}" =~ ^(core|indexer|runtime)(,(core|indexer|runtime))*$ ]] || { echo "archive-state <label> [--only core,indexer,runtime]" >&2; exit 2; }
      ONLY="--only $5"
    fi
    put_tools; r "$RI $MODE $EXTRA $ONLY < /dev/null" ;;
  identity-pool-plan)
    # read only and local: nothing is sent anywhere
    shift 2; bun "$REPO/scripts/identity/ship-pool.ts" plan --instance "$NAME" "$@" ;;
  identity-pool-sync)
    put_tools; shift 2; bun "$REPO/scripts/identity/ship-pool.ts" sync --instance "$NAME" --host "$HOST" --ssh-key "$SSH_KEY" --ssh-port "$SSH_PORT" --ssh-user "$SSH_USER" "$@" ;;
  identity-pool)
    # sends GitHub accounts to the instance's identity service: never part of stage or activate
    [ "${IDENTITY_POOL_SEND:-}" = yes ] || { echo "identity-pool sends GitHub accounts of the local pool to the $NAME instance and marks them used for good in the ledger: run identity-pool-plan first, then IDENTITY_POOL_SEND=yes with the owner's approval" >&2; exit 1; }
    put_tools; shift 2; IDENTITY_POOL_SEND=yes bun "$REPO/scripts/identity/ship-pool.ts" ship --instance "$NAME" --host "$HOST" --ssh-key "$SSH_KEY" --ssh-port "$SSH_PORT" --ssh-user "$SSH_USER" "$@" ;;
  remove) put_tools; r "$RI remove $EXTRA ${4:-} < /dev/null" ;;
  *) echo "unknown mode $MODE (stage, activate, go, chain-plan, chain, sweep-plan, sweep, status, stop, start, archive-state, restore-state, identity-pool-plan, identity-pool, identity-pool-sync, remove)" >&2; exit 2 ;;
esac
