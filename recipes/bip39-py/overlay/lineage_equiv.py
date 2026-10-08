"""Lineage equivalence harness for trezor/python-mnemonic (overlay file, protected).

Usage: python lineage_equiv.py <seed>

Prints the observable result (value, or exception type and message) of every public function on
seeded inputs and edge cases: all languages, every entropy length, wrong lengths, list and str
phrases, corrupted and unknown words, wrong word counts, NFKD forms, prefixes, seeds, master keys.
"""
import hashlib
import os
import random
import sys
import unicodedata

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))
from mnemonic import Mnemonic  # noqa: E402
from mnemonic import mnemonic as MOD  # noqa: E402


def show(label, fn, *args):
    try:
        v = fn(*args)
        if isinstance(v, (bytes, bytearray)):
            v = (type(v).__name__, bytes(v).hex())
        print(label, "ok", repr(v))
    except Exception as e:  # noqa: BLE001
        print(label, "err", type(e).__name__, repr(str(e)))


def main() -> None:
    seed = sys.argv[1]
    r = random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))
    langs = sorted(Mnemonic.list_languages())
    print("langs", langs)
    for lang in langs:
        m = Mnemonic(lang)
        print("lang", lang, m.radix, repr(m.delimiter), len(m.wordlist))
        for i in range(25):
            n = r.choice((16, 20, 24, 28, 32))
            data = r.randbytes(n)
            show(f"tm {lang} {i}", m.to_mnemonic, data)
            phrase = m.to_mnemonic(data)
            show(f"ck {lang} {i}", m.check, phrase)
            if lang != "japanese":
                show(f"te {lang} {i}", m.to_entropy, phrase)
                show(f"tl {lang} {i}", m.to_entropy, phrase.split(" "))
            w = phrase.split(m.delimiter)
            w2 = list(w)
            w2[r.randrange(len(w2))] = r.choice(m.wordlist)
            show(f"ckx {lang} {i}", m.check, m.delimiter.join(w2))
            show(f"tex {lang} {i}", m.to_entropy, w2)
            show(f"cks {lang} {i}", m.check, " ".join(w[:-1]))
            show(f"tes {lang} {i}", m.to_entropy, w[:-1])
            w3 = list(w)
            w3[r.randrange(len(w3))] = "zzzq"
            show(f"cku {lang} {i}", m.check, " ".join(w3))
            show(f"teu {lang} {i}", m.to_entropy, w3)
            show(f"ckb {lang} {i}", m.check, phrase.upper())
            nfc = unicodedata.normalize("NFC", phrase)
            show(f"cknfc {lang} {i}", m.check, nfc)
            if lang != "japanese":
                show(f"tenfc {lang} {i}", m.to_entropy, nfc)
                show(f"tlnfc {lang} {i}", m.to_entropy, nfc.split(" "))
            if i < 4:
                show(f"seed {lang} {i}", Mnemonic.to_seed, phrase, r.choice(("", "TREZOR", "páss")))
        for i in range(30):
            word = r.choice(m.wordlist)
            pre = word[: r.randint(0, len(word))]
            show(f"xw {lang} {i}", m.expand_word, pre)
        show(f"xp {lang}", m.expand, " ".join(r.choice(m.wordlist)[:3] for _ in range(12)))
    m = Mnemonic("english")
    for n in (0, 1, 15, 17, 31, 33, 64):
        show(f"badlen {n}", m.to_mnemonic, bytes(n))
    for n in (0, 1, 11, 13, 25, 27):
        show(f"badwc {n}", m.to_entropy, ["abandon"] * n)
        show(f"badck {n}", m.check, " ".join(["abandon"] * n))
    for edge in (b"\x00" * 16, b"\xff" * 16, b"\x00" * 32, b"\xff" * 32, b"\x80" + b"\x00" * 19):
        show(f"edge {edge.hex()}", m.to_mnemonic, edge)
        show(f"edgeback {edge.hex()}", m.to_entropy, m.to_mnemonic(edge))
    show("checkspaces", m.check, "abandon  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")
    show("checktrail", m.check, "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about ")
    show("checknfc", Mnemonic("spanish").check, "ábaco " * 11 + "abdomen")
    show("detect", Mnemonic.detect_language, "jaguar security")
    show("detect2", Mnemonic.detect_language, "fav financer")
    show("detect3", Mnemonic.detect_language, "xxxxzz")
    for i in range(6):
        s = r.randbytes(64)
        show(f"hd {i}", Mnemonic.to_hd_master_key, s, bool(i & 1))
    show("hdbad", Mnemonic.to_hd_master_key, b"\x00" * 63)
    for i in range(40):
        show(f"b58 {i}", MOD.b58encode, r.randbytes(r.randint(0, 82)))
    show("b58z", MOD.b58encode, b"\x00\x00\x01")
    show("norm", Mnemonic.normalize_string, b"caf\xc3\xa9")
    show("normbad", Mnemonic.normalize_string, 5)
    try:
        Mnemonic("english", wordlist=["a"] * 5)
    except Exception as e:  # noqa: BLE001
        print("cfg err", type(e).__name__, repr(str(e)))
    try:
        Mnemonic("klingon")
    except Exception as e:  # noqa: BLE001
        print("cfg2 err", type(e).__name__, repr(str(e)))


if __name__ == "__main__":
    main()
