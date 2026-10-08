# lineage/worker: a verifier or author worker (`lineage-worker run`) in a container (plan W9b).
#
# The worker starts sandbox containers through the HOST Docker daemon (Docker-outside-of-Docker):
# mount /var/run/docker.sock. That socket is root-equivalent on the host; prefer rootless Docker and a
# host that runs nothing else (docs/RUNBOOK.md "Worker image"). Sandboxes are siblings of this
# container, and the daemon resolves their bind mounts on the host, so LINEAGE_HOME must be mounted
# at the SAME absolute path inside and outside (default /var/lib/lineage). Keys are mounted read-only.
#
# Build from the repository root:  docker build -f images/worker/Dockerfile -t lineage/worker .
# Run (stop with `docker stop -t 900` so the drain can reveal what was committed):
#   docker run -d --name lineage-worker --stop-timeout 900 \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v /var/lib/lineage:/var/lib/lineage \
#     -v /etc/lineage/agent.json:/keys/agent.json:ro \
#     lineage/worker run --core https://<core> --key /keys/agent.json
FROM docker:27.5.1-cli AS dockercli

FROM oven/bun:1.3.13-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/lineage
# workspace manifests first, so a source change does not reinstall dependencies
COPY package.json bun.lock tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/chain/package.json packages/chain/
COPY packages/core/package.json packages/core/
COPY packages/worker/package.json packages/worker/
COPY packages/souls/package.json packages/souls/
COPY packages/runtime/package.json packages/runtime/
COPY packages/mirror/package.json packages/mirror/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY packages packages
COPY fixtures fixtures
COPY recipes recipes
COPY config config
# a Rust or C++ sandbox writes build output as the worker's uid on Linux (src/docker.ts containerUser);
# the default root user here makes the sandboxes run as 10001, and can clean up after them
ENV LINEAGE_HOME=/var/lib/lineage
RUN mkdir -p /var/lib/lineage && ln -s /opt/lineage/packages/worker/src/main.ts /usr/local/bin/lineage-worker
LABEL org.opencontainers.image.title="lineage/worker" org.opencontainers.image.description="Lineage verifier and author worker; sandboxes run on the host Docker daemon"
STOPSIGNAL SIGTERM
# tini forwards SIGTERM to the worker (which drains: finishes and reveals committed replays) and reaps docker CLI children
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "/opt/lineage/packages/worker/src/main.ts"]
CMD ["--help"]
