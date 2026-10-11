// ensureFork with an owner other than the token's login (the units-agents organization) and the
// same-named-upstream collision (docs/plans/GITHUB-ORG.md 3).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, ensureFork } from "../src/github.ts";
import { MockGitHub } from "./mockgh.ts";

let root: string;
let gh: MockGitHub;
const T = (gh: MockGitHub) => ({ apiBase: gh.api, gitBase: gh.root, fetch: gh.fetch, sleep: async () => {} });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "units-forkowner-"));
  gh = new MockGitHub(root);
  gh.users.push({ login: "pub", id: 7, token: "tok-pub", signingKey: "" });
  gh.createRepo("keis/base58", { "a.py": "x\n" });
  gh.createRepo("debris/base58", { "a.rs": "y\n" });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("forks into the organization, then reuses the fork", async () => {
  const c = client("tok-pub", T(gh));
  const a = await ensureFork(c, "units-agents", "keis/base58", T(gh), { organization: true });
  expect(a).toEqual({ fork: "units-agents/base58", created: true });
  const post = c.writes.find((w) => w.method === "POST")!;
  expect(post.body).toEqual({ default_branch_only: true, organization: "units-agents" });
  const again = await ensureFork(c, "units-agents", "keis/base58", T(gh), { organization: true });
  expect(again).toEqual({ fork: "units-agents/base58", created: false });
});

test("a second upstream with the same name gets <owner>-<repo>", async () => {
  const c = client("tok-pub", T(gh));
  const b = await ensureFork(c, "units-agents", "debris/base58", T(gh), { organization: true });
  expect(b).toEqual({ fork: "units-agents/debris-base58", created: true });
  expect(c.writes.find((w) => w.method === "POST")!.body).toEqual({ default_branch_only: true, organization: "units-agents", name: "debris-base58" });
  // both stay stable on later passes
  expect((await ensureFork(c, "units-agents", "debris/base58", T(gh), { organization: true })).fork).toBe("units-agents/debris-base58");
  expect((await ensureFork(c, "units-agents", "keis/base58", T(gh), { organization: true })).fork).toBe("units-agents/base58");
});

test("a user-account fork without organization keeps the old behaviour", async () => {
  const c = client("tok-pub", T(gh));
  const r = await ensureFork(c, "pub", "keis/base58", T(gh));
  expect(r).toEqual({ fork: "pub/base58", created: true });
  expect(c.writes.find((w) => w.method === "POST")!.body).toEqual({ default_branch_only: true });
});
