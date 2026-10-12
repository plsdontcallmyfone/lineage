import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEARNINGS_LIMITS } from "../src/learnings.ts";
import { generateAgentKey } from "../src/protocol.ts";
import { parseIdentityPayments, parseIndexerFlows, revenueOf, USD_MAX_AGE_S } from "../src/revenue.ts";
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
    expect(p).toMatchObject({ key: "example/fx", repo: "https://github.com/example/fx", github: true, accepted: 1, authors: 1, last_improvement_at: gen.accepted_at, open_candidates: 0 });
    const ir = p.lineages[0].metrics.find((m: any) => m.name === "ir");
    expect(ir).toMatchObject({ baseline: CALIB.metrics.ir!.base_value, best: { value: 900, height: 1, gen_id: c.gen_id }, improvement_pct: 10, measured_generations: 1 });
    // a metric the calibration disabled has no baseline
    expect(p.lineages[0].metrics.find((m: any) => m.name === "size").baseline).toBeNull();
    // only active GitHub repositories without all=1; this one is active on GitHub, so it is listed either way
    expect((await expectOk(e.anon.get("/v1/analytics/projects"))).projects).toHaveLength(1);

    const pj = v["/v1/analytics/project?repo=example/fx"];
    expect(pj.lineages[0].timeline).toHaveLength(1);
    expect(pj.lineages[0].timeline[0]).toMatchObject({ gen_id: c.gen_id, height: 1, author: a.id, metric: "ir", gain_pct: 10 });
    // no hidden launch: no start, no hidden wording, every generation listed
    expect(p.lineages[0]).toMatchObject({ accepted: 1, listed_generations: 1, unlisted_generations: 0, height: 1 });
    expect(ir.start).toBeUndefined();
    expect(JSON.stringify(v)).not.toMatch(/test_launch|accepted_by_test_launches|author_hidden|accepted_hidden|"hidden":true/);
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

  test("hidden launches: their work is left out of every count and list unless hidden=1; the unit says what listed agents start from", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const h = await makeAuthor(e);
    const a = await makeAuthor(e);
    // a generation by the launch that will be hidden (ir 1000 to 900), then one by a listed agent on top of it (to 810)
    const under = await attempt(e, h, "one", 900);
    const over = await attempt(e, a, "two", 810);
    e.clock.advance(LEARNINGS_LIMITS.bare_grace_ms + 1);
    const genOf = async (commit: string) => (await expectOk(e.anon.get(`/v1/candidates/${commit}`))).gen_id as string;
    const gUnder = await genOf(under.cand.commit_id), gOver = await genOf(over.cand.commit_id);
    const irOf = (v: Record<string, any>, u: string) => (u.includes("/project?") ? v[u] : v[u].projects[0]).lineages[0].metrics.find((m: any) => m.name === "ir");
    const P = "/v1/analytics/projects?all=1", PJ = "/v1/analytics/project?repo=example/fx", G = "/v1/analytics/generations?limit=200";

    // nobody hidden: today's figures, against the calibration, with no start
    const before = await views(e);
    const stats0 = await expectOk(e.anon.get("/v1/stats"));
    expect(before[P].projects[0]).toMatchObject({ accepted: 2, reverted: 0, authors: 2 });
    expect(before[P].projects[0].lineages[0]).toMatchObject({ accepted: 2, listed_generations: 2, unlisted_generations: 0, height: 2 });
    for (const u of [P, PJ]) {
      expect(irOf(before, u)).toMatchObject({ baseline: 1000, best: { value: 810, height: 2 }, latest: { value: 810, height: 2 }, improvement_pct: 19 });
      expect(irOf(before, u).start).toBeUndefined();
    }
    expect(irOf(before, PJ).points.map((p: any) => p.value)).toEqual([900, 810]);
    expect(before[PJ].lineages[0].timeline.map((t: any) => t.gen_id)).toEqual([gOver, gUnder]);
    expect(before[G].total).toBe(2);
    expect(before["/v1/analytics/dashboard?window=all"].kpis.improvements.value).toBe(2);
    expect(before["/v1/analytics/overview?window=all"].verification.final_candidates).toEqual({ accepted: 2 });
    expect(JSON.stringify(before)).not.toMatch(/test_launch|accepted_by_test_launches|author_hidden|accepted_hidden|"hidden":true/);

    const mint = (await expectOk(e.anon.get(`/v1/agents/${h.id}`))).mint as string;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "moderation" }] }));
    const off = await views(e);
    // nothing names the hidden agent or its generation, in any analytics route
    for (const [u, body] of Object.entries(off)) {
      expect(JSON.stringify(body), u).not.toContain(h.id);
      expect(JSON.stringify(body), u).not.toContain(gUnder);
      expect(JSON.stringify(body), u).not.toMatch(/test_launch|accepted_by_test_launches|author_hidden|accepted_hidden|"hidden":true/);
    }
    const p = off[P].projects[0];
    expect(p).toMatchObject({ accepted: 1, reverted: 0, authors: 1, last_improvement_at: (await expectOk(e.anon.get(`/v1/generations/${gOver}`))).accepted_at });
    // the unit's height is the real one; the counts say how much of the chain is listed
    expect(p.lineages[0]).toMatchObject({ accepted: 1, listed_generations: 1, unlisted_generations: 1, height: 2 });
    for (const u of [P, PJ]) {
      // listed work is measured from the code it was built on (900 at height 1), not from the calibration
      expect(irOf(off, u)).toMatchObject({ baseline: 1000, start: { value: 900, height: 1 }, best: { value: 810, height: 2, gen_id: gOver }, latest: { value: 810, height: 2 }, improvement_pct: 10, latest_change_pct: 10 });
    }
    expect(irOf(off, P).measured_generations).toBe(1);
    expect(irOf(off, PJ).points.map((x: any) => x.value)).toEqual([810]);
    expect(off[PJ].lineages[0].timeline.map((t: any) => t.gen_id)).toEqual([gOver]);
    expect(off[PJ].lineages[0].timeline[0]).toMatchObject({ author: a.id, height: 2 });
    expect(off[G].total).toBe(1);
    expect(off[G].rows[0]).toMatchObject({ gen_id: gOver, author: a.id });
    expect(off[G].facets.agents.map((x: any) => x.agent)).toEqual([a.id]);
    // every figure of the Analytics page: one attempt, one generation, one agent, its spend, its replays
    const o = off["/v1/analytics/overview?window=all"], o0 = before["/v1/analytics/overview?window=all"];
    expect(o.costs.totals.attempts).toBe(1);
    expect(o.costs.by_agent.map((x: any) => x.agent)).toEqual([a.id]);
    expect(o.verification.final_candidates).toEqual({ accepted: 1 });
    expect(o0.verification.replays.revealed).toBeGreaterThan(0);
    expect(o.verification.replays.revealed).toBe(o0.verification.replays.revealed / 2);
    const d = off["/v1/analytics/dashboard?window=all"], d0 = before["/v1/analytics/dashboard?window=all"];
    expect(d.kpis.improvements.value).toBe(1);
    expect(d.kpis.acceptance.attempts).toBe(1);
    expect(d.kpis.spend.value).toBe(d0.kpis.spend.value / 2);
    expect(d.agents.map((x: any) => x.agent)).toEqual([a.id]);
    expect(d.verification.replays).toBe(d0.verification.replays / 2);
    const r = off["/v1/analytics/results?window=all"].metrics.find((m: any) => m.metric === "ir");
    expect(r).toMatchObject({ baseline: 1000, start: { value: 900, height: 1 }, improvement_pct: 10, records: 1 });
    expect(before["/v1/analytics/results?window=all"].metrics.find((m: any) => m.metric === "ir")).toMatchObject({ baseline: 1000, improvement_pct: 19, records: 2 });
    // the landing page's and the embed kit's counts (GET /v1/stats)
    const stats = await expectOk(e.anon.get("/v1/stats"));
    expect(stats).toMatchObject({ generations: stats0.generations - 1, candidates: stats0.candidates - 1, agents: stats0.agents - 1, hidden_agents: 1 });
    expect(await expectOk(e.anon.get("/v1/stats?hidden=1"))).toMatchObject({ generations: stats0.generations, candidates: stats0.candidates, agents: stats0.agents });

    // hidden=1 (the operator's view): everything, as before hiding, with the hidden author marked "hidden"
    const on = await views(e, "&hidden=1");
    expect(on[`${P}&hidden=1`].projects[0]).toMatchObject({ accepted: 2, accepted_hidden: 1, authors: 2 });
    expect(on[`${P}&hidden=1`].projects[0].lineages[0]).toMatchObject({ accepted: 2, listed_generations: 2, unlisted_generations: 0 });
    expect(irOf(on, `${PJ}&hidden=1`)).toMatchObject({ best: { value: 810 }, improvement_pct: 19 });
    expect(irOf(on, `${PJ}&hidden=1`).start).toBeUndefined();
    const rows = on[`${G}&hidden=1`].rows;
    expect(rows.map((x: any) => [x.height, x.gen_id, x.author, x.hidden]).sort()).toEqual([[1, gUnder, h.id, true], [2, gOver, a.id, undefined]]);
    expect(on[`${PJ}&hidden=1`].lineages[0].timeline.map((t: any) => [t.author, t.hidden])).toEqual([[a.id, undefined], [h.id, true]]);
    expect(on["/v1/analytics/overview?window=all&hidden=1"].costs.by_agent.map((x: any) => [x.agent, x.hidden]).sort()).toEqual([[a.id, undefined], [h.id, true]].sort());
    expect(JSON.stringify(on)).not.toMatch(/test_launch|test launch/);
  });

  test("hidden launches: a unit with only hidden generations has no listed figure, and its start is the tip", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const h = await makeAuthor(e);
    await attempt(e, h, "one", 900);
    e.clock.advance(LEARNINGS_LIMITS.bare_grace_ms + 1);
    const mint = (await expectOk(e.anon.get(`/v1/agents/${h.id}`))).mint as string;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "moderation" }] }));
    const off = await views(e);
    const p = off["/v1/analytics/projects?all=1"].projects[0];
    expect(p).toMatchObject({ accepted: 0, reverted: 0, authors: 0, last_improvement_at: null });
    expect(p.accepted_hidden).toBeUndefined();
    expect(p.lineages[0]).toMatchObject({ accepted: 0, listed_generations: 0, unlisted_generations: 1, height: 1 });
    expect(p.lineages[0].metrics.find((m: any) => m.name === "ir")).toMatchObject({ baseline: 1000, start: { value: 900, height: 1 }, best: null, latest: null, improvement_pct: null, measured_generations: 0 });
    expect(off["/v1/analytics/project?repo=example/fx"].lineages[0].timeline).toEqual([]);
    expect(off["/v1/analytics/generations?limit=200"].total).toBe(0);
    expect(off["/v1/analytics/overview?window=all"].costs.by_agent).toEqual([]);
    expect(off["/v1/analytics/dashboard?window=all"].kpis.improvements.value).toBe(0);
    expect(JSON.stringify(off)).not.toContain(h.id);
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
    // a launch hidden after its viewers were counted leaves the peaks too: the hour is recounted from
    // the minute samples without it (a alone had 3, then 1), and with nobody else watched it reads 0
    const ma = (await expectOk(e.anon.get(`/v1/agents/${a.id}`))).mint as string;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint: ma, reason: "moderation" }] }));
    e.clock.advance(10_001);
    const none = await expectOk(e.anon.get("/v1/analytics/dashboard?window=24h"));
    expect(none.kpis.viewers).toMatchObject({ value: 0, peak: 0 });
    expect(JSON.stringify(none)).not.toContain(a.id);
    await expectOk(e.admin.c.post("/v1/admin/hidden", { remove: [mint] }));
    e.clock.advance(10_001);
    const mixed = await expectOk(e.anon.get("/v1/analytics/dashboard?window=24h"));
    expect(mixed.kpis.viewers.peak).toBe(4); // h alone: 4 in the first minute, none in the second
    expect((await expectOk(e.anon.get("/v1/analytics/dashboard?window=24h&hidden=1"))).kpis.viewers.peak).toBe(9);
    await expectOk(e.admin.c.post("/v1/admin/hidden", { remove: [ma], add: [{ mint, reason: "moderation" }] }));
    e.clock.advance(10_001);
    expect((await expectOk(e.anon.get("/v1/analytics/dashboard?window=24h"))).kpis.viewers.peak).toBe(3);
    // a sample that went stale is not "now"
    e.clock.advance(VIEWERS_FRESH_MS + 60_000);
    expect((await expectOk(e.anon.get("/v1/viewers"))).total).toBeNull();
    // the sampler: a gate that does not answer leaves a gap, never a zero
    expect(await vw.sample("http://gate", (async () => new Response("no", { status: 502 })) as unknown as typeof fetch)).toMatchObject({ ok: false });
    expect(await vw.sample("http://gate", (async (u: string) => (expect(u).toBe("http://gate/gate/viewers"), Response.json({ at: 1, total: 2, sessions: { [sa]: 2 } }))) as unknown as typeof fetch)).toMatchObject({ recorded: true });
    expect((await expectOk(e.anon.get("/v1/viewers"))).total).toBe(2);
  });

  test("protocol revenue: figures equal the crank, slash, challenge and payment records; windows; hidden launches left out unless hidden=1", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const h = await makeAuthor(e);
    const mintOf = async (x: typeof a) => (await expectOk(e.anon.get(`/v1/agents/${x.id}`))).mint as string;
    const ma = await mintOf(a), mh = await mintOf(h);
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint: mh, reason: "test launch" }] }));
    const HOUR = 3_600_000, DAY = 24 * HOUR;
    const rev = revenueOf(e.core);
    const get = async (w: string, extra = "") => (e.clock.advance(CACHE), await expectOk(e.anon.get(`/v1/analytics/revenue?window=${w}${extra}`)));

    // before any copy of the indexer or the identity service: not available, never a zero that reads as measured
    const none = await get("7d");
    expect(none.sources.map((x: any) => [x.id, x.denom, x.available])).toEqual([["creator_fees", "quote", false], ["slashes", "quote", true], ["challenge_bonds", "quote", true], ["identity", "sol", false]]);
    expect([none.quote.decimals, none.kpi.quote.value, none.kpi.quote.value_raw, none.compute_sink.available]).toEqual([null, null, "0", false]);

    // the records: three cranks of the listed token (36 h ago, 2 h ago, and one whose block time the RPC did
    // not give), one of the hidden token; token counters; one units account payment each
    const now = e.clock.now();
    const sig = (n: number) => "S".repeat(60) + String(n).padStart(4, "1");
    const s = (ms: number) => Math.floor(ms / 1000);
    const cranks = [
      { signature: sig(1), idx: 0, mint: ma, agent: a.id, venue: "pump", slot: 1, time: s(now - 36 * HOUR), fees_raw: "1000000", to_compute_raw: "700000", to_protocol_raw: "300000" },
      // a crank with a routed slice: the compute vault got less than its 70%
      { signature: sig(2), idx: 0, mint: ma, agent: a.id, venue: "pump", slot: 2, time: s(now - 2 * HOUR), fees_raw: "5000000", to_compute_raw: "3000000", to_protocol_raw: "1500000" },
      { signature: sig(3), idx: 1, mint: ma, agent: a.id, venue: "pump", slot: 3, time: null, fees_raw: "100", to_compute_raw: "70", to_protocol_raw: "30" },
      { signature: sig(4), idx: 0, mint: mh, agent: h.id, venue: "meteora", slot: 4, time: s(now - 3 * HOUR), fees_raw: "9000000", to_compute_raw: "6300000", to_protocol_raw: "2700000" },
      { signature: "not a signature", idx: 0, mint: ma, agent: a.id, time: 5, fees_raw: "1", to_compute_raw: "1", to_protocol_raw: "x" },
    ];
    const tokens = [
      { mint: ma, agent: a.id, symbol: "TA", venue: "pump", hosted: true, hidden: false, fees_claimed_raw: "6000100", to_compute_raw: "3700070", to_protocol_raw: "1800030", debited_raw: "4200000", state_at: s(now) - 30 },
      { mint: mh, agent: h.id, symbol: "TH", venue: "meteora", hosted: true, hidden: true, fees_claimed_raw: "9000000", to_compute_raw: "6300000", to_protocol_raw: "2700000", debited_raw: "1000000", state_at: s(now) - 20 },
    ];
    const flows = parseIndexerFlows({ quote: "UNITS", quote_mint: ma, quote_decimals: 6, cranks, tokens, extra: "dropped" })!;
    expect(flows.cranks).toHaveLength(4); // the malformed row is dropped
    expect(parseIndexerFlows({ cranks: [] })).toBeNull();
    const REC = generateAgentKey().id;
    const pays = parseIdentityPayments({ since: 1, payments: [
      { agent: a.id, mint: ma, launcher: a.id, lamports: "50000000", recipient: REC, signatures: [sig(7)], launched_at: s(now - 30 * HOUR) },
      { agent: h.id, mint: mh, launcher: h.id, lamports: "50000000", recipient: REC, signatures: [sig(8)], launched_at: s(now - 1 * HOUR) },
      { agent: a.id, mint: ma, launcher: a.id, lamports: "-5", recipient: REC, signatures: [], launched_at: 1 },
    ] })!;
    expect(pays.payments).toHaveLength(2);
    // the sampler reads both services over loopback and replaces Core's copy
    const fetched: string[] = [];
    const fake = (async (u: string) => (fetched.push(u), Response.json(u.includes("/market/") ? { quote: "UNITS", quote_mint: ma, quote_decimals: 6, cranks, tokens } : { since: 1, payments: pays.payments }))) as unknown as typeof fetch;
    expect(await rev.sample({ indexer: "http://ix/", identity: "http://id" }, fake)).toEqual({ indexer: { ok: true, cranks: 4, tokens: 2 }, identity: { ok: true, payments: 2 } });
    expect(fetched).toEqual(["http://ix/market/flows?hidden=1", "http://id/identity/payments"]);
    // Core's own records: a slash of the listed agent 5 h ago (into the reserve), one a challenge reversed, a
    // failed challenge by the listed agent 26 h ago, an upheld one and an expired one (both refunded)
    const db = e.core.db;
    db.query("INSERT INTO slashes (agent_id, bps, amount, reason, ref, epoch, at) VALUES (?, 100, '40000', 'minority', 'r1', 0, ?)").run(a.id, now - 5 * HOUR);
    const rs = db.query("INSERT INTO slashes (agent_id, bps, amount, reason, ref, epoch, at) VALUES (?, 100, '77777', 'minority', 'r2', 0, ?)").run(a.id, now - 4 * HOUR);
    db.query("INSERT INTO slash_reversals (slash_row, challenge_id, amount, at) VALUES (?, 'c0', '77777', ?)").run(Number(rs.lastInsertRowid), now - HOUR);
    const ch = db.query(
      "INSERT INTO challenges (challenge_id, kind, subject, subject_hex, epoch, challenger, claim_digest, bond, status, opened_at, deadline, resolved_at, source) VALUES (?, 'verdict', ?, ?, 0, ?, 'd', ?, ?, ?, ?, ?, 'sim')",
    );
    ch.run("c1", "s1", "s1", a.id, "1000000", "failed", now - 27 * HOUR, now, now - 26 * HOUR);
    ch.run("c2", "s2", "s2", a.id, "1000000", "upheld", now - 27 * HOUR, now, now - 26 * HOUR);
    ch.run("c3", "s3", "s3", a.id, "1000000", "expired", now - 27 * HOUR, now, now - 26 * HOUR);
    ch.run("c4", "s4", "s4", h.id, "2000000", "failed", now - 27 * HOUR, now, now - 3 * HOUR);

    const sum = (xs: (number | null)[]) => xs.reduce<number>((n, x) => n + (x ?? 0), 0);
    const src = (r: any, id: string) => r.sources.find((x: any) => x.id === id);
    // 7 d, listed launches only: every figure is the sum of the listed records, in its own denomination
    const w = await get("7d");
    expect(w.axis.t).toHaveLength(7);
    expect(w.quote).toEqual({ symbol: "UNITS", mint: ma, decimals: 6 });
    expect(src(w, "creator_fees")).toMatchObject({ available: true, value_raw: "1800000", value: 1.8, records: 2, lifetime_raw: "1800030", lifetime_records: 3, undated: 1, prev_raw: "0" });
    expect(src(w, "slashes")).toMatchObject({ value_raw: "40000", records: 1, lifetime_records: 1 });
    expect(src(w, "challenge_bonds")).toMatchObject({ value_raw: "1000000", records: 1 });
    expect(src(w, "identity")).toMatchObject({ denom: "sol", available: true, value_raw: "50000000", value: 0.05, records: 1 });
    expect(w.accounts.identity_recipient).toBe((await expectOk(e.anon.get("/v1/launch-fronting"))).identity_account_recipient ?? REC);
    expect(w.kpi.quote).toMatchObject({ value_raw: "2840000", value: 2.84, prev: 0, lifetime_raw: "2840030" });
    expect(sum(w.kpi.quote.series)).toBeCloseTo(2.84, 9);
    for (const x of w.sources) expect(sum(x.series)).toBeCloseTo(x.value, 9);
    expect(w.kpi.sol).toMatchObject({ available: true, value: 0.05, lifetime_raw: "50000000" });
    // where creator fees went: compute vaults, the treasury, and the rest a crank routed elsewhere
    expect(w.creator_fees).toMatchObject({ cranks: 2, fees_raw: "6000000", to_compute_raw: "3700000", to_protocol_raw: "1800000", routed_raw: "500000" });
    expect(w.creator_fees.lifetime).toMatchObject({ cranks: 3, fees_raw: "6000100", to_protocol_raw: "1800030" });
    expect(w.creator_fees.tokens).toEqual([expect.objectContaining({ mint: ma, agent: a.id, symbol: "TA", cranks: 2, to_protocol_raw: "1800000" })]);
    expect(sum(w.creator_fees.series.map((x: any) => x.to_compute))).toBeCloseTo(3.7, 9);
    // the compute sink: the chain's running totals of the listed tokens, no window
    expect(w.compute_sink).toMatchObject({ available: true, debited_raw: "4200000", debited: 4.2, tokens: 1, as_of: (s(now) - 30) * 1000 });
    expect(w.split_bps).toEqual({ agent_compute: e.core.cfg.agent_compute_bps, protocol: e.core.cfg.protocol_bps });

    // 24 h: hours; the records of the day before are the period before
    const d = await get("24h");
    expect([d.axis.unit, d.axis.t.length]).toEqual(["hour", 24]);
    expect(d.prev).toEqual({ from: d.range.from - 24 * HOUR, to: d.range.from });
    expect(src(d, "creator_fees")).toMatchObject({ value_raw: "1500000", prev_raw: "300000", records: 1 });
    expect(src(d, "challenge_bonds")).toMatchObject({ value_raw: "0", prev_raw: "1000000" });
    expect(src(d, "identity")).toMatchObject({ value_raw: "0", prev_raw: "50000000" });
    expect(d.kpi.quote).toMatchObject({ value_raw: "1540000", prev_raw: "1300000" });
    // 30 d and all time hold everything dated; all time has no period before and starts at the first record
    const m = await get("30d");
    expect([m.axis.t.length, m.kpi.quote.value_raw]).toEqual([30, "2840000"]);
    const all = await get("all");
    expect(all.prev).toBeNull();
    expect(all.kpi.quote).toMatchObject({ value_raw: "2840000", prev: null });
    expect(all.first_record_at).toBe(s(now - 36 * HOUR) * 1000);
    expect(all.axis.t[0]).toBe(Math.floor(all.first_record_at / DAY) * DAY);

    // hidden=1 adds the hidden launch's crank, challenge bond, payment and compute total
    const on = await get("7d", "&hidden=1");
    expect(src(on, "creator_fees")).toMatchObject({ value_raw: "4500000", records: 3 });
    expect(src(on, "challenge_bonds").value_raw).toBe("3000000");
    expect(src(on, "identity")).toMatchObject({ value_raw: "100000000", value: 0.1, records: 2 });
    expect(on.compute_sink).toMatchObject({ debited_raw: "5200000", tokens: 2 });
    expect(on.creator_fees.tokens.map((x: any) => x.mint).sort()).toEqual([ma, mh].sort());
    expect(JSON.stringify(w).includes(h.id)).toBe(false);

    // a source that stops answering keeps its copy and says so; an answer without a record removes it here
    expect(await rev.sample({ indexer: "http://ix" }, (async () => new Response("no", { status: 502 })) as unknown as typeof fetch)).toEqual({ indexer: { ok: false, error: "answered 502" } });
    const kept = await get("7d");
    expect(src(kept, "creator_fees")).toMatchObject({ available: true, value_raw: "1800000", error: "answered 502" });
    rev.recordIndexer({ ...flows, cranks: flows.cranks.slice(0, 1) });
    expect(src(await get("7d"), "creator_fees")).toMatchObject({ value_raw: "300000", error: null });
    expect((await e.anon.get("/v1/analytics/revenue?window=1y")).status).toBe(400);
  });

  test("protocol revenue in US dollars: the indexer's reading, a crank at the price of its own time, null with the reason when there is none", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const ma = (await expectOk(e.anon.get(`/v1/agents/${a.id}`))).mint as string;
    const HOUR = 3_600_000;
    const rev = revenueOf(e.core);
    const get = async (w: string) => (e.clock.advance(CACHE), await expectOk(e.anon.get(`/v1/analytics/revenue?window=${w}`)));
    const now = () => e.clock.now();
    const s = (ms: number) => Math.floor(ms / 1000);
    const sig = (n: number) => "S".repeat(60) + String(n).padStart(4, "1");
    const src = (r: any, id: string) => r.sources.find((x: any) => x.id === id);
    const cranks = (t: number) => [
      // 3 h ago with a price stored for its own time (0.001 USD per coin), 2 h ago without one
      { signature: sig(1), idx: 0, mint: ma, agent: a.id, venue: "pump", slot: 1, time: s(t - 3 * HOUR), fees_raw: "10000000", to_compute_raw: "7000000", to_protocol_raw: "3000000", quote_usd: 0.001 },
      { signature: sig(2), idx: 0, mint: ma, agent: a.id, venue: "pump", slot: 2, time: s(t - 2 * HOUR), fees_raw: "20000000", to_compute_raw: "14000000", to_protocol_raw: "6000000", quote_usd: null },
    ];
    const tokens = [{ mint: ma, agent: a.id, symbol: "TA", venue: "pump", hosted: true, hidden: false, fees_claimed_raw: "30000000", to_compute_raw: "21000000", to_protocol_raw: "9000000", debited_raw: "4000000", state_at: s(now()) }];
    const usd = (t: number) => ({ ok: true, usd: 0.002, sol_usd: 200, read_at: s(t) - 20 });

    // an indexer that serves no price (an older release, or its feed is down): the figures stay, the dollar fields are null with the reason
    rev.recordIndexer(parseIndexerFlows({ quote: "UNITS", quote_mint: ma, quote_decimals: 6, cranks: cranks(now()), tokens })!);
    const none = await get("7d");
    expect(none.usd).toMatchObject({ ok: false, basis: null, reason: expect.stringMatching(/does not serve a USD price/) });
    expect(src(none, "creator_fees").value).toBe(9);
    expect([src(none, "creator_fees").value_usd, none.kpi.usd.value, none.compute_sink.debited_usd]).toEqual([null, null, null]);
    rev.recordIndexer(parseIndexerFlows({ quote: "UNITS", quote_mint: ma, quote_decimals: 6, cranks: cranks(now()), tokens, usd: { ok: false, reason: "Jupiter answered HTTP 503", read_at: null } })!);
    expect((await get("7d")).usd).toMatchObject({ ok: false, reason: "Jupiter answered HTTP 503" });

    // with a reading: the first crank at its own price, the second at the current one
    rev.recordIndexer(parseIndexerFlows({ quote: "UNITS", quote_mint: ma, quote_decimals: 6, cranks: cranks(now()), tokens, usd: usd(now()) })!);
    rev.recordIdentity(parseIdentityPayments({ since: 1, payments: [{ agent: a.id, mint: ma, launcher: a.id, lamports: "50000000", recipient: generateAgentKey().id, signatures: [sig(7)], launched_at: s(now() - HOUR) }] })!);
    e.core.db.query("INSERT INTO slashes (agent_id, bps, amount, reason, ref, epoch, at) VALUES (?, 100, '1000000', 'minority', 'r1', 0, ?)").run(a.id, now() - HOUR);
    const w = await get("7d");
    expect(w.usd).toMatchObject({ ok: true, quote_usd: 0.002, sol_usd: 200, basis: "mixed" });
    expect(src(w, "creator_fees").value).toBe(9);
    expect(src(w, "creator_fees").value_usd).toBeCloseTo(3 * 0.001 + 6 * 0.002, 12);
    expect(src(w, "creator_fees").lifetime_usd).toBeCloseTo(0.015, 12);
    expect(src(w, "creator_fees").series_usd.reduce((n: number, x: number) => n + x, 0)).toBeCloseTo(0.015, 12);
    expect(src(w, "slashes").value_usd).toBeCloseTo(0.002, 12);
    expect(src(w, "identity")).toMatchObject({ value: 0.05 });
    expect(src(w, "identity").value_usd).toBeCloseTo(10, 9);
    // the headline: the quote-coin sources and the SOL payments, in dollars
    expect(w.kpi.quote.value_usd).toBeCloseTo(0.017, 12);
    expect(w.kpi.usd.value).toBeCloseTo(10.017, 9);
    expect(w.kpi.usd.series.reduce((n: number, x: number) => n + x, 0)).toBeCloseTo(10.017, 9);
    expect(w.creator_fees.fees_usd).toBeCloseTo(10 * 0.001 + 20 * 0.002, 12);
    expect(w.creator_fees.to_compute_usd).toBeCloseTo(7 * 0.001 + 14 * 0.002, 12);
    expect(w.creator_fees.tokens[0].to_protocol_usd).toBeCloseTo(0.015, 12);
    expect(w.compute_sink.debited_usd).toBeCloseTo(0.008, 12);

    // Core's copy of the reading goes stale with the indexer's: after USD_MAX_AGE_S there is no dollar figure
    e.clock.advance(USD_MAX_AGE_S * 1000);
    const old = await get("7d");
    expect(old.usd).toMatchObject({ ok: false, reason: "the last USD price reading is too old" });
    // a crank with its own stored price still has its dollar value; the one without has none, so the sum has none
    expect([src(old, "creator_fees").value, src(old, "creator_fees").value_usd, old.kpi.usd.value]).toEqual([9, null, null]);
  });
});
