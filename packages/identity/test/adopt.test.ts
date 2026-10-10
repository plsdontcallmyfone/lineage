import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adopt } from "../src/adopt.ts";
import type { AgentState, CredRecord } from "../src/records.ts";
import { EncryptedStore, ensureKeyFile } from "../src/store.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function store() {
  const d = mkdtempSync(join(tmpdir(), "lineage-adopt-"));
  dirs.push(d);
  ensureKeyFile(join(d, "master.key"));
  return new EncryptedStore(join(d, "data"), join(d, "master.key"));
}
const A = "6C8N2z5LwktukWEP6g8sUnf9ky1L9rxyngBLbdomUzHc", B = "5iCWSoXAsvhdDiwsexnuAXU3RcNXgbXw7TzuRZH2LYoA", M = "CiBfnTkDc1vgYbuMobMNEQaKSQXPYeTUbZGRZcug1L62";
const base = { mint: M, launcher: B, repo: "https://github.com/karpathy/minbpe", launched_at: 1_791_700_000 };
const cred = { login: "acct1", github_id: 7, token: "ghp_test", ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n",
  ssh_public_key: "ssh-ed25519 AAAA test", ssh_signing_key_id: 9, assigned_at: "2026-10-08T00:00:00Z" };
const gh = (login: string) => (async () => Response.json({ login })) as unknown as typeof fetch;

describe("adopt (devnet v2 relaunch)", () => {
  test("import: the token must answer for the login; the agent is ready (purchased) before its launch is seen", async () => {
    const s = store();
    await expect(adopt(s, { agent: A, ...base, cred }, { fetch: gh("someone-else") })).rejects.toThrow(/another account/);
    expect(s.get("cred", A)).toBeNull();
    const r = await adopt(s, { agent: A, ...base, cred }, { fetch: gh("acct1") });
    expect(r).toEqual({ agent: A, login: "acct1", github_id: 7, status: "ready", how: "import", from_agent: null });
    expect(s.get<CredRecord>("cred", A)).toMatchObject({ agent: A, login: "acct1", mode: "purchased", ssh_signing_key_id: 9 });
    expect(s.get<AgentState>("state", A)).toMatchObject({ status: "ready", mode: "purchased", login: "acct1", mint: M });
    expect(JSON.stringify(r)).not.toContain("ghp_test");
  });

  test("rekey: a new agent id keeps the earlier agent's account; the earlier state stays; one account never serves two other agents", async () => {
    const s = store();
    await adopt(s, { agent: A, ...base, cred }, { fetch: gh("acct1") });
    const NEW = "Axo38WX6TBAGGQ2nPpejn5tPsQogygA728baRaeJebGX";
    const r = await adopt(s, { agent: NEW, ...base, from_agent: A });
    expect(r).toMatchObject({ agent: NEW, login: "acct1", how: "rekey", from_agent: A });
    expect(s.get<CredRecord>("cred", NEW)).toMatchObject({ agent: NEW, login: "acct1", token: "ghp_test" });
    expect(s.get<AgentState>("state", A)!.status).toBe("ready");
    await expect(adopt(s, { agent: B, ...base, from_agent: A })).rejects.toThrow(/already the account of/);
    await expect(adopt(s, { agent: B, ...base })).rejects.toThrow(/exactly one/);
  });
});
