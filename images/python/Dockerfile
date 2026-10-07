# Lineage sandbox image for Python recipes. Referenced by image id (sha256) in recipes, never by tag alone.
FROM python:3.12-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends valgrind git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -u 10001 -m runner
ENV PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
USER 10001
WORKDIR /work
