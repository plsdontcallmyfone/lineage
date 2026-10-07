import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LINEAGE_HOME, mirrorPath } from "../../sandbox/src/repo.ts";
import { overlayDigest } from "../../sandbox/src/recipe.ts";
import { canonicalUrl, filePath, parseDiff, sha256Hex, type Recipe } from "./protocol.ts";

// Generation trees for the live wall (SPEC 17.1). Core never stores trees: the tree at a
// generation is the snapshot commit, plus the recipe overlay, plus the generation's patch series,
// exactly as a worker materialises it. This module rebuilds ONE file of that tree on demand:
//
//   base bytes   = recipes/<name>/overlay/<path> when the overlay (verified against the recipe's
//                  overlay_digest) has it, else `git show <commit>:<path>` from the local bare
//                  mirror the sandbox already keeps (LINEAGE_HOME/mirrors, or fixtures/ for
//                  fixture: repos). Core never clones: a missing mirror means "tree unavailable".
//   patched      = each canonical patch of the series applied in order, hunk by hunk, with no fuzz
//                  (the same rule as git apply in the sandbox). A context mismatch is an error.
//
// Files a recipe's prepare step generates (prepare_outputs) are known paths but have no bytes
// here; Core reports them as such instead of guessing.

export interface FileAtGen {
  path: string;
  exists: boolean;
  source: "snapshot" | "overlay" | "patched" | "prepare_output" | "absent";
  text: string | null;
  sha256: string | null;
  lines: number | null;
}

export interface TreeSource {
  /** Every file path of the tree at this generation, or null when the tree is not available here. */
  listFiles(recipe: Recipe, commit: string, patches: string[]): Set<string> | null;
  /** One file of the tree at this generation, or null when the tree is not available here. */
  file(recipe: Recipe, commit: string, patches: string[], path: string): FileAtGen | null;
}

export class TreeError extends Error {}

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function git(cwd: string, args: string[]): { ok: boolean; out: Uint8Array; err: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: p.exitCode === 0, out: p.stdout, err: p.stderr.toString() };
}

/** Applies the hunks of one file's diff to its text. Exact context, no fuzz. */
export function applyHunks(text: string | null, hunks: string[]): string {
  const hadFinalNewline = text === null ? true : text.endsWith("\n");
  const src = text === null || text === "" ? [] : (hadFinalNewline ? text.slice(0, -1) : text).split("\n");
  const out: string[] = [];
  let pos = 0; // index into src
  let newEndsWithoutNewline = false;
  let lastSign = "";
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]!;
    if (h.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h)!;
      const oldStart = Number(m[1]);
      const oldLen = m[2] === undefined ? 1 : Number(m[2]);
      const at = oldLen === 0 ? oldStart : oldStart - 1;
      if (at < pos || at > src.length) throw new TreeError(`hunk at line ${oldStart} out of order or past end`);
      while (pos < at) out.push(src[pos++]!);
      continue;
    }
    const sign = h[0];
    const body = h.slice(1);
    if (sign === " " || sign === "-") {
      if (src[pos] !== body) throw new TreeError(`context mismatch at line ${pos + 1}`);
      if (sign === " ") out.push(body);
      pos++;
      lastSign = sign;
    } else if (sign === "+") {
      out.push(body);
      lastSign = "+";
      newEndsWithoutNewline = false;
    } else if (sign === "\\") {
      // "\ No newline at end of file" refers to the line just before it
      if (lastSign === "+" || lastSign === " ") newEndsWithoutNewline = true;
    }
  }
  while (pos < src.length) out.push(src[pos++]!);
  if (out.length === 0) return "";
  const keepNoNewline = newEndsWithoutNewline || (!hadFinalNewline && lastSign !== "+");
  return out.join("\n") + (keepNoNewline ? "" : "\n");
}

/** The default source: the sandbox's local git mirrors plus recipe overlays in this checkout. */
export class GitTreeSource implements TreeSource {
  private lists = new Map<string, Set<string> | null>();
  private overlays = new Map<string, string | null>();

  /** The bare mirror for a repo if it exists locally (fixtures are built locally, never fetched). */
  private mirror(repo: string, commit: string): string | null {
    let dir: string;
    if (repo.startsWith("fixture:")) {
      try {
        dir = mirrorPath(repo);
      } catch {
        return null;
      }
    } else {
      dir = join(LINEAGE_HOME, "mirrors", sha256Hex(canonicalUrl(repo)).slice(0, 24) + ".git");
      if (!existsSync(dir)) return null;
    }
    return git(dir, ["cat-file", "-e", `${commit}^{commit}`]).ok ? dir : null;
  }

  /** recipes/<name>/overlay when its content digest equals the recipe's overlay_digest. */
  private overlayDir(recipe: Recipe): string | null {
    if (!recipe.overlay_digest) return null;
    const key = `${recipe.name}:${recipe.overlay_digest}`;
    if (this.overlays.has(key)) return this.overlays.get(key)!;
    const dir = join(REPO_ROOT, "recipes", recipe.name, "overlay");
    let ok: string | null = null;
    try {
      if (existsSync(dir) && overlayDigest(dir).digest === recipe.overlay_digest) ok = dir;
    } catch {
      ok = null;
    }
    this.overlays.set(key, ok);
    return ok;
  }

  private baseList(recipe: Recipe, commit: string): Set<string> | null {
    const key = `${recipe.repo}@${commit}:${recipe.overlay_digest ?? ""}`;
    if (this.lists.has(key)) return this.lists.get(key)!;
    const m = this.mirror(recipe.repo, commit);
    let out: Set<string> | null = null;
    if (m) {
      const r = git(m, ["ls-tree", "-r", "--name-only", "-z", commit]);
      if (r.ok) {
        out = new Set(new TextDecoder().decode(r.out).split("\0").filter(Boolean));
        const ov = this.overlayDir(recipe);
        if (ov) for (const f of overlayDigest(ov).files) out.add(f);
      }
    }
    // only cache successes, so a mirror created later is picked up
    if (out) this.lists.set(key, out);
    return out;
  }

  listFiles(recipe: Recipe, commit: string, patches: string[]): Set<string> | null {
    const base = this.baseList(recipe, commit);
    if (!base) return null;
    const files = new Set(base);
    for (const f of recipe.prepare_outputs ?? []) files.add(f);
    for (const p of patches) {
      for (const d of parseDiff(p)) {
        if (d.status === "delete" && d.oldPath) files.delete(d.oldPath);
        else files.add(filePath(d));
      }
    }
    return files;
  }

  file(recipe: Recipe, commit: string, patches: string[], path: string): FileAtGen | null {
    const m = this.mirror(recipe.repo, commit);
    if (!m) return null;
    const ov = this.overlayDir(recipe);
    let text: string | null = null;
    let source: FileAtGen["source"] = "absent";
    if (ov && existsSync(join(ov, path)) && resolve(ov, path).startsWith(ov + "/")) {
      text = readFileSync(join(ov, path), "utf8");
      source = "overlay";
    } else {
      const r = git(m, ["show", `${commit}:${path}`]);
      if (r.ok) {
        text = new TextDecoder().decode(r.out);
        source = "snapshot";
      }
    }
    let touched = false;
    for (const p of patches) {
      for (const d of parseDiff(p)) {
        if (filePath(d) !== path && d.oldPath !== path) continue;
        if (d.status === "delete") {
          text = null;
          touched = true;
          continue;
        }
        text = applyHunks(d.status === "add" ? null : text, d.hunks);
        touched = true;
      }
    }
    if (touched) source = text === null ? "absent" : "patched";
    if (text === null) {
      if ((recipe.prepare_outputs ?? []).includes(path)) return { path, exists: true, source: "prepare_output", text: null, sha256: null, lines: null };
      return { path, exists: false, source: "absent", text: null, sha256: null, lines: null };
    }
    const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { path, exists: true, source, text, sha256: sha256Hex(text), lines };
  }
}
