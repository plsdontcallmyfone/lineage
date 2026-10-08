"""Lineage equivalence harness for rsennrich/subword-nmt (overlay file, protected).

Usage: python lineage_equiv.py <seed>

Prints the observable results of BPE segmentation and BPE learning on seeded inputs: process_line
and segment_tokens with the default and custom separators, merge limits, version 0.1 codes (no
header), vocabulary filtering, glossaries, seeded dropout, leading/trailing/UTF-8 whitespace and
mutated words; learn_bpe output (and its stderr notes) for seeded corpora with different symbol
counts, min_frequency, dictionary input and total_symbols; isolate_glossary and read_vocabulary.
"""
import contextlib
import hashlib
import io
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "subword_nmt"))
import apply_bpe as A  # noqa: E402
import learn_bpe as L  # noqa: E402

DATA = os.path.join(HERE, "subword_nmt", "tests", "data")


def show(label, fn, *args, **kw):
    try:
        v = fn(*args, **kw)
        print(label, "ok", repr(v))
    except SystemExit as e:
        print(label, "exit", repr(e.code))
    except Exception as e:  # noqa: BLE001
        print(label, "err", type(e).__name__, repr(str(e)))


def main():
    seed = sys.argv[1]
    r = random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest(), "big"))
    with open(os.path.join(DATA, "corpus.en"), encoding="utf-8") as f:
        corpus = f.read().splitlines()
    with open(os.path.join(DATA, "bpe.ref"), encoding="utf-8") as f:
        codes_text = f.read()

    def pick(n):
        out = []
        for _ in range(n):
            ws = r.choice(corpus).split(" ")
            for k in range(len(ws)):
                if r.random() < 0.2 and len(ws[k]) > 2:
                    j = r.randrange(len(ws[k]) - 1)
                    ws[k] = ws[k][:j] + ws[k][j + 1] + ws[k][j] + ws[k][j + 2:]
            out.append(" ".join(ws))
        return out

    sample = pick(60)
    extra = ["", "\n", "  iron cement  \n", "iron\xa0cement\n", "a", "a b  c", "über straße", "1934USABUSA likeable unlike", "x" * 40]
    counts = {}
    for line in sample:
        for w in line.split():
            counts[w] = counts.get(w, 0) + 1
    vocab = set(w for w, c in counts.items() if c >= 2) | {"th@@", "e", "the", "an@@", "d"}
    configs = [
        ("default", dict()),
        ("sep", dict(separator="##")),
        ("merges", dict(merges=r.randint(50, 600))),
        ("vocab", dict(vocab=vocab)),
        ("gloss", dict(glossaries=["USA", "like", "[0-9]+"])),
    ]
    for name, kw in configs:
        bpe = A.BPE(io.StringIO(codes_text), **kw)
        print("config", name, bpe.version, len(bpe.bpe_codes))
        for i, line in enumerate(sample + extra):
            show(f"pl {name} {i}", bpe.process_line, line if line.endswith("\n") else line + "\n")
        show(f"st {name}", bpe.segment_tokens, ["", "a", "abc"] + sample[0].split())
        print("cache", name, len(bpe.cache))
    # version 0.1 codes (no header line)
    bpe01 = A.BPE(io.StringIO("\n".join(codes_text.split("\n")[1:])))
    print("v01", bpe01.version)
    for i, line in enumerate(sample[:20] + extra):
        show(f"pl01 {i}", bpe01.process_line, line + "\n")
    # dropout: encode draws random.random() for every pair, so seed the module RNG
    bpe = A.BPE(io.StringIO(codes_text))
    for d in (0.1, 0.5):
        random.seed(seed + str(d))
        for i, line in enumerate(sample[:15]):
            show(f"drop {d} {i}", bpe.process_line, line + "\n", d)
    for w in ["", "like", "unlike", "likeable", "1934USABUSA", "USA", "xUSAy"]:
        show(f"iso {w}", A.isolate_glossary, w, "USA")
        show(f"isol {w}", A.isolate_glossary, w, "like")
    # learn_bpe
    for k in range(4):
        text = "\n".join(pick(r.randint(20, 120))) + "\n"
        n = r.choice([10, 60, 200, 500])
        for kw in (dict(), dict(min_frequency=r.choice([1, 3, 6])), dict(total_symbols=True)):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stderr(err):
                show(f"learn {k} {n} {sorted(kw.items())}", L.learn_bpe, io.StringIO(text), out, n, **kw)
            print("learned", out.getvalue())
            print("notes", err.getvalue())
        d = {}
        for w in text.split():
            d[w] = d.get(w, 0) + 1
        dict_text = "".join(f"{w} {c}\n" for w, c in sorted(d.items()))
        out = io.StringIO()
        with contextlib.redirect_stderr(io.StringIO()):
            show(f"learndict {k}", L.learn_bpe, io.StringIO(dict_text), out, 80, is_dict=True)
        print("learned", out.getvalue())
        show(f"getvocab {k}", lambda t: sorted(L.get_vocabulary(io.StringIO(t)).items()), text)
    show("readvocab", lambda: sorted(A.read_vocabulary(io.StringIO("a 5\nb 1\nc 3\n"), 2)))


if __name__ == "__main__":
    main()
