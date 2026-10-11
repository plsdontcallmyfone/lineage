import { afterEach, describe, expect, test } from "bun:test";
import { replicate } from "../src/replica.ts";
import { recipeId } from "../src/protocol.ts";
import { candidate, diff, expectOk, honest, makeAuthor, RECIPE, result, ROOT, runReplays, setup, submit, type Env } from "./helpers.ts";

// Guard limits on non-target metrics (SPEC 10.1 rule 6) through Core: the activation boundary,
// admin-edited versions and per-recipe overrides, and independent recomputation of both rule
// versions by scripts/verify.ts and the replica.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const flat = (v: number) => Array(15).fill(v);
/** ir improves 10% (the target), ns (guarded, noisy, enabled in CALIB) ends at `nsCand` against 100. */
const withNs = (nsCand: number) => result({ metrics: { ir: { base: [1000], cand: [900], deterministic: true }, ns: { base: flat(100), cand: flat(nsCand), deterministic: false } } });

async function verifyScript(base: string): Promise<{ code: number; out: string }> {
  // async spawn: the Core under test serves from this process
  const p = Bun.spawn(["bun", `${ROOT}/scripts/verify.ts`, "--core", base, "--no-draws"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
}

describe("guard limits (SPEC 10.1 rule 6)", () => {
  test("activation boundary: a candidate committed before keeps rule 1, one after is rejected; verify.ts and the replica recompute both", async () => {
    const e = (env = await setup({ over: { guard_activation_ms: null } }));
    expect((await expectOk(e.anon.get("/v1/guard-config"))).versions).toEqual([]);
    const author = await makeAuthor(e);
    const before = await submit(e, author, diff("g-old", "src/a.rs"));
    e.clock.advance(1000);
    const v1 = await expectOk(e.admin.c.post("/v1/admin/guard-config", { default_max_regression: 0.01 }));
    expect(v1.version).toBe(1);
    expect(v1.effective_from_ms).toBe(e.clock.now() + 1);
    e.clock.advance(1000);
    const after = await submit(e, author, diff("g-new", "src/b.rs"), { parent: e.gen0 });

    await runReplays(e, after.candidate_id, honest(withNs(120)));
    const a = await candidate(e, after.candidate_id);
    expect(a.status).toBe("rejected");
    expect(a.reason).toBe("metric_regression");
    expect(a.detail).toContain("ns worsened +");
    expect(a.detail).toContain("limit 1%");
    expect(a.verdict.rule_version).toBe(2);
    expect(a.verdict.guard_limits.config_version).toBe(1);
    expect(a.verdict.guard_limits.config_digest).toBe(v1.digest);
    expect(a.verdict.guard_limits.checks).toEqual([expect.objectContaining({ metric: "ns", limit: 0.01, status: "exceeded" }), expect.objectContaining({ metric: "size", status: "disabled" })]);

    await runReplays(e, before.candidate_id, honest(withNs(120)));
    const b = await candidate(e, before.candidate_id);
    expect(b.status).toBe("accepted");
    expect(b.verdict.rule_version).toBeUndefined();
    expect(b.verdict.guard_limits).toBeUndefined();

    const v = await verifyScript(e.base);
    expect(v.out).toContain("2/2 verdicts independently recomputed (rule v1: 1, rule v2 with guard limits: 1; 1 guard config versions");
    expect(v.code).toBe(0);
    expect((await replicate(e.base)).divergences).toEqual([]);
  }, 60_000);

  test("within the limit accepts and records passed; a per-recipe override changes the limit or unguards the metric", async () => {
    const e = (env = await setup()); // config/network.json: version 1 seeded at Core start, 1%
    const cfg = await expectOk(e.anon.get("/v1/guard-config"));
    expect(cfg.versions.length).toBe(1);
    expect(cfg.versions[0]).toMatchObject({ version: 1, default_max_regression: 0.01, kinds: ["perf", "slim"], overrides: {} });
    expect(cfg.activation_ms).toBe(cfg.versions[0].effective_from_ms);
    const author = await makeAuthor(e);
    e.clock.advance(1000);

    const ok = await submit(e, author, diff("w1", "src/a.rs"));
    await runReplays(e, ok.candidate_id, honest(withNs(100.5)));
    const okv = await candidate(e, ok.candidate_id);
    expect(okv.status).toBe("accepted");
    expect(okv.verdict.guard_limits.checks[0]).toMatchObject({ metric: "ns", limit: 0.01, status: "passed" });

    // per-recipe override: ns may regress 25% on this recipe
    const rid = recipeId(RECIPE);
    const v2 = await expectOk(e.admin.c.post("/v1/admin/guard-config", { overrides: { [rid]: { ns: 0.25 } } }));
    expect(v2).toMatchObject({ version: 2, default_max_regression: 0.01, overrides: { [rid]: { ns: 0.25 } } });
    e.clock.advance(1000);
    const loose = await submit(e, author, diff("w2", "src/b.rs"));
    await runReplays(e, loose.candidate_id, honest(withNs(120)));
    const lv = await candidate(e, loose.candidate_id);
    expect(lv.status).toBe("accepted");
    expect(lv.verdict.guard_limits.config_version).toBe(2);
    expect(lv.verdict.guard_limits.checks[0]).toMatchObject({ metric: "ns", limit: 0.25, status: "passed", worst_ratio: 1.2 });

    // null: unguarded (e.g. a noisy timing), any change ignored
    await expectOk(e.admin.c.post("/v1/admin/guard-config", { overrides: { [rid]: { ns: null } } }));
    e.clock.advance(1000);
    const free = await submit(e, author, diff("w3", "src/c.rs"));
    await runReplays(e, free.candidate_id, honest(withNs(300)));
    const fv = await candidate(e, free.candidate_id);
    expect(fv.status).toBe("accepted");
    expect(fv.verdict.guard_limits.checks[0]).toEqual({ metric: "ns", limit: null, status: "unguarded" });

    const v = await verifyScript(e.base);
    expect(v.out).toContain("3/3 verdicts independently recomputed (rule v1: 0, rule v2 with guard limits: 3; 3 guard config versions");
    expect(v.code).toBe(0);
    expect((await replicate(e.base)).divergences).toEqual([]);
  }, 60_000);

  test("admin edits are validated and never take effect before Core's clock", async () => {
    const e = (env = await setup());
    const rid = recipeId(RECIPE);
    const post = (b: unknown) => e.admin.c.post("/v1/admin/guard-config", b);
    expect((await post({ default_max_regression: 2 })).status).toBe(400);
    expect((await post({ overrides: { [rid]: { nope: 0.1 } } })).status).toBe(400);
    expect((await post({ overrides: { unknown: { ns: 0.1 } } })).status).toBe(400);
    expect((await post({ overrides: { [rid]: { ns: -1 } } })).status).toBe(400);
    expect((await post({ kinds: ["perf", "other"] })).status).toBe(400);
    expect((await post({ effective_from_ms: e.clock.now() - 1 })).status).toBe(400);
    expect((await post({ effective_from_ms: e.clock.now() })).status).toBe(400); // a candidate committed this ms keeps the old rule
    expect((await post({ surprise: 1 })).status).toBe(400);
    const author = await makeAuthor(e);
    expect((await author.c.post("/v1/admin/guard-config", { default_max_regression: 0.5 })).status).toBe(403);
    const later = await expectOk(post({ default_max_regression: 0.05, effective_from_ms: e.clock.now() + 60_000 }));
    expect(later.version).toBe(2);
    e.clock.advance(1000);
    const view = await expectOk(e.anon.get("/v1/guard-config"));
    expect(view.current.version).toBe(1); // version 2 is not in force yet
  });
});
