# Lineage sandbox image for Go recipes (class go, SPEC 6.1). Referenced by image id (sha256) in
# recipes, never by tag alone. Single platform: build it on the arch the recipe requires.
#
# - Go is a pinned release tarball checked against its published sha256 (go.dev/dl).
# - Debian trixie for valgrind 3.24 (arm64 LSE atomics, which Go's runtime uses, decode cleanly).
# - CGO off, so no C toolchain is needed; GOTOOLCHAIN=local so go never tries to download one.
# - -buildvcs=false: the sandbox tree is a throwaway git repo owned by the host user, which git
#   refuses to read as uid 10001, and VCS stamps would differ between base and candidate anyway.
# - Modules live in /deps/gomod (the recipe's prepare fills it with network; read-only after);
#   the build cache is per container under /tmp.
# - Metric commands set GOMAXPROCS=1 GOGC=off themselves; tests run with the defaults.
# - gotap turns `go test -json` into TAP lines "ok N - <package>::<test>" for parser: tap.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
ARG GO_VERSION=1.26.8
ARG GO_SHA256_ARM64=211ffced9dcb9633a55eac6364816ec0ddd951389a740e88fa8b3337971bdda0
# First layer is byte-identical to images/cpp so the two images share it on disk.
RUN apt-get update \
 && apt-get install -y --no-install-recommends valgrind ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq git curl \
 && arch="$(dpkg --print-architecture)" \
 && test "$arch" = arm64 \
 && curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" \
 && echo "${GO_SHA256_ARM64}  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm -rf /tmp/go.tgz /usr/local/go/test /usr/local/go/api /usr/local/go/doc /usr/local/go/misc \
 && ln -s /usr/local/go/bin/go /usr/local/bin/go && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
COPY gotap /usr/local/bin/gotap
RUN useradd -u 10001 -m runner
ENV GOMODCACHE=/deps/gomod GOCACHE=/tmp/gocache GOPATH=/tmp/gopath GOFLAGS="-mod=mod -buildvcs=false" \
    GOTOOLCHAIN=local CGO_ENABLED=0
USER 10001
WORKDIR /work
