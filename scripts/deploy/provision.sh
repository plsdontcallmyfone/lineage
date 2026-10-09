#!/usr/bin/env bash
# Lineage site: one-time and idempotent box setup, run as root on a fresh Ubuntu 24.04 server.
# deploy.sh copies this file to the server and runs it; running it again changes nothing that is
# already in place. See docs/DEPLOY-SITE.md.
#
#   bash provision.sh [--no-docker]
#
# Installs: base packages, the unprivileged user `lineage` (root's authorized keys, no password, no
# sudo), ufw (deny incoming; 22, 80, 443), fail2ban for sshd, unattended security upgrades, a
# swapfile when RAM is under 8 GiB (not inside a container), journald size cap, Docker (docker.io
# from Ubuntu, `lineage` in the docker group; skipped with --no-docker, which the dry run uses),
# Bun pinned to BUN_VERSION (checksum verified against the release's SHASUMS256.txt) and Caddy from
# the Caddy project's apt repository.
set -euo pipefail
BUN_VERSION="${BUN_VERSION:-1.3.13}"
DOCKER=1
for a in "$@"; do
  case "$a" in
    --no-docker) DOCKER=0 ;;
    *) echo "unknown argument $a" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=a
. /etc/os-release
echo "== provision: $PRETTY_NAME $(uname -m)"
case "$VERSION_ID" in 24.04) ;; *) echo "note: written for Ubuntu 24.04, this is $VERSION_ID" ;; esac
IN_CONTAINER=0
if systemd-detect-virt --container >/dev/null 2>&1; then IN_CONTAINER=1; fi

# the Caddy project's apt repository (dl.cloudsmith.io) answered 402 on 2026-10-09; an apt source that
# fails must not stop provisioning of a box that already has everything
apt-get update -qq || echo "note: apt-get update reported an error (an unreachable source); continuing"
apt-get install -y -qq ca-certificates curl gnupg git unzip jq lsof sqlite3 ufw fail2ban unattended-upgrades \
  debian-keyring debian-archive-keyring apt-transport-https openssh-server >/dev/null
echo "packages ok"

# ---------------------------------------------------------------- user
if ! id lineage >/dev/null 2>&1; then adduser --disabled-password --gecos "" lineage >/dev/null; fi
if id -nG lineage | grep -qw -E 'sudo|admin'; then echo "lineage is in a sudo group; refusing" >&2; exit 1; fi
install -d -m 700 -o lineage -g lineage /home/lineage/.ssh /home/lineage/.config /home/lineage/.config/lineage \
  /home/lineage/.config/lineage/devnet /home/lineage/.config/lineage/site
if [ -f /root/.ssh/authorized_keys ]; then install -m 600 -o lineage -g lineage /root/.ssh/authorized_keys /home/lineage/.ssh/authorized_keys; fi
chmod 750 /home/lineage
install -d -m 755 -o lineage -g lineage /opt/lineage /opt/lineage/releases
install -d -m 750 -o lineage -g lineage /var/lib/lineage /var/lib/lineage/core /var/lib/lineage/site /var/lib/lineage/canaries \
  /var/lib/lineage/backups /var/lib/lineage/runtime
echo "user lineage ok"

# ---------------------------------------------------------------- firewall, fail2ban, upgrades
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in 22/tcp 80/tcp 443/tcp; do ufw allow "$p" >/dev/null; done
ufw --force enable >/dev/null
echo "ufw: $(ufw status | head -1)"
cat > /etc/fail2ban/jail.d/lineage-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban >/dev/null 2>&1 || true
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/lineage.conf
systemctl restart systemd-journald || true
# sshd: keys only for root. Passwords stay as they are unless root already logs in with a key
# (this script reached the box over a key, so that holds whenever deploy.sh runs it).
if [ -s /root/.ssh/authorized_keys ]; then
  printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/10-lineage.conf
  systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true
fi
echo "fail2ban, unattended upgrades, journald cap, sshd keys-only ok"

# ---------------------------------------------------------------- swap
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$IN_CONTAINER" = 1 ]; then
  echo "swap: skipped (container)"
elif [ "$MEM_MB" -lt 7800 ] && ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10; echo 'vm.swappiness=10' > /etc/sysctl.d/90-lineage-swap.conf
  echo "swap: 4 GiB swapfile added (RAM ${MEM_MB} MiB)"
else
  echo "swap: unchanged (RAM ${MEM_MB} MiB, $(swapon --show --noheadings | wc -l) swap devices)"
fi

# ---------------------------------------------------------------- docker
if [ "$DOCKER" = 1 ]; then
  if ! command -v docker >/dev/null; then apt-get install -y -qq docker.io docker-buildx >/dev/null; fi
  install -d /etc/docker
  if [ ! -f /etc/docker/daemon.json ]; then
    printf '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }\n' > /etc/docker/daemon.json
  fi
  systemctl enable --now docker >/dev/null
  usermod -aG docker lineage
  echo "docker: $(docker version --format '{{.Server.Version}} {{.Server.Arch}}')"
else
  echo "docker: skipped (--no-docker)"
fi

# ---------------------------------------------------------------- bun (pinned, checksum verified)
if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  case "$(uname -m)" in
    x86_64) if grep -qw avx2 /proc/cpuinfo; then ASSET=bun-linux-x64; else ASSET=bun-linux-x64-baseline; fi ;;
    aarch64) ASSET=bun-linux-aarch64 ;;
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  T=$(mktemp -d)
  BASE="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
  curl -fsSL -o "$T/$ASSET.zip" "$BASE/$ASSET.zip"
  curl -fsSL -o "$T/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
  WANT=$(awk -v f="$ASSET.zip" '$2 == f {print $1}' "$T/SHASUMS256.txt")
  GOT=$(sha256sum "$T/$ASSET.zip" | awk '{print $1}')
  [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "bun checksum mismatch for $ASSET.zip" >&2; exit 1; }
  unzip -q -o "$T/$ASSET.zip" -d "$T"
  install -m 755 "$T/$ASSET/bun" /usr/local/bin/bun
  rm -rf "$T"
fi
echo "bun $(bun --version)"

# ---------------------------------------------------------------- caddy
if ! command -v caddy >/dev/null; then
  if curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update -qq && apt-get install -y -qq caddy >/dev/null; then :; else
    # fallback: Ubuntu's own caddy package (universe)
    rm -f /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq || true
    apt-get install -y -qq caddy >/dev/null
  fi
fi
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nMemoryMax=256M\n' > /etc/systemd/system/caddy.service.d/lineage.conf
systemctl daemon-reload
systemctl enable caddy >/dev/null 2>&1 || true
echo "caddy $(caddy version | awk '{print $1}')"
echo "== provision done"
