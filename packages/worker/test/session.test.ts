import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRecipe, materialize, newWorkDir, prepareDeps, removeTree } from "@lineage/sandbox";
import { loadScript, ScriptedProposer, ToolBox, type ProposeContext } from "../src/index.ts";
import { patchHunks } from "../src/proposers/scripted.ts";
import type { SessionEventInput } from "../src/session.ts";

// Authoring session events (SPEC 17.3): what the worker records per tool call and per patch hunk.

const ROOT = join(import.meta.dir, "../../..");
const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));

async function ctx(events: SessionEventInput[]): Promise<{ c: ProposeContext; done: () => void }> {
  const work = newWorkDir("session-test");
  const tree = join(work, "src");
  materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
  const deps = await prepareDeps(loaded);
  const calibration = { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 };
  return { c: { loaded, deps, calibration, parentPatches: [], findings: [], tree, seed: "5eed", log: () => {}, session: (e) => events.push(e) }, done: () => removeTree(work) };
}

describe("session events", () => {
  test("the Claude tool box records navigation and edits with before and after text at the working-copy line", async () => {
    const events: SessionEventInput[] = [];
    const { c, done } = await ctx(events);
    try {
      const t = new ToolBox(c, 1);
      await t.run("list_files", { dir: "." });
      await t.run("read_file", { path: "src/lib.rs", start_line: 2, end_line: 5 });
      await t.run("search", { pattern: "fn encode" });
      const src = readFileSync(join(c.tree, "src/lib.rs"), "utf8");
      const line = src.split("\n").findIndex((l) => l.includes("fn encode")) + 1;
      const old = src.split("\n")[line - 1]!;
      await t.run("edit_file", { path: "src/lib.rs", old_string: old, new_string: `${old}\n    // lineage session test` });
      expect(events.map((e) => e.kind)).toEqual(["list", "read", "search", "edit"]);
      expect(events[0]!.count).toBeGreaterThan(0);
      expect(events[1]).toMatchObject({ path: "src/lib.rs", start_line: 2, end_line: 5 });
      expect(events[1]!.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(events[2]!.matches).toBeGreaterThan(0);
      expect(events[3]).toMatchObject({ kind: "edit", path: "src/lib.rs", start_line: line, end_line: line, before: old, after: `${old}\n    // lineage session test`, lines_before: 1, lines_after: 2 });
    } finally {
      done();
    }
  });

  test("a scripted author emits its patch hunk by hunk, labelled, anchored in apply order", async () => {
    const events: SessionEventInput[] = [];
    const { c, done } = await ctx(events);
    try {
      const script = loadScript(join(ROOT, "fixtures/b58-patches"));
      const p = new ScriptedProposer(script);
      const prop = await p.propose(c);
      expect(prop).not.toBeNull();
      const used = script.find((s) => `scripted patch ${s.name}` === prop!.rationale)!;
      const hunks = patchHunks(used.diff);
      expect(events.length).toBe(hunks.length);
      expect(events.every((e) => e.kind === "patch" && e.label!.startsWith(`applying patch ${used.name}, hunk`))).toBe(true);
      // replaying the hunks in order on the parent file gives exactly the patched file
      const files = new Map<string, string[]>();
      const parent = (path: string) => {
        if (!files.has(path)) files.set(path, Bun.spawnSync(["git", "show", `HEAD:${path}`], { cwd: c.tree }).stdout.toString().split("\n"));
        return files.get(path)!;
      };
      for (const e of events) {
        const lines = parent(e.path!);
        const before = e.before === "" ? [] : e.before!.split("\n");
        expect(lines.slice(e.start_line! - 1, e.start_line! - 1 + before.length)).toEqual(before);
        lines.splice(e.start_line! - 1, before.length, ...(e.after === "" ? [] : e.after!.split("\n")));
      }
      for (const [path, lines] of files) expect(lines.join("\n")).toBe(readFileSync(join(c.tree, path), "utf8"));
    } finally {
      done();
    }
  });
});

describe("SessionRecorder", () => {
  test("opens a session only once the attempt records an event", async () => {
    const { SessionRecorder } = await import("../src/session.ts");
    const calls: string[] = [];
    const client = {
      post: async (path: string) => {
        calls.push(path);
        return path === "/v1/sessions" ? { status: 200, body: { session_id: "s1" } } : { status: 200, body: {} };
      },
    } as any;
    const w = { lineage_id: "l", gen_id: "g", commit: "c" };
    const idle = new SessionRecorder(client, () => {}, { flushMs: 60_000 });
    await idle.start(w, "scripted");
    await idle.end(null);
    expect(calls).toEqual([]);
    const busy = new SessionRecorder(client, () => {}, { flushMs: 60_000 });
    await busy.start(w, "scripted");
    busy.push({ kind: "read", path: "src/lib.rs", start_line: 1, end_line: 2 });
    await busy.end("commit1");
    expect(calls).toEqual(["/v1/sessions", "/v1/sessions/s1/events", "/v1/sessions/s1/end"]);
  });
});
