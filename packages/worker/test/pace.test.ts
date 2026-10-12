import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ReplayResult } from "@units/protocol";
import { loadRecipe } from "@units/sandbox";
import { AnthropicProposer, ToolBox, type ProposeContext } from "../src/index.ts";
import { openingMessage, systemBlocks, systemPrompt, systemStatic, systemVolatile } from "../src/proposers/anthropic.ts";
import { paceLine, paceNotice } from "../src/proposers/budget.ts";
import { efficiencyError } from "../src/proposers/efficiency.ts";

// Agent productivity lane (docs/plans/AGENT-EFFICIENCY.md section 5): a cacheable static prefix,
// pacing (budget stated and counted down, two-step wrap-up) and the submit reserve.

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

function measured(encodeRatio: number): ReplayResult {
  const metrics: ReplayResult["metrics"] = {};
  for (const m of loaded.recipe.metrics) if (m.deterministic) metrics[m.name] = { base: [1000], cand: [m.name === "encode_ir" ? 1000 * encodeRatio : 1000], deterministic: true };
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

function setup(extra: Partial<ProposeContext> = {}): { c: ProposeContext; logs: string[]; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "units-pace-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/lib.rs"), "pub fn encode() {}\n");
  for (const a of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]]) Bun.spawnSync(["git", ...a], { cwd: dir });
  const logs: string[] = [];
  return {
    c: { loaded, deps: {} as ProposeContext["deps"], calibration, parentPatches: [], findings: [], tree: dir, seed: "5eed", log: (m) => logs.push(m), guardRule: async () => null, guardRegression: null, ...extra },
    logs,
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;
const EDIT = use("e", "edit_file", { path: "src/lib.rs", old_string: "pub fn encode() {}", new_string: "pub fn encode() { }" });
const EVAL = (id: string) => use(id, "evaluate", { kind: "perf", target: "encode_ir" });
const SUBMIT = use("s", "submit", { kind: "perf", target: "encode_ir", rationale: "less work per byte" });

/** Scripted turns with their output tokens; records every request as sent. */
function fake(turns: { content: Anthropic.Beta.BetaContentBlock[]; out: number }[]) {
  const requests: any[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(req: any) {
          requests.push(JSON.parse(JSON.stringify(req)));
          const t = turns[Math.min(i++, turns.length - 1)]!;
          const cut = t.out > req.max_tokens;
          const msg = {
            id: `m${i}`,
            type: "message",
            role: "assistant",
            model: req.model,
            content: t.content,
            stop_reason: cut ? "max_tokens" : t.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
            stop_details: null,
            usage: { input_tokens: 2000, output_tokens: Math.min(t.out, req.max_tokens), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
          return { finalMessage: async () => msg };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

/** Runs the proposer with the sandbox replaced by `results` (one per evaluate call). */
async function proposeWith(p: AnthropicProposer, c: ProposeContext, results: ReplayResult[]) {
  const orig = ToolBox.prototype.run;
  let i = 0;
  const impl = (async () => ({ result: results[Math.min(i++, results.length - 1)]!, transcript: { steps: [] } })) as unknown as ConstructorParameters<typeof ToolBox>[2];
  ToolBox.prototype.run = async function (this: any, name: string, input: Record<string, unknown>) {
    this.evaluateImpl = impl;
    return orig.call(this, name, input);
  };
  try {
    return await p.propose(c);
  } finally {
    ToolBox.prototype.run = orig;
  }
}

const lastUserText = (req: any): string => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === "string" ? m.content : m.content.map((b: any) => (b.type === "text" ? b.text : "")).join("\n");
};

describe("cacheable prefix", () => {
  test("the static part is the same whatever the soul, notes and shared findings say, and carries the breakpoint", () => {
    const a = setup({ soul: "Soul A", notes: "note one", shared: "- ACCEPTED perf:encode_ir by X" });
    const b = setup({ soul: "Soul B", notes: "another note, later", shared: null });
    const none = setup();
    try {
      expect(systemStatic(a.c)).toBe(systemStatic(b.c));
      expect(systemStatic(a.c)).toBe(systemStatic(none.c));
      for (const word of ["Soul A", "note one", "ACCEPTED"]) expect(systemStatic(a.c)).not.toContain(word);
      const blocks = systemBlocks(a.c);
      expect(blocks.length).toBe(2);
      expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
      expect(blocks[1]!.cache_control).toBeUndefined();
      expect(blocks[1]!.text).toContain("Soul A");
      expect(blocks[1]!.text).toContain("note one");
      // same text as the one-string prompt the other adapters send
      expect(blocks.map((x) => x.text).join("")).toBe(systemPrompt(a.c));
      expect(systemPrompt(a.c)).toBe(systemStatic(a.c) + systemVolatile(a.c));
      // nothing volatile: one block, still with the breakpoint
      expect(systemBlocks(none.c).length).toBe(1);
      // no clock, no budget figure and no agent id in the static part
      expect(systemStatic(a.c)).not.toMatch(/USD|\d{4}-\d{2}-\d{2}/);
    } finally {
      a.done();
      b.done();
      none.done();
    }
  });

  test("the request sends the static block first with its breakpoint and keeps the automatic one", async () => {
    const { c, done } = setup({ notes: "note one" });
    try {
      const { client, requests } = fake([{ content: [use("g", "give_up", { reason: "none" })], out: 100 }]);
      await new AnthropicProposer({ max_usd: 1 }, client).propose(c);
      expect(Array.isArray(requests[0].system)).toBe(true);
      expect(requests[0].system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(requests[0].system[0].text).toBe(systemStatic(c));
      expect(requests[0].cache_control).toEqual({ type: "ephemeral" });
    } finally {
      done();
    }
  });
});

describe("pacing", () => {
  test("off by default: no budget paragraph, no budget line", async () => {
    const { c, done } = setup();
    try {
      const { client, requests } = fake([{ content: [use("l", "list_files", { dir: "." })], out: 100 }, { content: [use("g", "give_up", { reason: "none" })], out: 100 }]);
      await new AnthropicProposer({ max_usd: 1, efficiency: { cap_mode: "bounded" } }, client).propose(c);
      expect(requests[0].messages[0].content).not.toContain("Budget for this attempt");
      expect(lastUserText(requests[1])).not.toContain("[budget:");
      expect(openingMessage(c)).not.toContain("Budget");
    } finally {
      done();
    }
  });

  test("on: the opening states the budget of the loop, and every tool result turn ends with what is left", async () => {
    const { c, done } = setup({ journalReserveUsd: 0.08 });
    try {
      const { client, requests } = fake([{ content: [use("l", "list_files", { dir: "." })], out: 1000 }, { content: [use("g", "give_up", { reason: "none" })], out: 100 }]);
      await new AnthropicProposer({ max_usd: 1, max_evals: 4, efficiency: { cap_mode: "bounded", pace: true } }, client).propose(c);
      // the cap of the loop is the attempt cap less the journal reserve
      expect(requests[0].messages[0].content).toContain("Budget for this attempt: 0.92 USD");
      expect(requests[0].messages[0].content).toContain("You have 4 evaluations");
      // 2000 input at 4 and 1000 output at 20 USD per million tokens = 0.028 spent
      expect(lastUserText(requests[1])).toContain("[budget: 0.89 of 0.92 USD left; 4 evaluations left]");
    } finally {
      done();
    }
  });

  test("the notices: a nudge at half with nothing evaluated, the final one at 80% worded for the state, each once", () => {
    const sent = new Set<"nudge" | "final">();
    const base = { cap: 1, evaluated: false, accepted: false, evalsLeft: 4, sent };
    expect(paceNotice({ ...base, spent: 0.49 })).toBeNull();
    const n = paceNotice({ ...base, spent: 0.5 })!;
    expect(n.stage).toBe("nudge");
    expect(n.text).toContain("make your most promising change now and call evaluate");
    sent.add("nudge");
    expect(paceNotice({ ...base, spent: 0.6 })).toBeNull();
    // an attempt that already evaluated gets no nudge
    expect(paceNotice({ ...base, sent: new Set(), evaluated: true, spent: 0.6 })).toBeNull();
    expect(paceNotice({ ...base, spent: 0.8 })!.text).toContain("call evaluate now");
    expect(paceNotice({ ...base, spent: 0.8, evaluated: true })!.text).toContain("extension of your change");
    expect(paceNotice({ ...base, spent: 0.8, evaluated: true, accepted: true })!.text).toContain("call submit now");
    expect(paceNotice({ ...base, spent: 0.8, evaluated: true, evalsLeft: 0 })!.text).toContain("no evaluation is left");
    sent.add("final");
    expect(paceNotice({ ...base, spent: 0.95 })).toBeNull();
    expect(paceNotice({ ...base, cap: 0, spent: 0 })).toBeNull();
    expect(paceLine(-0.01, 0.92, 1)).toBe("[budget: 0.00 of 0.92 USD left; 1 evaluation left]");
  });

  test("the nudge reaches the model in the turn after half the budget went on one thinking turn", async () => {
    const { c, logs, done } = setup();
    try {
      // 26k output tokens = 0.52 USD of a 1.00 USD cap
      const { client, requests } = fake([{ content: [use("l", "list_files", { dir: "." })], out: 26_000 }, { content: [use("g", "give_up", { reason: "none" })], out: 100 }]);
      await new AnthropicProposer({ max_usd: 1, efficiency: { cap_mode: "bounded", pace: true } }, client).propose(c);
      expect(lastUserText(requests[1])).toContain("half of this attempt's budget is spent");
      expect(logs.join("\n")).toContain("budget nudge sent");
    } finally {
      done();
    }
  });
});

describe("submit reserve", () => {
  // a thinking turn with the edit (11k output tokens), the evaluate call (accepted: encode_ir 20% better),
  // then submit. At a 0.50 USD cap the submit call has room for about 3,700 output tokens: under the
  // 4,096 a call normally needs, far more than a submit takes.
  const script = (thinking: number) => [
    { content: [EDIT], out: 11_000 },
    { content: [EVAL("v1")], out: thinking },
    { content: [SUBMIT], out: 300 },
  ];

  test("without pacing the accepted change is lost: the cap ends the attempt before the submit call", async () => {
    const { c, logs, done } = setup();
    try {
      const { client, requests } = fake(script(7_500));
      const p = new AnthropicProposer({ max_usd: 0.5, efficiency: { cap_mode: "bounded" } }, client);
      expect(await proposeWith(p, c, [measured(0.8)])).toBeNull();
      expect(requests.length).toBe(2);
      expect(logs.join("\n")).toContain("spend cap reached");
    } finally {
      done();
    }
  });

  test("with pacing the reserve pays for the submit call, and the cap still holds", async () => {
    const { c, logs, done } = setup();
    try {
      const { client, requests } = fake(script(7_500));
      const p = new AnthropicProposer({ max_usd: 0.5, efficiency: { cap_mode: "bounded", pace: true } }, client);
      const proposal = await proposeWith(p, c, [measured(0.8)]);
      expect(proposal).not.toBeNull();
      expect(proposal!.target).toBe("encode_ir");
      expect(requests.length).toBe(3);
      // the evaluate call was held to the cap less the reserve; the submit call got the reserve
      expect(requests[1].max_tokens).toBeLessThan(8_000);
      expect(requests[2].max_tokens).toBeGreaterThanOrEqual(512);
      expect(requests[2].max_tokens).toBeLessThan(4096);
      expect(proposal!.usage!.usd).toBeLessThanOrEqual(0.5);
      expect(logs.some((l) => l.startsWith("anthropic: usage submitted"))).toBe(true);
    } finally {
      done();
    }
  });

  test("the reserve is not released for a change edited after its evaluation, or one that was not accepted", async () => {
    const { c, done } = setup();
    try {
      const { client, requests } = fake(script(7_500));
      const p = new AnthropicProposer({ max_usd: 0.5, efficiency: { cap_mode: "bounded", pace: true } }, client);
      // encode_ir unchanged: not accepted, so the last call never happens
      expect(await proposeWith(p, c, [measured(1.0)])).toBeNull();
      expect(requests.length).toBe(2);
    } finally {
      done();
    }
  });

  test("validated in the runtime block", () => {
    expect(efficiencyError({ cap_mode: "bounded", pace: true, submit_reserve_usd: 0.06 })).toBeNull();
    expect(efficiencyError({ pace: true })).toBe("efficiency.pace needs cap_mode bounded");
    expect(efficiencyError({ cap_mode: "bounded", pace: "yes" })).toBe("efficiency.pace is true or false");
    expect(efficiencyError({ cap_mode: "bounded", submit_reserve_usd: 2 })).toBe("efficiency.submit_reserve_usd is 0 to 1 USD");
  });
});
