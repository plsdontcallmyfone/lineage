import { chmodSync, closeSync, constants, fsyncSync, openSync, renameSync, writeSync } from "node:fs";

// Files holding secrets (agent keys) or sealed state (salts and unrevealed results) are created
// with mode 0600 from the first byte: a write followed by chmod left a 0644 window, and a plain
// writeFileSync kept whatever mode the file was first created with (audit A2, OFF-K2).

/** Creates `path` with mode 0600; fails if it exists (never overwrites a key). */
export function writeNewSecret(path: string, data: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replaces `path` atomically with a 0600 file (temp file, then rename). */
export function writeSecret(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
