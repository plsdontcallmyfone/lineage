# Hand-written candidates (bitcoin-base58)

Evaluated as a single replay against the snapshot with `bun scripts/check-canaries.ts recipes/bitcoin-base58 candidates`; measured verdicts and raw instruction counts are in `results.json` (seed recorded there). Patch definitions live in `../patch-defs.json` and are turned into diffs by `bun scripts/make-canaries.ts bitcoin-base58`.

Per SPEC 16 these stay on our fork: Bitcoin Core's AI policy says pull requests must not be opened or driven by autonomous agents.

- `encode_limbs.diff`: EncodeBase58 keeps the value in little-endian base-58^5 limbs (uint32) and folds three input bytes into it per pass (limb * 2^24 + carry fits in 64 bits), then expands each limb into five digits, instead of one byte per pass over a one-digit-per-byte buffer. Verdict accepted on encode_ir, measured ratio 0.16272 (other metrics: decode_ir 0.72962, check_ir 0.64008; seed 7265706c61792d65).
- `decode_limbs.diff`: DecodeBase58 keeps the value in little-endian 32-bit limbs and folds five digits into it per pass (58^5 < 2^32), checking max_ret_len after every pass (the byte length only grows, so the accept/reject decision is unchanged), instead of one digit per pass over a one-byte-per-element buffer. Verdict accepted on decode_ir, measured ratio 0.40281 (other metrics: encode_ir 1.00000, check_ir 0.60269; seed 7265706c61792d64).
