import { afterEach, describe, expect, test } from "bun:test";
import { journalStatement, signJournal } from "../src/protocol.ts";
import { LEARNINGS_LIMITS } from "../src/learnings.ts";
import { DRY_DEFAULTS, dryVerdict, parseDrySettings, type DryAttempt } from "../src/unit-dry.ts";
import { expectOk, makeAuthor, setup, testConfig, type Agent, type Env } from "./helpers.ts";

// Units that run dry (docs/plans/AGENT-EFFICIENCY.md 8.1): the rule is pure and reads only final
// attempts, accepted changes and the calibration's fixed values.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const H = 3_600_000;
const NOW = 1_000 * H;
const none = (at: number): DryAttempt => ({ outcome: "no_candidate", reason: null, gain_pct: null, at });
const acc = (at: number, gain: number | null): DryAttempt => ({ outcome: "accepted", reason: null, gain_pct: gain, at });
const rej = (at: number, reason: string): DryAttempt => ({ outcome: "rejected", reason, gain_pct: null, at });
const base = (attempts: DryAttempt[], over: Partial<Parameters<typeof dryVerdict>[0]> = {}) => ({ attempts, created_at: NOW - 100 * H, last_accepted_at: null, fixed: {}, now: NOW, ...over });
const seq = (n: number, f: (at: number, i: number) => DryAttempt) => Array.from({ length: n }, (_, i) => f(NOW - (i + 1) * 60_000, i));

describe("the dry rule (pure)", () => {
  test("a unit with fewer final attempts than min_attempts is fresh, never dry", () => {
    const v = dryVerdict(base(seq(7, none)));
    expect(v).toMatchObject({ dry: false, fresh: true, rule: null, line: null });
    expect(v.facts).toMatchObject({ attempts: 7, fruitless: 7, fruitless_share: 1, best_gain_pct: null });
    expect(dryVerdict(base([]))).toMatchObject({ dry: false, fresh: true });
  });

  test("fruitless: most of the window ended without an improvement and nothing accepted in it was large", () => {
    // 9 of 12 fruitless (7 no candidate, 2 no_improvement), 2 small accepted gains, 1 lost to order
    const a = [...seq(7, none), rej(NOW - 8 * 60_000, "no_improvement"), rej(NOW - 9 * 60_000, "no_improvement"), acc(NOW - 10 * 60_000, 1.2), acc(NOW - 11 * 60_000, 2.9), rej(NOW - 12 * 60_000, "stale")];
    const v = dryVerdict(base(a, { last_accepted_at: NOW - 10 * 60_000 }));
    expect(v).toMatchObject({ dry: true, fresh: false, rule: "fruitless" });
    expect(v.facts).toMatchObject({ attempts: 12, no_candidate: 7, no_improvement: 2, accepted: 2, other: 1, fruitless: 9, best_gain_pct: 2.9 });
    expect(v.line).toBe("Most recent attempts found nothing more to improve here: 9 of the last 12 ended without an improvement, and the largest accepted gain among them was 2.9%.");
    // one accepted gain at or above small_gain_pct in the window keeps it off
    a[9] = acc(NOW - 10 * 60_000, 3);
    expect(dryVerdict(base(a, { last_accepted_at: NOW - 10 * 60_000 }))).toMatchObject({ dry: false, fresh: false });
    // so does an accepted change that fixed tests (no gain figure)
    a[9] = acc(NOW - 10 * 60_000, null);
    expect(dryVerdict(base(a, { last_accepted_at: NOW - 10 * 60_000 })).dry).toBe(false);
  });

  test("only the window counts: older attempts do not make a productive unit dry, and a share under the setting does not either", () => {
    const fresh12 = seq(12, (at, i) => (i % 2 ? none(at) : acc(at, 12)));
    const old = Array.from({ length: 50 }, (_, i) => none(NOW - (100 + i) * 60_000));
    expect(dryVerdict(base([...fresh12, ...old], { last_accepted_at: NOW - 60_000 })).dry).toBe(false);
    // 7 of 12 fruitless is 58%: under 0.6
    const a = seq(12, (at, i) => (i < 7 ? none(at) : rej(at, "stale_conflict")));
    expect(dryVerdict(base(a, { last_accepted_at: NOW - H })).dry).toBe(false);
    expect(dryVerdict(base(a, { last_accepted_at: NOW - H }), { ...DRY_DEFAULTS, fruitless_share: 0.5 })).toMatchObject({ dry: true, rule: "fruitless" });
  });

  test("quiet: no accepted change for quiet_hours while min_attempts attempts ended", () => {
    // candidates keep losing to order, so the window is not fruitless; nothing was accepted for 30 hours
    const a = seq(12, (at, i) => (i < 4 ? none(at) : rej(at, "stale")));
    const v = dryVerdict(base(a, { last_accepted_at: NOW - 30 * H }));
    expect(v).toMatchObject({ dry: true, rule: "quiet" });
    expect(v.line).toBe("No change has been accepted here for 30 hours, over 12 attempts.");
    expect(v.facts.attempts_since_accepted).toBe(12);
    // 23 hours: not yet
    expect(dryVerdict(base(a, { last_accepted_at: NOW - 23 * H })).dry).toBe(false);
    // a quiet unit nobody attempted is not dry: there is no evidence
    expect(dryVerdict(base(a.map((x) => ({ ...x, at: NOW - 40 * H })), { last_accepted_at: NOW - 30 * H })).dry).toBe(false);
  });

  test("fixed: every metric that records its share is mostly not the library, and nothing large was accepted", () => {
    const a = seq(12, (at, i) => (i < 5 ? none(at) : acc(at, 1.5)));
    const fixed = { encode_ir: { fixed_value: 60, tip_value: 100, share: 0.6 }, decode_ir: { fixed_value: 52, tip_value: 100, share: 0.52 } };
    const v = dryVerdict(base(a, { last_accepted_at: NOW - 60_000, fixed }));
    expect(v).toMatchObject({ dry: true, rule: "fixed" });
    expect(v.line).toBe("What is left to measure here is mostly not the library's own work: at least 52.0% of every metric that records it.");
    // one metric still mostly library work: not dry by this rule
    expect(dryVerdict(base(a, { last_accepted_at: NOW - 60_000, fixed: { ...fixed, decode_ir: { fixed_value: 10, tip_value: 100, share: 0.1 } } })).dry).toBe(false);
    // nothing recorded: the rule never fires
    expect(dryVerdict(base(a, { last_accepted_at: NOW - 60_000 })).dry).toBe(false);
  });

  test("no sentence carries an em dash or a number that is not a fact", () => {
    for (const v of [dryVerdict(base(seq(12, none))), dryVerdict(base(seq(12, (at) => rej(at, "stale")), { last_accepted_at: NOW - 50 * H }))]) {
      expect(v.line).not.toContain(String.fromCharCode(0x2014));
      for (const n of v.line!.match(/\d+(\.\d+)?/g) ?? []) expect([v.facts.fruitless, v.facts.attempts, v.facts.attempts_since_accepted, Math.floor(v.facts.quiet_hours)].map(String)).toContain(n);
    }
  });

  test("settings: defaults, ranges, unknown fields", () => {
    expect(parseDrySettings(undefined)).toEqual(DRY_DEFAULTS);
    expect(parseDrySettings({ window: 20, _note: "x" })).toEqual({ ...DRY_DEFAULTS, window: 20 });
    expect(() => parseDrySettings({ windw: 3 })).toThrow("unknown field");
    expect(() => parseDrySettings({ fruitless_share: 1.5 })).toThrow();
    expect(() => parseDrySettings({ window: 4 })).toThrow("min_attempts above window");
    expect(testConfig().dry).toEqual(DRY_DEFAULTS);
    expect(testConfig({ dry: { window: 3, min_attempts: 2 } }).dry).toMatchObject({ window: 3, min_attempts: 2 });
    expect(() => testConfig({ dry: { quiet_hours: -1 } })).toThrow("network config: dry settings");
  });
});

// ------------------------------------------------------------------------------------------------
// Core: the facts come from published episodes

async function attempt(e: Env, a: Agent, proposer = "anthropic") {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer }));
  const sid = s.session_id as string;
  await expectOk(a.c.post(`/v1/sessions/${sid}/events`, { events: [{ kind: "read", path: "src/lib.rs", start_line: 1, end_line: 3 }] }));
  await expectOk(a.c.post(`/v1/sessions/${sid}/end`, {}));
  await expectOk(a.c.post(`/v1/sessions/${sid}/episode`, { v: 1, planned: null, outcome: "no change found", usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.01 }, sandbox_s: 1, models: ["m"], harness: null, route: null }));
  const st = journalStatement({ agent: a.id, session_id: sid, lineage_id: e.lineage, created_at: e.clock.now(), text: "Nothing I tried measured faster." });
  await expectOk(a.c.post(`/v1/agents/${a.id}/journal`, { statement: st, sig: signJournal(a.key, st) }));
  e.clock.advance(1000);
}

describe("GET /v1/units/dry", () => {
  test("a unit turns dry once enough final attempts by any agent ended without a candidate; scripted sessions are not attempts", async () => {
    const e = (env = await setup({ verifiers: 2, over: { dry: { window: 4, min_attempts: 3 } } }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const read = async () => {
      e.clock.advance(LEARNINGS_LIMITS.sweep_every_ms + 1);
      return expectOk(e.anon.get("/v1/units/dry"));
    };
    let r = await read();
    expect(r.settings).toMatchObject({ window: 4, min_attempts: 3 });
    expect(r.units).toHaveLength(1);
    expect(r.units[0]).toMatchObject({ lineage_id: e.lineage, unit_id: e.lineage, dry: false, fresh: true, line: null });
    expect(r.units[0].targets.length).toBeGreaterThan(0);
    await attempt(e, a);
    await attempt(e, b);
    await attempt(e, a, "scripted");
    r = await read();
    expect(r.units[0]).toMatchObject({ dry: false, fresh: true });
    expect(r.units[0].facts.attempts).toBe(2);
    await attempt(e, b);
    r = await read();
    expect(r.units[0]).toMatchObject({ dry: true, fresh: false, rule: "fruitless", line: "Most recent attempts found nothing more to improve here: 3 of the last 3 ended without an improvement." });
    // one unit, and the repository filter
    const one = await expectOk(e.anon.get(`/v1/units/${e.lineage}/dry`));
    expect(one).toMatchObject({ dry: true, rule: "fruitless", lineage_id: e.lineage });
    expect((await expectOk(e.anon.get(`/v1/units/dry?repo=${encodeURIComponent(r.units[0].repo)}`))).units).toHaveLength(1);
    expect((await expectOk(e.anon.get("/v1/units/dry?repo=https://github.com/none/none"))).units).toHaveLength(0);
    expect((await e.anon.get(`/v1/lineages/${"0".repeat(64)}/dry`)).status).toBe(404);
    // the unit itself is untouched: still active
    expect((await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).status).toBe("active");
  });
});
