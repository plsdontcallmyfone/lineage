#!/usr/bin/env bash
# Lineage site deploy kit, local dry run: a systemd Ubuntu 24.04 container plays the fresh server and
# the real deploy.sh provisions and deploys it over real ssh. No Docker inside the container (no
# docker-in-docker and no host socket), so the sandbox units (bootstrap, reference, verifiers,
# runtime, author) are marked skipped; Core (devnet chain mode, read only: no key leaves this
# machine), the dashboard, the gate and Caddy (internal TLS) are started and checked. Nothing is sent
# on chain (fund and site-chain run as plans). Results: scripts/deploy/DRYRUN-LAST.json.
#
#   scripts/deploy/dryrun.sh [--keep]
#
# Deploys DRYRUN_FIRST_REF (default HEAD~1 when it has the kit, else HEAD) and then HEAD, so rollback is
# exercised; runs `full` twice on HEAD (re-run safety). Host ports 9668 (ssh) and 9669 (https) from
# this repo's block, bound to 127.0.0.1. The container and its image (scripts/deploy/dryrun/Dockerfile,
# ubuntu:24.04 pinned by digest plus systemd, built for this machine's arch) carry label lineage=1 and
# are removed at the end unless --keep.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="lineage/site-dryrun:24.04"   # scripts/deploy/dryrun/Dockerfile: ubuntu:24.04 pinned by digest + systemd, native arch
BASE_IMAGE="ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55"
NAME="lineage-site-dryrun"
SSH_P=9668; HTTPS_P=9669
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
T0=$(date +%s)
for p in $SSH_P $HTTPS_P; do
  if [ -n "$(lsof -ti :$p)" ]; then echo "port $p busy; not starting" >&2; exit 1; fi
done
WORK="$(mktemp -d)"
RESULTS="$WORK/results.jsonl"; : > "$RESULTS"
FAIL=0
check() { # check <name> <ok 0/1> <detail>
  local ok=$2
  [ "$ok" = 1 ] && echo "PASS $1${3:+: $3}" || { echo "FAIL $1${3:+: $3}"; FAIL=$((FAIL + 1)); }
  bun -e 'const [n,o,d]=process.argv.slice(1); console.log(JSON.stringify({check:n, ok:o==="1", detail:d}))' "$1" "$ok" "${3:-}" >> "$RESULTS"
}
had_base=0; docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 && had_base=1
cleanup() {
  if [ "$KEEP" = 0 ]; then
    docker rm -f "$NAME" >/dev/null 2>&1
    docker rmi "$IMAGE" >/dev/null 2>&1
    [ "$had_base" = 0 ] && docker rmi "$BASE_IMAGE" >/dev/null 2>&1
  fi
  [ -n "${DRYRUN_LOGS:-}" ] && mkdir -p "$DRYRUN_LOGS" && cp "$WORK"/*.log "$DRYRUN_LOGS"/ 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== container"
docker rm -f "$NAME" >/dev/null 2>&1
docker build -q --label lineage=1 -t "$IMAGE" "$REPO/scripts/deploy/dryrun" >/dev/null || exit 1
docker run -d --name "$NAME" --label lineage=1 --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -p 127.0.0.1:$SSH_P:22 -p 127.0.0.1:$HTTPS_P:443 "$IMAGE" >/dev/null || exit 1
for i in $(seq 1 30); do docker exec "$NAME" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
# What a provider gives: root ssh with the owner's key. Our throwaway key stands in for ~/.ssh/lineage_site.
ssh-keygen -q -t ed25519 -N "" -f "$WORK/key" -C lineage-dryrun
docker exec "$NAME" bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq openssh-server curl >/dev/null && install -d -m 700 /root/.ssh && systemctl enable --now ssh >/dev/null 2>&1' || exit 1
docker exec -i "$NAME" bash -c 'cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' < "$WORK/key.pub"
for i in $(seq 1 20); do ssh -i "$WORK/key" -p $SSH_P -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR root@127.0.0.1 true 2>/dev/null && break; sleep 1; done
ok=$(ssh -i "$WORK/key" -p $SSH_P -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR root@127.0.0.1 true && echo 1 || echo 0)
check "fresh box reachable over root ssh" "$ok"
[ "$ok" = 1 ] || { echo "no ssh into the container; stopping" >&2; exit 1; }

export SSH_KEY="$WORK/key" SSH_PORT=$SSH_P SSH_INSECURE_TEST=1 DRY_RUN=1 SITE_NAMES=localhost DRY_RUN_ORIGIN="https://localhost:$HTTPS_P"
D="$REPO/scripts/deploy/deploy.sh"
FIRST="${DRYRUN_FIRST_REF:-HEAD~1}"
git -C "$REPO" cat-file -e "$FIRST:scripts/deploy/remote.sh" 2>/dev/null || FIRST=HEAD
# pinned: other sessions commit in this tree while the dry run runs, so every deploy names HEADSHA
HEADSHA="$(git -C "$REPO" rev-parse HEAD)"; FIRSTSHA="$(git -C "$REPO" rev-parse "$FIRST")"

echo "== deploy 1: full at $FIRSTSHA"
s=$(date +%s); DEPLOY_REF="$FIRSTSHA" "$D" 127.0.0.1 full > "$WORK/d1.log" 2>&1; rc=$?
tail -25 "$WORK/d1.log"
check "deploy.sh full on a fresh box" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
[ $rc = 0 ] || { echo "first deploy failed; stopping (log above)" >&2; exit 1; }
grep -q "plan done (nothing sent)" "$WORK/d1.log" && grep -q "fund-site.*plan" "$WORK/d1.log"; check "fund and site-chain ran as plans (nothing sent on chain)" "$(grep -c 'plan done (nothing sent)' "$WORK/d1.log" | awk '{print ($1>=2)?1:0}')"

if [ "$FIRSTSHA" != "$HEADSHA" ]; then
  echo "== deploy 2: full at HEAD $HEADSHA"
  s=$(date +%s); DEPLOY_REF="$HEADSHA" "$D" 127.0.0.1 full > "$WORK/d2.log" 2>&1; rc=$?; tail -8 "$WORK/d2.log"
  check "deploy.sh full re-run on the same box (new commit)" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
fi
echo "== deploy 3: full again at HEAD (re-run safety)"
s=$(date +%s); DEPLOY_REF="$HEADSHA" "$D" 127.0.0.1 full > "$WORK/d3.log" 2>&1; rc=$?; tail -5 "$WORK/d3.log"
check "deploy.sh full re-run, same commit" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc, $(( $(date +%s) - s )) s"
prevsha=$(sed -n 's/^== ship \([0-9a-f]*\) .*/\1/p' "$WORK/d$([ -f "$WORK/d2.log" ] && echo 2 || echo 1).log")
d3sha=$(sed -n 's/^== ship \([0-9a-f]*\) .*/\1/p' "$WORK/d3.log")
if [ "$prevsha" = "$d3sha" ]; then
  grep -q "data backup" "$WORK/d3.log" && check "same-commit re-run takes no data backup" 0 || check "same-commit re-run takes no data backup" 1
else
  # another session committed in between: a new release must back the data up
  grep -q "data backup" "$WORK/d3.log" && check "re-run on a newer HEAD backs up Core's data" 1 "$prevsha -> $d3sha" || check "re-run on a newer HEAD backs up Core's data" 0
fi

R() { ssh -i "$WORK/key" -p $SSH_P -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR root@127.0.0.1 "$@"; }
docker cp "$NAME:/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt" "$WORK/ca.crt" >/dev/null 2>&1
U="https://localhost:$HTTPS_P"
C=(curl -sS -m 15 --cacert "$WORK/ca.crt")
code() { "${C[@]}" -o /dev/null -w '%{http_code}' "$@"; }

echo "== units"
# rebrand (docs/plans/REBRAND-UNITS.md 3.8): with DRYRUN_FIRST_REF at a release from before the unit
# rename, deploy 2 moved every unit from lineage-* to units-*; none of the old names may still run or be enabled
old_active=$(R "systemctl list-units --all --plain --no-legend --state=active,activating 'lineage-*' | awk '{print \$1}' | paste -sd' ' -")
old_enabled=$(R "systemctl list-unit-files --plain --no-legend --state=enabled 'lineage-*' | awk '{print \$1}' | paste -sd' ' -")
check "no lineage-* unit running or enabled after the units release" "$([ -z "$old_active$old_enabled" ] && echo 1 || echo 0)" "active: ${old_active:-none}; enabled: ${old_enabled:-none}"
for u in units-core units-web units-gate caddy; do
  st=$(R systemctl is-active $u); check "unit $u active" "$([ "$st" = active ] && echo 1 || echo 0)" "$st"
done
for u in units-bootstrap units-reference units-verifier@v1 units-verifier@v2 units-runtime units-author; do
  st=$(R systemctl is-active $u); check "sandbox unit $u skipped in the dry run" "$([ "$st" != active ] && echo 1 || echo 0)" "$st"
done
mm=$(R systemctl show -p MemoryMax --value units-core); check "units-core memory cap" "$([ "$mm" = 1073741824 ] && echo 1 || echo 0)" "MemoryMax $mm"
own=$(R "stat -c '%U %a' /home/lineage/.config/lineage/site/admin.json"); check "site keys made on the server, owner lineage, mode 600" "$([ "$own" = 'lineage 600' ] && echo 1 || echo 0)" "$own"
nk=$(R "ls /home/lineage/.config/lineage/devnet | wc -l"); check "no key copied from this machine in the dry run" "$([ "$nk" = 0 ] && echo 1 || echo 0)" "$nk files"
uf=$(R "ufw status | head -1"); check "ufw active" "$(echo "$uf" | grep -q 'active' && echo 1 || echo 0)" "$uf"
f2b=$(R "systemctl is-active fail2ban"); check "fail2ban active" "$([ "$f2b" = active ] && echo 1 || echo 0)" "$f2b"
bv=$(R "bun --version"); check "bun pinned" "$([ "$bv" = 1.3.13 ] && echo 1 || echo 0)" "$bv"
lu=$(R "id -nG lineage"); check "lineage user has no sudo" "$(echo "$lu" | grep -qwE 'sudo|admin' && echo 0 || echo 1)" "$lu"

echo "== HTTPS through Caddy and the gate"
h=$("${C[@]}" "$U/v1/health"); check "GET /v1/health over HTTPS (internal TLS)" "$(echo "$h" | grep -q '"ok":true' && echo 1 || echo 0)" "$h"
for i in $(seq 1 20); do ch=$("${C[@]}" "$U/v1/chain"); echo "$ch" | grep -q '"slot"' && break; sleep 3; done
check "Core in devnet chain mode read the chain" "$(echo "$ch" | grep -q '"mode":"devnet"' && echo "$ch" | grep -q '"slot"' && echo 1 || echo 0)" "$(echo "$ch" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(`slot ${j.slot}, epochs posted ${j.epochs_posted}, core_signing ${j.core_signing}`)' 2>/dev/null)"
check "Core does not sign as Core authority in the dry run" "$(echo "$ch" | grep -q '"core_signing":false' && echo 1 || echo 0)"
ag=$("${C[@]}" "$U/v1/agents" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(Array.isArray(j)?j.length:(j.agents?.length ?? -1))' 2>/dev/null)
check "Core mirrored the registry's agents" "$([ "${ag:-0}" -gt 0 ] 2>/dev/null && echo 1 || echo 0)" "$ag agents"
check "dashboard page" "$([ "$(code "$U/")" = 200 ] && echo 1 || echo 0)"
check "wallet page" "$([ "$(code "$U/wallet")" = 200 ] && echo 1 || echo 0)"
check "client bundle" "$([ "$(code "$U/assets/app.js")" = 200 ] && echo 1 || echo 0)"
check "wallet bundle" "$([ "$(code "$U/assets/wallet.js")" = 200 ] && echo 1 || echo 0)"
cc=$("${C[@]}" "$U/chain/config"); check "/chain/config: devnet" "$(echo "$cc" | grep -q '"devnet":true' && echo 1 || echo 0)"
check "/chain/config: no keyed RPC URL" "$(echo "$cc" | grep -qi 'api-key\|helius' && echo 0 || echo 1)"
check "/api proxy to Core" "$([ "$(code "$U/api/lineages")" = 200 ] && echo 1 || echo 0)"
acao=$("${C[@]}" -D - -o /dev/null "$U/v1/health" | tr -d '\r' | grep -i '^access-control-allow-origin:' | awk '{print $2}')
check "CORS * on the public read API" "$([ "$acao" = '*' ] && echo 1 || echo 0)" "$acao"
hsts=$("${C[@]}" -D - -o /dev/null "$U/" | tr -d '\r' | grep -ci '^strict-transport-security:')
check "security headers" "$([ "$hsts" = 1 ] && echo 1 || echo 0)"
check "admin API not public" "$([ "$(code "$U/v1/admin/ledger")" = 404 ] && echo 1 || echo 0)"
check "Core writes not public" "$([ "$(code -X POST -H 'content-type: application/json' -d '{}' "$U/v1/candidates")" = 405 ] && echo 1 || echo 0)"
check "cross-origin faucet POST refused" "$([ "$(code -X POST -H 'origin: https://evil.example' -H 'content-type: application/json' -d '{}' "$U/chain/faucet")" = 403 ] && echo 1 || echo 0)"
rpc=$("${C[@]}" -X POST -H "origin: $U" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}' "$U/chain/rpc")
check "devnet RPC proxy (same origin)" "$(echo "$rpc" | grep -q '"result"' && echo 1 || echo 0)" "$(echo "$rpc" | head -c 80)"
check "RPC method allowlist kept" "$([ "$(code -X POST -H "origin: $U" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","params":[]}' "$U/chain/rpc")" = 400 ] && echo 1 || echo 0)"
codes=""; for i in 1 2 3 4; do codes="$codes $(code -X POST -H "origin: $U" -H 'content-type: application/json' -d '{"wallet":"x"}' "$U/chain/faucet")"; done
check "faucet rate limit per address (3 then 429)" "$(echo "$codes" | awk '{print ($4==429 && $3!=429)?1:0}')" "$codes"
big=$(head -c 300000 /dev/zero | tr '\0' a); bc=$(printf '%s' "$big" | code -X POST -H "origin: $U" -H 'content-type: application/json' --data-binary @- "$U/chain/rpc")
check "oversized body refused" "$([ "$bc" = 413 ] && echo 1 || echo 0)" "$bc"
for i in 1 2 3 4; do "${C[@]}" -N -m 6 "$U/live/events" > /dev/null 2>&1 & done; sleep 2
s5=$(code -m 4 "$U/live/events"); wait
check "event streams capped per address (4 open, 5th 429)" "$([ "$s5" = 429 ] && echo 1 || echo 0)" "$s5"
sse=$("${C[@]}" -N -m 4 "$U/live/events" 2>/dev/null | head -c 300)
check "event stream flows through Caddy and the gate" "$(echo "$sse" | grep -q 'event: status' && echo 1 || echo 0)" "$(echo "$sse" | head -1)"
v=$(cd "$REPO" && NODE_EXTRA_CA_CERTS="$WORK/ca.crt" bun scripts/verify.ts --core "$U" 2>&1); rc=$?
check "scripts/verify.ts runs against the public site" "$([ $rc = 0 ] && echo 1 || echo 0)" "exit $rc: $(echo "$v" | tail -1)"

echo "== status, stop, start, rollback"
"$D" 127.0.0.1 status > "$WORK/status.log" 2>&1; rc=$?; cat "$WORK/status.log"
check "deploy.sh status" "$([ $rc = 0 ] && grep -q 'core      ok' "$WORK/status.log" && echo 1 || echo 0)"
"$D" 127.0.0.1 stop >/dev/null 2>&1; st=$(R systemctl is-active units-core caddy | sort -u | tr '\n' ' ')
check "stop" "$(echo "$st" | grep -qw active && echo 0 || echo 1)" "$st"
"$D" 127.0.0.1 start >/dev/null 2>&1
for i in $(seq 1 30); do [ "$(code "$U/v1/health")" = 200 ] && break; sleep 2; done
check "start" "$([ "$(code "$U/v1/health")" = 200 ] && echo 1 || echo 0)"
if [ "$FIRSTSHA" != "$HEADSHA" ]; then
  want=$(R "basename \$(cat /opt/lineage/previous)")
  "$D" 127.0.0.1 rollback > "$WORK/rb.log" 2>&1; rc=$?
  cur=$(R "basename \$(readlink /opt/lineage/current)")
  for i in $(seq 1 30); do [ "$(code "$U/v1/health")" = 200 ] && break; sleep 2; done
  check "rollback to the previous release" "$([ $rc = 0 ] && [ "$cur" = "$want" ] && [ "$(code "$U/v1/health")" = 200 ] && echo 1 || echo 0)" "now $cur"
  echo "== zero-downtime activate: a release whose Core fails its health check is rolled back"
  # a drop-in that fails Core's start only while /opt/lineage/current is HEAD's release
  R "install -d /etc/systemd/system/units-core.service.d && printf '[Service]\nExecStartPre=/bin/sh -c \"readlink -f /opt/lineage/current | grep -qv $HEADSHA\"\n' > /etc/systemd/system/units-core.service.d/zz-dryrun-break.conf && systemctl daemon-reload"
  DEPLOY_REF="$HEADSHA" DEPLOY_HEALTH_WAIT=15 "$D" 127.0.0.1 code > "$WORK/dbreak.log" 2>&1; rc=$?
  cur=$(R "basename \$(readlink /opt/lineage/current)")
  R "rm -f /etc/systemd/system/units-core.service.d/zz-dryrun-break.conf && systemctl daemon-reload"
  for i in $(seq 1 30); do [ "$(code "$U/v1/health")" = 200 ] && break; sleep 1; done
  check "a failed Core health check rolls the release back" "$([ $rc != 0 ] && [ "$cur" = "$want" ] && grep -q 'rolled back to' "$WORK/dbreak.log" && [ "$(code "$U/v1/health")" = 200 ] && echo 1 || echo 0)" "exit $rc, now $cur"

  echo "== zero-downtime activate: a verifier mid-replay drains without holding the public units"
  # Stand-in for a verifier finishing a long replay: on SIGTERM it keeps working SIM_DRAIN_S seconds
  # (the real template's TimeoutStopSec stays in force). No Docker here, so docker.service is a stub.
  SIM_DRAIN_S=150
  cat > "$WORK/sim.sh" <<'SIM'
#!/bin/bash
LOG=/var/lib/lineage-sim/verifier.log
echo "$(date +%s) start $$ $(readlink -f /proc/self/cwd)" >> "$LOG"
trap 'echo "$(date +%s) term $$" >> "$LOG"; sleep "${SIM_DRAIN_S:-90}"; echo "$(date +%s) drained $$" >> "$LOG"; exit 0' TERM
while :; do sleep 1 & wait $!; done
SIM
  R "cat > /usr/local/lib/lineage-sim-verifier.sh && chmod 755 /usr/local/lib/lineage-sim-verifier.sh" < "$WORK/sim.sh"
  R "install -d -o lineage -g lineage /var/lib/lineage-sim && rm -f /var/lib/lineage-sim/verifier.log
     systemctl cat docker.service >/dev/null 2>&1 || printf '[Unit]\nDescription=dry run stub (no Docker in this container)\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\n' > /etc/systemd/system/docker.service
     install -d /etc/systemd/system/units-verifier@sim.service.d
     printf '[Service]\nExecStart=\nExecStart=/bin/bash /usr/local/lib/lineage-sim-verifier.sh\nEnvironment=SIM_DRAIN_S=$SIM_DRAIN_S\n' > /etc/systemd/system/units-verifier@sim.service.d/dryrun.conf
     systemctl daemon-reload && systemctl start units-verifier@sim"
  sleep 2
  st=$(R systemctl is-active units-verifier@sim)
  check "simulated verifier running before the deploy" "$([ "$st" = active ] && echo 1 || echo 0)" "$st"
  # poll the public site every 250 ms through the whole deploy
  ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
  ( while :; do t=$(ms); c=$(code -m 10 "$U/api/config"); echo "$t $c $(ms)"; sleep 0.25; done ) > "$WORK/poll.log" 2>/dev/null &
  POLL=$!
  s=$(date +%s); DEPLOY_REF="$HEADSHA" DEPLOY_DRAIN_WAIT=20 "$D" 127.0.0.1 code > "$WORK/d4.log" 2>&1; rc=$?; took=$(( $(date +%s) - s ))
  sleep 2; kill "$POLL" 2>/dev/null; wait "$POLL" 2>/dev/null
  cur=$(R "basename \$(readlink /opt/lineage/current)")
  check "forward again to HEAD (code mode)" "$([ $rc = 0 ] && [ "$cur" = "$(sed -n 's/^== ship \([0-9a-f]*\) .*/\1/p' "$WORK/d4.log")" ] && echo 1 || echo 0)" "now $cur"
  grep -E 'up in|draining|DRAINING|public units on' "$WORK/d4.log" | sed 's/^/  /'
  check "deploy returned while the verifier was still draining" "$([ "$took" -lt "$SIM_DRAIN_S" ] && grep -q 'units-verifier@sim' <(sed -n '/still draining/,$p' "$WORK/d4.log") && echo 1 || echo 0)" "deploy $took s, drain $SIM_DRAIN_S s"
  # public downtime: non-200 answers and the longest time between two 200 answers
  pol=$(bun -e '
    const rows = (await Bun.file(process.argv[1]).text()).trim().split("\n").map((l) => l.split(" ")).filter((r) => r.length === 3).map(([a, c, b]) => ({ a: +a, c, b: +b }));
    let bad = 0, gap = 0, last = null, slow = 0;
    for (const r of rows) { if (r.c !== "200") { bad++; continue; } if (last !== null) gap = Math.max(gap, r.b - last); last = r.b; slow = Math.max(slow, r.b - r.a); }
    console.log(JSON.stringify({ polls: rows.length, non200: bad, longest_gap_ms: gap, slowest_ms: slow }));' "$WORK/poll.log")
  check "public site answered 200 through the whole deploy" "$(echo "$pol" | grep -q '"non200":0' && echo 1 || echo 0)" "$pol"
  # the queued start runs the new release only after the old process exits: never two at once
  for i in $(seq 1 $((SIM_DRAIN_S + 30))); do [ "$(R "grep -c ' start ' /var/lib/lineage-sim/verifier.log")" -ge 2 ] && break; sleep 1; done
  sl=$(R "cat /var/lib/lineage-sim/verifier.log")
  echo "$sl" | sed 's/^/  sim: /'
  ok=$(echo "$sl" | bun -e '
    const l = (await Bun.stdin.text()).trim().split("\n").map((x) => x.split(" "));
    const starts = l.filter((x) => x[1] === "start"), drained = l.filter((x) => x[1] === "drained");
    const ok = starts.length === 2 && drained.length === 1 && drained[0][2] === starts[0][2] && +starts[1][0] >= +drained[0][0] && starts[1][3].includes(process.argv[1]) && !starts[0][3].includes(process.argv[1]);
    console.log(ok ? 1 : 0);' "$HEADSHA")
  check "drained verifier restarted once, on the new release, after its old process exited" "$ok"
fi
dfree=$(df -g / | tail -1 | awk '{print $4}')
check "host disk still >= 4 GB free" "$([ "$dfree" -ge 4 ] && echo 1 || echo 0)" "$dfree GB"

bun -e '
const lines = (await Bun.file(process.argv[1]).text()).trim().split("\n").map((l) => JSON.parse(l));
const out = { at: new Date().toISOString(), head: process.argv[2], first: process.argv[3], container_image: process.argv[4], seconds: Number(process.argv[5]),
  passed: lines.filter((l) => l.ok).length, failed: lines.filter((l) => !l.ok).length, checks: lines };
await Bun.write(process.argv[6], JSON.stringify(out, null, 2) + "\n");
console.log(`dry run: ${out.passed}/${lines.length} checks passed in ${out.seconds} s`);
' "$RESULTS" "$HEADSHA" "$FIRSTSHA" "$IMAGE" "$(( $(date +%s) - T0 ))" "$REPO/scripts/deploy/DRYRUN-LAST.json"
[ "$FAIL" = 0 ]
