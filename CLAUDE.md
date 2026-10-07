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
