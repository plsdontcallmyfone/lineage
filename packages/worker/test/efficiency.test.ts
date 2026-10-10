import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { loadRecipe } from "@lineage/sandbox";
import { AnthropicProposer, type ProposeContext } from "../src/index.ts";
import { MAX_TURN_TOKENS, turnAllowance } from "../src/proposers/efficiency.ts";

// Attempt efficiency settings (docs/plans/AGENT-EFFICIENCY.md): the bounded cap mode keeps the
// attempt's hard cap per call while letting cheap evaluate-and-submit turns run after one long
// thinking turn; the default (projected) behaves as before.

const ROOT = join(import.meta.dir, "../../..");
const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
const OPUS = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 };

function ctx(): { c: ProposeContext; logs: string[]; done: () => void } {
  const tree = mkdtempSync(join(tmpdir(), "eff-"));
  writeFileSync(join(tree, "a.txt"), "x\n");
  const logs: string[] = [];
  const calibration = { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 } as unknown as ProposeContext["calibration"];
  return {
    c: { loaded, deps: {} as ProposeContext["deps"], calibration, parentPatches: [], findings: [], tree, seed: "5eed", log: (m) => logs.push(m) },
    logs,
    done: () => rmSync(tree, { recursive: true, force: true }),
  };
}

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;

/** Scripted turns; each turn names its output tokens (capped at the request's max_tokens, stop_reason max_tokens when cut). */
function fake(turns: { content: Anthropic.Beta.BetaContentBlock[]; out: number }[]) {
  const requests: any[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(req: any) {
          requests.push({ max_tokens: req.max_tokens });
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

describe("turnAllowance", () => {
  test("room minus the worst-case input, in output tokens, at most the streaming maximum", () => {
    // 0.5 USD room, 10k cached prefix (0.002), 2000 new chars = 1000 tokens at the write rate (0.005)
    expect(turnAllowance({ room: 0.5, prefixTokens: 10_000, newChars: 2000, cold: false, prices: OPUS })).toBe(Math.floor(((0.5 - 0.002 - 0.005) * 1e6) / 20));
    // a cold cache prices the prefix as a write
    expect(turnAllowance({ room: 0.5, prefixTokens: 10_000, newChars: 2000, cold: true, prices: OPUS })).toBe(Math.floor(((0.5 - 0.05 - 0.005) * 1e6) / 20));
    expect(turnAllowance({ room: 100, prefixTokens: 0, newChars: 0, cold: false, prices: OPUS })).toBe(MAX_TURN_TOKENS);
    expect(turnAllowance({ room: 0.001, prefixTokens: 10_000, newChars: 0, cold: true, prices: OPUS })).toBe(0);
  });
});

describe("AnthropicProposer cap modes", () => {
  // one long thinking turn (15k output = 0.3 USD at Opus 5.5 rates), then a cheap turn, then give_up
  const script = () => [
    { content: [use("t1", "list_files", { dir: "." })], out: 15_000 },
    { content: [use("t2", "read_file", { path: "a.txt" })], out: 500 },
    { content: [use("t3", "give_up", { reason: "done" })], out: 200 },
  ];

  test("projected (default): the long turn ends the attempt at a 0.5 USD cap", async () => {
    const { c, logs, done } = ctx();
    try {
      const { client, requests } = fake(script());
      expect(await new AnthropicProposer({ max_usd: 0.5 }, client).propose(c)).toBeNull();
      expect(requests.length).toBe(1);
      expect(requests[0].max_tokens).toBe(64000);
      expect(logs.join("\n")).toContain("spend cap reached");
      expect(logs.some((l) => l.startsWith("anthropic: usage cap reached: 1 calls"))).toBe(true);
    } finally {
      done();
    }
  });

  test("bounded: the cheap turns still run, every call's allowance fits the room, spend stays under the cap", async () => {
    const { c, logs, done } = ctx();
    try {
      const { client, requests } = fake(script());
      const p = new AnthropicProposer({ max_usd: 0.5, efficiency: { cap_mode: "bounded" } }, client);
      expect(await p.propose(c)).toBeNull();
      expect(requests.length).toBe(3);
      expect(logs.join("\n")).toContain("gave up: done");
      // second call: what is left after 0.3 USD of output and the input, never the full 64000
      expect(requests[1].max_tokens).toBeLessThan(10_000);
      expect(requests[1].max_tokens).toBeGreaterThan(4096);
      const used = Number(logs.find((l) => l.startsWith("anthropic: usage gave up"))!.match(/([\d.]+) USD$/)![1]);
      expect(used).toBeLessThanOrEqual(0.5);
    } finally {
      done();
    }
  });

  test("bounded: stops before a call whose allowance is below min_turn_tokens, and when a response is cut at it", async () => {
    const { c, logs, done } = ctx();
    try {
      const { client, requests } = fake([{ content: [use("t1", "list_files", { dir: "." })], out: 20_000 }, { content: [use("t2", "list_files", { dir: "." })], out: 64_000 }]);
      const p = new AnthropicProposer({ max_usd: 0.6, efficiency: { cap_mode: "bounded", min_turn_tokens: 1000 } }, client);
      expect(await p.propose(c)).toBeNull();
      // call 2 asked for what was left and was cut there: the cap is spent, its tool call never runs
      expect(requests.length).toBe(2);
      expect(logs.join("\n")).toContain("response cut at its");
      const used = Number(logs.find((l) => l.startsWith("anthropic: usage cap reached"))!.match(/([\d.]+) USD$/)![1]);
      expect(used).toBeLessThanOrEqual(0.6);

      const small = ctx();
      try {
        const f = fake([{ content: [use("t1", "list_files", { dir: "." })], out: 100 }]);
        expect(await new AnthropicProposer({ max_usd: 0.05, efficiency: { cap_mode: "bounded", min_turn_tokens: 4096 } }, f.client).propose(small.c)).toBeNull();
        expect(f.requests.length).toBe(0);
        expect(small.logs.join("\n")).toContain("next call could only have");
      } finally {
        small.done();
      }
    } finally {
      done();
    }
  });
});

describe("runtime efficiency block", () => {
  test("validated: known settings only, with their types", async () => {
    const { efficiencyError } = await import("../src/proposers/efficiency.ts");
    expect(efficiencyError({ cap_mode: "bounded", min_turn_tokens: 4096, log_usage: true, series: true })).toBeNull();
    expect(efficiencyError({})).toBeNull();
    expect(efficiencyError({ cap_mode: "loose" })).toContain("cap_mode");
    expect(efficiencyError({ min_turn_tokens: 10 })).toContain("min_turn_tokens");
    expect(efficiencyError({ series: "yes" })).toContain("series");
    expect(efficiencyError({ model: "claude-haiku-4-5" })).toContain("not a setting");
    expect(efficiencyError([])).toContain("object");
  });
});
