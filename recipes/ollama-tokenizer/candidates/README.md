# Hand-written candidates (ollama-tokenizer)

Evaluated as a single replay against the snapshot with `bun scripts/check-canaries.ts recipes/ollama-tokenizer candidates`; measured verdicts and raw instruction counts are in `results.json` (seed recorded there). Patch definitions live in `../patch-defs.json` and are turned into diffs by `bun scripts/make-canaries.ts ollama-tokenizer`.

- `bpe_no_concat.diff`: encodeBPEMerge builds each merge-table key ('left right') in one reused byte buffer and looks it up with m[string(buf)] (which Go does without allocating or copying), instead of concatenating three strings per candidate pair; and a popped pair is checked still current by comparing lengths (both tokens and the pair value are spans of the same encoded string starting at the left node) instead of concatenating the two tokens and comparing bytes. Verdict accepted on encode_ir, measured ratio 0.85327 (other metrics: decode_ir 0.99989; seed 7265706c61792d62).
