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
    expect(efficiencyError({ spread: true, spread_intent_ttl_s: 1800 })).toBeNull();
    expect(efficiencyError({ spread_intent_ttl_s: 10 })).toContain("spread_intent_ttl_s");
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

// unit choice (recipes headroom lane): several active units of one repository
import { rankUnits, type UnitInput } from "../src/target-spread.ts";
import { ScriptedProposer } from "../src/proposers/scripted.ts";
import { generateAgentKey } from "@units/protocol";

describe("rankUnits", () => {
  const T2 = [{ kind: "perf" as const, name: "train_ir" }, { kind: "perf" as const, name: "encode_ir" }];
  const T5 = ["train_basic_ir", "train_regex_ir", "encode_ir", "decode_ir", "save_load_ir"].map((name) => ({ kind: "perf" as const, name }));
  const miss = (target: string, count: number) => ({ kind: "no_candidate", target: `perf:${target}`, count }) as unknown as SharedData["items"][number];
  const unit = (unit: string, targets: UnitInput["targets"], o: Partial<UnitInput> = {}): UnitInput => ({ unit, targets, intents: [], shared: null, ownFruitless: 0, ...o });

  test("a unit where anyone's attempts keep ending without a candidate sinks under a fresh one", () => {
    const r = rankUnits(A, [unit("old", T2, { shared: shared([miss("train_ir", 9), miss("encode_ir", 7), failed("encode_ir", true)]) }), unit("new", T5)]);
    expect(r.map((x) => x.unit)).toEqual(["new", "old"]);
    expect(r[1]).toMatchObject({ misses: 17, targets: 2, free_targets: 2 });
  });

  test("its own fruitless attempts on the tip count with everyone's misses, per target", () => {
    // 2 misses over 5 targets is less than 1 over 2
    const r = rankUnits(A, [unit("old", T2, { ownFruitless: 1 }), unit("new", T5, { ownFruitless: 1, shared: shared([miss("decode_ir", 1)]) })]);
    expect(r[0]!.unit).toBe("new");
    // 3 over 5 is more than 1 over 2
    expect(rankUnits(A, [unit("old", T2, { ownFruitless: 1 }), unit("new", T5, { ownFruitless: 3 })])[0]!.unit).toBe("old");
    expect(rankUnits(A, [unit("old", T2, { shared: shared([miss("train_ir", 1)]) }), unit("new", T5, { ownFruitless: 2, shared: shared([miss("decode_ir", 1)]) })])[0]!.unit).toBe("old");
  });

  test("a unit whose every target another agent holds comes after one with a free target; its own intents do not count", () => {
    const full = unit("old", T2, { intents: [intent(B, "train_ir"), intent(C, "encode_ir"), intent(A, "encode_ir")] });
    const r = rankUnits(A, [full, unit("new", T5, { ownFruitless: 4, intents: [intent(B, "decode_ir"), intent(B, "decode_ir", "expired")] })]);
    expect(r.map((x) => x.unit)).toEqual(["new", "old"]);
    expect(r[0]).toMatchObject({ free_targets: 4, others: 1 });
    expect(r[1]).toMatchObject({ free_targets: 0, others: 2 });
  });

  test("equal counts: agents do not all take the same unit, one agent's order is stable, a unit without targets goes last", () => {
    const first = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const self = String.fromCharCode(68 + i).repeat(44);
      const one = rankUnits(self, [unit("u1", T2), unit("u2", T2)]);
      expect(rankUnits(self, [unit("u2", T2), unit("u1", T2)])).toEqual(one);
      first.add(one[0]!.unit);
    }
    expect(first.size).toBe(2);
    expect(rankUnits(A, [unit("none", []), unit("u1", T2, { ownFruitless: 50 })]).map((x) => x.unit)).toEqual(["u1", "none"]);
  });

  test("a unit Core says has run dry goes after every unit that has not, whatever the other counts; a fresh unit is first while it has headroom", () => {
    // the fresh unit has every target held by another agent and misses of its own: still before the dry one
    const busy = unit("fresh", T2, { ownFruitless: 3, intents: [intent(B, "train_ir"), intent(B, "encode_ir")] });
    const r = rankUnits(A, [unit("dry", T5, { dry: true }), busy]);
    expect(r.map((x) => x.unit)).toEqual(["fresh", "dry"]);
    expect(r.map((x) => x.dry)).toEqual([false, true]);
    // three units: the two with gains in their old order, the dry one last
    const three = rankUnits(A, [unit("dry", T5, { dry: true }), unit("worked", T2, { shared: shared([miss("train_ir", 4)]) }), unit("new", T5)]);
    expect(three.map((x) => x.unit)).toEqual(["new", "worked", "dry"]);
    // every unit dry: the old order among them, so the work does not stop
    const all = rankUnits(A, [unit("d1", T2, { dry: true, shared: shared([miss("train_ir", 9)]) }), unit("d2", T5, { dry: true })]);
    expect(all.map((x) => x.unit)).toEqual(["d2", "d1"]);
    // a unit without an enabled target is still last of all
    expect(rankUnits(A, [unit("none", []), unit("dry", T2, { dry: true })]).map((x) => x.unit)).toEqual(["dry", "none"]);
  });

  test("agents spread over the units that have gains: the unit with fewer other agents per target first", () => {
    const crowded = unit("crowded", T2, { intents: [intent(B, "train_ir")] });
    const r = rankUnits(A, [crowded, unit("quiet", T2)]);
    expect(r.map((x) => x.unit)).toEqual(["quiet", "crowded"]);
  });
});

describe("the worker's unit choice", () => {
  const REPO = "https://github.com/karpathy/minbpe";
  const metrics = (names: string[]) => Object.fromEntries(names.map((n) => [n, { enabled: true }]));
  function worker(o: { spread: boolean; proposer?: string; exhausted?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "units-unit-"));
    const logs: string[] = [];
    const w = new Worker({
      core: "http://127.0.0.1:9", key: generateAgentKey(), telemetry: false, stateDir: dir, log: (m) => logs.push(m), spread: o.spread,
      proposer: { name: o.proposer ?? "anthropic", propose: async () => null, ...(o.exhausted === undefined ? {} : { exhausted: () => o.exhausted! }) },
    });
    const x = w as any;
    const units: Record<string, { repo: string; names: string[]; intents: IntentView[]; shared: SharedData["items"] }> = {
      old: { repo: REPO, names: ["train_ir", "encode_ir"], intents: [], shared: [{ kind: "no_candidate", target: "perf:train_ir", count: 6 } as never] },
      heavy: { repo: REPO, names: ["train_basic_ir", "train_regex_ir", "encode_ir", "decode_ir", "save_load_ir"], intents: [], shared: [] },
      other: { repo: "https://github.com/keis/base58", names: ["encode_ir"], intents: [], shared: [] },
    };
    const gets: string[] = [];
    x.me = async () => ({ kind: "launched", lifecycle: "active", awake: true, target_repo: REPO });
    x.client.get = async (path: string) => {
      gets.push(path);
      if (path === "/v1/lineages") return { status: 200, body: Object.entries(units).map(([lineage_id, u]) => ({ lineage_id, repo: u.repo, status: "active" })) };
      const m = /^\/v1\/lineages\/(\w+)$/.exec(path);
      if (m) return { status: 200, body: { lineage_id: m[1], repo: units[m[1]!]!.repo, recipe_id: m[1], calibration: { metrics: metrics(units[m[1]!]!.names) } } };
      const i = /^\/v1\/intents\?lineage=(\w+)$/.exec(path);
      if (i) return { status: 200, body: units[i[1]!]!.intents };
      const s = /^\/v1\/learnings\/shared\?lineage=(\w+)/.exec(path);
      if (s) return { status: 200, body: { lineage_id: s[1], tip: { gen_id: `tip-${s[1]}`, height: 1 }, items: units[s[1]!]!.shared } };
      return { status: 404, body: {} };
    };
    x.recipes = { has: () => true, get: (id: string) => ({ recipe: { metrics: units[id]!.names.map((name) => ({ name, kind: "perf" })) } }) };
    const tried: string[] = [];
    // stands in for an attempt that runs and ends without a candidate
    x.authorOn = async (view: { lineage_id: string }) => {
      tried.push(view.lineage_id);
      x.attempted = true;
      return null;
    };
    return { w, x, units, tried, logs, gets, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** the views of the repository's units, as authorOnce reads them (the order a swarm's seat is placed with) */
  const views = async (s: ReturnType<typeof worker>) => Promise.all(["old", "heavy"].map(async (id) => (await s.x.client.get(`/v1/lineages/${id}`)).body));

  test("spread on: one attempt per step, on the fresh unit first, then by its own fruitless attempts; never a unit of another repository", async () => {
    const s = worker({ spread: true });
    await s.w.authorOnce();
    expect(s.tried).toEqual(["heavy"]);
    expect(s.gets).not.toContain("/v1/lineages/other");
    expect(s.logs.some((m) => m.startsWith("unit choice: heavy of 2 units"))).toBe(true);
    // three attempts on the heavy unit's tip ended without a candidate: 3 over 5 targets against 6 misses by anyone over 2
    s.x.fruitless.set("heavy", { tip: "tip-heavy", counts: new Map([["perf:decode_ir", 2], ["perf:encode_ir", 1]]) });
    await s.w.authorOnce();
    expect(s.tried).toEqual(["heavy", "heavy"]);
    // with nothing published against the old unit, 3 over 5 is the larger share: the old unit is next
    s.units.old!.shared = [];
    await s.w.authorOnce();
    expect(s.tried).toEqual(["heavy", "heavy", "old"]);
    // misses remembered for an older tip of the heavy unit no longer count
    s.x.fruitless.set("heavy", { tip: "an-older-tip", counts: new Map([["perf:decode_ir", 3]]) });
    s.units.old!.shared = [{ kind: "no_candidate", target: "perf:train_ir", count: 1 } as never];
    await s.w.authorOnce();
    expect(s.tried.at(-1)).toBe("heavy");
    s.done();
  });

  test("spread on: a unit Core says has run dry is tried last, a seat takes the same order, and a Core without the signal changes nothing", async () => {
    const s = worker({ spread: true });
    const get = s.x.client.get;
    let dry: string[] = ["heavy"];
    s.x.client.get = async (path: string) => {
      if (path.startsWith("/v1/units/dry?repo=")) {
        expect(decodeURIComponent(path.split("=")[1]!)).toBe(REPO);
        return { status: 200, body: { units: ["old", "heavy"].map((lineage_id) => ({ lineage_id, dry: dry.includes(lineage_id) })) } };
      }
      return get(path);
    };
    // without the signal the fresh heavy unit is first (the test above); Core says it has run dry: the old unit is
    await s.w.authorOnce();
    expect(s.tried).toEqual(["old"]);
    expect(s.logs.some((m) => m.startsWith("unit choice: old of 2 units") && m.includes("1 dry unit last"))).toBe(true);
    expect((await s.x.unitOrder(await views(s))).map((v: { lineage_id: string }) => v.lineage_id)).toEqual(["old", "heavy"]);
    // both dry: the work goes on, in the old order
    dry = ["old", "heavy"];
    await s.w.authorOnce();
    expect(s.tried).toEqual(["old", "heavy"]);
    expect(s.logs.some((m) => m.includes("it has run dry, and so has every other unit"))).toBe(true);
    // neither dry
    dry = [];
    await s.w.authorOnce();
    expect(s.tried.at(-1)).toBe("heavy");
    s.done();
  });

  test("spread on: a unit that started no attempt (open limit, no budget) does not end the step", async () => {
    const s = worker({ spread: true });
    s.x.authorOn = async (view: { lineage_id: string }) => {
      s.tried.push(view.lineage_id);
      s.x.attempted = view.lineage_id === "old";
      return null;
    };
    await s.w.authorOnce();
    expect(s.tried).toEqual(["heavy", "old"]);
    s.done();
  });

  test("spread off and scripted proposers keep Core's order over every unit; an exhausted proposer starts nothing", async () => {
    const off = worker({ spread: false });
    await off.w.authorOnce();
    expect(off.tried).toEqual(["old", "heavy"]);
    off.done();
    const scripted = worker({ spread: true, proposer: "scripted" });
    await scripted.w.authorOnce();
    expect(scripted.tried).toEqual(["old", "heavy"]);
    scripted.done();
    const done = worker({ spread: true, proposer: "scripted", exhausted: true });
    await done.w.authorOnce();
    expect(done.tried).toEqual([]);
    expect(done.gets).toEqual([]);
    done.done();
    expect(new ScriptedProposer([]).exhausted()).toBe(true);
    expect(new ScriptedProposer([{ name: "p", kind: "perf", target: "t", diff: "" }]).exhausted()).toBe(false);
  });
});
