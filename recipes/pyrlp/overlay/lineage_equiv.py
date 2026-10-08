"""Lineage equivalence harness for ethereum/pyrlp (overlay file, protected).

Usage: python lineage_equiv.py <seed>

Prints the observable results (value or exception type and message) of encoding and decoding
seeded nested structures of every shape (short, long-form and empty strings and lists, ints of
every width), decoding with strict on and off, recursive_cache, per-item RLP caches of decoded
Serializables, lazy decoding (decode_lazy, peek), sedes round trips (Binary, CountableList, List,
text, boolean, big_endian_int), and malformed inputs (truncated, non-canonical prefixes, trailing
bytes, wrong types), plus the repository's rlptest.json vectors.
"""
import hashlib
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rlp  # noqa: E402
from rlp import codec  # noqa: E402
from rlp.sedes import Binary, CountableList, List, Serializable, big_endian_int, binary, boolean, text  # noqa: E402


def plain(v):
    # LazyList has no value repr (its default repr is an address), so expand it
    if isinstance(v, rlp.LazyList):
        return ("lazy", [plain(v[i]) for i in range(len(v))])
    if isinstance(v, list):
        return [plain(x) for x in v]
    return v


def show(label, fn, *args, **kw):
    try:
        v = plain(fn(*args, **kw))
        print(label, "ok", repr(v))
    except Exception as e:  # noqa: BLE001
        print(label, "err", type(e).__name__, repr(str(e))[:300])


def value(r, depth=0):
    k = r.random()
    if depth > 4 or k < 0.45:
        return r.randbytes(r.choice((0, 1, 1, 2, 55, 56, 57, r.randint(0, 80), r.randint(200, 300))))
    if k < 0.65:
        return r.getrandbits(r.choice((1, 7, 8, 9, 64, 256, 300)))
    return [value(r, depth + 1) for _ in range(r.choice((0, 1, 2, 5, r.randint(0, 20))))]


class Pt(Serializable):
    fields = [("x", big_endian_int), ("y", big_endian_int), ("tag", binary)]


class Shape(Serializable):
    fields = [("name", text), ("ok", boolean), ("pts", CountableList(Pt)), ("raw", List([binary, big_endian_int]))]


def mutate(r, b):
    if not b:
        return b"\x80"
    b = bytearray(b)
    k = r.randrange(5)
    i = r.randrange(len(b))
    if k == 0:
        b[i] ^= 1 << r.randrange(8)
    elif k == 1:
        del b[i:]
    elif k == 2:
        b += r.randbytes(r.randint(1, 3))
    elif k == 3:
        b[0] = r.choice((0x81, 0xb8, 0xb9, 0xc1, 0xf8, 0xf9, 0x00, 0x7f))
    else:
        b.insert(i, r.randrange(256))
    return bytes(b)


def main():
    seed = sys.argv[1]
    r = random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))
    with open(os.path.join(HERE, "tests", "core", "rlptest.json")) as f:
        vectors = json.load(f)
    for name in sorted(vectors):
        v = vectors[name]["in"]
        if isinstance(v, str) and v.startswith("#"):
            v = int(v[1:])
        show(f"vec {name}", lambda x: rlp.encode(x).hex(), v)
    for i in range(400):
        v = value(r)
        e = None
        try:
            e = rlp.encode(v)
            print(f"enc {i} ok {e.hex()}")
        except Exception as ex:  # noqa: BLE001
            print(f"enc {i} err {type(ex).__name__}")
        if e is None:
            continue
        show(f"dec {i}", rlp.decode, e)
        show(f"decc {i}", rlp.decode, e, recursive_cache=True)
        m = mutate(r, e)
        show(f"mut {i} {m.hex()[:80]}", rlp.decode, m)
        show(f"mutns {i}", rlp.decode, m, strict=False)
        show(f"lazy {i}", rlp.decode_lazy, e)
        show(f"item {i}", codec.consume_item, e, 0)
        if isinstance(v, list) and v:
            show(f"peek {i}", rlp.peek, e, [0])
    for i in range(60):
        pts = [Pt(r.getrandbits(r.choice((8, 64, 256))), r.getrandbits(32), r.randbytes(r.randint(0, 70))) for _ in range(r.randint(0, 6))]
        s = Shape("".join(r.choice("abcé中 ") for _ in range(r.randint(0, 20))), r.random() < 0.5, pts, [r.randbytes(r.randint(0, 60)), r.getrandbits(64)])
        e = rlp.encode(s)
        print(f"shape {i} {e.hex()}")
        d = rlp.decode(e, Shape, recursive_cache=bool(i & 1))
        print(f"shaped {i} {d == s} {d._cached_rlp == e} {[p._cached_rlp for p in d.pts]!r}")
        show(f"shapebad {i}", rlp.decode, mutate(r, e), Shape)
        show(f"shapelazy {i}", lambda b: rlp.decode_lazy(b, Shape).name, e)
    for v in (-1, 1.5, "str", None, True, object(), [b"a", 2**2048], b"x" * (2**16)):
        show(f"badenc {type(v).__name__}", lambda x: rlp.encode(x)[:40].hex(), v)
    for b in (b"", b"\x80", b"\x81\x00", b"\x81\x80", b"\xb8\x00", b"\xb8\x37" + b"a" * 55, b"\xc0", b"\xc1",
              b"\xf8\x00", b"\xf8\x37" + b"\x80" * 55, b"\xc2\x80", b"\xc2\x80\x80\x80", 5, "c0", bytearray(b"\xc0")):
        show(f"edge {b!r}"[:60], rlp.decode, b)
        show(f"edgens {b!r}"[:60], rlp.decode, b, strict=False)


if __name__ == "__main__":
    main()
