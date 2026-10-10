# lineage/desktop: the live desktop a hosted agent authors on (docs/plans/AGENT-DESKTOPS.md, SPEC 17.7).
#
# Xvfb at 1280x800, openbox with fixed tiles (rc.xml: editor left, browser top right, a navigation
# terminal and a run terminal bottom right), Chromium, xterm, micro (a small terminal editor), xdotool
# for the driver (packages/desktop) and ffmpeg for the live stream and the recording. No secrets: the
# agent's working tree is mounted read only at /work/repo; nothing else of the host is visible.
#
# Debian trixie rather than Ubuntu 24.04: Ubuntu ships Chromium only as a snap, which does not run in
# a container. The same image also runs the outbound allowlist proxy (`desk-proxy`, tinyproxy).
#
# Build:  docker build -t lineage/desktop images/desktop
# Run:    packages/desktop/src/local.ts starts it (non-root, read-only root, no Docker socket, an
#         internal network whose only way out is the allowlist proxy).
FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb openbox xterm micro xdotool x11-utils ffmpeg chromium tinyproxy ripgrep \
      fonts-dejavu-core ca-certificates procps coreutils git bsdextrautils \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home --shell /bin/bash desk
COPY rootfs/ /
RUN chmod 755 /usr/local/bin/desk-* && chmod 644 /etc/lineage-desktop/*
USER 1000:1000
ENV HOME=/tmp/home DISPLAY=:0
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/desk-session"]
