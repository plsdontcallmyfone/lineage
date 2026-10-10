import { describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateKeypair } from "@lineage/chain";
import { EncryptedStore, ensureKeyFile } from "../../packages/identity/src/store.ts";
import { compare, facts, IDENTITY_DIR, IDENTITY_KEY, RUNTIME_KEYS, SITE_KEYS_DIR, type IdentityFacts, type StateFacts } from "./backup-facts.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "backup-facts-"));
  const ids: string[] = [];
  for (let k = 0; k < 2; k++) {
    const tmp = join(root, RUNTIME_KEYS, `tmp${k}.json`);
    const { key } = loadOrCreateKeypair(tmp);
    renameSync(tmp, join(root, RUNTIME_KEYS, `${key.id}.json`));
    ids.push(key.id);
  }
  loadOrCreateKeypair(join(root, SITE_KEYS_DIR, "admin.json"));
  ensureKeyFile(join(root, IDENTITY_KEY));
  const store = new EncryptedStore(join(root, IDENTITY_DIR), join(root, IDENTITY_KEY));
  store.put("published", "agent1", { secret: "never shown" });
  store.put("cycle", "last", { n: 1 });
  return { root, ids };
}

describe("backup facts", () => {
  test("state facts are public keys only, by file name", () => {
    const { root, ids } = fixture();
    const f = facts("state", root) as StateFacts;
    expect(Object.keys(f.runtime_keys).sort()).toEqual([...ids].sort());
    for (const [n, p] of Object.entries(f.runtime_keys)) expect(p).toBe(n);
    expect(Object.keys(f.site_keys)).toEqual(["admin"]);
    expect(JSON.stringify(f)).not.toMatch(/\[\d/); // no secret key byte arrays
  });
  test("identity facts: key hash, records, every record authenticates; contents never appear", () => {
    const { root } = fixture();
    const f = facts("identity", root) as IdentityFacts;
    expect(f.records).toEqual(["cycle/last", "published/agent1"]);
    expect(f.authenticated).toBe(2);
    expect(f.key_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(f)).not.toContain("never shown");
  });
  test("compare: equal passes; a different key or a lost key fails; newer live keys are noted", () => {
    const a = fixture(), b = fixture();
    const sa = facts("state", a.root);
    expect(compare(sa, sa).ok).toBe(true);
    expect(compare(sa, facts("state", b.root)).ok).toBe(false);
    const live = facts("state", a.root) as StateFacts;
    live.runtime_keys.Extra = "Extra";
    const r = compare(sa, live);
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("1 live key(s) made after the snapshot");
    const lost = facts("state", a.root) as StateFacts;
    delete lost.runtime_keys[a.ids[0]!];
    expect(compare(sa, lost).ok).toBe(false);
  });
  test("compare identity: another key file fails; a tampered record fails", () => {
    const a = fixture(), b = fixture();
    const ia = facts("identity", a.root);
    expect(compare(ia, ia).ok).toBe(true);
    expect(compare(ia, facts("identity", b.root)).ok).toBe(false);
    writeFileSync(join(a.root, IDENTITY_DIR, "records", "cycle", "last.enc"), JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: "AAAAAAAAAAAAAAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==", ct: "AAAA" }), { mode: 0o600 });
    const t = facts("identity", a.root) as IdentityFacts;
    expect(t.authenticated).toBe(1);
    expect(compare(t, t).ok).toBe(false);
  });
});
