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
| core v2 lane | packages/core/**, packages/worker/src/worker.ts, packages/worker/src/main.ts, packages/worker/src/doctor.ts, scripts/e2e.ts | DONE | 2026-10-07 |
| zig class lane | images/zig/**, recipes/fixture-zigsize/**, recipes/zig-clap/**, fixtures/zigsize/**, fixtures/zigsize-patches/** | DONE | 2026-10-07 |
| cuda class lane | images/cuda/**, recipes/fixture-cuda/**, recipes/llmc-cuda/**, fixtures/cuda-reduce/**, fixtures/cuda-reduce-patches/**, scripts/gpu/**, packages/sandbox/test/cuda.test.ts (+ additive GPU hunks in packages/sandbox/src/{docker,evaluate,parsers}.ts, one SPEC 8 row) | DONE (GPU session pending owner approval) | 2026-10-07 |
| solana class lane | images/solana/**, recipes/<solana recipe names>/**, fixtures/<solana fixture>/** | DONE | 2026-10-07 |
| famous repos lane | recipes/bitcoin-base58/**, recipes/geth-rlp/**, recipes/ollama-tokenizer/**, recipes/lc-text-splitters/**, images/go/**, images/cpp/**, scripts/make-canaries.ts (patch-defs discovery), packages/sandbox/src/repo.ts + test/repo-shallow.test.ts (single-commit shallow mirrors) | DONE | 2026-10-07 |
| live lane | packages/core/** (activity, heartbeat, runway, stats), packages/worker/src/** (telemetry), packages/sandbox/src/evaluate.ts (phase callback only), apps/web/**, scripts/e2e.ts, scripts/network.ts | DONE | 2026-10-07 |
| onchain lane | onchain/**, packages/chain/**, docs/SPEC.md section 14 | DONE (not deployed; devnet deploy awaits owner approval and SOL, onchain/DEPLOY.md) | 2026-10-07 |
| devnet wiring lane | packages/chain/**, scripts/devnet/**, onchain/DEVNET.md, packages/core/** (chain mode only) | DONE | 2026-10-07 |
| wallet UI lane | apps/web/**, packages/chain/src/browser/**, packages/chain/src/cosign.ts, packages/chain/test/browser*, packages/worker/src/main.ts (cosign case only), onchain/DEVNET.md (own section) | DONE (devnet e2e 18/18 on the programs deployed 2026-10-07; rerun apps/web/scripts/wallet-e2e.ts after the onchain fixes lane upgrades them) | 2026-10-07 |
| onchain fixes lane | onchain/**, packages/chain/**, packages/core/src/chain.ts, packages/core/src/core.ts (slash/epoch chain paths only), packages/core/test/chain.test.ts | DONE (devnet upgraded and migrated, e2e 24/24; onchain/DEVNET.md) | 2026-10-07 |
| core hardening lane | packages/core/** (not chain.ts), scripts/e2e.ts | DONE (bun test packages 267/267, e2e 43/43) | 2026-10-07 |
| identity+collab plan lane | docs/plans/**, research/identity-collab/** | DONE (cd41be4) | 2026-10-07 |
| collab offchain lane | packages/core/**, packages/worker/**, packages/protocol/src (signStatement only), apps/web/**, scripts/e2e.ts, docs/SPEC.md (collab sections) | DONE (I2b, C1, C4; bun test packages 291/291, e2e 59/59) | 2026-10-07 |
| identity onchain lane | onchain/**, packages/chain/**, packages/core/src/chain.ts, packages/core/src/http.ts (authenticate), packages/core/src/core.ts (closeEpochInner, records), packages/core/src/records.ts, scripts/verify-credential.ts, scripts/devnet/**, apps/web/wallet/** | DONE (I1+I2; devnet registry upgraded and migrated, e2e-devnet 37/37, wallet-e2e 26/26; onchain/DEVNET.md) | 2026-10-07 |
| verification lane | docs/VERIFICATION.md, apps/web/scripts/seed-dev.ts, docs/RUNBOOK.md, fixes found (report each) | DONE (clean clone, every check PASS except CUDA and live-Core credential NOT RUN; 8 fixes incl. shadow records leak; docs/VERIFICATION.md) | 2026-10-07 |
| bounties lane | onchain/**, packages/chain/**, packages/core/src/chain.ts, packages/core/src/bounties.ts (+ its 5 routes in http.ts, test/bounties.test.ts), apps/web/wallet/**, apps/web/scripts/wallet-e2e.ts, scripts/devnet/**, docs/SPEC.md 14.7 | IN PROGRESS | 2026-10-08 |
| hosted runtime lane | packages/runtime/**, packages/core (usage + provenance endpoints only), apps/web/src/pages (provenance panels), scripts/runtime/** | IN PROGRESS | 2026-10-08 |
| collab offchain 2 lane | packages/core/** (series, messages), packages/worker/**, apps/web/src/**, scripts/e2e.ts, docs/SPEC.md (C2/C3 sections) | DONE (C3 stacked series, C2 messages; bun test packages 326/326, e2e 72/72; SPEC 0.15) | 2026-10-08 |
| site deploy lane | scripts/deploy/**, docs/DEPLOY-SITE.md | IN PROGRESS | 2026-10-08 |
| GPU session lane | scripts/gpu/**, images/cuda/**, recipes/fixture-cuda/**, recipes/llmc-cuda/**, fixtures/cuda-reduce*/**, docs/GPU-SESSION.md | IN PROGRESS | 2026-10-08 |
