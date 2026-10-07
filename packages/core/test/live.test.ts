import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHunks, GitTreeSource, type TreeSource } from "../src/trees.ts";
import { H, canonicalJson, parseDiff, sha256Hex, type Recipe } from "../src/protocol.ts";
import { CAPS, ROOT, RECIPE, agentClient, diff, expectOk, makeAuthor, result, runReplays, honest, setup, submit, type Env } from "./helpers.ts";

// Live activity and heartbeats (SPEC 17.1).

const SRC = "fn a() {\n    slow_a_0();\n}\nfn b() {}\n";
const FILES = new Set(["src/lib.rs", "src/util.rs", "Cargo.toml"]);
class FakeTrees implements TreeSource {
  listFiles(_r: Recipe, _c: string, patches: string[]) {
    const s = new Set(FILES);
    for (const p of patches) for (const d of parseDiff(p)) s.add((d.newPath ?? d.oldPath)!);
    return s;
  }
  file(_r: Recipe, _c: string, patches: string[], path: string) {
    if (!FILES.has(path)) return { path, exists: false, source: "absent" as const, text: null, sha256: null, lines: null };
    let text = path === "src/lib.rs" ? SRC : `// ${path}\n`;
    let touched = false;
    for (const p of patches) for (const d of parseDiff(p)) if (d.newPath === path) ((text = applyHunks(text, d.hunks)), (touched = true));
    return { path, exists: true, source: touched ? ("patched" as const) : ("snapshot" as const), text, sha256: sha256Hex(text), lines: text.split("\n").length - 1 };
  }
}

let env: Env;
afterEach(() => env?.close());

async function liveEnv(over: Record<string, unknown> = {}) {
  env = await setup({ verifiers: 3, over: { heartbeat_s: 10, activity_rate: 50, ...over } });
  (env.core.live as unknown as { trees: TreeSource }).trees = new FakeTrees();
  const lin = (await env.anon.get(`/v1/lineages/${env.lineage}`)).body;
  return { lin, commit: lin.snapshot.commit_sha as string };
}

const ev = (lin: any, over: Record<string, unknown>) => ({ lineage_id: lin.lineage_id, gen_id: lin.tip, commit: lin.snapshot.commit_sha, ...over });

describe("activity", () => {
  test("accepts real events, checks the path against the generation tree, lists them publicly", async () => {
    const { lin } = await liveEnv();
    const author = await makeAuthor(env);
    const r = await expectOk(
      author.c.post("/v1/activity", {
        events: [
          ev(lin, { kind: "read", path: "src/lib.rs", start_line: 1, end_line: 3, content_sha256: sha256Hex(SRC) }),
          ev(lin, { kind: "search", query: "slow_" }),
          ev(lin, { kind: "edit", path: "src/lib.rs", start_line: 2, end_line: 2 }),
          ev(lin, { kind: "evaluate", target: "ir" }),
        ],
      }),
    );
    expect(r.accepted).toBe(4);
    expect(r.refused).toEqual([]);
    const list = await expectOk<any[]>(env.anon.get(`/v1/activity?lineage=${env.lineage}`));
    expect(list.map((e) => e.kind)).toEqual(["evaluate", "edit", "search", "read"]);
    expect(list[3].path_checked).toBe(true);
    expect(list[3].content_sha256).toBe(sha256Hex(SRC));
    const evs = env.core.events(0, 5000).filter((e) => e.type === "activity");
    expect(evs.length).toBe(1);
    expect((evs[0]!.data as any).count).toBe(4);
    const live = await expectOk(env.anon.get("/v1/live"));
    const ch = live.channels.find((c: any) => c.lineage_id === env.lineage);
    expect(ch.status).toBe("active");
    expect(ch.last.kind).toBe("evaluate");
    expect(ch.last_file.kind).toBe("edit");
    env.clock.advance(31_000);
    const later = await expectOk(env.anon.get("/v1/live"));
    const ch2 = later.channels.find((c: any) => c.lineage_id === env.lineage);
    expect(ch2.status).toBe("idle");
    expect(ch2.idle_since).toBe(ch.last.received_at);
  });

  test("refuses unknown objects, unknown fields and paths outside the tree", async () => {
    const { lin } = await liveEnv();
    const author = await makeAuthor(env);
    const r = await expectOk(
      author.c.post("/v1/activity", {
        events: [
          ev(lin, { kind: "read", path: "src/lib.rs", start_line: 1, end_line: 2 }),
          ev(lin, { kind: "read", lineage_id: "f".repeat(64), path: "src/lib.rs" }),
          ev(lin, { kind: "read", gen_id: "e".repeat(64), path: "src/lib.rs" }),
          ev(lin, { kind: "read", commit: "a".repeat(40), path: "src/lib.rs" }),
          ev(lin, { kind: "edit", path: "src/lib.rs", start_line: 2, end_line: 2, new_string: "fast()" }),
          ev(lin, { kind: "read", path: "src/missing.rs" }),
          ev(lin, { kind: "read", path: "../etc/passwd" }),
          ev(lin, { kind: "edit" }),
          ev(lin, { kind: "read", path: "src/lib.rs", query: "x" }),
          ev(lin, { kind: "teleport" }),
          ev(lin, { kind: "read", path: "src/lib.rs", start_line: 5, end_line: 2 }),
        ],
      }),
    );
    expect(r.accepted).toBe(1);
    expect(r.refused.map((x: any) => x.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.refused.find((x: any) => x.index === 4).error).toContain("unknown field new_string");
    expect(r.refused.find((x: any) => x.index === 5).error).toContain("not in this generation's tree");
    const all = await author.c.post("/v1/activity", { events: [ev(lin, { kind: "read", lineage_id: "f".repeat(64), path: "src/lib.rs" })] });
    expect(all.status).toBe(400);
    const anon = agentClient(env);
    const unreg = await anon.c.post("/v1/activity", { events: [ev(lin, { kind: "search", query: "x" })] });
    expect(unreg.status).toBe(403);
  });

  test("rate limit is activity_rate events per agent per minute", async () => {
    const { lin } = await liveEnv({ activity_rate: 5 });
    const author = await makeAuthor(env);
    const batch = (n: number) => ({ events: Array.from({ length: n }, (_, i) => ev(lin, { kind: "search", query: `q${i}` })) });
    const r = await expectOk(author.c.post("/v1/activity", batch(7)));
    expect(r.accepted).toBe(5);
    expect(r.refused.filter((x: any) => x.error === "rate_limited").length).toBe(2);
    const again = await author.c.post("/v1/activity", batch(1));
    expect(again.status).toBe(429);
    env.clock.advance(61_000);
    expect((await expectOk(author.c.post("/v1/activity", batch(1)))).accepted).toBe(1);
  });
});

describe("heartbeats", () => {
  test("awake window, totals, capability digest", async () => {
    await liveEnv();
    const v = env.verifiers[0]!;
    const digest = H("caps", canonicalJson(CAPS));
    const m = await expectOk(v.c.post("/v1/heartbeat", { job: "idle", caps_digest: digest, load: { load1: 1.5, load5: 1.2, load15: 1, mem_free_mb: 2048 } }));
    expect(m.awake).toBe(true);
    expect(m.caps_match).toBe(true);
    expect(m.capabilities.cpus).toBe(CAPS.cpus);
    expect((await v.c.post("/v1/heartbeat", { job: "idle" })).status).toBe(429);
    let stats = await expectOk(env.anon.get("/v1/stats"));
    expect(stats.machines).toBe(1);
    expect(stats.machines_awake).toBe(1);
    env.clock.advance(31_000);
    stats = await expectOk(env.anon.get("/v1/stats"));
    expect(stats.machines_awake).toBe(0);
    const live = await expectOk(env.anon.get("/v1/live"));
    expect(live.totals).toMatchObject({ machines: 1, awake: 0 });
    expect((await v.c.post("/v1/heartbeat", { job: "idle", lineage_id: env.lineage })).status).toBe(400);
    expect((await v.c.post("/v1/heartbeat", { job: "idle", phase: "dancing" })).status).toBe(400);
    expect((await v.c.post("/v1/heartbeat", { job: "replay", replay_id: "a".repeat(64) })).status).toBe(404);
  });

  test("a sealed replay never exposes its candidate before the candidate is final", async () => {
    await liveEnv();
    const author = await makeAuthor(env);
    const c = await submit(env, author, diff("seal"));
    expect(c.status).toBe("replaying");
    const replayers = env.verifiers.filter(() => true);
    let beat = 0;
    for (const v of replayers) {
      const asg = (await expectOk<any[]>(v.c.get("/v1/assignments", true))).find((a) => a.candidate?.candidate_id === c.candidate_id);
      if (!asg) continue;
      beat++;
      const m = await expectOk(v.c.post("/v1/heartbeat", { job: "replay", replay_id: asg.replay_id, phase: "build", container_started_at: env.clock.now(), job_started_at: env.clock.now() }));
      expect(m.sealed).toBe(true);
      expect(m.candidate_id).toBeNull();
      expect(m.lineage_id).toBeNull();
      expect(m.gen_id).toBeNull();
      expect(m.class).toBe("rust");
      // another agent cannot claim someone else's replay
      const other = env.verifiers.find((x) => x.id !== v.id)!;
      expect((await other.c.post("/v1/heartbeat", { job: "replay", replay_id: asg.replay_id })).status).toBe(404);
    }
    expect(beat).toBeGreaterThanOrEqual(2);
    const publicText = async () =>
      JSON.stringify([
        (await env.anon.get("/v1/live")).body,
        (await env.anon.get("/v1/heartbeats")).body,
        (await env.anon.get("/v1/activity")).body,
        env.core.events(0, 5000).filter((e) => e.type === "machine.heartbeat" || e.type === "activity"),
      ]);
    const before = await publicText();
    expect(before).not.toContain(c.candidate_id);
    expect(before).not.toContain(c.commit_id);
    await runReplays(env, c.candidate_id, honest(result()));
    const fin = (await env.anon.get(`/v1/candidates/${c.candidate_id}`)).body;
    expect(fin.status).toBe("accepted");
    env.clock.advance(1500);
    const machines = await expectOk<any[]>(env.anon.get("/v1/heartbeats"));
    const opened = machines.filter((m) => m.job === "replay");
    expect(opened.length).toBe(beat);
    for (const m of opened) {
      expect(m.sealed).toBe(false);
      expect(m.candidate_id).toBe(c.candidate_id);
      expect(m.outcome).toBe("accepted");
      expect(m.gain.ratio).toBeCloseTo(0.9, 6);
      expect(m.height).toBe(0);
    }
    const stats = await expectOk(env.anon.get("/v1/stats"));
    expect(stats.verified_gains).toBe(1);
  });

  test("author heartbeats name a lineage and generation; only launched agents author", async () => {
    const { lin } = await liveEnv();
    const author = await makeAuthor(env);
    const m = await expectOk(author.c.post("/v1/heartbeat", { job: "author", phase: "propose", lineage_id: lin.lineage_id, gen_id: lin.tip, job_started_at: env.clock.now() }));
    expect(m).toMatchObject({ job: "author", phase: "propose", lineage_id: lin.lineage_id, gen_id: lin.tip, height: 0, recipe_name: RECIPE.name, sealed: false });
    const live = await expectOk(env.anon.get("/v1/live"));
    expect(live.channels[0].status).toBe("active");
    expect(live.channels[0].authors_awake.length).toBe(1);
    const v = env.verifiers[0]!;
    expect((await v.c.post("/v1/heartbeat", { job: "author", lineage_id: lin.lineage_id, gen_id: lin.tip })).status).toBe(403);
  });
});

describe("file at a generation and runway", () => {
  test("file endpoint serves the tree at a generation, patched", async () => {
    const { lin } = await liveEnv();
    const g0 = await expectOk(env.anon.get(`/v1/lineages/${env.lineage}/file?path=src/lib.rs`));
    expect(g0).toMatchObject({ source: "snapshot", sha256: sha256Hex(SRC), lines: 4, text: SRC, height: 0 });
    const author = await makeAuthor(env);
    const c = await submit(env, author, diff("a"));
    await runReplays(env, c.candidate_id, honest(result()));
    const tip = (await env.anon.get(`/v1/lineages/${env.lineage}`)).body.tip;
    const g1 = await expectOk(env.anon.get(`/v1/lineages/${env.lineage}/file?gen=${tip}&path=src/lib.rs`));
    expect(g1.source).toBe("patched");
    expect(g1.text).toContain("fast_a_0();");
    expect(g1.height).toBe(1);
    expect((await env.anon.get(`/v1/lineages/${env.lineage}/file?gen=${lin.tip}&path=src/lib.rs`)).body.text).toBe(SRC);
    expect((await env.anon.get(`/v1/lineages/${env.lineage}/file?path=src/nope.rs`)).status).toBe(404);
    expect((await env.anon.get(`/v1/lineages/${env.lineage}/file?path=../x`)).status).toBe(400);
  });

  test("runway is vault over mean hourly debit, only when both exist", async () => {
    await liveEnv();
    const author = await makeAuthor(env);
    expect((await expectOk(env.anon.get(`/v1/agents/${author.id}`))).runway).toBeNull();
    await expectOk(env.admin.c.post("/v1/admin/usage", { agent: author.id, amount: "1000000", model_tokens: 10, sandbox_seconds: 5 }));
    const a = await expectOk(env.anon.get(`/v1/agents/${author.id}`));
    const perHour = (1_000_000 * 3600) / env.cfg.epoch_length_s;
    expect(a.runway.debited).toBe("1000000");
    expect(Number(a.runway.per_hour)).toBe(Math.round(perHour));
    expect(a.runway.hours).toBeCloseTo(Number(a.compute) / perHour, 6);
    const stats = await expectOk(env.anon.get("/v1/stats"));
    expect(BigInt(stats.compute.vaults)).toBeGreaterThanOrEqual(BigInt(a.compute));
    expect(stats.compute.debited).toBe("1000000");
  });
});

describe("trees", () => {
  test("applyHunks matches git apply on the real fixture, and GitTreeSource rebuilds patched files", () => {
    const recipeYml = Bun.YAML.parse(readFileSync(join(ROOT, "recipes/fixture-b58/recipe.yml"), "utf8")) as Recipe;
    const src = new GitTreeSource();
    const patch = readFileSync(join(ROOT, "fixtures/b58-patches/perf_encode.diff"), "utf8");
    const list = src.listFiles(recipeYml, recipeYml.commit, [patch]);
    expect(list).not.toBeNull();
    expect(list!.has("src/lib.rs")).toBe(true);
    expect(list!.has("Cargo.lock")).toBe(true); // a prepare output: known path, no bytes
    const base = src.file(recipeYml, recipeYml.commit, [], "src/lib.rs")!;
    expect(base.source).toBe("snapshot");
    expect(base.text).toBe(readFileSync(join(ROOT, "fixtures/b58/src/lib.rs"), "utf8"));
    const patched = src.file(recipeYml, recipeYml.commit, [patch], "src/lib.rs")!;
    // reference: git apply in a scratch repo
    const dir = mkdtempSync(join(tmpdir(), "lineage-trees-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      Bun.spawnSync(["mkdir", "-p", "src"], { cwd: dir });
      Bun.write(join(dir, "src/lib.rs"), base.text!);
      Bun.spawnSync(["sh", "-c", "sleep 0.05"]);
      const p = Bun.spawnSync(["git", "apply", "-"], { cwd: dir, stdin: Buffer.from(patch) });
      expect(p.exitCode).toBe(0);
      expect(patched.text).toBe(readFileSync(join(dir, "src/lib.rs"), "utf8"));
      expect(patched.source).toBe("patched");
      expect(patched.sha256).toBe(sha256Hex(patched.text!));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(src.file(recipeYml, recipeYml.commit, [], "Cargo.lock")!.source).toBe("prepare_output");
    expect(src.file(recipeYml, recipeYml.commit, [], "nope.rs")!.exists).toBe(false);
  });

  test("a rebased series (perf_decode written against gen 0) rebuilds exactly as sequential git apply", () => {
    const recipeYml = Bun.YAML.parse(readFileSync(join(ROOT, "recipes/fixture-b58/recipe.yml"), "utf8")) as Recipe;
    const series = ["perf_encode", "fix_leading_ones", "perf_decode"].map((n) => readFileSync(join(ROOT, `fixtures/b58-patches/${n}.diff`), "utf8"));
    const src = new GitTreeSource();
    const dir = mkdtempSync(join(tmpdir(), "lineage-trees-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      Bun.spawnSync(["mkdir", "-p", "src"], { cwd: dir });
      require("node:fs").writeFileSync(join(dir, "src/lib.rs"), readFileSync(join(ROOT, "fixtures/b58/src/lib.rs")));
      for (const p of series) expect(Bun.spawnSync(["git", "apply", "-"], { cwd: dir, stdin: Buffer.from(p) }).exitCode).toBe(0);
      expect(src.file(recipeYml, recipeYml.commit, series, "src/lib.rs")!.text).toBe(readFileSync(join(dir, "src/lib.rs"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("applyHunks handles additions, deletions and missing final newlines", () => {
    expect(applyHunks(null, ["@@ -0,0 +1,2 @@", "+a", "+b"])).toBe("a\nb\n");
    expect(applyHunks("a\nb\nc\n", ["@@ -1,3 +1,2 @@", " a", "-b", " c"])).toBe("a\nc\n");
    expect(applyHunks("a\nb", ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"])).toBe("a\nc");
    expect(() => applyHunks("x\n", ["@@ -1,1 +1,1 @@", "-y", "+z"])).toThrow();
    // a rebased patch: the hunk says line 2 but the block now sits at line 5, as git apply finds it
    expect(applyHunks("p\nq\nr\na\nb\nc\n", ["@@ -2,3 +2,3 @@", " a", "-b", "+B", " c"])).toBe("p\nq\nr\na\nB\nc\n");
  });
});
