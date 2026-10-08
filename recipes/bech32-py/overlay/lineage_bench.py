"""Lineage benchmark harness for sipa/bech32 Python reference (overlay file, protected).

Usage: python lineage_bench.py <encode|decode|bech32> <seed>

Workload: segwit addresses as used in practice (P2WPKH 20-byte v0, P2WSH 32-byte v0, P2TR
32-byte v1, a few other versions/lengths) on mainnet/testnet/regtest HRPs, plus generic
Bech32/Bech32m strings (e.g. lightning-style long HRPs) and corrupted strings that must be
rejected. Inputs depend only on the seed; a crc32 checksum of results is printed.
"""
import gc
import hashlib
import os
import random
import sys
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "ref", "python"))
import segwit_addr  # noqa: E402

gc.disable()

HRPS = ("bc", "tb", "bcrt")


def rng_for(seed: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))


def programs(r, n):
    out = []
    for _ in range(n):
        k = r.random()
        if k < 0.4:
            v, ln = 0, 20
        elif k < 0.6:
            v, ln = 0, 32
        elif k < 0.95:
            v, ln = 1, 32
        else:
            v, ln = r.randint(2, 16), r.randint(2, 40)
        out.append((r.choice(HRPS), v, list(r.randbytes(ln))))
    return out


def main() -> None:
    mode, seed = sys.argv[1], sys.argv[2]
    r = rng_for(seed)
    acc = 0
    if mode == "encode":
        for hrp, v, prog in programs(r, 700):
            a = segwit_addr.encode(hrp, v, prog)
            acc = zlib.crc32(a.encode(), acc)
    elif mode == "decode":
        progs = programs(r, 900)
        addrs = []
        for hrp, v, prog in progs:
            a = segwit_addr.encode(hrp, v, prog)
            if r.random() < 0.3:
                a = a.upper()
            if r.random() < 0.15:
                j = r.randrange(len(hrp) + 1, len(a))
                c = a[j].lower()
                a = a[:j] + segwit_addr.CHARSET[(segwit_addr.CHARSET.index(c) + 1) % 32] + a[j + 1:]
            addrs.append((hrp, a))
        for hrp, a in addrs:
            v, p = segwit_addr.decode(hrp, a)
            acc = zlib.crc32(repr((v, p)).encode(), acc)
    elif mode == "bech32":
        items = []
        for _ in range(500):
            hrp = "".join(r.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(r.randint(1, 12)))
            data = [r.randrange(32) for _ in range(r.randint(0, 80 - len(hrp)))]
            spec = r.choice(list(segwit_addr.Encoding))
            items.append((hrp, data, spec))
        strs = []
        for hrp, data, spec in items:
            s = segwit_addr.bech32_encode(hrp, data, spec)
            acc = zlib.crc32(s.encode(), acc)
            strs.append(s)
        for s in strs:
            h, d, sp = segwit_addr.bech32_decode(s)
            acc = zlib.crc32(repr((h, d, sp)).encode(), acc)
        for s in strs[:200]:
            j = r.randrange(len(s))
            s2 = s[:j] + r.choice("qpzry9x8gf2tvdw0s3jn54khce6mua7l") + s[j + 1:]
            acc = zlib.crc32(repr(segwit_addr.bech32_decode(s2)).encode(), acc)
        for _, data, _ in items[:300]:
            b = segwit_addr.convertbits(data, 5, 8, False)
            acc = zlib.crc32(repr(b).encode(), acc)
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"{mode} {acc:08x}")


if __name__ == "__main__":
    main()
