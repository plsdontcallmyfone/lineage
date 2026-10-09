// Encrypted credential store of the identity service (plan AUDIT-AND-IDENTITY B, SPEC 13.9).
//
// Layout (on the site: /var/lib/lineage/identity, mode 700, owned by the dedicated user
// `lineage-identity`):
//   <dir>/records/<kind>/<id>.enc   one record per file, mode 600, JSON { v, alg, iv, tag, ct }
//   key file (separate path)        32 random bytes, mode 600 (or 400), readable only by that user
//
// Every record is AES-256-GCM encrypted under the key file with a fresh 96-bit IV, and the record's
// own name ("<kind>/<id>") is the additional authenticated data, so a record copied over another
// id, a flipped byte or a truncated file all fail to decrypt instead of being read. Plaintext never
// touches the disk: writes go to a temporary file in the same directory (ciphertext only) and are
// renamed into place. Tokens are never logged and no API returns them; see service.ts.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class StoreError extends Error {}

/** Makes a new 32-byte key file (mode 600) when none exists; never overwrites one. */
export function ensureKeyFile(path: string): { created: boolean } {
  if (existsSync(path)) {
    checkKeyFile(path);
    return { created: false };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return { created: true };
}

function checkKeyFile(path: string): Buffer {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new StoreError(`key file ${path} is mode ${mode.toString(8)}; it must be readable by its owner only`);
  const k = readFileSync(path);
  if (k.length !== 32) throw new StoreError(`key file ${path} must hold exactly 32 bytes`);
  return k;
}

export class EncryptedStore {
  private readonly key: Buffer;
  readonly dir: string;

  constructor(dir: string, keyFile: string) {
    this.dir = dir;
    this.key = checkKeyFile(keyFile);
    this.ensure(dir);
    this.ensure(join(dir, "records"));
  }

  private ensure(d: string) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }

  private path(kind: string, id: string): string {
    if (!KIND.test(kind)) throw new StoreError(`bad record kind ${JSON.stringify(kind)}`);
    if (!ID.test(id)) throw new StoreError(`bad record id ${JSON.stringify(id.slice(0, 40))}`);
    return join(this.dir, "records", kind, `${id}.enc`);
  }

  put(kind: string, id: string, value: unknown) {
    const p = this.path(kind, id);
    this.ensure(dirname(p));
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(`${kind}/${id}`));
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(value), "utf8")), c.final()]);
    const rec = { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(rec) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  }

  get<T = unknown>(kind: string, id: string): T | null {
    const p = this.path(kind, id);
    if (!existsSync(p)) return null;
    const mode = statSync(p).mode & 0o777;
    if (mode & 0o077) throw new StoreError(`record ${kind}/${id} is mode ${mode.toString(8)}; it must be 600`);
    let rec: { v: number; alg: string; iv: string; tag: string; ct: string };
    try {
      rec = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      throw new StoreError(`record ${kind}/${id} is not readable (corrupt)`);
    }
    if (rec.v !== 1 || rec.alg !== "aes-256-gcm") throw new StoreError(`record ${kind}/${id} has an unknown format`);
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(rec.iv, "base64"));
      d.setAAD(Buffer.from(`${kind}/${id}`));
      d.setAuthTag(Buffer.from(rec.tag, "base64"));
      const pt = Buffer.concat([d.update(Buffer.from(rec.ct, "base64")), d.final()]);
      return JSON.parse(pt.toString("utf8")) as T;
    } catch {
      throw new StoreError(`record ${kind}/${id} failed authentication (tampered, moved, or a different key)`);
    }
  }

  has(kind: string, id: string): boolean {
    return existsSync(this.path(kind, id));
  }

  delete(kind: string, id: string): boolean {
    const p = this.path(kind, id);
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  }

  /** Ids of every record of one kind (sorted). */
  list(kind: string): string[] {
    if (!KIND.test(kind)) throw new StoreError(`bad record kind ${JSON.stringify(kind)}`);
    const d = join(this.dir, "records", kind);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".enc"))
      .map((f) => f.slice(0, -4))
      .sort();
  }
}
