"""Units benchmark harness for karpathy/minbpe, heavy workload (overlay file, protected).

Usage: python lineage_bench.py <train_basic|train_regex|encode|decode|save_load> <seed> [--inputs-only]

Second recipe for the repository (recipes/minbpe is the first and is frozen). The first harness ran
about 3.8 G instructions at generation 0 and about 0.33 G at its unit's tip, of which starting the
interpreter and the imports were 60%, so the 1% minimum effect had become 2.5% of what a change to
the library can touch. This one is sized so that the library is nearly all of the count, also after
the first large optimisations, and it has five targets instead of two:

  train_basic  BasicTokenizer.train on a few documents (one flat id list per document)
  train_regex  RegexTokenizer.train with the GPT-4 and the GPT-2 split patterns on larger corpora
  encode       RegexTokenizer.encode_ordinary and encode with special tokens on long texts, and
               BasicTokenizer.encode on short ones, with a fixed vocabulary (lineage_bench.model)
  decode       decode of long id lists (RegexTokenizer with special tokens, BasicTokenizer)
  save_load    Tokenizer.save (model and vocab files) and load, for a 3,072-merge vocabulary

What is not the library's work is kept small and is measurable: `--inputs-only` runs the same
imports and builds the same inputs, then stops before the first library call that the mode
measures (scripts/efficiency/fixed-share.ts reports its share of each metric).
- tiktoken is not imported: minbpe/__init__.py imports GPT4Tokenizer, whose module imports
  tiktoken (about 55 M instructions of the 214 M that `import minbpe` costs on arm64). A stub
  module stands in for it here; GPT4Tokenizer is not benchmarked and stays covered by the tests,
  which run with the real tiktoken.
- Inputs are seeded windows of tests/taylorswift.txt (slices, no per-character work) joined with
  a few seeded synthetic lines (digits, unicode, emoji, whitespace runs, contractions), so BPE
  merges and both split patterns see realistic text and every run of a seed sees the same bytes.

Determinism: inputs depend only on the seed and repo files, PYTHONHASHSEED=0 is set by the sandbox,
the cyclic GC is off so collection points cannot move with a patch's allocation pattern, and files
go to a fresh directory under /tmp with fixed names.
"""
import gc
import hashlib
import os
import random
import sys
import types
import zlib

sys.modules.setdefault("tiktoken", types.ModuleType("tiktoken"))

from minbpe import BasicTokenizer, RegexTokenizer  # noqa: E402
from minbpe.regex import GPT2_SPLIT_PATTERN  # noqa: E402

gc.disable()

HERE = os.path.dirname(os.path.abspath(__file__))
SPECIALS = {"<|endoftext|>": 100257, "<|fim_prefix|>": 100258, "<|fim_middle|>": 100259, "<|fim_suffix|>": 100260}
EXTRA = ["été", "naïve", "你好", "привет", "\U0001F600", "\U0001F680", "مرحبا", "don't", "we'll", "I'VE"]


def rng_for(seed: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))


def prose() -> str:
    with open(os.path.join(HERE, "tests", "taylorswift.txt"), encoding="utf-8") as f:
        return f.read()


def synthetic(r: random.Random, n: int):
    """n short seeded lines; each is reused many times by corpus(), so their cost stays small."""
    syll = ["ka", "lo", "mi", "ne", "tor", "ex", "an", "ing", "th", "qu", "z", "re", "st", "o", "ul"]
    out = []
    for _ in range(n):
        words = []
        for _ in range(r.randint(6, 30)):
            x = r.random()
            if x < 0.70:
                words.append("".join(r.choice(syll) for _ in range(r.randint(1, 4))))
            elif x < 0.82:
                words.append(str(r.randint(0, 10 ** r.randint(1, 7))))
            elif x < 0.93:
                words.append(r.choice(EXTRA))
            else:
                words.append(r.choice([",", ".", "!!", "?", "'s", "'ll", ":", "--", "(", ")"]))
        out.append(" ".join(words) + r.choice(["\n", "\n\n", "  \n", ". ", "\r\n"]))
    return out


def corpus(r: random.Random, text: str, lines, n_chars: int) -> str:
    parts = []
    size = 0
    while size < n_chars:
        if r.random() < 0.75:
            start = r.randrange(0, len(text) - 4000)
            s = text[start:start + r.randint(400, 3000)]
        else:
            s = "".join(r.choice(lines) for _ in range(r.randint(2, 8)))
        parts.append(s)
        size += len(s)
    return "".join(parts)[:n_chars]


def digest_ids(ids, acc):
    return zlib.crc32(",".join(map(str, ids)).encode(), acc)


def main() -> None:
    mode, seed = sys.argv[1], sys.argv[2]
    inputs_only = "--inputs-only" in sys.argv[3:]
    r = rng_for(seed)
    text = prose()
    lines = synthetic(r, 40)
    acc = 0
    if mode == "train_basic":
        docs = [corpus(r, text, lines, 8000) for _ in range(2)]
        if inputs_only:
            return print(mode, "inputs", zlib.crc32("".join(docs).encode()))
        for d in docs:
            b = BasicTokenizer()
            b.train(d, 256 + 128)
            acc = zlib.crc32(repr(list(b.merges.items())).encode(), acc)
    elif mode == "train_regex":
        big = corpus(r, text, lines, 12000)
        small = corpus(r, text, lines, 6000)
        if inputs_only:
            return print(mode, "inputs", zlib.crc32((big + small).encode()))
        t4 = RegexTokenizer()
        t4.train(big, 256 + 160)
        t2 = RegexTokenizer(GPT2_SPLIT_PATTERN)
        t2.train(small, 256 + 96)
        for t in (t4, t2):
            acc = zlib.crc32(repr(list(t.merges.items())).encode(), acc)
    elif mode == "encode":
        texts = [corpus(r, text, lines, 30000) for _ in range(4)]
        short = [corpus(r, text, lines, 1500) for _ in range(3)]
        if inputs_only:
            return print(mode, "inputs", zlib.crc32("".join(texts + short).encode()))
        # fixed vocabulary (lineage_bench.model: 512 merges trained by this repository's own
        # RegexTokenizer on tests/taylorswift.txt), so this metric measures encoding only
        rt = RegexTokenizer()
        rt.load(os.path.join(HERE, "lineage_bench.model"))
        rt.register_special_tokens(SPECIALS)
        for i, t in enumerate(texts):
            if i % 2:
                t = "<|endoftext|>" + t[:15000] + "<|fim_prefix|>" + t[15000:] + "<|fim_suffix|>"
                acc = digest_ids(rt.encode(t, allowed_special="all"), acc)
            else:
                acc = digest_ids(rt.encode_ordinary(t), acc)
        b = BasicTokenizer()
        b.merges = rt.merges
        b.vocab = rt.vocab
        for t in short:
            acc = digest_ids(b.encode(t), acc)
    elif mode == "decode":
        rt = RegexTokenizer()
        rt.load(os.path.join(HERE, "lineage_bench.model"))
        rt.register_special_tokens(SPECIALS)
        n_vocab = 256 + len(rt.merges)
        # id lists as an encoder produces them for text (mostly merged tokens of valid UTF-8), with
        # special tokens in between; built from seeded draws, not by encoding, so encode is not in this count
        # (one seeded 256-entry table per list maps seeded random bytes to ids: no per-id Python work)
        common = [i for i in range(256, n_vocab)] + [i for i in range(32, 127)]

        def draw(n):
            table = r.choices(common, k=256)
            return list(map(table.__getitem__, r.randbytes(n)))

        lists = []
        for _ in range(2):
            ids = draw(100000)
            for _ in range(40):
                ids[r.randrange(len(ids))] = r.choice(list(SPECIALS.values()))
            lists.append(ids)
        plain = [draw(100000)]
        if inputs_only:
            return print(mode, "inputs", len(lists), len(plain))
        b = BasicTokenizer()
        b.merges = rt.merges
        b.vocab = rt.vocab
        for _ in range(12):
            for ids in lists:
                acc = zlib.crc32(rt.decode(ids).encode("utf-8"), acc)
            for ids in plain:
                acc = zlib.crc32(b.decode(ids).encode("utf-8"), acc)
    elif mode == "save_load":
        import tempfile

        # a 3,072-merge vocabulary, built here without training: seeded pairs over the ids that exist
        # so far (what train() produces), so save and load are all this metric measures
        rt = RegexTokenizer()
        merges = {}
        idx = 256
        while len(merges) < 3072:
            pair = (r.randrange(32, idx) if r.random() < 0.9 else r.randrange(0, 256), r.randrange(32, idx))
            if pair not in merges:
                merges[pair] = idx
                idx += 1
        if inputs_only:
            return print(mode, "inputs", len(merges))
        rt.merges = merges
        rt.vocab = rt._build_vocab()
        rt.register_special_tokens(SPECIALS)
        with tempfile.TemporaryDirectory() as d:
            for k in range(12):
                prefix = os.path.join(d, f"tok{k}")
                rt.save(prefix)
                with open(prefix + ".vocab", "rb") as f:
                    acc = zlib.crc32(f.read(), acc)
                t2 = RegexTokenizer()
                t2.load(prefix + ".model")
                acc = zlib.crc32(repr((t2.pattern, len(t2.merges), sorted(t2.special_tokens.items()), len(t2.vocab))).encode(), acc)
                b = BasicTokenizer()
                b.merges = dict(list(merges.items())[: 1024 + 128 * k])
                b.vocab = b._build_vocab()
                b.save(prefix + "b")
                b2 = BasicTokenizer()
                b2.load(prefix + "b.model")
                acc = zlib.crc32(repr(list(b2.merges.items())[-3:]).encode(), acc)
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"{mode} {acc:08x}")


if __name__ == "__main__":
    main()
