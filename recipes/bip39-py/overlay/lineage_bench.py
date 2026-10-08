"""Lineage benchmark harness for trezor/python-mnemonic (overlay file, protected).

Usage: python lineage_bench.py <entropy|check|mnemonic|expand> <seed>

Workload: BIP39 phrases of every allowed length (12 to 24 words) in the English wordlist and a
few others, built from seeded entropy; checks include corrupted phrases that must fail; expand
takes seeded unique and ambiguous prefixes. Inputs depend only on the seed; a crc32 of the
results is printed.
"""
import gc
import hashlib
import os
import random
import sys
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))
from mnemonic import Mnemonic  # noqa: E402

gc.disable()

LENGTHS = (16, 20, 24, 28, 32)


def rng_for(seed: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))


def main() -> None:
    mode, seed = sys.argv[1], sys.argv[2]
    r = rng_for(seed)
    m = Mnemonic("english")
    acc = 0
    if mode == "mnemonic":
        for _ in range(1500):
            phrase = m.to_mnemonic(r.randbytes(r.choice(LENGTHS)))
            acc = zlib.crc32(phrase.encode(), acc)
    elif mode == "entropy":
        phrases = [m.to_mnemonic(r.randbytes(r.choice(LENGTHS))) for _ in range(250)]
        for p in phrases:
            words = p.split(" ") if r.random() < 0.5 else p
            acc = zlib.crc32(bytes(m.to_entropy(words)), acc)
    elif mode == "check":
        phrases = [m.to_mnemonic(r.randbytes(r.choice(LENGTHS))) for _ in range(250)]
        for p in phrases:
            if r.random() < 0.3:
                w = p.split(" ")
                w[r.randrange(len(w))] = r.choice(m.wordlist)
                p = " ".join(w)
            acc = zlib.crc32(b"1" if m.check(p) else b"0", acc)
    elif mode == "expand":
        items = []
        for _ in range(120):
            w = r.choice(m.wordlist)
            items.append(w[: r.randint(1, len(w))])
        for p in items:
            acc = zlib.crc32(m.expand_word(p).encode(), acc)
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"{mode} {acc:08x}")


if __name__ == "__main__":
    main()
