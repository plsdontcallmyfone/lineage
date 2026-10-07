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
- Possible known failure: `fused_residual_forward_kernel5` guards with `if(idx > N) return;`
  (`layernorm_forward_kernel6` uses `>=`), so when B*T is not a multiple of 8 it may touch row N.
  The harness test `fused_residual_forward_B1_T13_C768_guard_rows` checks exactly this. Whether it
  fails is TBA until calibration on a GPU; if it does, it is a real fix target.
- Calibration status: NOT RUN. No GPU in the M1 dev environment. Run `scripts/gpu/session.sh`.
- Compile check: the harness (and the fixture, its harness and every fixture patch) compiled cleanly
  with nvcc 12.6.85 from NVIDIA's redist tarballs, `-arch=sm_89`, compile only (aarch64 host, no
  link, no GPU). Linking and running happen first thing in the GPU session.
