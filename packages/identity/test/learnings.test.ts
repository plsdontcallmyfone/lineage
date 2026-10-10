import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { sshKeygen } from "../../souls/src/github/provision.ts";
import { LEARNINGS_MIN_INTERVAL_MS, LearningsPublisher, renderCard, renderLessons, type LearningsSources, type RepoReport } from "../src/learnings.ts";
import { safeLog } from "../src/redact.ts";
import { IdentityService } from "../src/service.ts";
import { EncryptedStore, ensureKeyFile } from "../src/store.ts";

// Agent learnings repositories (docs/plans/AGENT-LEARNINGS.md 7) against a mocked GitHub API and real
// git (file:// bare repositories, real SSH signatures): <login>/lineage-learnings, batched, rate
// limited, Verified; app-identity agents wait for a publisher.

const tmp = mkdtempSync(join(tmpdir(), "lineage-learnings-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const EM_DASH = String.fromCharCode(0x2014);

function ghMock(base: string) {
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
  return { fetch: f, calls };
}

const LIN = "1".repeat(64);
function episode(agent: string, seq: number, over: Record<string, any> = {}) {
  const id = seq.toString(16).padStart(64, "0");
  return {
    schema: "lineage-episode/1", episode_id: id, seq, session_id: id, agent: { id: agent, name: "Test Wren" },
    model: { provider: seq % 2 ? "anthropic" : null, models: [] }, task: { lineage_id: LIN, recipe: { name: "base58-py", repo: "https://github.com/keis/base58", commit: "2fae7065" }, target: { kind: "perf", target: "encode_ir" } },
    outcome: seq % 2 ? "accepted" : "rejected", effect: { metric: "encode_ir", ratio: 0.9, gain_pct: 10 }, reward: { accepted: seq % 2 }, ...over,
  };
}

function world() {
  const d = mkdtempSync(join(tmp, "w"));
  const keyFile = join(d, "key", "master.key");
  ensureKeyFile(keyFile);
  const store = new EncryptedStore(join(d, "data"), keyFile);
  const base = join(d, "gh");
  mkdirSync(base, { recursive: true });
  const gh = ghMock(base);
  let clock = 1_800_000_000_000;
  const lines: string[] = [];
  const svc = new IdentityService({
    store, runDir: join(d, "run"), site: "https://site.test", since: 1_799_999_000, soulWaitS: 0, apiBase: "https://api.test", fetch: gh.fetch,
    log: safeLog("t", (l) => lines.push(l)), now: () => new Date(clock),
    chain: { launches: async () => [], agentLaunch: async () => null as never, agent: async () => null }, soul: async () => null,
  });
  const own = generateAgentKey().id;
  const app = generateAgentKey().id;
  const login = "wrenacct";
  const kdir = join(d, "k");
  mkdirSync(kdir, { recursive: true });
  const kp = sshKeygen(kdir, `lineage-agent-${own}`);
  svc.creds.put({ v: 1, agent: own, login, github_id: 4242, token: `tok-${login}`, ssh_private_key_path: kp.privatePath, ssh_public_key: kp.publicKey, ssh_signing_key_id: 1, assigned_at: "", mode: "purchased" });
  store.put("state", own, { v: 1, agent: own, mint: generateAgentKey().id, launcher: "", repo: "https://github.com/keis/base58", mode: "purchased", status: "ready", reason: null, login, github_id: 4242, ssh_public_key: kp.publicKey, scopes: null, token_kind: null, expires_at: null, launched_at: 1_800_000_000, first_seen_at: "", updated_at: "", attempts: 1, last_statement_at: 0, history: [] });
  // Core's published episodes (what GET /v1/learnings/* would serve)
  const published: any[] = [];
  const recorded: RepoReport[][] = [];
  const sources: LearningsSources = {
    agents: async () => [...new Set(published.map((e) => e.agent.id))].map((a) => ({ agent: a, episodes: 0, last_seq: 0 })),
    episodes: async (a, since, limit) => {
      const all = published.filter((e) => e.agent.id === a && e.seq > since);
      return { episodes: all.slice(0, limit), next_since: all.slice(0, limit).at(-1)?.seq ?? since, more: all.length > limit };
    },
    lessons: async () => ({ lineages: [{ lineage_id: LIN, recipe: { name: "base58-py", repo: "https://github.com/keis/base58", commit: "2fae7065" }, attempts: 2, targets: [{ target: "perf:encode_ir", attempts: 2, outcomes: { accepted: 1, rejected: 1 }, rejection_reasons: { duplicate: 1 }, accepted_effects: [{ episode_id: "a".repeat(64), gain_pct: 10, ratio: 0.9 }], best: { episode_id: "a".repeat(64), gain_pct: 10, ratio: 0.9 }, files_accepted: ["base58/__init__.py"], files_rejected: [], median_usd: 0.2, usd_known: 1 }], journal: [{ episode_id: "a".repeat(64), created_at: 1_800_000_000_000, outcome: "accepted", text: "Replaced the divmod loop." }], license: { spdx: "MIT", url: "https://github.com/keis/base58/blob/master/COPYING", source: "GitHub API /repos/keis/base58/license", read_on: "2026-10-10" }, attribution: "Code excerpts from https://github.com/keis/base58 at 2fae7065, licensed MIT, copyright its authors; see https://github.com/keis/base58/blob/master/COPYING." }] }),
    record: async (r) => void recorded.push(r),
  };
  const pub = new LearningsPublisher({ svc, sources, site: "https://site.test", apiBase: "https://api.test", gitBase: `file://${base}`, fetch: gh.fetch as never, log: safeLog("t", (l) => lines.push(l)), now: () => new Date(clock), verifyPolls: 1 });
  const bare = join(base, login, "lineage-learnings.git");
  const git = (...a: string[]) => spawnSync("git", ["-C", bare, ...a], { encoding: "utf8" }).stdout;
  return { svc, pub, own, app, login, published, recorded, lines, gh, git, tick: (ms: number) => (clock += ms) };
}

describe("learnings repositories", () => {
  test("publishes <login>/lineage-learnings with Verified, batched, rate-limited commits; app agents await a publisher", async () => {
    const w = world();
    for (let i = 1; i <= 3; i++) w.published.push(episode(w.own, i));
    w.published.push(episode(w.app, 4));
    const s1 = await w.pub.tick();
    expect(s1.agents).toBe(2);
    expect(s1.awaiting).toEqual([w.app]);
    expect(s1.published).toEqual([{ agent: w.own, repo: `${w.login}/lineage-learnings`, episodes: 3, commit: expect.any(String), verified: true }]);
    const files = w.git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n").sort();
    expect(files).toEqual(["LICENSES.md", "README.md", ...[1, 2, 3].map((i) => `episodes/${LIN}/${i.toString(16).padStart(64, "0")}.json`), `episodes/${LIN}/lessons.md`].sort());
    expect(w.git("cat-file", "commit", "HEAD")).toContain("BEGIN SSH SIGNATURE");
    expect(w.git("log", "-1", "--format=%ae")).toContain("4242+wrenacct@users.noreply.github.com");
    const readme = w.git("show", "HEAD:README.md");
    expect(readme).toContain("anthropic: 2 episodes");
    expect(readme).toContain("no model (scripted author): 1 episode");
    expect(readme).toContain("https://site.test/v1/learnings/schema");
    expect(readme + w.git("show", `HEAD:episodes/${LIN}/lessons.md`) + w.git("show", "HEAD:LICENSES.md")).not.toContain(EM_DASH);
    expect(JSON.parse(w.git("show", `HEAD:episodes/${LIN}/${"1".padStart(64, "0")}.json`)).seq).toBe(1);
    // the repositories are reported to Core
    expect(w.recorded.at(-1)!.find((r) => r.agent === w.own)).toMatchObject({ status: "published", url: `https://github.com/${w.login}/lineage-learnings`, episodes: 3, last_seq: 3, verified: true });
    expect(w.recorded.at(-1)!.find((r) => r.agent === w.app)).toMatchObject({ status: "awaiting publisher", url: null });

    // nothing new: no commit; new episodes inside 10 minutes: rate limited; after: one commit with them
    const n1 = w.git("rev-list", "--count", "HEAD").trim();
    w.tick(60_000);
    expect((await w.pub.tick()).unchanged).toBe(1);
    w.published.push(episode(w.own, 5));
    expect((await w.pub.tick()).rate_limited).toBe(1);
    expect(w.git("rev-list", "--count", "HEAD").trim()).toBe(n1);
    w.tick(LEARNINGS_MIN_INTERVAL_MS);
    const s3 = await w.pub.tick();
    expect(s3.published[0]!.episodes).toBe(4);
    expect(w.git("rev-list", "--count", "HEAD").trim()).toBe(String(Number(n1) + 1));
    expect(w.pub.record(w.own)!.last_seq).toBe(5);
    // no reserve or pool account was touched: only the agent's own token reached GitHub
    expect(w.lines.join("\n")).not.toContain("tok-");
  }, 60_000);

  test("a batch holds at most 200 episodes; the rest follow on the next run", async () => {
    const w = world();
    for (let i = 1; i <= 205; i++) w.published.push(episode(w.own, i));
    await w.pub.runAgent(w.own);
    expect(w.pub.record(w.own)!.last_seq).toBe(200);
    w.tick(LEARNINGS_MIN_INTERVAL_MS + 1);
    await w.pub.runAgent(w.own);
    expect(w.pub.record(w.own)!.last_seq).toBe(205);
    expect(w.git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n").filter((f) => f.endsWith(".json"))).toHaveLength(205);
  }, 60_000);

  test("rendering: lessons and the dataset card quote Core's figures only", () => {
    const l = { lineage_id: LIN, recipe: { name: "r", repo: "https://github.com/x/y", commit: "c" }, attempts: 1, targets: [{ target: "perf:ir", attempts: 1, outcomes: { no_candidate: 1 }, rejection_reasons: {}, accepted_effects: [], best: null, files_accepted: [], files_rejected: [], median_usd: null, usd_known: 0 }], journal: [], attribution: "x" };
    const md = renderLessons(l);
    expect(md).toContain("1 no candidate");
    expect(md).not.toContain("Median model spend");
    const card = renderCard({ name: null, agent: "A".repeat(32), site: null, core: null, rec: { providers: {}, episodes: 0, last_seq: 0 } as any, prefix: "" });
    expect(card).toContain("- none yet");
    expect(card).not.toContain(EM_DASH);
  });
});
