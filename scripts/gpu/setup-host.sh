#!/usr/bin/env bash
# GPU BOX ONLY, run with sudo on a fresh Ubuntu 22.04/24.04 VM that already has the NVIDIA driver
# (Lambda Cloud images and the AWS "Deep Learning Base OSS Nvidia Driver GPU AMI" both do).
# Idempotent. Installs what is missing, opens GPU performance counters to non-admin users, and
# tells you when a reboot is needed (then reboot and run it again).
#
#   sudo bash scripts/gpu/setup-host.sh [--user <login user>]
set -euo pipefail
LOGIN_USER="${SUDO_USER:-ubuntu}"
if [[ "${1:-}" == "--user" ]]; then LOGIN_USER="$2"; fi
say() { printf '\n== %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

say "1. NVIDIA driver"
if ! command -v nvidia-smi >/dev/null || ! nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi missing or failing: pick an image with the NVIDIA driver preinstalled (see RUNBOOK.md)"; exit 1
fi
nvidia-smi --query-gpu=index,name,compute_cap,driver_version,memory.total --format=csv
DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1)
MAJ=${DRV%%.*}; MIN=$(echo "$DRV" | cut -d. -f2)
if (( MAJ < 560 || (MAJ == 560 && MIN < 35) )); then
  echo "WARNING: driver $DRV is older than 560.35.05 (CUDA 12.6 Update 3). Choose a newer image or upgrade the driver before measuring."
fi

say "2. Docker engine"
if ! command -v docker >/dev/null; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io
fi
systemctl enable --now docker
usermod -aG docker "$LOGIN_USER" || true
docker --version

say "3. NVIDIA Container Toolkit"
if ! command -v nvidia-ctk >/dev/null; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q nvidia-container-toolkit
fi
if ! docker info 2>/dev/null | grep -qi 'nvidia'; then
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
fi
nvidia-ctk --version | head -n1

say "4. GPU performance counters for non-admin users (needed by ncu as uid 10001 in the sandbox)"
CONF=/etc/modprobe.d/lineage-profiling.conf
# /proc/driver/nvidia/params names it RmProfilingAdminOnly (seen on driver 580); older docs say
# RestrictProfilingToAdminUsers. The modprobe option is NVreg_RestrictProfilingToAdminUsers either way.
profparam() { grep -i -E 'RestrictProfilingToAdminUsers|RmProfilingAdminOnly' /proc/driver/nvidia/params 2>/dev/null | head -n1 | awk '{print $2}' || true; }
CUR=$(profparam)
echo "current RestrictProfilingToAdminUsers (RmProfilingAdminOnly): ${CUR:-unknown}"
if [[ "$CUR" != "0" ]]; then
  echo 'options nvidia NVreg_RestrictProfilingToAdminUsers=0' > "$CONF"
  update-initramfs -u -k all >/dev/null 2>&1 || true
  # try a live reload first (works on a headless VM when nothing holds the GPU)
  systemctl stop nvidia-persistenced 2>/dev/null || true
  if modprobe -r nvidia_uvm nvidia_drm nvidia_modeset nvidia 2>/dev/null && modprobe nvidia && modprobe nvidia_uvm; then
    systemctl start nvidia-persistenced 2>/dev/null || true
    CUR=$(profparam)
    echo "reloaded the driver: RestrictProfilingToAdminUsers=$CUR"
  else
    systemctl start nvidia-persistenced 2>/dev/null || true
    echo "REBOOT REQUIRED: run 'sudo reboot', reconnect, and run this script again."
    exit 3
  fi
fi

say "5. Bun (pinned) and tools"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q git curl unzip jq >/dev/null
if ! sudo -u "$LOGIN_USER" bash -lc 'command -v bun' >/dev/null; then
  sudo -u "$LOGIN_USER" bash -lc 'curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13"'
fi
sudo -u "$LOGIN_USER" bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; bun --version'

say "6. Smoke: GPU in a container with the sandbox's hardening flags"
docker run --rm --gpus device=0 --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only --network none \
  --label lineage=1 ubuntu:22.04 nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader
echo "host ready. Log out and back in (docker group), then: bash scripts/gpu/session.sh"
