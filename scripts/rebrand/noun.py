#!/usr/bin/env python3
# Protocol noun pass (docs/plans/REBRAND-UNITS.md 3.14): "lineage" as the name of a repository's chain
# of verified generations becomes "unit" in visible copy. Only prose is touched: in TypeScript, text
# inside string and template literals that contains a space (UI copy); in Markdown, text outside code
# spans and fences. Field names, routes, query keys and identifiers are left alone.
#   python3 -I scripts/rebrand/noun.py [--write] <paths...>
import os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
WRITE = "--write" in sys.argv
roots = [a for a in sys.argv[1:] if not a.startswith("--")]

WORD = re.compile(r"(?<![A-Za-z0-9_/?&.$`{\[-])(L|l)ineage(s?)(?![A-Za-z0-9_=/:-])")
def noun(m):
    cap, pl = m.group(1) == "L", m.group(2)
    return ("Unit" if cap else "unit") + ("s" if pl else "")

def prose(text: str) -> tuple[str, int]:
    return WORD.subn(noun, text)

# TypeScript: string literals and the text parts of template literals (not ${...})
LIT = re.compile(r'"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'|`(?:[^`\\]|\\.)*`', re.S)
def ts(src: str) -> tuple[str, int]:
    total = 0
    def lit(m):
        nonlocal total
        s = m.group(0)
        if " " not in s or s.startswith(("'@", '"@', '"./', "'./")):
            return s
        if s[0] == "`":
            parts = re.split(r"(\$\{(?:[^{}]|\{[^{}]*\})*\})", s)
            out = []
            for i, p in enumerate(parts):
                if i % 2 == 1:
                    out.append(p)
                else:
                    t, n = prose(p); total += n; out.append(t)
            return "".join(out)
        t, n = prose(s); total += n
        return t
    # skip comments: only literals are changed, and comments are left as they are
    return LIT.sub(lit, src), total

FENCE = re.compile(r"(```.*?```|`[^`\n]*`|\]\([^)]*\)|<[^>\n]*>|https?://\S+)", re.S)
def md(src: str) -> tuple[str, int]:
    parts = FENCE.split(src)
    total = 0
    for i in range(0, len(parts), 2):
        parts[i], n = prose(parts[i]); total += n
    return "".join(parts), total

files = subprocess.run(["git", "-C", ROOT, "ls-files", "--", *roots], capture_output=True, text=True).stdout.split()
grand = 0
for f in files:
    if re.search(r"LAST\.json$|/runs/|RUNS\.md$", f): continue
    p = os.path.join(ROOT, f)
    if not os.path.isfile(p): continue
    s = open(p, encoding="utf-8").read()
    if "ineage" not in s: continue
    if f.endswith((".ts", ".tsx")): t, n = ts(s)
    elif f.endswith(".md"): t, n = md(s)
    else: continue
    if n:
        grand += n
        print(f"{n:4d} {f}")
        if WRITE: open(p, "w", encoding="utf-8").write(t)
print(grand, "replacements", "written" if WRITE else "(dry run)")
