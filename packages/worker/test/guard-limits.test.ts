import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { guardConfigDigest, type GuardConfigVersion, type GuardRule, type ReplayResult } from "@units/protocol";
import { loadRecipe } from "@units/sandbox";
import { AnthropicProposer, ToolBox, type ProposeContext } from "../src/index.ts";
import { guardOutcome, guardRuleReader } from "../src/guard-limits.ts";

// Guard limits in the author's self-evaluation (SPEC 10.1 rule 6, docs/plans/GUARD-LIMITS.md 7): the
// worker judges its own measurement with the guard rule Core publishes; a change that worsens a
// guarded non-target metric beyond its limit is not submitted, the model reads the metric and the
// measured change and may fix it within the attempt, else the attempt ends "guard regression on <metric>".

const ROOT = join(import.meta.dir, "../../..");
const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
const calibration = {
  recipe_id: "",
  snapshot_id: "",
  runs: 1,
  stable: ["t1"],
  known_failures: [],
  quarantined: [],
  metrics: Object.fromEntries(loaded.recipe.metrics.map((m) => [m.name, { enabled: m.deterministic, base_value: 1000 }])),
  median_eval_seconds: 1,
} as unknown as ProposeContext["calibration"];
const RULE: GuardRule = { config_version: 1, config_digest: "ab".repeat(32), default_max_regression: 0.01, kinds: ["perf", "slim"], overrides: {} };

/** A measured result: encode_ir improves 20%; decode_ir changes by `decodeRatio`; everything else unchanged. */
function measured(decodeRatio: number): ReplayResult {
  const metrics: ReplayResult["metrics"] = {};
  for (const m of loaded.recipe.metrics) {
    if (!m.deterministic) continue;
    const cand = m.name === "encode_ir" ? 800 : m.name === "decode_ir" ? 1000 * decodeRatio : 1000;
    metrics[m.name] = { base: [1000], cand: [cand], deterministic: true };
  }
  return {
    apply: "ok",
    guard: "ok",
    build: { base: "ok", cand: "ok" },
    tests: { base_pass: ["t1"], cand_pass: ["t1"], cand_fail: [] },
    equivalence: { base_digest: "0".repeat(64), cand_digest: "0".repeat(64) },
    metrics,
    env: { image_digest: "", cpu_model: "test", cores: 1, worker_version: "test" },
    transcript_digest: "0".repeat(64),
  };
}

function tree(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "units-guard-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/lib.rs"), "pub fn encode() {}\n");
  for (const a of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]]) Bun.spawnSync(["git", ...a], { cwd: dir });
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function ctxFor(dir: string, rule: GuardRule | null): { c: ProposeContext; logs: string[] } {
  const logs: string[] = [];
  return { c: { loaded, deps: {} as ProposeContext["deps"], calibration, parentPatches: [], findings: [], tree: dir, seed: "5eed", log: (m) => logs.push(m), guardRule: async () => rule, guardRegression: null }, logs };
}

/** Sandbox stand-in: each evaluation returns the next measured result. */
function evaluations(results: ReplayResult[]) {
  let i = 0;
  return (async () => ({ result: results[Math.min(i++, results.length - 1)]!, transcript: { steps: [] } })) as unknown as ConstructorParameters<typeof ToolBox>[2];
}

describe("worker self-evaluation applies the guard rule", () => {
  test("a regression beyond the limit is not submittable and the model reads the metric and the measured change; within the limit it is", async () => {
    const { dir, done } = tree();
    try {
      const { c } = ctxFor(dir, RULE);
      const t = new ToolBox(c, 4, evaluations([measured(1.05), measured(1.005)]));
      await t.run("edit_file", { path: "src/lib.rs", old_string: "pub fn encode() {}", new_string: "pub fn encode() { }" });
      const bad = await t.run("evaluate", { kind: "perf", target: "encode_ir" });
      expect(bad).toContain("outcome: rejected (metric_regression");
      expect(bad).toContain("guard regression on decode_ir: decode_ir worsened +5.00% against the parent; the limit is 1%");
      expect(c.guardRegression).toMatchObject({ metric: "decode_ir", status: "exceeded", limit: 0.01, config_version: 1 });
      const refused = t.validateSubmit({ kind: "perf", target: "encode_ir" });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error).toContain("guard regression on decode_ir");
      expect(guardOutcome(c.guardRegression!)).toStartWith("guard regression on decode_ir: measured change +5.00%, limit 1%");

      // fixed within the attempt: +0.5% is within the 1% limit
      const ok = await t.run("evaluate", { kind: "perf", target: "encode_ir" });
      expect(ok).toContain("outcome: accepted");
      expect(ok).toContain("guard limits (config version 1): every guarded metric other than the target is within its limit");
      expect(c.guardRegression).toBeNull();
      expect(t.validateSubmit({ kind: "perf", target: "encode_ir" }).ok).toBe(true);
    } finally {
      done();
    }
  });

  test("no rule in force (rule version 1): the same regression is accepted, as replays would", async () => {
    const { dir, done } = tree();
    try {
      const { c } = ctxFor(dir, null);
      const t = new ToolBox(c, 4, evaluations([measured(1.05)]));
      await t.run("edit_file", { path: "src/lib.rs", old_string: "pub fn encode() {}", new_string: "pub fn encode() { }" });
      expect(await t.run("evaluate", { kind: "perf", target: "encode_ir" })).toContain("outcome: accepted");
      expect(t.validateSubmit({ kind: "perf", target: "encode_ir" }).ok).toBe(true);
    } finally {
      done();
    }
  });

  test("an unreadable guard config is never treated as no guards: the evaluation cannot be submitted", async () => {
    const { dir, done } = tree();
    try {
      const { c } = ctxFor(dir, null);
      c.guardRule = async () => {
        throw new Error("GET /v1/guard-config: HTTP 503");
      };
      const t = new ToolBox(c, 4, evaluations([measured(1.0)]));
      await t.run("edit_file", { path: "src/lib.rs", old_string: "pub fn encode() {}", new_string: "pub fn encode() { }" });
      expect(await t.run("evaluate", { kind: "perf", target: "encode_ir" })).toContain("the guard config could not be read (GET /v1/guard-config: HTTP 503)");
      expect(t.validateSubmit({ kind: "perf", target: "encode_ir" }).ok).toBe(false);
    } finally {
      done();
    }
  });
});

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;
function model(turns: Anthropic.Beta.BetaContentBlock[][]) {
  const seen: any[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(req: any) {
          seen.push(req.messages.at(-1));
          const content = turns[Math.min(i++, turns.length - 1)]!;
          const msg = { id: `m${i}`, type: "message", role: "assistant", model: req.model, content, stop_reason: "tool_use", stop_details: null,
            usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
          return { finalMessage: async () => msg };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, seen };
}

/** Runs the proposer with the sandbox replaced by `results` (one per evaluate call). */
async function proposeWith(c: ProposeContext, turns: Anthropic.Beta.BetaContentBlock[][], results: ReplayResult[]) {
  const orig = ToolBox.prototype.run;
  const impl = evaluations(results);
  ToolBox.prototype.run = async function (this: any, name: string, input: Record<string, unknown>) {
    this.evaluateImpl = impl;
    return orig.call(this, name, input);
  };
  try {
    const { client, seen } = model(turns);
    const proposal = await new AnthropicProposer({ max_usd: 5 }, client).propose(c);
    return { proposal, seen };
  } finally {
    ToolBox.prototype.run = orig;
  }
}

describe("the attempt: not submitted on a guard regression, submitted within the limit", () => {
  const edit = use("e", "edit_file", { path: "src/lib.rs", old_string: "pub fn encode() {}", new_string: "pub fn encode() { }" });
  const evaluate = (id: string) => use(id, "evaluate", { kind: "perf", target: "encode_ir" });
  const submit = (id: string) => use(id, "submit", { kind: "perf", target: "encode_ir", rationale: "faster encode" });

  test("a regressing candidate is not submitted; the attempt ends with guard regression on <metric>", async () => {
    const { dir, done } = tree();
    try {
      const { c } = ctxFor(dir, RULE);
      const { proposal, seen } = await proposeWith(c, [[edit], [evaluate("v1")], [submit("s1")], [use("g", "give_up", { reason: "cannot keep decode_ir within the limit" })]], [measured(1.05)]);
      expect(proposal).toBeNull();
      const results = JSON.stringify(seen);
      expect(results).toContain("guard regression on decode_ir: decode_ir worsened +5.00% against the parent; the limit is 1%");
      expect(results).toContain("not submitted: guard regression on decode_ir");
      expect(c.guardRegression?.metric).toBe("decode_ir");
      // the worker's outcome line for this attempt (worker.ts authorOn)
      expect(guardOutcome(c.guardRegression!)).toStartWith("guard regression on decode_ir");
    } finally {
      done();
    }
  });

  test("the model fixes the regression within the attempt; the candidate within the limit is submitted", async () => {
    const { dir, done } = tree();
    try {
      const { c } = ctxFor(dir, RULE);
      const { proposal } = await proposeWith(c, [[edit], [evaluate("v1")], [evaluate("v2")], [submit("s1")]], [measured(1.05), measured(1.005)]);
      expect(proposal).toMatchObject({ kind: "perf", target: "encode_ir" });
      expect(c.guardRegression).toBeNull();
    } finally {
      done();
    }
  });
});

describe("guard rule reader (GET /v1/guard-config)", () => {
  const version = (n: number, from: number, over: Record<string, Record<string, number | null>> = {}): GuardConfigVersion => {
    const f = { version: n, effective_from_ms: from, default_max_regression: 0.01 * n, kinds: ["perf", "slim"] as GuardConfigVersion["kinds"], overrides: over };
    return { ...f, digest: guardConfigDigest(f) };
  };
  test("picks the version in force now with the recipe's overrides; 404 means no guards; a failure keeps the last rule read", async () => {
    const versions = [version(1, 1000), version(2, 5000, { rid: { decode_ir: null } })];
    let status = 200;
    let now = 2000;
    const read = guardRuleReader(async () => ({ status, body: { versions } }), "rid", () => now);
    expect(await read()).toMatchObject({ config_version: 1, default_max_regression: 0.01, overrides: {} });
    now = 6000;
    expect(await read()).toMatchObject({ config_version: 2, overrides: { decode_ir: null } });
    status = 503;
    expect(await read()).toMatchObject({ config_version: 2 });
    now = 500;
    status = 200;
    expect(await read()).toBeNull(); // before the first version: rule version 1
    expect(await guardRuleReader(async () => ({ status: 404, body: null }), "rid")()).toBeNull();
    await expect(guardRuleReader(async () => ({ status: 503, body: null }), "rid")()).rejects.toThrow(/503/);
  });
});
