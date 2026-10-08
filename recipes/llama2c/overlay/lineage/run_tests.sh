#!/bin/sh
# TAP runner for the llama2.c recipe (overlay, protected). Test 1 is upstream's test.c (built
# verbatim by lineage/Makefile; it prints "ALL OK" or exits non-zero); the rest are lineage/props.c.
if out="$(lineage_out/testc 2>&1)" && printf '%s\n' "$out" | grep -qx 'ALL OK'; then
  echo "ok 1 - upstream::test_prompt_encodings"
else
  printf '%s\n' "$out" | tail -n 3 | sed 's/^/# /'
  echo "not ok 1 - upstream::test_prompt_encodings"
fi
exec lineage_out/props 2
