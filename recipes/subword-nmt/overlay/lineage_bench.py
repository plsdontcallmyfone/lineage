"""Lineage benchmark harness for rsennrich/subword-nmt (overlay file, protected).

Usage: python lineage_bench.py <apply|vocab|learn> <seed>

  apply: segments 300 seeded lines with the repository's merge table (subword_nmt/tests/data/bpe.ref)
         through BPE.process_line. Lines are drawn from tests/data/corpus.en with a share of words
         mutated (characters swapped, dropped or repeated) so both the word cache and the merge
         loop run.
  vocab: the same with a vocabulary filter (BPE(vocab=...)), so OOV segments are split back by
         reversing merges (check_vocab_and_split / recursive_split).
  learn: learns 150 merge operations from 200 seeded corpus lines (learn_bpe).
Inputs depend only on the seed; a crc32 of the results is printed.
"""
import gc
import hashlib
import io
import os
import random
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "subword_nmt"))
from apply_bpe import BPE  # noqa: E402
from learn_bpe import learn_bpe  # noqa: E402

gc.disable()
DATA = os.path.join(HERE, "subword_nmt", "tests", "data")


def rng_for(seed):
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))


def mutate(r, w):
    if len(w) < 3:
        return w
    k = r.randrange(3)
    j = r.randrange(len(w) - 1)
    if k == 0:
        return w[:j] + w[j + 1] + w[j] + w[j + 2:]
    if k == 1:
        return w[:j] + w[j + 1:]
    return w[:j] + w[j] + w[j:]


def lines(r, n, pmut):
    with open(os.path.join(DATA, "corpus.en"), encoding="utf-8") as f:
        corpus = f.read().splitlines()
    out = []
    for _ in range(n):
        words = r.choice(corpus).split(" ")
        out.append(" ".join(mutate(r, w) if r.random() < pmut else w for w in words) + "\n")
    return out


def main():
    mode, seed = sys.argv[1], sys.argv[2]
    r = rng_for(seed)
    acc = 0
    if mode in ("apply", "vocab"):
        src = lines(r, 300, 0.15)
        vocab = None
        if mode == "vocab":
            with open(os.path.join(DATA, "corpus.bpe.ref.en"), encoding="utf-8") as f:
                counts = {}
                for line in f:
                    for tok in line.split():
                        counts[tok] = counts.get(tok, 0) + 1
            vocab = set(t for t, c in counts.items() if c >= 2)
        with open(os.path.join(DATA, "bpe.ref"), encoding="utf-8") as codes:
            bpe = BPE(codes, vocab=vocab)
        for line in src:
            acc = zlib.crc32(bpe.process_line(line).encode("utf-8"), acc)
    elif mode == "learn":
        src = lines(r, 200, 0.05)
        out = io.StringIO()
        learn_bpe(io.StringIO("".join(src)), out, 150)
        acc = zlib.crc32(out.getvalue().encode("utf-8"))
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"{mode} {acc:08x}")


if __name__ == "__main__":
    main()
