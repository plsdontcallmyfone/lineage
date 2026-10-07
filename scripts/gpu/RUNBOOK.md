# GPU session runbook (cuda target class, SPEC 6.1)

Goal: one short rented session that proves the `cuda` class end to end: image, sandbox with GPU,
Nsight Compute counters under the sandbox's hardening, a calibrated fixture lineage, a calibrated
real lineage (karpathy/llm.c kernels), and a Core + reference + 2 verifier run where planted
patches are accepted or rejected for the right reason.

Nothing here spends money by itself. Renting is the owner's call (see "Owner decisions").

## 1. What to rent

The box must be a full VM with root (we load a kernel module option and run Docker). Container
products (RunPod pods, Vast.ai containers) do not work: no Docker inside, no driver options.

| Option | GPU (compute capability) | vCPU / RAM / disk | On-demand price | Notes |
|---|---|---|---|---|
| **A. Lambda Cloud 1x A6000** (recommended) | RTX A6000 48 GB (sm 8.6) | 14 / 100 GiB / 512 GiB | **$1.09 per hour** plus tax | Ubuntu + Lambda Stack (driver and NVIDIA Container Toolkit preinstalled); no quota request. Availability varies by region and hour. |
| A2. Lambda Cloud 1x A10 (fallback if A6000 is sold out) | A10 24 GB (sm 8.6) | 30 / 226 GiB / 1.3 TiB | **$1.29 per hour** plus tax | Same sm as A6000, so the same recipes apply unchanged. |
| B. AWS EC2 g6.xlarge, us-east-1 | L4 24 GB (sm 8.9) | 4 / 16 GiB / EBS | **$0.8048 per hour** plus EBS | Cheapest, but a new AWS account has a default quota of 0 vCPU for "Running On-Demand G and VT instances" (quota code L-DB2E81BA); request 4 vCPU first, which can take time or be refused. Use the "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)", 100 GB gp3 root. |

Prices looked up 2026-10-07:
[Lambda pricing](https://lambda.ai/pricing) (1x A6000 $1.09, 1x A10 $1.29, per GPU-hour, plus sales tax),
[DoiT g6.xlarge us-east-1](https://compute.doit.com/spot/us-east-1/g6.xlarge) and
[Holori g6.xlarge](https://calculator.holori.com/aws/ec2/g6.xlarge/us-east-1) ($0.8048 on demand),
[AWS EC2 instance quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html) (G and VT default 0),
[Lambda Stack](https://lambda.ai/lambda-stack-deep-learning-software) (bundles the NVIDIA Container Toolkit; Docker engine itself not confirmed, setup-host.sh installs it if missing).

The recipes default to sm 8.6 (option A). `session.sh` re-pins them to whatever GPU the box has,
so option B works too; just do not mix sm values between verifiers of one lineage.

## 2. Before renting (local, free)

1. Commit everything the session needs (cuda lane, `scripts/calibrate-recipe.ts`, core and worker).
2. `bash scripts/gpu/pack.sh` prints the bundle path and warns about anything not committed.
3. Have an SSH public key ready to paste into the provider.

## 3. On the box

```sh
# from the Mac
scp lineage-<sha>.bundle ubuntu@<host>:lineage.bundle
ssh ubuntu@<host>
git clone -q lineage.bundle lineage && cd lineage
sudo bash scripts/gpu/setup-host.sh        # exit 3 = reboot needed: sudo reboot, reconnect, run again
exit; ssh ubuntu@<host>; cd lineage          # new login so the docker group applies
tmux new -s gpu                              # survive a dropped SSH connection
bash scripts/gpu/session.sh 2>&1 | tee session.out
```

`session.sh` steps (each logged to `results/gpu-<timestamp>/<step>.log`, keeps going on failure):

| Step | What it proves | Expected |
|---|---|---|
| box facts | GPU, sm, driver, profiling param, versions | recorded |
| build-image | `images/cuda` builds on the pinned base digest | image id recorded, recipes re-pinned to it |
| unit-tests | parsers and GPU flags | pass |
| doctor-gpu | the exact replay flags (uid 10001, `--cap-drop ALL`, `no-new-privileges`, read-only root, no network) plus `--gpus device=0` run nvcc, a kernel, and `ncu` twice with identical warp instruction counts | all PASS; stops the session if ncu cannot read counters |
| fixture-patches | calibration of `recipes/fixture-cuda` and each planted patch as one replay | 7/7 as in `fixtures/cuda-reduce-patches/index.json` |
| calibrate-fixture, calibrate-llmc | `calibration.json` for both recipes, 5 runs | warp-instruction metrics enabled with cv 0; llmc known failures listed (see recipes/llmc-cuda/NOTES.md) |
| e2e-cuda | Core + reference + 2 verifier processes, GPU qualification, perf accepted, tests/equivalence/regression/guard rejected, verdicts recomputed by `scripts/verify.ts` | all checks PASS |

Expected outcomes are EXPECTATIONS, not observations: nothing CUDA has run yet.

Copy results back, then terminate the instance in the provider console (stopping is not enough on
Lambda; terminate):

```sh
scp -r ubuntu@<host>:lineage/results/gpu-<timestamp>.tar.gz .
scp ubuntu@<host>:lineage/recipes/fixture-cuda/calibration.json recipes/fixture-cuda/
scp ubuntu@<host>:lineage/recipes/llmc-cuda/calibration.json recipes/llmc-cuda/
scp ubuntu@<host>:lineage/results/gpu-<timestamp>/recipe-pins.diff .   # apply: real image id + sm
```

## 4. Time and cost estimate

Estimates, not measurements:

| Phase | Wall time |
|---|---|
| Boot, SSH, setup-host (incl. one possible reboot) | 15 to 25 min |
| build-image (4.06 GB compressed base layers to pull) | 5 to 10 min |
| doctor, unit tests | 3 min |
| fixture-patches (calibration + 7 replays) | 10 to 20 min |
| calibrations (fixture + llm.c, 5 runs each) | 15 to 25 min |
| e2e-cuda (calibration, 2 qualifications, 6 candidates x 2 replays, GPU shared in turns) | 25 to 45 min |
| Copy back, terminate | 5 min |
| **Total** | **about 1.5 to 2.5 hours**, budget 4 hours for debugging |

Cost at option A ($1.09 per hour): about $1.65 to $2.75 for the plan, **$4.36 for the 4 hour cap**,
plus sales tax. Option A2: $5.16 cap. Option B: $3.22 cap plus a few cents of EBS.

## 5. Profiling permission (the one host change)

`ncu` reads GPU performance counters. NVIDIA drivers reserve them for admin users by default
(`ERR_NVGPUCTRPERM`). NVIDIA's guidance for containers: either enable access on the host, or start
the container with `--cap-add=SYS_ADMIN` as an admin user
([NVIDIA, ERR_NVGPUCTRPERM](https://developer.nvidia.com/nvidia-development-tools-solutions-err_nvgpuctrperm-permission-issue-performance-counters)).

We use the host option: `options nvidia NVreg_RestrictProfilingToAdminUsers=0` in
`/etc/modprobe.d/`, then reload the driver or reboot (setup-host.sh does both). The sandbox grants
nothing extra: `--gpus device=N` only. `--cap-add SYS_ADMIN` is not a usable alternative here: the
sandbox runs as uid 10001 with `no-new-privileges`, and a non-root process does not get added
capabilities in its effective set, so it would only work by running ncu as root in the container,
which also hands the patch author's code CAP_SYS_ADMIN. On R610+ drivers NVIDIA also offers
per-node grants (`/dev/nvidia-caps` profiler-device made readable); the regkey still works there and
doctor-gpu decides by actually running ncu.

Trade-off: opening counters host-wide exposes a known performance-counter side channel between
users of the same host. A verifier box must therefore be dedicated (SPEC 8 note).

## 6. If something fails

- `ERR_NVGPUCTRPERM` in doctor-gpu: param still 1. `cat /proc/driver/nvidia/params`, rerun setup-host, reboot.
- `docker: could not select device driver "" with capabilities: [[gpu]]`: toolkit not configured; `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
- nvidia hook fails with a read-only root filesystem: record the error in the results. Workaround to
  test (do not commit without review): run doctor-gpu with the image rebuilt, or file it as a sandbox
  finding; the read-only root is a SPEC 8 control and must not be dropped silently.
- `host GPU 0 ... is sm X but the recipe requires sm Y`: the pin step did not run; rerun session.sh.
- llm.c harness compile error: it was compile-checked with nvcc 12.6.85 for sm_89 off-box but never
  linked; fix in `recipes/llmc-cuda/overlay/lineage/harness.cu`, rerun with `--skip-e2e`.

## 7. Limits of a one-box proof

Core, reference and both verifiers share one GPU, one host and one operator. This proves the
pipeline, the sandbox and cross-process determinism of warp instruction counts. It does not prove
independence: that needs at least two boxes from different operators (then also check that two
different GPUs of the same sm agree, for example A6000 vs A10, which differ in SM count).

## Owner decisions

1. Approve renting: provider (A, A2 or B), and a spending cap (suggested $10 including tax).
2. Provide or create the provider account and payment method yourself (agents may not), and an SSH key.
3. For option B only: file the G and VT on-demand quota request (4 vCPU) in the chosen region.
4. Decide whether results (calibration.json, image id pin) get committed after the session.
