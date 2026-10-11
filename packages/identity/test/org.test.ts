import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, signStatement } from "@units/protocol";
import { keypair } from "../../mirror/test/mockgh.ts";
import { MAX_ATTEMPTS, OrgMembership } from "../src/org.ts";
import { IdentityService } from "../src/service.ts";
import { checkStatement, PURPOSE, tokenSha256 } from "../src/statement.ts";
import { EncryptedStore, ensureKeyFile } from "../src/store.ts";
import { MockOrgGitHub } from "./mockorg.ts";

// Joining the units-agents organization (docs/plans/GITHUB-ORG.md 2) against a mocked GitHub that
// follows the REST docs: invite by an org owner, accept and publicize with the member's own token.

const tmp = mkdtempSync(join(tmpdir(), "units-org-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const ORG = "units-agents";

function world(name: string) {
  const gh = new MockOrgGitHub(join(tmp, name, "host"));
  gh.addOrg(ORG, "pub");
  ensureKeyFile(join(tmp, name, "key"));
  const store = new EncryptedStore(join(tmp, name, "store"), join(tmp, name, "key"));
  const svc = new IdentityService({
    store, runDir: join(tmp, name, "run"), chain: { launches: async () => [], agentLaunch: async () => null, agent: async () => null }, soul: async () => null, site: null, since: 0,
    apiBase: gh.api, fetch: gh.fetch, org: ORG,
  });
  const pubKey = keypair(join(tmp, name), "pubkey");
  gh.users.push({ login: "pub", id: 1, token: "tok-pub", signingKey: "" });
  gh.scopes.set("pub", ["admin:org", "repo", "admin:ssh_signing_key"]);
  store.put("publisher", "app", { v: 1, login: "pub", github_id: 1, token: "tok-pub", ssh_private_key: "", ssh_public_key: pubKey.publicKey, ssh_signing_key_id: 1, scopes: null, set_at: "" });
  const slept: number[] = [];
  let now = Date.UTC(2026, 9, 11, 15);
  const org = new OrgMembership({ svc, now: () => new Date(now), sleep: async (ms) => void slept.push(ms) });
  const agent = (login: string, id: number, mode: "purchased" | "token", scopes: string[] | null, joinOrg?: boolean) => {
    const a = generateAgentKey().id;
    gh.users.push({ login, id, token: `tok-${login}`, signingKey: "" });
    if (scopes) gh.scopes.set(login, scopes);
    store.put("cred", a, { v: 1, agent: a, mode, login, github_id: id, token: `tok-${login}`, ssh_private_key: "", ssh_public_key: "ssh-ed25519 AAAA", ssh_signing_key_id: null, assigned_at: "" });
    store.put("state", a, { v: 1, agent: a, mint: generateAgentKey().id, launcher: "", repo: "https://github.com/up/fx", mode, status: "ready", reason: null, login, github_id: id, ssh_public_key: null, scopes: null, token_kind: null, expires_at: null, launched_at: 0, first_seen_at: "", updated_at: "", attempts: 0, last_statement_at: 0, history: [], ...(joinOrg === undefined ? {} : { join_org: joinOrg }) });
    return a;
  };
  return { gh, svc, org, agent, slept, advance: (ms: number) => void (now += ms) };
}

test("a purchased account is invited, accepts and becomes a public member; a second pass writes nothing", async () => {
  const w = world("happy");
  const a = w.agent("agwyus9p", 11, "purchased", ["admin:org", "repo"]);
  const r = await w.org.join(a);
  expect(r).toMatchObject({ status: "joined", public: true, login: "agwyus9p", step: "done" });
  expect(w.gh.orgs.get(ORG)!.members.get("agwyus9p")).toEqual({ role: "member", state: "active" });
  expect([...w.gh.orgs.get(ORG)!.public]).toEqual(["agwyus9p"]);
  const writes = w.gh.orgCalls.filter((c) => !c.startsWith("GET"));
  expect(writes).toEqual([`PUT /orgs/${ORG}/memberships/agwyus9p as pub`, `PATCH /user/memberships/orgs/${ORG} as agwyus9p`, `PUT /orgs/${ORG}/public_members/agwyus9p as agwyus9p`]);
  // idempotent, also with force: GitHub already shows every effect
  w.gh.orgCalls.length = 0;
  expect((await w.org.join(a, { force: true })).status).toBe("joined");
  expect(w.gh.orgCalls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  expect(w.svc.view(a).org).toMatchObject({ name: ORG, status: "joined", public: true });
});

test("an account that is already an active member is only made public", async () => {
  const w = world("member");
  const a = w.agent("nbebp7jy", 12, "purchased", ["admin:org"]);
  w.gh.orgs.get(ORG)!.members.set("nbebp7jy", { role: "member", state: "active" });
  expect((await w.org.join(a)).status).toBe("joined");
  expect(w.gh.orgCalls.filter((c) => !c.startsWith("GET"))).toEqual([`PUT /orgs/${ORG}/public_members/nbebp7jy as nbebp7jy`]);
});

test("missing scopes are reported and nothing is sent", async () => {
  const w = world("scopes");
  const a = w.agent("lowscope", 13, "purchased", ["repo", "write:ssh_signing_key"]);
  const r = await w.org.join(a);
  expect(r.status).toBe("scope_missing");
  expect(r.reason).toContain("write:org");
  expect(w.gh.orgCalls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  // the publisher without admin:org
  const w2 = world("pubscope");
  w2.gh.scopes.set("pub", ["repo"]);
  const b = w2.agent("okscope", 14, "purchased", ["admin:org"]);
  const r2 = await w2.org.join(b);
  expect(r2).toMatchObject({ status: "scope_missing", step: "invite" });
  expect(r2.reason).toContain("admin:org");
  // the tick does not retry a scope problem
  expect(await w2.org.tick()).toBe(0);
});

test("a fine-grained token (no scope header) refused by GitHub is reported as a missing permission", async () => {
  const w = world("fine");
  const a = w.agent("finegrained", 15, "purchased", null);
  w.gh.failNext.set(`PATCH /user/memberships/orgs/${ORG}`, { status: 403, message: "Resource not accessible by personal access token", count: 1 });
  const r = await w.org.join(a);
  expect(r).toMatchObject({ status: "scope_missing", step: "accept" });
  expect(r.reason).toContain("organization Members: write");
});

test("pasted-token accounts join only with the launcher's opt-in", async () => {
  const w = world("optin");
  const off = w.agent("launcherA", 16, "token", ["write:org", "repo"]);
  const on = w.agent("launcherB", 17, "token", ["write:org", "repo"], true);
  expect((await w.org.afterReady(off))).toBeNull();
  expect(w.gh.orgs.get(ORG)!.members.has("launchera")).toBe(false);
  expect((await w.org.join(off)).status).toBe("not_eligible");
  expect((await w.org.afterReady(on))!.status).toBe("joined");
  expect(w.svc.view(on).join_org).toBe(true);
  expect(w.svc.view(off).join_org).toBe(false);
});

test("the opt-in rides on the signed token statement", () => {
  const key = generateAgentKey();
  const now = 1_800_000_000;
  const base = { v: 1, kind: "lineage-identity-token", agent: generateAgentKey().id, mint: generateAgentKey().id, signer: key.id, token_sha256: tokenSha256("ghp_x"), created_at: now };
  expect(checkStatement(base, signStatement(key, PURPOSE, base), "lineage-identity-token", now)).toBeNull();
  const opt = { ...base, join_org: true };
  expect(checkStatement(opt, signStatement(key, PURPOSE, opt), "lineage-identity-token", now)).toBeNull();
  // the flag is covered by the signature
  expect(checkStatement({ ...opt, join_org: false }, signStatement(key, PURPOSE, opt), "lineage-identity-token", now)).toContain("signature");
  const bad = { ...base, join_org: "yes" };
  expect(checkStatement(bad, signStatement(key, PURPOSE, bad), "lineage-identity-token", now)).toContain("join_org");
  const rv = { v: 1, kind: "lineage-identity-revoke", agent: base.agent, mint: base.mint, signer: key.id, created_at: now, join_org: true };
  expect(checkStatement(rv, signStatement(key, PURPOSE, rv), "lineage-identity-revoke", now)).toContain("fields");
});

test("transient failures retry in place, then back off across passes up to the cap", async () => {
  const w = world("retry");
  const a = w.agent("flaky", 18, "purchased", ["admin:org"]);
  // two 502s are absorbed by the in-place retries
  w.gh.failNext.set(`PUT /orgs/${ORG}/memberships/flaky`, { status: 502, message: "Bad Gateway", count: 2 });
  expect((await w.org.join(a)).status).toBe("joined");
  expect(w.slept).toEqual([2000, 4000]);
  // a persistent rate limit: failed with backoff 5 min, then 10 min
  const b = w.agent("limited", 19, "purchased", ["admin:org"]);
  w.gh.failNext.set(`PUT /orgs/${ORG}/memberships/limited`, { status: 403, message: "API rate limit exceeded", count: 6 });
  const r1 = await w.org.join(b);
  expect(r1).toMatchObject({ status: "failed", step: "invite", attempts: 1 });
  expect(await w.org.tick()).toBe(0); // inside the backoff
  w.advance(5 * 60 * 1000);
  expect(await w.org.tick()).toBe(1);
  expect(w.org.record(b)).toMatchObject({ status: "failed", attempts: 2 });
  w.advance(10 * 60 * 1000);
  expect(await w.org.tick()).toBe(1);
  expect(w.org.record(b)!.status).toBe("joined");
  // the cap
  const c = w.agent("dead", 20, "purchased", ["admin:org"]);
  w.gh.failNext.set(`PUT /orgs/${ORG}/memberships/dead`, { status: 500, message: "boom", count: 1000 });
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await w.org.join(c);
    w.advance(7 * 60 * 60 * 1000);
  }
  expect(w.org.record(c)!.attempts).toBe(MAX_ATTEMPTS);
});

test("org-status lists the publisher's role and the public members", async () => {
  const w = world("status");
  const a = w.agent("owunqwxs", 21, "purchased", ["admin:org"]);
  await w.org.join(a);
  const s = await w.org.status();
  expect(s.publisher).toMatchObject({ login: "pub", role: "admin", state: "active" });
  expect(s.public_members).toEqual(["owunqwxs"]);
});
