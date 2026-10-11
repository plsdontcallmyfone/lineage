import { afterEach, describe, expect, test } from "bun:test";
import { journalStatement, signJournal } from "../src/protocol.ts";
import { episodeId, LEARNINGS_LIMITS } from "../src/learnings.ts";
import { distillUnits, filesOf, ideaOf, isFinalEpisode, sharedItems, slug, targetKey, targetSlug, unitSlug } from "../src/shared-findings.ts";
import { authorLeaks, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Shared findings (docs/plans/AGENT-LEARNINGS.md 12): every listed agent's published episodes by unit and
// target, lessons distilled from measured facts, and the items a worker reads before an attempt.

let env: Env;
afterEach(() => env?.close());
const EM_DASH = String.fromCharCode(0x2014);

// ------------------------------------------------------------------------------------------------
// pure parts

const L1 = "a".repeat(64);
const G = (n: number) => n.toString(16).padStart(64, "0");
let n = 0;
function ep(o: { agent: string; name?: string; outcome: string; target?: { kind: string; target: string | string[] } | null; reason?: string; ratio?: number; parent?: number; gen?: number; files?: string[]; idea?: string; usd?: number; status?: string; detail?: string; verdictReason?: string }) {
  n++;
  const cand = ["accepted", "rejected", "expired"].includes(o.outcome) || o.status
    ? { status: o.status ?? o.outcome, reason: o.reason ?? null, gen_id: o.gen !== undefined ? G(o.gen) : null, finalized_at: 1000 + n, patch: (o.files ?? ["src/a.py"]).map((f) => `--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y`).join("\n"), semantic_hash: "s".repeat(64) }
    : null;
  const eff = o.ratio !== undefined ? { metric: "encode_ir", ratio: o.ratio, ci_low: o.ratio, ci_high: o.ratio, gain_pct: (1 - o.ratio) * 100 } : null;
  return {
    episode_id: G(1_000_000 + n), seq: n, agent: { id: o.agent, name: o.name ?? null }, outcome: o.outcome,
    task: { lineage_id: L1, recipe: { name: "base58-py", class: "python", repo: "https://github.com/keis/base58", commit: "2fae706" }, parent_gen_id: G(o.parent ?? 1), parent_height: o.parent ?? 1, target: o.target === undefined ? { kind: "perf", target: "encode_ir", source: "candidate" } : o.target },
    candidate: cand, verdict: cand ? { outcome: o.outcome === "accepted" ? "accepted" : "rejected", reason: o.verdictReason ?? o.reason ?? null, detail: o.detail ?? null, effect: eff } : null,
    effect: o.outcome === "accepted" || o.outcome === "rejected" ? eff : null, cost: o.usd !== undefined ? { usd: o.usd } : null, reward: { reverted: false },
    actions: o.idea ? [{ kind: "submit", reason: o.idea }] : [], times: { started_at: 900 + n, ended_at: 950 + n }, license: { spdx: "MIT" }, attribution: "Code excerpts from keis/base58",
  };
}

const A = "A".repeat(43), B = "B".repeat(43), C = "C".repeat(43);

describe("aggregation and lessons (deterministic, measured facts only)", () => {
  const eps = () => {
    n = 0;
    return [
      ep({ agent: A, name: "Wren", outcome: "accepted", ratio: 0.76, gen: 2, parent: 1, files: ["base58/__init__.py"], idea: `Replace the divmod loop ${EM_DASH} use int.to_bytes`, usd: 0.3 }),
      ep({ agent: B, name: "Neap", outcome: "rejected", reason: "no_improvement", ratio: 0.995, parent: 2, detail: "worst ratio 0.9950 vs required 0.9900", usd: 0.2 }),
      ep({ agent: C, outcome: "rejected", reason: "stale", ratio: 0.98, parent: 2, verdictReason: null as never }),
      ep({ agent: B, name: "Neap", outcome: "rejected", reason: "stale_conflict", verdictReason: "apply_conflict", parent: 1, files: ["base58/__init__.py", "base58/__main__.py"] }),
      ep({ agent: C, outcome: "no_candidate", target: { kind: "perf", target: "encode_ir" } }),
      ep({ agent: C, outcome: "no_candidate", target: null }),
      ep({ agent: A, name: "Wren", outcome: "accepted", target: { kind: "fix", target: ["t1", "t2"] }, gen: 3, parent: 2 }),
      // never final: dropped by the sealing filter even if something served it
      ep({ agent: C, outcome: "rejected", status: "revealed", reason: "x" }),
    ];
  };

  test("units, targets, worked, failed and why, lessons; the same input gives the same output", () => {
    const heights = new Map([[G(2), 2], [G(3), 3]]);
    const tips = new Map([[L1, { gen_id: G(3), height: 3 }]]);
    const u = distillUnits(eps(), { heights, tips });
    expect(distillUnits(eps(), { heights, tips })).toEqual(u);
    expect(u).toHaveLength(1);
    const unit = u[0]!;
    expect(unit.slug).toBe("base58-py-aaaaaaaa");
    expect(unit.attempts).toBe(7);
    expect(unit.outcomes).toEqual({ accepted: 2, rejected: 3, no_candidate: 2 });
    expect(unit.tip).toEqual({ gen_id: G(3), height: 3 });
    const perf = unit.targets.find((t) => t.key === "perf:encode_ir")!;
    expect(perf.slug).toBe("perf-encode_ir");
    expect(perf.attempts).toBe(5);
    expect(perf.worked).toHaveLength(1);
    expect(perf.worked[0]).toMatchObject({ agent: { id: A, name: "Wren" }, height: 2, parent_height: 1, files: ["base58/__init__.py"] });
    expect(perf.worked[0]!.idea).not.toContain(EM_DASH);
    expect(perf.best).toMatchObject({ metric: "encode_ir", ratio: 0.76 });
    expect(perf.best!.gain_pct).toBeCloseTo(24, 9);
    expect(perf.rejection_reasons).toEqual({ no_improvement: 1, stale: 1, stale_conflict: 1 });
    const conflict = perf.failed.find((f) => f.reason === "stale_conflict")!;
    expect(conflict.verdict_reason).toBe("apply_conflict");
    expect(perf.no_candidate.count).toBe(1);
    expect(perf.median_usd).toBeCloseTo(0.25, 12);
    const text = perf.lessons.join("\n");
    expect(text).toContain("5 attempts by 3 agents");
    expect(text).toContain("Best accepted effect: 24.00% on encode_ir (ratio 0.7600) by Wren (AAAAAAAA)");
    expect(text).toContain("Measured but below the minimum effect: 0.50% on encode_ir");
    expect(text).toContain("Measured an improvement but still failed (stale): 2.00% on encode_ir");
    expect(text).toContain("2 candidates failed because the parent moved under them");
    expect(text).toContain("1 attempt ended without a candidate");
    expect(text).not.toContain(EM_DASH);
    // every number in the lessons comes from the episodes (ratios, counts, spend)
    const fix = unit.targets.find((t) => t.key === "fix:t1,t2")!;
    expect(fix.slug).toBe("fix-t1+t2");
    expect(fix.worked[0]!.effect).toBeNull();
    expect(unit.targets.find((t) => t.key === "none")!.no_candidate.count).toBe(1);
  });

  test("items for a worker: the asked target and the current tip first, then the newest; capped", () => {
    const u = distillUnits(eps(), { tips: new Map([[L1, { gen_id: G(2), height: 2 }]]) })[0]!;
    const items = sharedItems(u, { target: "perf:encode_ir" });
    expect(items[0]!.target).toBe("perf:encode_ir");
    // failures on the current tip (generation 2) rank above the older stale_conflict on generation 1
    const failed = items.filter((i) => i.kind === "failed");
    expect(failed.slice(0, 2).every((f) => f.on_tip)).toBe(true);
    expect(failed.at(-1)!.reason).toBe("stale_conflict (apply_conflict)");
    expect(items.some((i) => i.kind === "no_candidate" && i.target === "perf:encode_ir" && i.count === 1)).toBe(true);
    expect(items.find((i) => i.target === "none")).toBeUndefined();
    expect(sharedItems(u, { limit: 2 })).toHaveLength(2);
    // no item carries a patch, a diff, an output or a note
    expect(JSON.stringify(items)).not.toContain("+++ b/");
  });

  test("paths, keys and the sealing filter", () => {
    expect(targetKey(null)).toBe("none");
    expect(targetKey({ kind: "perf", target: ["a", "b"] })).toBe("perf:a,b");
    expect(targetSlug("perf:train_ir")).toBe("perf-train_ir");
    expect(slug("../../etc/passwd")).toBe("etc-passwd");
    expect(slug("x".repeat(200)).length).toBe(80);
    expect(unitSlug(null, L1)).toBe("unit-aaaaaaaa");
    expect(filesOf("--- a/x\n+++ b/x\n+++ b/y")).toEqual(["x", "y"]);
    expect(ideaOf({ actions: [{ kind: "submit", reason: "a\nb" }] })).toBe("a b");
    expect(isFinalEpisode({ outcome: "rejected", candidate: { status: "revealed" } })).toBe(false);
    expect(isFinalEpisode({ outcome: "rejected", candidate: null })).toBe(false);
    expect(isFinalEpisode({ outcome: "no_candidate", candidate: null })).toBe(true);
    expect(isFinalEpisode({ outcome: "accepted", candidate: { status: "accepted" } })).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// Core: routes, sealing leak test, hidden launches, the dump record

const S = { edit: "SEALED_EDIT_shared_x", note: "SEALED_NOTE_shared_x", submit: "SEALED_SUBMIT_shared_x", journal: "SEALED_JOURNAL_shared_x", report: "SEALED_REPORT_shared_x" };

async function session(e: Env, a: Agent, tag: string): Promise<string> {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/events`, { events: [{ kind: "note", text: `${S.note} ${tag}` }, { kind: "edit", path: "src/lib.rs", start_line: 2, end_line: 2, lines_before: 1, lines_after: 1, before: "x", after: `${S.edit} ${tag}` }] }));
  return s.session_id;
}

const report = (note: string) => ({ v: 1, planned: { kind: "perf", target: "ir", note }, outcome: "submitted", usage: null, sandbox_s: null, models: [], harness: null, route: null });

function journal(e: Env, a: Agent, sid: string, text: string) {
  const st = journalStatement({ agent: a.id, session_id: sid, lineage_id: e.lineage, created_at: e.clock.now(), text });
  return a.c.post(`/v1/agents/${a.id}/journal`, { statement: st, sig: signJournal(a.key, st) });
}

async function finished(e: Env, a: Agent, tag: string, verdictIr: number | null) {
  const sid = await session(e, a, tag);
  const cand = await submit(e, a, diff(tag));
  await expectOk(a.c.post(`/v1/sessions/${sid}/events`, { events: [{ kind: "submit", reason: `${S.submit} ${tag}` }] }));
  await expectOk(a.c.post(`/v1/sessions/${sid}/end`, { commit_id: cand.commit_id }));
  await expectOk(a.c.post(`/v1/sessions/${sid}/episode`, report(`${S.report} ${tag}`)));
  await expectOk(journal(e, a, sid, `${S.journal} ${tag}`));
  if (verdictIr !== null) await runReplays(e, cand.candidate_id, honest(result({}, verdictIr)));
  return { sid, cand };
}

async function sharedText(e: Env): Promise<string> {
  e.clock.advance(LEARNINGS_LIMITS.sweep_every_ms + 1);
  const out: string[] = [];
  for (const u of ["/v1/learnings/units", `/v1/learnings/units?lineage=${e.lineage}`, `/v1/learnings/shared?lineage=${e.lineage}`, `/v1/learnings/shared?lineage=${e.lineage}&target=perf:ir&limit=40`, "/v1/learnings/dump"]) {
    const r = await e.anon.get(u);
    expect(r.status).toBe(200);
    out.push(JSON.stringify(r.body));
  }
  return out.join("\n");
}

describe("Core shared findings", () => {
  test("leak test: an open candidate's attempt, and the same agent's later attempts, stay out until final", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    // b: an accepted attempt (published)
    const done = await finished(e, b, "bdone", 900);
    // a: a candidate still open, and a later attempt without a candidate that mentions it
    const open = await finished(e, a, "aopen", null);
    e.clock.advance(60_000);
    const s2 = await session(e, a, "alater");
    await expectOk(a.c.post(`/v1/sessions/${s2}/end`, {}));
    await expectOk(a.c.post(`/v1/sessions/${s2}/episode`, report(`${S.report} mine ${open.cand.commit_id}`)));
    await expectOk(journal(e, a, s2, `${S.journal} alater`));

    const text = await sharedText(e);
    const leaked = [`${S.submit} aopen`, `${S.journal} aopen`, `${S.report} aopen`, `${S.edit} aopen`, `${S.note} aopen`, `${S.note} alater`, `${S.journal} alater`, open.sid, s2, open.cand.commit_id, open.cand.candidate_id, episodeId(open.sid), episodeId(s2), a.id].filter((x) => text.includes(x));
    expect(leaked).toEqual([]);
    // b's accepted work is there, with its provenance
    const sh = await expectOk(e.anon.get(`/v1/learnings/shared?lineage=${e.lineage}&target=perf:ir`));
    expect(sh.items[0]).toMatchObject({ kind: "accepted", target: "perf:ir", agent: { id: b.id }, episode_id: episodeId(done.sid) });
    expect(sh.items[0].idea).toContain("bdone");
    expect(sh.items[0].effect.metric).toBe("ir");
    expect(sh.tip.height).toBe(1);
    // the route sweep: nothing names the open candidate with its author, no sealed value is out
    const leaks = await authorLeaks(e, [{ ids: [open.cand.commit_id, open.cand.candidate_id, episodeId(open.sid), episodeId(s2)], parties: [a.id], sealed: [`${S.submit} aopen`, `${S.journal} aopen`, `${S.report} aopen`, `${S.note} alater`] }]);
    expect(leaks).toEqual([]);

    // the verdict is in: both of a's attempts become findings
    await runReplays(e, open.cand.candidate_id, honest(result({}, 1000)));
    e.clock.advance(LEARNINGS_LIMITS.sweep_every_ms + 1);
    const units = await expectOk(e.anon.get("/v1/learnings/units"));
    const t = units.units[0].targets.find((x: any) => x.key === "perf:ir");
    expect(t.attempts).toBe(3);
    expect(t.failed.map((f: any) => f.agent.id)).toEqual([a.id]);
    expect(t.no_candidate.count).toBe(1);
    expect(units.units[0].agents.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort());
    // until= freezes the view at a cursor (the dump's commits)
    const early = await expectOk(e.anon.get("/v1/learnings/units?until=1"));
    expect(early.units[0].attempts).toBe(1);
    expect(early.last_seq).toBe(1);
  });

  test("hidden test launches are left out; queries are checked; the dump record takes the runtime key only", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    await finished(e, a, "hid", 900);
    e.clock.advance(LEARNINGS_LIMITS.sweep_every_ms + 1);
    expect((await expectOk(e.anon.get("/v1/learnings/units"))).units).toHaveLength(1);
    const mint = e.core.db.query<{ mint: string }, [string]>("SELECT mint FROM agents WHERE agent_id = ?").get(a.id)!.mint;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "Test launch" }] }));
    expect((await expectOk(e.anon.get("/v1/learnings/units"))).units).toEqual([]);
    expect((await expectOk(e.anon.get(`/v1/learnings/shared?lineage=${e.lineage}`))).items).toEqual([]);
    expect((await e.anon.get("/v1/learnings/shared")).status).toBe(400);
    expect((await e.anon.get(`/v1/learnings/shared?lineage=${e.lineage}&target=nonsense`)).status).toBe(400);
    expect((await e.anon.get(`/v1/learnings/shared?lineage=${e.lineage}&limit=999`)).status).toBe(400);
    expect((await e.anon.get("/v1/learnings/units?lineage=zz")).status).toBe(400);

    const rec = { status: "published", repo: "units-agents/findings", url: "https://github.com/units-agents/findings", commit: "c".repeat(40), verified: true, episodes: 3, units: 1, agents: 1, last_seq: 3 };
    expect((await a.c.post("/v1/learnings/dump", rec)).status).toBe(403);
    expect((await e.admin.c.post("/v1/learnings/dump", { ...rec, url: "https://evil.example/x" })).status).toBe(400);
    expect((await e.admin.c.post("/v1/learnings/dump", { ...rec, reason: `a ${EM_DASH} b` })).status).toBe(400);
    await expectOk(e.admin.c.post("/v1/learnings/dump", rec));
    expect((await expectOk(e.anon.get("/v1/learnings/dump"))).dump).toMatchObject({ status: "published", episodes: 3, verified: true });
  });
});
