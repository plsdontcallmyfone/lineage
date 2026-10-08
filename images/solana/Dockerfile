# Lineage sandbox image for the `solana` target class (SPEC 6.1). linux/arm64 (reference), linux/amd64 (public site).
# Referenced by image id (sha256) in recipes, never by tag alone.
#
# Pinned:
#   base            rust:1.93.1-slim-bookworm (index digest below; host toolchain for tests and harnesses)
#   platform tools  anza-xyz/platform-tools v1.57, platform-tools-linux-aarch64.tar.bz2 (sha256 checked)
#   cargo-build-sbf 4.3.0 from crates.io (`cargo install --locked`), whose built-in default is v1.57
#   protobuf-compiler from Debian bookworm
#
# Agave publishes no linux arm64 CLI binaries, but platform tools ship a linux-aarch64 build and
# cargo-build-sbf is a plain crate, so this image is native arm64 (no emulation).
#
# Layout: platform tools live at /opt/sbf/.cache/solana/v1.57/platform-tools, where
# cargo-build-sbf looks for them under HOME=/opt/sbf. The sandbox sets HOME=/tmp, so
# `cargo build-sbf` resolves to a wrapper that sets HOME=/opt/sbf. The rustup toolchain link is
# made at image build time (the root filesystem is read-only at run time), so cargo-build-sbf
# finds it already linked and never downloads anything.
#
# Pruned from platform tools (1.66 GB extracted; about 0.94 GB removed, summed from the v1.57 tarball listing): clang, lldb, duplicate llc/opt and llvm utilities
# in the host rustlib, rustdoc, rust library sources, and the sbpfv1/v2/v3 target libraries
# (recipes build the default sbpf v0 target). C sources cannot be compiled for SBF in this image.
FROM rust:1.93.1-slim-bookworm@sha256:5b9332190bb3b9ece73b810cd1f1e9f06343b294ce184bcb067f0747d7d333ea

ARG PT_VERSION=v1.57
ARG PT_SHA256=f2f31c9325cb2d00244df23b4a1a0904e51819cec49d39235a3ed3ee2320375d
# amd64 (the public site's server): platform-tools-linux-x86_64.tar.bz2, digest from the v1.57 GitHub release, read 2026-10-08
ARG PT_SHA256_AMD64=b0f7af104adf726fff2a6a09ea2eb2f2d2965c92295f4d7388c08d140e0c2b00
ARG CARGO_BUILD_SBF_VERSION=4.3.0

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl bzip2 git libssl3 libssl-dev pkg-config; \
    PT=/opt/sbf/.cache/solana/${PT_VERSION}/platform-tools; \
    mkdir -p "$PT"; \
    case "$(dpkg --print-architecture)" in arm64) ptarch=aarch64; ptsum="$PT_SHA256" ;; amd64) ptarch=x86_64; ptsum="$PT_SHA256_AMD64" ;; *) exit 1 ;; esac; \
    curl -fsSL "https://github.com/anza-xyz/platform-tools/releases/download/${PT_VERSION}/platform-tools-linux-${ptarch}.tar.bz2" -o /tmp/pt.tar.bz2; \
    echo "${ptsum}  /tmp/pt.tar.bz2" | sha256sum -c -; \
    tar -xjf /tmp/pt.tar.bz2 -C "$PT"; \
    rm /tmp/pt.tar.bz2; \
    cd "$PT"; \
    rm -f llvm/bin/clang* llvm/bin/llc llvm/bin/lldb* llvm/bin/solana-lldb llvm/lib/liblldb*; \
    H=rust/lib/rustlib/${ptarch}-unknown-linux-gnu/bin; \
    rm -f $H/llc $H/opt $H/llvm-* $H/rust-objcopy rust/bin/rustdoc; \
    rm -rf rust/lib/rustlib/src rust/lib/rustlib/sbpfv1-solana-solana rust/lib/rustlib/sbpfv2-solana-solana rust/lib/rustlib/sbpfv3-solana-solana; \
    CARGO_HOME=/tmp/cargo-home cargo install cargo-build-sbf --version "${CARGO_BUILD_SBF_VERSION}" --locked --root /opt/sbf --target-dir /tmp/cbs-target; \
    rm -rf /tmp/cargo-home /tmp/cbs-target /opt/sbf/.crates.toml /opt/sbf/.crates2.json; \
    apt-get purge -y libssl-dev pkg-config; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

COPY cargo-build-sbf /usr/local/bin/cargo-build-sbf

# Link the solana toolchain and prove the pruned tools still build a program (offline, no deps).
RUN set -eux; \
    chmod 755 /usr/local/bin/cargo-build-sbf; \
    mkdir -p /tmp/smoke/src; cd /tmp/smoke; \
    printf '[package]\nname = "smoke"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib"]\n[workspace]\n' > Cargo.toml; \
    printf '#[no_mangle]\npub extern "C" fn entrypoint(_input: *mut u8) -> u64 { 0 }\n' > src/lib.rs; \
    CARGO_HOME=/tmp/smoke-home cargo build-sbf --offline; \
    test -s target/deploy/smoke.so; \
    cd /; rm -rf /tmp/smoke /tmp/smoke-home; \
    chmod -R a+rX /opt/sbf /usr/local/rustup

# protoc: prost-build needs it for mollusk-svm's `fuzz` feature, which Solana program test suites
# commonly enable (solana-program/config does).
RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -m runner
ENV CARGO_HOME=/deps/cargo CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
USER 10001
WORKDIR /work
