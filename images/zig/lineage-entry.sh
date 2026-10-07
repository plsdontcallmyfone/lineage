#!/bin/sh
# Entry point of lineage/zig. The sandbox root filesystem is read-only and /tmp is a fresh tmpfs
# per container, so every step would rebuild compiler_rt from scratch. This seeds the writable
# Zig global cache from the copy baked into the image at build time (same compiler, same
# content-addressed keys), then runs the command unchanged. Outputs do not depend on the seed:
# a cache hit yields the same bytes a rebuild would (checked when the image was made).
if [ -n "$ZIG_GLOBAL_CACHE_DIR" ] && [ ! -e "$ZIG_GLOBAL_CACHE_DIR" ] && [ -d /opt/zig-cache-seed ]; then
  cp -R /opt/zig-cache-seed "$ZIG_GLOBAL_CACHE_DIR" 2>/dev/null || true
fi
exec "$@"
