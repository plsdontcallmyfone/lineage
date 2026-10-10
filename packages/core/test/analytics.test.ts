import { afterEach, describe, expect, test } from "bun:test";
import { LEARNINGS_LIMITS } from "../src/learnings.ts";
import { generateAgentKey } from "../src/protocol.ts";
import { authorLeaks, CALIB, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Env } from "./helpers.ts";

// Read-only aggregates for the Projects, Generations and Analytics pages
// (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md): figures equal the records they summarise,
// hidden launches stay out unless hidden=1, and an open candidate changes nothing but its lineage's
// open count (author-blind replay, SPEC 10.7).

let env: Env;
afterEach(() => env?.close());

const CACHE = 10_001;
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
async function attempt(e: Env, a: Awaited<ReturnType<typeof makeAuthor>>, name: string, irCand: number) {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  const cand = await submit(e, a, diff(name));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/end`, { commit_id: cand.commit_id }));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/episode`, report));
  await runReplays(e, cand.candidate_id, honest(result({}, irCand)));
  return { session: s.session_id as string, cand };
}

/** The analytics routes as text, minus the clock. */
async function views(e: Env, extra = "") {
  e.clock.advance(Math.max(CACHE, LEARNINGS_LIMITS.sweep_every_ms + 1));
  const urls = [`/v1/analytics/projects?all=1${extra}`, `/v1/analytics/project?repo=example/fx${extra}`, `/v1/analytics/generations?limit=200${extra}`, ...["24h", "7d", "all"].map((w) => `/v1/analytics/overview?window=${w}${extra}`)];
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
    expect(JSON.stringify(after)).not.toContain(quiet.id);
    expect(JSON.stringify(after)).not.toContain(open.commit_id);
    expect(await authorLeaks(e, [{ ids: [open.commit_id, open.candidate_id], parties: [quiet.id], sealed: [] }])).toEqual([]);
  });
});
