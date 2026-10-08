"""Lineage equivalence harness for sipa/bech32 Python reference (overlay file, protected).

Usage: python lineage_equiv.py <seed>

Prints observable results of every public function on seeded random inputs and edge cases:
valid/invalid segwit addresses, mixed case, bad chars, length limits, wrong checksum variant,
padding errors, out-of-range values for convertbits, exceptions (type and message).
"""
import hashlib
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "ref", "python"))
import segwit_addr as S  # noqa: E402

CS = S.CHARSET


def show(label, fn, *args):
    try:
        v = fn(*args)
        print(label, "ok", repr(v))
    except Exception as e:  # noqa: BLE001
        print(label, "err", type(e).__name__, repr(str(e)))


def mutate(r, s):
    k = r.randrange(6)
    if not s:
        return s + r.choice(CS)
    j = r.randrange(len(s))
    if k == 0:
        return s[:j] + r.choice(CS) + s[j + 1:]
    if k == 1:
        return s[:j] + s[j + 1:]
    if k == 2:
        return s[:j] + r.choice(CS + "1bioBIO !~\x7f\x80\xff") + s[j:]
    if k == 3:
        return s[:j] + s[j].swapcase() + s[j + 1:]
    if k == 4 and len(s) > 1:
        i = r.randrange(len(s) - 1)
        return s[:i] + s[i + 1] + s[i] + s[i + 2:]
    return s.upper()


def main() -> None:
    seed = sys.argv[1]
    r = random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))

    print("const", CS, S.BECH32M_CONST, [e.name for e in S.Encoding])
    # polymod / hrp_expand / checksum primitives
    for i in range(80):
        vals = [r.randrange(32) for _ in range(r.randint(0, 100))]
        show(f"poly {i}", S.bech32_polymod, vals)
        hrp = "".join(chr(r.randint(33, 126)) for _ in range(r.randint(0, 10)))
        show(f"hexp {i}", S.bech32_hrp_expand, hrp)
        for spec in S.Encoding:
            show(f"cchk {i} {spec.name}", S.bech32_create_checksum, hrp, vals, spec)
            show(f"vchk {i} {spec.name}", S.bech32_verify_checksum, hrp, vals)
    # convertbits
    for i in range(150):
        fb, tb = r.choice(((8, 5), (5, 8), (8, 1), (1, 8), (3, 7), (16, 5), (5, 16), (8, 8)))
        n = r.randint(0, 40)
        data = [r.randrange(1 << fb) for _ in range(n)]
        if r.random() < 0.1 and data:
            data[r.randrange(n)] = r.choice((-1, 1 << fb, (1 << fb) + 3))
        show(f"cb {i} {fb} {tb} T", S.convertbits, data, fb, tb, True)
        show(f"cb {i} {fb} {tb} F", S.convertbits, data, fb, tb, False)
    # generic bech32 strings
    strs = []
    for i in range(250):
        hrp = "".join(chr(r.randint(33, 126)) for _ in range(r.randint(1, 20))).lower()
        data = [r.randrange(32) for _ in range(r.randint(0, 90))]
        spec = r.choice(list(S.Encoding))
        show(f"benc {i}", S.bech32_encode, hrp, data, spec)
        s = S.bech32_encode(hrp, data, spec)
        strs.append(s)
        show(f"bdec {i}", S.bech32_decode, s)
        show(f"bdecU {i}", S.bech32_decode, s.upper())
        for k in range(3):
            show(f"bdecM {i} {k}", S.bech32_decode, mutate(r, s))
    # segwit addresses
    for i in range(300):
        hrp = r.choice(("bc", "tb", "bcrt", "BC", "x", "ltc"))
        v = r.choice((0, 0, 1, 1, 2, 16, 17, 31))
        ln = r.choice((0, 1, 2, 19, 20, 21, 31, 32, 33, 40, 41, r.randint(0, 45)))
        prog = list(r.randbytes(ln))
        if r.random() < 0.03 and prog:
            prog[0] = 256
        show(f"enc {i}", S.encode, hrp, v, prog)
        # force encoding regardless of validity, then decode under several hrps/specs
        try:
            raw = S.bech32_encode(hrp.lower(), [v] + S.convertbits(prog, 8, 5), r.choice(list(S.Encoding)))
        except Exception as e:  # noqa: BLE001
            print(f"raw {i} err", type(e).__name__)
            continue
        for h in ("bc", "tb", hrp):
            show(f"dec {i} {h}", S.decode, h, raw)
            show(f"decU {i} {h}", S.decode, h, raw.upper())
            show(f"decM {i} {h}", S.decode, h, mutate(r, raw))
    fixed = ["", "1", "a1", "a12uel5l", "A12UEL5L", "A12uel5l", "bc1", "bc1qqqqqq", "1qqqqqq",
             "a" * 83 + "1" + "q" * 6, "a" * 84 + "1" + "q" * 6, "bc1gmk9yu", " 1nwldj5", "x1b4n0q5v"]
    for s in fixed:
        show(f"fx-bdec {s!r}", S.bech32_decode, s)
        show(f"fx-dec {s!r}", S.decode, "bc", s)
        show(f"fx-decA {s!r}", S.decode, "a", s)
    show("dec-nonehrp", S.decode, None, "zz")


if __name__ == "__main__":
    main()
