# Lineage sandbox image for Zig recipes (SPEC 6.1, class zig). Referenced by image id (sha256) in
# recipes, never by tag alone. Single platform: linux/arm64 on the M1 reference runner; an amd64
# build of this file is a different image and a different lineage (sizes differ per arch).
#
# Zig is the official release tarball, verified against the sha256 published in
# https://ziglang.org/download/index.json before it is unpacked. To keep the image small the libc
# headers and sources for Windows, macOS, FreeBSD and NetBSD are removed (about 120 MB): recipes
# of this class build and run for Linux on the image arch only, so nothing here can use them.
FROM debian:trixie-slim

ARG ZIG_VERSION=0.15.2
ARG ZIG_SHA256_ARM64=958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f
ARG ZIG_SHA256_AMD64=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239

RUN apt-get update \
 && apt-get install -y --no-install-recommends valgrind ca-certificates curl xz-utils \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      arm64) zarch=aarch64; sum="$ZIG_SHA256_ARM64" ;; \
      amd64) zarch=x86_64; sum="$ZIG_SHA256_AMD64" ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac \
 && name="zig-${zarch}-linux-${ZIG_VERSION}" \
 && curl -fsSL -o /tmp/zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/${name}.tar.xz" \
 && echo "${sum}  /tmp/zig.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/zig \
 && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 \
 && rm -rf /tmp/zig.tar.xz /opt/zig/doc \
 && cd /opt/zig/lib/libc \
 && rm -rf mingw darwin freebsd netbsd include/any-windows-any include/any-macos-any \
           include/*-freebsd-* include/generic-freebsd include/*-netbsd-* include/generic-netbsd \
 && cd / \
 && ln -s /opt/zig/zig /usr/local/bin/zig \
 && apt-get purge -y curl xz-utils \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man \
 && zig version

RUN useradd -u 10001 -m runner
# Seed cache: compiler_rt (and ubsan_rt) for the pinned recipe target (<arch>-linux-musl,
# cpu baseline) in every optimize mode,
# plus the native target the build runner uses. Copied into /tmp by the entry point.
COPY warm.zig /opt/zig-warm/warm.zig
COPY lineage-entry.sh /usr/local/bin/lineage-entry
RUN chmod 0755 /usr/local/bin/lineage-entry \
 && cd /opt/zig-warm \
 && export ZIG_GLOBAL_CACHE_DIR=/opt/zig-cache-seed ZIG_LOCAL_CACHE_DIR=/tmp/zig-warm-local \
 && t="$(uname -m)-linux-musl" \
 && for mode in Debug ReleaseSafe ReleaseFast ReleaseSmall; do \
      zig build-exe -O$mode -target $t -mcpu=baseline warm.zig -femit-bin=/tmp/warm-$mode || exit 1; \
      zig test -O$mode -target $t -mcpu=baseline warm.zig || exit 1; \
    done \
 && zig build-exe -ODebug warm.zig -femit-bin=/tmp/warm-native \
 && rm -rf /tmp/zig-warm-local /tmp/warm-* /opt/zig-cache-seed/tmp \
 && chmod -R a+rX /opt/zig-cache-seed \
 && du -sh /opt/zig-cache-seed
# The sandbox root filesystem is read-only and only /work (the tree) and /tmp (tmpfs) are
# writable. Both Zig caches go to /tmp so builds never write cache files into the tree (which
# keeps artifact digests and `git status` clean) and never need a writable $HOME.
ENV ZIG_GLOBAL_CACHE_DIR=/tmp/zig-global-cache \
    ZIG_LOCAL_CACHE_DIR=/tmp/zig-local-cache
USER 10001
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/lineage-entry"]
