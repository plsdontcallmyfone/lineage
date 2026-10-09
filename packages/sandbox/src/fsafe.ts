import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";

// Host-side file access inside trees that untrusted code wrote (a repository checkout, a prepare or
// build container's output). Every helper here refuses symlinks on the WHOLE path, not only the last
// component, and touches only directories and regular files: a FIFO, socket or device is refused
// before it is opened in a blocking mode (audit A2, OFF-S1, OFF-S2, OFF-S5, OFF-S7).

/** A relative path with no empty, `.` or `..` segment and no backslash. */
export function isCleanRel(rel: string): boolean {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || rel.includes("\\") || rel.includes("\0")) return false;
  const parts = rel.replace(/\/+$/, "").split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * True when `root/rel` can be reached without following a symlink: every existing component is a
 * real directory (or, for the last one, a directory or a regular file). Missing components are fine.
 */
export function noSymlinkOnPath(root: string, rel: string): boolean {
  if (!isCleanRel(rel)) return false;
  const parts = rel.replace(/\/+$/, "").split("/");
  let p = root;
  for (let i = 0; i < parts.length; i++) {
    p = join(p, parts[i]!);
    const st = lstatOrNull(p);
    if (!st) return true;
    if (st.isSymbolicLink()) return false;
    if (i < parts.length - 1 && !st.isDirectory()) return false;
    if (i === parts.length - 1 && !st.isDirectory() && !st.isFile()) return false;
  }
  return true;
}

/**
 * Opens a file for reading only if it is a regular file: O_NOFOLLOW refuses a final symlink and
 * O_NONBLOCK keeps a FIFO from blocking the open (which froze the whole event loop). Returns the
 * fd and its stat, or null.
 */
export function openRegular(path: string): { fd: number; st: Stats } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    return null;
  }
  return { fd, st };
}

/** Reads `root/rel` if the whole path is free of symlinks, the file is regular and at most `cap` bytes. */
export function readInside(root: string, rel: string, cap: number): Buffer | null {
  if (!noSymlinkOnPath(root, rel)) return null;
  const o = openRegular(join(root, rel));
  if (!o) return null;
  try {
    if (o.st.size > cap) return null;
    const buf = Buffer.alloc(o.st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(o.fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(o.fd);
  }
}

/** sha256 of a regular file read in chunks (no 2 GiB readFileSync limit, constant memory). */
export function fileSha256(path: string): string {
  const o = openRegular(path);
  if (!o) throw new Error(`not a regular file: ${path}`);
  const h = createHash("sha256");
  const buf = Buffer.alloc(1 << 20);
  try {
    for (let pos = 0; ; ) {
      const n = readSync(o.fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    closeSync(o.fd);
  }
  return h.digest("hex");
}

/**
 * Copies `srcRoot/rel` (a file or a directory tree) to `destRoot/rel`. Refuses a symlink anywhere on
 * the source path or inside a copied directory, and anything that is not a directory or a regular
 * file. Also refuses a destination path that runs through a symlink.
 */
export function copyConfined(srcRoot: string, rel: string, destRoot: string): void {
  if (!isCleanRel(rel)) throw new Error(`unsafe path ${JSON.stringify(rel)}`);
  if (!noSymlinkOnPath(srcRoot, rel)) throw new Error(`${rel} runs through a symlink or is not a regular file`);
  if (!noSymlinkOnPath(destRoot, rel)) throw new Error(`destination ${rel} runs through a symlink`);
  const copy = (src: string, dest: string) => {
    const st = lstatSync(src);
    if (st.isSymbolicLink()) throw new Error(`symlink in copied tree: ${src}`);
    const d = lstatOrNull(dest);
    if (d && (d.isSymbolicLink() || (!d.isDirectory() && !d.isFile()))) throw new Error(`destination is a symlink or special file: ${dest}`);
    if (st.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      for (const e of readdirSync(src)) copy(join(src, e), join(dest, e));
    } else if (st.isFile()) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } else throw new Error(`not a regular file or directory: ${src}`);
  };
  const src = join(srcRoot, rel);
  if (!lstatOrNull(src)) throw new Error(`${rel} does not exist`);
  copy(src, join(destRoot, rel));
}
