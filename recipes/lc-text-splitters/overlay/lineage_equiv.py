"""lineage_equiv for langchain-text-splitters (overlay, protected). Usage: python lineage_equiv.py <seed>

Prints a digest of every chunk (text, start index, metadata) produced by the splitters the
benchmark measures, across seeded windows, chunk sizes, overlaps, keep_separator modes and
regex separators, so behaviour changes the unit tests miss show up.
"""

import gc
import hashlib
import json
import sys

import lineage_corpus as lc

from langchain_text_splitters import (
    CharacterTextSplitter,
    Language,
    MarkdownHeaderTextSplitter,
    MarkdownTextSplitter,
    RecursiveCharacterTextSplitter,
)


def main() -> None:
    gc.disable()
    r = lc.rng(sys.argv[1], "equiv")
    h = hashlib.sha256()

    def emit(tag, obj):
        h.update(json.dumps([tag, obj], sort_keys=True, ensure_ascii=False).encode())

    md = lc.windows(r, lc.corpus("md"), 60, 5000)
    # Real Markdown rarely contains control or invisible characters, but the splitters handle
    # them specially (MarkdownHeaderTextSplitter drops non-printable characters), so half the
    # windows get some spliced in at seeded positions.
    odd = ["\t", "\x0b", "\x0c", "\x07", "\u200b", "\ufeff", "\u00a0", "\u2028", "\r"]
    for k in range(0, len(md), 2):
        t = md[k]
        for _ in range(r.randrange(1, 12)):
            at = r.randrange(0, len(t) + 1)
            t = t[:at] + r.choice(odd) + t[at:]
        md[k] = t
    py = lc.windows(r, lc.corpus("py"), 40, 5000)
    for i, t in enumerate(md):
        size = r.choice([20, 50, 120, 300, 1000])
        overlap = r.randrange(0, size // 2)
        keep = r.choice([True, False, "start", "end"])
        s = RecursiveCharacterTextSplitter(chunk_size=size, chunk_overlap=overlap, keep_separator=keep, add_start_index=True, strip_whitespace=r.random() < 0.7)
        emit("rec", [(d.page_content, d.metadata) for d in s.create_documents([t])])
        sep = r.choice(["\n\n", "\n", " ", ". ", r"\s+"])
        c = CharacterTextSplitter(separator=sep, is_separator_regex=sep == r"\s+", chunk_size=size, chunk_overlap=overlap)
        emit("chr", c.split_text(t))
        emit("mdh", [(d.page_content, d.metadata) for d in MarkdownHeaderTextSplitter([("#", "h1"), ("##", "h2"), ("###", "h3")], strip_headers=i % 2 == 0, return_each_line=i % 3 == 0).split_text(t)])
        emit("mdt", MarkdownTextSplitter(chunk_size=size, chunk_overlap=overlap).split_text(t))
    for t in py:
        size = r.choice([40, 120, 400])
        s = RecursiveCharacterTextSplitter.from_language(Language.PYTHON, chunk_size=size, chunk_overlap=r.randrange(0, size // 2))
        emit("py", s.split_text(t))
    print(h.hexdigest())


if __name__ == "__main__":
    main()
