#!/usr/bin/env python3
# Rebrand inventory (docs/plans/REBRAND-UNITS.md): counts every lineage/Lineage/LINEAGE occurrence in
# tracked text files by plan category. Usage: python3 -I scripts/rebrand/inventory.py [repo root]
import re, subprocess, collections, sys
root = sys.argv[1] if len(sys.argv) > 1 else "."
files = subprocess.run(["git","-C",root,"grep","-Iil","lineage"],capture_output=True,text=True).stdout.split()
cats = [
 ("frozen: recipes (feed recipe_id -> lineage_id)", lambda f,m,ctx: f.startswith("recipes/")),
 ("frozen: hash/HKDF domains + id derivation", lambda f,m,ctx: re.search(r'lineage-(x25519|msg-seal|soul-variety|episode)-v1|H\("lineage",|"lineage-link-v1"', ctx)),
 ("dual: statement purposes/kinds (signed)", lambda f,m,ctx: re.search(r'lineage-\$\{purpose\}|lineage-(follow|reaction|media|link|agent-follow|journal|upstream-optin|reputation|identity-token|identity-revoke|github-genesis|identity-v1|rotate-v1|soul)\b', ctx)),
 ("dual: commit trailers Lineage-*", lambda f,m,ctx: re.search(r'Lineage-[A-Z]', ctx)),
 ("dual: GitHub artifacts (proof file, learnings repo, markers, branches, episode schema)", lambda f,m,ctx: re.search(r'lineage-proof|lineage-learnings|lineage:(genesis|status)|lineage-episode/|`lineage/\$|lineage/pr-|lineage-app@', ctx)),
 ("rename: @lineage/* package scope", lambda f,m,ctx: m.startswith("@") ),
 ("rename+alias: LINEAGE_* env vars", lambda f,m,ctx: m.startswith("LINEAGE_")),
 ("rename: on-chain crates lineage_registry/launch/msg", lambda f,m,ctx: re.match(r'lineage[-_](registry|launch|msg)\b', m)),
 ("keep (domain noun): lineage_id / lineages / lineage concept", lambda f,m,ctx: re.match(r'(lineage_id|lineages|lineageId|lineage_ids|LineageSummary|lineage_root|lineage_retired|lineage_inactive|lineage_exists|lineage_col)', m) or re.search(r'/v1/(admin/)?lineages', ctx)),
 ("rename+symlink: server/local paths", lambda f,m,ctx: re.search(r'(/opt/|/var/lib/|/etc/|/home/|\.config/|/\.)lineage', ctx) and re.search(r'(/opt/|/var/lib/|/etc/|/home/|\.config/|/\.)'+re.escape(m), ctx)),
 ("rename: systemd units, service users, CLI bins", lambda f,m,ctx: re.match(r'lineage-(core|web|gate|indexer|monitor|identity|runtime|author|verifier|reference|backup|bootstrap|worker|souls|mirror|deploy|restore-test|desk-gw)', m)),
 ("rename (both during transition): Docker label + image names", lambda f,m,ctx: re.search(r'lineage=1|lineage/(desktop|worker|python|rust|go|zig|cpp|cuda|solana)', ctx)),
 ("rename+alias: embed elements / window.Lineage / events", lambda f,m,ctx: re.search(r'<lineage-|window\.Lineage|lineage-ready|lineage:event|customElements|LineageConfig', ctx)),
 ("rename+migrate: browser storage keys", lambda f,m,ctx: re.search(r'lineage(\.deck|-wallet|-theme|-gh:|\.created|\.status)', ctx)),
]
tot = collections.Counter(); filesby = collections.defaultdict(set)
for f in files:
    try: txt = open(f"{root}/{f}", encoding="utf-8", errors="ignore").read()
    except Exception: continue
    for line in txt.splitlines():
        for mo in re.finditer(r"@?[A-Za-z_.-]*?(lineage|Lineage|LINEAGE)(/[a-z-]+)?[A-Za-z0-9_]*", line):
            m = mo.group(0); s = mo.start()
            mm = re.search(r'(@lineage/[a-z-]+|LINEAGE_[A-Z0-9_]+|[Ll]ineage[A-Za-z0-9_-]*|LINEAGE)', m).group(0)
            ctx = line
            c = "rename: other identifiers + prose/copy/docs"
            for name, fn in cats:
                try:
                    if fn(f, mm, ctx): c = name; break
                except Exception: pass
            tot[c]+=1; filesby[c].add(f)
for c,n in tot.most_common(): print(f"{n:6d} occ {len(filesby[c]):4d} files  {c}")
print(sum(tot.values()), "total", len(files), "files")
