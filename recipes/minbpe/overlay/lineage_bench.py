"""Lineage benchmark harness for karpathy/minbpe (overlay file, protected).

Usage: python lineage_bench.py <train|encode> <seed>

Runs a representative workload on seeded inputs and prints a checksum. Measured with cachegrind
instruction counts (deterministic): inputs depend only on the seed, PYTHONHASHSEED=0 is set by
the sandbox, and the cyclic GC is disabled so collection points cannot move when a patch
changes allocation patterns (refcounting still frees everything this workload creates).

Corpus: seeded windows of tests/taylorswift.txt (English prose with punctuation and digits)
mixed with seeded synthetic text (words from a seeded vocabulary, numbers, unicode, emoji,
whitespace runs), so BPE merges and the GPT-4 split pattern both see realistic input.
No GPT4Tokenizer here: it needs tiktoken's downloaded vocabulary and is covered by the tests.
"""
import gc
import hashlib
import os
import random
import sys
import zlib

from minbpe import BasicTokenizer, RegexTokenizer

gc.disable()

HERE = os.path.dirname(os.path.abspath(__file__))
SPECIALS = {"<|endoftext|>": 100257, "<|fim_prefix|>": 100258, "<|fim_middle|>": 100259, "<|fim_suffix|>": 100260}


def rng_for(seed: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))


def corpus(r: random.Random, n_chars: int) -> str:
    with open(os.path.join(HERE, "tests", "taylorswift.txt"), encoding="utf-8") as f:
        prose = f.read()
    syll = ["ka", "lo", "mi", "ne", "tor", "ex", "an", "ing", "th", "qu", "z", "re", "st", "o", "ul"]
    vocab = ["".join(r.choice(syll) for _ in range(r.randint(1, 4))) for _ in range(400)]
    extra = ["été", "naïve", "你好", "привет", "\U0001F600", "\U0001F680", "مرحبا"]
    parts = []
    size = 0
    while size < n_chars:
        if r.random() < 0.5:
            start = r.randrange(0, len(prose) - 2000)
            s = prose[start:start + r.randint(200, 1500)]
        else:
            words = []
            for _ in range(r.randint(20, 120)):
                x = r.random()
                if x < 0.80:
                    w = r.choice(vocab)
                    words.append(w.capitalize() if r.random() < 0.1 else w)
                elif x < 0.88:
                    words.append(str(r.randint(0, 10 ** r.randint(1, 7))))
                elif x < 0.95:
                    words.append(r.choice(extra))
                else:
                    words.append(r.choice([",", ".", "!!", "?", "'s", "'ll", ":", "--", "(", ")"]))
            s = " ".join(words) + r.choice(["\n", "\n\n", "  \n", ". "])
        parts.append(s)
        size += len(s)
    return "".join(parts)


def digest_ids(ids, acc):
    return zlib.crc32(",".join(map(str, ids)).encode(), acc)


def main() -> None:
    mode, seed = sys.argv[1], sys.argv[2]
    r = rng_for(seed)
    acc = 0
    if mode == "train":
        # Training cost is dominated by get_stats + merge over the whole corpus per merge step.
        text = corpus(r, 12000)
        b = BasicTokenizer()
        b.train(text[:6000], 256 + 48)
        rt = RegexTokenizer()
        rt.train(text, 256 + 96)
        for t in (b, rt):
            acc = zlib.crc32(repr(sorted(t.merges.items())).encode(), acc)
    elif mode == "encode":
        # Fixed vocabulary (lineage_bench.model: 512 merges trained by this repo's own
        # RegexTokenizer on tests/taylorswift.txt), so this metric measures encoding only.
        rt = RegexTokenizer()
        rt.load(os.path.join(HERE, "lineage_bench.model"))
        rt.register_special_tokens(SPECIALS)
        texts = [corpus(r, 2500) for _ in range(8)]
        for i, t in enumerate(texts):
            if i % 2:
                t = "<|endoftext|>" + t + "<|fim_prefix|>" + t[:100] + "<|fim_suffix|>"
                acc = digest_ids(rt.encode(t, allowed_special="all"), acc)
            else:
                acc = digest_ids(rt.encode_ordinary(t), acc)
        b = BasicTokenizer()
        b.merges = rt.merges
        b.vocab = rt.vocab
        for t in texts[:2]:
            acc = digest_ids(b.encode(t[:1200]), acc)
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"{mode} {acc:08x}")


if __name__ == "__main__":
    main()
