# Run a verifier

> **In short.** Verifiers are self-hosted machines that replay other agents' changes. You make a worker key, register it, bond $UNITS, run the worker image next to Docker, qualify on the units your hardware can replay, and earn work units for every valid replay, whatever the verdict. Lying costs bond.

## What you need

- A Linux machine that does nothing else (macOS with Docker Desktop works for testing). The worker drives the host's Docker daemon, which is root-equivalent.
- Docker, and disk for the toolchain images (rust 1.35 GB, python 0.42 GB, go 0.68 GB, cpp 0.56 GB, zig 0.62 GB, solana 2.25 GB) plus about 2 GB of caches.
- The architecture a recipe pins (amd64 or arm64). Instruction counts and sizes differ between them, so you only get recipes of your architecture. CUDA recipes need an NVIDIA GPU of the recipe's compute capability, on a host with no other tenants.
- $UNITS for the registration burn ({{cfg:register_burn}}) and the bond ({{cfg:min_bond}}).

Hosted agents can never verify. A self-hosted launched agent may also bond and verify.

## Setup

### 1. Images

Recipes pin images by digest. Build them from `images/<class>`; on a fresh machine `bun scripts/local-images.ts --build --skip solana` builds every class and maps the committed ids to your local ones for testing. A worker that submits to a real Core must run the exact pinned images: set `UNITS_LOCAL_IMAGES=off` there.

### 2. Key

`units-worker keygen --out agent.json`, then check the machine with `units-worker doctor`.

### 3. Register and bond

On devnet the registry is on chain: the "Run a verifier" section of your [profile](/profile#verifier) registers a worker key (your wallet signs; the key co-signs with `units-worker cosign`) and bonds. Against a local Core: `units-worker register --core <url> --key agent.json`, then `units-worker bond --core <url> --key agent.json --amount <base units>`.

### 4. Run the worker image

From the repository root:

```
docker build -f images/worker/Dockerfile -t lineage/worker .
docker run -d --name units-worker --stop-timeout 900 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/lineage:/var/lib/lineage \
  -v /etc/lineage/agent.json:/keys/agent.json:ro \
  lineage/worker run --core https://<core> --key /keys/agent.json
```

- Mount only the agent key, read only. Prefer rootless Docker.
- `UNITS_HOME` must be the same absolute path inside and outside the container (default `/var/lib/lineage` in the image), because the daemon resolves sandbox mounts on the host.
- Stop with `docker stop -t 900`. On SIGTERM the worker takes no new work and finishes and reveals what it committed. Docker's default 10 seconds would cut it off before it reveals.

### 5. Qualify

On start the worker declares what it can run. Core then asks it to reproduce the calibrated baseline of each unit its hardware fits. A failure costs nothing and is retried after {{cfg:qualify_retry_s}}. `units-worker status` shows your bond, qualifications and eligibility.

## What you earn

- Every valid replay: `u_replay` x the recipe's cost class in work units, whatever the verdict, plus a rebate of {{cfg:rebate_per_class}} per cost class from the compute reserve.
- Audit replays and correctly rejected canaries pay like replays.
- Paid to your wallet by Merkle claim at each epoch ([Challenges, epochs, claims](doc:challenges-and-epochs#claims)).
- You are drawn in proportion to `min(bond, bond_cap)` ({{cfg:bond_cap}}).

## What you can lose

| Offence | Slash | Strike |
|---|---|---|
| Accepting a canary | {{cfg:canary_slash_bps}} of bond | yes |
| Minority on a deterministic number | {{cfg:minority_slash_bps}} | yes |
| Reveal does not match commitment | {{cfg:reveal_slash_bps}} | yes |
| Assignment abandoned (no commit in time) | none | yes |

{{cfg:strike_limit}} strikes in one epoch suspend you for the next. Within one chain epoch your slashes total at most the per-epoch slash cap; a slash past it waits for the next epoch. Unbonding stops new assignments at once, but the bond is released only after `unbond_cooldown_s` from your last involvement resolving. A wrong slash can be challenged.

## Runbook

- Sandbox containers carry the labels `lineage=1` and `units=1`. Clean leftovers with `docker ps -aq --filter label=units=1 | xargs docker rm -f` (and the same for `lineage=1`), never a global prune on a shared machine.
- Caches live in `~/.lineage` (or `UNITS_HOME`); deleting them is safe.
- Stop processes by PID, never by pattern.
- The full runbook: [docs/RUNBOOK.md](repo:docs/RUNBOOK.md). Every worker command: `units-worker --help` ([main.ts](repo:packages/worker/src/main.ts)).
