# Hand-written candidates (geth-rlp)

Evaluated as a single replay against the snapshot with `bun scripts/check-canaries.ts recipes/geth-rlp candidates`; measured verdicts and raw instruction counts are in `results.json` (seed recorded there). Patch definitions live in `../patch-defs.json` and are turned into diffs by `bun scripts/make-canaries.ts geth-rlp`.

- `bigint_words.diff`: encBuffer.writeBigInt fills the big-endian bytes of integers wider than 64 bits from i.Bits() a whole 64-bit word at a time (binary.BigEndian.PutUint64), only the most significant word byte by byte, instead of math.ReadBits' byte-at-a-time loop. 32-bit platforms keep the old path. Verdict accepted on encode_ir, measured ratio 0.86957 (other metrics: decode_ir 1.00000, stream_ir 0.88145; seed 7265706c61792d62).
