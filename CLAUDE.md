# lineage (placeholder name)

Autonomous software-evolution network: agents mutate real repos, independent agents replay,
accepted improvements form a public lineage. Separate crypto project, NOT part of Instance.

Spec: `docs/SPEC.md` (source of truth). Milestones: `docs/MILESTONES.md`.

## Rules
- Ports owned by this repo: 9660-9669 (9660 Core API, 9661 web, 9662-9669 tests/workers). `lsof -ti :<port>` before binding.
- No em dashes anywhere. No monospace fonts in UI. Never invent numbers in UI or docs: every figure is measured or marked TBA.
- Docker sandboxes: never `docker rm -f $(docker ps -aq)` or prune globally; only touch containers labelled `lineage=1`.
- No secrets in the repo. Model key lives at `~/.config/lineage/model.env` (owner provides).
- Commit your own work before going idle.

## Who is working on what
| Who | Paths | Status | Started |
|---|---|---|---|
| main session | docs/, packages/protocol, packages/sandbox, images/, recipes/, fixtures/ | IN PROGRESS | 2026-10-07 |
| core lane | packages/core/** | DONE | 2026-10-07 |
| recipes lane | recipes/base58-py/**, recipes/minbpe/**, recipes/base58-rs/**, recipes/fixture-b58/calibration.json, scripts/calibrate-recipe.ts, scripts/make-canaries.ts, scripts/check-canaries.ts | DONE | 2026-10-07 |
| dashboard lane | apps/web/** | DONE | 2026-10-07 |
| core v2 lane | packages/core/**, packages/worker/src/worker.ts, packages/worker/src/main.ts, packages/worker/src/doctor.ts, scripts/e2e.ts | IN PROGRESS | 2026-10-07 |
| zig class lane | images/zig/**, recipes/<zig recipe names>/**, fixtures/<zig fixture>/** | IN PROGRESS | 2026-10-07 |
| cuda class lane | images/cuda/**, recipes/fixture-cuda/**, recipes/llmc-cuda/**, fixtures/cuda-reduce/**, fixtures/cuda-reduce-patches/**, scripts/gpu/**, packages/sandbox/test/cuda.test.ts (+ additive GPU hunks in packages/sandbox/src/{docker,evaluate,parsers}.ts, one SPEC 8 row) | DONE (GPU session pending owner approval) | 2026-10-07 |
| solana class lane | images/solana/**, recipes/<solana recipe names>/**, fixtures/<solana fixture>/** | IN PROGRESS | 2026-10-07 |
