"""Seeded inputs for the lineage harnesses (overlay, protected).

Text comes from the repository itself (every Markdown file and the langchain-core sources, in
sorted path order), cut into windows chosen by a generator seeded only from $LINEAGE_SEED.
"""

import hashlib
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "libs", "text-splitters"))

ROOT = os.path.dirname(os.path.abspath(__file__))


def rng(seed: str, salt: str) -> random.Random:
    return random.Random(hashlib.sha256(f"{seed}/{salt}".encode()).digest())


def _files(top: str, suffix: str) -> list[str]:
    out = []
    for d, dirs, files in os.walk(os.path.join(ROOT, top)):
        dirs[:] = sorted(x for x in dirs if not x.startswith(".") and x != "node_modules")
        out += [os.path.join(d, f) for f in files if f.endswith(suffix)]
    return sorted(out)


def corpus(kind: str) -> str:
    if kind == "md":
        files = _files("", ".md")
    elif kind == "py":
        files = _files(os.path.join("libs", "core", "langchain_core"), ".py")
    else:
        raise ValueError(kind)
    parts = []
    for f in files:
        with open(f, encoding="utf-8", errors="replace") as fh:
            parts.append(fh.read())
    return "\n\n".join(parts)


def windows(r: random.Random, text: str, n: int, max_len: int) -> list[str]:
    out = []
    for _ in range(n):
        a = r.randrange(0, len(text) - max_len)
        out.append(text[a : a + r.randrange(max_len // 4, max_len)])
    return out
