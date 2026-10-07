import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./protocol.ts";

// Content-addressed blob store: <root>/<first two hex chars>/<sha256>. A blob is written only if
// its bytes hash to the name it is stored under, so a digest reference is always self-verifying.

const HEX64 = /^[0-9a-f]{64}$/;

export class BlobStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  static isDigest(s: string): boolean {
    return HEX64.test(s);
  }

  path(digest: string): string {
    if (!HEX64.test(digest)) throw new Error("invalid digest");
    return join(this.root, digest.slice(0, 2), digest);
  }

  has(digest: string): boolean {
    return HEX64.test(digest) && existsSync(this.path(digest));
  }

  size(digest: string): number | null {
    return this.has(digest) ? statSync(this.path(digest)).size : null;
  }

  /** Stores bytes under their digest. Returns false when the bytes do not hash to `digest`. */
  put(digest: string, bytes: Uint8Array): { ok: boolean; actual: string; created: boolean } {
    const actual = sha256Hex(bytes);
    if (actual !== digest) return { ok: false, actual, created: false };
    const p = this.path(digest);
    if (existsSync(p)) return { ok: true, actual, created: false };
    mkdirSync(join(this.root, digest.slice(0, 2)), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, p);
    return { ok: true, actual, created: true };
  }

  get(digest: string): Uint8Array | null {
    return this.has(digest) ? readFileSync(this.path(digest)) : null;
  }
}
