#!/usr/bin/env bash
# Desktop host kit, local dry run (like scripts/deploy/dryrun.sh): a systemd Ubuntu 24.04 container
# plays the fresh desktop host (privileged, with its own Docker inside on an anonymous volume) and this
# machine plays the site (SITE_DIR=local:...). The real provision.sh provisions it over real ssh, twice
# (idempotency), then real desktops run on it through the real gateway:
#   - provision checks (gateway refuses, firewall only lets the "site" in);
#   - packages/desktop/scripts/proof.ts --backend host: a scripted attempt on a desktop on the host, its
#     stream pulled to this machine and served by the gate's handler; the added latency is measured;
#   - dryrun-check.ts: placement onto the host, the host going away (paused): new desktops are refused
#     with the reason (no other slot configured), the running one ends its stream cleanly; back again.
# Results: scripts/deploy/desktop-host/DRYRUN-LAST.json. Port 9665 (ssh) from this repo's block, bound to
# 127.0.0.1. The container and its image carry label lineage=1 and are removed at the end unless --keep.
#
#   scripts/deploy/desktop-host/dryrun.sh [--keep]
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
IMAGE="lineage/site-dryrun:24.04"
NAME="lineage-deskhost-dryrun"
SSH_P=9665
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
if [ -n "$(lsof -ti :$SSH_P)" ]; then echo "port $SSH_P busy; not starting" >&2; exit 1; fi
WORK="$(mktemp -d)"; RESULTS="$WORK/results.jsonl"; : > "$RESULTS"; FAIL=0
check() {
  [ "$2" = 1 ] && echo "PASS $1${3:+: $3}" || { echo "FAIL $1${3:+: $3}"; FAIL=$((FAIL + 1)); }
  bun -e 'const [n,o,d]=process.argv.slice(1); console.log(JSON.stringify({check:n, ok:o==="1", detail:d}))' "$1" "$2" "${3:-}" >> "$RESULTS"
}
had_img=0; docker image inspect "$IMAGE" >/dev/null 2>&1 && had_img=1
cleanup() {
  if [ "$KEEP" = 0 ]; then
    docker rm -f -v "$NAME" >/dev/null 2>&1
    [ "$had_img" = 0 ] && docker rmi "$IMAGE" >/dev/null 2>&1
  fi
  rm -rf "$WORK" "/tmp/ldh-$$"
}
trap cleanup EXIT

echo "== container (the fresh desktop host)"
docker rm -f -v "$NAME" >/dev/null 2>&1
docker build -q --label lineage=1 -t "$IMAGE" "$REPO/scripts/deploy/dryrun" >/dev/null || exit 1
docker run -d --name "$NAME" --label lineage=1 --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v /var/lib/docker -v /var/lib/containerd --tmpfs /run --tmpfs /run/lock \
  -p 127.0.0.1:$SSH_P:22 "$IMAGE" >/dev/null || exit 1
for i in $(seq 1 30); do docker exec "$NAME" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
ssh-keygen -q -t ed25519 -N "" -f "$WORK/key" -C lineage-deskhost-dryrun
docker exec "$NAME" bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq openssh-server iptables >/dev/null && install -d -m 700 /root/.ssh && ssh-keygen -A >/dev/null && systemctl enable --now ssh >/dev/null 2>&1' || exit 1
docker exec -i "$NAME" bash -c 'cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' < "$WORK/key.pub"
SSHO=(-i "$WORK/key" -p $SSH_P -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
for i in $(seq 1 20); do ssh "${SSHO[@]}" root@127.0.0.1 true 2>/dev/null && break; sleep 1; done
# the address this machine's connections arrive from inside the container: the "site" for the firewall
SRC="$(ssh "${SSHO[@]}" root@127.0.0.1 'echo ${SSH_CLIENT%% *}')"
check "fresh box reachable over root ssh" "$([ -n "$SRC" ] && echo 1 || echo 0)" "site address seen by the host: $SRC"
[ -n "$SRC" ] || exit 1

export SSH_KEY="$WORK/key" HOST_PORT=$SSH_P SSH_INSECURE_TEST=1 DRY_RUN=1 JUMP=none SITE_DIR="local:$WORK/site" SITE_IP="$SRC"
P() { NAME=dryrun "$REPO/scripts/deploy/desktop-host/provision.sh" "$@"; }
echo "== provision 1 (full, fresh box)"
s=$(date +%s); P 127.0.0.1 full > "$WORK/p1.log" 2>&1; rc=$?; tail -22 "$WORK/p1.log"
check "provision.sh full on a fresh box" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
[ $rc = 0 ] || exit 1
echo "== provision 2 (full again: idempotent)"
s=$(date +%s); P 127.0.0.1 full > "$WORK/p2.log" 2>&1; rc=$?; tail -6 "$WORK/p2.log"
check "provision.sh full re-run on the same box" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
grep -q "^unchanged" "$WORK/p2.log"; check "re-run keeps the built image (no rebuild)" "$([ $? = 0 ] && echo 1 || echo 0)"
s=$(date +%s); P 127.0.0.1 update > "$WORK/p3.log" 2>&1; rc=$?
check "provision.sh update (gateway, image, proxy)" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
n=$(jq '.hosts | length' "$WORK/site/hosts.json"); max=$(jq '.hosts[0].desktops_max' "$WORK/site/hosts.json")
check "one host registered in the site's hosts file" "$([ "$n" = 1 ] && echo 1 || echo 0)" "desktops_max $max: $(jq -r '.hosts[0].capacity' "$WORK/site/hosts.json")"
[ "$(grep -c '' "$WORK/site/known_hosts")" = 1 ]; check "known_hosts holds one entry for the host (its own key)" "$([ $? = 0 ] && echo 1 || echo 0)"

echo "== host checks"
H() { ssh "${SSHO[@]}" root@127.0.0.1 "$@"; }
H 'ufw status' | grep -q "22/tcp.*ALLOW.*$SRC"; check "firewall: ssh only from the site" "$([ $? = 0 ] && echo 1 || echo 0)"
CIP="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")"
docker run --rm --label lineage=1 --entrypoint bash "$IMAGE" -c "timeout 4 bash -c '</dev/tcp/$CIP/22'" >/dev/null 2>&1
check "firewall: another machine cannot reach ssh" "$([ $? != 0 ] && echo 1 || echo 0)" "from a container on the bridge to $CIP:22"
H 'stat -c "%U %a" /var/run/docker.sock; id lineage-desk' | tr '\n' ' ' | grep -q "docker" ; check "lineage-desk in the docker group" "$([ $? = 0 ] && echo 1 || echo 0)"
GWK=(-i "$WORK/site/id_ed25519" -p $SSH_P -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$WORK/site/known_hosts" -o LogLevel=ERROR lineage-desk@127.0.0.1)
for bad in "id" "docker ps" "docker run --rm --privileged lineage/desktop" "docker exec -u 0:0 lineage-desk-proxy id" "docker run -d --name lineage-desk-0123456789abcdef --label lineage=1 --label lineage.desktop=1 --network lineage-desk --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 -v /:/host lineage/desktop"; do
  ssh "${GWK[@]}" "$bad" >/dev/null 2>&1; rc=$?
  check "gateway refuses: $bad" "$([ $rc = 126 ] && echo 1 || echo 0)" "exit $rc"
done
# with forwarding allowed this would print the host's own sshd banner (SSH-2.0-...)
banner="$( (sleep 3) | ssh "${GWK[@]}" -W 127.0.0.1:22 2>/dev/null | head -c 7)"
check "the runtime's key cannot forward ports" "$([ "$banner" != "SSH-2.0" ] && echo 1 || echo 0)"

echo "== desktops on the host"
git clone -q "$(for m in ~/.lineage/mirrors/*.git; do git -C "$m" cat-file -e HEAD:minbpe/basic.py 2>/dev/null && echo "$m" && break; done)" "$WORK/minbpe" 2>/dev/null
export LINEAGE_DESK_SSH_DIR="/tmp/ldh-$$"; mkdir -p "$LINEAGE_DESK_SSH_DIR"
if [ -f "$WORK/minbpe/minbpe/basic.py" ]; then
  s=$(date +%s); bun "$REPO/packages/desktop/scripts/proof.ts" --tree "$WORK/minbpe" --out "$WORK/proof" --backend host --hosts-file "$WORK/site/hosts.json" --hold 15 > "$WORK/proof.log" 2>&1; rc=$?
  tail -6 "$WORK/proof.log"
  lat=$(jq -c '{segments: (.latency|length), added_ms: ([.latency[].added_ms] | {min: min, max: max, mean: ((add/length)|floor)}), pull_ms: (.pulls_ms | {n: length, min: min, max: max, mean: ((add/length)|floor)})}' "$WORK/proof/proof.json" 2>/dev/null)
  up=$(grep -o "desktop up in [0-9.]* s on host" "$WORK/proof.log")
  check "scripted attempt on a desktop on the host (proof.ts --backend host)" "$([ $rc = 0 ] && grep -q "closed (11 actions, 0 refused" "$WORK/proof.log" && echo 1 || echo 0)" "$up"
  check "live stream pulled to the site and served (latency measured)" "$([ -n "$lat" ] && [ "$(jq '.latency|length' "$WORK/proof/proof.json")" -gt 3 ] && echo 1 || echo 0)" "$lat"
  cp "$WORK/proof/proof.json" "$REPO/scripts/deploy/desktop-host/PROOF-LAST.json"
else
  check "scripted attempt on a desktop on the host" 0 "no local minbpe mirror under ~/.lineage/mirrors"
fi
s=$(date +%s); DRYRUN_CONTAINER="$NAME" bun "$REPO/scripts/deploy/desktop-host/dryrun-check.ts" --hosts-file "$WORK/site/hosts.json" --tree "$WORK/minbpe" --results "$RESULTS"; rc=$?
[ $rc = 0 ] || FAIL=$((FAIL + 1))
H 'docker ps -a --filter label=lineage.desktop=1 -q | wc -l' | grep -qx 0; check "no desktop container left on the host" "$([ $? = 0 ] && echo 1 || echo 0)"

bun -e '
const fs = require("fs");
const [file, out] = process.argv.slice(1);
const checks = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), passed: checks.filter((c) => c.ok).length, total: checks.length, checks }, null, 2) + "\n");
console.log(`desktop host dry run: ${checks.filter((c) => c.ok).length}/${checks.length} passed`);
' "$RESULTS" "$REPO/scripts/deploy/desktop-host/DRYRUN-LAST.json"
[ "$FAIL" = 0 ]
