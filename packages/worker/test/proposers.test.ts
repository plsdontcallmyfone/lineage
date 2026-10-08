import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { calibrate, diffWorkingTree, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree } from "@lineage/sandbox";
import { AnthropicProposer, loadScript, ScriptedProposer, ToolBox, type ProposeContext } from "../src/index.ts";

const ROOT = join(import.meta.dir, "../../..");
const dockerUp = Bun.spawnSync(["docker", "info"]).exitCode === 0;
const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));

async function ctx(): Promise<{ c: ProposeContext; done: () => void; logs: string[] }> {
  const work = newWorkDir("proposer-test");
  const tree = join(work, "src");
  materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
  const deps = await prepareDeps(loaded);
  const logs: string[] = [];
  const calibration = dockerUp
    ? (await calibrate({ loaded, deps, seed: "t", runs: 1 })).calibration
    : { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 };
  return {
    c: { loaded, deps, calibration, parentPatches: [], findings: [], tree, seed: "5eed", log: (m) => logs.push(m) },
    done: () => removeTree(work),
    logs,
  };
}

describe("ToolBox path confinement", () => {
  test("reads inside the tree, refuses escapes, protected and disallowed writes", async () => {
    const { c, done } = await ctx();
    try {
      const t = new ToolBox(c, 1);
      expect(await t.run("read_file", { path: "src/lib.rs", start_line: 1, end_line: 3 })).toContain("Base58");
      expect(await t.run("list_files", { dir: "." })).toContain("src/lib.rs");
      expect(await t.run("search", { pattern: "fn encode" })).toContain("src/lib.rs");
      await expect(t.run("read_file", { path: "../../../../etc/passwd" })).rejects.toThrow(/outside/);
      await expect(t.run("read_file", { path: ".git/config" })).rejects.toThrow(/outside/);
      await expect(t.run("write_file", { path: "tests/basic.rs", contents: "x" })).rejects.toThrow(/protected/);
      await expect(t.run("write_file", { path: "examples/lineage_bench.rs", contents: "x" })).rejects.toThrow(/protected/);
      await expect(t.run("write_file", { path: "README.md", contents: "x" })).rejects.toThrow(/outside the allowed/);
      await expect(t.run("edit_file", { path: "src/lib.rs", old_string: "nope-not-there", new_string: "y" })).rejects.toThrow(/exactly once/);
      expect(await t.run("edit_file", { path: "src/lib.rs", old_string: "pub fn encode", new_string: "pub fn encode" })).toContain("edited");
      expect(t.validateSubmit({ kind: "perf", target: "encode_ir" }).ok).toBe(false);
    } finally {
      done();
    }
  }, 120_000);
});

describe("ScriptedProposer", () => {
  test("plan (advisory collaboration) prefers a target no other agent holds an intent on, then proposes it", async () => {
    const { c, done, logs } = await ctx();
    try {
      const p = new ScriptedProposer(loadScript(join(ROOT, "fixtures/b58-patches"), ["perf_encode", "fix_leading_ones"]));
      const held = { intent_id: "i", agent: "someone-else", kind: "perf" as const, target: "encode_ir", note: null, expires_at: 0, status: "open" };
      const mine = { ...held, agent: "me", kind: "fix" as const, target: ["tests/basic.rs::decode_leading_ones_are_zero_bytes"] };
      const planned = await p.plan({ ...c, self: "me", collab: "advisory", intents: [held, mine] });
      expect(planned?.kind).toBe("fix");
      expect(logs.some((l) => l.includes("skipping targets other agents hold"))).toBe(true);
      expect((await p.propose(c))?.kind).toBe("fix");
      // with every applying target held, intents stay advisory: it still plans the first one
      const q = new ScriptedProposer(loadScript(join(ROOT, "fixtures/b58-patches"), ["perf_encode"]));
      expect((await q.plan({ ...c, self: "me", collab: "advisory", intents: [held] }))?.target).toBe("encode_ir");
      // collab off: script order
      const r = new ScriptedProposer(loadScript(join(ROOT, "fixtures/b58-patches"), ["perf_encode", "fix_leading_ones"]));
      expect((await r.plan({ ...c, self: "me", collab: "off", intents: [held] }))?.kind).toBe("perf");
    } finally {
      done();
    }
  }, 120_000);

  test("applies the next patch that fits and skips ones that do not", async () => {
    const { c, done, logs } = await ctx();
    try {
      const p = new ScriptedProposer(loadScript(join(ROOT, "fixtures/b58-patches"), ["perf_encode", "stale_conflict", "fix_leading_ones"]));
      const first = await p.propose(c);
      expect(first?.kind).toBe("perf");
      expect(diffWorkingTree(c.tree)).toContain("with_capacity");
      Bun.spawnSync(["git", "commit", "-qm", "x"], { cwd: c.tree });
      const second = await p.propose(c); // stale_conflict no longer applies on top of perf_encode
      expect(second?.kind).toBe("fix");
      expect(logs.join("\n")).toContain("stale_conflict does not apply");
    } finally {
      done();
    }
  }, 120_000);
});

/** A fake Messages client: replays a fixed list of assistant turns and records requests. */
function fakeClient(turns: Anthropic.Beta.BetaContentBlock[][], usage = { input_tokens: 1000, output_tokens: 200 }) {
  const requests: any[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(req: any) {
          requests.push(structuredClone(req));
          const content = turns[Math.min(i++, turns.length - 1)]!;
          const msg = {
            id: `m${i}`,
            type: "message",
            role: "assistant",
            model: req.model,
            content,
            stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
            stop_details: null,
            usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
          return { finalMessage: async () => msg };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;

const d = dockerUp ? describe : describe.skip;
d("AnthropicProposer loop (fake model, real sandbox)", () => {
  test("explore, edit, evaluate for real, submit", async () => {
    const { c, done } = await ctx();
    try {
      const perf = readFileSync(join(ROOT, "fixtures/b58-patches/perf_encode.diff"), "utf8");
      const oldBlock = perf.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1)).join("\n");
      const newBlock = perf.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
      const { client, requests } = fakeClient([
        [use("t1", "read_file", { path: "src/lib.rs" })],
        [use("t2", "submit", { kind: "perf", target: "encode_ir", rationale: "too early" })],
        [use("t3", "edit_file", { path: "src/lib.rs", old_string: oldBlock, new_string: newBlock })],
        [use("t4", "evaluate", { kind: "perf", target: "encode_ir" })],
        [use("t5", "submit", { kind: "perf", target: "encode_ir", rationale: "push and reverse instead of insert at 0" })],
      ]);
      const p = new AnthropicProposer({ max_usd: 5 }, client);
      const out = await p.propose(c);
      expect(out?.kind).toBe("perf");
      expect(out?.claimed_effect).toBeLessThan(0.99);
      expect(out?.usage?.usd).toBeCloseTo((5 * 1000 * 4 + 5 * 200 * 20) / 1e6);
      // the early submit was refused with an error result
      const refused = requests[2].messages.at(-1).content[0];
      expect(refused.is_error).toBe(true);
      // the evaluate result reported a real measurement
      const evalResult = requests[4].messages.at(-1).content[0].content as string;
      expect(evalResult).toContain("outcome: accepted");
      // request shape: default model, adaptive thinking, fallbacks, caching
      expect(requests[0].model).toBe("claude-opus-5-5");
      expect(requests[0].thinking).toEqual({ type: "adaptive" });
      expect(requests[0].fallbacks).toBe("default");
      expect(requests[0].cache_control).toEqual({ type: "ephemeral" });
    } finally {
      done();
    }
  }, 300_000);

  test("stops at the spend cap", async () => {
    const { c, done, logs } = await ctx();
    try {
      const { client } = fakeClient([[use("t1", "list_files", { dir: "." })]], { input_tokens: 400_000, output_tokens: 0 });
      const out = await new AnthropicProposer({ max_usd: 1 }, client).propose(c);
      expect(out).toBeNull();
      expect(logs.join("\n")).toContain("spend cap");
    } finally {
      done();
    }
  }, 120_000);
});
