#!/usr/bin/env bash
# units capacity host: provision (or update, or remove) a server that adds sandbox capacity to a site
# (docs/plans/SCALE-OUT.md sections 5 to 7, docs/DEPLOY-SITE.md "Adding capacity"). Idempotent.
#
#   scripts/deploy/capacity-host/provision.sh <host-ip> [full|update|remove]
#
# A capacity host does one or both of:
#   sandbox   runs the evaluations of the hosted runtime's attempts (the runtime stays on the site with
#             every agent key; it sends each evaluation over ssh to this host's gateway)
#   verifier  runs a verifier of its own (its own key, made on the host and never copied off it), which
#             replays candidates like the site's verifiers. It speaks to the site's Core through an ssh
#             tunnel (Core listens on the site's loopback only, and the public gate refuses writes).
#             The verifier is installed but NOT started: registering and bonding it are chain
#             transactions the owner signs. The steps are printed at the end.
#
# Environment (defaults in brackets):
#   ROLE         sandbox | verifier | both [both]
#   INSTANCE     which instance of the site this host serves: devnet | mainnet [mainnet]
#   NAME         the host's name in the site's files, a-z 0-9 - [cap-<last part of the ip>]
#   SSH_KEY      the owner's key for root on the new host [~/.ssh/lineage_site]
#   SITE         root ssh of the site [root@157.245.71.188]; SITE_KEY its key [~/.ssh/lineage_site]
#   SITE_IP      the address the host sees the site's connections from [the host part of SITE]
#   JUMP         reach the host through this ssh hop [the site]; JUMP=none connects directly
#   HOST_PORT    the host's ssh port [22]
#   RECIPES      recipes whose sandbox images the host needs [the instance's UNITS_RECIPES on the site]
#   VERIFIERS    verifier role: how many verifiers (keys) this host runs, 1 to 4 [1]; they share its replay slots
#   START=1      verifier role: start the verifier now (only after it is registered and bonded)
#   ATTACH=0     prepare the host only: everything on the host, and nothing written on the site (the
#                release and the images are read from it). No runtime key, no hosts.json entry, no
#                tunnel account. Run again without ATTACH=0 (mode update) to attach.
#   SSH_FROM     who may reach the host's ssh after the firewall: site [default] or any
#   Dry runs:    SITE_DIR=local:<dir> plays the site on this machine (this checkout is the release, the
#                local Docker holds the images, no tunnel); DRY_RUN=1 skips the firewall reset;
#                IMAGES_MAP=<file> a local image pin map for the host (packages/sandbox local-images.ts);
#                CORE_URL=<url> the Core the verifier uses instead of the tunnel.
#
# What it does, in order (full):
#   host: Docker, git, ufw; the units-cap user (docker group, no password; its key runs only
#         /usr/local/bin/units-sandbox-gw); sshd without passwords; Bun (the site's version); the site's
#         release (the instance's /opt/<prefix>/current: the same re-pinned recipes, so the same recipe
#         ids) with its dependencies installed; the sandbox images the instance's recipes pin, copied
#         from the site's Docker (an image built here would have another id); /etc/units-cap/env with
#         the slots from this host's own size (scripts/deploy/sizing.ts); ufw: ssh from the site only.
#   sandbox:  the site's runtime user gets a key for this host, the host's own host key goes to its
#         known_hosts (read over the owner's root ssh), and the host is added to the instance's
#         sandbox-hosts/hosts.json. The running runtime re-reads it every minute: no restart.
#   verifier: a key made on the host (mode 600, never printed, never copied), the instance's caps.json,
#         a tunnel unit and the verifier unit (enabled only with START=1).
#   update: the release, its dependencies, the images, the gateway and the slots again (after a deploy
#         of the site: a host on an older release answers "update the host" and gets no evaluations).
#   remove: takes the host out of hosts.json, stops and disables its verifier and tunnel, removes the
#         tunnel's key from the site. The verifier's key and bond stay (unbond from the owner's wallet
#         first if the host is going away for good).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
HOST="${1:?usage: provision.sh <host-ip> [full|update|remove]}"
MODE="${2:-full}"
ROLE="${ROLE:-both}"
INSTANCE="${INSTANCE:-mainnet}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/lineage_site}"
SITE="${SITE:-root@157.245.71.188}"
SITE_KEY="${SITE_KEY:-$HOME/.ssh/lineage_site}"
SITE_IP="${SITE_IP:-${SITE#*@}}"
HOST_PORT="${HOST_PORT:-22}"
NAME="${NAME:-cap-${HOST##*.}}"
SITE_DIR="${SITE_DIR:-}"
ATTACH="${ATTACH:-1}"; SSH_FROM="${SSH_FROM:-site}"
VERIFIERS="${VERIFIERS:-1}"; [[ "$VERIFIERS" =~ ^[1-4]$ ]] || { echo "VERIFIERS is 1 to 4" >&2; exit 2; }
JUMP="${JUMP:-$SITE}"
[[ "$NAME" =~ ^[a-z0-9-]{1,32}$ ]] || { echo "NAME must be a-z 0-9 - (got $NAME)" >&2; exit 2; }
[[ "$MODE" =~ ^(full|update|remove)$ ]] || { echo "mode is full, update or remove" >&2; exit 2; }
[[ "$ROLE" =~ ^(sandbox|verifier|both)$ ]] || { echo "ROLE is sandbox, verifier or both" >&2; exit 2; }
case "$INSTANCE" in
  devnet) P=units; CORE_PORT=9660; NETWORK=devnet ;;
  mainnet) P=units-main; CORE_PORT=9760; NETWORK=mainnet ;;
  *) echo "INSTANCE is devnet or mainnet" >&2; exit 2 ;;
esac
want() { [ "$ROLE" = "$1" ] || [ "$ROLE" = both ]; }
SO=(-o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o LogLevel=ERROR)
[ -n "${SSH_INSECURE_TEST:-}" ] && SO+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null) || SO+=(-o StrictHostKeyChecking=accept-new)
HOPT=("${SO[@]}" -i "$SSH_KEY" -p "$HOST_PORT")
[ "$JUMP" != none ] && [ -z "$SITE_DIR" ] && HOPT+=(-o "ProxyCommand=ssh ${SO[*]} -i $SITE_KEY -W %h:%p $JUMP")
host() { ssh "${HOPT[@]}" "root@$HOST" "$@"; }
if [ -n "$SITE_DIR" ]; then
  SDIR="${SITE_DIR#local:}"; mkdir -p "$SDIR"
  site() { bash -c "$1"; }
  KDIR="$SDIR"; RUNAS=""; BUN="bun"; SREL="$REPO"; SETC="$SDIR"; SSTATE="$SDIR"
else
  site() { ssh "${SO[@]}" -i "$SITE_KEY" "$SITE" "$1"; }
  KDIR="/home/$P/.config/lineage/sandbox-hosts"; RUNAS="sudo -u $P -H"; BUN="/usr/local/bin/bun"; SREL="/opt/$P/current"; SETC="/etc/$P"; SSTATE="/var/lib/$P"
fi
step() { echo "== $*"; }
ENTRY="$([ "$HOST_PORT" = 22 ] && echo "$HOST" || echo "[$HOST]:$HOST_PORT")"

# ---------------------------------------------------------------------------------------------- remove
if [ "$MODE" = remove ]; then
  step "remove $NAME ($HOST) from the $INSTANCE instance"
  site "set -e; [ -f $KDIR/hosts.json ] && (cd $SREL && $RUNAS $BUN scripts/deploy/capacity-host/register.ts --file $KDIR/hosts.json --remove $NAME) || echo 'no sandbox hosts file'"
  if [ -z "$SITE_DIR" ]; then
    site "f=/home/units-cap-tunnel/.ssh/authorized_keys; [ -f \$f ] && { grep -v ' units-cap-$NAME\$' \$f > \$f.new || true; cat \$f.new > \$f; rm -f \$f.new; echo 'tunnel key removed from the site'; } || true"
  fi
  host 'for u in units-cap-verifier units-cap-verifier-2 units-cap-verifier-3 units-cap-verifier-4 units-cap-tunnel; do systemctl disable -q --now $u 2>/dev/null || true; done; echo "verifier and tunnel stopped and disabled (running replays were given the stop timeout to finish and reveal)"' || echo "host not reachable: nothing stopped there"
  echo "done: the runtime stops sending evaluations to $NAME within a minute. The verifier's key (/etc/units-cap/verifier.json on the host) and its bond are untouched."
  exit 0
fi

step "host $HOST ($NAME), $MODE, role $ROLE, instance $INSTANCE"
host true

if [ "$MODE" = full ]; then
  step "packages: docker.io, git, ufw, unzip, curl"
  host 'export DEBIAN_FRONTEND=noninteractive
    need=""; for p in docker.io git ufw unzip curl ca-certificates openssh-client unattended-upgrades; do dpkg -s $p >/dev/null 2>&1 || need="$need $p"; done
    if [ -n "$need" ]; then apt-get update -qq && apt-get install -y -qq $need >/dev/null; fi
    systemctl enable -q --now docker
    # security updates by themselves, as on the site (provision.sh there)
    printf "%s\n" "APT::Periodic::Update-Package-Lists \"1\";" "APT::Periodic::Unattended-Upgrade \"1\";" > /etc/apt/apt.conf.d/20auto-upgrades
    docker version --format "docker {{.Server.Version}}"'
  step "user units-cap (docker group; its key runs only the gateway)"
  host 'id units-cap >/dev/null 2>&1 || useradd --create-home --shell /bin/sh units-cap
    usermod -aG docker units-cap; passwd -l units-cap >/dev/null
    install -d -m 700 -o units-cap -g units-cap /home/units-cap/.ssh
    install -d -m 755 /opt/units-cap /opt/units-cap/releases
    install -d -m 750 -o units-cap -g units-cap /var/lib/units-cap
    install -d -m 750 -o root -g units-cap /etc/units-cap'
  step "sshd: keys only"
  host 'printf "%s\n" "# units capacity host (provision.sh)" "PasswordAuthentication no" "KbdInteractiveAuthentication no" "PermitRootLogin prohibit-password" > /etc/ssh/sshd_config.d/10-units-cap.conf
    sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true)'
fi

step "bun (the site's version)"
BUNV="$(site "$BUN --version")"
host "if [ \"\$(/usr/local/bin/bun --version 2>/dev/null)\" = '$BUNV' ]; then echo 'bun $BUNV present'; else
    export BUN_INSTALL=/opt/units-cap/bun; curl -fsSL https://bun.sh/install | bash -s 'bun-v$BUNV' >/dev/null 2>&1 && install -m 755 /opt/units-cap/bun/bin/bun /usr/local/bin/bun && echo \"bun \$(/usr/local/bin/bun --version) installed\"; fi"

step "release (the $INSTANCE instance's, with its re-pinned recipes)"
if [ -n "$SITE_DIR" ]; then
  REV="$(git -C "$REPO" rev-parse --short=12 HEAD)-local"
  pack() { (cd "$REPO" && { git ls-files; git ls-files --others --exclude-standard; } | grep -v -E '^(tests/|docs/|onchain/|research/|work/)' | grep -E -v '^apps/[^/]+/.+/' | while read -r f; do [ -f "$f" ] && echo "$f"; done | tar -czf - -T -); }
else
  REV="$(site "basename \$(readlink -f $SREL)")"
  # the apps are not shipped, only their manifests: the lockfile names every workspace and the install is frozen
  pack() { site "cd $SREL && { find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -not -path './apps/*' -not -path './tests/*' -not -path './docs/*' -not -path './onchain/*'; find ./apps -mindepth 2 -maxdepth 2 -type f -not -name '*.lock'; } | tar -czf - -T -"; }
fi
if [ "$(host "cat /opt/units-cap/releases/$REV/.units-release 2>/dev/null; true")" = "$REV" ] && [ -z "$SITE_DIR" ]; then
  echo "unchanged ($REV)"
else
  pack | host "set -e; d=/opt/units-cap/releases/$REV; rm -rf \$d.new; mkdir -p \$d.new; tar -xzf - -C \$d.new; chown -R units-cap:units-cap \$d.new
    cd \$d.new && su -s /bin/sh units-cap -c 'cd '\$d'.new && HOME=/home/units-cap bun install --production --ignore-scripts > /tmp/units-cap-install.log 2>&1' || { echo 'bun install failed:' >&2; tail -5 /tmp/units-cap-install.log >&2; exit 1; }
    echo $REV > \$d.new/.units-release; rm -rf \$d; mv \$d.new \$d; ln -sfn \$d /opt/units-cap/current
    # older releases go only when no process still runs from them: a verifier whose release directory vanished
    # could not start a sandbox any more and reported that as a failed base build (2026-10-12, cap-nyc1)
    for old in \$(ls -d /opt/units-cap/releases/* | grep -v \"/$REV\$\"); do
      case \"\$old\" in *.new) continue ;; esac
      inuse=0; for c in /proc/[0-9]*/cwd; do [ \"\$(readlink \$c 2>/dev/null)\" = \"\$old\" ] && inuse=1 && break; done
      [ \$inuse = 1 ] && echo \"kept \$(basename \$old): a process still runs from it\" || rm -rf \"\$old\"
    done
    echo \"release $REV installed\""
fi

step "kit tools (sizing and the capacity-host scripts of this checkout, laid over the release; the worker and sandbox code stay the site's)"
(cd "$REPO" && tar -czf - scripts/deploy/sizing.ts scripts/deploy/capacity-host) | host 'tar -xzf - -C /opt/units-cap/current && chown -R units-cap:units-cap /opt/units-cap/current/scripts/deploy/sizing.ts /opt/units-cap/current/scripts/deploy/capacity-host'
host '[ -f /opt/units-cap/current/packages/worker/src/eval-job.ts ] && grep -q PHASE_PREFIX /opt/units-cap/current/packages/sandbox/src/remote.ts 2>/dev/null && echo "release has the evaluation job runner" || echo "NOTE: this release has no evaluation job runner yet (the site runs a release from before the scale-out lane): the host cannot take evaluations until the site is deployed and this host updated"'

step "sandbox images (copied from the site's Docker, so the ids are the ones the recipes pin)"
RECIPES="${RECIPES:-$(site "sed -n 's/^UNITS_RECIPES=//p' $SETC/site.env 2>/dev/null | tail -1")}"
RECIPES="${RECIPES:-fixture-b58,base58-py,minbpe}"
REFS="$(host "cd /opt/units-cap/current && for r in $(echo "$RECIPES" | tr ',' ' '); do grep -h '^image:' recipes/\$r/recipe.yml 2>/dev/null; done" | sed -n 's/^image: *"\{0,1\}\([^"@]*\)@sha256:\([0-9a-f]*\).*/\1 \2/p' | sort -u)"
[ -n "$REFS" ] || { echo "no image pin found for recipes $RECIPES in the release" >&2; exit 1; }
# on fd 3: the ssh commands inside the loop would otherwise read the list as their stdin
while read -r ref id <&3; do
  [ -n "$ref" ] || continue
  # the id the site's Docker has under that reference (a local dry run resolves the pin through its pin map)
  sid="$(site "docker image inspect --format '{{.Id}}' $ref 2>/dev/null | sed 's/^sha256://'" < /dev/null || true)"
  [ -n "$sid" ] || { echo "the site has no image $ref" >&2; exit 1; }
  if [ -z "$SITE_DIR" ] && [ "$sid" != "$id" ]; then echo "the site's $ref is $sid but the release pins $id" >&2; exit 1; fi
  if [ "$(host "docker image inspect --format '{{.Id}}' $ref 2>/dev/null | sed 's/^sha256://'; true" < /dev/null)" = "$sid" ]; then
    echo "$ref unchanged (${sid:0:12})"
  else
    echo "copying $ref (${sid:0:12})"
    site "docker save $ref | gzip -1" < /dev/null | host "gunzip | docker load >/dev/null"
    [ "$(host "docker image inspect --format '{{.Id}}' $ref | sed 's/^sha256://'" < /dev/null)" = "$sid" ] || { echo "$ref arrived with another id" >&2; exit 1; }
  fi
done 3<<< "$REFS"
if [ -n "${IMAGES_MAP:-}" ]; then host 'cat > /var/lib/units-cap/local-images.json && chown units-cap:units-cap /var/lib/units-cap/local-images.json' < "$IMAGES_MAP"; fi

step "dependency layers (copied from the site: a layer prepared here can get another digest than the snapshot's, and replays then refuse)"
if [ -n "$SITE_DIR" ]; then SDEPS="${UNITS_HOME:-$HOME/.lineage}/deps"; else SDEPS="/home/$P/.lineage/deps"; fi
KEYS="$(host "cd /opt/units-cap/current && runuser -u units-cap -- env HOME=/home/units-cap bun scripts/deploy/capacity-host/deps-keys.ts $RECIPES")"
while read -r key rname <&3; do
  [ -n "$key" ] || continue
  sd="$(site "cat $SDEPS/$key/.lineage-digest 2>/dev/null; true" < /dev/null)"
  if [ -z "$sd" ]; then echo "$rname: the site has no layer yet (the host prepares its own on first use)"; continue; fi
  hd="$(host "cat /var/lib/units-cap/deps/$key/.lineage-digest 2>/dev/null; true" < /dev/null)"
  if [ "$hd" = "$sd" ]; then echo "$rname unchanged (${sd:0:12})"; continue; fi
  echo "copying the layer of $rname (${sd:0:12})${hd:+; the layer prepared on this host had digest ${hd:0:12} and is replaced}"
  site "tar -C $SDEPS -czf - $key" < /dev/null | host "set -e; mkdir -p /var/lib/units-cap/deps; rm -rf /var/lib/units-cap/deps/$key; tar -xzf - -C /var/lib/units-cap/deps; chown -R units-cap:units-cap /var/lib/units-cap/deps; chmod -R a+rX /var/lib/units-cap/deps/$key"
done 3<<< "$KEYS"

step "repository mirrors (cloned once now, one after the other: two first evaluations at once would race for the same clone)"
host "cd /opt/units-cap/current && runuser -u units-cap -- env HOME=/home/units-cap UNITS_HOME=/var/lib/units-cap bun scripts/deploy/capacity-host/warm.ts $RECIPES" < /dev/null

step "slots from this host's size, and the gateway"
SROLE="$([ "$ROLE" = sandbox ] && echo shard || echo "$ROLE")"
host "set -e; cd /opt/units-cap/current
  { echo '# written by scripts/deploy/capacity-host/provision.sh from this host size (scripts/deploy/sizing.ts)'
    echo UNITS_HOME=/var/lib/units-cap; echo UNITS_SANDBOX_HOST=$NAME; echo UNITS_NETWORK=$NETWORK
    bun scripts/deploy/sizing.ts --role $SROLE --verifiers $VERIFIERS --env
    echo UNITS_LOCAL_IMAGES=$([ -n "${IMAGES_MAP:-}" ] && echo /var/lib/units-cap/local-images.json || echo off)
  } > /etc/units-cap/env.new
  grep -q '^UNITS_SANDBOX_SLOTS=[0-9]' /etc/units-cap/env.new
  chown root:units-cap /etc/units-cap/env.new; chmod 640 /etc/units-cap/env.new; mv /etc/units-cap/env.new /etc/units-cap/env
  echo \"\$(nproc) cores: \$(grep SLOTS= /etc/units-cap/env | tr '\n' ' ')\""
host 'cat > /usr/local/bin/units-sandbox-gw.new && chmod 755 /usr/local/bin/units-sandbox-gw.new && mv /usr/local/bin/units-sandbox-gw.new /usr/local/bin/units-sandbox-gw' < "$REPO/scripts/deploy/capacity-host/units-sandbox-gw"

if [ "$MODE" = full ] && [ "${DRY_RUN:-0}" != 1 ]; then
  step "firewall: ssh only$([ "$SSH_FROM" = site ] && echo ", from the site ($SITE_IP)")"
  host "ufw --force reset >/dev/null; ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
    $([ "$SSH_FROM" = site ] && echo "ufw allow proto tcp from $SITE_IP to any port 22 comment units-site" || echo "ufw allow proto tcp to any port 22 comment ssh") >/dev/null; ufw --force enable >/dev/null; ufw status | sed -n '1,8p'"
fi

# --------------------------------------------------------------------------------------------- sandbox
if want sandbox && [ "$ATTACH" = 1 ]; then
  step "site: the runtime's key for sandbox hosts"
  site "set -e; install -d -m 700 $([ -n "$RUNAS" ] && echo "-o $P -g $P") $KDIR
    [ -f $KDIR/id_ed25519 ] || $RUNAS ssh-keygen -q -t ed25519 -N '' -C units-site-sandboxes -f $KDIR/id_ed25519
    [ -f $KDIR/known_hosts ] || $RUNAS touch $KDIR/known_hosts"
  PUB="$(site "cat $KDIR/id_ed25519.pub")"
  step "host: units-cap's authorized_keys runs only the gateway"
  printf 'command="/usr/local/bin/units-sandbox-gw",restrict %s\n' "$PUB" | host 'cat > /home/units-cap/.ssh/authorized_keys && chown units-cap:units-cap /home/units-cap/.ssh/authorized_keys && chmod 600 /home/units-cap/.ssh/authorized_keys'
  HK="$(host 'cat /etc/ssh/ssh_host_ed25519_key.pub' | awk '{print $1" "$2}')"
  step "site: known_hosts entry for $ENTRY (the host's own key, read over root ssh)"
  site "set -e; f=$KDIR/known_hosts; awk -v e='$ENTRY' '\$1 != e' \$f > \$f.new; echo '$ENTRY $HK' >> \$f.new; cat \$f.new > \$f; rm -f \$f.new"
  step "check from the site, as the runtime connects, and register"
  CK="ssh -i $KDIR/id_ed25519 -p $HOST_PORT -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KDIR/known_hosts -o ConnectTimeout=10 -o LogLevel=ERROR units-cap@$HOST"
  HEALTH="$(site "$RUNAS $CK health")"
  echo "$HEALTH"
  echo "$HEALTH" | grep -q '"docker":true' && echo "PASS health over the runtime's key" || { echo "FAIL health over the runtime's key" >&2; exit 1; }
  if site "$RUNAS $CK id" >/dev/null 2>&1; then echo "FAIL the runtime's key ran a command outside the gateway" >&2; exit 1; else echo "PASS a command outside the gateway is refused"; fi
  site "cd $SREL && $RUNAS $BUN scripts/deploy/capacity-host/register.ts --file $KDIR/hosts.json --name $NAME --address $HOST --port $HOST_PORT --key $KDIR/id_ed25519 --known-hosts $KDIR/known_hosts --health '$HEALTH'"
fi

# -------------------------------------------------------------------------------------------- verifier
if want verifier; then
  step "verifier: its own key (made on the host, never copied), capabilities, units"
  site "cat $SSTATE/site/caps.json 2>/dev/null || (cd $SREL && $BUN packages/worker/src/main.ts doctor)" | host 'cat > /etc/units-cap/caps.json && chown root:units-cap /etc/units-cap/caps.json && chmod 644 /etc/units-cap/caps.json'
  for n in $(seq 1 "$VERIFIERS"); do
    sfx="$([ "$n" = 1 ] && echo "" || echo "-$n")"
    host "set -e; if [ ! -f /etc/units-cap/verifier$sfx.json ]; then
        cd /opt/units-cap/current && su -s /bin/sh units-cap -c 'HOME=/home/units-cap bun packages/worker/src/main.ts keygen --out /var/lib/units-cap/verifier$sfx.json.new' >/dev/null
        install -m 600 -o units-cap -g units-cap /var/lib/units-cap/verifier$sfx.json.new /etc/units-cap/verifier$sfx.json; rm -f /var/lib/units-cap/verifier$sfx.json.new
      fi; stat -c 'key %n %U %a' /etc/units-cap/verifier$sfx.json"
  done
  if [ -z "${CORE_URL:-}" ] && [ "$ATTACH" != 1 ]; then CORE_URL="http://127.0.0.1:$CORE_PORT"; echo "ATTACH=0: no tunnel yet (the attach run makes it)"
  elif [ -z "${CORE_URL:-}" ]; then
    CORE_URL="http://127.0.0.1:$CORE_PORT"
    step "tunnel to the site's Core (127.0.0.1:$CORE_PORT there, the same port here)"
    host 'set -e; [ -f /etc/units-cap/tunnel_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C units-cap-'"$NAME"' -f /etc/units-cap/tunnel_ed25519
      chown units-cap:units-cap /etc/units-cap/tunnel_ed25519 /etc/units-cap/tunnel_ed25519.pub; chmod 600 /etc/units-cap/tunnel_ed25519'
    TPUB="$(host 'cat /etc/units-cap/tunnel_ed25519.pub')"
    SHK="$(site "cat /etc/ssh/ssh_host_ed25519_key.pub" | awk '{print $1" "$2}')"
    # on the site: an account that can do nothing but forward to the instance's Core port
    site "set -e; id units-cap-tunnel >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin units-cap-tunnel
      passwd -l units-cap-tunnel >/dev/null; install -d -m 700 -o units-cap-tunnel -g units-cap-tunnel /home/units-cap-tunnel/.ssh
      f=/home/units-cap-tunnel/.ssh/authorized_keys; touch \$f; grep -v ' units-cap-$NAME\$' \$f > \$f.new || true
      echo 'restrict,port-forwarding,permitopen=\"127.0.0.1:9660\",permitopen=\"127.0.0.1:9760\",command=\"/bin/false\" $TPUB' >> \$f.new
      cat \$f.new > \$f; rm -f \$f.new; chown units-cap-tunnel:units-cap-tunnel \$f; chmod 600 \$f
      ufw status 2>/dev/null | grep -q 'Status: active' && ufw allow proto tcp from $HOST to any port 22 comment units-cap-$NAME >/dev/null || true"
    host "echo '$SITE_IP $SHK' > /etc/units-cap/site_known_hosts; chmod 644 /etc/units-cap/site_known_hosts
      cat > /etc/systemd/system/units-cap-tunnel.service <<UNIT
[Unit]
Description=units capacity host: tunnel to the site's Core ($INSTANCE)
After=network-online.target
Wants=network-online.target
[Service]
User=units-cap
ExecStart=/usr/bin/ssh -N -i /etc/units-cap/tunnel_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/units-cap/site_known_hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:$CORE_PORT:127.0.0.1:$CORE_PORT units-cap-tunnel@$SITE_IP
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload; systemctl enable -q --now units-cap-tunnel; sleep 3
      curl -fsS -m 10 http://127.0.0.1:$CORE_PORT/v1/health >/dev/null && echo 'PASS Core answers through the tunnel' || { echo 'FAIL Core does not answer through the tunnel' >&2; exit 1; }"
  fi
  RSLOTS="$(host "sed -n 's/^UNITS_REPLAY_SLOTS=//p' /etc/units-cap/env")"
  for n in $(seq 1 "$VERIFIERS"); do
    sfx="$([ "$n" = 1 ] && echo "" || echo "-$n")"
    host "cat > /etc/systemd/system/units-cap-verifier$sfx.service <<UNIT
[Unit]
Description=units capacity host: verifier $NAME$sfx ($INSTANCE)
After=docker.service network-online.target units-cap-tunnel.service
Wants=network-online.target
[Service]
User=units-cap
Group=units-cap
SupplementaryGroups=docker
WorkingDirectory=/opt/units-cap/current
Environment=HOME=/home/units-cap PATH=/usr/local/bin:/usr/bin:/bin UNITS_CORE_RETRY_MS=30000
EnvironmentFile=/etc/units-cap/env
# a stop finishes the running replays and reveals what was committed (the same timeout as the site's verifiers)
KillSignal=SIGTERM
TimeoutStopSec=2700
NoNewPrivileges=yes
Restart=always
RestartSec=5
MemoryMax=4G
TasksMax=4096
ExecStart=/usr/local/bin/bun packages/worker/src/main.ts run --core $CORE_URL --key /etc/units-cap/verifier$sfx.json --capabilities /etc/units-cap/caps.json --interval 2000
[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload"
    IDS="$(host "cd /opt/units-cap/current && runuser -u units-cap -- env HOME=/home/units-cap bun scripts/deploy/capacity-host/verifier-id.ts /etc/units-cap/verifier$sfx.json /etc/units-cap/caps.json")"
    VID="$(echo "$IDS" | sed -n 1p)"; CAPS_DIGEST="$(echo "$IDS" | sed -n 2p)"
    if [ "${START:-0}" = 1 ]; then
      # a running verifier moves to the new release (it finishes and reveals what it is doing first)
      host "systemctl enable -q units-cap-verifier$sfx; if [ \"\$(readlink /proc/\$(systemctl show units-cap-verifier$sfx -p MainPID --value)/cwd 2>/dev/null)\" = \"\$(readlink -f /opt/units-cap/current)\" ]; then echo 'already on this release'; else systemctl restart units-cap-verifier$sfx; fi; sleep 2; systemctl is-active units-cap-verifier$sfx"
    else
      host "systemctl is-active units-cap-verifier$sfx 2>/dev/null || true" | grep -qx active && host "[ \"\$(readlink /proc/\$(systemctl show units-cap-verifier$sfx -p MainPID --value)/cwd 2>/dev/null)\" = \"\$(readlink -f /opt/units-cap/current)\" ] || { echo 'units-cap-verifier$sfx runs an older release: restarting it on the new one'; systemctl restart --no-block units-cap-verifier$sfx; }" || true
    fi
    cat <<STEPS

== verifier $NAME$sfx: what the owner does next (chain transactions; nothing here sends one)
   verifier agent id      $VID
   capabilities digest    $CAPS_DIGEST   (the $INSTANCE instance's caps.json, the same its site verifiers registered)
   replays at once        $RSLOTS
1. Plan, on the machine that holds the owner key (it reads the burn, the bond and the mint from the registry):
     bun scripts/deploy/capacity-host/verifier-chain.ts --registry REGISTRY_PROGRAM_ID --agents $VID --caps-digest $CAPS_DIGEST --plan
2. Register (three steps inside about a minute, the life of a blockhash), then bond:
     owner machine:  ... verifier-chain.ts --registry REGISTRY_PROGRAM_ID --register $VID --caps-digest $CAPS_DIGEST     (prints the owner-signed transaction)
     this host:      ssh root@$HOST 'cd /opt/units-cap/current && runuser -u units-cap -- env HOME=/home/units-cap UNITS_NETWORK=$NETWORK UNITS_PROFILE_LOCAL=/etc/units-cap/profile.local.json bun scripts/deploy/capacity-host/cosign-register.ts --key /etc/units-cap/verifier$sfx.json --tx TRANSACTION'     (prints it co-signed; no RPC on the host)
     any machine with the RPC:  ... verifier-chain.ts --registry REGISTRY_PROGRAM_ID --send CO_SIGNED_TRANSACTION
     owner machine:  ... verifier-chain.ts --registry REGISTRY_PROGRAM_ID --bond $VID
   The host needs the deployment's public profile overlay at /etc/units-cap/profile.local.json (program ids and quote; on the site /etc/$P/profile.local.json).
   (Simulated Core only: bun packages/worker/src/main.ts register --core $CORE_URL --key /etc/units-cap/verifier$sfx.json --capabilities /etc/units-cap/caps.json, then bond.)
3. Let Core hand it enough work: on the site, /etc/$P/sizing.json needs "max_open_replays" of at least $RSLOTS
   (it is the most any verifier may hold), then deploy the instance.
4. Start it:   START=1 VERIFIERS=$VERIFIERS ROLE=$ROLE INSTANCE=$INSTANCE NAME=$NAME $0 $HOST update
5. Check:      ssh root@$HOST 'cd /opt/units-cap/current && runuser -u units-cap -- env HOME=/home/units-cap UNITS_NETWORK=$NETWORK bun packages/worker/src/main.ts status --core $CORE_URL --key /etc/units-cap/verifier$sfx.json'
   It qualifies on each unit first (one base run per unit), then takes replays.
STEPS
  done
fi

if [ "$ATTACH" = 1 ]; then echo "done: $NAME ($HOST), role $ROLE, instance $INSTANCE$(want sandbox && echo "; the runtime sends it evaluations within a minute")"
else echo "prepared: $NAME ($HOST), role $ROLE, instance $INSTANCE; NOT attached (nothing was written on the site). Attach: ROLE=$ROLE INSTANCE=$INSTANCE NAME=$NAME $0 $HOST update"; fi
