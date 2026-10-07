import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, generateAgentKey } from "@lineage/protocol";
import { loadRecipe, materialize, newWorkDir, removeTree, type DepsLayer } from "@lineage/sandbox";
import { CoreClient } from "../../core/src/client.ts";
import { loadScript, ScriptedProposer, ToolBox, type ProposeContext } from "../src/index.ts";
import { Telemetry, type ActivityInput } from "../src/telemetry.ts";

// Live telemetry (SPEC 17.1): proposers report what they really touch, and telemetry can never
// break the work it reports on.

const ROOT = join(import.meta.dir, "../../..");
const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));

function ctx(events: ActivityInput[]): { c: ProposeContext; done: () => void } {
  const work = newWorkDir("telemetry-test");
  const tree = join(work, "src");
  materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
  const calibration = { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 };
  const deps: DepsLayer = { dir: work, digest: "0".repeat(64) };
  return {
    c: { loaded, deps, calibration, parentPatches: [], findings: [], tree, seed: "5eed", log: () => {}, activity: (e) => events.push(e) },
    done: () => removeTree(work),
  };
}

describe("ToolBox activity", () => {
  test("read carries the whole-file sha256 and the read range; edits carry path and parent range only", async () => {
    const events: ActivityInput[] = [];
    const { c, done } = ctx(events);
    try {
      const t = new ToolBox(c, 1);
      await t.run("read_file", { path: "src/lib.rs", start_line: 2, end_line: 9 });
      await t.run("search", { pattern: "fn encode" });
      await t.run("list_files", { dir: "." });
      const src = readFileSync(join(c.tree, "src/lib.rs"), "utf8");
      const target = "pub fn encode";
      const line = src.slice(0, src.indexOf(target)).split("\n").length;
      await t.run("edit_file", { path: "src/lib.rs", old_string: target, new_string: "pub fn encode" });
      t.report({ kind: "give_up" });
      expect(events.map((e) => e.kind)).toEqual(["read", "search", "edit", "give_up"]);
      expect(events[0]).toEqual({ kind: "read", path: "src/lib.rs", start_line: 2, end_line: 9, content_sha256: sha256Hex(readFileSync(join(c.tree, "src/lib.rs"))) });
      expect(events[1]).toEqual({ kind: "search", query: "fn encode" });
      expect(events[2]).toEqual({ kind: "edit", path: "src/lib.rs", start_line: line, end_line: line });
      // nothing an event carries is file content or new text
      for (const e of events) expect(Object.keys(e).every((k) => ["kind", "path", "start_line", "end_line", "query", "target", "content_sha256"].includes(k))).toBe(true);
    } finally {
      done();
    }
  }, 60_000);

  test("an activity callback that throws never reaches the model's tool result", async () => {
    const { c, done } = ctx([]);
    try {
      c.activity = () => {
        throw new Error("telemetry down");
      };
      const t = new ToolBox(c, 1);
      expect(await t.run("read_file", { path: "src/lib.rs", start_line: 1, end_line: 2 })).toContain("src/lib.rs");
    } finally {
      done();
    }
  }, 60_000);
});

describe("ScriptedProposer activity", () => {
  test("one edit per hunk at the parent lines it replaces, then propose", async () => {
    const events: ActivityInput[] = [];
    const { c, done } = ctx(events);
    try {
      const p = new ScriptedProposer(loadScript(join(ROOT, "fixtures/b58-patches"), ["perf_encode"]));
      expect((await p.propose(c))?.kind).toBe("perf");
      expect(events).toEqual([
        { kind: "edit", path: "src/lib.rs", start_line: 30, end_line: 42 },
        { kind: "propose", target: "encode_ir" },
      ]);
    } finally {
      done();
    }
  }, 60_000);
});

describe("Telemetry", () => {
  test("an unreachable Core never throws and never blocks", async () => {
    const logs: string[] = [];
    const t = new Telemetry(new CoreClient("http://127.0.0.1:1", generateAgentKey()), (m) => logs.push(m));
    t.job("replay", { replay_id: "a".repeat(64) });
    t.phase("build", Date.now());
    t.activity({ lineage_id: "b".repeat(64), gen_id: "c".repeat(64), commit: "d".repeat(40) }, { kind: "search", query: "x" });
    await t.beat();
    await t.flush();
    t.idle();
    await t.stop();
    expect(t.sent.failed).toBeGreaterThan(0);
    expect(logs.some((l) => l.startsWith("telemetry"))).toBe(true);
  });
});
