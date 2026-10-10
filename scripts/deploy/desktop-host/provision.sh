#!/usr/bin/env bash
# Lineage desktop host: provision (or update) a dedicated server that runs agent desktops for the site
# (docs/plans/AGENT-DESKTOPS.md "Desktop hosts", docs/DEPLOY-SITE.md "Desktop hosts"). Idempotent:
# run it again at any time; `update` redoes only the gateway, the image and the proxy.
#
#   scripts/deploy/desktop-host/provision.sh <host-ip> [full|update]
#
# Environment (defaults in brackets):
#   SSH_KEY      the owner's key for root on the new host [~/.ssh/lineage_site]
#   NAME         the host's name in the site's config, a-z 0-9 - [desk-<last part of the ip>]
#   SITE         root ssh of the site [root@157.245.71.188]; SITE_KEY its key [~/.ssh/lineage_site]
#   SITE_IP      the address the host sees the site's connections from [the host part of SITE]
#   JUMP         reach the host through this ssh hop [the site; after the firewall only the site
#                reaches the host]; JUMP=none connects directly
#   HOST_PORT    the host's ssh port [22]
#   SITE_DIR     local:<dir> plays the site on this machine (dry runs): the site's key, known_hosts
#                and hosts file go to <dir>, the site's commands run here
#   DRY_RUN=1    no apt upgrade of the base system (dry runs)
#
# What it does, in order:
#   host: Docker (docker.io), python3, ufw; the lineage-desk user (docker group, no password, no
#         shell login: its key runs only /usr/local/bin/lineage-desk-gw); the gateway; the
#         lineage/desktop image built on the host from images/desktop (rebuilt only when that tree
#         changed); the internal desktop network and the allowlist proxy; sshd without passwords;
#         ufw: deny all incoming but ssh from the site.
#   site: a key for the runtime (lineage user) kept in ~lineage/.config/lineage/desktop-hosts/, the
#         host's own host key in known_hosts there (read over the owner's root ssh, not scanned), and
#         the host in hosts.json with desktops_max from its measured CPUs and memory
#         (packages/desktop/src/placement.ts hostCapacity). The running runtime re-reads hosts.json
#         every minute: new desktops go to the host from then on, no restart.
#   check: as the runtime would, from the site: health answers; a command outside the gateway is
#         refused.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
HOST="${1:?usage: provision.sh <host-ip> [full|update]}"
MODE="${2:-full}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/lineage_site}"
SITE="${SITE:-root@157.245.71.188}"
SITE_KEY="${SITE_KEY:-$HOME/.ssh/lineage_site}"
SITE_IP="${SITE_IP:-${SITE#*@}}"
HOST_PORT="${HOST_PORT:-22}"
NAME="${NAME:-desk-${HOST##*.}}"
SITE_DIR="${SITE_DIR:-}"
JUMP="${JUMP:-$SITE}"
[[ "$NAME" =~ ^[a-z0-9-]{1,32}$ ]] || { echo "NAME must be a-z 0-9 - (got $NAME)" >&2; exit 2; }
[[ "$MODE" =~ ^(full|update)$ ]] || { echo "mode is full or update" >&2; exit 2; }
SO=(-o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o LogLevel=ERROR)
[ -n "${SSH_INSECURE_TEST:-}" ] && SO+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null) || SO+=(-o StrictHostKeyChecking=accept-new)
HOPT=("${SO[@]}" -i "$SSH_KEY" -p "$HOST_PORT")
[ "$JUMP" != none ] && [ -z "$SITE_DIR" ] && HOPT+=(-o "ProxyCommand=ssh ${SO[*]} -i $SITE_KEY -W %h:%p $JUMP")
host() { ssh "${HOPT[@]}" "root@$HOST" "$@"; }
# the site: over root ssh, or this machine for a dry run (SITE_DIR=local:<dir>)
if [ -n "$SITE_DIR" ]; then
  SDIR="${SITE_DIR#local:}"; mkdir -p "$SDIR"
  site() { bash -c "$1"; }
  KDIR="$SDIR"; RUNAS=""; BUN="bun"; SREPO="$REPO"
else
  site() { ssh "${SO[@]}" -i "$SITE_KEY" "$SITE" "$1"; }
  KDIR="/home/lineage/.config/lineage/desktop-hosts"; RUNAS="sudo -u lineage -H"; BUN="/usr/local/bin/bun"; SREPO="/opt/lineage/current"
fi
step() { echo "== $*"; }

step "host $HOST ($NAME), $MODE"
host true

if [ "$MODE" = full ]; then
  step "packages: docker.io, python3, ufw"
  host 'export DEBIAN_FRONTEND=noninteractive
    need=""; for p in docker.io python3 ufw; do dpkg -s $p >/dev/null 2>&1 || need="$need $p"; done
    if [ -n "$need" ]; then apt-get update -qq && apt-get install -y -qq $need >/dev/null; fi
    systemctl enable -q --now docker
    docker version --format "docker {{.Server.Version}}"'
  step "user lineage-desk (docker group; its key runs only the gateway)"
  host 'id lineage-desk >/dev/null 2>&1 || useradd --create-home --shell /bin/sh lineage-desk
    usermod -aG docker lineage-desk; passwd -l lineage-desk >/dev/null
    install -d -m 700 -o lineage-desk -g lineage-desk /home/lineage-desk/.ssh
    install -d -m 755 /var/lib/lineage-desk'
  step "sshd: keys only"
  host 'printf "%s\n" "# lineage desktop host (provision.sh)" "PasswordAuthentication no" "KbdInteractiveAuthentication no" "PermitRootLogin prohibit-password" > /etc/ssh/sshd_config.d/10-lineage-desk.conf
    sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true)'
fi

step "gateway /usr/local/bin/lineage-desk-gw"
host 'cat > /usr/local/bin/lineage-desk-gw.new && chmod 755 /usr/local/bin/lineage-desk-gw.new && mv /usr/local/bin/lineage-desk-gw.new /usr/local/bin/lineage-desk-gw' < "$REPO/scripts/deploy/desktop-host/lineage-desk-gw"

step "image lineage/desktop (built on the host from images/desktop)"
SUM="$(cd "$REPO" && find images/desktop -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-64)"
if [ "$(host 'cat /var/lib/lineage-desk/image.sum 2>/dev/null; true')" = "$SUM" ] && host 'docker image inspect lineage/desktop >/dev/null 2>&1'; then
  echo "unchanged ($SUM)"
else
  tar -C "$REPO/images/desktop" -czf - . | host "rm -rf /var/lib/lineage-desk/build && mkdir -p /var/lib/lineage-desk/build && tar -xzf - -C /var/lib/lineage-desk/build \
    && docker build -q --label lineage=1 -t lineage/desktop /var/lib/lineage-desk/build && echo $SUM > /var/lib/lineage-desk/image.sum"
fi

step "desktop network and allowlist proxy"
host 'docker network inspect lineage-desk >/dev/null 2>&1 || docker network create --internal --label lineage=1 lineage-desk >/dev/null
  want=github.com,githubusercontent.com,githubassets.com
  if ! docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" lineage-desk-proxy 2>/dev/null | grep -qx "DESK_ALLOW=$want" \
     || [ "$(docker inspect --format "{{.Image}}" lineage-desk-proxy 2>/dev/null)" != "$(docker image inspect --format "{{.Id}}" lineage/desktop)" ]; then
    docker rm -f lineage-desk-proxy >/dev/null 2>&1 || true
    docker run -d --name lineage-desk-proxy --label lineage=1 --restart unless-stopped --read-only --tmpfs /tmp:size=16m --cap-drop ALL \
      --security-opt no-new-privileges --user 1000:1000 --memory 128m --pids-limit 128 -e DESK_ALLOW=$want \
      --entrypoint /usr/local/bin/desk-proxy lineage/desktop >/dev/null
    docker network connect lineage-desk lineage-desk-proxy
  fi
  docker inspect --format "proxy {{.State.Status}}" lineage-desk-proxy'

if [ "$MODE" = full ]; then
  step "firewall: only the site ($SITE_IP) reaches ssh"
  host "ufw --force reset >/dev/null; ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
    ufw allow proto tcp from $SITE_IP to any port 22 comment lineage-site >/dev/null; ufw --force enable >/dev/null; ufw status | sed -n '1,8p'"
fi

step "site: the runtime's key for this host"
site "set -e; install -d -m 700 $([ -n "$RUNAS" ] && echo '-o lineage -g lineage') $KDIR
  [ -f $KDIR/id_ed25519 ] || $RUNAS ssh-keygen -q -t ed25519 -N '' -C lineage-site-desktops -f $KDIR/id_ed25519
  [ -f $KDIR/known_hosts ] || $RUNAS touch $KDIR/known_hosts"
PUB="$(site "cat $KDIR/id_ed25519.pub")"
step "host: lineage-desk's authorized_keys runs only the gateway"
printf 'command="/usr/local/bin/lineage-desk-gw",restrict %s\n' "$PUB" | host 'cat > /home/lineage-desk/.ssh/authorized_keys && chown lineage-desk:lineage-desk /home/lineage-desk/.ssh/authorized_keys && chmod 600 /home/lineage-desk/.ssh/authorized_keys'
HK="$(host 'cat /etc/ssh/ssh_host_ed25519_key.pub' | awk '{print $1" "$2}')"
ENTRY="$([ "$HOST_PORT" = 22 ] && echo "$HOST" || echo "[$HOST]:$HOST_PORT")"
step "site: known_hosts entry for $ENTRY (the host's own key, read over root ssh)"
site "set -e; f=$KDIR/known_hosts; awk -v e='$ENTRY' '\$1 != e' \$f > \$f.new; echo '$ENTRY $HK' >> \$f.new; cat \$f.new > \$f; rm -f \$f.new"

step "measure the host and register it"
HEALTH="$(host "su -s /bin/sh lineage-desk -c 'SSH_ORIGINAL_COMMAND=health /usr/local/bin/lineage-desk-gw'")"
echo "$HEALTH"
site "cd $SREPO && $RUNAS $BUN scripts/deploy/desktop-host/register.ts --file $KDIR/hosts.json --name $NAME --address $HOST --port $HOST_PORT --key $KDIR/id_ed25519 --known-hosts $KDIR/known_hosts --health '$HEALTH'"

step "check from the site, as the runtime connects"
CK="ssh -i $KDIR/id_ed25519 -p $HOST_PORT -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KDIR/known_hosts -o ConnectTimeout=10 -o LogLevel=ERROR lineage-desk@$HOST"
site "$RUNAS $CK health" | grep -q '"image": "sha256:' && echo "PASS health over the runtime's key" || { echo "FAIL health over the runtime's key" >&2; exit 1; }
if site "$RUNAS $CK id" >/dev/null 2>&1; then echo "FAIL the runtime's key ran a command outside the gateway" >&2; exit 1; else echo "PASS a command outside the gateway is refused"; fi
echo "done: $NAME ($HOST) registered; the runtime picks it up within a minute"
