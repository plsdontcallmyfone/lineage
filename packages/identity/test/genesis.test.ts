import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@lineage/protocol";
import type { AgentLaunch } from "../../chain/src/index.ts";
import { sshKeygen } from "../../souls/src/github/provision.ts";
import { genesisRoute } from "../../runtime/src/genesis.ts";
import { GENESIS_KIND, genesisFileText, signGenesis, verifyGenesis, type GenesisFile, type UnsignedGenesis } from "../src/genesis-proof.ts";
import { GenesisRunner, MARK_GENESIS, README_MIN_INTERVAL_MS, renderReadme, statusBlock, statusFacts, type GenesisSources } from "../src/genesis.ts";
import { safeLog } from "../src/redact.ts";
import { IdentityService } from "../src/service.ts";
import { EncryptedStore, ensureKeyFile } from "../src/store.ts";

// GitHub genesis proof (docs/plans/GITHUB-GENESIS.md): proof file, the runtime signer, README rendering,
// the sealed-content guarantee, and the runner end to end against a mocked GitHub API and real git
// (file:// bare repositories, real SSH signatures).

const tmp = mkdtempSync(join(tmpdir(), "lineage-genesis-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const EM_DASH = String.fromCharCode(0x2014);

const unsignedFor = (agent: string, login = "acct1", over: Partial<UnsignedGenesis> = {}): UnsignedGenesis => ({
  v: 1, kind: GENESIS_KIND, agent, mint: generateAgentKey().id, launch_tx: null, soul_digest: "b".repeat(64), target_repo: "https://github.com/keis/base58",
  github_login: login, network: "devnet", site: "https://site.test", issued_at: 1_800_000_000, ...over,
});

describe("proof file", () => {
  test("signs, verifies offline, and refuses tampering, wrong agent, wrong login and a stranger's key", () => {
    const k = generateAgentKey();
    const f = signGenesis(k, unsignedFor(k.id));
    const text = genesisFileText(f);
    expect(text.endsWith("\n")).toBe(true);
    expect(verifyGenesis(text).ok).toBe(true);
    expect(verifyGenesis(text, { agent: k.id, login: "ACCT1", key: k.id }).ok).toBe(true);
    expect(verifyGenesis({ ...f, target_repo: "https://github.com/x/y" })).toMatchObject({ ok: false, reason: expect.stringContaining("signature") });
    expect(verifyGenesis(f, { agent: generateAgentKey().id }).ok).toBe(false);
    expect(verifyGenesis(f, { login: "other" }).ok).toBe(false);
    expect(verifyGenesis(f, { key: generateAgentKey().id })).toMatchObject({ ok: false, reason: expect.stringContaining("registry signing key") });
    expect(verifyGenesis({ ...f, extra: 1 }).ok).toBe(false);
    expect(verifyGenesis({ ...f, signer: null, sig: null })).toMatchObject({ ok: false, reason: "the proof is not signed yet" });
    expect(verifyGenesis("{not json").ok).toBe(false);
  });

  test("the runtime signs only exact genesis statements for agents it holds keys for", async () => {
    const k = generateAgentKey();
    const keys = new Map<string, AgentKey>([[k.id, k]]);
    const host = { keyOf: (a: string) => keys.get(a) ?? null };
    const post = (agent: string, body: unknown) => genesisRoute(new Request(`http://127.0.0.1:9667/runtime/genesis/${agent}`, { method: "POST", body: JSON.stringify(body) }), host);
    const ok = await post(k.id, { statement: unsignedFor(k.id) });
    expect(ok!.status).toBe(200);
    const f = (await ok!.json()) as GenesisFile;
    expect(f.signer).toBe(k.id);
    expect(verifyGenesis(f, { agent: k.id, key: k.id }).ok).toBe(true);
    expect((await post(k.id, { statement: { ...unsignedFor(k.id), signer: k.id } }))!.status).toBe(400); // signer is the runtime's to fill
    expect((await post(k.id, { statement: { ...unsignedFor(k.id), kind: "lineage-link" } }))!.status).toBe(400);
    expect((await post(k.id, { statement: unsignedFor(generateAgentKey().id) }))!.status).toBe(400); // not the path agent
    const stranger = generateAgentKey().id;
    expect((await post(stranger, { statement: unsignedFor(stranger) }))!.status).toBe(404);
    expect(await genesisRoute(new Request("http://127.0.0.1:9667/runtime/bind/x"), host)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// README

const facts = (over: Record<string, unknown> = {}) => ({
  agent: "5iCWSoXAsvhdDiwsexnuAXU3RcNXgbXw7TzuRZH2LYoA", name: "Wick Radix", tagline: "Fewer big-int steps in base58.", repo: "https://github.com/keis/base58",
  mint: "A8YeMNZuSfKZZpgMpj8sYwmsHpDsm5CkjTYp966mpsFS", symbol: "TESTB58", launch_tx: null, model: "claude-opus-5-5", soul_digest: null, network: "devnet",
  explorer_cluster: "devnet", site: "https://site.test", hidden: false, ...over,
});
const gen = (id: string, at: number, ratio: number) => ({ kind: "generation", id, at, generation: { height: 5, kind: "perf", target: "decode_ir", effect: { metric: "decode_ir", ratio, ci_low: ratio, ci_high: ratio } } });

describe("README", () => {
  test("factual, links back, token lines only when allowed, no em dashes", () => {
    const st = statusFacts({ stats: { accepted: 3, rejected: 1, final: 4 }, timeline: [gen("a".repeat(64), 1_800_000_000_000, 0.96491)] }, [{ session_id: "c".repeat(64), state: "final", repo: "https://github.com/keis/base58", started_at: 1_800_000_100_000, ended_at: 1_800_000_200_000 }], [
      { gen_id: "a".repeat(64), html_url: "https://github.com/acct1/base58/commit/abc", verified: true } as any,
    ]);
    const r = renderReadme(facts(), st, { noToken: false, signed: true, login: "acct1" });
    expect(r.startsWith(MARK_GENESIS)).toBe(true);
    expect(r).toContain("# Wick Radix");
    expect(r).toContain("every change is replayed by independent verifiers before it counts");
    expect(r).toContain("TESTB58, mint `A8YeMNZuSfKZZpgMpj8sYwmsHpDsm5CkjTYp966mpsFS` ([explorer](https://explorer.solana.com/address/A8YeMNZuSfKZZpgMpj8sYwmsHpDsm5CkjTYp966mpsFS?cluster=devnet))");
    expect(r).toContain("https://site.test/agents/5iCWSoXAsvhdDiwsexnuAXU3RcNXgbXw7TzuRZH2LYoA/profile");
    expect(r).toContain("https://site.test/tokens/A8YeMNZuSfKZZpgMpj8sYwmsHpDsm5CkjTYp966mpsFS");
    expect(r).toContain(`https://site.test/sessions/${"c".repeat(64)}`);
    expect(r).toContain("- Model: claude-opus-5-5");
    const block = statusBlock(r)!;
    expect(block).toContain("Status: idle, last session");
    expect(block).toContain("decode_ir, ratio 0.9649");
    expect(block).toContain("[Verified commit](https://github.com/acct1/base58/commit/abc)");
    expect(block).toContain("Final verdicts: 4 (3 accepted, 1 rejected)");
    expect(r.includes(EM_DASH)).toBe(false);
    // no_token (Wick Radix): no token, mint, symbol, price or token page lines at all
    const n = renderReadme(facts(), st, { noToken: true, signed: true, login: "acct1" });
    for (const w of ["Token", "token", "TESTB58", "A8YeMNZu", "mint", "price", "/tokens/"]) expect(n.includes(w)).toBe(false);
    expect(n).toContain("# Wick Radix");
    // unknown model says TBA; unsigned proofs say so
    const u = renderReadme(facts({ model: null }), statusFacts(null, null, []), { noToken: false, signed: false, login: "acct1" });
    expect(u).toContain("- Model: TBA");
    expect(u).toContain("Its signature is pending");
    expect(statusBlock(u)).toContain("launched, no session yet");
  });

  test("sealed work can never reach the README (SPEC 10.7, 17.3)", () => {
    const SECRET = ["SEALED_TARGET_fn_zz", "SEALED_DIFF_line", "SEALED_NOTE_text", "SEALED_JOURNAL_entry", "SEALED_CANDIDATE_ID", "SEALED_EVENT_payload", "SEALED_SUBMIT_msg"];
    // every input carries sealed content in every place a careless reader might take it from
    const profile = {
      target_repo: "https://github.com/keis/base58",
      stats: { accepted: 2, rejected: 0, final: 2, open: SECRET[4], last_candidate: SECRET[1] },
      timeline: [
        gen("d".repeat(64), 1_800_000_000_000, 0.98),
        { kind: "session", id: "e".repeat(64), at: 1_800_000_500_000, session: { state: "sealed", recipe_name: SECRET[0], candidate: { candidate_id: SECRET[4], target: SECRET[0], notes: SECRET[2] } } },
        { kind: "candidate", id: SECRET[4], at: 1_800_000_600_000, generation: { effect: { metric: SECRET[0], ratio: 0.5 } } },
        { kind: "journal", id: "j", at: 1_800_000_700_000, text: SECRET[3] },
      ],
      journal: [{ text: SECRET[3] }],
      posts: [{ text: SECRET[6] }],
    };
    const sessions = [
      { session_id: "e".repeat(64), state: "sealed", open: false, repo: "https://github.com/keis/base58", started_at: 1_800_000_500_000, ended_at: null, recipe_name: SECRET[0], candidate: { candidate_id: SECRET[4], target: SECRET[0], diff: SECRET[1] }, events: [{ kind: "edit", text: SECRET[5] }], notes: SECRET[2] },
    ];
    const st = statusFacts(profile, sessions, [{ gen_id: SECRET[4], html_url: `https://github.com/x/${SECRET[1]}`, verified: true } as any]);
    const r = renderReadme(facts(), st, { noToken: false, signed: true, login: "acct1" });
    for (const s of SECRET) expect(r.includes(s)).toBe(false);
    expect(JSON.stringify(st).includes("SEALED")).toBe(false);
    // what it does say while the candidate is sealed: only that it is working on the repository
    expect(statusBlock(r)).toContain("Status: working on keis/base58");
    expect(statusBlock(r)).toContain("decode_ir, ratio 0.9800");
  });
});

// ------------------------------------------------------------------------------------------------
// runner end to end: mocked GitHub API + file:// bare repositories + real SSH signing

function bareMock(base: string) {
  const repos = new Map<string, { default_branch: string }>();
  const calls: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
    const login = String((init.headers as any).authorization).replace("Bearer tok-", "");
    let m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && m) {
      const r = repos.get(`${m[1]}/${m[2]}`);
      return r ? j({ full_name: `${m[1]}/${m[2]}`, fork: false, archived: false, private: false, default_branch: r.default_branch }) : j({ message: "Not Found" }, 404);
    }
    if (method === "POST" && u.pathname === "/user/repos") {
      const b = JSON.parse(String(init.body));
      expect(b.private).toBe(false);
      const dir = join(base, login, `${b.name}.git`);
      mkdirSync(join(base, login), { recursive: true });
      spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main", dir]);
      repos.set(`${login}/${b.name}`, { default_branch: "main" });
      return j({ full_name: `${login}/${b.name}`, default_branch: "main" }, 201);
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})$/.exec(u.pathname);
    if (method === "GET" && m) {
      const raw = spawnSync("git", ["-C", join(base, m[1]!, `${m[2]}.git`), "cat-file", "commit", m[3]!], { encoding: "utf8" }).stdout;
      return j({ sha: m[3], html_url: `https://github.com/${m[1]}/${m[2]}/commit/${m[3]}`, commit: { verification: { verified: raw.includes("-----BEGIN SSH SIGNATURE-----"), reason: raw.includes("SSH SIGNATURE") ? "valid" : "unsigned" } } });
    }
    return j({ message: `unmocked ${method} ${u.pathname}` }, 404);
  };
  return { fetch: f, calls, repos };
}

function fakeSources(o: { profile: any; sessions: any[]; hidden?: { mint: string | null; agent: string | null }[]; keys: Map<string, AgentKey>; recorded: string[] }): GenesisSources {
  return {
    profile: async () => o.profile,
    sessions: async () => o.sessions,
    hidden: async () => o.hidden ?? [],
    token: async (m) => ({ mint: m, symbol: "TESTB58", events: [{ kind: "launch", signature: "4w5YXSTEsTrhTi1J5ck5VuMjhT8agWTjX8P52VGmYxJhKXKBne8E1nkWJWwFpmocfh6rPz8dwgsbYdseFEPFPjX5" }] }),
    sign: async (a, st) => (o.keys.get(a) ? signGenesis(o.keys.get(a)!, st) : null),
    record: async (a, login) => (o.recorded.push(`${a}:${login}`), { status: "verified", detail: null }),
  };
}

let n = 0;
function world(mode: "purchased" | "token" = "purchased", hidden = false) {
  const d = join(tmp, `w${++n}`);
  const keyFile = join(d, "key", "master.key");
  ensureKeyFile(keyFile);
  const store = new EncryptedStore(join(d, "data"), keyFile);
  const base = join(d, "gh");
  mkdirSync(base, { recursive: true });
  const gh = bareMock(base);
  let clock = 1_800_000_000_000;
  const agentKey = generateAgentKey();
  const agent = agentKey.id;
  const mint = generateAgentKey().id;
  const login = `acct${n}`;
  const launch = { agent, mint, launcher: generateAgentKey().id, repoId: "00", repoUrl: "https://github.com/keis/base58", identityMode: mode === "token" ? 0 : 1, hosted: true, createdAt: 1_800_000_000n } as unknown as AgentLaunch;
  const lines: string[] = [];
  const svc = new IdentityService({
    store, runDir: join(d, "run"), site: "https://site.test", since: 1_799_999_000, soulWaitS: 0, apiBase: "https://api.test", fetch: gh.fetch,
    log: safeLog("t", (l) => lines.push(l)), now: () => new Date(clock),
    chain: { launches: async () => [launch], agentLaunch: async () => launch, agent: async () => null },
    soul: async () => null,
  });
  // a ready account (what provisioning leaves): state + encrypted credential with a real SSH key
  const kdir = join(d, "k");
  mkdirSync(kdir, { recursive: true });
  const kp = sshKeygen(kdir, `lineage-agent-${agent}`);
  svc.creds.put({ v: 1, agent, login, github_id: 100 + n, token: `tok-${login}`, ssh_private_key_path: kp.privatePath, ssh_public_key: kp.publicKey, ssh_signing_key_id: 1, assigned_at: "", mode });
  store.put("state", agent, { v: 1, agent, mint, launcher: launch.launcher, repo: launch.repoUrl, mode, status: "ready", reason: null, login, github_id: 100 + n, ssh_public_key: kp.publicKey, scopes: null, token_kind: null, expires_at: null, launched_at: 1_800_000_000, first_seen_at: "", updated_at: "", attempts: 1, last_statement_at: 0, history: [] });
  const profile: any = { agent, mint, target_repo: "https://github.com/keis/base58", hidden: null, soul: { name: "Test Wren", tagline: "A plainly labelled test agent.", digest: "c".repeat(64) }, model: "claude-opus-5-5", stats: { accepted: 0, rejected: 0, final: 0 }, timeline: [] };
  const sessions: any[] = [];
  const recorded: string[] = [];
  const keys = new Map([[agent, agentKey]]);
  const sources = fakeSources({ profile, sessions, keys, recorded, hidden: hidden ? [{ mint, agent: null }] : [] });
  const runner = new GenesisRunner({ svc, sources, network: { name: "devnet", explorer_cluster: "devnet" }, site: "https://site.test", apiBase: "https://api.test", gitBase: `file://${base}`, fetch: gh.fetch as never, log: safeLog("t", (l) => lines.push(l)), now: () => new Date(clock), verifyPolls: 1 });
  const bareDir = join(base, login, `${login}.git`);
  const show = (p: string, ref = "HEAD") => spawnSync("git", ["-C", bareDir, "show", `${ref}:${p}`], { encoding: "utf8" });
  const commits = () => spawnSync("git", ["-C", bareDir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).stdout.trim();
  return { svc, runner, gh, agent, agentKey, mint, login, profile, sessions, recorded, lines, keys, bareDir, show, commits, tick: (ms: number) => (clock += ms) };
}

describe("genesis runner", () => {
  test("at provisioning: profile repository created, one signed Verified commit with README and proof, Core asked to record it", async () => {
    const w = world();
    let done: Promise<unknown> | null = null;
    w.svc.afterReady = (a) => (done = w.runner.run(a));
    // the hook fires when an account becomes ready; here we fire it the way the service does
    (w.svc as any).ready(w.agent);
    await done;
    const rec = w.runner.record(w.agent)!;
    expect(rec.status).toBe("published");
    expect(rec.commit!.verified).toBe(true);
    expect(rec.repo).toBe(`${w.login}/${w.login}`);
    expect(w.recorded).toEqual([`${w.agent}:${w.login}`]);
    expect(w.gh.calls).toContain("POST /user/repos");
    const raw = spawnSync("git", ["-C", w.bareDir, "cat-file", "commit", "HEAD"], { encoding: "utf8" }).stdout;
    expect(raw).toContain("-----BEGIN SSH SIGNATURE-----");
    expect(raw).toContain(`${100 + Number(w.login.slice(4))}+${w.login}@users.noreply.github.com`);
    expect(raw).toContain(`Agent: ${w.agent}`);
    const proof = w.show("lineage-proof.json").stdout;
    const v = verifyGenesis(proof, { agent: w.agent, login: w.login, key: w.agentKey.id });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.file.mint).toBe(w.mint);
      expect(v.file.launch_tx).toStartWith("4w5YXSTE");
      expect(v.file.soul_digest).toBe("c".repeat(64));
    }
    const readme = w.show("README.md").stdout;
    expect(readme).toContain("# Test Wren");
    expect(readme).toContain("TESTB58");
    expect(readme.includes(EM_DASH)).toBe(false);
    expect(w.commits()).toBe("1");
    expect(w.svc.view(w.agent).genesis).toMatchObject({ status: "published", signed: true, verified: true, proof_url: `https://github.com/${w.login}/${w.login}/blob/HEAD/lineage-proof.json` });
    // no token or key in any log line
    expect(w.lines.join("\n").includes(`tok-${w.login}`)).toBe(false);
    expect(w.lines.join("\n").includes("PRIVATE KEY")).toBe(false);
  });

  test("living README: session start and verdicts update the status, at most once per 10 minutes, never when unchanged", async () => {
    const w = world();
    await w.runner.run(w.agent, { explicit: true });
    expect(w.commits()).toBe("1");
    // nothing changed: no commit
    w.tick(README_MIN_INTERVAL_MS + 1000);
    expect(await w.runner.refresh(w.agent, { force: true })).toBe("unchanged");
    // a session starts: repo + working only
    w.sessions.push({ session_id: "f".repeat(64), state: "live", repo: "https://github.com/keis/base58", started_at: 1_800_000_900_000, ended_at: null });
    expect(await w.runner.refresh(w.agent, { force: true })).toBe("committed");
    expect(statusBlock(w.show("README.md").stdout)).toContain("Status: working on keis/base58");
    expect(w.commits()).toBe("2");
    // the verdict comes 2 minutes later: rate limited
    w.sessions[0].state = "final";
    w.sessions[0].ended_at = 1_800_001_000_000;
    w.profile.stats = { accepted: 1, rejected: 0, final: 1 };
    w.profile.timeline.push(gen("9".repeat(64), 1_800_001_000_000, 0.759));
    w.tick(2 * 60 * 1000);
    expect(await w.runner.refresh(w.agent, { force: true })).toBe("rate_limited");
    expect(w.commits()).toBe("2");
    w.tick(README_MIN_INTERVAL_MS);
    expect(await w.runner.refresh(w.agent, { force: true })).toBe("committed");
    const block = statusBlock(w.show("README.md").stdout)!;
    expect(block).toContain("Status: idle");
    expect(block).toContain("decode_ir, ratio 0.7590");
    expect(block).toContain("Final verdicts: 1 (1 accepted, 0 rejected)");
    expect(w.commits()).toBe("3");
    // every commit signed; the proof file unchanged across README updates
    const all = spawnSync("git", ["-C", w.bareDir, "log", "--format=%H"], { encoding: "utf8" }).stdout.trim().split("\n");
    for (const sha of all) expect(spawnSync("git", ["-C", w.bareDir, "cat-file", "commit", sha], { encoding: "utf8" }).stdout).toContain("SSH SIGNATURE");
    expect(w.show("lineage-proof.json").stdout).toBe(w.show("lineage-proof.json", all[all.length - 1]).stdout);
    // the poll interval keeps Core reads down when not forced
    expect(await w.runner.refresh(w.agent)).toBe("skipped");
  });

  test("hidden test launches are skipped unless explicitly provisioned; no_token keeps token lines out", async () => {
    const w = world("purchased", true);
    expect((await w.runner.run(w.agent)).status).toBe("skipped");
    expect(existsSync(w.bareDir)).toBe(false);
    const r = await w.runner.run(w.agent, { explicit: true, noToken: true });
    expect(r.status).toBe("published");
    const readme = w.show("README.md").stdout;
    for (const s of ["TESTB58", w.mint, "Token", "/tokens/"]) expect(readme.includes(s)).toBe(false);
    // the proof still carries the mint as recorded
    expect(JSON.parse(w.show("lineage-proof.json").stdout).mint).toBe(w.mint);
    // later README updates keep the option
    w.tick(README_MIN_INTERVAL_MS + 1000);
    w.profile.stats = { accepted: 1, rejected: 0, final: 1 };
    w.profile.timeline.push(gen("8".repeat(64), 1_800_000_500_000, 0.9));
    expect(await w.runner.refresh(w.agent, { force: true })).toBe("committed");
    expect(w.show("README.md").stdout.includes("TESTB58")).toBe(false);
  });

  test("a pasted token's own profile README is kept; ours goes to LINEAGE.md; unsigned when no key holder", async () => {
    const w = world("token");
    // the launcher's existing profile repository with their own README
    const seed = join(tmp, `seed${n}`);
    spawnSync("git", ["init", "-q", "--initial-branch=main", seed]);
    writeFileSync(join(seed, "README.md"), "# Hi, I am a human\n");
    spawnSync("git", ["-C", seed, "add", "."]);
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", seed, "commit", "-q", "-m", "mine"]);
    mkdirSync(join(w.bareDir, ".."), { recursive: true });
    spawnSync("git", ["clone", "-q", "--bare", seed, w.bareDir]);
    w.gh.repos.set(`${w.login}/${w.login}`, { default_branch: "main" });
    w.keys.clear(); // self-hosted: the runtime holds no key
    const r = await w.runner.run(w.agent);
    expect(r.status).toBe("published");
    expect(r.readme_path).toBe("LINEAGE.md");
    expect(w.show("README.md").stdout).toBe("# Hi, I am a human\n");
    expect(w.show("LINEAGE.md").stdout).toContain("Its signature is pending");
    const p = JSON.parse(w.show("lineage-proof.json").stdout);
    expect(p.sig).toBeNull();
    expect(w.recorded).toEqual([]); // nothing for Core to verify yet
    // the operator signs with the agent's key file later
    const r2 = await w.runner.run(w.agent, { key: w.agentKey });
    expect(r2.proof!.signed).toBe(true);
    expect(verifyGenesis(w.show("lineage-proof.json").stdout, { key: w.agentKey.id }).ok).toBe(true);
    expect(w.show("README.md").stdout).toBe("# Hi, I am a human\n");
    expect(w.recorded.length).toBe(1);
  });
});
