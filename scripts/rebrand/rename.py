#!/usr/bin/env python3
# Rebrand pass (docs/plans/REBRAND-UNITS.md 5): renames the brand in tracked text files by pattern,
# leaving frozen strings, records and the concept noun alone. ONE-SHOT: already applied (merged
# 2026-10-11). Do not rerun with --write: it would also rename the compatibility names added after it
# (LINEAGE_* env fallbacks, the <lineage-*> element aliases, window.Lineage).
#   python3 -I scripts/rebrand/rename.py [--write]      (without --write: counts only)
import os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
WRITE = "--write" in sys.argv

# Records, frozen inputs and history: never rewritten.
EXCLUDE = re.compile(r"""^(
    recipes/ | fixtures/ | research/ | docs/plans/ | docs/audit/ | onchain/tests/ | onchain/vendor/ |
    onchain/programs/ | scripts/rebrand/ | images/(python|rust|go|zig|cpp|cuda|solana)/ |
    CLAUDE\.md$ | bun\.lock$ | onchain/Cargo\.lock$ | onchain/DEVNET\.md$ | scripts/deploy/SITE-DEVNET\.md$ |
    docs/VERIFICATION\.md$ | docs/GPU-SESSION\.md$ | docs/MILESTONES\.md$ |
    scripts/.*\.json$ | apps/web/scripts/.*\.json$ | packages/.*/[A-Z-]+LAST\.json$ |
    .*LAST\.json$ | .*/runs/ | .*RUNS\.md$ | .*STATE\.json$ | .*\.jsonl$ | .*/fixtures/ |
    packages/protocol/src/ids\.ts$ | packages/protocol/test/frozen-domains\.test\.ts$ |
    packages/mirror/src/message\.ts$ | packages/protocol/src/env-alias\.ts$ | packages/protocol/test/(env-alias|trailers|statement-domains)\.test\.ts$
)""", re.X)
TEXT = re.compile(r"\.(ts|tsx|js|mjs|json|md|sh|service|timer|tmpl|toml|yml|yaml|html|css|py|txt)$|(^|/)(Dockerfile|lineage-desk-gw)$")

# Strings that must survive every pass (placeholders while the passes run).
PROTECT = [
    r"lineage-(x25519|msg-seal|episode|soul-variety|link|identity|rotate|github-genesis)-v1",
    r"lineage-\$\{purpose\}-v1",
    r"lineage-(follow|reaction|media|link|agent-follow|journal|upstream-optin|reputation|identity-token|identity-revoke|github-genesis|soul)\b(?![-.@])",
    r"\bLineage-[A-Z][A-Za-z0-9-]*",
    r"lineage-proof(\.json|\.md)?", r"lineage-learnings[a-z-]*", r"lineage:(genesis|status)[a-z: v0-9-]*", r"lineage-episode/1",
    r"lineage-app(@lineage\.invalid)?", r"lineage\.invalid",
    r"lineage(=1|\.(job|desktop|attempt|build-hash)\b)",
    r"\bLINEAGE_SEED\b", r"\blineage_[a-z0-9_]+", r"\bLINEAGE\.md\b",
    r"(/opt|/var/lib|/etc|/home|/run|\.config|/var/log/caddy)/lineage[a-zA-Z0-9_.-]*", r"~/\.lineage\b", r"/\.lineage\b", r"\.lineage/",
    r"lineage-(desk|desktop|site-dryrun|deploy|sim-verifier)[a-zA-Z0-9_.-]*",
    r"(?<!@)\blineage/[a-z0-9{$]", r"`lineage/", r"\"lineage/",
    r"\blineage-(core|web|gate|indexer|monitor|identity|runtime|bootstrap|reference|author|verifier|backup|restore-test)\b",
    r"H\(\"lineage\"", r"--hostname\",\s*\"lineage\"", r"\"--hostname\",\n\s*\"lineage\"",
    r"github\.com/plsdontcallmyfone/lineage", r"plsdontcallmyfone/lineage",
    r"lineage-garage|lineage-sable", r"com\.lineage\.[a-z-]+",
    r"Lineage devnet TEST LINE", r"Published under the Lineage app identity",
    r"LINEAGE_RECIPES=\$UNITS_RECIPES", r"LINEAGE_SITE_URL=https", r"\$\{LINEAGE_RECIPES", r"cur LINEAGE_RECIPES",
]
PROTECT_RE = re.compile("|".join(f"(?:{p})" for p in PROTECT))

def css_var_fallback(s: str) -> str:
    # var(--lineage-x, d) -> var(--units-x, var(--lineage-x, d)); var(--lineage-x) -> var(--units-x, var(--lineage-x))
    out, i = [], 0
    pat = re.compile(r"var\(--lineage-([a-z0-9-]+)")
    while True:
        m = pat.search(s, i)
        if not m:
            out.append(s[i:]); break
        out.append(s[i:m.start()])
        pre = f"var(--units-{m.group(1)}, "
        if s[max(0, m.start() - len(pre)):m.start()] == pre:  # already wrapped
            out.append(m.group(0)); i = m.end(); continue
        depth, j = 1, m.end()
        while j < len(s) and depth:
            if s[j] == "(": depth += 1
            elif s[j] == ")": depth -= 1
            j += 1
        inner = s[m.start():j]  # var(--lineage-x ... )
        out.append(f"var(--units-{m.group(1)}, {inner})")
        i = j
    return "".join(out)

PASSES = [
    ("package scope", re.compile(r"@lineage/"), "@units/"),
    ("env vars", re.compile(r"\bLINEAGE_(?!SEED\b)([A-Z0-9_]+)"), r"UNITS_\1"),
    ("embed elements", re.compile(r"(?<![-\w])lineage-(screen|stats|device|explorer|reel|leaderboard|terminal|token|feed|palette|how|ready)\b"), r"units-\1"),
    ("embed asset", re.compile(r"\blineage-(embed|explorer)\.js\b"), r"units-\1.js"),
    ("js globals", re.compile(r"\bwindow\.Lineage(Config)?\b"), r"window.Units\1"),
    ("js globals 2", re.compile(r"\bLineageConfig\b"), "UnitsConfig"),
    ("event name", re.compile(r"\blineage:event\b"), "units:event"),
    ("cli bins", re.compile(r"\blineage-(worker|souls|mirror)\b"), r"units-\1"),
    ("site title", re.compile(r"\bLineage Network\b"), "units"),
    ("brand word", re.compile(r"(?<![A-Za-z.`/-])Lineage(?![-_A-Za-z])"), "units"),
]

files = subprocess.run(["git", "-C", ROOT, "ls-files"], capture_output=True, text=True).stdout.split("\n")
total, per = 0, {}
changed = []
for f in files:
    if not f or EXCLUDE.match(f) or not TEXT.search(f): continue
    p = os.path.join(ROOT, f)
    if os.path.islink(p) or not os.path.isfile(p): continue
    try: s = open(p, encoding="utf-8").read()
    except Exception: continue
    if "ineage" not in s and "INEAGE" not in s: continue
    keep = []
    def stash(m):
        keep.append(m.group(0)); return f"\x00{len(keep) - 1}\x00"
    t = PROTECT_RE.sub(stash, s)
    for name, rx, rep in PASSES:
        t, n = rx.subn(rep, t)
        if n: per[name] = per.get(name, 0) + n; total += n
    if f.startswith(("packages/embed/src/", "apps/web/")) and not f.endswith(".md"):
        n0 = t.count("var(--lineage-"); t2 = css_var_fallback(t)
        if t2 != t: per["css var fallback"] = per.get("css var fallback", 0) + n0; t = t2
    t, n = re.subn(r"(?<!var\()--lineage-([a-z0-9-]+)", r"--units-\1", t)
    if n: per["css var names"] = per.get("css var names", 0) + n
    t = re.sub("\x00(\\d+)\x00", lambda m: keep[int(m.group(1))], t)
    if t != s:
        changed.append(f)
        if WRITE: open(p, "w", encoding="utf-8").write(t)
for k, v in per.items(): print(f"{v:6d}  {k}")
print(f"{len(changed)} files {'written' if WRITE else 'would change'}")
