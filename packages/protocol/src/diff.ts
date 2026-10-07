import { H, sha256Hex } from "./hash.ts";
import type { Hex } from "./types.ts";

// Canonical diff format and parser, SPEC section 7.3.

export interface FileDiff {
  oldPath: string | null; // null for added files
  newPath: string | null; // null for deleted files
  status: "modify" | "add" | "delete" | "rename";
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  /** Hunk text: "@@" headers and body lines, without trailing newlines. */
  hunks: string[];
  added: number;
  removed: number;
}

export class DiffParseError extends Error {}

function stripPrefix(p: string, prefix: "a/" | "b/"): string | null {
  if (p === "/dev/null") return null;
  if (p.startsWith('"')) p = JSON.parse(p);
  return p.startsWith(prefix) ? p.slice(2) : p;
}

/** Parses `git diff` output (with or without index lines). */
export function parseDiff(text: string): FileDiff[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let inHunk = false;
  let oldLeft = 0;
  let newLeft = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      if (inHunk && (oldLeft !== 0 || newLeft !== 0)) throw new DiffParseError("truncated hunk");
      const m = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(line);
      if (!m) throw new DiffParseError(`bad diff header: ${line}`);
      cur = {
        oldPath: stripPrefix(m[1]!, "a/"),
        newPath: stripPrefix(m[2]!, "b/"),
        status: "modify",
        binary: false,
        hunks: [],
        added: 0,
        removed: 0,
      };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) {
      if (line.trim() === "") continue;
      throw new DiffParseError(`content before first file header: ${line}`);
    }
    if (inHunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === " ") {
        oldLeft--;
        newLeft--;
      } else if (c === "-") {
        oldLeft--;
        cur.removed++;
      } else if (c === "+") {
        newLeft--;
        cur.added++;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"
      } else if (line === "") {
        // some tools drop the leading space on empty context lines
        oldLeft--;
        newLeft--;
        cur.hunks.push(" ");
        continue;
      } else {
        throw new DiffParseError(`bad hunk line: ${line}`);
      }
      if (oldLeft < 0 || newLeft < 0) throw new DiffParseError("hunk longer than header");
      cur.hunks.push(line);
      continue;
    }
    if (line.startsWith("\\") && inHunk) {
      cur.hunks.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new DiffParseError(`bad hunk header: ${line}`);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      inHunk = true;
      cur.hunks.push(line);
      continue;
    }
    inHunk = false;
    if (line.startsWith("new file mode ")) {
      cur.status = "add";
      cur.newMode = line.slice(14);
      cur.oldPath = null;
    } else if (line.startsWith("deleted file mode ")) {
      cur.status = "delete";
      cur.oldMode = line.slice(18);
      cur.newPath = null;
    } else if (line.startsWith("old mode ")) cur.oldMode = line.slice(9);
    else if (line.startsWith("new mode ")) cur.newMode = line.slice(9);
    else if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy ")) {
      cur.status = "rename";
    } else if (line.startsWith("similarity index") || line.startsWith("dissimilarity index") || line.startsWith("index ")) {
      if (line.startsWith("index ")) {
        const mode = /^index \S+ (\d{6})$/.exec(line);
        if (mode) {
          cur.oldMode ??= mode[1];
          cur.newMode ??= mode[1];
        }
      }
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      cur.binary = true;
    } else if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4).replace(/\t.*$/, ""), "a/");
      if (cur.status !== "add" && p !== null) cur.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4).replace(/\t.*$/, ""), "b/");
      if (cur.status !== "delete" && p !== null) cur.newPath = p;
    } else if (cur.binary) {
      // binary patch payload lines
    } else {
      throw new DiffParseError(`unexpected line: ${line}`);
    }
  }
  if (inHunk && (oldLeft !== 0 || newLeft !== 0)) throw new DiffParseError("truncated hunk");
  return files;
}

export const filePath = (f: FileDiff): string => (f.newPath ?? f.oldPath)!;

/** Emits the canonical byte string that patch_hash covers. */
export function canonicalizeDiff(text: string): string {
  const files = parseDiff(text);
  files.sort((x, y) => (filePath(x) < filePath(y) ? -1 : filePath(x) > filePath(y) ? 1 : 0));
  let out = "";
  for (const f of files) {
    const a = f.oldPath ?? filePath(f);
    const b = f.newPath ?? filePath(f);
    out += `diff --git a/${a} b/${b}\n`;
    if (f.status === "add") out += `new file mode ${f.newMode ?? "100644"}\n`;
    else if (f.status === "delete") out += `deleted file mode ${f.oldMode ?? "100644"}\n`;
    else if (f.oldMode && f.newMode && f.oldMode !== f.newMode) out += `old mode ${f.oldMode}\nnew mode ${f.newMode}\n`;
    if (f.status === "rename") out += `rename from ${f.oldPath}\nrename to ${f.newPath}\n`;
    if (f.binary) {
      out += `Binary files a/${a} and b/${b} differ\n`;
      continue;
    }
    if (f.hunks.length === 0) continue;
    out += `--- ${f.oldPath === null ? "/dev/null" : "a/" + f.oldPath}\n`;
    out += `+++ ${f.newPath === null ? "/dev/null" : "b/" + f.newPath}\n`;
    for (const h of f.hunks) out += h + "\n";
  }
  return out;
}

export const patchHash = (canonical: string): Hex => H("patch", sha256Hex(canonical));

/** Whitespace-insensitive identity of a change, to spot re-skinned duplicates. */
export function semanticHash(canonical: string): Hex {
  const files = parseDiff(canonical).map((f) => ({
    path: filePath(f),
    removed: f.hunks.filter((l) => l.startsWith("-")).map((l) => l.slice(1).replace(/\s+/g, "")).filter(Boolean),
    added: f.hunks.filter((l) => l.startsWith("+")).map((l) => l.slice(1).replace(/\s+/g, "")).filter(Boolean),
  }));
  return H("semantic", JSON.stringify(files));
}
