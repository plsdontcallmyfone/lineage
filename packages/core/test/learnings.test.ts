import { afterEach, describe, expect, test } from "bun:test";
import { journalStatement, signJournal } from "../src/protocol.ts";
import { checkReport, computeReward, episodeId, hunk, learningsOf, LEARNINGS_LIMITS } from "../src/learnings.ts";
import { authorLeaks, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Agent learnings (docs/plans/AGENT-LEARNINGS.md, SPEC 17.8): one episode per finished attempt, built
// by Core from the session's events, the candidate, its replays and verdict, the journal entry and the
// worker report; published only once nothing in it can name the author of an open candidate.

let env: Env;
afterEach(() => env?.close());

const S = {
  edit: "SEALED_EDIT_unrolled_inner_loop",
  note: "SEALED_NOTE_hypothesis_divmod",
  output: "SEALED_OUTPUT_ratio_0.91",
  submit: "SEALED_SUBMIT_rationale",
  journal: "SEALED_JOURNAL_text",
  report: "SEALED_REPORT_planned_note",
};
const SEALED = Object.values(S);

async function startSession(e: Env, a: Agent): Promise<string> {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  await expectOk(
    a.c.post(`/v1/sessions/${s.session_id}/events`, {
      events: [
        { kind: "note", text: `${S.note}: encode spends its time in divmod` },
        { kind: "list", path: ".", count: 4 },
        { kind: "read", path: "src/lib.rs", start_line: 1, end_line: 3 },
        { kind: "search", query: "slow_", matches: 2 },
        { kind: "edit", path: "src/lib.rs", start_line: 2, end_line: 2, lines_before: 1, lines_after: 1, before: "    slow();", after: `    fast(); // ${S.edit}` },
        { kind: "evaluate", target: "ir", eval_kind: "perf" },
        { kind: "phase", phase: "build" },
        { kind: "phase", phase: "metrics" },
        { kind: "result", outcome: "accepted", output: `metric ir: parent 1000, candidate 910 ${S.output}` },
      ],
    }),
  );
  return s.session_id;
}

const report = (note = S.report) => ({
  v: 1,
  planned: { kind: "perf", target: "ir", note },
  outcome: "submitted a perf candidate",
  usage: { input_tokens: 10, output_tokens: 2000, cache_read_tokens: 5000, cache_write_tokens: 1000, usd: 0.25 },
  sandbox_s: 120,
  models: ["claude-opus-5-5"],
  harness: { name: "anthropic", version: "anthropic/1", digest: "a".repeat(64), provider: "anthropic" },
  route: { via: "direct", model: { provider: "anthropic", id: "claude-opus-5-5" }, upstream: [] },
});

function journal(e: Env, a: Agent, sid: string, text: string) {
  const st = journalStatement({ agent: a.id, session_id: sid, lineage_id: e.lineage, created_at: e.clock.now(), text });
  return a.c.post(`/v1/agents/${a.id}/journal`, { statement: st, sig: signJournal(a.key, st) });
}

const exportAll = async (e: Env, extra = "") => {
  e.clock.advance(LEARNINGS_LIMITS.sweep_every_ms + 1);
  return (await expectOk(e.anon.get(`/v1/learnings/episodes?limit=200${extra}`))).episodes as any[];
};

/** Every public learnings surface as text (the authorLeaks sweep covers the rest). */
async function learningsText(e: Env, a: Agent): Promise<string> {
  e.clock.advance(LEARNINGS_LIMITS.sweep_every_ms + 1);
  const urls = ["/v1/learnings/episodes?limit=200", "/v1/learnings/episodes?format=jsonl&limit=1000", `/v1/learnings/episodes?agent=${a.id}`, "/v1/learnings/stats", `/v1/learnings/lessons?agent=${a.id}`, "/v1/learnings/repos"];
  const out: string[] = [];
  for (const u of urls) {
    const r = await e.anon.get(u);
    out.push(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  }
  return out.join("\n");
}

describe("reward (measured facts only)", () => {
  const cost = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.5, sandbox_s: 1800, source: "provenance:hosted" as const };
  test("accepted metric candidate: effect is 1 - ratio, normalised by measured cost", () => {
    const r = computeReward("accepted", { metric: "ir", ratio: 0.75, ci_low: 0.75, ci_high: 0.75, gain_pct: 25 }, cost);
    expect(r.accepted).toBe(1);
    expect(r.effect).toBeCloseTo(0.25, 12);
    expect(r.effect_per_usd).toBeCloseTo(0.5, 12);
    expect(r.effect_per_sandbox_hour).toBeCloseTo(0.5, 12);
    expect(r.inputs).toEqual(["outcome", "verdict.effect.ratio", "cost.usd (provenance:hosted)", "cost.sandbox_s (provenance:hosted)"]);
  });
  test("rejected, expired, no candidate and abandoned are zero, whatever was measured", () => {
    for (const o of ["rejected", "expired", "no_candidate", "abandoned"] as const) {
      const r = computeReward(o, { metric: "ir", ratio: 0.5, ci_low: 0.5, ci_high: 0.5, gain_pct: 50 }, cost);
      expect(r).toMatchObject({ accepted: 0, effect: 0, fixed_tests: 0 });
      expect(r.effect_per_usd).toBe(0);
    }
  });
  test("accepted fix counts tests, has no metric effect; unknown cost gives null ratios", () => {
    const r = computeReward("accepted", { fixed: ["t1", "t2"] }, null);
    expect(r).toMatchObject({ accepted: 1, effect: null, fixed_tests: 2, effect_per_usd: null, effect_per_sandbox_hour: null });
    const z = computeReward("accepted", { metric: "ir", ratio: 0.9, ci_low: null, ci_high: null, gain_pct: 10 }, { ...cost, usd: 0, sandbox_s: null });
    expect(z.effect_per_usd).toBeNull();
    expect(z.effect_per_sandbox_hour).toBeNull();
    expect(computeReward("accepted", { metric: "ir", ratio: 0.9, ci_low: null, ci_high: null, gain_pct: 10 }, null, true).reverted).toBe(true);
  });
  test("worker report shape", () => {
    expect(checkReport(report()).usage?.usd).toBe(0.25);
    expect(() => checkReport({ ...report(), extra: 1 })).toThrow();
    expect(() => checkReport({ ...report(), outcome: "slow — fast" })).toThrow();
    expect(() => checkReport({ ...report(), usage: { usd: -1 } })).toThrow();
    expect(() => checkReport({ ...report(), harness: { name: "x", version: "1", digest: "zz", provider: "p" } })).toThrow();
    expect(hunk("a.rs", 3, "x\ny", "z")).toBe("--- a/a.rs\n+++ b/a.rs\n@@ -3,2 +3,1 @@\n-x\n-y\n+z");
  });
});

describe("episodes (SPEC 17.8)", () => {
  test("built from the recorded session: actions, diff, hypotheses, candidate, replays, verdict, journal, report, reward", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const sid = await startSession(e, a);
    const cand = await submit(e, a, diff("ep"));
    await expectOk(a.c.post(`/v1/sessions/${sid}/events`, { events: [{ kind: "submit", reason: S.submit }] }));
    await expectOk(a.c.post(`/v1/sessions/${sid}/end`, { commit_id: cand.commit_id }));
    await expectOk(a.c.post(`/v1/sessions/${sid}/episode`, report()));
    // once only, own session only
    expect((await expectOk(a.c.post(`/v1/sessions/${sid}/episode`, report()))).stored).toBe(false);
    expect((await a.c.post(`/v1/sessions/${sid}/episode`, report("other"))).status).toBe(409);
    const other = await makeAuthor(e);
    expect((await other.c.post(`/v1/sessions/${sid}/episode`, report())).status).toBe(403);
    await expectOk(journal(e, a, sid, `${S.journal}. Tried the divmod loop.`));
    await runReplays(e, cand.candidate_id, honest(result({}, 900)));

    const eps = await exportAll(e);
    expect(eps).toHaveLength(1);
    const ep = eps[0];
    expect(ep).toMatchObject({ schema: "lineage-episode/1", episode_id: episodeId(sid), session_id: sid, seq: 1, outcome: "accepted" });
    expect(ep.agent.id).toBe(a.id);
    expect(ep.task.lineage_id).toBe(e.lineage);
    expect(ep.task.metrics.map((m: any) => m.name)).toEqual(["ir", "ns", "size"]);
    expect(ep.task.target).toEqual({ kind: "perf", target: "ir", source: "candidate" });
    expect(ep.task.baseline.ir.median).toBe(1000);
    expect(ep.plan.planned).toEqual({ kind: "perf", target: "ir", note: S.report });
    expect(ep.hypotheses[0]).toContain(S.note);
    const kinds = ep.actions.map((x: any) => x.kind);
    expect(kinds).toEqual(["note", "list", "read", "search", "edit", "evaluate", "result", "submit"]);
    expect(ep.actions[4].diff).toBe(`--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -2,1 +2,1 @@\n-    slow();\n+    fast(); // ${S.edit}`);
    expect(ep.actions[5].phases.map((p: any) => p.phase)).toEqual(["build", "metrics"]);
    expect(ep.actions[6].output).toContain(S.output);
    expect(ep.actions[7].reason).toBe(S.submit);
    expect(ep.candidate).toMatchObject({ commit_id: cand.commit_id, candidate_id: cand.candidate_id, status: "accepted", kind: "perf" });
    expect(ep.candidate.patch).toContain("fast_ep_0");
    expect(ep.replays.filter((r: any) => r.counted).length).toBeGreaterThan(0);
    expect(ep.replays[0].metrics.ir).toMatchObject({ base: [1000], cand: [900], ratio: 0.9 });
    expect(ep.verdict.outcome).toBe("accepted");
    expect(ep.effect.metric).toBe("ir");
    expect(ep.effect.ratio).toBeCloseTo(0.9, 12);
    expect(ep.effect.gain_pct).toBeCloseTo(10, 9);
    // no provenance in this test: cost and model come from the worker report, labelled as claimed
    expect(ep.cost).toMatchObject({ usd: 0.25, sandbox_s: 120, source: "worker_report" });
    expect(ep.model).toMatchObject({ provider: "anthropic", models: ["claude-opus-5-5"], source: "worker_report" });
    expect(ep.reward.accepted).toBe(1);
    expect(ep.reward.effect).toBeCloseTo(0.1, 12);
    expect(ep.reward.effect_per_usd).toBeCloseTo(0.4, 12);
    expect(ep.journal.text).toContain(S.journal);
    expect(ep.attribution).toContain("https://github.com/example/fx");
    expect(ep.verify.candidate).toBe(`/v1/candidates/${cand.commit_id}`);
    // one by id; lessons from it
    expect((await expectOk(e.anon.get(`/v1/learnings/episodes/${ep.episode_id}`))).session_id).toBe(sid);
    const les = await expectOk(e.anon.get(`/v1/learnings/lessons?agent=${a.id}`));
    expect(les.lineages[0].targets[0]).toMatchObject({ target: "perf:ir", attempts: 1, outcomes: { accepted: 1 }, files_accepted: ["src/lib.rs"] });
    expect(les.lineages[0].journal[0].text).toContain(S.journal);
    expect((await expectOk(e.anon.get("/v1/learnings/stats"))).by_outcome).toEqual({ accepted: 1 });
  });

  test("leak test: nothing about an open attempt is public, nor a later no-candidate attempt of the same agent", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    // a: a candidate still open
    const s1 = await startSession(e, a);
    const cand = await submit(e, a, diff("open"));
    await expectOk(a.c.post(`/v1/sessions/${s1}/events`, { events: [{ kind: "submit", reason: S.submit }] }));
    await expectOk(a.c.post(`/v1/sessions/${s1}/end`, { commit_id: cand.commit_id }));
    await expectOk(a.c.post(`/v1/sessions/${s1}/episode`, report()));
    await expectOk(journal(e, a, s1, `${S.journal}: waiting for replays.`));
    // a: a later attempt with no candidate, ended (its session gate is open), mentioning the open one
    e.clock.advance(60_000);
    const s2 = await startSession(e, a);
    await expectOk(a.c.post(`/v1/sessions/${s2}/end`, {}));
    await expectOk(a.c.post(`/v1/sessions/${s2}/episode`, report(`${S.report} my open ${cand.commit_id}`)));
    // b: a control attempt with no candidate and nothing open
    const s3 = await startSession(e, b);
    await expectOk(b.c.post(`/v1/sessions/${s3}/end`, {}));
    await expectOk(b.c.post(`/v1/sessions/${s3}/episode`, report("control")));
    await expectOk(journal(e, a, s2, `${S.journal}: nothing worth submitting.`));
    await expectOk(journal(e, b, s3, "control entry"));

    const eps = await exportAll(e);
    expect(eps.map((x) => x.session_id)).toEqual([s3]);
    expect(eps[0].seq).toBe(1);
    const text = await learningsText(e, a);
    // b's control episode carries the sentinels of b's own finished session (note, edit, output), never a's
    const leaked = [S.submit, S.journal, S.report, s1, s2, cand.commit_id, cand.candidate_id, episodeId(s1), episodeId(s2)].filter((x) => text.includes(x));
    expect(leaked).toEqual([]);
    // the event log never gains anything from learnings
    expect(JSON.stringify((await e.anon.get("/v1/events/log?since=0&limit=5000")).body)).not.toContain("episode");
    expect((await e.anon.get(`/v1/learnings/episodes/${episodeId(s1)}`)).status).toBe(404);
    expect((await e.anon.get(`/v1/learnings/episodes/${s2}`)).status).toBe(404);
    expect((await expectOk(e.anon.get(`/v1/learnings/episodes?agent=${a.id}`))).episodes).toEqual([]);
    expect((await expectOk(e.anon.get(`/v1/learnings/stats`))).agents).toBe(1);
    // the full route sweep: no object names the open candidate with its author, no sealed value is out
    const leaks = await authorLeaks(e, [{ ids: [cand.commit_id, cand.candidate_id, episodeId(s1), episodeId(s2)], parties: [a.id], sealed: [S.submit, S.journal, S.report] }]);
    expect(leaks).toEqual([]);

    // verdict in: both of a's episodes publish, after the control, with no gap in the cursor
    await runReplays(e, cand.candidate_id, honest(result({}, 900)));
    const after = await exportAll(e);
    expect(after.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(new Set(after.slice(1).map((x) => x.session_id))).toEqual(new Set([s1, s2]));
    const ep2 = after.find((x) => x.session_id === s2);
    expect(ep2.outcome).toBe("no_candidate");
    expect(ep2.reward).toMatchObject({ accepted: 0, effect: 0 });
    expect(ep2.task.target).toEqual({ kind: "perf", target: "ir", source: "worker_report.planned" });
  });

  test("waits for the journal and the report after the end; abandoned sessions publish after 24 h of silence", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const s1 = await startSession(e, a);
    await expectOk(a.c.post(`/v1/sessions/${s1}/end`, {}));
    expect(await exportAll(e)).toHaveLength(0); // no report, no journal: the 2 h write window
    e.clock.advance(LEARNINGS_LIMITS.bare_grace_ms);
    const eps = await exportAll(e);
    expect(eps.map((x) => x.outcome)).toEqual(["no_candidate"]);
    expect(eps[0].cost).toBeNull();
    // too late for a report now
    expect((await a.c.post(`/v1/sessions/${s1}/episode`, report())).status).toBe(409);
    const s2 = await startSession(e, a);
    expect(await exportAll(e)).toHaveLength(1);
    e.clock.advance(24 * 3600 * 1000 + 1);
    const later = await exportAll(e);
    expect(later.find((x) => x.session_id === s2)?.outcome).toBe("abandoned");
  });

  test("export paging: since is exclusive, next_since resumes, jsonl carries the cursor in headers, filters and hidden", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await startSession(e, a);
      await expectOk(a.c.post(`/v1/sessions/${s}/end`, {}));
      await expectOk(a.c.post(`/v1/sessions/${s}/episode`, report(`n${i}`)));
      await expectOk(journal(e, a, s, `entry ${i}`));
      ids.push(s);
    }
    e.clock.advance(LEARNINGS_LIMITS.sweep_every_ms + 1);
    const p1 = await expectOk(e.anon.get("/v1/learnings/episodes?limit=2"));
    expect(p1.episodes.map((x: any) => x.seq)).toEqual([1, 2]);
    expect(p1).toMatchObject({ next_since: 2, more: true });
    const p2 = await expectOk(e.anon.get(`/v1/learnings/episodes?limit=2&since=${p1.next_since}`));
    expect(p2.episodes.map((x: any) => x.seq)).toEqual([3, 4]);
    const p3 = await expectOk(e.anon.get(`/v1/learnings/episodes?limit=2&since=${p2.next_since}`));
    expect(p3.episodes.map((x: any) => x.seq)).toEqual([5]);
    expect(p3).toMatchObject({ next_since: 5, more: false });
    expect((await expectOk(e.anon.get("/v1/learnings/episodes?since=5"))).episodes).toEqual([]);
    expect(new Set([...p1.episodes, ...p2.episodes, ...p3.episodes].map((x: any) => x.session_id))).toEqual(new Set(ids));

    const res = await fetch(`${e.base}/v1/learnings/episodes?format=jsonl&limit=3&since=1`);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("x-next-since")).toBe("4");
    expect(res.headers.get("x-more")).toBe("1");
    expect(res.headers.get("link")).toContain("since=4");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((x) => x.seq)).toEqual([2, 3, 4]);
    expect((await e.anon.get("/v1/learnings/episodes?format=csv")).status).toBe(400);
    expect((await e.anon.get("/v1/learnings/episodes?limit=-1")).status).toBe(400);
    expect((await expectOk(e.anon.get("/v1/learnings/episodes?outcome=accepted"))).episodes).toEqual([]);
    expect((await expectOk(e.anon.get("/v1/learnings/episodes?provider=anthropic"))).episodes).toHaveLength(5);

    // a hidden test launch leaves the export unless asked for
    const mint = e.core.db.query<{ mint: string }, [string]>("SELECT mint FROM agents WHERE agent_id = ?").get(a.id)!.mint;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "Test launch" }] }));
    expect((await expectOk(e.anon.get("/v1/learnings/episodes"))).episodes).toEqual([]);
    expect((await expectOk(e.anon.get("/v1/learnings/episodes?hidden=1"))).episodes).toHaveLength(5);
    const schema = await expectOk(e.anon.get("/v1/learnings/schema"));
    expect(schema.schema).toBe("lineage-episode/1");
    expect(JSON.stringify(schema)).not.toContain("—");
  });

  test("publication records: runtime key only, shape checked", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const a = await makeAuthor(e);
    const rec = { agent: a.id, status: "published", repo: "x/lineage-learnings", url: "https://github.com/x/lineage-learnings", commit: "c".repeat(40), verified: true, episodes: 3, last_seq: 3 };
    expect((await a.c.post("/v1/learnings/repos", { repos: [rec] })).status).toBe(403);
    expect((await e.admin.c.post("/v1/learnings/repos", { repos: [{ ...rec, url: "https://evil.example/x" }] })).status).toBe(400);
    await expectOk(e.admin.c.post("/v1/learnings/repos", { repos: [rec] }));
    expect((await expectOk(e.anon.get(`/v1/learnings/repos?agent=${a.id}`))).repos[0]).toMatchObject({ status: "published", episodes: 3, verified: true });
    expect(learningsOf(e.core).repos().repos).toHaveLength(1);
  });
});
