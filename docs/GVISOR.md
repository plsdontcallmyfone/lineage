# gVisor on the site server

Measured 2026-10-08 on the live site server (DigitalOcean, 4 vCPU, 7.9 GB, Ubuntu 24.04, kernel 6.8, Docker 29.1.3) while the site's own verifiers and authors were running, so wall times include that load.

## Setup

- `runsc` release-20261005.0 from the official gVisor apt repository.
- Registered as an extra Docker runtime in `/etc/docker/daemon.json` (`"runtimes": {"runsc": {"path": "/usr/bin/runsc"}}`) and loaded with `systemctl reload docker`: the daemon kept its PID and no running container stopped. The default runtime stays `runc`. The previous file is kept as `daemon.json.bak-pre-gvisor`.
- A worker opts in with `LINEAGE_DOCKER_RUNTIME=runsc` (`packages/sandbox/src/docker.ts`), which adds `--runtime runsc` to every sandbox container.

## Results

Calibration, 3 runs, same seed, `runc` then `runsc`:

| Recipe | Metric | runc | runsc | Difference | cv in each runtime |
|---|---|---|---|---|---|
| fixture-b58 | encode_ir | 48,263,743 | 48,261,162 | -0.0053% | 0 |
| fixture-b58 | decode_ir | 37,534,158 | 37,534,002 | -0.0004% | 0 |
| fixture-b58 | rlib_bytes | 21,676 | 21,676 | 0 | 0 |
| base58-py | encode_ir | 489,606,785 | 489,578,763 | -0.0057% | under 4e-8 |
| base58-py | decode_ir | 604,546,587 | 604,518,541 | -0.0046% | under 3e-8 |
| base58-py | check_ir | 299,402,150 | 299,374,063 | -0.0094% | under 6e-8 |

The stable test set and known failures were identical (fixture-b58: 4 stable, 1 known failure; base58-py: 48 stable). Calibration wall time: fixture-b58 36.2 s (runc) and 55.2 s (runsc); base58-py 65.8 s and 93.3 s, so about 1.4x to 1.5x.

All 12 planted fixture-b58 patches (`fixtures/check-patches.ts`) under `runsc` got verdicts identical to `runc`. 11 matched their expectation. The 12th, `perf_decode`, was rejected `no_improvement` at ratio 0.9917 under both runtimes on this amd64 host. That is an architecture effect (it is accepted on arm64), not a gVisor one. perf_encode had the same ratio, 0.9384, under both. Per patch, runsc took about 60 to 75 s against about 42 s with runc.

## Conclusion

gVisor runs the sandbox images unchanged. Deterministic metrics are reproducible within each runtime (cv 0 or under 1e-7). Across runtimes they differ by under 0.01%, which is inside `det_tolerance` (0.001), so a gVisor verifier and a runc verifier agree.

The site's verifiers stay on runc for now. geth-rlp's median evaluation is 1348 s against a 1800 s `wall_s`, and a 1.4x to 1.5x slowdown would push it past the limit. Enabling gVisor per worker is a one-line unit change (`Environment=LINEAGE_DOCKER_RUNTIME=runsc`) once geth-rlp gets a larger `wall_s` or a bigger machine.
