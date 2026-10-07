"""Lineage equivalence harness for karpathy/minbpe (overlay file, protected).

Usage: python lineage_equiv.py <seed>

Prints observable behaviour on seeded inputs plus edge cases the upstream tests miss:
- exact merge order from training, including tie-breaking between equally frequent pairs
  (max() keeps the first pair seen, so dict insertion order is part of the contract);
- encodings with the Basic and Regex tokenizers, the GPT-2 and GPT-4 split patterns,
  special tokens in every allowed_special mode, adjacent and repeated specials;
- empty strings, single bytes, long runs of one character, invalid UTF-8 boundaries on decode,
  unknown ids, save/load round trips (files go to /tmp).
A perf patch must leave this output byte-identical.
"""
import hashlib
import os
import random
import sys
import tempfile

from minbpe import BasicTokenizer, RegexTokenizer
from minbpe.base import get_stats, merge, render_token
from minbpe.regex import GPT2_SPLIT_PATTERN, GPT4_SPLIT_PATTERN

HERE = os.path.dirname(os.path.abspath(__file__))


def show(label, fn, *args, **kw):
    try:
        v = fn(*args, **kw)
        print(label, "ok", repr(v))
    except Exception as e:  # noqa: BLE001 - the exception is the observable output
        print(label, "err", type(e).__name__, repr(str(e)))


def rand_text(r: random.Random, n: int) -> str:
    alphabet = "aaabbcdeeefghiiklmnoooprsstuu  \n\t.,!?'0123456789" + "éü你好\U0001F600​"
    return "".join(r.choice(alphabet) for _ in range(n))


def main() -> None:
    seed = sys.argv[1]
    r = random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))
    with open(os.path.join(HERE, "tests", "taylorswift.txt"), encoding="utf-8") as f:
        prose = f.read()

    # helpers directly
    for i in range(30):
        ids = [r.randrange(0, 6) for _ in range(r.randint(0, 40))]
        st = get_stats(ids)
        print("stats", i, list(st.items()))
        if st:
            pair = r.choice(list(st))
            print("merge", i, merge(ids, pair, 99))
    print("merge-edge", merge([], (1, 2), 9), merge([1], (1, 2), 9), merge([1, 1, 1], (1, 1), 9), merge([1, 2, 1, 2, 1], (1, 2), 9))
    print("render", render_token(b"a\nb\x00\xff\xe4\xbd"))

    texts = ["", "a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "ab" * 40, " \n \n\n   ", "\U0001F600" * 7]
    for _ in range(6):
        start = r.randrange(0, len(prose) - 3000)
        texts.append(prose[start:start + r.randint(50, 2500)])
    texts += [rand_text(r, r.randint(1, 600)) for _ in range(8)]

    train_sets = [
        ("tie", "abcabdabeabf" * 3, 260),  # many equal counts: tie-breaking decides
        ("wiki", "aaabdaaabac", 259),
        ("prose", prose[r.randrange(0, 50000):][:4000], 256 + 40),
        ("rand", rand_text(r, 3000), 256 + 30),
    ]
    tokenizers = []
    for name, text, vs in train_sets:
        b = BasicTokenizer()
        b.train(text, vs)
        print("basic-merges", name, list(b.merges.items()))
        tokenizers.append((f"basic-{name}", b))
        for pname, pat in (("gpt2", GPT2_SPLIT_PATTERN), ("gpt4", GPT4_SPLIT_PATTERN)):
            t = RegexTokenizer(pat)
            t.train(text, vs)
            print("regex-merges", name, pname, list(t.merges.items()))
            tokenizers.append((f"regex-{name}-{pname}", t))

    for tname, tok in tokenizers:
        for i, text in enumerate(texts):
            ids = tok.encode(text) if isinstance(tok, BasicTokenizer) and not isinstance(tok, RegexTokenizer) else tok.encode_ordinary(text)
            print("enc", tname, i, ids)
            print("dec", tname, i, repr(tok.decode(ids)))

    specials = {"<|endoftext|>": 100257, "<|fim_prefix|>": 100258, "<|end|>": 100300}
    t = tokenizers[-1][1]
    t.register_special_tokens(specials)
    cases = ["<|endoftext|>", "<|endoftext|><|endoftext|>", "a<|end|>b<|fim_prefix|>", "<|endoftext", "x <|end|> y", texts[7]]
    for i, c in enumerate(cases):
        for mode in ("all", "none", "none_raise", {"<|end|>"}, set(), "bogus"):
            show(f"special {i} {mode!r}", t.encode, c, allowed_special=mode)
    for ids in ([100257], [100300, 97], [0xE4], [0xE4, 0xBD, 0xA0], [10 ** 6], [], [255, 254]):
        show(f"decode {ids}", t.decode, ids)
    b = tokenizers[0][1]
    for ids in ([0xE4], [10 ** 6], []):
        show(f"bdecode {ids}", b.decode, ids)

    with tempfile.TemporaryDirectory() as d:
        for tname, tok in tokenizers[::3]:
            prefix = os.path.join(d, tname)
            tok.save(prefix)
            with open(prefix + ".model", encoding="utf-8") as f:
                print("model", tname, hashlib.sha256(f.read().encode()).hexdigest())
            with open(prefix + ".vocab", encoding="utf-8") as f:
                print("vocab", tname, hashlib.sha256(f.read().encode()).hexdigest())
            t2 = RegexTokenizer()
            t2.load(prefix + ".model")
            print("reload", tname, t2.pattern == tok.pattern, t2.merges == tok.merges, t2.encode_ordinary(texts[8]))


if __name__ == "__main__":
    main()
