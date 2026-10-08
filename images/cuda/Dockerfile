# Lineage sandbox image for the cuda target class (SPEC 6.1). linux/amd64 only.
# Referenced by image id (sha256) in recipes, never by tag alone.
#
# Base: nvidia/cuda:12.6.3-devel-ubuntu22.04, pinned to its linux/amd64 manifest digest
# (looked up with `docker buildx imagetools inspect` on 2026-10-07, nothing pulled). The devel image
# already ships nvcc and the Nsight Compute CLI (package cuda-nsight-compute-12-6=12.6.3-1, ncu
# under /usr/local/cuda/bin), so this layer only adds the runner user and stable entry points.
#
# Host requirements (checked by scripts/gpu/doctor-gpu.sh, not by this image):
#   - NVIDIA driver >= 560.35.05 (CUDA 12.6 Update 3). The image also carries cuda-compat for
#     older datacenter drivers, but ncu is only supported on a driver at least the toolkit's.
#   - nvidia-container-toolkit, so `docker run --gpus device=N` works.
#   - GPU performance counters open to non-admin users on the HOST
#     (NVreg_RestrictProfilingToAdminUsers=0, or the R610+ profiler-device capability made world
#     readable). The sandbox runs ncu as uid 10001 with --cap-drop ALL and no-new-privileges, so
#     --cap-add SYS_ADMIN would not help anyway (a non-root process gets no effective capabilities).
#
# Build (on the GPU box): docker build --platform linux/amd64 -t lineage/cuda:m1 images/cuda
FROM nvidia/cuda:12.6.3-devel-ubuntu22.04@sha256:1608a19a5d6f013d36abfb9ad50a42b4c0ef86f4ab48e351c6899f0280b946c1

# Fail the build early if the toolchain is not where recipes expect it.
RUN test -x /usr/local/cuda/bin/nvcc \
 && NCU="$(ls -1 /usr/local/cuda/bin/ncu /opt/nvidia/nsight-compute/*/ncu 2>/dev/null | head -n 1)" \
 && test -n "$NCU" \
 && printf '#!/bin/sh\nexec %s "$@"\n' "$NCU" > /usr/local/bin/ncu \
 && printf '#!/bin/sh\nexec /usr/local/cuda/bin/nvcc "$@"\n' > /usr/local/bin/nvcc \
 && chmod 0755 /usr/local/bin/ncu /usr/local/bin/nvcc \
 && /usr/local/bin/nvcc --version \
 && /usr/local/bin/ncu --version

RUN useradd -u 10001 -m runner
# The sandbox clears PATH (packages/sandbox/src/evaluate.ts envFor) to a list that includes
# /usr/local/bin, which is why the wrappers above live there. LD_LIBRARY_PATH and the NVIDIA_*
# variables from the base image are kept because the sandbox only adds variables.
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility CUDA_MODULE_LOADING=EAGER
# The base image's entrypoint (/opt/nvidia/nvidia_entrypoint.sh) prints a licence banner to stdout on
# every `docker run`, which lands in test, equivalence and metric output. The sandbox runs
# `sh -c <cmd>` itself, so the entrypoint is cleared (found in the 2026-10-08 GPU session).
ENTRYPOINT []
USER 10001
WORKDIR /work
