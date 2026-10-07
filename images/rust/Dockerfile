# Lineage sandbox image for Rust recipes. Referenced by image id (sha256) in recipes, never by tag alone.
FROM rust:1.89-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends valgrind git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -u 10001 -m runner
ENV CARGO_HOME=/deps/cargo CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
USER 10001
WORKDIR /work
