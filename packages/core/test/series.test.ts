import { afterEach, describe, expect, test } from "bun:test";
import { teamStatement } from "../src/collab.ts";
import { canonicalizeDiff, patchCommitment, patchHash, sha256Hex, signStatement } from "../src/protocol.ts";
import {
  assignmentsFor,
  authorLeaks,
  CANARY_FAST,
  candidate,
  diff,
  expectOk,
  honest,
  makeAuthor,
  reconcileOk,
  result,
  runReplays,
  settleCanaries,
  setup,
  submit,
  warmShadows,
  type Agent,
  type Env,
} from "./helpers.ts";

// Stacked series (SPEC 12.4, plan milestone C3): a candidate commits early on top of a pending one,
// is held until that one is final, then is judged on the tip like any rebase, or fails with it.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

interface Sealed {
  commit_id: string;
  patch: string;
  salt: string;
}

async function tip(e: Env): Promise<string> {
  return (await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).tip;
}

/** Commits without revealing. `team` members sign the statement (with depends_on when given). */
async function commit(e: Env, a: Agent, patch: string, o: { depends_on?: string; team?: { members: any[]; signers: Agent[]; omitDep?: boolean }; target?: string } = {}) {
  const salt = sha256Hex(Math.random().toString()).slice(0, 32);
  const canonical = canonicalizeDiff(patch);
  const commitment = patchCommitment(patchHash(canonical), salt);
  const parent = await tip(e);
  const target = o.target ?? "ir";
  const body: Record<string, unknown> = { lineage_id: e.lineage, parent_gen_id: parent, kind: "perf", target, commitment, claimed_effect: 0.1 };
  if (o.depends_on) body.depends_on = o.depends_on;
  if (o.team) {
    const st = teamStatement({ lineage_id: e.lineage, parent_gen_id: parent, commitment, kind: "perf", target, members: o.team.members, depends_on: o.team.omitDep ? null : (o.depends_on ?? null) });
    body.team = { members: o.team.members, sigs: Object.fromEntries(o.team.signers.map((s) => [s.id, signStatement(s.key, "team", st)])) };
  }
  const r = await a.c.post("/v1/candidates", body);
  return { r, sealed: r.status < 300 ? ({ commit_id: r.body.commit_id, patch, salt } as Sealed) : null };
}

async function commitOk(e: Env, a: Agent, patch: string, o: Parameters<typeof commit>[3] = {}): Promise<Sealed> {
  const { r, sealed } = await commit(e, a, patch, o);
  if (!sealed) throw new Error(`commit refused: ${r.status} ${JSON.stringify(r.body)}`);
  return sealed;
}

function reveal(a: Agent, s: Sealed) {
  return a.c.post(`/v1/candidates/${s.commit_id}/reveal`, { patch: s.patch, salt: s.salt });
}

const authorUnits = (e: Env, gen: string) =>
  e.core
    .events(0, 10_000)
    .filter((x) => x.type === "units.awarded" && (x.data as any).kind === "author" && (x.data as any).ref === gen)
    .map((x) => x.data as { agent: string; units: number });

describe("stacked series (SPEC 12.4)", () => {
  test("B commits on pending A, cannot reveal before A, waits, then is measured on the tip that includes A and keeps its commit time", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e);
    const A = await commitOk(e, a, diff("series_a"));
    e.clock.advance(1000);
    const B = await commitOk(e, a, diff("series_b"), { depends_on: A.commit_id });
    const bCommitted = (await expectOk(a.c.get(`/v1/candidates/${B.commit_id}`, true))).committed_at;
    // B's diff context would show A's sealed lines: it may not reveal first
    const early = await reveal(a, B);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("dependency_unrevealed");
    const ra = await expectOk(reveal(a, A));
    expect(ra.status).toBe("replaying");
    const rb = await expectOk(reveal(a, B));
    expect(rb.status).toBe("waiting");
    expect(rb.series.depends_on).toBe(A.commit_id);
    // the public sees a waiting candidate: no author, no link to A
    const pub = await candidate(e, rb.candidate_id);
    expect(pub.status).toBe("waiting");
    expect(pub.author).toBeNull();
    expect(pub.series).toBeNull();
    expect((await candidate(e, ra.candidate_id)).series).toBeNull();
    e.clock.advance(5000);
    e.core.tick();
    expect((await candidate(e, rb.candidate_id)).status).toBe("waiting");
    expect(await assignmentsFor(e.verifiers[0]!, rb.candidate_id)).toEqual([]);
    await runReplays(e, ra.candidate_id, honest(result({}, 900)));
    const fa = await candidate(e, ra.candidate_id);
    expect(fa.status).toBe("accepted");
    e.core.tick();
    const queued = await expectOk(a.c.get(`/v1/candidates/${B.commit_id}`, true));
    expect(queued.status).toBe("replaying");
    expect(queued.eval_parent_gen_id).toBe(fa.gen_id);
    expect(queued.series.outcome).toBe("on_tip");
    expect(queued.series.released_onto).toBe(fa.gen_id);
    // every replay of B is measured on the tip that contains A
    for (const v of e.verifiers) for (const asg of await assignmentsFor(v, rb.candidate_id)) expect(asg.parent_series.map((p: any) => p.gen_id)).toContain(fa.gen_id);
    await runReplays(e, rb.candidate_id, honest(result({}, 900)));
    const fb = await candidate(e, rb.candidate_id);
    expect(fb.status).toBe("accepted");
    expect(fb.committed_at).toBe(bCommitted);
    const gb = await expectOk(e.anon.get(`/v1/generations/${fb.gen_id}`));
    expect(gb.parent_gen_id).toBe(fa.gen_id);
    // both final: the link is public now, on both sides
    expect(fb.series.depends_on).toBe(A.commit_id);
    expect((await candidate(e, ra.candidate_id)).series.dependents).toEqual([B.commit_id]);
    expect(authorUnits(e, fb.gen_id).map((u) => u.agent)).toEqual([a.id]);
    const evs = e.core.events(0, 10_000).map((x) => x.type);
    expect(evs).toContain("candidate.waiting");
    expect(evs).toContain("candidate.released");
    await reconcileOk(e);
  });

  test("A rejected: B is queued alone on the tip; a patch that does not apply there fails as dependency_failed, one that applies is judged on its own", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e);
    const A = await commitOk(e, a, diff("fail_a"));
    const B = await commitOk(e, a, diff("fail_b"), { depends_on: A.commit_id });
    const B2 = await commitOk(e, a, diff("fail_b2", "src/other.rs"), { depends_on: A.commit_id });
    const ra = await expectOk(reveal(a, A));
    const rb = await expectOk(reveal(a, B));
    const rb2 = await expectOk(reveal(a, B2));
    expect(rb.status).toBe("waiting");
    const broken = result({ tests: { base_pass: ["t1", "t2", "t3", "net_test"], cand_pass: ["t1"], cand_fail: ["t2", "t3", "bug1", "bug2"] } });
    await runReplays(e, ra.candidate_id, honest(broken));
    expect((await candidate(e, ra.candidate_id)).status).toBe("rejected");
    const before = await tip(e);
    e.core.tick();
    const qb = await expectOk(a.c.get(`/v1/candidates/${B.commit_id}`, true));
    expect(qb.status).toBe("replaying");
    expect(qb.eval_parent_gen_id).toBe(before);
    expect(qb.series.outcome).toBe("alone");
    await runReplays(e, rb.candidate_id, honest(result({ apply: "conflict" })));
    const fb = await candidate(e, rb.candidate_id);
    expect(fb.status).toBe("rejected");
    expect(fb.reason).toBe("dependency_failed");
    // the same B, on the same parent, may be committed again on another dependency: it failed only with the first one
    expect(await tip(e)).toBe(before);
    // the same B may be committed again on another dependency: it failed only with the first one
    const A3 = await commitOk(e, a, diff("fail_a3", "src/third.rs"));
    await expectOk(reveal(a, A3));
    const again = await commitOk(e, a, diff("fail_b"), { depends_on: A3.commit_id });
    expect((await expectOk(reveal(a, again))).status).toBe("waiting");
    await runReplays(e, rb2.candidate_id, honest(result({}, 900)));
    expect((await candidate(e, rb2.candidate_id)).status).toBe("accepted");
    await reconcileOk(e);
  });

  test("a stacked candidate whose dependency ends unrevealed fails at once; it never reveals", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const A = await commitOk(e, a, diff("exp_a"));
    e.clock.advance(10_000);
    const B = await commitOk(e, a, diff("exp_b"), { depends_on: A.commit_id });
    e.clock.advance(e.cfg.reveal_window_s * 1000 - 5_000);
    e.core.tick();
    const fa = await expectOk(a.c.get(`/v1/candidates/${A.commit_id}`, true));
    expect(fa.status).toBe("expired");
    const fb = await expectOk(a.c.get(`/v1/candidates/${B.commit_id}`, true));
    expect(fb.status).toBe("rejected");
    expect(fb.reason).toBe("dependency_failed");
    expect((await reveal(a, B)).status).toBe(409);
  });

  test("validation: same lineage, open dependency, max_series_depth, another author's signature bound to depends_on; credit stays with each candidate's own authors", async () => {
    const e = (env = await setup({ verifiers: 5, over: { max_series_depth: 2 } }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const A = await commitOk(e, a, diff("v_a"));
    expect((await commit(e, a, diff("v_x"), { depends_on: "f".repeat(64) })).r.status).toBe(404);
    expect((await commit(e, a, diff("v_x"), { depends_on: "nope" })).r.status).toBe(400);
    // another author's candidate: refused without that author's signed membership
    const ride = await commit(e, b, diff("v_ride"), { depends_on: A.commit_id });
    expect(ride.r.status).toBe(403);
    expect(ride.r.body.error).toBe("dependency_unsigned");
    const members = [
      { agent: b.id, role: "author", share_bps: 10_000 },
      { agent: a.id, role: "author", share_bps: 0 },
    ];
    // a team signature that does not bind depends_on is not consent to ride on A
    const unbound = await commit(e, b, diff("v_b"), { depends_on: A.commit_id, team: { members, signers: [b, a], omitDep: true } });
    expect(unbound.r.status).toBe(403);
    expect(unbound.r.body.error).toBe("unsigned_member");
    const B = await commitOk(e, b, diff("v_b"), { depends_on: A.commit_id, team: { members, signers: [b, a] } });
    // depth: C on B on A is 2 open candidates; D on C would be 3
    const C = await commitOk(e, b, diff("v_c"), { depends_on: B.commit_id });
    const deep = await commit(e, b, diff("v_d"), { depends_on: C.commit_id });
    expect(deep.r.status).toBe(409);
    expect(deep.r.body.error).toBe("series_too_deep");
    const ra = await expectOk(reveal(a, A));
    const rb = await expectOk(reveal(b, B));
    const rc = await expectOk(reveal(b, C));
    expect([rb.status, rc.status]).toEqual(["waiting", "waiting"]);
    await runReplays(e, ra.candidate_id, honest(result({}, 900)));
    const fa = await candidate(e, ra.candidate_id);
    expect(fa.status).toBe("accepted");
    // a final candidate has nothing to wait for
    const late = await commit(e, a, diff("v_late"), { depends_on: A.commit_id });
    expect(late.r.status).toBe(409);
    expect(late.r.body.error).toBe("dependency_final");
    e.core.tick();
    await runReplays(e, rb.candidate_id, honest(result({}, 900)));
    const fb = await candidate(e, rb.candidate_id);
    expect(fb.status).toBe("accepted");
    // B's units go to B's authors by its declared shares: b all, a (share 0) nothing; A's to a
    expect(authorUnits(e, fb.gen_id).map((u) => u.agent)).toEqual([b.id]);
    expect(authorUnits(e, fa.gen_id).map((u) => u.agent)).toEqual([a.id]);
    e.core.tick();
    expect((await candidate(e, rc.candidate_id)).status).toBe("replaying");
    await reconcileOk(e);
  });

  test("exclusions span the series: a party of B already replaying A is cancelled and redrawn, and is never drawn for any candidate of the series", async () => {
    const e = (env = await setup({ verifiers: 6 }));
    const a = await makeAuthor(e);
    const A = await commitOk(e, a, diff("x_a"));
    const ra = await expectOk(reveal(a, A));
    let v: Agent | undefined;
    for (const x of e.verifiers) if ((await assignmentsFor(x, ra.candidate_id)).length) v = x;
    expect(v).toBeDefined();
    const members = [
      { agent: a.id, role: "author", share_bps: 10_000 },
      { agent: v!.id, role: "reviewer", share_bps: 0 },
    ];
    const B = await commitOk(e, a, diff("x_b"), { depends_on: A.commit_id, team: { members, signers: [a, v!] } });
    expect(await assignmentsFor(v!, ra.candidate_id)).toEqual([]);
    e.core.tick();
    const drawn = e.core.db.query<{ replayer: string; status: string }, [string]>("SELECT replayer, status FROM replays WHERE candidate_id = ?").all(ra.candidate_id);
    expect(drawn.filter((r) => r.replayer === v!.id).map((r) => r.status)).toEqual(["cancelled"]);
    expect(drawn.filter((r) => r.status === "assigned").length).toBeGreaterThanOrEqual(2);
    await runReplays(e, ra.candidate_id, honest(result({}, 900)));
    const rb = await expectOk(reveal(a, B));
    e.core.tick();
    await runReplays(e, rb.candidate_id, honest(result({}, 900)));
    const fb = await candidate(e, rb.candidate_id);
    expect(fb.status).toBe("accepted");
    const all = e.core.db.query<{ replayer: string }, [string, string]>("SELECT replayer FROM replays WHERE candidate_id IN (?, ?) AND status != 'cancelled'").all(ra.candidate_id, rb.candidate_id);
    expect(all.some((r) => r.replayer === v!.id || r.replayer === a.id)).toBe(false);
    // the exclusion rounds name every party of the series for both candidates
    for (const cid of [ra.candidate_id, rb.candidate_id]) {
      const rounds = e.core.db.query<{ exclude: string }, [string]>("SELECT exclude FROM assignment_rounds WHERE subject = ?").all(cid);
      expect(rounds.length).toBeGreaterThan(0);
      for (const r of rounds.slice(1)) expect(JSON.parse(r.exclude).agents).toContain(v!.id);
    }
  });

  test("author-blind: while A is open and B waits, no public endpoint names an author or the link; once both are final the link is public", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e);
    const A = await commitOk(e, a, diff("blind_a"));
    const B = await commitOk(e, a, diff("blind_b"), { depends_on: A.commit_id });
    const ra = await expectOk(reveal(a, A));
    const rb = await expectOk(reveal(a, B));
    const open = [ra, rb].map((c) => ({ ids: [c.commit_id, c.candidate_id], parties: [a.id], sealed: [] as string[] }));
    expect(await authorLeaks(e, open)).toEqual([]);
    // no public object names both candidates (the dependency would mark A as real)
    const pubA = JSON.stringify(await candidate(e, ra.candidate_id));
    const pubB = JSON.stringify(await candidate(e, rb.candidate_id));
    expect(pubA.includes(B.commit_id) || pubA.includes(rb.candidate_id)).toBe(false);
    expect(pubB.includes(A.commit_id) || pubB.includes(ra.candidate_id)).toBe(false);
    const log = await expectOk<any[]>(e.anon.get("/v1/events/log?since=0&limit=5000"));
    expect(log.some((x) => JSON.stringify(x).includes(A.commit_id) && JSON.stringify(x).includes(B.commit_id))).toBe(false);
  });

  test("shadow parity: canaries wait at the rate real candidates of the lineage waited, for a real-looking time, and look the same publicly", async () => {
    const e = (env = await setup({ verifiers: 6, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("sp_canary", "src/c.rs") }));
    const a = await makeAuthor(e);
    warmShadows(e);
    // history: every real candidate of this lineage waited 20 s (written directly so the rate is 1)
    const history = await submit(e, a, diff("sp_hist"));
    await runReplays(e, history.candidate_id, honest(result({}, 900)));
    const now = e.clock.now();
    e.core.db.query("INSERT INTO series (commit_id, depends_on, depth, state, outcome, waiting_since, released_at) VALUES (?, ?, 1, 'released', 'on_tip', ?, ?)").run(history.commit_id, "e".repeat(64), now - 30_000, now - 10_000);
    const trigger = await submit(e, a, diff("sp_trigger", "src/t.rs"));
    e.core.db.query("INSERT INTO series (commit_id, depends_on, depth, state, outcome, waiting_since, released_at) VALUES (?, ?, 1, 'released', 'on_tip', ?, ?)").run(trigger.commit_id, "e".repeat(64), now - 30_000, now - 10_000);
    const canaryRow = () => e.core.db.query<{ commit_id: string; candidate_id: string; status: string }, []>("SELECT commit_id, candidate_id, status FROM candidates WHERE is_canary = 1").get();
    for (let i = 0; i < 20 && (!canaryRow() || canaryRow()!.status === "committed"); i++) settleCanaries(e, 1);
    const canary = canaryRow();
    expect(canary).toBeTruthy();
    expect(canary!.status).toBe("waiting");
    const pub = await candidate(e, canary!.candidate_id);
    expect(pub.status).toBe("waiting");
    expect(pub.author).toBeNull();
    expect(pub.series).toBeNull();
    const row = e.core.db.query<{ release_at: number; waiting_since: number }, [string]>("SELECT release_at, waiting_since FROM series WHERE commit_id = ?").get(canary!.commit_id)!;
    expect(row.release_at - row.waiting_since).toBeGreaterThanOrEqual(18_000);
    expect(row.release_at - row.waiting_since).toBeLessThanOrEqual(22_000);
    for (let i = 0; i < 6; i++) {
      e.clock.advance(5_000);
      e.core.tick();
    }
    expect(["replaying", "queued"]).toContain((await candidate(e, canary!.candidate_id)).status);
  });
});
