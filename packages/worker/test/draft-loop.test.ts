import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger } from "../src/discovery.ts";
import { autoNote, RecipeDrafter, type TrialReport } from "../src/recipe-proposer.ts";

// The drafting loop around the model (recipe-proposer.ts): what it tells the model, how a draft that
// follows a failed one starts, and how a draft ends when the model runs out of budget. The model is a
// script and the trial a stand-in; the repository is the fixture b58 (no network).

const TARGET = { name: "b58-draft", repo: "fixture:b58", commit: "c2c30d4ecbdd6a7b9f14457f33898fdf27f0c7d6", class: "rust" as const, arch: "arm64" as const, image: "lineage/rust:m1@sha256:ad2f9ba06cb62446a4a2015ffac9e90f877dbd0c7e10aa2c2976240e68d0a626" };
const usage = (usd_ish: number) => ({ input_tokens: 0, output_tokens: Math.round((usd_ish * 1e6) / 25), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) as Anthropic.Beta.BetaUsage;

/** A model that plays `script` (one tool call a turn), recording what it was sent. */
function scripted(script: { name: string; input?: Record<string, unknown>; tokens?: number }[]) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        stream(req: any) {
          if (req.max_tokens === 1) return { finalMessage: async () => ({ model: "claude-opus-5-5", usage: usage(0), stop_reason: "max_tokens", content: [] }) };
          requests.push(JSON.parse(JSON.stringify(req)));
          const step = script[requests.length - 1] ?? { name: "read_file", input: { path: "Cargo.toml" } };
          return { finalMessage: async () => ({ model: "claude-opus-5-5", usage: usage(step.tokens ?? 0.01), stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${requests.length}`, name: step.name, input: step.input ?? {} }] }) };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

class Stub extends RecipeDrafter {
  reports: TrialReport[] = [];
  override async trial(): Promise<TrialReport> {
    return this.reports.shift() ?? { ok: true, recipe_id: "r", text: "recipe_id r\nprepare ok (deps abc)\nbuild ok; stable tests 5, known failures 0, quarantined 0\nmetric encode_ir: enabled cv 0.00e+0 base 1000\nequivalence: exit 0/0, 40 bytes of output, identical digests" };
  }
}

function drafter(o: { script: Parameters<typeof scripted>[0]; capUsd?: number; resume?: string; history?: ConstructorParameters<typeof RecipeDrafter>[0]["history"]; firstTrialTurns?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "units-draft-loop-"));
  const m = scripted(o.script);
  const logs: string[] = [];
  const d = new Stub({ client: m.client, ledger: new SpendLedger(join(dir, "spend.jsonl"), 100), capUsd: o.capUsd ?? 5, dir: join(dir, "draft"), target: TARGET, example: { recipe_yml: "name: example\n", overlay: {} }, image: null, resume: o.resume, history: o.history, firstTrialTurns: o.firstTrialTurns, log: (l) => logs.push(l) });
  mkdirSync(join(dir, "draft"), { recursive: true });
  return { d, logs, dir: join(dir, "draft"), ...m };
}

const RECIPE = { name: "write_recipe", input: { yaml: "name: b58-draft\n" } };

describe("how a draft ends", () => {
  test("a trial that passed, then the spend limit before the model could submit: the loop submits the unchanged draft with the trial's report as its note", async () => {
    const { d, logs } = drafter({ script: [RECIPE, { name: "trial_calibrate", tokens: 0.9 }], capUsd: 1 });
    const out = await d.draft();
    expect(out).toMatchObject({ submitted: true, trials: 1, turns: 2, before_trial: { turns: 2 } });
    expect(out.outcomes).toMatchObject([{ n: 1, ok: true, reason: null }]);
    expect(out.note).toStartWith("Recipe for fixture:b58 at c2c30d4. Its last trial calibration passed in the sandbox and the draft was not changed after it;");
    expect(out.note).toContain("build ok; stable tests 5, known failures 0, quarantined 0; metric encode_ir: enabled cv 0.00e+0 base 1000; equivalence: exit 0/0, 40 bytes of output, identical digests");
    expect(logs.some((l) => l.includes("submitted by the loop"))).toBe(true);
  });
  test("a draft changed after its passing trial is not submitted by the loop", async () => {
    const { d } = drafter({ script: [RECIPE, { name: "trial_calibrate" }, { name: "write_recipe", input: { yaml: "name: b58-draft\n# changed\n" }, tokens: 0.9 }], capUsd: 1 });
    const out = await d.draft();
    expect(out).toMatchObject({ submitted: false, stop: "spend", reason: "the draft was not submitted, and it reached its spend limit" });
  });
  test("a failed trial then the spend limit: the reason names the stage and the rule in fixed words, and the outcome keeps the cause", async () => {
    const { d, logs } = drafter({ script: [RECIPE, { name: "trial_calibrate", tokens: 0.9 }], capUsd: 1 });
    d.reports = [{ ok: false, text: "recipe_id r\nFAILED: calibration build failed: error[E0433]", reason: { stage: "build", kind: "compile", cause: "error[E0433]: failed to resolve: use of undeclared crate `x` in src/lib.rs:3", seconds: 41.2 } }];
    const out = await d.draft();
    expect(out).toMatchObject({ submitted: false, stop: "spend", reason: "trial 1 failed at build (compile error), and it reached its spend limit" });
    expect(out.outcomes[0]!.reason!.cause).toBe("error[E0433]: failed to resolve: use of undeclared crate `x` in src/lib.rs:3");
    // the first line of the log entry is the one a runtime keeps: it says why
    expect(logs.find((l) => l.startsWith("recipe-drafter: trial 1 not ok"))!.split("\n")[0]).toMatch(/^recipe-drafter: trial 1 not ok: build: error\[E0433\]: failed to resolve: use of undeclared crate `x` in src\/lib\.rs:3 \(\d+ s\)$/);
    expect(autoNote(TARGET, "")).not.toContain("\u2014");
  });
  test("no trial at all: said so, with the turns", async () => {
    const { d } = drafter({ script: [{ name: "read_file", input: { path: "Cargo.toml" }, tokens: 0.6 }, { name: "read_file", input: { path: "Cargo.toml" }, tokens: 0.6 }], capUsd: 1 });
    expect(await d.draft()).toMatchObject({ submitted: false, trials: 0, stop: "spend", reason: "it reached its spend limit before its first trial (2 turns)", before_trial: { turns: 2 } });
  });
});

describe("what the model is told", () => {
  test("the turn budget before a first trial: the note arrives with the tool results once it is used up", async () => {
    const read = { name: "read_file", input: { path: "Cargo.toml" } };
    const { d, requests, logs } = drafter({ script: [read, read, read, { name: "give_up", input: { reason: "x", impossible: false } }], firstTrialTurns: 2 });
    await d.draft();
    expect(requests[0].system).toContain("plan to reach your first trial within 2 turns");
    const texts = (i: number) => requests[i].messages.at(-1).content.filter((b: any) => b.type === "text").map((b: any) => b.text);
    expect(texts(1)).toEqual([]);
    expect(texts(2)[0]).toStartWith("Pace: 2 turns and ");
    expect(texts(2)[0]).toContain("no trial has run. Stop reading.");
    expect(logs.some((l) => l.startsWith("recipe-drafter: told to trial now (2 turns"))).toBe(true);
  });
  test("a draft after one that did not pass starts as a copy of its files, shows them, and says why the last trial failed", async () => {
    const prev = mkdtempSync(join(tmpdir(), "units-draft-prev-"));
    mkdirSync(join(prev, "overlay/examples"), { recursive: true });
    writeFileSync(join(prev, "recipe.yml"), "name: b58-draft\n# from draft 1\n");
    writeFileSync(join(prev, "overlay/examples/lineage_bench.rs"), "fn main() { /* bench of draft 1 */ }\n");
    const { d, requests, dir } = drafter({ script: [{ name: "give_up", input: { reason: "x", impossible: false } }], resume: prev, history: [{ draft: 1, trials: [{ n: 1, ok: false, seconds: 96, reason: { stage: "build", kind: "compile", cause: "error[E0433]: failed to resolve in examples/lineage_bench.rs:3" } }] }] });
    await d.draft();
    expect(readFileSync(join(dir, "recipe.yml"), "utf8")).toContain("# from draft 1");
    expect(existsSync(join(dir, "overlay/examples/lineage_bench.rs"))).toBe(true);
    expect(requests[0].system).toContain("- draft 1, trial 1 (96 s): build: error[E0433]: failed to resolve in examples/lineage_bench.rs:3");
    expect(requests[0].system).toContain("Last time this failed because: build: error[E0433]: failed to resolve in examples/lineage_bench.rs:3. Fix exactly that first.");
    expect(requests[0].system).toContain("plan to reach your first trial within 4 turns");
    const first = requests[0].messages[0].content as string;
    expect(first).toStartWith("Your draft already holds the previous draft's files, shown below. Do not start over");
    expect(first).toContain("--- recipe.yml ---\nname: b58-draft\n# from draft 1");
    expect(first).toContain("--- overlay/examples/lineage_bench.rs ---\nfn main() { /* bench of draft 1 */ }");
  });
});
