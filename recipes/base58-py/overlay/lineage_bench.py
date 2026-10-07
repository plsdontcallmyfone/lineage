"""Lineage benchmark harness for keis/base58 (overlay file, protected).

Usage: python lineage_bench.py <encode|decode|check> <seed>

Runs a representative workload on inputs generated from the seed and prints a checksum, so the
work cannot be optimised away. Measured with cachegrind instruction counts (deterministic):
the inputs depend only on the seed, PYTHONHASHSEED=0 is set by the sandbox and the cyclic GC is
disabled so collection points cannot shift with allocation patterns of the harness itself.

Workload shape: what base58 is used for in practice. Solana public keys (32 bytes) and
signatures (64 bytes), Bitcoin payloads with Base58Check (21 bytes + checksum), WIF private keys
(33/34 bytes), inputs with leading zero bytes, and a few long blobs (256 to 1024 bytes).
"""
import gc
import hashlib
import random
import sys
import zlib

import base58

gc.disable()


def rng_for(seed: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))


def payloads(r: random.Random):
    out = []
    for _ in range(600):
        out.append(r.randbytes(32))
    for _ in range(250):
        out.append(r.randbytes(64))
    for _ in range(150):
        z = r.randint(1, 4)
        out.append(b"\0" * z + r.randbytes(r.choice((20, 31, 32))))
    for _ in range(12):
        out.append(r.randbytes(r.choice((256, 512, 1024))))
    r.shuffle(out)
    return out


def check_payloads(r: random.Random):
    out = []
    for _ in range(500):
        version = r.choice((b"\x00", b"\x05", b"\x80", b"\x6f"))
        n = 32 if version == b"\x80" else 20
        body = version + r.randbytes(n)
        if version == b"\x80" and r.random() < 0.5:
            body += b"\x01"
        out.append(body)
    return out


def main() -> None:
    mode, seed = sys.argv[1], sys.argv[2]
    r = rng_for(seed)
    acc = 0
    if mode == "encode":
        data = payloads(r)
        for _ in range(2):
            for p in data:
                acc = zlib.crc32(base58.b58encode(p), acc)
            for p in data[:200]:
                acc = zlib.crc32(base58.b58encode(p, alphabet=base58.RIPPLE_ALPHABET), acc)
    elif mode == "decode":
        data = payloads(r)
        enc = [base58.b58encode(p) for p in data]
        renc = [base58.b58encode(p, alphabet=base58.RIPPLE_ALPHABET) for p in data[:200]]
        strs = [e.decode("ascii") for e in enc[:300]]
        for _ in range(2):
            for e in enc:
                acc = zlib.crc32(base58.b58decode(e), acc)
            for e in renc:
                acc = zlib.crc32(base58.b58decode(e, alphabet=base58.RIPPLE_ALPHABET), acc)
            for s in strs:
                acc = zlib.crc32(base58.b58decode(s), acc)
    elif mode == "check":
        data = check_payloads(r)
        for _ in range(2):
            for p in data:
                e = base58.b58encode_check(p)
                acc = zlib.crc32(base58.b58decode_check(e), acc)
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"{mode} {acc:08x}")


if __name__ == "__main__":
    main()
