import { describe, expect, test } from "bun:test";
import { pickTarget } from "../src/target-spread.ts";
import { openingMessage } from "../src/proposers/anthropic.ts";
import { efficiencyError } from "../src/proposers/efficiency.ts";
import type { IntentView, ProposeContext } from "../src/proposers/types.ts";
import type { SharedData } from "../src/shared-findings.ts";

// Target spread (docs/plans/AGENT-EFFICIENCY.md section 5): agents on one unit are pointed at
// different metric targets from counts only.

const A = "A".repeat(44);
const B = "B".repeat(44);
const C = "C".repeat(44);
const TARGETS = [
  { kind: "perf" as const, name: "encode_ir" },
  { kind: "perf" as const, name: "decode_ir" },
  { kind: "perf" as const, name: "check_ir" },
];
const intent = (agent: string, target: string, status = "open"): IntentView => ({ intent_id: `${agent}${target}`, agent, kind: "perf", target, note: null, expires_at: 0, status });
const failed = (target: string, onTip: boolean) => ({ kind: "failed", target: `perf:${target}`, on_tip: onTip, count: 1 }) as unknown as SharedData["items"][number];
const shared = (items: SharedData["items"]): SharedData => ({ lineage_id: "l", tip: { gen_id: "tip", height: 20 }, items });

describe("pickTarget", () => {
  test("avoids the targets other agents hold an open intent on", () => {
    const p = pickTarget({ targets: TARGETS, intents: [intent(B, "encode_ir"), intent(C, "decode_ir")], self: A, tip: "tip", shared: null })!;
    expect(p.planned).toEqual({ kind: "perf", target: "check_ir" });
    expect(p.line).toContain("Suggested target for this attempt: perf check_ir");
    expect(p.line).toContain("no other agent has an open intent on it");
    expect(p.why.others).toBe(0);
  });

  test("its own intents, closed intents and other units' targets do not count", () => {
    const p = pickTarget({ targets: TARGETS.slice(0, 2), intents: [intent(A, "encode_ir"), intent(B, "encode_ir", "expired"), intent(B, "decode_ir")], self: A, tip: "tip", shared: null })!;
    expect(p.planned.target).toBe("encode_ir");
  });

  test("with every target taken, the one with the fewest other agents", () => {
    const p = pickTarget({ targets: TARGETS, intents: [intent(B, "encode_ir"), intent(C, "encode_ir"), intent(B, "decode_ir"), intent(C, "decode_ir"), intent(B, "check_ir")], self: A, tip: "tip", shared: null })!;
    expect(p.planned.target).toBe("check_ir");
    expect(p.line).toContain("1 other agent has an open intent on it");
  });

  test("then its own fruitless attempts on this tip, then candidates that failed on this tip", () => {
    const own = new Map([["perf:encode_ir", 2], ["perf:decode_ir", 1], ["perf:check_ir", 1]]);
    const p = pickTarget({ targets: TARGETS, intents: [], self: A, tip: "tip", shared: shared([failed("decode_ir", true), failed("check_ir", false)]), fruitless: own })!;
    // decode and check tie on own misses; decode has a failure on the tip, check's failure was on an older generation
    expect(p.planned.target).toBe("check_ir");
    expect(p.line).toContain("1 attempt of yours on this tip ended without a candidate");
    expect(p.why).toEqual({ others: 0, own_fruitless: 1, tip_failed: 0, no_candidate: 0 });
  });

  test("agents that see the same counts do not all take the same target, and the pick is stable for one agent and tip", () => {
    const picks = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const self = String.fromCharCode(68 + i).repeat(44);
      const one = pickTarget({ targets: TARGETS, intents: [], self, tip: "tip", shared: null })!;
      expect(pickTarget({ targets: TARGETS, intents: [], self, tip: "tip", shared: null })!.planned).toEqual(one.planned);
      picks.add(String(one.planned.target));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  test("no enabled target: no pick; one target: no talk of other targets", () => {
    expect(pickTarget({ targets: [], intents: [], self: A, tip: "tip", shared: null })).toBeNull();
    expect(pickTarget({ targets: TARGETS.slice(0, 1), intents: [], self: A, tip: "tip", shared: null })!.line).not.toContain("different targets");
  });

  test("the line names no agent, candidate or patch, only counts", () => {
    const p = pickTarget({ targets: TARGETS, intents: [intent(B, "encode_ir")], self: A, tip: "tip", shared: shared([failed("encode_ir", true)]) })!;
    expect(p.line).not.toContain(B);
    expect(p.line).not.toContain(A);
    expect(p.line).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("the suggestion in the prompt", () => {
  test("the opening message carries the line after the findings, and nothing without one", () => {
    const base = { findings: [{ key: "encode_ir", kind: "metric_target", target: "encode_ir" }] } as unknown as ProposeContext;
    expect(openingMessage(base)).not.toContain("Suggested target");
    const m = openingMessage({ ...base, suggested: "Suggested target for this attempt: perf check_ir (counts)." } as ProposeContext);
    expect(m.indexOf("Suggested target")).toBeGreaterThan(m.indexOf("Open findings"));
    expect(m.indexOf("Suggested target")).toBeLessThan(m.indexOf("Start by exploring"));
  });

  test("the runtime block takes spread", () => {
    expect(efficiencyError({ spread: true })).toBeNull();
    expect(efficiencyError({ spread: 1 })).toBe("efficiency.spread is true or false");
  });
});

// through a real Core: the intent one worker files for its pick is what the next worker's pick reads
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectOk, makeAuthor, setup, type Env } from "../../core/test/helpers.ts";
import { SPREAD_INTENT_TTL_S, Worker } from "../src/worker.ts";

describe("spread through Core's intents", () => {
  let env: Env | null = null;
  let dir: string | null = null;
  afterEach(() => {
    env?.close();
    env = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("the second agent is pointed at another target than the first one's open intent", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    e.clock.set(Date.now());
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    dir = mkdtempSync(join(tmpdir(), "units-spread-"));
    const wa = new Worker({ core: e.base, key: a.key, telemetry: false, stateDir: join(dir, "a"), log: () => {} });
    const wb = new Worker({ core: e.base, key: b.key, telemetry: false, stateDir: join(dir, "b"), log: () => {} });
    const view = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    const tree = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/tree`));
    const enabled = Object.entries(view.calibration.metrics as Record<string, { enabled: boolean }>).filter(([, m]) => m.enabled).map(([name]) => ({ kind: "perf" as const, name }));
    expect(enabled.length).toBeGreaterThan(1);

    const first = pickTarget({ targets: enabled, intents: await wa.intentsOn(e.lineage), self: a.id, tip: tree.gen_id, shared: null })!;
    const id = await wa.fileIntent(e.lineage, tree.gen_id, first.planned, SPREAD_INTENT_TTL_S);
    expect(id).toBeTruthy();
    const seen = await wb.intentsOn(e.lineage);
    const filed = seen.find((i) => i.intent_id === id)!;
    expect(filed).toMatchObject({ agent: a.id, kind: "perf", target: first.planned.target, status: "open" });
    // the intent lives for the spread's short time, not the worker's default half hour
    expect(filed.expires_at - Date.now()).toBeLessThanOrEqual(SPREAD_INTENT_TTL_S * 1000);

    const second = pickTarget({ targets: enabled, intents: seen, self: b.id, tip: tree.gen_id, shared: null })!;
    expect(second.planned.target).not.toBe(first.planned.target);
    // the first agent's own intent does not push it off its target
    expect(pickTarget({ targets: enabled, intents: await wa.intentsOn(e.lineage), self: a.id, tip: tree.gen_id, shared: null })!.planned).toEqual(first.planned);
  });
});
