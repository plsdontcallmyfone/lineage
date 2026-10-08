import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { github } from "../src/index.ts";
import { soul } from "./fixtures.ts";

const { FileCredentialStore, Pool, provisionAccount, signedCommit, redactTokens } = github;
const tmp = mkdtempSync(join(tmpdir(), "lineage-souls-gh-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Acct {
  login: string;
  id: number;
  valid: boolean;
  stars: string[];
  gists: { id: string; owner: { login: string } }[];
  collab: string[];
  orgs: number;
  profile: Record<string, unknown>;
  signingKeys: { id: number; key: string }[];
}

/** In-memory GitHub API: per-token accounts, the endpoints provisioning uses, and a call log. */
function mockGitHub(accts: Record<string, Acct>, verified = (sha: string) => true) {
  const calls: string[] = [];
  let nextKey = 100;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const token = String((init.headers as any).authorization).replace("Bearer ", "");
    calls.push(`${method} ${u.pathname}`);
    const a = accts[token];
    const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (!a || !a.valid) return json({ message: "Bad credentials" }, 401);
    const p = u.pathname;
    const page = Number(u.searchParams.get("page") ?? 1);
    const pg = <T,>(xs: T[]) => xs.slice((page - 1) * 100, page * 100);
    if (method === "GET" && p === "/user") return json({ login: a.login, id: a.id });
    if (method === "GET" && p === "/user/repos") return json(pg(a.collab.map((f) => ({ full_name: f, owner: { login: f.split("/")[0] } }))));
    if (method === "GET" && p === "/user/orgs") return json(Array.from({ length: a.orgs }, (_, i) => ({ login: `org${i}` })));
    if (method === "GET" && p === "/user/starred") return json(pg(a.stars.map((s) => ({ full_name: s }))));
    if (method === "DELETE" && p.startsWith("/user/starred/")) {
      a.stars = a.stars.filter((s) => s !== p.slice("/user/starred/".length));
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && p === "/gists") return json(pg(a.gists));
    if (method === "DELETE" && p.startsWith("/gists/")) {
      a.gists = a.gists.filter((g) => g.id !== p.slice(7));
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH" && p === "/user") {
      Object.assign(a.profile, JSON.parse(String(init.body)));
      return json({ login: a.login });
    }
    if (method === "GET" && p === "/user/ssh_signing_keys") return json(pg(a.signingKeys));
    if (method === "DELETE" && p.startsWith("/user/ssh_signing_keys/")) {
      a.signingKeys = a.signingKeys.filter((k) => String(k.id) !== p.split("/").pop());
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && p === "/user/ssh_signing_keys") {
      const k = { id: nextKey++, key: JSON.parse(String(init.body)).key };
      a.signingKeys.push(k);
      return json(k, 201);
    }
    const repoM = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (repoM) {
      const [, owner, repo, rest] = repoM;
      if (method === "GET" && !rest) return owner === a.login && (a as any).forked ? json({ full_name: `${owner}/${repo}`, fork: true, size: 1, parent: { full_name: "upstream/proj" } }) : json({ message: "Not Found" }, 404);
      if (method === "POST" && rest === "/forks") {
        (a as any).forked = true;
        return json({ full_name: `${a.login}/${repo}` }, 202);
      }
      if (method === "GET" && rest === "/branches") return json([{ name: "main" }]);
      const c = rest?.match(/^\/commits\/([0-9a-f]{40})$/);
      if (method === "GET" && c) return json({ sha: c[1], html_url: `https://github.invalid/${owner}/${repo}/commit/${c[1]}`, commit: { verification: { verified: verified(c[1]!), reason: verified(c[1]!) ? "valid" : "unsigned" } } });
    }
    return json({ message: `mock: no route ${method} ${p}` }, 404);
  };
  return { fetchImpl, calls };
}

function acct(login: string, id: number, over: Partial<Acct> = {}): Acct {
  return { login, id, valid: true, stars: ["a/one", "b/two", "c/three"], gists: [{ id: "g1", owner: { login } }, { id: "g2", owner: { login } }], collab: [], orgs: 0, profile: { name: "old", bio: "old bio", company: "old co" }, signingKeys: [{ id: 7, key: "ssh-ed25519 OLD" }], ...over };
}

function poolFile(accounts: { login: string; token: string; status?: string }[]) {
  const path = join(tmp, `pool-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, accounts: accounts.map((a) => ({ status: "available", assigned_agent: null, ...a })) }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const fakeKeygen = (dir: string) => {
  writeFileSync(join(dir, "k"), "PRIVATE", { mode: 0o600 });
  return { privatePath: join(dir, "k"), publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE lineage" };
};

describe("pool", () => {
  test("refuses a pool file readable by others", () => {
    const p = poolFile([]);
    chmodSync(p, 0o644);
    expect(() => new Pool(p).read()).toThrow("must be 600");
  });
});

describe("provisioning against a mocked GitHub API", () => {
  test("skips invalid, excluded and foreign-collaborator accounts, cleans, sets the soul profile, registers a signing key, stores the credential", async () => {
    const T = { bad: "ghp_" + "B".repeat(36), excl: "ghp_" + "E".repeat(36), collab: "ghp_" + "C".repeat(36), good: "ghp_" + "G".repeat(36) };
    const accts: Record<string, Acct> = {
      [T.bad]: acct("badtok", 1, { valid: false }),
      [T.excl]: acct("ver1t0l3", 2),
      [T.collab]: acct("collabby", 3, { collab: ["someoneelse/private-thing"] }),
      [T.good]: acct("goodone", 4, { gists: [{ id: "g1", owner: { login: "goodone" } }, { id: "g9", owner: { login: "goodone" } }] }),
    };
    const gh = mockGitHub(accts);
    const path = poolFile([{ login: "badtok", token: T.bad }, { login: "ver1t0l3", token: T.excl }, { login: "collabby", token: T.collab }, { login: "goodone", token: T.good }]);
    const pool = new Pool(path);
    const store = new FileCredentialStore(join(tmp, "creds"));
    const k = generateAgentKey();
    const logs: string[] = [];
    const r = await provisionAccount({ agent: k.id, soul: soul(k.id), pool, store, profileUrl: `https://lineage.example/agents/${k.id}`, fetch: gh.fetchImpl, keygen: fakeKeygen, log: (m) => logs.push(m) });
    expect(r.login).toBe("goodone");
    expect(r.skipped.map((s) => s.login)).toEqual(["badtok", "collabby"]); // ver1t0l3 never tried
    expect(gh.calls.some((c) => c.includes("ver1t0l3"))).toBe(false);
    const g = accts[T.good]!;
    expect(g.stars).toEqual([]);
    expect(g.gists).toEqual([]);
    expect(g.signingKeys.map((x) => x.id)).toEqual([100]);
    expect(g.profile).toMatchObject({ name: "Wren Halvard", company: "", location: "", blog: `https://lineage.example/agents/${k.id}` });
    expect(String(g.profile.bio).length).toBeLessThanOrEqual(160);
    expect(String(g.profile.bio)).toContain(k.id);
    const cred = store.get(k.id)!;
    expect(cred.login).toBe("goodone");
    expect(cred.token).toBe(T.good);
    expect(statSync(join(tmp, "creds", `${k.id}.json`)).mode & 0o777).toBe(0o600);
    const after = JSON.parse(readFileSync(path, "utf8")).accounts;
    expect(after.find((a: any) => a.login === "goodone")).toMatchObject({ status: "assigned", assigned_agent: k.id });
    expect(after.find((a: any) => a.login === "badtok").status).toBe("token_invalid");
    expect(after.find((a: any) => a.login === "collabby").status).toBe("excluded");
    // no token in logs or in the returned record
    const out = JSON.stringify(r) + logs.join("\n");
    for (const t of Object.values(T)) expect(out.includes(t)).toBe(false);
    // re-running for the same agent reuses its account
    const again = await provisionAccount({ agent: k.id, soul: soul(k.id), pool, store, profileUrl: null, fetch: gh.fetchImpl, keygen: fakeKeygen });
    expect(again.login).toBe("goodone");
  });

  test("dry run reads only: no writes sent, pool and store untouched", async () => {
    const T = "ghp_" + "D".repeat(36);
    const accts = { [T]: acct("dryone", 9) };
    const gh = mockGitHub(accts);
    const path = poolFile([{ login: "dryone", token: T }]);
    const before = readFileSync(path, "utf8");
    const store = new FileCredentialStore(join(tmp, "creds-dry"));
    const k = generateAgentKey();
    const r = await provisionAccount({ agent: k.id, soul: soul(k.id), pool: new Pool(path), store, profileUrl: null, dryRun: true, fetch: gh.fetchImpl });
    expect(r.dry_run).toBe(true);
    expect(gh.calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(r.writes.map((w) => w.method)).toContain("PATCH");
    expect(r.writes.filter((w) => w.method === "DELETE").length).toBe(3 + 2 + 1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(store.get(k.id)).toBeNull();
    expect(accts[T]!.stars.length).toBe(3);
  });

  test("redaction", () => {
    expect(redactTokens("token ghp_" + "Z".repeat(36) + " leaked")).toBe("token <redacted> leaked");
  });
});

describe("signed commit", () => {
  const hasKeygen = spawnSync("ssh-keygen", ["-?"]).status !== null;
  test.skipIf(!hasKeygen)("forks, signs with the agent key, pushes and reads verification", async () => {
    // a local bare "fork" stands in for github.com; the API is mocked
    const base = join(tmp, "remote");
    spawnSync("mkdir", ["-p", join(base, "upstream"), join(base, "goodone")]);
    const seedRepo = join(tmp, "seed");
    for (const a of [["init", "-q", seedRepo], ["-C", seedRepo, "commit", "-q", "--allow-empty", "-m", "base"]]) spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
    spawnSync("git", ["clone", "-q", "--bare", seedRepo, join(base, "upstream", "proj.git")]);
    spawnSync("git", ["clone", "-q", "--bare", seedRepo, join(base, "goodone", "proj.git")]);
    const baseSha = spawnSync("git", ["-C", seedRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const store = new FileCredentialStore(join(tmp, "creds-commit"));
    const k = generateAgentKey();
    const kp = github.sshKeygen(store.keyDir(k.id), "test");
    const T = "ghp_" + "K".repeat(36);
    const gh = mockGitHub({ [T]: { ...acct("goodone", 4), forked: true } as any });
    const r = await signedCommit({
      cred: { v: 1, agent: k.id, login: "goodone", github_id: 4, token: T, ssh_private_key_path: kp.privatePath, ssh_public_key: kp.publicKey, ssh_signing_key_id: 1, assigned_at: "" },
      upstream: "upstream/proj", branch: "lineage/proj-test", baseCommit: baseSha, files: { ".lineage/agent.json": "{}\n" },
      message: `Record the agent\n\n${github.lineageTrailers({ agent: k.id, soul: "e".repeat(64) })}\n`, gitBase: `file://${base}`, fetch: gh.fetchImpl,
    });
    expect(r.verified).toBe(true);
    const log = spawnSync("git", ["-C", join(base, "goodone", "proj.git"), "log", "-1", "--format=%G?|%ae|%B", "lineage/proj-test"], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "gpg.ssh.allowedSignersFile", GIT_CONFIG_VALUE_0: "/dev/null" } }).stdout;
    expect(log).toContain("4+goodone@users.noreply.github.com");
    expect(log).toContain(`Agent: ${k.id}`);
    const raw = spawnSync("git", ["-C", join(base, "goodone", "proj.git"), "cat-file", "commit", "lineage/proj-test"], { encoding: "utf8" }).stdout;
    expect(raw).toContain("-----BEGIN SSH SIGNATURE-----");
    expect(existsSync(kp.privatePath)).toBe(true);
  });
});
