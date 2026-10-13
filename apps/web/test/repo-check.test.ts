import { describe, expect, test } from "bun:test";
import { ANYWAY_LABEL, CHECKING_LINE, repoCheckLine, repoCheckProblem, repoCheckView, watchRepoCheck, type RepoCheck } from "../wallet/repo-check.ts";

// The launch form's one line about the repository (wallet/repo-check.ts), to the exact words, and when
// the step is held.

const SETUP: RepoCheck = { state: "can_set_up", language: "Python", tests: 59, tests_in: ["tests"], setup_minutes: null };
const NO_TESTS: RepoCheck = { state: "cannot", cause: "tests", language: "Python", seen: null, gpu: [], reason: "it has no tests, and a unit needs the repository's own tests to check every change" };
const GPU: RepoCheck = { ...NO_TESTS, gpu: ["prepare.py", "train.py"] } as RepoCheck;
const LANG: RepoCheck = { state: "cannot", cause: "language", language: null, seen: ".js", gpu: [], reason: "there is no toolchain image for its language (mostly .js files); images exist for Python, Rust, Go, C and C++, Zig and Solana programs" };

describe("the repository line", () => {
  const cases: [string, RepoCheck, string, string][] = [
    ["checking", { state: "checking" }, "checking", "Checking that agents can work on it ..."],
    ["ready", { state: "ready" }, "ready", "Agents already work on this repository."],
    ["will set up, no recorded time", SETUP, "setup", "It has tests in Python (59 files, in tests); the agent sets up its measurement first."],
    ["will set up, a time from recorded setups", { ...SETUP, setup_minutes: 12 } as RepoCheck, "setup", "It has tests in Python (59 files, in tests); the agent sets up its measurement first, usually within 12 minutes."],
    ["will set up, one file in two places", { state: "can_set_up", language: "Rust", tests: 1, tests_in: ["tests", "crates"], setup_minutes: 1 }, "setup", "It has tests in Rust (1 file, in tests and crates); the agent sets up its measurement first, usually within 1 minute."],
    ["no tests", NO_TESTS, "cannot", "Agents cannot work on this repository yet: it has no tests of its own, and every change must be checked by the repository's own tests."],
    ["no tests and a GPU", GPU, "cannot", "Agents cannot work on this repository yet: it has no tests of its own, and every change must be checked by the repository's own tests. Its code also needs a GPU (prepare.py and train.py), and agents are measured on CPUs."],
    ["a language agents cannot build", LANG, "cannot", "Agents cannot work on this repository yet: it is mostly .js files, and agents can build Python, Rust, Go, C and C++, Zig and Solana programs."],
    ["no source code", { ...LANG, seen: null, reason: "there is no toolchain image for its language (no source files found); images exist for Python, Rust, Go, C and C++, Zig and Solana programs" } as RepoCheck, "cannot", "Agents cannot work on this repository yet: no source code was found in it, and agents can build Python, Rust, Go, C and C++, Zig and Solana programs."],
    ["no verifier for its language", { state: "cannot", cause: "verifier", language: "Go", seen: null, gpu: [], reason: "x" }, "cannot", "Agents cannot work on this repository yet: no verifier on this network checks Go work yet."],
    ["too large to check", { state: "unknown", why: "the repository is too large to read here" }, "neutral", "This repository is too large to check here. You can still launch; the agent reads the repository itself after the launch."],
    ["could not be read", { state: "unknown", why: "the repository could not be read" }, "neutral", "This repository could not be checked right now. You can still launch; the agent reads the repository itself after the launch."],
    ["the check did not answer", { state: "failed" }, "neutral", "The check that agents can work on it did not answer. You can still launch; the agent reads the repository itself after the launch."],
  ];
  for (const [name, c, kind, text] of cases)
    test(name, () => {
      expect(repoCheckLine(c)).toEqual({ kind: kind as never, text });
      // no em dash, no internal word
      expect(text).not.toMatch(/—|\bunit\b|recipe|lineage|TBA|toolchain/);
    });

  test("only a cannot offers Launch anyway, and it stays ticked across a re-render", () => {
    expect(repoCheckView(NO_TESTS).s).toContain(`<input type="checkbox" name="rc_anyway"> <span>${ANYWAY_LABEL}</span>`);
    expect(repoCheckView(NO_TESTS, true).s).toContain('name="rc_anyway" checked>');
    for (const c of [SETUP, { state: "ready" }, { state: "checking" }, { state: "failed" }, { state: "unknown", why: "x" }] as RepoCheck[]) expect(repoCheckView(c).s).not.toContain("rc_anyway");
    expect(ANYWAY_LABEL).toBe("Launch anyway; the agent waits until the repository can be measured");
  });
});

describe("leaving the step", () => {
  test("it waits while the check runs, is held on a cannot until the launcher says so, and is never held on a check that did not run", () => {
    expect(repoCheckProblem(undefined, false)).toBe(CHECKING_LINE);
    expect(repoCheckProblem({ state: "checking" }, false)).toBe(CHECKING_LINE);
    expect(repoCheckProblem(NO_TESTS, false)).toBe(`${repoCheckLine(NO_TESTS).text} Tick "Launch anyway" to launch it regardless.`);
    expect(repoCheckProblem(NO_TESTS, true)).toBeNull();
    for (const c of [SETUP, { state: "ready" }, { state: "failed" }, { state: "unknown", why: "x" }] as RepoCheck[]) expect(repoCheckProblem(c, false)).toBeNull();
  });
});

describe("asking Core", () => {
  const answers = (list: (RepoCheck | number | Error)[]) => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(url);
      const a = list[Math.min(asked.length - 1, list.length - 1)]!;
      if (a instanceof Error) throw a;
      if (typeof a === "number") return new Response("{}", { status: a });
      return Response.json(a);
    }) as unknown as typeof fetch;
    return { f, asked };
  };
  test("it asks again while a reading runs and returns the answer", async () => {
    const a = answers([{ state: "checking" }, { state: "checking" }, SETUP]);
    expect(await watchRepoCheck("https://github.com/o/r", () => true, { fetch: a.f, everyMs: 1 })).toEqual(SETUP);
    expect(a.asked).toEqual(Array(3).fill("/api/repo-check?repo=https%3A%2F%2Fgithub.com%2Fo%2Fr"));
  });
  test("a service that is down, refuses or never finishes is failed, never a cannot", async () => {
    expect(await watchRepoCheck("r", () => true, { fetch: answers([502]).f, everyMs: 1 })).toEqual({ state: "failed" });
    expect(await watchRepoCheck("r", () => true, { fetch: answers([429]).f, everyMs: 1 })).toEqual({ state: "failed" });
    expect(await watchRepoCheck("r", () => true, { fetch: answers([new Error("down")]).f, everyMs: 1 })).toEqual({ state: "failed" });
    const never = answers([{ state: "checking" }]);
    expect(await watchRepoCheck("r", () => true, { fetch: never.f, everyMs: 1, tries: 4 })).toEqual({ state: "failed" });
    expect(never.asked.length).toBe(4);
  });
  test("it stops asking once the launcher typed another repository", async () => {
    const a = answers([{ state: "checking" }]);
    let alive = true;
    const p = watchRepoCheck("r", () => alive, { fetch: a.f, everyMs: 5 });
    setTimeout(() => (alive = false), 12);
    await p;
    expect(a.asked.length).toBeLessThan(6);
  });
});
