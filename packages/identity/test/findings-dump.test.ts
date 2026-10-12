import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillUnits } from "../../core/src/shared-findings.ts";
import { sshKeygen } from "../../souls/src/github/provision.ts";
import { DUMP_MIN_INTERVAL_MS, episodePath, FindingsDumpPublisher, type DumpReport, type DumpSources } from "../src/findings-dump.ts";
import { renderCard as learningsCard } from "../src/learnings.ts";
import { safeLog } from "../src/redact.ts";
import { IdentityService } from "../src/service.ts";
import { EncryptedStore, ensureKeyFile } from "../src/store.ts";

// The organisation's findings dump (docs/plans/AGENT-LEARNINGS.md 12.3) against a mocked GitHub API and
// real git (file:// bare repositories, real SSH signatures): units-agents/findings under the
// publisher's key, organised by unit and target, batched, rate limited, Verified, hidden agents out.

const tmp = mkdtempSync(join(tmpdir(), "units-dump-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const EM_DASH = String.fromCharCode(0x2014);

function ghMock(base: string) {
  const calls: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
    let m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && m) {
      const exists = spawnSync("test", ["-d", join(base, m[1]!, `${m[2]}.git`)]).status === 0;
      return exists ? j({ full_name: `${m[1]}/${m[2]}`, fork: false, archived: false, private: false, default_branch: "main" }) : j({ message: "Not Found" }, 404);
    }
    const orgRepos = /^\/orgs\/([^/]+)\/repos$/.exec(u.pathname);
    if (method === "POST" && orgRepos) {
      const b = JSON.parse(String(init.body));
      const dir = join(base, orgRepos[1]!, `${b.name}.git`);
      mkdirSync(join(base, orgRepos[1]!), { recursive: true });
      spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main", dir]);
      return j({ full_name: `${orgRepos[1]}/${b.name}`, default_branch: "main" }, 201);
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

const L1 = "1".repeat(64);
const L2 = "2".repeat(64);
const A = "A".repeat(43), B = "B".repeat(43), HID = "H".repeat(43);
function episode(seq: number, agent: string, over: Record<string, any> = {}) {
  const id = seq.toString(16).padStart(64, "0");
  const lineage = over.lineage ?? (seq % 3 ? L1 : L2);
  const outcome = over.outcome ?? (seq % 2 ? "accepted" : "rejected");
  return {
    schema: "lineage-episode/1", episode_id: id, seq, session_id: id, agent: { id: agent, name: agent === A ? "Wren" : "Neap" },
    model: { provider: seq % 2 ? "anthropic" : null }, outcome,
    task: { lineage_id: lineage, recipe: { name: lineage === L1 ? "base58-py" : "minbpe", class: "python", repo: lineage === L1 ? "https://github.com/keis/base58" : "https://github.com/karpathy/minbpe", commit: "2fae706" }, parent_gen_id: "9".repeat(64), parent_height: 3, target: { kind: "perf", target: lineage === L1 ? "encode_ir" : "train_ir" } },
    candidate: { status: over.status ?? outcome, reason: outcome === "rejected" ? "no_improvement" : null, gen_id: outcome === "accepted" ? "8".repeat(64) : null, finalized_at: 1_800_000_000_000 + seq, patch: "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b" },
    verdict: { outcome: outcome === "accepted" ? "accepted" : "rejected", reason: outcome === "rejected" ? "no_improvement" : null, detail: null, effect: { metric: "encode_ir", ratio: outcome === "accepted" ? 0.8 : 0.995 } },
    effect: { metric: "encode_ir", ratio: outcome === "accepted" ? 0.8 : 0.995, gain_pct: outcome === "accepted" ? 20 : 0.5 }, reward: { reverted: false },
    actions: [{ kind: "submit", reason: `idea ${seq}` }], times: { started_at: 1, ended_at: 2 },
    license: { spdx: "MIT", url: "https://example.test/LICENSE", source: "GitHub API", read_on: "2026-10-10" }, attribution: "Code excerpts from the repository, licensed MIT.",
    ...over,
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
    store, runDir: join(d, "run"), site: "https://site.test", since: 1_799_999_000, soulWaitS: 0, apiBase: "https://api.test", fetch: gh.fetch as never,
    log: safeLog("t", (l) => lines.push(l)), now: () => new Date(clock),
    chain: { launches: async () => [], agentLaunch: async () => null as never, agent: async () => null }, soul: async () => null,
  });
  const kp = sshKeygen(mkdtempSync(join(tmp, "pk")), "publisher");
  const setPublisher = () => store.put("publisher", "app", { v: 1, login: "unitsdotgg", github_id: 77, token: "tok-unitsdotgg", ssh_private_key: readFileSync(kp.privatePath, "utf8"), ssh_public_key: kp.publicKey, ssh_signing_key_id: 1, scopes: null, set_at: "", owner: "units-agents" });
  // Core's published episodes of listed agents (what GET /v1/learnings/* would serve)
  const published: any[] = [];
  const hidden = new Set<string>();
  const reports: DumpReport[] = [];
  const unitsCalls: number[] = [];
  const listed = () => published.filter((e) => !hidden.has(e.agent.id));
  const sources: DumpSources = {
    episodes: async (since, limit) => {
      const all = listed().filter((e) => e.seq > since);
      return { episodes: all.slice(0, limit), next_since: all.slice(0, limit).at(-1)?.seq ?? since, more: all.length > limit };
    },
    units: async (until) => (unitsCalls.push(until), { units: distillUnits(listed().filter((e) => e.seq <= until)), last_seq: until }),
    agents: async () => [...new Set(listed().map((e) => e.agent.id))].map((a) => ({ agent: a, episodes: 0, last_seq: 0 })),
    repos: async () => [{ agent: A, status: "published", repo: "wrenacct/units-learnings", url: "https://github.com/wrenacct/units-learnings" }],
    record: async (r) => void reports.push(r),
  };
  const pub = new FindingsDumpPublisher({ svc, sources, site: "https://site.test", apiBase: "https://api.test", gitBase: `file://${base}`, fetch: gh.fetch as never, log: safeLog("t", (l) => lines.push(l)), now: () => new Date(clock), verifyPolls: 1 });
  const bare = join(base, "units-agents", "findings.git");
  const git = (...a: string[]) => spawnSync("git", ["-C", bare, ...a], { encoding: "utf8" }).stdout;
  return { svc, pub, published, hidden, reports, unitsCalls, lines, gh, git, setPublisher, tick: (ms: number) => (clock += ms) };
}

describe("findings dump", () => {
  test("no publisher: skipped, nothing sent to GitHub", async () => {
    const w = world();
    w.published.push(episode(1, A));
    expect((await w.pub.run()).result).toBe("skipped");
    expect(w.gh.calls).toEqual([]);
  });

  test("units-agents/findings: every listed agent by unit and target, Verified, batched, rate limited, reported to Core", async () => {
    const w = world();
    w.setPublisher();
    for (let i = 1; i <= 205; i++) w.published.push(episode(i, i % 4 ? A : B));
    // never final: Core would not serve it, and the publisher drops it if it did
    w.published.push(episode(206, B, { status: "revealed", actions: [{ kind: "submit", reason: "OPEN_CANDIDATE_SECRET" }] }));
    const s1 = await w.pub.run();
    expect(s1).toMatchObject({ result: "published", added: 200, removed: 0, last_seq: 200, more: true, verified: true, repo: "units-agents/findings" });
    expect(w.gh.calls).toContain("POST /orgs/units-agents/repos");
    // the lessons are Core's view at the commit's cursor
    expect(w.unitsCalls.at(-1)).toBe(200);
    const files = w.git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
    expect(files).toContain("README.md");
    expect(files).toContain("index.json");
    expect(files).toContain("LICENSES.md");
    expect(files).toContain("findings/base58-py-11111111/README.md");
    expect(files).toContain("findings/base58-py-11111111/perf-encode_ir/LESSONS.md");
    expect(files).toContain("findings/minbpe-22222222/perf-train_ir/LESSONS.md");
    expect(files.filter((f) => f.endsWith(".json") && f.startsWith("findings/"))).toHaveLength(200);
    expect(files).toContain(episodePath(episode(1, A)));
    expect(w.git("cat-file", "commit", "HEAD")).toContain("BEGIN SSH SIGNATURE");
    expect(w.git("log", "-1", "--format=%ae")).toContain("77+unitsdotgg@users.noreply.github.com");
    const readme = w.git("show", "HEAD:README.md");
    expect(readme).toContain("200 episodes from 2 agents on 2 units, up to Core cursor 200");
    expect(readme).toContain("its own learnings repository: https://github.com/wrenacct/units-learnings");
    expect(readme).toContain("https://site.test/v1/learnings/units");
    expect(readme).toContain("CC BY 4.0");
    const lessons = w.git("show", "HEAD:findings/base58-py-11111111/perf-encode_ir/LESSONS.md");
    expect(lessons).toContain("## What worked");
    expect(lessons).toContain("## What failed and why");
    expect(lessons).toContain("no_improvement");
    expect(lessons).toContain("Wren (`AAAAAAAA`)");
    const index = JSON.parse(w.git("show", "HEAD:index.json"));
    expect(index.episodes).toHaveLength(200);
    expect(index.episodes[0]).toMatchObject({ seq: 1, agent: A, unit: "base58-py-11111111", target: "perf:encode_ir", outcome: "accepted", provider: "anthropic" });
    const all = files.filter((f) => !f.endsWith(".json") || f === "index.json").map((f) => w.git("show", `HEAD:${f}`)).join("\n");
    expect(all).not.toContain(EM_DASH);
    expect(w.reports.at(-1)).toMatchObject({ status: "published", url: "https://github.com/units-agents/findings", episodes: 200, units: 2, agents: 2, last_seq: 200, verified: true });
    // the commit message counts what the commit holds (the index is built inside plan())
    expect(w.git("log", "-1", "--format=%B")).toContain("2 units, 200 episodes in all.");

    // the rest inside 10 minutes: rate limited; after: one more commit with them, never the open one
    const n1 = Number(w.git("rev-list", "--count", "HEAD").trim());
    w.tick(60_000);
    expect((await w.pub.run()).result).toBe("rate_limited");
    w.tick(DUMP_MIN_INTERVAL_MS);
    const s2 = await w.pub.run();
    expect(s2).toMatchObject({ result: "published", added: 5, episodes: 205 });
    expect(Number(w.git("rev-list", "--count", "HEAD").trim())).toBe(n1 + 1);
    expect(w.git("log", "-1", "--format=%B")).toContain("205 episodes in all.");
    const tree = w.git("ls-tree", "-r", "--name-only", "HEAD");
    expect(tree).not.toContain("0".repeat(62) + "ce"); // seq 206 (0xce)
    expect(w.git("grep", "-c", "OPEN_CANDIDATE_SECRET", "HEAD")).toBe("");
    // nothing new: no commit, no GitHub write
    w.tick(DUMP_MIN_INTERVAL_MS);
    expect((await w.pub.run()).result).toBe("unchanged");
    expect(Number(w.git("rev-list", "--count", "HEAD").trim())).toBe(n1 + 1);
    expect(w.lines.join("\n")).not.toContain("tok-");
  }, 60_000);

  test("an agent hidden after its episodes were written: its files leave the repository", async () => {
    const w = world();
    w.setPublisher();
    for (let i = 1; i <= 6; i++) w.published.push(episode(i, i <= 3 ? A : HID));
    await w.pub.run();
    expect(JSON.parse(w.git("show", "HEAD:index.json")).episodes).toHaveLength(6);
    w.hidden.add(HID);
    w.tick(DUMP_MIN_INTERVAL_MS + 1);
    const s = await w.pub.run();
    expect(s).toMatchObject({ result: "published", removed: 3, episodes: 3 });
    const files = w.git("ls-tree", "-r", "--name-only", "HEAD");
    for (let i = 4; i <= 6; i++) expect(files).not.toContain(episodePath(episode(i, HID)));
    expect(JSON.parse(w.git("show", "HEAD:index.json")).episodes.map((x: any) => x.agent)).toEqual([A, A, A]);
    expect(w.git("show", "HEAD:README.md")).not.toContain(HID);
  }, 60_000);

  test("each agent's own learnings card points at the dump", () => {
    const card = learningsCard({ name: null, agent: A, site: null, core: null, rec: { providers: {}, episodes: 0, last_seq: 0 } as any, prefix: "" });
    expect(card).toContain("https://github.com/units-agents/findings");
  });
});
