# Hand-written candidates (base58-rs)

Evaluated as a single replay against the snapshot with `bun scripts/check-canaries.ts recipes/base58-rs candidates`; measured verdict and raw instruction counts are in `results.json` (seed recorded there). Patch definitions live in `../patch-defs.json` and are turned into diffs by `bun scripts/make-canaries.ts base58-rs`.

- `encode_limbs.diff`: to_base58 converts four input bytes per pass into little-endian base-58^5 limbs held in u64, then expands each limb into five digits, instead of one byte per pass over a one-digit-per-byte buffer. Accepted on encode_ir, measured ratio 0.15916.
