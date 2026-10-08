"""Lineage benchmark harness for ethereum/pyrlp (overlay file, protected).

Usage: python lineage_bench.py <encode|decode|sedes> <seed>

  encode: rlp.encode (three rounds) of seeded transaction- and block-shaped nested structures (ints of every
          width, 0 to 600-byte strings, nested lists including long-form lengths)
  decode: rlp.decode of the same structures' encodings (strict, then with recursive_cache)
  sedes:  a Serializable transaction and header class: encode, then decode with sedes, so
          serialization, deserialization and the per-item RLP cache all run
Inputs depend only on the seed; a crc32 of the results is printed.
"""
import gc
import hashlib
import os
import random
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rlp  # noqa: E402
from rlp.sedes import Binary, CountableList, List, Serializable, big_endian_int, binary  # noqa: E402

gc.disable()


def rng_for(seed):
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))


def value(r, depth=0):
    k = r.random()
    if depth > 3 or k < 0.45:
        return r.randbytes(r.choice((0, 1, 1, 20, 32, 32, 65, r.randint(0, 120), r.randint(56, 600))))
    if k < 0.7:
        return r.getrandbits(r.choice((8, 64, 256)))
    return [value(r, depth + 1) for _ in range(r.randint(0, 12))]


def tx(r):
    return [r.getrandbits(64), r.getrandbits(64), r.getrandbits(32), r.randbytes(20), r.getrandbits(80),
            r.randbytes(r.randint(0, 400)), r.randint(27, 28), r.getrandbits(256), r.getrandbits(256)]


class Tx(Serializable):
    fields = [("nonce", big_endian_int), ("gas_price", big_endian_int), ("gas", big_endian_int),
              ("to", Binary.fixed_length(20, allow_empty=True)), ("value", big_endian_int), ("data", binary),
              ("v", big_endian_int), ("r", big_endian_int), ("s", big_endian_int)]


class Block(Serializable):
    fields = [("parent", Binary.fixed_length(32)), ("number", big_endian_int), ("extra", binary),
              ("txs", CountableList(Tx)), ("uncles", CountableList(List([binary, big_endian_int])))]


def main():
    mode, seed = sys.argv[1], sys.argv[2]
    r = rng_for(seed)
    acc = 0
    if mode in ("encode", "decode"):
        items = [[tx(r) for _ in range(r.randint(1, 30))] if r.random() < 0.5 else value(r) for _ in range(200)]
        if mode == "encode":
            for _ in range(3):
                for it in items:
                    acc = zlib.crc32(rlp.encode(it), acc)
        else:
            encs = [rlp.encode(it) for it in items]
            for e in encs:
                acc = zlib.crc32(repr(rlp.decode(e)).encode(), acc)
            for e in encs[:100]:
                acc = zlib.crc32(repr(rlp.decode(e, recursive_cache=True)).encode(), acc)
    elif mode == "sedes":
        blocks = []
        for _ in range(60):
            txs = [Tx(*tx(r)) for _ in range(r.randint(0, 25))]
            blocks.append(Block(r.randbytes(32), r.getrandbits(40), r.randbytes(r.randint(0, 32)), txs,
                                [[r.randbytes(32), r.getrandbits(16)] for _ in range(r.randint(0, 2))]))
        for b in blocks:
            e = rlp.encode(b)
            d = rlp.decode(e, Block)
            acc = zlib.crc32(e, acc)
            acc = zlib.crc32(rlp.encode(d.txs[0]) if d.txs else b"", acc)
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"{mode} {acc:08x}")


if __name__ == "__main__":
    main()
