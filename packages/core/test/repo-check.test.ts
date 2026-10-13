import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateAgentKey } from "../src/protocol.ts";
import { archiveUrl, repoCheckOf, TooLarge, unpackArchive, type RepoWork } from "../src/repo-check.ts";
import { recipeProposalsOf } from "../src/recipe-proposals.ts";
import { bare, expectOk, makeAuthor, RECIPE, setup } from "./helpers.ts";

// The repository check before a launch (GET /v1/repo-check): the answer for every kind of repository,
// that a reading never runs twice for one head commit, and the bounds of the download.

let env: { close(): void } | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const PY_TESTS = { "pkg/core.py": "def f(): return 1\n", "tests/test_core.py": "def test_f(): pass\n", "tests/test_more.py": "def test_g(): pass\n", "test_top.py": "def test_h(): pass\n" };
const RS_TESTS = { "src/lib.rs": "pub fn f() {}\n", "tests/a.rs": "#[test]\nfn a() {}\n" };

/** A stand-in for the network: each repository's head and files, and what was asked of it. */
function fakeWork(repos: Record<string, { head: string; files?: Record<string, string>; fail?: string; large?: boolean; slow?: Promise<void> }>) {
  const asked = { head: [] as string[], tree: [] as string[] };
  const work: RepoWork = {
    async head(repo) {
      asked.head.push(repo);
      const r = repos[repo];
      if (!r || r.fail) throw new Error(r?.fail ?? "the repository could not be read (it must be public and have a default branch)");
      return r.head;
    },
    async tree(repo, commit, dir) {
      asked.tree.push(`${repo}@${commit}`);
      const r = repos[repo]!;
      await r.slow;
      if (r.large) throw new TooLarge("big");
      for (const [p, c] of Object.entries(r.files ?? {})) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), c);
      }
    },
  };
  return { work, asked, repos };
}

const check = (e: { anon: { get(p: string): Promise<{ status: number; body: any }> } }, repo: string) => expectOk<any>(e.anon.get(`/v1/repo-check?repo=${encodeURIComponent(repo)}`));

describe("repository check", () => {
  test("a repository with an active unit is ready, and nothing is fetched", async () => {
    const e = await setup({ verifiers: 0 });
    env = e;
    const f = fakeWork({});
    repoCheckOf(e.core).work = f.work;
    expect(await check(e, RECIPE.repo)).toEqual({ repo: RECIPE.repo, head: null, checked_at: null, state: "ready", units: 1 });
    // the address as a person types it is the same repository
    expect((await check(e, `${RECIPE.repo}.git`)).state).toBe("ready");
    expect(f.asked).toEqual({ head: [], tree: [] });
  });

  test("tests in a language with a verifier here: can set up, with how many test files and where", async () => {
    const e = await setup({ verifiers: 0 });
    env = e;
    const f = fakeWork({ "https://github.com/o/rs": { head: HEAD_A, files: RS_TESTS } });
    repoCheckOf(e.core).work = f.work;
    const r = await check(e, "https://github.com/o/rs");
    expect(r).toEqual({ repo: "https://github.com/o/rs", head: HEAD_A, checked_at: e.clock.now(), state: "can_set_up", class: "rust", language: "Rust", tests: 1, tests_in: ["tests"], setup_minutes: null, setups: 0 });
  });

  test("where the tests are: top folders by count, a file at the top as itself", async () => {
    const e = await setup({ verifiers: 0 });
    env = e;
    // a Python unit exists here, so a verifier can be qualified for Python
    e.core.db.query("UPDATE recipes SET json = replace(json, '\"class\":\"rust\"', '\"class\":\"python\"')").run();
    repoCheckOf(e.core).work = fakeWork({ "https://github.com/o/py": { head: HEAD_A, files: PY_TESTS } }).work;
    expect(await check(e, "https://github.com/o/py")).toMatchObject({ state: "can_set_up", language: "Python", tests: 3, tests_in: ["tests", "test_top.py"] });
  });

  test("no tests: cannot, with the reading's reason", async () => {
    const e = await setup({ verifiers: 0 });
    env = e;
    repoCheckOf(e.core).work = fakeWork({ "https://github.com/o/none": { head: HEAD_A, files: { "src/lib.rs": "pub fn f() {}\n" } } }).work;
    expect(await check(e, "https://github.com/o/none")).toMatchObject({ state: "cannot", cause: "tests", class: "rust", language: "Rust", gpu: [], reason: "it has no tests, and a unit needs the repository's own tests to check every change" });
  });

  test("no tests and code that calls a GPU: cannot, with the files", async () => {
    const e = bare();
    env = e;
    repoCheckOf(e.core).work = fakeWork({ "https://github.com/karpathy/autoresearch": { head: HEAD_A, files: { "train.py": "import torch\nmodel.cuda()\n", "prepare.py": "x = torch.cuda.is_available()\n" } } }).work;
    const r = await check(e, "https://github.com/karpathy/autoresearch");
    expect(r).toMatchObject({ state: "cannot", cause: "tests", language: "Python", gpu: ["prepare.py", "train.py"] });
    expect(r.reason).toContain("calls CUDA (a GPU) in prepare.py and train.py");
  });

  test("a language with no toolchain image: cannot, with what the tree mostly holds", async () => {
    const e = bare();
    env = e;
    repoCheckOf(e.core).work = fakeWork({ "https://github.com/o/js": { head: HEAD_A, files: { "index.js": "x", "lib/a.js": "y", "README.md": "z" } } }).work;
    expect(await check(e, "https://github.com/o/js")).toMatchObject({ state: "cannot", cause: "language", class: null, language: null, seen: ".js" });
  });

  test("tests in a language no unit here is written in: cannot, no verifier", async () => {
    const e = await setup({ verifiers: 0 }); // the one unit here is Rust
    env = e;
    repoCheckOf(e.core).work = fakeWork({ "https://github.com/o/py": { head: HEAD_A, files: PY_TESTS } }).work;
    expect(await check(e, "https://github.com/o/py")).toMatchObject({ state: "cannot", cause: "verifier", class: "python", language: "Python", reason: "this network has no Python unit yet, so no verifier is qualified to calibrate one" });
  });

  test("an address that is not a repository on a known host: cannot, nothing fetched; no address at all is refused", async () => {
    const e = bare();
    env = e;
    const f = fakeWork({});
    repoCheckOf(e.core).work = f.work;
    expect(await check(e, "https://example.com/o/r")).toMatchObject({ state: "cannot", cause: "address" });
    expect((await e.anon.get("/v1/repo-check")).status).toBe(400);
    expect(f.asked.head).toEqual([]);
  });

  test("the check itself failing is unknown, never cannot; it is not retried for a minute", async () => {
    const e = bare();
    env = e;
    const f = fakeWork({ "https://github.com/o/down": { head: HEAD_A, fail: "the repository could not be read (it must be public and have a default branch)" } });
    repoCheckOf(e.core).work = f.work;
    const r = await check(e, "https://github.com/o/down");
    expect(r).toEqual({ repo: "https://github.com/o/down", head: null, checked_at: null, state: "unknown", why: "the repository could not be read (it must be public and have a default branch)" });
    await check(e, "https://github.com/o/down");
    expect(f.asked.head.length).toBe(1);
    e.clock.advance(61_000);
    await check(e, "https://github.com/o/down");
    expect(f.asked.head.length).toBe(2);
  });

  test("one reading per head commit: asked again it is answered from the table, a new head is read once", async () => {
    const e = await setup({ verifiers: 0 });
    env = e;
    const f = fakeWork({ "https://github.com/o/rs": { head: HEAD_A, files: RS_TESTS } });
    const rc = repoCheckOf(e.core);
    rc.work = f.work;
    const first = await check(e, "https://github.com/o/rs");
    for (let i = 0; i < 5; i++) expect(await check(e, "https://github.com/o/rs")).toEqual(first);
    // within a minute the head is not even asked for again
    expect(f.asked).toEqual({ head: ["https://github.com/o/rs"], tree: [`https://github.com/o/rs@${HEAD_A}`] });
    // later, same head: the head is asked for, the tree is not read again
    e.clock.advance(120_000);
    expect(await check(e, "https://github.com/o/rs")).toEqual(first);
    expect(f.asked.head.length).toBe(2);
    expect(f.asked.tree.length).toBe(1);
    // a new head commit (its tests removed): one new reading, and the stored row is replaced
    f.repos["https://github.com/o/rs"] = { head: HEAD_B, files: { "src/lib.rs": "pub fn f() {}\n" } };
    e.clock.advance(120_000);
    expect(await check(e, "https://github.com/o/rs")).toMatchObject({ head: HEAD_B, state: "cannot", cause: "tests" });
    expect(f.asked.tree).toEqual([`https://github.com/o/rs@${HEAD_A}`, `https://github.com/o/rs@${HEAD_B}`]);
    expect(rc.readings).toBe(2);
    expect(e.core.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM repo_checks").get()!.n).toBe(1);
  });

  test("a reading that takes long answers checking; every asker shares the one reading", async () => {
    const e = await setup({ verifiers: 0 });
    env = e;
    let release!: () => void;
    const f = fakeWork({ "https://github.com/o/slow": { head: HEAD_A, files: RS_TESTS, slow: new Promise<void>((r) => (release = r)) } });
    const rc = repoCheckOf(e.core);
    rc.work = f.work;
    rc.bounds.wait_ms = 30;
    expect(await check(e, "https://github.com/o/slow")).toEqual({ repo: "https://github.com/o/slow", head: null, checked_at: null, state: "checking" });
    expect((await check(e, "https://github.com/o/slow")).state).toBe("checking");
    release();
    rc.bounds.wait_ms = 2000;
    expect((await check(e, "https://github.com/o/slow")).state).toBe("can_set_up");
    expect(f.asked.tree.length).toBe(1);
  });

  test("a repository too large to read is unknown, remembered for its head and not fetched again", async () => {
    const e = bare();
    env = e;
    const f = fakeWork({ "https://github.com/o/huge": { head: HEAD_A, large: true } });
    repoCheckOf(e.core).work = f.work;
    expect(await check(e, "https://github.com/o/huge")).toMatchObject({ state: "unknown", why: "the repository is too large to read here", head: HEAD_A });
    e.clock.advance(120_000);
    expect((await check(e, "https://github.com/o/huge")).state).toBe("unknown");
    expect(f.asked.tree.length).toBe(1);
  });

  test("a usual setup time is stated only from at least three recorded setups", async () => {
    const e = await setup({ verifiers: 0 });
    env = e;
    const rc = repoCheckOf(e.core);
    recipeProposalsOf(e.core);
    expect(rc.setupTime()).toEqual({ minutes: null, setups: 0 });
    const record = async (repo: string, minutes: number) => {
      const a = await makeAuthor(e, { repo, fees: 0n });
      const at = e.core.db.query<{ registered_at: number }, [string]>("SELECT registered_at FROM agents WHERE agent_id = ?").get(a.id)!.registered_at;
      e.core.db
        .query("INSERT INTO recipe_proposals (proposal_id, proposer, name, recipe_id, class, arch, repo, commit_sha, recipe, overlay, status, runs, created_at, decided_at) VALUES (?, ?, 'n', 'r', 'rust', 'arm64', ?, 'c', '{}', '{}', 'accepted', 3, ?, ?)")
        .run(generateAgentKey().id, a.id, repo, at, at + minutes * 60_000 - 1000);
    };
    await record("https://github.com/o/one", 12);
    await record("https://github.com/o/two", 30);
    expect(rc.setupTime()).toEqual({ minutes: null, setups: 2 });
    await record("https://github.com/o/three", 9);
    // the 80th percentile of 9, 12 and 30 minutes
    expect(rc.setupTime()).toEqual({ minutes: 30, setups: 3 });
    rc.work = fakeWork({ "https://github.com/o/rs": { head: HEAD_A, files: RS_TESTS } }).work;
    expect(await check(e, "https://github.com/o/rs")).toMatchObject({ state: "can_set_up", setup_minutes: 30, setups: 3 });
  });
});

describe("the source archive", () => {
  test("where each host serves one commit's archive", () => {
    expect(archiveUrl("https://github.com/o/r", HEAD_A)).toBe(`https://codeload.github.com/o/r/tar.gz/${HEAD_A}`);
    expect(archiveUrl("https://gitlab.com/o/r", HEAD_A)).toBe(`https://gitlab.com/o/r/-/archive/${HEAD_A}/r-${HEAD_A}.tar.gz`);
    expect(archiveUrl("https://codeberg.org/o/r", HEAD_A)).toBe(`https://codeberg.org/o/r/archive/${HEAD_A}.tar.gz`);
  });

  test("an archive is unpacked without its top folder; one over the packed or unpacked bound, or too slow, is dropped", async () => {
    const src = mkdtempSync(join(tmpdir(), "repo-check-src-"));
    mkdirSync(join(src, "r-abc/tests"), { recursive: true });
    writeFileSync(join(src, "r-abc/lib.py"), "def f(): return 1\n");
    writeFileSync(join(src, "r-abc/tests/test_lib.py"), "def test_f(): pass\n");
    writeFileSync(join(src, "r-abc/zeros.bin"), Buffer.alloc(3_000_000));
    Bun.spawnSync(["tar", "-czf", join(src, "a.tar.gz"), "-C", src, "r-abc"]);
    const bytes = readFileSync(join(src, "a.tar.gz"));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/missing") return new Response("no", { status: 404 });
        if (p === "/slow") await Bun.sleep(400);
        return new Response(bytes);
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    const out = () => mkdtempSync(join(tmpdir(), "repo-check-out-"));
    try {
      const ok = out();
      await unpackArchive(`${url}/a`, ok, { tree_ms: 10_000, packed_bytes: 1_000_000, unpacked_bytes: 10_000_000 });
      expect(readdirSync(ok).sort()).toEqual(["lib.py", "tests", "zeros.bin"]);
      expect(readFileSync(join(ok, "tests/test_lib.py"), "utf8")).toBe("def test_f(): pass\n");
      // 3 MB of zeros pack to a few KB: the unpacked bound is what stops it
      await expect(unpackArchive(`${url}/a`, out(), { tree_ms: 10_000, packed_bytes: 1_000_000, unpacked_bytes: 1_000_000 })).rejects.toBeInstanceOf(TooLarge);
      await expect(unpackArchive(`${url}/a`, out(), { tree_ms: 10_000, packed_bytes: 1000, unpacked_bytes: 10_000_000 })).rejects.toBeInstanceOf(TooLarge);
      await expect(unpackArchive(`${url}/slow`, out(), { tree_ms: 100, packed_bytes: 1_000_000, unpacked_bytes: 10_000_000 })).rejects.toThrow("too long");
      await expect(unpackArchive(`${url}/missing`, out(), { tree_ms: 10_000, packed_bytes: 1_000_000, unpacked_bytes: 10_000_000 })).rejects.toThrow("HTTP 404");
    } finally {
      server.stop(true);
      rmSync(src, { recursive: true, force: true });
    }
  });
});
