# Hand-written candidates (lc-text-splitters)

Evaluated as a single replay against the snapshot with `bun scripts/check-canaries.ts recipes/lc-text-splitters candidates`; measured verdicts and raw instruction counts are in `results.json` (seed recorded there). Patch definitions live in `../patch-defs.json` and are turned into diffs by `bun scripts/make-canaries.ts lc-text-splitters`.

Upstream PRs need an opt-in first (SPEC 16); langchain's AGENTS.md then asks for a brief disclaimer noting AI-agent involvement.

- `merge_window_index.diff`: TextSplitter._merge_splits keeps the current window as an index into one growing list instead of copying the list on every pop from the front, and measures each piece once instead of again when it is popped. Same chunks for any pure length function. Verdict accepted on recursive_ir, measured ratio 0.97692 (other metrics: code_ir 0.97082, markdown_ir 0.99962; seed 7265706c61792d6d).
- `printable_fast_path.diff`: MarkdownHeaderTextSplitter.split_text filters non-printable characters only from lines that contain one (str.isprintable() on the whole line is a single C call), instead of rebuilding every line character by character. Same output: for an all-printable line the filter is the identity. Verdict accepted on markdown_ir, measured ratio 0.48253 (other metrics: recursive_ir 1.00098, code_ir 1.00598; seed 7265706c61792d70).
