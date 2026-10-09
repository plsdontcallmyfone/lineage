import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { github } from "../src/index.ts";

// Offchain audit A2 (docs/AUDIT.md, Offchain): GitHub token handling in the souls package.

const tmp = mkdtempSync(join(tmpdir(), "lineage-a2-souls-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const T = "ghp_" + "Q".repeat(36);
const cred = { v: 1, agent: "a", login: "acct", github_id: 9, token: T, ssh_private_key_path: join(tmp, "k"), ssh_public_key: "ssh-ed25519 X", ssh_signing_key_id: 1, assigned_at: "" } as never;

/** GitHub API stand-in: the account already owns a repository named like the upstream, not a fork. */
const ownRepo = async (url: string) => {
  const p = new URL(url).pathname;
  if (p === "/repos/acct/proj") return new Response(JSON.stringify({ full_name: "acct/proj", fork: false, size: 10 }), { status: 200 });
  return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
};

test("OFF-G1 the git Authorization header value is redacted in any casing", () => {
  const basic = Buffer.from(`x-access-token:${T}`).toString("base64");
  const line = `trace: http.extraheader AUTHORIZATION: basic ${basic}`;
  expect(github.redactTokens(line)).not.toContain(basic);
  expect(github.redactTokens(`header Authorization: Bearer abc.def-ghi`)).toBe("header Authorization: Bearer <redacted>");
  expect(github.redactTokens(`stray ${basic}`)).not.toContain(basic);
});

test("OFF-G2 a signed commit never pushes into an existing repository that is not the upstream's fork", async () => {
  await expect(
    github.signedCommit({ cred, upstream: "up/proj", branch: "lineage/x", files: { "a.txt": "x" }, message: "m", gitBase: `file://${join(tmp, "none")}`, fetch: ownRepo as never }),
  ).rejects.toThrow(/not a fork/);
});

test("OFF-G2 signed commit file paths cannot escape the tree or touch .git", async () => {
  for (const bad of ["../x", "/etc/x", ".git/config", "a/.GIT/hooks/pre-commit", "a/../../b", "./a"]) {
    await expect(
      github.signedCommit({ cred, upstream: "up/proj", branch: "lineage/x", files: { [bad]: "x" }, message: "m", gitBase: `file://${join(tmp, "none")}`, fetch: ownRepo as never }),
    ).rejects.toThrow(/unsafe file path/);
  }
});
