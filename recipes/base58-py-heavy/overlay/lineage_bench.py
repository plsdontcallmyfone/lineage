"""Units benchmark harness for keis/base58, heavy workload (overlay file, protected).

Usage: python lineage_bench.py <encode|decode|encode_long|decode_long|check|int> <seed> [--inputs-only]

Second recipe for the repository (recipes/base58-py is the first and is frozen). At the first
unit's tip, starting the interpreter and the imports were 35 to 51% of each of its three metrics,
so the 1% minimum effect had become up to 2% of what a change to the library can touch. This
harness runs batches large enough that the library is nearly all of the count, and it has six
targets, one per code path people use:

  encode       b58encode of address-sized payloads in batches: Solana keys (32 bytes) and
               signatures (64), Bitcoin hashes (20, 21), leading zero bytes, bytes and str
               input, the Bitcoin and the Ripple alphabets
  decode       b58decode of the same shapes: bytes and str input, both alphabets, trailing
               whitespace, autofix on a part
  encode_long  b58encode of blobs of 256 bytes to 4 KiB (transactions, serialized accounts)
  decode_long  b58decode of the same blobs
  check        b58encode_check and b58decode_check (version byte, payload, 4 byte checksum),
               both alphabets, bytes and str, autofix on a part
  int          b58encode_int and b58decode_int on integers of 64 to 2,048 bits, both alphabets,
               default_one in both settings

`--inputs-only` runs the same imports and builds the same inputs, then stops before the first
library call that the mode measures (the decode modes need encoded inputs: those are drawn
directly as seeded strings over the alphabet, not produced by an encoder, so a decode metric
holds no encode work).
scripts/efficiency/fixed-share.ts reports that count's share of each metric.

Determinism: inputs depend only on the seed, PYTHONHASHSEED=0 is set by the sandbox and the
cyclic GC is off so collection points cannot move with a patch's allocation pattern.
"""
import gc
import hashlib
import random
import sys
import zlib

import base58

gc.disable()

BTC = base58.BITCOIN_ALPHABET
XRP = base58.RIPPLE_ALPHABET


def rng_for(seed: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))


_TABLES = {}


def encoded(r: random.Random, n_bytes: int, alphabet: bytes, zeros: int = 0) -> bytes:
    """A Base58 string as long as the encoding of an n_bytes payload, with `zeros` leading zero digits.

    Drawn directly (seeded random bytes mapped onto the alphabet in C), not by encoding a payload:
    every string over the alphabet is a valid encoding, and no encoder runs in a decode metric.
    """
    n = (n_bytes * 138) // 100 + 1
    table = _TABLES.get(alphabet)
    if table is None:
        table = _TABLES[alphabet] = bytes(alphabet[i % 58] for i in range(256))
    body = r.randbytes(n).translate(table)
    return alphabet[0:1] * zeros + body.lstrip(alphabet[0:1])


def short_encoded(r: random.Random, n: int, alphabet: bytes):
    out = []
    for _ in range(n):
        x = r.random()
        if x < 0.45:
            out.append(encoded(r, 32, alphabet))
        elif x < 0.65:
            out.append(encoded(r, 64, alphabet))
        elif x < 0.85:
            out.append(encoded(r, r.choice((20, 21, 25, 33, 34)), alphabet))
        else:
            out.append(encoded(r, r.choice((20, 31, 32)), alphabet, r.randint(1, 4)))
    return out


def short_payloads(r: random.Random, n: int):
    out = []
    for _ in range(n):
        x = r.random()
        if x < 0.45:
            out.append(r.randbytes(32))
        elif x < 0.65:
            out.append(r.randbytes(64))
        elif x < 0.85:
            out.append(r.randbytes(r.choice((20, 21, 25, 33, 34))))
        else:
            out.append(b"\0" * r.randint(1, 4) + r.randbytes(r.choice((20, 31, 32))))
    return out


def long_payloads(r: random.Random, n: int):
    return [r.randbytes(r.choice((256, 512, 1024, 1232, 2048, 4096))) for _ in range(n)]


def check_payloads(r: random.Random, n: int):
    out = []
    for _ in range(n):
        version = r.choice((b"\x00", b"\x05", b"\x80", b"\x6f"))
        body = version + r.randbytes(32 if version == b"\x80" else 20)
        if version == b"\x80" and r.random() < 0.5:
            body += b"\x01"
        out.append(body)
    return out


def main() -> None:
    mode, seed = sys.argv[1], sys.argv[2]
    inputs_only = "--inputs-only" in sys.argv[3:]
    r = rng_for(seed)
    crc = zlib.crc32
    acc = 0
    if mode == "encode":
        data = short_payloads(r, 3000)
        strs = [p.hex() for p in data[:600]]
        if inputs_only:
            return print(mode, "inputs", len(data))
        for _ in range(7):
            for p in data:
                acc = crc(base58.b58encode(p), acc)
            for p in data[:1000]:
                acc = crc(base58.b58encode(p, alphabet=XRP), acc)
            for s in strs:
                acc = crc(base58.b58encode(s), acc)
    elif mode == "decode":
        enc = short_encoded(r, 3000, BTC)
        renc = short_encoded(r, 1000, XRP)
        strs = [e.decode("ascii") for e in enc[:1000]]
        padded = [e + b" \n" for e in enc[1000:1300]]
        fix = [e.replace(b"1", b"l").replace(b"o", b"0") for e in enc[1300:1700]]
        if inputs_only:
            return print(mode, "inputs", len(enc))
        for _ in range(8):
            for e in enc:
                acc = crc(base58.b58decode(e), acc)
            for e in renc:
                acc = crc(base58.b58decode(e, alphabet=XRP), acc)
            for s in strs:
                acc = crc(base58.b58decode(s), acc)
            for e in padded:
                acc = crc(base58.b58decode(e), acc)
            for e in fix:
                acc = crc(base58.b58decode(e, autofix=True), acc)
    elif mode == "encode_long":
        data = long_payloads(r, 180)
        if inputs_only:
            return print(mode, "inputs", len(data))
        for p in data:
            acc = crc(base58.b58encode(p), acc)
        for p in data[:45]:
            acc = crc(base58.b58encode(p, alphabet=XRP), acc)
    elif mode == "decode_long":
        sizes = (256, 512, 1024, 1232, 2048, 4096)
        enc = [encoded(r, r.choice(sizes), BTC) for _ in range(60)]
        renc = [encoded(r, r.choice(sizes), XRP) for _ in range(15)]
        if inputs_only:
            return print(mode, "inputs", len(enc))
        for _ in range(3):
            for e in enc:
                acc = crc(base58.b58decode(e), acc)
            for e in renc:
                acc = crc(base58.b58decode(e, alphabet=XRP), acc)
            for e in enc[:20]:
                acc = crc(base58.b58decode(e.decode("ascii")), acc)
    elif mode == "check":
        data = check_payloads(r, 2500)
        if inputs_only:
            return print(mode, "inputs", len(data))
        for k in range(7):
            for i, p in enumerate(data):
                alpha = XRP if i % 5 == 0 else BTC
                e = base58.b58encode_check(p, alphabet=alpha)
                if i % 3 == 0:
                    e = e.decode("ascii")
                acc = crc(base58.b58decode_check(e, alphabet=alpha, autofix=(i % 7 == k)), acc)
    elif mode == "int":
        nums = [r.getrandbits(r.choice((64, 128, 256, 256, 512, 1024, 2048))) for _ in range(1500)]
        if inputs_only:
            return print(mode, "inputs", len(nums))
        for k in range(5):
            for i, n in enumerate(nums):
                alpha = XRP if (i + k) % 4 == 0 else BTC
                e = base58.b58encode_int(n, default_one=bool(i % 2), alphabet=alpha)
                acc = crc(e, acc)
                acc = crc(str(base58.b58decode_int(e, alphabet=alpha)).encode(), acc)
                if i % 10 == 0:
                    acc = crc(str(base58.b58decode_int(e.decode("ascii"), alphabet=alpha, autofix=True)).encode(), acc)
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"{mode} {acc:08x}")


if __name__ == "__main__":
    main()
