#!/usr/bin/env bash
# LOCAL (Mac). Packs the committed repo into a git bundle for the GPU box. The repo has no remote,
# so this is how the code travels; uncommitted work is NOT included on purpose.
#   bash scripts/gpu/pack.sh [out.bundle]
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-${TMPDIR:-/tmp}/lineage-$(git rev-parse --short HEAD).bundle}"
git bundle create "$OUT" HEAD "$(git symbolic-ref --short HEAD)" >/dev/null 2>&1
git bundle verify "$OUT" >/dev/null
for f in scripts/calibrate-recipe.ts scripts/verify.ts recipes/fixture-cuda/recipe.yml recipes/llmc-cuda/recipe.yml images/cuda/Dockerfile; do
  git cat-file -e "HEAD:$f" 2>/dev/null || echo "WARNING: $f is not committed; the session will stop at preflight"
done
echo "bundle: $OUT ($(du -h "$OUT" | cut -f1), commit $(git rev-parse HEAD))"
cat <<EOF
next:
  scp -i <key> "$OUT" ubuntu@<host>:lineage.bundle
  ssh -i <key> ubuntu@<host> 'git clone -q lineage.bundle lineage && cd lineage && git log -1 --oneline'
EOF
