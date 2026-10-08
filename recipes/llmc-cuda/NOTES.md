# llmc-cuda recipe notes

- Repo: https://github.com/karpathy/llm.c at f1e2ace651495b74ae22d45d1723443fd00ecd3a (master, 2025-05-10).
- Licence: MIT ("Copyright (c) 2024 Andrej Karpathy"), OSI approved. The overlay harness follows the
  CPU references in llm.c `dev/cuda/*.cu`.
- Upstream policy (SPEC 16): the repo is effectively archived (last commit May 2025, no CONTRIBUTING
  file). Lineage measures it and keeps its lineage public; it does not open pull requests upstream
  unless the owner decides otherwise.
- Why these files: `llmc/encoder.cuh`, `llmc/layernorm.cuh`, `llmc/gelu.cuh` are the kernels
  `train_gpt2.cu` runs every step and need no cuBLAS, cuDNN, NCCL or weights. matmul and attention
  (cuBLASLt / cuDNN) are deliberately out of scope for M1.
- Known failure (confirmed 2026-10-08): `fused_residual_forward_kernel5` guards with `if(idx > N) return;`
  (`layernorm_forward_kernel6` uses `>=`). With B*T not a multiple of the 8 rows per block, the thread
  for row N writes residual, normed, mean and rstd one row past the end. The harness test
  `fused_residual_forward_B1_T13_C768_guard_rows` fails on every calibration run, so calibration lists it
  as the recipe's one known failure. The fix candidate `candidates/fix_fused_residual_guard` (`>=`) was
  judged accepted as a fix in a single replay (results in candidates/results.json).
- Calibration: done on an RTX 4000 Ada (sm 8.9, driver 580.173.02), 5 runs: stable 16, known failures 1,
  quarantined 0; all five warp-instruction metrics cv 0 (calibration.json).
- Canaries (canaries/, made by scripts/make-canaries.ts from patch-defs.json, judged by
  scripts/check-canaries.ts): gelu_no_cube -> tests_fail, encoder_clamp_ids -> equivalence_changed,
  gelu_sinh_cosh -> no_improvement (ratio 1.97731). All three rejected as expected.
- Candidate gelu_bwd_sech_from_tanh (sech^2 = 1 - tanh^2 in GeLU backward, drops coshf): accepted in a
  single replay, gelu_bwd_inst 45211376 -> 31055600, ratio 0.68690.
- Data dependence: gelu_fwd_inst and gelu_bwd_inst vary by a few hundred instructions between seeds
  (tanhf takes value-dependent paths), for example 25156200 vs 25156040. Same seed, same count (cv 0);
  replays compare base and candidate on the same seed, so the ratio is unaffected.
- Compile check before the session: nvcc 12.6.85, -arch=sm_89, compile only (aarch64 host). On the box it linked and ran unchanged.
