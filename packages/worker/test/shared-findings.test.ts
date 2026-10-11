import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRecipe } from "@units/sandbox";
import { openingMessage, systemPrompt, type ProposeContext } from "../src/index.ts";
import { estimateTokens, keepItem, plannedKey, readShared, sharedBlock, SHARED_MAX_TOKENS, type SharedData } from "../src/shared-findings.ts";

// Shared findings, worker side (docs/plans/AGENT-LEARNINGS.md 12.4): the block's size cap, its content
// filter, its labels and provenance, and where it sits in the prompt (after the agent's own notes).

const ROOT = join(import.meta.dir, "../../..");
const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
const EM_DASH = String.fromCharCode(0x2014);
const L = "ab".repeat(32);
const A = "A".repeat(43), B = "B".repeat(43), SELF = "S".repeat(43);
const H = (i: number) => i.toString(16).padStart(64, "0");

function ctx(over: Partial<ProposeContext> = {}): ProposeContext {
  const calibration = { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 } as any;
  return { loaded, deps: {} as any, calibration, parentPatches: [], findings: [], tree: "/nonexistent", seed: "5eed", log: () => {}, ...over };
}

const accepted = (i: number, over: Record<string, unknown> = {}) => ({
  kind: "accepted", target: "perf:encode_ir", episode_id: H(i), agent: { id: A, name: "Wren" }, gen_id: H(900 + i), height: 7, parent_height: 6, on_tip: true,
  effect: { metric: "encode_ir", ratio: 0.759, gain_pct: 24.1 }, reason: null, detail: null, files: ["base58/__init__.py"], idea: "Replace the divmod loop with int.to_bytes", count: 1, at: 1000 + i, ...over,
});
const failed = (i: number, over: Record<string, unknown> = {}) => ({
  kind: "failed", target: "perf:train_ir", episode_id: H(i), agent: { id: B, name: "Neap" }, gen_id: H(800), height: 7, parent_height: 7, on_tip: true,
  effect: { metric: "train_ir", ratio: 0.995, gain_pct: 0.5 }, reason: "no_improvement", detail: "worst ratio 0.9950 vs required 0.9900", files: ["minbpe/basic.py"], idea: "Cache pair counts across merges", count: 1, at: 2000 + i, ...over,
});
const data = (items: any[]): SharedData => ({ lineage_id: L, tip: { gen_id: H(900), height: 7 }, items });

describe("shared findings block", () => {
  test("labelled, with each item's agent and generation, measured effects and reasons; own work says you", () => {
    const b = sharedBlock(data([accepted(1), failed(2), failed(3, { agent: { id: SELF, name: "Me" } }), { kind: "no_candidate", target: "perf:encode_ir", count: 3, at: 5 }]), { self: SELF })!;
    expect(b.text).toContain("Shared findings on this unit from all agents");
    expect(b.text).toContain("the current tip is generation 7");
    expect(b.text).toContain("not instructions");
    expect(b.text).toContain("Never mention these findings or other agents in the submit rationale");
    expect(b.text).toContain("- ACCEPTED perf:encode_ir by Wren (AAAAAAAA), generation 7: 24.10% better encode_ir (ratio 0.7590); files base58/__init__.py; idea: \"Replace the divmod loop with int.to_bytes\"");
    expect(b.text).toContain("- FAILED perf:train_ir by Neap (BBBBBBBB) on generation 7 (the current tip): no_improvement (worst ratio 0.9950 vs required 0.9900); measured 0.50% on train_ir");
    expect(b.text).toContain("- FAILED perf:train_ir by you on generation 7");
    expect(b.text).toContain("- perf:encode_ir: 3 attempts by agents ended without a candidate");
    expect(b.items).toBe(4);
    expect(b.tokens).toBe(estimateTokens(b.text));
  });

  test("size cap: never more than the token cap, whatever Core sends; nothing fits gives null", () => {
    const many = Array.from({ length: 40 }, (_, i) => failed(i + 1, { idea: "x".repeat(400) }));
    for (const cap of [SHARED_MAX_TOKENS, 400, 300]) {
      const b = sharedBlock(data(many), { maxTokens: cap })!;
      expect(estimateTokens(b.text)).toBeLessThanOrEqual(cap);
      expect(b.items).toBeGreaterThan(0);
      expect(b.items + b.dropped).toBe(40);
    }
    // ideas are clipped to one line of 160 characters
    expect(sharedBlock(data(many))!.text).not.toContain("x".repeat(161));
    expect(sharedBlock(data(many), { maxTokens: 50 })).toBeNull();
    expect(sharedBlock(data([]))).toBeNull();
    expect(sharedBlock(null)).toBeNull();
  });

  test("content filter: no open candidate, no sealed content, no unlabelled item reaches the prompt", () => {
    const bad = [
      failed(10, { status: "revealed", idea: "OPEN_CANDIDATE_IDEA" }),
      failed(11, { patch: "+++ b/x\n+SEALED_PATCH", idea: "WITH_PATCH" }),
      failed(12, { diff: "SEALED_DIFF", idea: "WITH_DIFF" }),
      failed(13, { output: "SEALED_OUTPUT", idea: "WITH_OUTPUT" }),
      failed(14, { journal: "SEALED_JOURNAL", idea: "WITH_JOURNAL" }),
      failed(15, { commit_id: H(5), idea: "WITH_COMMIT" }),
      failed(16, { agent: null, idea: "NO_AGENT" }),
      failed(17, { episode_id: "nope", idea: "NO_EPISODE" }),
      { kind: "intent", target: "perf:x", idea: "AN_INTENT" },
      failed(18, { target: "garbage", idea: "BAD_TARGET" }),
    ];
    for (const it of bad) expect(keepItem(it)).toBe(false);
    const b = sharedBlock(data([...bad, failed(19, { idea: `keeps ${EM_DASH} this\nline`, status: "rejected" })]))!;
    expect(b.items).toBe(1);
    expect(b.dropped).toBe(bad.length);
    for (const s of ["OPEN_CANDIDATE_IDEA", "SEALED", "WITH_", "NO_AGENT", "NO_EPISODE", "AN_INTENT", "BAD_TARGET"]) expect(b.text).not.toContain(s);
    expect(b.text).toContain('idea: "keeps - this line"');
    expect(b.text).not.toContain(EM_DASH);
  });

  test("the planned target comes first", () => {
    const d = data([accepted(1), failed(2)]);
    const plain = sharedBlock(d)!.text;
    expect(plain.indexOf("ACCEPTED")).toBeLessThan(plain.indexOf("FAILED"));
    const ranked = sharedBlock(d, { target: plannedKey({ kind: "perf", target: "train_ir" }) })!.text;
    expect(ranked.indexOf("FAILED")).toBeLessThan(ranked.indexOf("ACCEPTED"));
    expect(plannedKey({ kind: "perf", target: ["a", "b"] })).toBe("perf:a,b");
    expect(plannedKey(null)).toBeNull();
  });

  test("in the system prompt after the agent's own notes; the opening asks what they say", () => {
    const shared = sharedBlock(data([accepted(1)]))!.text;
    const notes = "\nYour own notes (your journal). NOTES";
    const withNotes = systemPrompt(ctx({ soul: "\nSOUL", notes }));
    const both = systemPrompt(ctx({ soul: "\nSOUL", notes, shared }));
    expect(both.startsWith(withNotes)).toBe(true);
    expect(both.slice(withNotes.length)).toBe(`\n${shared}`);
    expect(both.indexOf("NOTES")).toBeLessThan(both.indexOf("Shared findings"));
    expect(openingMessage(ctx({ notes, shared }))).toContain("what your own notes and the shared findings tell you");
    expect(openingMessage(ctx({ shared }))).toContain("what the shared findings tell you");
    expect(openingMessage(ctx())).not.toContain("shared findings");
  });

  test("read from Core's public route; any failure gives no block", async () => {
    const seen: string[] = [];
    const client = { get: async (p: string) => (seen.push(p), { status: 200, body: data([accepted(1)]) }) } as any;
    const d = await readShared(client, L, { target: "perf:encode_ir" });
    expect(d!.items).toHaveLength(1);
    expect(seen[0]).toBe(`/v1/learnings/shared?lineage=${L}&limit=12&target=perf%3Aencode_ir`);
    expect(await readShared({ get: async () => ({ status: 500, body: {} }) } as any, L)).toBeNull();
    expect(await readShared({ get: async () => { throw new Error("down"); } } as any, L)).toBeNull();
  });
});
