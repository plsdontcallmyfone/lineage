import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, signStatement, type AgentKey } from "@lineage/protocol";
import type { AgentLaunch, AgentRecord } from "../../chain/src/index.ts";
import { soul as fixtureSoul } from "../../souls/test/fixtures.ts";
import { handler } from "../src/http.ts";
import { redact, safeLog } from "../src/redact.ts";
import { HttpError, IdentityService } from "../src/service.ts";
import { PURPOSE, tokenSha256, type RevokeStatement, type TokenStatement } from "../src/statement.ts";
import { EncryptedStore, ensureKeyFile, StoreError } from "../src/store.ts";

const tmp = mkdtempSync(join(tmpdir(), "lineage-identity-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function newStore() {
  const d = join(tmp, `s${++n}`);
  const key = join(d, "key", "master.key");
  ensureKeyFile(key);
  return { store: new EncryptedStore(join(d, "data"), key), dir: join(d, "data"), key, run: join(d, "run") };
}
const tok = (c: string) => `ghp_${c.repeat(36).slice(0, 36)}`;

function walk(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
}

describe("encrypted store", () => {
  test("round trip, file modes, and no plaintext on disk", () => {
    const { store, dir, key } = newStore();
    const secret = tok("A");
    store.put("reserve", "acct1", { login: "acct1", token: secret, note: "plain marker zebra" });
    expect(store.get<any>("reserve", "acct1").token).toBe(secret);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of walk(dir)) {
      expect(statSync(f).mode & 0o777).toBe(0o600);
      const raw = readFileSync(f, "utf8");
      expect(raw.includes(secret)).toBe(false);
      expect(raw.includes("zebra")).toBe(false);
      expect(raw.includes("acct1\"")).toBe(false);
    }
    expect(store.list("reserve")).toEqual(["acct1"]);
  });

  test("tamper detection: flipped byte, swapped record, wrong key, loose mode", () => {
    const { store, dir, key } = newStore();
    store.put("cred", "a1", { token: tok("B") });
    store.put("cred", "a2", { token: tok("C") });
    const p1 = join(dir, "records/cred/a1.enc");
    const p2 = join(dir, "records/cred/a2.enc");
    // a record copied over another id fails (the id is authenticated data)
    writeFileSync(p2, readFileSync(p1));
    expect(() => store.get("cred", "a2")).toThrow(StoreError);
    // a flipped ciphertext byte fails
    const rec = JSON.parse(readFileSync(p1, "utf8"));
    const ct = Buffer.from(rec.ct, "base64");
    ct[0]! ^= 1;
    writeFileSync(p1, JSON.stringify({ ...rec, ct: ct.toString("base64") }), { mode: 0o600 });
    expect(() => store.get("cred", "a1")).toThrow(/failed authentication/);
    // another key cannot read
    const other = newStore();
    store.put("cred", "a3", { token: tok("D") });
    const s2 = new EncryptedStore(dir, other.key);
    expect(() => s2.get("cred", "a3")).toThrow(/failed authentication/);
    // a world-readable record or key is refused
    chmodSync(join(dir, "records/cred/a3.enc"), 0o644);
    expect(() => store.get("cred", "a3")).toThrow(/mode/);
    chmodSync(key, 0o644);
    expect(() => new EncryptedStore(dir, key)).toThrow(/mode/);
  });

  test("ids and kinds are validated (no path traversal)", () => {
    const { store } = newStore();
    expect(() => store.put("cred", "../x", {})).toThrow(StoreError);
    expect(() => store.put("../cred", "x", {})).toThrow(StoreError);
  });
});

describe("redaction", () => {
  test("tokens and private keys never reach a log line", () => {
    const lines: string[] = [];
    const log = safeLog("t", (l) => lines.push(l));
    const fine = `github_pat_${"x".repeat(60)}`;
    log(`token ${tok("E")} and ${fine} and gho_${"y".repeat(36)} and ${"a".repeat(40)}`);
    log("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----");
    const all = lines.join("\n");
    expect(all.includes(tok("E"))).toBe(false);
    expect(all.includes(fine)).toBe(false);
    expect(all.includes("y".repeat(36))).toBe(false);
    expect(all.includes("abc")).toBe(false);
    expect(redact("plain text")).toBe("plain text");
  });
});

// ------------------------------------------------------------------------------------------------
// mock GitHub (per-token accounts) and mock chain

interface Acct {
  login: string;
  id: number;
  valid: boolean;
  scopes: string;
  stars: string[];
  signingKeys: { id: number; key: string; title: string }[];
  profile: Record<string, unknown>;
}
function mockGitHub(accts: Record<string, Acct>) {
  let nextKey = 500;
  const calls: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const t = String((init.headers as any).authorization).replace("Bearer ", "");
    calls.push(`${method} ${u.pathname}`);
    const a = accts[t];
    const j = (d: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: s, headers: h });
    if (!a || !a.valid) return j({ message: "Bad credentials" }, 401);
    const p = u.pathname;
    if (method === "GET" && p === "/user") return j({ login: a.login, id: a.id }, 200, { "x-oauth-scopes": a.scopes, "github-authentication-token-expiration": "2026-12-01 10:00:00 UTC" });
    if (method === "GET" && (p === "/user/repos" || p === "/gists")) return j([]);
    if (method === "GET" && p === "/user/orgs") return j([]);
    if (method === "GET" && p === "/user/starred") return j(Number(u.searchParams.get("page") ?? 1) === 1 ? a.stars.map((s) => ({ full_name: s })) : []);
    if (method === "DELETE" && p.startsWith("/user/starred/")) {
      a.stars = a.stars.filter((s) => s !== p.slice(14));
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH" && p === "/user") {
      Object.assign(a.profile, JSON.parse(String(init.body)));
      return j({});
    }
    if (method === "GET" && p === "/user/ssh_signing_keys") return j(Number(u.searchParams.get("page") ?? 1) === 1 ? a.signingKeys : []);
    if (method === "DELETE" && p.startsWith("/user/ssh_signing_keys/")) {
      a.signingKeys = a.signingKeys.filter((k) => String(k.id) !== p.split("/").pop());
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && p === "/user/ssh_signing_keys") {
      if (!a.scopes.includes("write:ssh_signing_key")) return j({ message: "Not Found" }, 404);
      const b = JSON.parse(String(init.body));
      const k = { id: nextKey++, key: b.key, title: b.title };
      a.signingKeys.push(k);
      return j(k, 201);
    }
    return j({ message: `unmocked ${method} ${p}` }, 404);
  };
  return { fetch: f, calls };
}
const acct = (login: string, id: number, over: Partial<Acct> = {}): Acct => ({ login, id, valid: true, scopes: "repo, write:ssh_signing_key, gist", stars: ["x/y"], signingKeys: [], profile: {}, ...over });

const fakeKeygen = (dir: string, comment: string) => {
  const privatePath = join(dir, "k");
  writeFileSync(privatePath, `-----BEGIN OPENSSH PRIVATE KEY-----\nfake ${comment}\n-----END OPENSSH PRIVATE KEY-----\n`, { mode: 0o600 });
  writeFileSync(`${privatePath}.pub`, `ssh-ed25519 AAAAfake ${comment}`);
  return { privatePath, publicKey: `ssh-ed25519 AAAAfake ${comment}` };
};

function launchOf(agent: string, mode: number, createdAt: number, launcher: string, mint = generateAgentKey().id): AgentLaunch {
  return { agent, mint, launcher, repoId: "00", repoUrl: "https://github.com/o/r", identityMode: mode, hosted: false, createdAt: BigInt(createdAt) } as unknown as AgentLaunch;
}

function setup(launches: AgentLaunch[], accts: Record<string, Acct>, souls: Record<string, any> = {}, signing: Record<string, string> = {}) {
  const s = newStore();
  const gh = mockGitHub(accts);
  let clock = 1_800_000_000_000;
  const lines: string[] = [];
  const svc = new IdentityService({
    store: s.store, runDir: s.run, site: "https://site.test", since: 1_799_999_000, soulWaitS: 600, apiBase: "https://api.test", fetch: gh.fetch, keygen: fakeKeygen,
    log: safeLog("t", (l) => lines.push(l)), now: () => new Date(clock),
    chain: {
      launches: async () => launches,
      agentLaunch: async (m) => launches.find((l) => l.mint === m) ?? null,
      agent: async (a) => (signing[a] ? ({ agent: a, signingKey: signing[a] } as unknown as AgentRecord) : null),
    },
    soul: async (a) => souls[a] ?? null,
  });
  return { svc, s, gh, lines, tick: (ms: number) => (clock += ms), nowS: () => Math.floor(clock / 1000) };
}

describe("launch watcher", () => {
  test("purchased launch: waits for the soul, then provisions from the reserve automatically", async () => {
    const launcher = generateAgentKey();
    const agent = generateAgentKey().id;
    const old = generateAgentKey().id;
    const appAgent = generateAgentKey().id;
    const L = [launchOf(agent, 1, 1_800_000_000, launcher.id), launchOf(old, 1, 1_700_000_000, launcher.id), launchOf(appAgent, 2, 1_800_000_000, launcher.id)];
    const accts = { [tok("1")]: acct("dead1", 1, { valid: false }), [tok("2")]: acct("good2", 2) };
    const souls: Record<string, any> = {};
    const t = setup(L, accts, souls);
    t.svc.reserve.add("dead1", tok("1"));
    t.svc.reserve.add("good2", tok("2"));
    await t.svc.watchOnce();
    expect(t.svc.view(agent).status).toBe("waiting_soul");
    expect(t.svc.view(appAgent).status).toBe("app");
    expect(t.svc.view(old).status).toBe("untracked"); // launched before `since`: never touched
    souls[agent] = fixtureSoul(agent);
    await t.svc.watchOnce();
    const v = t.svc.view(agent);
    expect(v.status).toBe("ready");
    expect(v.identity).toBe("account");
    expect(v.login).toBe("good2");
    expect(v.ssh_signing_key).toContain("ssh-ed25519");
    expect(accts[tok("2")]!.profile.name).toBe("Wren Halvard");
    expect(String(accts[tok("2")]!.profile.bio)).toContain(`https://site.test/agents/${agent}`);
    expect(accts[tok("2")]!.stars).toEqual([]);
    expect(accts[tok("2")]!.signingKeys.length).toBe(1);
    const pub = t.svc.reserve.publicList();
    expect(pub.find((a) => a.login === "dead1")!.status).toBe("token_invalid");
    expect(pub.find((a) => a.login === "good2")).toMatchObject({ status: "assigned", assigned_agent: agent });
    // credential stored encrypted with the key inside; materialised keys cleaned up
    const c = t.svc.creds.record(agent)!;
    expect(c.token).toBe(tok("2"));
    expect(c.ssh_private_key).toContain("PRIVATE KEY");
    expect(existsSync(join(t.s.run, "keys"))).toBe(false);
    expect(JSON.stringify(v).includes(tok("2"))).toBe(false);
    expect(t.lines.join("\n").includes(tok("2"))).toBe(false);
    // idempotent
    await t.svc.watchOnce();
    expect(t.svc.view(agent).history.filter((h) => h.status === "ready").length).toBe(1);
  });

  test("no soul within the wait: provisions with a plain profile; empty reserve fails with a reason", async () => {
    const launcher = generateAgentKey();
    const a1 = generateAgentKey().id;
    const a2 = generateAgentKey().id;
    const accts = { [tok("3")]: acct("only3", 3) };
    const t = setup([launchOf(a1, 1, 1_800_000_000, launcher.id), launchOf(a2, 1, 1_800_000_001, launcher.id)], accts);
    t.svc.reserve.add("only3", tok("3"));
    await t.svc.watchOnce();
    t.tick(601_000);
    await t.svc.watchOnce();
    expect(t.svc.view(a1).status).toBe("ready");
    expect(accts[tok("3")]!.profile.name).toBe(`Lineage agent ${a1.slice(0, 8)}`);
    expect(t.svc.view(a2).status).toBe("failed");
    expect(t.svc.view(a2).reason).toContain("reserve is empty");
    expect(t.svc.view(a2).identity).toBe("app");
  });
});

function signed<T extends TokenStatement | RevokeStatement>(key: AgentKey, st: T) {
  return { statement: st, sig: signStatement(key, PURPOSE, st) };
}

describe("token flow and revocation", () => {
  test("a pasted token bound by the launcher's statement becomes the agent's identity; revocation moves it to app", async () => {
    const launcher = generateAgentKey();
    const agent = generateAgentKey().id;
    const l = launchOf(agent, 0, 1_800_000_000, launcher.id);
    const token = tok("T");
    const accts = { [token]: acct("pasted", 9, { signingKeys: [{ id: 7, key: "ssh-ed25519 theirs", title: "their own key" }] }) };
    const t = setup([l], accts);
    await t.svc.watchOnce();
    expect(t.svc.view(agent).status).toBe("awaiting_token");
    const check = await t.svc.checkToken(token);
    expect(check).toMatchObject({ login: "pasted", scopes: ["repo", "write:ssh_signing_key", "gist"], token_kind: "classic", expires_at: "2026-12-01T10:00:00.000Z" });
    const st: TokenStatement = { v: 1, kind: "lineage-identity-token", agent, mint: l.mint, signer: launcher.id, token_sha256: tokenSha256(token), created_at: t.nowS() };
    // wrong signer, wrong token, stale statement are refused
    const stranger = generateAgentKey();
    await expect(t.svc.submitToken({ ...signed(stranger, { ...st, signer: stranger.id }), token })).rejects.toMatchObject({ code: "not_launcher" });
    await expect(t.svc.submitToken({ ...signed(launcher, st), token: tok("U") })).rejects.toMatchObject({ code: "token_mismatch" });
    await expect(t.svc.submitToken({ ...signed(launcher, { ...st, created_at: t.nowS() - 3600 }), token })).rejects.toMatchObject({ code: "bad_statement" });
    await expect(t.svc.submitToken({ statement: st, sig: signed(launcher, { ...st, created_at: st.created_at + 1 }).sig, token })).rejects.toMatchObject({ code: "bad_statement" });
    const v = await t.svc.submitToken({ ...signed(launcher, st), token });
    expect(v).toMatchObject({ status: "ready", identity: "account", login: "pasted", token_kind: "classic" });
    expect(accts[token]!.signingKeys.map((k) => k.title)).toEqual(["their own key", `lineage agent ${agent.slice(0, 12)}`]);
    // replay of the same statement is refused
    await expect(t.svc.submitToken({ ...signed(launcher, st), token })).rejects.toMatchObject({ code: "replayed" });
    // revocation by the launcher: our key removed, theirs kept, credential gone, app identity
    t.tick(5_000);
    const rv: RevokeStatement = { v: 1, kind: "lineage-identity-revoke", agent, mint: l.mint, signer: launcher.id, created_at: t.nowS() };
    const after = await t.svc.revoke(signed(launcher, rv));
    expect(after).toMatchObject({ status: "revoked", identity: "app", login: null });
    expect(accts[token]!.signingKeys.map((k) => k.title)).toEqual(["their own key"]);
    expect(t.svc.creds.record(agent)).toBeNull();
    expect(t.lines.join("\n").includes(token)).toBe(false);
  });

  test("the agent's signing key may sign; a token without signing-key permission fails with the reason; a rejected token goes to app", async () => {
    const launcher = generateAgentKey();
    const agentKey = generateAgentKey();
    const agent = agentKey.id;
    const l = launchOf(agent, 0, 1_800_000_000, launcher.id);
    const weak = tok("W");
    const good = tok("G");
    const accts = { [weak]: acct("weak", 11, { scopes: "repo" }), [good]: acct("good", 12) };
    const t = setup([l], accts, {}, { [agent]: agent });
    const mk = (token: string, at: number): TokenStatement => ({ v: 1, kind: "lineage-identity-token", agent, mint: l.mint, signer: agent, token_sha256: tokenSha256(token), created_at: at });
    await expect(t.svc.submitToken({ ...signed(agentKey, mk(weak, t.nowS())), token: weak })).rejects.toMatchObject({ code: "signing_key" });
    expect(t.svc.view(agent).status).toBe("failed");
    expect(t.svc.view(agent).reason).toContain("write:ssh_signing_key");
    t.tick(2000);
    expect((await t.svc.submitToken({ ...signed(agentKey, mk(good, t.nowS())), token: good })).status).toBe("ready");
    t.svc.markRejected(agent, "GitHub rejected the stored token on use (401)");
    expect(t.svc.view(agent)).toMatchObject({ status: "rejected", identity: "app" });
    // an app-mode launch cannot take a token
    const appA = generateAgentKey().id;
    const la = launchOf(appA, 2, 1_800_000_000, launcher.id);
    const t2 = setup([la], accts);
    const st2: TokenStatement = { v: 1, kind: "lineage-identity-token", agent: appA, mint: la.mint, signer: launcher.id, token_sha256: tokenSha256(good), created_at: t2.nowS() };
    await expect(t2.svc.submitToken({ ...signed(launcher, st2), token: good })).rejects.toBeInstanceOf(HttpError);
  });

  test("HTTP: no token in any answer, origin and size checks, rate limit", async () => {
    const launcher = generateAgentKey();
    const agent = generateAgentKey().id;
    const l = launchOf(agent, 0, 1_800_000_000, launcher.id);
    const token = tok("H");
    const t = setup([l], { [token]: acct("http", 13) });
    const h = handler(t.svc, () => {});
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      h(new Request(`http://site.test${path}`, { method: "POST", headers: { "content-type": "application/json", host: "site.test", ...headers }, body: JSON.stringify(body) }), "1.2.3.4");
    const st: TokenStatement = { v: 1, kind: "lineage-identity-token", agent, mint: l.mint, signer: launcher.id, token_sha256: tokenSha256(token), created_at: t.nowS() };
    const r = await post("/identity/token", { ...signed(launcher, st), token });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.includes(token)).toBe(false);
    const g = await h(new Request(`http://site.test/identity/agents/${agent}`), "1.2.3.4");
    const gv = await g.json();
    expect(gv.login).toBe("http");
    expect(JSON.stringify(gv).includes(token)).toBe(false);
    expect((await (await h(new Request("http://site.test/identity/agents"), "1.2.3.4")).text()).includes(token)).toBe(false);
    expect((await post("/identity/token/check", { token }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post("/identity/token/check", { token: "x".repeat(20_000) }, {})).status).toBe(413);
    expect((await h(new Request("http://site.test/identity/token", { method: "PUT" }), "1.2.3.4")).status).toBe(405);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post("/identity/token/check", { token }, {})).status);
    expect(codes).toContain(429);
  });
});
