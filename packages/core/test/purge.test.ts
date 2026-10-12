import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { calibId, generateAgentKey, recipeId, repoId, signMessage, snapshotId } from "../src/protocol.ts";
import { purgeDigest, RULES } from "../src/purge.ts";
import { replicate } from "../src/replica.ts";
import { CALIB, DEPS, RECIPE, ROOT, candidate, diff, expectOk, honest, makeAuthor, qualify, reconcileOk, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// purge.ts: a launch and everything it produced leave the database for good; the unit it built is back
// at generation 0 with its calibration and the verifiers' qualifications; nothing of another agent changes.

let env: Env;
afterEach(() => env?.close());

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

/** One attempt on `e.lineage`: a session, a candidate replayed to accepted, the worker's report. */
async function attempt(e: Env, a: Agent, name: string, irCand: number) {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  const cand = await submit(e, a, diff(name, `src/${name}.rs`));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/end`, { commit_id: cand.commit_id }));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/episode`, report));
  await runReplays(e, cand.candidate_id, honest(result({}, irCand)));
  expect((await candidate(e, cand.candidate_id)).status).toBe("accepted");
  return { session: s.session_id as string, cand };
}

/** A second unit on its own repository, calibrated by the reference runner; every verifier qualifies on it. */
async function secondUnit(e: Env): Promise<Env> {
  const recipe = { ...RECIPE, name: "fx2", repo: "https://github.com/example/fx2" };
  await expectOk(e.admin.c.post("/v1/admin/recipes", { recipe, recipe_id: recipeId(recipe) }));
  await expectOk(e.admin.c.post("/v1/admin/snapshots", { repo: recipe.repo, commit: recipe.commit, deps_digest: DEPS }));
  const calib = { ...CALIB, recipe_id: recipeId(recipe), snapshot_id: snapshotId(repoId(recipe.repo), recipe.commit, DEPS) };
  const lin = await expectOk(e.reference!.c.post("/v1/calibrations", { calibration: calib, sig: signMessage(e.reference!.key, calibId(calib.recipe_id, calib.snapshot_id, calib)) }));
  e.core.tick();
  for (const v of e.verifiers) expect(await qualify(v)).toHaveLength(1);
  return { ...e, lineage: lin.lineage_id, gen0: lin.gen0 };
}

type Dump = Record<string, string[]>;
/** Every row of every table, as text (request nonces aside: every signed request of the test adds one). */
function dump(e: Env): Dump {
  const out: Dump = {};
  for (const { name } of e.core.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
    if (name !== "nonces") out[name] = e.core.db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((r) => JSON.stringify(r));
  return out;
}
const names = (rows: string[], ids: string[]) => rows.filter((r) => ids.some((id) => r.includes(id)));

describe("purge", () => {
  test("one of two launches is purged: no row names it, the other launch is untouched, its unit is at generation 0 and the network still verifies", async () => {
    const e1 = (env = await setup({ verifiers: 4 }));
    const e2 = await secondUnit(e1);
    const kept = await makeAuthor(e1);
    const gone = await makeAuthor(e2, { repo: "https://github.com/example/fx2" });
    e1.clock.advance(1000);
    await attempt(e1, kept, "kept_a", 900);
    await attempt(e1, kept, "kept_b", 800);
    const g1 = await attempt(e2, gone, "gone_a", 900);
    const g2 = await attempt(e2, gone, "gone_b", 800);
    const goneView = await expectOk(e1.anon.get(`/v1/agents/${gone.id}`));
    const mint = goneView.mint as string;
    await expectOk(e1.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "test launch" }] }));
    expect((await expectOk(e1.anon.get(`/v1/lineages/${e2.lineage}`))).height).toBe(2);

    // every table this database holds is classified
    const tables = [...Object.keys(dump(e1)), "nonces"];
    expect(tables.filter((t) => !RULES[t] && t !== "purged_agents")).toEqual([]);

    // what must not remain: the agent, its coin, its commits, candidates, generations, sessions and their replays
    const db = e1.core.db;
    const ids = [
      gone.id, mint, g1.session, g2.session, g1.cand.commit_id, g2.cand.commit_id, g1.cand.candidate_id, g2.cand.candidate_id,
      ...db.query<{ gen_id: string }, [string, string]>("SELECT gen_id FROM generations WHERE lineage_id = ? AND gen_id != ?").all(e2.lineage, e2.gen0).map((r) => r.gen_id),
      ...db.query<{ replay_id: string }, [string, string]>("SELECT replay_id FROM replays WHERE candidate_id IN (?, ?)").all(g1.cand.candidate_id, g2.cand.candidate_id).map((r) => r.replay_id),
    ];
    expect(ids.length).toBeGreaterThan(12);
    const before = dump(e1);
    expect(names(before.candidates!, ids)).toHaveLength(2);
    expect(names(before.units!, ids).length).toBeGreaterThan(0);
    const quals = before.qualifications!;
    const calibs = before.calibrations!;

    // refused while a session of the agent is live
    const lv = await expectOk(e2.anon.get(`/v1/lineages/${e2.lineage}`));
    const live = await expectOk(gone.c.post("/v1/sessions", { lineage_id: e2.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
    const busy = await e1.admin.c.post("/v1/admin/purge", { agents: [gone.id], plan: true });
    expect(busy.status).toBe(409);
    expect(busy.body.message).toContain("live");
    await expectOk(gone.c.post(`/v1/sessions/${live.session_id}/end`, {}));
    ids.push(live.session_id);

    // a unit that mixes authors is never rewritten
    const other = await makeAuthor(e1);
    await attempt(e1, other, "other_a", 700);
    const mixed = await e1.admin.c.post("/v1/admin/purge", { agents: [kept.id], plan: true });
    expect(mixed.status).toBe(409);
    expect(mixed.body.message).toContain("mixes");
    // only the admin may ask
    expect((await kept.c.post("/v1/admin/purge", { agents: [gone.id], plan: true })).status).toBe(403);

    // the plan: counts, and nothing changed
    const at = dump(e1);
    const plan = await expectOk(e1.admin.c.post("/v1/admin/purge", { agents: [gone.id], plan: true }));
    expect(plan).toMatchObject({ plan: true, agents: 1, backup: null, units_reset: [{ lineage_id: e2.lineage, height_before: 2, generations_removed: 2 }] });
    expect(plan.tables.candidates).toEqual({ action: "rows deleted", rows: 2 });
    expect(plan.tables.generations.rows).toBe(2);
    expect(plan.tables.agents.rows).toBe(1);
    expect(dump(e1)).toEqual(at);
    expect((await expectOk(e1.anon.get("/v1/purged"))).count).toBe(0);

    // the run
    const run = await expectOk(e1.admin.c.post("/v1/admin/purge", { agents: [gone.id] }));
    expect(run.plan).toBe(false);
    expect(run.tables).toEqual({ ...plan.tables });
    expect(existsSync(run.backup)).toBe(true);
    expect(run.backup).toContain("pre-purge-");
    const copy = new Database(run.backup, { readonly: true });
    expect(copy.query("SELECT 1 FROM agents WHERE agent_id = ?").get(gone.id)).toBeTruthy(); // the copy still holds it
    copy.close();

    // full-table scan: no cell of any row names the purged launch or its work
    const after = dump(e1);
    for (const [t, rows] of Object.entries(after)) expect([t, names(rows, ids)]).toEqual([t, []]);
    // the tombstone holds digests only
    expect(after.purged_agents).toHaveLength(1);
    expect(await expectOk(e1.anon.get("/v1/purged"))).toMatchObject({ count: 1, purged: [{ agent_sha256: purgeDigest(gone.id), mint_sha256: purgeDigest(mint) }] });

    // everything that did not name it is byte-identical (the purged unit's row, the ledger's
    // recomputed balances, the event log's new entry and the tombstone are checked on their own)
    const changed = new Set(["lineages", "balances", "ledger_entries", "events", "purged_agents", "heartbeats"]);
    for (const t of Object.keys(at)) {
      if (changed.has(t)) continue;
      expect([t, after[t]]).toEqual([t, at[t]!.filter((r) => !ids.some((id) => r.includes(id)))]);
    }
    expect(after.events!.slice(0, -1)).toEqual(at.events!.filter((r) => !ids.some((id) => r.includes(id))));
    expect(after.events!.at(-1)).toContain("purge.done");
    expect(after.ledger_entries).toEqual(at.ledger_entries!.filter((r) => !ids.some((id) => r.includes(id))));
    // the other launches: their agent, candidates, generations and unit read as before
    for (const a of [kept, other]) expect(names(after.candidates!, [a.id])).toEqual(names(at.candidates!, [a.id]));
    expect(names(after.generations!, [e1.lineage])).toEqual(names(at.generations!, [e1.lineage]));
    expect(names(after.lineages!, [e1.lineage])).toEqual(names(at.lineages!, [e1.lineage]));

    // the purged unit: generation 0, calibration and qualifications intact
    const unit = await expectOk(e1.anon.get(`/v1/lineages/${e2.lineage}`));
    expect(unit).toMatchObject({ height: 0, tip: e2.gen0, gen0: e2.gen0, status: "active" });
    expect(db.query("SELECT COUNT(*) AS n FROM generations WHERE lineage_id = ?").get(e2.lineage)).toEqual({ n: 1 });
    expect(after.qualifications).toEqual(quals);
    expect(after.calibrations).toEqual(calibs);
    expect((await e1.anon.get(`/v1/agents/${gone.id}`)).status).toBe(404);
    expect((await expectOk(e1.anon.get("/v1/hidden"))).count).toBe(0);
    await reconcileOk(e1);

    // it cannot come back: not by a launch of the same agent, not by the same coin
    const again = await e1.admin.c.post("/v1/admin/launches", { agent: gone.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/example/fx2", hosted: true, identity_mode: "app" });
    expect([again.status, again.body.error]).toEqual([409, "purged"]);
    const sameCoin = await e1.admin.c.post("/v1/admin/launches", { agent: generateAgentKey().id, mint, launcher: generateAgentKey().id, target_repo: "https://github.com/example/fx2", hosted: true, identity_mode: "app" });
    expect([sameCoin.status, sameCoin.body.error]).toEqual([409, "purged"]);

    // idempotent
    const twice = await expectOk(e1.admin.c.post("/v1/admin/purge", { agents: [gone.id] }));
    expect(twice).toMatchObject({ agents: 0, already_purged: 1, tables: {}, units_reset: [] });
    expect((await e1.admin.c.post("/v1/admin/purge", { agents: [generateAgentKey().id] })).status).toBe(404);

    // a new launch starts the unit from the original code, and the same verifiers replay it without qualifying again
    const fresh = await makeAuthor(e2, { repo: "https://github.com/example/fx2" });
    await attempt(e2, fresh, "fresh_a", 900);
    expect((await expectOk(e1.anon.get(`/v1/lineages/${e2.lineage}`))).height).toBe(1);

    // the network still checks out: the ledger, the replica over a closed epoch, and verify.ts
    await reconcileOk(e1);
    await expectOk(e1.admin.c.post("/v1/admin/epochs/close"));
    const rep = await replicate(e1.base);
    expect(rep.epochs.checked).toBeGreaterThan(0);
    expect(rep.divergences).toEqual([]);
    const proc = Bun.spawn(["bun", join(ROOT, "scripts/verify.ts"), "--core", e1.base], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect([code, (out + err).split("\n").filter((l) => /FAIL|mismatch/i.test(l))]).toEqual([0, []]);
  }, 120_000);
});
