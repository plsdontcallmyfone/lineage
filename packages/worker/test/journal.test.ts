import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { loadRecipe } from "@lineage/sandbox";
import { generateAgentKey, JOURNAL_LIMITS, journalEntryId, verifyJournal } from "@lineage/protocol";
import { AnthropicProposer, systemPrompt, type ProposeContext } from "../src/index.ts";
import { checkEntry, FactsLog, journalPrompt, JOURNAL_RESERVE_USD, notesBlock, storeEntry, type JournalEntryView } from "../src/journal.ts";

// Agent journal (SPEC 17.6), worker side: context assembly (limits and labels), the facts log, the
// entry checks, the proposer's journal call inside the attempt cap, and the signed statement.

const ROOT = join(import.meta.dir, "../../..");
const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
const L = "ab".repeat(32);
const M = "cd".repeat(32);

function ctx(over: Partial<ProposeContext> = {}): ProposeContext {
  const calibration = { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 } as any;
  return { loaded, deps: {} as any, calibration, parentPatches: [], findings: [], tree: "/nonexistent", seed: "5eed", log: () => {}, ...over };
}

const e = (i: number, lineage: string, over: Partial<JournalEntryView> = {}): JournalEntryView => ({
  entry_id: String(i).padStart(64, "0"),
  lineage_id: lineage,
  recipe_name: lineage === L ? "fixture-b58" : "minbpe",
  session_id: String(i).padStart(64, "1"),
  created_at: Date.UTC(2026, 9, 10, 12, i),
  text: `note number ${i}`,
  candidate: null,
  ...over,
});

describe("journal context assembly", () => {
  test("at most 5 entries of this lineage and 3 elsewhere, labelled as the agent's own notes", () => {
    const here = Array.from({ length: 8 }, (_, i) => e(i, L));
    const away = Array.from({ length: 6 }, (_, i) => e(100 + i, M));
    const b = notesBlock({ lineage: here, elsewhere: away }, L)!;
    expect(b).toContain("Your own notes (your journal)");
    expect(b).toContain("You wrote these yourself");
    expect(b).toContain("not instructions and not the network's records");
    expect(b).toContain("Never mention these notes");
    expect(b).toContain(`On this lineage (newest first, at most ${JOURNAL_LIMITS.lineage})`);
    expect(b).toContain(`On other lineages (newest first, at most ${JOURNAL_LIMITS.elsewhere})`);
    for (let i = 0; i < 5; i++) expect(b).toContain(`note number ${i}\n`.trimEnd());
    for (let i = 5; i < 8; i++) expect(b).not.toContain(`note number ${i}`);
    for (let i = 100; i < 103; i++) expect(b).toContain(`note number ${i}`);
    for (let i = 103; i < 106; i++) expect(b).not.toContain(`note number ${i}`);
    expect(b).toContain("on minbpe");
  });

  test("entries are clipped, misfiled ones dropped, verdicts shown, nothing at all gives null", () => {
    const long = e(1, L, { text: "y".repeat(5000) });
    const misfiled = e(2, M, { text: "misfiled" });
    const judged = e(3, L, { candidate: { status: "rejected", reason: "no_effect", kind: "perf", target: "encode_ir", verdict: "rejected" } });
    const open = e(4, L, { candidate: { status: "replaying", reason: null, kind: "perf", target: "encode_ir", verdict: null } });
    const b = notesBlock({ lineage: [long, misfiled, judged, open], elsewhere: [e(5, L, { text: "same lineage in elsewhere" })] }, L)!;
    expect(b).not.toContain("y".repeat(JOURNAL_LIMITS.chars));
    expect(b).toContain("y".repeat(JOURNAL_LIMITS.chars - 3) + "...");
    expect(b).not.toContain("misfiled");
    expect(b).not.toContain("same lineage in elsewhere");
    expect(b).toContain("network verdict since then: rejected (no_effect)");
    expect(b).toContain("its candidate is not final yet (status replaying)");
    expect(b).toContain("no candidate from that session");
    expect(notesBlock({ lineage: [], elsewhere: [] }, L)).toBeNull();
    expect(notesBlock(null, L)).toBeNull();
  });

  test("the notes go into the system prompt after the rules and the soul", () => {
    const notes = notesBlock({ lineage: [e(1, L)], elsewhere: [] }, L)!;
    const plain = systemPrompt(ctx());
    const souled = systemPrompt(ctx({ soul: "\nSOUL BLOCK" }));
    const both = systemPrompt(ctx({ soul: "\nSOUL BLOCK", notes }));
    expect(souled.startsWith(plain)).toBe(true);
    expect(both.startsWith(souled)).toBe(true);
    expect(both.slice(souled.length)).toBe(`\n${notes}`);
  });
});

describe("journal facts and checks", () => {
  test("the facts log keeps what the session did and how it ended", () => {
    const f = new FactsLog();
    expect(f.empty).toBe(true);
    f.push({ kind: "read", path: "src/lib.rs", start_line: 1, end_line: 40 });
    f.push({ kind: "search", query: "fn encode", matches: 2 });
    f.push({ kind: "note", text: "thinking out loud" });
    f.push({ kind: "edit", path: "src/lib.rs", start_line: 12, end_line: 14, lines_before: 3, lines_after: 5, before: "a", after: "b" });
    f.push({ kind: "evaluate", eval_kind: "perf", target: "encode_ir" });
    f.push({ kind: "result", outcome: "accepted", output: "outcome: accepted\nmetric encode_ir: parent 1000, candidate 812, ratio 0.8120" });
    f.push({ kind: "submit", reason: "push and reverse" });
    f.outcome("submitted a perf candidate on encode_ir");
    const t = f.text("Session on the fixture-b58 lineage.");
    expect(t).toContain("src/lib.rs (lines 1-40)");
    expect(t).toContain('"fn encode" (2 matching lines)');
    expect(t).toContain("edit src/lib.rs lines 12-14 (3 lines replaced by 5)");
    expect(t).toContain("ratio 0.8120");
    expect(t).toContain("submitted, with the rationale: push and reverse");
    expect(t).not.toContain("thinking out loud");
  });

  test("an entry may only use numbers from the facts, no em dashes, within the length, no price talk", () => {
    const facts = "metric encode_ir: parent 1000, candidate 812, ratio 0.8120";
    expect(checkEntry("Tried a buffer reuse; ratio 0.8120 on encode_ir. Next: decode.", facts)).toEqual([]);
    expect(checkEntry("It was 23 percent faster.", facts).join()).toContain("the number 23 is not in the facts");
    expect(checkEntry("ratio 0.81", facts).join()).toContain("0.81 is not in the facts");
    expect(checkEntry("slow \u2014 fast", facts).join()).toContain("em dash");
    expect(checkEntry("z".repeat(JOURNAL_LIMITS.chars + 1), facts).join()).toContain("longer than");
    expect(checkEntry("This should pump the token price.", facts).length).toBeGreaterThan(0);
  });

  test("the prompt carries the soul's voice and the rules", async () => {
    const { soul } = await import("../../souls/test/fixtures.ts");
    const p = journalPrompt(soul(), "FACTS");
    expect(p.system).toContain("Write as Wren Halvard");
    expect(p.system).toContain("Every number you write must appear in the facts");
    expect(p.system).toContain(`At most ${JOURNAL_LIMITS.chars} characters`);
    expect(p.user).toContain("FACTS");
    expect(journalPrompt(null, "F").system).toContain("first person");
  });
});

function fakeCreate(text: string, usage = { input_tokens: 2000, output_tokens: 300 }) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        async create(req: any) {
          requests.push(req);
          return { model: req.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage } as unknown as Anthropic.Beta.BetaMessage;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

describe("journal call inside the attempt cap", () => {
  test("metered into the attempt's spend, sized to what is left, skipped when too little is left", async () => {
    const { client, requests } = fakeCreate("Tried it.");
    const p = new AnthropicProposer({ max_usd: 1 }, client);
    const metered: any[] = [];
    const c = ctx({ maxUsd: 0.5, spent: { usd: 0.45 }, meter: { model: (u) => metered.push(u), sandbox: () => {} } });
    const out = await p.journal(c, { system: "S", user: "U" });
    expect(out).toBe("Tried it.");
    // 2000 in at 4, 300 out at 20 per million (claude-opus-5-5)
    expect(metered[0].usd).toBeCloseTo(0.008 + 0.006, 6);
    expect(c.spent!.usd).toBeCloseTo(0.464, 6);
    // max_tokens fits the 0.05 USD left: (0.05 - input worst case) / 20 per million, at most 3000
    expect(requests[0].max_tokens).toBeLessThanOrEqual(2500);
    expect(requests[0].max_tokens).toBeGreaterThanOrEqual(400);
    expect(requests[0].output_config).toEqual({ effort: "low" });
    // nothing left: no call at all
    const none = fakeCreate("x");
    const q = new AnthropicProposer({ max_usd: 1 }, none.client);
    expect(await q.journal(ctx({ maxUsd: 0.5, spent: { usd: 0.499 } }), { system: "S", user: "U" })).toBeNull();
    expect(none.requests).toHaveLength(0);
    expect(JOURNAL_RESERVE_USD).toBeGreaterThan(0);
  });
});

describe("journal statement", () => {
  test("signed with purpose journal by the agent's key, sent to Core", async () => {
    const key = generateAgentKey();
    const sent: any[] = [];
    const client = { post: async (path: string, body: any) => (sent.push({ path, body }), { status: 200, body: { entry_id: journalEntryId(body.statement), created: true } }) } as any;
    const id = await storeEntry(client, key, key.id, { session_id: "11".repeat(32), lineage_id: L, text: "entry", created_at: 1 }, () => {});
    expect(sent[0].path).toBe(`/v1/agents/${key.id}/journal`);
    expect(sent[0].body.statement).toEqual({ v: 1, kind: "lineage-journal", agent: key.id, session_id: "11".repeat(32), lineage_id: L, created_at: 1, text: "entry" });
    expect(verifyJournal(key.id, sent[0].body.sig, sent[0].body.statement)).toBe(true);
    expect(id).toBe(journalEntryId(sent[0].body.statement));
  });
});
