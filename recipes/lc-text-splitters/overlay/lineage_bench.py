"""lineage_bench for langchain-text-splitters (overlay, protected).

Usage: python lineage_bench.py <recursive|code|markdown> <seed>
Run under callgrind with --toggle-collect=ffi_call (see main). The cyclic GC is disabled so collection points cannot move when a patch
changes allocation counts; inputs depend only on the seed and the repository's own files.
"""

import ctypes
import gc
import sys

import lineage_corpus as lc

from langchain_text_splitters import (
    CharacterTextSplitter,
    Language,
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
)


def work(mode: str, texts: list[str]) -> int:
    total = 0
    if mode == "recursive":
        for size, overlap in ((300, 30), (1000, 200)):
            s = RecursiveCharacterTextSplitter(chunk_size=size, chunk_overlap=overlap, add_start_index=True)
            for d in s.create_documents(texts):
                total += len(d.page_content) + d.metadata["start_index"]
        c = CharacterTextSplitter(separator="\n\n", chunk_size=500, chunk_overlap=50)
        for t in texts:
            total += len(c.split_text(t))
    elif mode == "code":
        s = RecursiveCharacterTextSplitter.from_language(Language.PYTHON, chunk_size=400, chunk_overlap=40)
        for t in texts:
            total += sum(len(x) for x in s.split_text(t))
    elif mode == "markdown":
        h = MarkdownHeaderTextSplitter([("#", "h1"), ("##", "h2"), ("###", "h3")], strip_headers=False)
        for t in texts:
            total += sum(len(d.page_content) + len(d.metadata) for d in h.split_text(t))
    return total


def main() -> None:
    gc.disable()
    mode, seed = sys.argv[1], sys.argv[2]
    if mode not in ("recursive", "code", "markdown"):
        raise SystemExit(f"unknown mode {mode}")
    r = lc.rng(seed, "bench")
    texts = lc.windows(r, lc.corpus("py" if mode == "code" else "md"), 300, 6000)
    # The measured region: work() is invoked through ctypes (libffi's ffi_call into the C API's
    # PyEval_CallFunction), and the metric runs callgrind with --toggle-collect=ffi_call, so
    # only instructions executed inside that call are counted; nothing else in this process
    # goes through ffi_call. Interpreter start-up, imports (~1.24G instructions for
    # langchain_core and its dependencies) and input generation are excluded. (libpython's
    # own exports are not usable as toggle points: callgrind does not attribute calls to them
    # by name in this stripped build, so a toggle on them counted nothing.)
    call = ctypes.pythonapi.PyEval_CallFunction
    call.restype = ctypes.py_object
    call.argtypes = [ctypes.py_object, ctypes.c_char_p, ctypes.py_object, ctypes.py_object]
    print(call(work, b"OO", mode, texts))


if __name__ == "__main__":
    main()
