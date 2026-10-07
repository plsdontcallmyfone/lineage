# Lineage sandbox image for C++ recipes (class cpp, SPEC 6.1). Referenced by image id (sha256) in
# recipes, never by tag alone. Single platform: build it on the arch the recipe requires.
#
# - Debian trixie: GCC 14 (C++20), GNU make, valgrind 3.24. No CMake: recipes that need one build
#   description bring it in their overlay (a Makefile), so the image stays small.
# - Compiler version is fixed by the pinned base digest plus the trixie package set at build time;
#   the recipe pins the resulting image id, so every replay uses the same g++ binary.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
# First layer is byte-identical to images/go so the two images share it on disk.
RUN apt-get update \
 && apt-get install -y --no-install-recommends valgrind ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
RUN useradd -u 10001 -m runner
USER 10001
WORKDIR /work
