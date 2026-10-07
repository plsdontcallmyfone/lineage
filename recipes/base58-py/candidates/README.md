# Hand-written candidates (base58-py)

Each patch was evaluated as a single replay against the snapshot with `bun scripts/check-canaries.ts recipes/base58-py candidates`; the measured verdicts and raw instruction counts are in `results.json` (seeds recorded there).

- `encode_chunked.diff`: b58encode_int peels five base-58 digits per big-integer divmod (58**5 fits one internal int digit) and builds the output in a bytearray instead of prepending to bytes. Accepted on encode_ir, measured ratio 0.88647.
- `decode_chunked.diff`: b58decode_int folds five digits into a small int, then into the big integer with one multiply-add. Accepted on decode_ir, measured ratio 0.94751; note the same replay measured check_ir at 1.00610 (short Base58Check strings pay the extra setup).
