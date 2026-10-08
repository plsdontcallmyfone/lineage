#!/usr/bin/env bash
# GPU BOX ONLY. One-shot proof of the cuda target class. Run from the repo root as the login user
# after `sudo bash scripts/gpu/setup-host.sh` succeeded (see scripts/gpu/RUNBOOK.md).
#
#   bash scripts/gpu/session.sh [--skip-e2e] [--skip-llmc]
#
# Every step logs to results/gpu-<timestamp>/ and the script keeps going after a failed step so one
# rented session yields as much evidence as possible. Exit code is the number of failed steps.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"
export LINEAGE_HOME="${LINEAGE_HOME:-$HOME/.lineage}"
export LINEAGE_GPU_DEVICE="${LINEAGE_GPU_DEVICE:-0}"
SKIP_E2E=0; SKIP_LLMC=0
for a in "$@"; do case "$a" in --skip-e2e) SKIP_E2E=1;; --skip-llmc) SKIP_LLMC=1;; esac; done
for f in scripts/calibrate-recipe.ts scripts/verify.ts packages/core/src/main.ts recipes/fixture-cuda/recipe.yml recipes/llmc-cuda/recipe.yml; do
  [[ -f "$f" ]] || { echo "missing $f: the bundle was made from a commit without it (see RUNBOOK.md, step 2)"; exit 98; }
done
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="results/gpu-$TS"
mkdir -p "$OUT"
FAILED=0
step() { # step <name> <command...>
  local name="$1"; shift
  local t0=$(date +%s)
  printf '\n==== %s\n' "$name" | tee -a "$OUT/session.log"
  "$@" > >(tee "$OUT/$name.log") 2>&1
  local rc=$?
  local dt=$(( $(date +%s) - t0 ))
  printf '%s exit=%s seconds=%s\n' "$name" "$rc" "$dt" | tee -a "$OUT/steps.txt" "$OUT/session.log"
  if [[ $rc -ne 0 ]]; then FAILED=$((FAILED + 1)); fi
  return $rc
}

# ---- 0. facts about this box
{
  date -u
  uname -a
  nvidia-smi
  nvidia-smi --query-gpu=index,name,compute_cap,driver_version,memory.total,clocks.max.sm --format=csv
  grep -i -E 'RestrictProfiling|RmProfilingAdminOnly' /proc/driver/nvidia/params || true
  docker version --format 'docker {{.Server.Version}}'
  nvidia-ctk --version 2>/dev/null | head -n1
  bun --version
  git log -1 --format='lineage commit %H %cI'
  nproc; free -g; df -h .
} > "$OUT/box.txt" 2>&1
cat "$OUT/box.txt"

SM_DOT=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader -i "$LINEAGE_GPU_DEVICE" | tr -d ' ')
SM_NUM=${SM_DOT/./}
echo "GPU $LINEAGE_GPU_DEVICE compute capability $SM_DOT"

# ---- 1. image
step build-image docker build --platform linux/amd64 -t lineage/cuda:m1 images/cuda
IMAGE_ID=$(docker image inspect --format '{{.Id}}' lineage/cuda:m1)
echo "$IMAGE_ID" > "$OUT/image-id.txt"
docker image inspect lineage/cuda:m1 --format '{{json .RepoDigests}} {{.Size}} {{.Architecture}}' >> "$OUT/image-id.txt"

# ---- 2. pin the recipes to this image and this GPU's compute capability
pin() {
  local f="$1"
  sed -i -E "s#^image: .*#image: \"lineage/cuda:m1@${IMAGE_ID}\"#" "$f"
  sed -i -E "s#sm: \"[0-9]+\.[0-9]+\"#sm: \"${SM_DOT}\"#" "$f"
  sed -i -E "s#sm_[0-9]+#sm_${SM_NUM}#g; s#make SM=[0-9]+#make SM=${SM_NUM}#" "$f"
}
pin recipes/fixture-cuda/recipe.yml
pin recipes/llmc-cuda/recipe.yml
git diff -- recipes/fixture-cuda/recipe.yml recipes/llmc-cuda/recipe.yml > "$OUT/recipe-pins.diff"

# ---- 3. code
step bun-install bun install --frozen-lockfile
step unit-tests bun test packages/sandbox/test/cuda.test.ts packages/sandbox/test/parsers-recipe.test.ts packages/protocol

# ---- 4. sandbox doctor: exact replay flags + ncu counters
step doctor-gpu bun scripts/gpu/doctor-gpu.ts "$IMAGE_ID" --out "$OUT/doctor-gpu.json"
if ! grep -q 'PASS ncu reads' "$OUT/doctor-gpu.log"; then
  echo "ncu cannot read counters in the sandbox: fix the host (setup-host.sh step 4) before measuring" | tee -a "$OUT/session.log"
  exit 99
fi
bun packages/worker/src/main.ts doctor --full > "$OUT/worker-doctor.json" 2>&1 || true

# ---- 5. fixture: calibration + every planted patch judged as a single replay
step fixture-patches bun fixtures/cuda-reduce-patches/check.ts
cp fixtures/cuda-reduce-patches/check-last.json "$OUT/fixture-patches.json" 2>/dev/null || true

# ---- 6. calibrations (writes recipes/<name>/calibration.json)
step calibrate-fixture bun scripts/calibrate-recipe.ts recipes/fixture-cuda --runs 5
cp recipes/fixture-cuda/calibration.json "$OUT/fixture-cuda.calibration.json" 2>/dev/null || true
if [[ $SKIP_LLMC -eq 0 ]]; then
  step calibrate-llmc bun scripts/calibrate-recipe.ts recipes/llmc-cuda --runs 5
  cp recipes/llmc-cuda/calibration.json "$OUT/llmc-cuda.calibration.json" 2>/dev/null || true
  # canaries (tests_fail, equivalence_changed, no_improvement) and hand-written candidates, each judged
  # as one replay against calibration.json (recipes/llmc-cuda/patch-defs.json)
  step llmc-canaries bun scripts/check-canaries.ts recipes/llmc-cuda canaries
  step llmc-candidates bun scripts/check-canaries.ts recipes/llmc-cuda candidates
  cp recipes/llmc-cuda/canaries/results.json "$OUT/llmc-canaries.results.json" 2>/dev/null || true
  cp recipes/llmc-cuda/candidates/results.json "$OUT/llmc-candidates.results.json" 2>/dev/null || true
fi

# ---- 7. end to end: Core + reference + 2 verifiers on this box
if [[ $SKIP_E2E -eq 0 ]]; then
  step e2e-cuda bun scripts/gpu/e2e-cuda.ts --port 9663 --out "$OUT"
fi

# ---- 8. pack
git status --short > "$OUT/git-status.txt"
git diff > "$OUT/worktree.diff"
tar -czf "results/gpu-$TS.tar.gz" -C results "gpu-$TS"
printf '\nDONE: %s failed step(s). Results: %s and results/gpu-%s.tar.gz\n' "$FAILED" "$OUT" "$TS" | tee -a "$OUT/session.log"
cat "$OUT/steps.txt"
exit "$FAILED"
