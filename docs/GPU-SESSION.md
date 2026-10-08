# GPU session, 2026-10-08

First run of the `cuda` target class (SPEC 6.1) on a real GPU. Every number below was measured in this
session; raw logs are in `scripts/gpu/results/2026-10-08/`.

## Box

| Item | Value |
|---|---|
| Provider | DigitalOcean GPU droplet, region tor1, droplet id 607248053, 159.203.62.37 |
| Size | 1x NVIDIA RTX 4000 Ada Generation (20 GB, sm 8.9), 8 vCPU, 31 GiB RAM visible, 485 GB root filesystem. The metadata service does not report the size slug; by hardware it is DigitalOcean's single RTX 4000 Ada size |
| OS, driver | Ubuntu 22.04, NVIDIA driver 580.173.02, Docker 29.1.3, NVIDIA Container Toolkit 1.19.1, bun 1.3.13 |
| Image | `lineage/cuda:m1@sha256:4f440a3ca551ebdeb52aecf6ce34283af257d8f5d31329493c9b8e3d4a9dd715` (image id, 4064641041 bytes, amd64), built on the box from `images/cuda` on base `nvidia/cuda:12.6.3-devel-ubuntu22.04@sha256:1608a19a5d6f013d36abfb9ad50a42b4c0ef86f4ab48e351c6899f0280b946c1` |
| Code | bundle of lineage commit 5d7ef67 plus the session fixes in this commit |

## Checks

| # | Check | Result |
|---|---|---|
| 1 | setup-host: container toolkit configured, `NVreg_RestrictProfilingToAdminUsers=0`, one reboot, bun 1.3.13, hardened GPU smoke container | PASS |
| 2 | build `images/cuda` on the pinned base digest | PASS |
| 3 | unit tests (cuda, parsers, protocol): 70 tests | PASS |
| 4 | doctor-gpu, 7/7: GPU visible as uid 10001 with read-only root, nvcc builds and runs a kernel, ncu reads `smsp__inst_executed.sum` with no extra capabilities, two runs equal (425984 vs 425984) | PASS |
| 5 | recipes pinned to the image id and sm 8.9 (`fixture-cuda`, `llmc-cuda`) | PASS |
| 6 | fixture planted patches, single replay each, 7/7 as expected | PASS |
| 7 | calibrate fixture-cuda, 5 runs: stable 14, known failures 0, quarantined 0; `reduce_warp_inst` cv 0, `scale_warp_inst` cv 0; `reduce_us` cv 0.00225 | PASS |
| 8 | calibrate llmc-cuda, 5 runs: stable 16, known failures 1, quarantined 0; all 5 warp-instruction metrics cv 0; `layernorm_fwd_us` cv 0.0142 | PASS |
| 9 | llm.c canaries (new), 3/3 rejected for the expected reason | PASS |
| 10 | upstream bug `idx > N` in `fused_residual_forward_kernel5` shows as a known failure at calibration | PASS (confirmed: `fused_residual_forward_B1_T13_C768_guard_rows` fails on every run) |
| 11 | one honest llm.c improvement | PASS: gelu backward, ratio 0.68690 |
| 12 | CUDA e2e (`scripts/gpu/e2e-cuda.ts`): Core + reference + 2 verifier processes, 15/15 checks, 386 s | PASS |

No drift found: every deterministic metric had cv 0 in both calibrations, and the two verifiers in the
e2e reproduced the calibration counts during qualification. The one variation seen is by seed, not by
run: `gelu_fwd_inst` and `gelu_bwd_inst` differ by a few hundred instructions between seeds (tanhf takes
value-dependent paths; for example 25156200 vs 25156040), while the same seed always gives the same
count. Replays compare base and candidate on one seed, so ratios are unaffected. The fixture's absolute
counts also depend on the seed (its bench shapes are seeded), which is why check.ts and
calibrate-recipe.ts report different base values.

## Fixture patches (single replay, `fixtures/cuda-reduce-patches/check.ts`)

| Patch | Outcome | Metric | Base | Candidate | Ratio |
|---|---|---|---|---|---|
| perf_reduce | accepted | reduce_warp_inst | 33510687 | 14690743 | 0.4384 |
| perf_reduce_warp (on perf_reduce) | accepted | reduce_warp_inst | 14688957 | 6415110 | 0.4367 |
| perf_scale | accepted | scale_warp_inst | 1877281 | 1461276 | 0.7784 |
| equiv_change | rejected: equivalence_changed | scale_warp_inst | 1877281 | 1237766 | not judged |
| regress | rejected: no_improvement | reduce_warp_inst | 33421059 | 33814827 | 1.0118 |
| break_tests | rejected: tests_fail | reduce_warp_inst | 33510687 | 33508650 | not judged |
| protected_test_edit | rejected: guard (PROTECTED_PATH) | none | none | none | not run |

## End to end (`scripts/gpu/e2e-cuda.ts`, 2 verifiers, quorum 2)

Both verifiers declared the GPU, passed qualification ("stable set reproduced; reduce_warp_inst,
scale_warp_inst match calibration"), and judged:

| Candidate | Verdict | Ratio |
|---|---|---|
| break_tests | rejected: tests_fail | |
| equiv_change | rejected: equivalence_changed | |
| regress | rejected: no_improvement | 1.011782032400589 |
| protected_test_edit | rejected: guard | |
| perf_reduce | accepted | 0.4383897889052528 |
| perf_reduce_warp | accepted | 0.43673012318029114 |
| perf_scale | accepted | 0.7784685526426932 |

Lineage height 3. `scripts/verify.ts`: 7/7 verdicts recomputed from public data.

## llm.c (`recipes/llmc-cuda`, `scripts/check-canaries.ts`, single replay each)

| Patch | Kind | Outcome | Target metric: base to candidate | Ratio |
|---|---|---|---|---|
| canary gelu_no_cube | perf | rejected: tests_fail (gelu_forward_N65536, gelu_forward_N8192_wide_range) | gelu_fwd_inst 25156200 to 23585096 | not judged |
| canary encoder_clamp_ids | perf | rejected: equivalence_changed | encoder_fwd_inst 2727936 to 2752512 | not judged |
| canary gelu_sinh_cosh | perf | rejected: no_improvement | gelu_fwd_inst 25156200 to 49741655 | 1.97731 |
| candidate gelu_bwd_sech_from_tanh | perf | accepted | gelu_bwd_inst 45211376 to 31055600 | 0.68690 |
| candidate fix_fused_residual_guard | fix | accepted (fixes the known failure) | none | |

The improvement: GeLU backward computed both `tanhf(a)` and `coshf(a)`; `sech^2(a) = 1 - tanh^2(a)`, so the
`coshf` call and its division go away, inside the bf16 tolerance on every test and seeded shape. 31.3%
fewer executed warp instructions in `gelu_backward_inplace_kernel` at GPT-2 small shapes. Not measured:
wall time of that kernel (the recipe times layernorm only).

## Fixes made in this session

- `images/cuda/Dockerfile`: `ENTRYPOINT []`. The NVIDIA base entrypoint printed a licence banner to
  stdout on every container run, into test, equivalence and metric output (doctor-gpu failed on it). The
  image id above is with this fix.
- setup-host.sh, doctor-gpu.ts, session.sh: driver 580 exposes the profiling switch as
  `RmProfilingAdminOnly` in `/proc/driver/nvidia/params`; the scripts only knew
  `RestrictProfilingToAdminUsers` (setup-host would have exited under `set -e` after a live reload).
- e2e-cuda.ts: registers with real capabilities from the worker doctor (core v2), waits for
  qualification through the agent view, submits the rejections before the accepted patches (equiv_change
  and regress no longer apply once perf_scale and perf_reduce rewrite their kernels; the first attempt
  stopped at "equiv_change does not apply to the current parent"), adds perf_reduce_warp, reads ratios
  from the stored verdict.
- session.sh runs the llm.c canaries and candidates after calibration.
- No sandbox changes were needed.

## Time and cost

| Phase | Wall time (UTC) |
|---|---|
| First SSH to box idle (setup with one reboot, image build, session.sh, llm.c checks, two e2e runs, copy back) | 11:17 to 11:44, about 27 minutes |
| Droplet uptime when this session first connected | 2 minutes (booted about 11:15) |

Rate: about 0.76 USD per hour for this size (third-party trackers, not confirmed against the invoice).
Cost of the work: about 0.5 hours, about 0.38 USD. The droplet keeps billing until it is destroyed:
the total is 0.76 USD times the hours from creation to destruction.

## Not proved here

One box, one GPU, one operator: this proves the pipeline, the sandbox flags with a GPU, and
cross-process determinism of warp-instruction counts. Independence needs two boxes from different
operators, and agreement between two GPUs of the same sm with different SM counts was not tested.
The recipes are now pinned to sm 8.9; an sm 8.6 verifier needs its own re-pin (session.sh) and a
separate lineage.
