import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEARNINGS_LIMITS } from "../src/learnings.ts";
import { generateAgentKey } from "../src/protocol.ts";
import { parseGateViewers, viewersOf, VIEWERS_FRESH_MS } from "../src/viewers.ts";
import { authorLeaks, CALIB, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Env } from "./helpers.ts";

// Read-only aggregates for the Projects, Generations and Analytics pages
// (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md): figures equal the records they summarise,
// hidden launches stay out unless hidden=1, and an open candidate changes nothing but its lineage's
// open count (author-blind replay, SPEC 10.7).

let env: Env;
afterEach(() => env?.close());

const CACHE = 10_001;
const SECTIONS = ["ops", "work", "results", "spend", "models", "verifiers", "social", "launches", "dashboard"];
const report = {
  v: 1,
  planned: { kind: "perf", target: "ir", note: null },
  outcome: "submitted a perf candidate",
  usage: { input_tokens: 10, output_tokens: 2000, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.5 },
  sandbox_s: 120,
  models: ["claude-opus-5-5"],
  harness: { name: "anthropic", version: "anthropic/1", digest: "a".repeat(64), provider: "anthropic" },
  route: { via: "direct", model: { provider: "anthropic", id: "claude-opus-5-5" }, upstream: [] },
};

/** One attempt: a session, a candidate replayed to its verdict (ir 1000 -> irCand), the worker's report. */
async function attempt(e: Env, a: Awaited<ReturnType<typeof makeAuthor>>, name: string, irCand: number, rep: Record<string, unknown> = report) {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  const cand = await submit(e, a, diff(name));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/end`, { commit_id: cand.commit_id }));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/episode`, rep));
  await runReplays(e, cand.candidate_id, honest(result({}, irCand)));
  return { session: s.session_id as string, cand };
}

/** The analytics routes as text, minus the clock. */
async function views(e: Env, extra = "") {
  e.clock.advance(Math.max(CACHE, LEARNINGS_LIMITS.sweep_every_ms + 1));
  const urls = [
    `/v1/analytics/projects?all=1${extra}`, `/v1/analytics/project?repo=example/fx${extra}`, `/v1/analytics/generations?limit=200${extra}`,
    ...["24h", "7d", "all"].map((w) => `/v1/analytics/overview?window=${w}${extra}`),
    // the expansion's section routes (plan section 5)
    ...SECTIONS.flatMap((r) => ["24h", "all"].map((w) => `/v1/analytics/${r}?window=${w}${extra}`)),
  ];
  const out: Record<string, any> = {};
  for (const u of urls) out[u] = await expectOk(e.anon.get(u));
  return out;
}
const strip = (v: any): any =>
  JSON.parse(JSON.stringify(v, (k, x) => (["now", "since", "started_at", "open_candidates", "hourly", "core"].includes(k) ? undefined : x)));

describe("analytics aggregates", () => {
  test("projects, project and generations: figures equal the generation, its replays and the calibration", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const { cand } = await attempt(e, a, "one", 900);
    const c = await expectOk(e.anon.get(`/v1/candidates/${cand.commit_id}`));
    expect(c.status).toBe("accepted");
    const gen = await expectOk(e.anon.get(`/v1/generations/${c.gen_id}`));
    const v = await views(e);

    const ps = v["/v1/analytics/projects?all=1"].projects;
    expect(ps).toHaveLength(1);
    const p = ps[0];
    expect(p).toMatchObject({ key: "example/fx", repo: "https://github.com/example/fx", github: true, accepted: 1, accepted_by_test_launches: 0, authors: 1, last_improvement_at: gen.accepted_at, open_candidates: 0 });
    const ir = p.lineages[0].metrics.find((m: any) => m.name === "ir");
    expect(ir).toMatchObject({ baseline: CALIB.metrics.ir!.base_value, best: { value: 900, height: 1, gen_id: c.gen_id }, improvement_pct: 10, measured_generations: 1 });
    // a metric the calibration disabled has no baseline
    expect(p.lineages[0].metrics.find((m: any) => m.name === "size").baseline).toBeNull();
    // only active GitHub repositories without all=1; this one is active on GitHub, so it is listed either way
    expect((await expectOk(e.anon.get("/v1/analytics/projects"))).projects).toHaveLength(1);

    const pj = v["/v1/analytics/project?repo=example/fx"];
    expect(pj.lineages[0].timeline).toHaveLength(1);
    expect(pj.lineages[0].timeline[0]).toMatchObject({ gen_id: c.gen_id, height: 1, author: a.id, author_hidden: false, metric: "ir", gain_pct: 10 });
    expect(pj.lineages[0].metrics.find((m: any) => m.name === "ir").points).toEqual([{ height: 1, gen_id: c.gen_id, value: 900, parent: 1000, replays: expect.any(Number), at: gen.accepted_at, targeted: true }]);
    expect((await e.anon.get("/v1/analytics/project?repo=nobody/none")).status).toBe(404);
    expect((await e.anon.get("/v1/analytics/project")).status).toBe(400);

    const g = v["/v1/analytics/generations?limit=200"];
    expect(g.total).toBe(1);
    expect(g.rows[0]).toMatchObject({ gen_id: c.gen_id, repo_key: "example/fx", height: 1, author: a.id, metric: "ir", gain_pct: 10, accepted_at: gen.accepted_at, effect: gen.effect });
    expect(g.facets.metrics).toEqual(["ir"]);
    // filters and sorts
    expect((await expectOk(e.anon.get(`/v1/analytics/generations?agent=${generateAgentKey().id}`))).total).toBe(0);
    expect((await expectOk(e.anon.get("/v1/analytics/generations?metric=ns"))).total).toBe(0);
    expect((await expectOk(e.anon.get("/v1/analytics/generations?from=2000-01-01&sort=effect&dir=asc"))).total).toBe(1);
    expect((await e.anon.get("/v1/analytics/generations?sort=fees")).status).toBe(400);
    expect((await e.anon.get("/v1/analytics/generations?from=yesterday")).status).toBe(400);
  });

  test("overview: costs, models and verification from published episodes and final replays; runtime cap and desktops as reported", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    await attempt(e, a, "one", 900);
    await attempt(e, a, "two", 800);
    e.clock.advance(LEARNINGS_LIMITS.bare_grace_ms + 1);
    // the runtime's spend report, with the platform cap and the desktop pool's counts
    await expectOk(
      e.admin.c.post("/v1/admin/runtime/spend", {
        price: { source: "config", status: "test", usd_per_token: null, line_per_usd: "1000000", why: null },
        provider_balance: { openrouter: null },
        cap: { max_usd: 10, window_s: 86400, window_start: 0, window_end: 86_400_000, spent_usd: 2.5, left_usd: 7.5, lifetime_usd: 30, scope: "subsidized", past_windows: [{ start: 0, window_s: 86400, usd: 9.9 }] },
        desktops: { required: true, local: { running: 1, max: 2 }, hosts: null, e2b: { running: 2, max: 6, spent_today_usd: 1.25, cap_usd: 16 } },
        agents: { [a.id]: { vault: "100", vault_usd: 4, burn_per_h: "10", burn_usd_per_h: 0.4, burn_window_s: 3600, runway_h: 10, model: { provider: "anthropic", id: "claude-opus-5-5" }, via: "direct", waiting: "desktop slot: none free" } },
      }),
    );
    const o = (await views(e))["/v1/analytics/overview?window=all"];
    expect(o.costs.totals).toMatchObject({ attempts: 2, priced: 2, usd: 1, accepted: 2, usd_per_accepted: 0.5, gain_pct: 30, sandbox_s: 240 });
    expect(o.costs.totals.usd_per_gain_pct).toBeCloseTo(1 / 30, 6);
    expect(o.costs.by_agent[0]).toMatchObject({ agent: a.id, attempts: 2, usd: 1 });
    const m = o.models.rows[0];
    expect(m).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", attempts: 2, accepted: 2, rate: null, mean_gain_pct: null, gain_samples: 2 });
    expect(o.thresholds).toEqual({ min_attempts_for_rate: 5, min_accepted_for_means: 3 });
    expect(o.activity).toMatchObject({ generations_total: 2, generations_in_window: 2 });
    expect(o.verification.replays.counted).toBeGreaterThan(0);
    expect(o.verification.agreement).toBe(1);
    expect(o.network.runtime.cap).toMatchObject({ max_usd: 10, spent_usd: 2.5, scope: "subsidized", past_windows: [{ start: 0, window_s: 86400, usd: 9.9 }] });
    expect(o.network.runtime.desktops).toEqual({ required: true, local: { running: 1, max: 2 }, hosts: null, e2b: { running: 2, max: 6, spent_today_usd: 1.25, cap_usd: 16 } });
    expect(o.network.waiting).toEqual([{ agent: a.id, name: null, waiting: "desktop slot: none free", category: "desktop slot", reported_at: expect.any(Number) }]);
    expect(o.costs.runway[0]).toMatchObject({ agent: a.id, runway_h: 10, vault_usd: 4 });
    expect((await e.anon.get("/v1/analytics/overview?window=1y")).status).toBe(400);
  });

  test("hidden launches: left out of agent rows and the explorer unless hidden=1; kept in the lineage with the author withheld", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const { cand } = await attempt(e, a, "one", 900);
    e.clock.advance(LEARNINGS_LIMITS.bare_grace_ms + 1);
    const mint = (await expectOk(e.anon.get(`/v1/agents/${a.id}`))).mint as string;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "test launch" }] }));
    const off = await views(e);
    expect(off["/v1/analytics/generations?limit=200"].total).toBe(0);
    expect(off["/v1/analytics/overview?window=all"].costs.by_agent).toEqual([]);
    const p = off["/v1/analytics/projects?all=1"].projects[0];
    expect(p).toMatchObject({ accepted: 1, accepted_by_test_launches: 1, authors: 0 });
    const t = off["/v1/analytics/project?repo=example/fx"].lineages[0].timeline[0];
    expect(t).toMatchObject({ author: null, author_name: null, author_hidden: true, model: null });
    expect(JSON.stringify(off)).not.toContain(a.id);
    const on = await views(e, "&hidden=1");
    expect(on["/v1/analytics/generations?limit=200&hidden=1"].rows[0]).toMatchObject({ author: a.id, test_launch: true, gen_id: (await expectOk(e.anon.get(`/v1/candidates/${cand.commit_id}`))).gen_id });
    expect(on["/v1/analytics/overview?window=all&hidden=1"].costs.by_agent[0].agent).toBe(a.id);
  });

  test("author-blind: an open candidate changes nothing but its lineage's open count, and no route names its author", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    await attempt(e, a, "one", 900);
    e.clock.advance(LEARNINGS_LIMITS.bare_grace_ms + 1);
    const quiet = await makeAuthor(e);
    const before = await views(e);
    expect(before["/v1/analytics/overview?window=all"].costs.totals.attempts).toBe(1);
    const open = await submit(e, quiet, diff("sealed"));
    const after = await views(e);
    expect(strip(after)).toEqual(strip(before));
    expect(after["/v1/analytics/project?repo=example/fx"].open_candidates).toBe(before["/v1/analytics/project?repo=example/fx"].open_candidates + 1);
    // the launches section lists every launched agent (as GET /v1/agents does), before its commit too;
    // no other route names the author of the open candidate
    for (const [u, body] of Object.entries(after)) {
      if (u.startsWith("/v1/analytics/launches")) expect(JSON.stringify(before[u]).includes(quiet.id)).toBe(JSON.stringify(body).includes(quiet.id));
      else expect(JSON.stringify(body), u).not.toContain(quiet.id);
    }
    expect(JSON.stringify(after)).not.toContain(open.commit_id);
    expect(await authorLeaks(e, [{ ids: [open.commit_id, open.candidate_id], parties: [quiet.id], sealed: [] }])).toEqual([]);
  });
  test("expansion sections: figures equal the episodes, candidates, replays and records they summarise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "units-ops-"));
    writeFileSync(join(dir, "deploys.jsonl"), [
      JSON.stringify({ kind: "deploy", sha: "a".repeat(40), previous: "b".repeat(40), started_at: 1, public_at: 2, ended_at: 3, result: "ok", probe: { probes: 40, non_200: 0, longest_gap_ms: 1200 } }),
      "not json",
      JSON.stringify({ kind: "deploy", sha: "c".repeat(40), started_at: 4, ended_at: 5, result: "rolled_back", failed_unit: "units-web", probe: { probes: 30, non_200: 2, longest_gap_ms: 4100 } }),
      JSON.stringify({ kind: "restore_test", snapshot: "core-x.tar.zst", started_at: 6, ended_at: 7, result: "PASS", passed: 5, failed: 0 }),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "monitor.json"), JSON.stringify({ at: "2026-10-11T00:00:00.000Z", worst: "warn", checks: [{ id: "backup", level: "ok", msg: "newest Core snapshot 12 min old" }, { id: "disk:/", level: "warn", msg: "80% used" }] }));
    process.env.UNITS_OPS_DIR = dir;
    process.env.UNITS_MONITOR_STATE = join(dir, "monitor.json");
    try {
      const e = (env = await setup({ verifiers: 3 }));
      const a = await makeAuthor(e);
      // an attempt that ends at the spend cap with no candidate
      const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
      const s3 = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
      await expectOk(a.c.post(`/v1/sessions/${s3.session_id}/end`, {}));
      await expectOk(a.c.post(`/v1/sessions/${s3.session_id}/episode`, { ...report, outcome: "no candidate: the session stopped without submitting a change [stop: cap reached; model calls: 13]", usage: { ...report.usage, usd: 0.25 } }));
      e.clock.advance(1_000);
      const one = await attempt(e, a, "one", 900, { ...report, outcome: "submitted a perf candidate [stop: submitted; model calls: 9]", usage: { input_tokens: 100, output_tokens: 2000, cache_read_tokens: 300, cache_write_tokens: 100, usd: 0.5 } });
      await attempt(e, a, "two", 800);
      e.clock.advance(LEARNINGS_LIMITS.bare_grace_ms + 1);
      for (const day of [0.5, 1.75, 1.25]) {
        await expectOk(e.admin.c.post("/v1/admin/runtime/spend", {
          price: { source: "config", status: "test", usd_per_token: null, line_per_usd: "1000000", why: null },
          provider_balance: { openrouter: { usd: 40 + day } },
          desktops: { required: true, local: { running: 0, max: 2 }, hosts: null, e2b: { running: 0, max: 6, spent_today_usd: day, cap_usd: 16 } },
          agents: { [a.id]: { vault: "100", vault_usd: 4, burn_per_h: "10", burn_usd_per_h: 0.4, burn_window_s: 3600, runway_h: 10, model: null, via: "direct", waiting: null } },
        }));
      }
      const v = await views(e);
      const eps = (await expectOk(e.anon.get("/v1/learnings/episodes?limit=200"))).episodes as any[];
      expect(eps).toHaveLength(3);

      const ops = v["/v1/analytics/ops?window=all"];
      expect(ops.deploys.log.map((d: any) => d.sha[0])).toEqual(["c", "a"]);
      expect(ops.deploys.in_window).toMatchObject({ deploys: 2, rolled_back: 1, non_200: 2, probes: 70, longest_gap_ms: 4100 });
      expect(ops.restore_tests[0]).toMatchObject({ kind: "restore_test", result: "PASS", passed: 5, failed: 0 });
      expect(ops.monitor).toMatchObject({ worst: "warn", checks: [{ id: "backup", level: "ok" }, { id: "disk:/", level: "warn" }] });
      // the day's highest E2B report, not the last
      expect(ops.e2b_daily).toEqual([{ day: new Date(e.clock.now()).toISOString().slice(0, 10), usd: 1.75 }]);
      expect(ops.sandbox.series.reduce((n: number, x: any) => n + (x.unknown ?? 0) + (x.rust ?? 0), 0)).toBe(eps.reduce((n, x) => n + (x.cost?.sandbox_s ?? 0), 0));
      expect(ops.viewers).toBeNull();

      const w = v["/v1/analytics/work?window=all"];
      expect(w.outcomes.totals).toMatchObject({ accepted: 2, cap_reached: 1, no_candidate: 0 });
      expect(w.outcomes.stop_recorded).toBe(2);
      expect(w.tools.turns).toMatchObject({ n: 2, median: 11 });
      expect([...w.tools.stops].sort((x: any, y: any) => x.stop.localeCompare(y.stop))).toEqual([{ stop: "cap reached", n: 1 }, { stop: "submitted", n: 1 }]);
      expect(w.tools.tool_calls.n).toBe(3);
      // diff() changes one line: one added, one removed
      expect(w.lines).toMatchObject({ n: 2, median: 2 });
      const commit = eps.filter((x) => x.candidate).map((x) => (x.candidate.committed_at - x.times.started_at) / 1000);
      expect(w.times.start_to_commit_s.n).toBe(commit.length);
      expect(w.rate.by_agent[0]).toMatchObject({ agent: a.id, attempts: 3, accepted: 2, rate: null });
      expect(w.conflicts[0]).toMatchObject({ project: "example/fx", final: 2, conflicts: 0 });
      expect(w.generations.reduce((n: number, x: number) => n + x, 0)).toBe(2);

      const r = v["/v1/analytics/results?window=all"];
      const ir = r.metrics.find((m: any) => m.metric === "ir");
      expect(ir).toMatchObject({ baseline: 1000, improvement_pct: 20, records: 2 });
      expect(ir.points.map((p: any) => p.best)).toEqual([900, 800]);
      expect(r.wins.all_time.map((x: any) => x.gain_pct)).toEqual([20, 10]);

      const sp = v["/v1/analytics/spend?window=all"];
      expect(sp.totals).toMatchObject({ usd: 1.25, priced: 3, attempts: 3, nothing_usd: 0.25, nothing_share: 0.2 });
      // cache hit: read over read + input + write, summed over priced episodes with tokens
      expect(sp.cache.read_tokens).toBe(300);
      expect(sp.cache.hit_rate).toBeCloseTo(300 / (300 + 100 + 10 + 10 + 100), 4);
      expect(sp.anthropic).toEqual({ usd: 1.25, attempts: 3 });
      expect(sp.openrouter.now.usd).toBe(41.25);
      expect(sp.openrouter.samples).toEqual([{ at: Math.floor(e.clock.now() / 3_600_000) * 3_600_000, usd: 40.5 }]);

      const m = v["/v1/analytics/models?window=all"];
      expect(m.failures[0]).toMatchObject({ model: "claude-opus-5-5", attempts: 3, failed: 1, outcomes: { cap_reached: 1 }, reasons: [{ reason: "no candidate: cap reached", n: 1 }] });

      const vf = v["/v1/analytics/verifiers?window=all"];
      const reps = e.core.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM replays WHERE kind IN ('replay', 'reference')").get()!.n;
      expect(vf.replays).toBe(reps);
      expect(vf.verifiers.reduce((n: number, x: any) => n + x.replays, 0)).toBe(reps);
      expect(vf.challenges.open).toBe(0);

      const so = v["/v1/analytics/social?window=all"];
      expect(so.totals.episodes).toBe(3);
      expect(so.series.reduce((n: number, x: any) => n + x.episodes, 0)).toBe(3);
      expect(so.series[so.series.length - 1].episodes_total).toBe(3);

      const la = v["/v1/analytics/launches?window=all"];
      expect(la.agents.map((x: any) => x.agent)).toEqual([a.id]);
      expect(la.series.reduce((n: number, x: any) => n + x.launches, 0)).toBe(1);
      expect(one.session).toBeTruthy();
      for (const sct of SECTIONS) expect((await e.anon.get(`/v1/analytics/${sct}?window=1y`)).status).toBe(400);
    } finally {
      delete process.env.UNITS_OPS_DIR;
      delete process.env.UNITS_MONITOR_STATE;
    }
  });

  test("dashboard: a window is its buckets, scripted attempts apart, the period before, and figures equal the records", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const DAY = 86_400_000;
    // day 0: one accepted model attempt (ir 1000 -> 900, 0.5 USD)
    await attempt(e, a, "one", 900);
    e.clock.advance(2 * DAY);
    // two days on: a scripted attempt (no model, no report), a model attempt at the cap, an accepted one
    const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    const sc = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "scripted" }));
    await expectOk(a.c.post(`/v1/sessions/${sc.session_id}/end`, {}));
    const cap = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
    await expectOk(a.c.post(`/v1/sessions/${cap.session_id}/end`, {}));
    await expectOk(a.c.post(`/v1/sessions/${cap.session_id}/episode`, { ...report, outcome: "no candidate [stop: cap reached; model calls: 13]", usage: { ...report.usage, usd: 0.25 } }));
    e.clock.advance(1_000);
    await attempt(e, a, "two", 800);
    e.clock.advance(LEARNINGS_LIMITS.bare_grace_ms + 1);
    const v = await views(e);
    const eps = (await expectOk(e.anon.get("/v1/learnings/episodes?limit=200"))).episodes as any[];
    expect(eps).toHaveLength(4);

    const all = v["/v1/analytics/dashboard?window=all"];
    expect(all.prev).toBeNull();
    expect(all.axis.unit).toBe("day");
    expect(all.axis.t).toHaveLength(Math.round((all.range.to - all.range.from) / DAY));
    // model attempts and scripted attempts never mix
    expect(all.attempts.totals.model).toMatchObject({ accepted: 2, cap_reached: 1, no_candidate: 0 });
    expect(Object.values(all.attempts.totals.scripted as Record<string, number>).reduce((n, x) => n + x, 0)).toBe(1);
    expect(all.kpis.acceptance).toMatchObject({ attempts: 3, accepted: 2, value: 0.6667, prev: null });
    // every headline figure is the sum of its series
    const sum = (xs: (number | null)[]) => xs.reduce<number>((n, x) => n + (x ?? 0), 0);
    expect(all.kpis.improvements).toMatchObject({ value: 2, prev: null, gain_pct: 30 });
    expect(sum(all.kpis.improvements.series)).toBe(2);
    expect(all.kpis.spend.value).toBe(1.25);
    expect(sum(all.kpis.spend.series)).toBeCloseTo(1.25, 6);
    expect(sum(all.spend.map((x: any) => x.accepted))).toBe(2);
    expect(all.kpis.cost_per_accepted.value).toBe(0.625);
    expect(all.kpis.cost_per_accepted.running[all.axis.t.length - 1]).toBe(0.625);
    expect(all.kpis.cost_per_accepted.series.filter((x: any) => x !== null)).toEqual([0.5, 0.75]);
    expect(all.kpis.agents).toMatchObject({ value: 1, live_now: 0 });
    // generations as events, cumulative from what came before the window
    expect(all.improvements.projects).toEqual([expect.objectContaining({ project: "example/fx", before: 0, generations: 2, gain_pct: 30 })]);
    expect(all.improvements.events.map((x: any) => x.gain_pct)).toEqual([10, 20]);
    expect(all.improvements.wins[0]).toMatchObject({ gain_pct: 20, agent: a.id });
    expect(all.models).toEqual([expect.objectContaining({ model: "claude-opus-5-5", attempts: 3, accepted: 2, usd: 1.25, rate: null, gain_per_usd: null })]);
    expect(all.agents).toEqual([expect.objectContaining({ agent: a.id, attempts: 3, scripted: 1, accepted: 2, usd: 1.25, generations: 2, runway: null })]);
    expect(all.reasons).toEqual([{ outcome: "cap_reached", reason: "cap reached", n: 1, usd: 0.25 }]);
    // replays of final candidates, by role
    const reps = e.core.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM replays WHERE kind IN ('replay', 'reference')").get()!.n;
    expect(all.verification.replays).toBe(reps);
    expect(all.verification.series.reduce((n: number, x: any) => n + x.counted + x.minority + x.env_failed + x.other, 0)).toBe(reps);
    expect(all.verification.verifiers.reduce((n: number, x: any) => n + x.replays, 0)).toBe(reps);
    expect(all.verification.agreement).toBe(1);

    // 24 h: the first attempt is the period before
    const d = v["/v1/analytics/dashboard?window=24h"];
    expect(d.axis.unit).toBe("hour");
    expect(d.axis.t).toHaveLength(24);
    expect(d.prev).toEqual({ from: d.range.from - 24 * 3_600_000, to: d.range.from });
    expect(d.kpis.improvements).toMatchObject({ value: 1, prev: 0 });
    expect(d.kpis.spend).toMatchObject({ value: 0.75, prev: null });
    expect(d.improvements.projects[0]).toMatchObject({ before: 1, generations: 1 });
    // 7 d and 30 d hold all of it, with nothing in the period before
    for (const w of ["7d", "30d"]) {
      const x = await expectOk(e.anon.get(`/v1/analytics/dashboard?window=${w}`));
      expect(x.axis.t).toHaveLength(w === "7d" ? 7 : 30);
      expect(x.kpis.improvements).toMatchObject({ value: 2, prev: 0 });
      expect(x.kpis.acceptance).toMatchObject({ attempts: 3, prev: null, prev_attempts: 0 });
      expect(x.kpis.spend).toMatchObject({ value: 1.25, prev: null });
    }
    expect((await e.anon.get("/v1/analytics/overview?window=30d")).status).toBe(200);
  });

  test("viewer counts: the gate's counts only, hourly peaks, hidden launches left out unless hidden=1", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const h = await makeAuthor(e);
    const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    const open = async (x: typeof a) => (await expectOk(x.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic", desktop: true }))).session_id as string;
    const sa = await open(a), sh = await open(h);
    const mint = (await expectOk(e.anon.get(`/v1/agents/${h.id}`))).mint as string;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "test launch" }] }));
    // only counts of 64 hex sessions survive the parse: no address, no cap, nothing else
    const unknown = "f".repeat(64);
    const g = parseGateViewers({ at: 1, total: 99, cap: 300, sessions: { [sa]: 3, [sh]: 4, [unknown]: 2, "10.0.0.1": 5, bad: "x" }, viewers: ["10.0.0.1"] })!;
    expect(g).toEqual({ total: 9, sessions: { [sa]: 3, [sh]: 4, [unknown]: 2 } });
    expect(parseGateViewers("nope")).toBeNull();
    // before any sample: unknown, not zero
    expect((await expectOk(e.anon.get("/v1/viewers"))).total).toBeNull();
    const vw = viewersOf(e.core);
    expect(vw.record(g)).toMatchObject({ recorded: true });
    expect(vw.record({ total: 50, sessions: { [sa]: 50 } })).toMatchObject({ recorded: false }); // one sample a minute
    e.clock.advance(60_000);
    vw.record({ total: 1, sessions: { [sa]: 1 } });
    e.clock.advance(10_001);

    const pub = await expectOk(e.anon.get("/v1/viewers"));
    expect(pub).toMatchObject({ total: 1, sessions: [{ session_id: sa, agent: a.id, viewers: 1 }] });
    const d = await expectOk(e.anon.get("/v1/analytics/dashboard?window=24h"));
    expect(d.kpis.viewers).toMatchObject({ value: 1, peak: 3 });
    expect(d.kpis.viewers.series.filter((x: any) => x !== null)).toEqual([3]);
    expect(d.live).toEqual([expect.objectContaining({ session_id: sa, agent: a.id, viewers: 1, desktop: true })]);
    expect(JSON.stringify(d)).not.toContain(h.id);
    expect(JSON.stringify(pub)).not.toContain(sh);
    // with hidden=1: the hidden launch's session, and the peak over every stream the gate counted
    const on = await expectOk(e.anon.get("/v1/analytics/dashboard?window=24h&hidden=1"));
    expect(on.kpis.viewers).toMatchObject({ value: 1, peak: 9 });
    expect(on.live.map((x: any) => x.agent).sort()).toEqual([a.id, h.id].sort());
    // a sample that went stale is not "now"
    e.clock.advance(VIEWERS_FRESH_MS + 60_000);
    expect((await expectOk(e.anon.get("/v1/viewers"))).total).toBeNull();
    // the sampler: a gate that does not answer leaves a gap, never a zero
    expect(await vw.sample("http://gate", (async () => new Response("no", { status: 502 })) as unknown as typeof fetch)).toMatchObject({ ok: false });
    expect(await vw.sample("http://gate", (async (u: string) => (expect(u).toBe("http://gate/gate/viewers"), Response.json({ at: 1, total: 2, sessions: { [sa]: 2 } }))) as unknown as typeof fetch)).toMatchObject({ recorded: true });
    expect((await expectOk(e.anon.get("/v1/viewers"))).total).toBe(2);
  });
});
