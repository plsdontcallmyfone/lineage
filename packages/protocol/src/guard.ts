import { DiffParseError, filePath, parseDiff, type FileDiff } from "./diff.ts";
import type { GuardViolation, PatchRules } from "./types.ts";

// Static patch guard, SPEC section 7.2. Pure: the apply check is done by the sandbox.

export interface GuardResult {
  ok: boolean;
  violation?: GuardViolation;
  detail?: string;
  files: number;
  lines: number;
  /** Non-fatal heuristics, logged for auditors (SPEC 7.2). */
  flags: string[];
}

const globCache = new Map<string, RegExp>();

/** Glob to RegExp: `**` spans directories, `*` and `?` stay inside one segment. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let s = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        s += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else s += "[^/]*";
    } else if (c === "?") s += "[^/]";
    else if ("\\^$+.()|{}[]".includes(c)) s += "\\" + c;
    else s += c;
  }
  re = new RegExp(s + "$");
  globCache.set(glob, re);
  return re;
}

export const matchesAny = (path: string, globs: string[]): boolean => globs.some((g) => globToRegExp(g).test(path));

const FLAG_PATTERNS: [RegExp, string][] = [
  [/LINEAGE_/, "reads LINEAGE_ environment"],
  [/lineage_(bench|equiv)/, "references harness"],
  [/\b(process\.hrtime|performance\.now|Instant::now|time\.perf_counter|SystemTime::now)\b/, "adds timing call"],
  [/\b(getpid|process\.argv|std::env::args|sys\.argv)\b/, "adds process introspection"],
];

function bad(violation: GuardViolation, detail: string, files = 0, lines = 0): GuardResult {
  return { ok: false, violation, detail, files, lines, flags: [] };
}

export function guard(diffText: string, rules: PatchRules): GuardResult {
  let files: FileDiff[];
  try {
    files = parseDiff(diffText);
  } catch (e) {
    return bad("MALFORMED", e instanceof DiffParseError ? e.message : String(e));
  }
  if (files.length === 0) return bad("EMPTY", "no files");

  let lines = 0;
  const flags: string[] = [];
  for (const f of files) {
    const paths = [f.oldPath, f.newPath].filter((p): p is string => p !== null);
    for (const p of paths) {
      if (p.split("/").some((seg) => seg === ".." || seg === ".git")) return bad("OUTSIDE_ALLOWED", p);
      if (matchesAny(p, rules.protected_paths)) return bad("PROTECTED_PATH", p);
      if (!matchesAny(p, rules.allowed_paths)) return bad("OUTSIDE_ALLOWED", p);
    }
    if (f.status === "rename") return bad("RENAME", filePath(f));
    if (f.binary) return bad("BINARY", filePath(f));
    for (const m of [f.oldMode, f.newMode]) {
      if (m === "120000") return bad("SYMLINK", filePath(f));
      if (m === "160000") return bad("SUBMODULE", filePath(f));
    }
    if (f.status === "modify" && f.oldMode && f.newMode && f.oldMode !== f.newMode) return bad("MODE_CHANGE", filePath(f));
    if (f.status === "add" && f.newMode && f.newMode !== "100644") return bad("MODE_CHANGE", filePath(f));
    if (f.hunks.length === 0 && f.status === "modify") return bad("EMPTY", filePath(f));
    lines += f.added + f.removed;
    for (const l of f.hunks) {
      if (!l.startsWith("+")) continue;
      for (const [re, label] of FLAG_PATTERNS) if (re.test(l)) flags.push(`${filePath(f)}: ${label}`);
    }
  }
  if (files.length > rules.max_files) return bad("TOO_MANY_FILES", `${files.length} > ${rules.max_files}`, files.length, lines);
  if (lines > rules.max_lines) return bad("TOO_MANY_LINES", `${lines} > ${rules.max_lines}`, files.length, lines);
  if (lines === 0) return bad("EMPTY", "no changed lines", files.length, 0);
  return { ok: true, files: files.length, lines, flags: [...new Set(flags)] };
}
