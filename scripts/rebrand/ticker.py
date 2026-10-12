#!/usr/bin/env python3
# Ticker pass (docs/plans/REBRAND-UNITS.md 3.15): $LINE becomes $UNITS and tLINE becomes UNITS in
# copy, labels, config symbols and docs. Records and the scripts that create or check the devnet test
# coin's on-chain metadata (name and symbol cannot change) are left alone.
#   python3 -I scripts/rebrand/ticker.py [--write]
import os, re, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
WRITE = "--write" in sys.argv
EXCLUDE = re.compile(r"""^(recipes/|fixtures/|research/|docs/plans/|docs/audit/|onchain/tests/|onchain/vendor/|onchain/programs/|scripts/rebrand/|
  CLAUDE\.md$|bun\.lock$|onchain/DEVNET\.md$|scripts/deploy/SITE-DEVNET\.md$|docs/VERIFICATION\.md$|docs/MILESTONES\.md$|
  scripts/devnet/setup\.ts$|scripts/devnet/pump-devnet-proof\.ts$|scripts/devnet/.*\.json$|scripts/.*\.json$|.*LAST\.json$|.*/runs/|.*RUNS\.md$|.*STATE\.json$|.*\.jsonl$)""", re.X)
TEXT = re.compile(r"\.(ts|tsx|js|json|md|sh|html|css|yml|yaml|toml|py)$")
PASSES = [(re.compile(r"\$LINE\b"), "$UNITS"), (re.compile(r"(?<![A-Za-z])tLINE\b"), "UNITS")]
n_all = 0
for f in subprocess.run(["git", "-C", ROOT, "ls-files"], capture_output=True, text=True).stdout.split("\n"):
    if not f or EXCLUDE.match(f) or not TEXT.search(f): continue
    p = os.path.join(ROOT, f)
    if not os.path.isfile(p): continue
    s = open(p, encoding="utf-8").read()
    if "LINE" not in s: continue
    t = s
    for rx, rep in PASSES: t = rx.sub(rep, t)
    if t != s:
        n = sum(len(rx.findall(s)) for rx, _ in PASSES); n_all += n
        print(f"{n:4d} {f}")
        if WRITE: open(p, "w", encoding="utf-8").write(t)
print(n_all, "replacements", "written" if WRITE else "(dry run)")
