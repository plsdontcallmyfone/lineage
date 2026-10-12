#!/usr/bin/env bash
# Capacity host kit, local dry run and scale-out proof (docs/plans/SCALE-OUT.md section 7). Two systemd
# Ubuntu 24.04 containers play two fresh servers (privileged, each with its own Docker inside on an
# anonymous volume, labelled lineage=1 units=1 units.machine=<name>); this machine plays the site
# (SITE_DIR=local:...). The real provision.sh provisions both over real ssh, the first one twice
# (idempotency), then scripts/scale/proof.ts runs a hosted runtime against a local simulated Core with
# its evaluations going to the two machines, one of which is killed in mid-evaluation.
#
#   scripts/deploy/capacity-host/dryrun.sh [--keep] [--no-proof]
#
# Ports from this repo's block, bound to 127.0.0.1 (PORT_A, PORT_B: ssh of the two machines; CORE_PORT: the
# proof's Core; defaults 9663, 9664, 9666, each checked with lsof first). Results: scripts/deploy/capacity-host/DRYRUN-LAST.json and scripts/scale/PROOF-LAST.json.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
IMAGE="lineage/site-dryrun:24.04"
KEEP=0; PROOF=1
for a in "$@"; do case "$a" in --keep) KEEP=1 ;; --no-proof) PROOF=0 ;; esac; done
# any three free ports of 9663, 9664, 9666-9669: PORT_A, PORT_B (ssh of the machines), CORE_PORT (the proof's Core)
PORT_A="${PORT_A:-9663}"; PORT_B="${PORT_B:-9664}"; CORE_PORT="${CORE_PORT:-9666}"
for p in $PORT_A $PORT_B $CORE_PORT; do if [ -n "$(lsof -ti :$p)" ]; then echo "port $p busy; not starting" >&2; exit 1; fi; done
WORK="${WORK:-$(mktemp -d)}"; mkdir -p "$WORK"; RESULTS="$WORK/results.jsonl"; : > "$RESULTS"; FAIL=0
check() {
  [ "$2" = 1 ] && echo "PASS $1${3:+: $3}" || { echo "FAIL $1${3:+: $3}"; FAIL=$((FAIL + 1)); }
  bun -e 'const [n,o,d]=process.argv.slice(1); console.log(JSON.stringify({check:n, ok:o==="1", detail:d}))' "$1" "$2" "${3:-}" >> "$RESULTS"
}
MACHINES=(a b); PORTS=("$PORT_A" "$PORT_B")
cleanup() {
  if [ "$KEEP" = 0 ]; then
    for m in "${MACHINES[@]}"; do docker rm -f -v "units-cap-dryrun-$m" >/dev/null 2>&1; done
    rm -rf "$WORK"
  else
    echo "kept: containers units-cap-dryrun-{a,b}, work $WORK"
  fi
}
trap cleanup EXIT

docker build -q --label lineage=1 -t "$IMAGE" "$REPO/scripts/deploy/dryrun" >/dev/null || exit 1
[ -f "$WORK/key" ] || ssh-keygen -q -t ed25519 -N "" -f "$WORK/key" -C units-cap-dryrun
SRC=""
for i in 0 1; do
  m="${MACHINES[$i]}"; port="${PORTS[$i]}"; name="units-cap-dryrun-$m"
  echo "== machine $m (container $name, ssh 127.0.0.1:$port)"
  docker rm -f -v "$name" >/dev/null 2>&1
  docker run -d --name "$name" --label lineage=1 --label units=1 --label "units.machine=$m" --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v /var/lib/docker -v /var/lib/containerd --tmpfs /run --tmpfs /run/lock \
    -p "127.0.0.1:$port:22" "$IMAGE" >/dev/null || exit 1
  for _ in $(seq 1 30); do docker exec "$name" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
  docker exec "$name" bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq openssh-server iptables >/dev/null && install -d -m 700 /root/.ssh && ssh-keygen -A >/dev/null && systemctl enable -q --now ssh' >/dev/null 2>&1
  docker exec -i "$name" bash -c 'cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' < "$WORK/key.pub"
  SSHO=(-i "$WORK/key" -p "$port" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
  for _ in $(seq 1 20); do ssh "${SSHO[@]}" root@127.0.0.1 true 2>/dev/null && break; sleep 1; done
  SRC="$(ssh "${SSHO[@]}" root@127.0.0.1 'echo ${SSH_CLIENT%% *}')"
  check "machine $m: fresh box reachable over root ssh" "$([ -n "$SRC" ] && echo 1 || echo 0)" "site address seen by the host: $SRC"
  [ -n "$SRC" ] || exit 1
done

export SSH_KEY="$WORK/key" SSH_INSECURE_TEST=1 DRY_RUN=1 JUMP=none SITE_DIR="local:$WORK/site" SITE_IP="$SRC" INSTANCE=devnet RECIPES=fixture-b58
export IMAGES_MAP="${IMAGES_MAP:-$HOME/.lineage/local-images.json}" CORE_URL="http://host.docker.internal:$CORE_PORT"
[ -f "$IMAGES_MAP" ] || unset IMAGES_MAP
P() { "$REPO/scripts/deploy/capacity-host/provision.sh" "$@"; }
echo "== provision machine a (both roles, fresh box)"
s=$(date +%s); NAME=cap-a ROLE=both HOST_PORT=$PORT_A P 127.0.0.1 full > "$WORK/pa1.log" 2>&1; rc=$?; tail -30 "$WORK/pa1.log"
check "provision.sh full, ROLE=both, on a fresh box" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
[ $rc = 0 ] || exit 1
echo "== provision machine a again (idempotent)"
s=$(date +%s); NAME=cap-a ROLE=both HOST_PORT=$PORT_A P 127.0.0.1 full > "$WORK/pa2.log" 2>&1; rc=$?; tail -4 "$WORK/pa2.log"
check "provision.sh full re-run on the same box" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
grep -q "unchanged (" "$WORK/pa2.log"; check "re-run copies no image again" "$([ $? = 0 ] && echo 1 || echo 0)"
echo "== provision machine b (sandbox role)"
s=$(date +%s); NAME=cap-b ROLE=sandbox HOST_PORT=$PORT_B P 127.0.0.1 full > "$WORK/pb1.log" 2>&1; rc=$?; tail -8 "$WORK/pb1.log"
check "provision.sh full, ROLE=sandbox, on a second fresh box" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
[ $rc = 0 ] || exit 1

n=$(jq '.hosts | length' "$WORK/site/hosts.json")
check "two hosts registered in the site's sandbox hosts file" "$([ "$n" = 2 ] && echo 1 || echo 0)" "$(jq -c '[.hosts[] | {name, slots, basis}]' "$WORK/site/hosts.json")"
[ "$(grep -c '' "$WORK/site/known_hosts")" = 2 ]; check "known_hosts holds one entry per host (its own key)" "$([ $? = 0 ] && echo 1 || echo 0)"

echo "== host checks (machine a)"
H() { ssh -i "$WORK/key" -p "$PORT_A" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR root@127.0.0.1 "$@"; }
GWK=(-i "$WORK/site/id_ed25519" -p "$PORT_A" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$WORK/site/known_hosts" -o LogLevel=ERROR units-cap@127.0.0.1)
for bad in "id" "docker ps" "cat /etc/units-cap/verifier.json" "eval; id" "bun -e 1"; do
  ssh "${GWK[@]}" "$bad" >/dev/null 2>&1; rc=$?
  check "gateway refuses: $bad" "$([ $rc = 126 ] && echo 1 || echo 0)" "exit $rc"
done
banner="$( (sleep 3) | ssh "${GWK[@]}" -W 127.0.0.1:22 2>/dev/null | head -c 7)"
check "the runtime's key cannot forward ports" "$([ "$banner" != "SSH-2.0" ] && echo 1 || echo 0)"
out="$(echo '{"v":1}' | ssh "${GWK[@]}" eval 2>/dev/null | tail -1)"
check "a malformed job is answered, not run" "$(echo "$out" | grep -q '"ok":false' && echo 1 || echo 0)" "$out"
H 'stat -c "%U %G %a" /etc/units-cap/verifier.json' | grep -qx "units-cap units-cap 600"; check "the verifier's key: made on the host, owner units-cap, mode 600" "$([ $? = 0 ] && echo 1 || echo 0)"
H 'systemctl is-enabled units-cap-verifier 2>/dev/null; true' | grep -qx enabled; check "the verifier unit is installed and not enabled until the owner registers and bonds it" "$([ $? != 0 ] && echo 1 || echo 0)"
H 'grep SLOTS= /etc/units-cap/env | tr "\n" " "; nproc; awk "/MemTotal/{print int(\$2/1024)}" /proc/meminfo' | tr '\n' ' ' > "$WORK/env-a.txt"
check "slots from the host's own size" "$(grep -q 'UNITS_SANDBOX_SLOTS=[1-9]' "$WORK/env-a.txt" && echo 1 || echo 0)" "$(cat "$WORK/env-a.txt")"
grep -q "what the owner does next" "$WORK/pa1.log" && grep -q "units_registry bond" "$WORK/pa1.log"; check "register and bond steps printed for the owner" "$([ $? = 0 ] && echo 1 || echo 0)" "$(grep -m1 'verifier agent id' "$WORK/pa1.log" | tr -s ' ')"

if [ "$PROOF" = 1 ]; then
  echo "== scale-out proof (scripts/scale/proof.ts)"
  bun "$REPO/scripts/scale/proof.ts" --hosts-file "$WORK/site/hosts.json" --core-port $CORE_PORT --kill units-cap-dryrun-b --verifier-host "127.0.0.1:$PORT_A" --root-key "$WORK/key" --out "$REPO/scripts/scale/PROOF-LAST.json" 2>&1 | tee "$WORK/proof.log" | grep -E "PASS|FAIL|proof:" ; rc=${PIPESTATUS[0]}
  check "scale-out proof" "$([ $rc = 0 ] && echo 1 || echo 0)" "$(grep -m1 'proof:' "$WORK/proof.log")"
  echo "== remove machine b"
  NAME=cap-b ROLE=sandbox HOST_PORT=$PORT_B P 127.0.0.1 remove > "$WORK/pb-rm.log" 2>&1; rc=$?; tail -3 "$WORK/pb-rm.log"
  check "provision.sh remove takes the host out of the hosts file" "$([ $rc = 0 ] && [ "$(jq -r '[.hosts[].name] | join(",")' "$WORK/site/hosts.json")" = cap-a ] && echo 1 || echo 0)"
fi

bun -e '
const fs = require("fs");
const [file, out] = process.argv.slice(1);
const checks = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), passed: checks.filter((c) => c.ok).length, total: checks.length, checks }, null, 2) + "\n");
console.log(`capacity host dry run: ${checks.filter((c) => c.ok).length}/${checks.length} passed`);
' "$RESULTS" "$REPO/scripts/deploy/capacity-host/DRYRUN-LAST.json"
[ "$FAIL" = 0 ]
