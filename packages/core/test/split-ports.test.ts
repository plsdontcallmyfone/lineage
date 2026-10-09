import { afterEach, describe, expect, test } from "bun:test";
import { teamStatement, type TeamMember } from "../src/collab.ts";
import {
  calibId,
  canonicalizeDiff,
  costClass,
  judge,
  patchCommitment,
  patchHash,
  recipeId,
  resultCommitment,
  sha256Hex,
  signMessage,
  signStatement,
  splitReportCommitment,
  subCommitment,
  type ReplayResult,
  type SplitReport,
} from "../src/protocol.ts";
import { ACC } from "../src/ledger.ts";
import {
  allAgents,
  assignmentsFor,
  CALIB,
  candidate,
  diff,
  expectOk,
  honest,
  makeAuthor,
  qualify,
  RECIPE,
  reconcileOk,
  result,
  runReplays,
  setup,
  type Agent,
  type Env,
} from "./helpers.ts";

// Measured split (SPEC 12.6, plan C5) and cross-lineage ports (SPEC 12.7, plan C7).

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const tipOf = async (e: Env, lineage = e.lineage): Promise<string> => (await expectOk(e.anon.get(`/v1/lineages/${lineage}`))).tip;

const unitsOf = (e: Env, gen: string, kind = "author") =>
  e.core
    .events(0, 10000)
    .filter((x) => x.type === "units.awarded" && (x.data as any).kind === kind && (x.data as any).ref === gen)
    .map((x) => x.data as { agent: string; units: number; rebate: string });

async function commitSplit(e: Env, lead: Agent, mate: Agent, subs: string[], o: { badSub?: boolean } = {}) {
  const patch = canonicalizeDiff(subs.join(""));
  const salt = sha256Hex(Math.random().toString()).slice(0, 32);
  const commitment = patchCommitment(patchHash(patch), salt);
  const sub_commitment = subCommitment(subs.map((s) => patchHash(canonicalizeDiff(s))), salt);
  const split = { mode: "shapley" as const, sub_commitment };
  const parent = await tipOf(e);
  const members: TeamMember[] = [
    { agent: lead.id, role: "author", share_bps: 5000 },
    { agent: mate.id, role: "author", share_bps: 5000 },
  ];
  const st = teamStatement({ lineage_id: e.lineage, parent_gen_id: parent, commitment, kind: "perf", target: "ir", members, split });
  const sigs = { [lead.id]: signStatement(lead.key, "team", st), [mate.id]: signStatement(mate.key, "team", st) };
  const r = await lead.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: parent, kind: "perf", target: "ir", commitment, team: { members, sigs, split } });
  return { r, patch, salt, subs: o.badSub ? [subs[1]!, subs[0]!] : subs };
}

const measure = (cand: number) => ({ apply: "ok" as const, build: "ok" as const, cand_pass: ["t1", "t2", "t3"], equivalence: { base_digest: "e1", cand_digest: "e1" }, metric: { base: [1000], cand: [cand] } });
const report = (a: number, b: number): SplitReport => ({ v: 1, compose: "ok", metric: "ir", subsets: { "0": measure(a), "1": measure(b) } });

/** Every assigned replayer of the candidate commits a result and a split report, then reveals both. */
async function replaySplit(e: Env, candidateId: string, res: ReplayResult, rep: (a: Agent) => SplitReport | null) {
  const held: { a: Agent; id: string; result: ReplayResult; salt: string; split: SplitReport | null }[] = [];
  for (let round = 0; round < 6; round++) {
    let moved = false;
    for (const a of allAgents(e))
      for (const asg of await assignmentsFor(a, candidateId)) {
        if (asg.status !== "assigned") continue;
        expect(asg.kind === "audit" ? asg.split : asg.split?.subs?.length).toBe(asg.kind === "audit" ? null : 2);
        const bytes = new TextEncoder().encode(`t ${asg.replay_id}`);
        const sha = sha256Hex(bytes);
        await expectOk(a.c.putBlob(sha, bytes));
        const full = { ...res, transcript_digest: sha };
        const salt = sha256Hex(Math.random().toString()).slice(0, 32);
        const split = asg.split ? rep(a) : null;
        await expectOk(a.c.post(`/v1/replays/${asg.replay_id}/commit`, { commitment: resultCommitment(full, salt), ...(split ? { split_commitment: splitReportCommitment(split, salt) } : {}) }));
        held.push({ a, id: asg.replay_id, result: full, salt, split });
        moved = true;
      }
    for (const h of [...held]) {
      const asg = (await assignmentsFor(h.a, candidateId)).find((x) => x.replay_id === h.id);
      if (asg?.reveal_open) {
        await expectOk(h.a.c.post(`/v1/replays/${h.id}/reveal`, { result: h.result, salt: h.salt, ...(h.split ? { split: h.split } : {}) }));
        held.splice(held.indexOf(h), 1);
        moved = true;
      }
    }
    if (!moved) return;
  }
}

describe("measured split (SPEC 12.6)", () => {
  test("Shapley shares from the replayers' coalition reports replace declared shares; verdict unchanged; cost billed and paid", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const lead = await makeAuthor(e);
    const mate = await makeAuthor(e);
    const subs = [diff("sa", "src/a.rs"), diff("sb", "src/b.rs")];
    const before = { lead: e.core.ledger.balance(ACC.compute(lead.id)), mate: e.core.ledger.balance(ACC.compute(mate.id)) };
    const x = await commitSplit(e, lead, mate, subs);
    expect(x.r.status).toBe(200);
    // fee: rebate_per_class x cost class x 2 extra trees x quorum 2, half each
    const fee = e.cfg.rebate_per_class * BigInt(costClass(CALIB.median_eval_seconds)) * 2n * 2n;
    // audit A2 OFF-09: nothing moves at commit (public balances would name the open candidate's team)
    expect(e.core.ledger.balance(ACC.compute(lead.id))).toBe(before.lead);
    expect(e.core.ledger.balance(ACC.compute(mate.id))).toBe(before.mate);
    // a reveal without the sub-patches, or with sub-patches in the wrong order, is refused
    expect((await lead.c.post(`/v1/candidates/${x.r.body.commit_id}/reveal`, { patch: x.patch, salt: x.salt })).status).toBe(400);
    const wrong = await lead.c.post(`/v1/candidates/${x.r.body.commit_id}/reveal`, { patch: x.patch, salt: x.salt, subs: [subs[1], subs[0]] });
    expect(wrong.body.error).toBe("split_mismatch");
    const c = await expectOk(lead.c.post(`/v1/candidates/${x.r.body.commit_id}/reveal`, { patch: x.patch, salt: x.salt, subs }));
    // blind while open
    expect((await candidate(e, c.candidate_id)).split).toBeNull();
    // whole patch 20% better; a alone 15%, b alone 5%
    await replaySplit(e, c.candidate_id, result({}, 800), () => report(850, 950));
    const fin = await candidate(e, c.candidate_id);
    expect(fin.status).toBe("accepted");
    // the fee is debited once the candidate is final, half each
    expect(fin.split.fee_paid.map((p: any) => p.amount)).toEqual([(fee / 2n).toString(), (fee / 2n).toString()]);
    expect(e.core.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ledger_entries WHERE reason = 'split_fee' AND ref = ?").get(x.r.body.commit_id)!.n).toBeGreaterThan(0);
    expect(fin.split.outcome.status).toBe("measured");
    expect(fin.split.outcome.share_bps).toEqual([7500, 2500]);
    expect(fin.split.outcome.phi[0] + fin.split.outcome.phi[1]).toBeCloseTo(0.2, 12);
    // the verdict is the same function of the results alone (the split is not an input)
    const replays = fin.replays.filter((r: any) => r.status === "revealed").map((r: any) => ({ replay_id: r.replay_id, replayer: r.replayer, seed: r.seed, result: r.result }));
    const j = judge(RECIPE, CALIB, { candidate_id: c.candidate_id, author: lead.id, kind: "perf", target: "ir" }, replays, { quorum: e.cfg.quorum, det_tolerance: e.cfg.det_tolerance, bootstrap_resamples: e.cfg.bootstrap_resamples });
    expect(j.digest).toBe(fin.verdict.digest);
    // author units by measured shares, exactly
    const u = unitsOf(e, fin.gen_id);
    const total = u.reduce((a, x) => a + x.units, 0);
    expect(Math.round(u.find((x) => x.agent === lead.id)!.units * 1e6)).toBe(Math.round(total * 1e6 * 0.75));
    // counted replayers paid for 1 + 2 trees (two unit rows per replay)
    const cls = costClass(CALIB.median_eval_seconds);
    for (const r of fin.verdict.counted) {
      const rows = e.core.db.query<{ units: number }, [string]>("SELECT units FROM units WHERE ref = ? AND kind = 'replay'").all(r);
      expect(rows.map((x) => x.units).sort((a, b) => a - b)).toEqual([cls * e.cfg.u_replay, 2 * cls * e.cfg.u_replay]);
    }
    await reconcileOk(e);
  }, 60_000);

  test("disagreeing coalition reports fall back to declared shares; acceptance unchanged", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const lead = await makeAuthor(e);
    const mate = await makeAuthor(e);
    const subs = [diff("da", "src/a.rs"), diff("db", "src/b.rs")];
    const x = await commitSplit(e, lead, mate, subs);
    const c = await expectOk(lead.c.post(`/v1/candidates/${x.r.body.commit_id}/reveal`, { patch: x.patch, salt: x.salt, subs }));
    let k = 0;
    await replaySplit(e, c.candidate_id, result({}, 800), () => (k++ === 0 ? report(850, 950) : report(820, 950)));
    const fin = await candidate(e, c.candidate_id);
    expect(fin.status).toBe("accepted");
    expect(fin.split.outcome.status).toBe("disagreed");
    const u = unitsOf(e, fin.gen_id);
    expect(Math.abs(Math.round(u[0]!.units * 1e6) - Math.round(u[1]!.units * 1e6))).toBeLessThanOrEqual(1);
    // audit A2 OFF-10: a report that disagrees earns nobody the extra trees' pay (a made-up report
    // used to be paid like a measured one); each counted replay is paid for its one tree only
    const cls = costClass(CALIB.median_eval_seconds);
    for (const r of fin.verdict.counted) {
      const rows = e.core.db.query<{ units: number }, [string]>("SELECT units FROM units WHERE ref = ? AND kind = 'replay'").all(r);
      expect(rows.map((x) => x.units)).toEqual([cls * e.cfg.u_replay]);
    }
  }, 60_000);

  test("refused on a noisy metric, beyond max_split_members, without a team; refunded when never replayed", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const lead = await makeAuthor(e);
    const mate = await makeAuthor(e);
    const parent = await tipOf(e);
    const salt = "ab".repeat(16);
    const commitment = patchCommitment(patchHash(diff("n")), salt);
    const split = { mode: "shapley" as const, sub_commitment: "0".repeat(64) };
    const members: TeamMember[] = [
      { agent: lead.id, role: "author", share_bps: 5000 },
      { agent: mate.id, role: "author", share_bps: 5000 },
    ];
    const st = teamStatement({ lineage_id: e.lineage, parent_gen_id: parent, commitment, kind: "perf", target: "ns", members, split });
    const sigs = { [lead.id]: signStatement(lead.key, "team", st), [mate.id]: signStatement(mate.key, "team", st) };
    const noisy = await lead.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: parent, kind: "perf", target: "ns", commitment, team: { members, sigs, split } });
    expect(noisy.body.error).toBe("split_needs_deterministic");
    // a signature over the statement without the split does not cover a split
    const st2 = teamStatement({ lineage_id: e.lineage, parent_gen_id: parent, commitment, kind: "perf", target: "ir", members });
    const sigs2 = { [lead.id]: signStatement(lead.key, "team", st2), [mate.id]: signStatement(mate.key, "team", st2) };
    expect((await lead.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: parent, kind: "perf", target: "ir", commitment, team: { members, sigs: sigs2, split } })).body.error).toBe("unsigned_member");
    // expiry refunds the fee
    const subs = [diff("ra", "src/a.rs"), diff("rb", "src/b.rs")];
    const before = e.core.ledger.balance(ACC.compute(lead.id));
    const x = await commitSplit(e, lead, mate, subs);
    expect(e.core.ledger.balance(ACC.compute(lead.id))).toBe(before);
    e.clock.advance((e.cfg.reveal_window_s + 1) * 1000);
    e.core.tick();
    expect((await expectOk(lead.c.get(`/v1/candidates/${x.r.body.commit_id}`, true))).status).toBe("expired");
    expect(e.core.ledger.balance(ACC.compute(lead.id))).toBe(before);
    await reconcileOk(e);
  }, 60_000);
});

describe("cross-lineage ports (SPEC 12.7)", () => {
  async function secondLineage(e: Env): Promise<string> {
    const r2 = { ...RECIPE, name: "fx-port" };
    await expectOk(e.admin.c.post("/v1/admin/recipes", { recipe: r2, recipe_id: recipeId(r2) }));
    const cal = { ...CALIB, recipe_id: recipeId(r2) };
    const ref = e.reference!;
    const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: cal, sig: signMessage(ref.key, calibId(cal.recipe_id, cal.snapshot_id, cal)) }));
    e.core.tick();
    for (const v of e.verifiers) await qualify(v);
    e.core.tick();
    return lin.lineage_id;
  }

  async function submitOn(e: Env, lineage: string, a: Agent, patch: string, extra: Record<string, unknown> = {}) {
    const salt = sha256Hex(Math.random().toString()).slice(0, 32);
    const c = await expectOk(
      a.c.post("/v1/candidates", { lineage_id: lineage, parent_gen_id: await tipOf(e, lineage), kind: "perf", target: "ir", commitment: patchCommitment(patchHash(canonicalizeDiff(patch)), salt), ...extra }),
    );
    return expectOk(a.c.post(`/v1/candidates/${c.commit_id}/reveal`, { patch, salt }));
  }

  test("an undeclared port of an accepted generation credits its author port_share_bps; a declared port credits too", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const L2 = await secondLineage(e);
    const orig = await makeAuthor(e);
    const porter = await makeAuthor(e);
    const p = await submitOn(e, e.lineage, orig, diff("port"));
    await runReplays(e, p.candidate_id, honest(result({}, 900)));
    const pf = await candidate(e, p.candidate_id);
    expect(pf.status).toBe("accepted");
    // the same change on the sibling lineage, not declared
    const q = await submitOn(e, L2, porter, diff("port"));
    await runReplays(e, q.candidate_id, honest(result({}, 900)));
    const qf = await candidate(e, q.candidate_id);
    expect(qf.status).toBe("accepted");
    expect(qf.port.ported_from).toBe(pf.gen_id);
    expect(qf.port.source).toBe("detected");
    const u = unitsOf(e, qf.gen_id);
    const total = u.reduce((a, x) => a + x.units, 0);
    const of = (id: string) => Math.round(u.filter((x) => x.agent === id).reduce((a, x) => a + x.units, 0) * 1e6);
    expect(of(orig.id)).toBe(Math.round((total * 1e6 * e.cfg.port_share_bps) / 10_000));
    expect(of(orig.id) + of(porter.id)).toBe(Math.round(total * 1e6));
    // an adapted change declared as a port of the same generation
    const d = await submitOn(e, L2, porter, diff("port2"), { ported_from: pf.gen_id });
    await runReplays(e, d.candidate_id, honest(result({}, 900)));
    const df = await candidate(e, d.candidate_id);
    expect(df.port.source).toBe("declared");
    expect(unitsOf(e, df.gen_id).some((x) => x.agent === orig.id)).toBe(true);
    // a declared port must name a generation of a sibling lineage
    const bad = await porter.c.post("/v1/candidates", { lineage_id: L2, parent_gen_id: await tipOf(e, L2), kind: "perf", target: "ir", commitment: "1".repeat(64), ported_from: df.gen_id });
    expect(bad.status).toBe(404);
    // an independent author who committed first on its own lineage is not a porter
    const i1 = await submitOn(e, L2, porter, diff("indep"));
    const i2 = await submitOn(e, e.lineage, orig, diff("indep"));
    await runReplays(e, i2.candidate_id, honest(result({}, 900)));
    await runReplays(e, i1.candidate_id, honest(result({}, 900)));
    const i1f = await candidate(e, i1.candidate_id);
    const i2f = await candidate(e, i2.candidate_id);
    expect(i1f.status).toBe("accepted");
    expect(i2f.status).toBe("accepted");
    expect(i1f.port).toBeNull();
    expect(i2f.port).toBeNull();
    await reconcileOk(e);
  }, 60_000);
});
