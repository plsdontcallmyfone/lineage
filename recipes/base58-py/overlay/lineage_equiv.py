"""Lineage equivalence harness for keis/base58 (overlay file, protected).

Usage: python lineage_equiv.py <seed>

Prints the observable behaviour of every public function on seeded random inputs plus edge
cases the upstream tests do not cover: leading zero runs of every length, all-zero inputs,
str and bytes inputs, alphabets containing a space, trailing whitespace, autofix groups,
error types and messages. A perf patch must leave this output byte-identical.
"""
import hashlib
import random
import sys

import base58
from base58 import (
    BITCOIN_ALPHABET,
    RIPPLE_ALPHABET,
    b58decode,
    b58decode_check,
    b58decode_int,
    b58encode,
    b58encode_check,
    b58encode_int,
)

BASE45 = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
SHORT = b"0123456789"
ALPHABETS = [("btc", BITCOIN_ALPHABET), ("xrp", RIPPLE_ALPHABET), ("b45", BASE45), ("b10", SHORT)]


def show(label, fn, *args, **kw):
    try:
        v = fn(*args, **kw)
        print(label, "ok", type(v).__name__, repr(v))
    except Exception as e:  # noqa: BLE001 - the exception itself is the observable output
        print(label, "err", type(e).__name__, repr(str(e)))


def main() -> None:
    seed = sys.argv[1]
    r = random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))

    fixed = [b"", b"\0", b"\0" * 7, b"\0\0\x01", b"\x01", b"\xff", b"\xff" * 33, b"hello world"]
    for z in range(0, 10):
        fixed.append(b"\0" * z + b"\x01\x00")
    rand = [r.randbytes(r.choice((1, 2, 3, 5, 8, 20, 25, 32, 33, 64, 100, 300))) for _ in range(250)]
    rand += [b"\0" * r.randint(1, 6) + r.randbytes(r.randint(0, 40)) for _ in range(60)]

    for name, alpha in ALPHABETS:
        for i, p in enumerate(fixed + rand):
            show(f"enc {name} {i}", b58encode, p, alphabet=alpha)
            e = b58encode(p, alphabet=alpha)
            show(f"dec {name} {i}", b58decode, e, alphabet=alpha)
            show(f"decs {name} {i}", b58decode, e.decode("ascii"), alphabet=alpha)
            show(f"chk {name} {i}", b58encode_check, p, alphabet=alpha)
        for i in range(60):
            n = r.getrandbits(r.choice((1, 8, 64, 256, 600)))
            show(f"eint {name} {i}", b58encode_int, n, alphabet=alpha)
            show(f"eint0 {name} {i}", b58encode_int, n, default_one=False, alphabet=alpha)
            show(f"dint {name} {i}", b58decode_int, b58encode_int(n, alphabet=alpha), alphabet=alpha)

    for z in (0, 1, 5):
        show(f"eint-zero {z}", b58encode_int, 0, default_one=bool(z))
    show("str-enc", b58encode, "hello world")
    show("str-enc-nonascii", b58encode, "héllo")
    show("int-in", b58encode, 5)
    show("ws-trail", b58decode, "StV1DL6CwTryKyV \n\t")
    show("ws-lead", b58decode, " StV1DL6CwTryKyV")
    show("ws-mid", b58decode, "StV1D L6CwTryKyV")
    show("b45-space", b58decode, b"A B ", alphabet=BASE45)
    show("dint-ws", b58decode_int, b"2g \n")
    show("dint-empty", b58decode_int, b"")
    show("dec-empty", b58decode, b"")
    show("dec-ones", b58decode, b"1111")
    for bad in ("0", "O", "I", "l", "\x00", "\xff", "+", "abc0def", "é"):
        show(f"bad {bad!r}", b58decode, bad)
        show(f"bad-fix {bad!r}", b58decode, bad, autofix=True)
        show(f"bad-int {bad!r}", b58decode_int, bad)
    for i in range(80):
        p = r.randbytes(r.randint(0, 40))
        e = b58encode_check(p)
        show(f"dchk {i}", b58decode_check, e)
        mutated = bytearray(e)
        if mutated:
            j = r.randrange(len(mutated))
            mutated[j] = BITCOIN_ALPHABET[(BITCOIN_ALPHABET.index(mutated[j]) + 1) % 58]
        show(f"dchk-bad {i}", b58decode_check, bytes(mutated))
        fixed_e = e.replace(b"1", b"l").replace(b"o", b"0")
        show(f"dchk-fix {i}", b58decode_check, fixed_e, autofix=True)
    show("dchk-short", b58decode_check, b"1")
    show("dchk-empty", b58decode_check, b"")
    charset = BITCOIN_ALPHABET.replace(b"x", b"l")
    show("fix-na", b58decode_check, b58encode_check(b"hello world").replace(b"x", b"l").replace(b"o", b"0"), alphabet=charset, autofix=True)
    print("aliases", base58.XRP_ALPHABET == RIPPLE_ALPHABET, base58.alphabet == BITCOIN_ALPHABET)


if __name__ == "__main__":
    main()
