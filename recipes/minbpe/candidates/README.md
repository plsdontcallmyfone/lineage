# Hand-written candidates (minbpe)

Each patch was evaluated as a single replay against the snapshot with `bun scripts/check-canaries.ts recipes/minbpe candidates`; the measured verdicts and raw instruction counts are in `results.json` (seeds recorded there).

- `train_dedupe_chunks.diff`: RegexTokenizer.train keeps each distinct regex chunk once (first-seen order) with its multiplicity and counts pairs weighted; pair counts and their first-seen order are unchanged, so the merges (ties included) are identical. Accepted on train_ir, measured ratio 0.56715.
- `encode_chunk_cache.diff`: encode_ordinary encodes each distinct chunk once per call through a call-local dict. Accepted on encode_ir, measured ratio 0.90083.
