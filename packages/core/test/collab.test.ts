import { afterEach, describe, expect, test } from "bun:test";
import { intentStatement, splitByBps, teamStatement, type TeamMember } from "../src/collab.ts";
import { canonicalizeDiff, generateAgentKey, patchCommitment, patchHash, sha256Hex, signStatement, verifyStatement } from "../src/protocol.ts";
import {
  agentClient,
  authorLeaks,
  CANARY_FAST,
  makeVerifier,
  candidate,
  diff,
  expectOk,
  honest,
  makeAuthor,
  result,
  runReplays,
  settleCanaries,
  setup,
  submit,
  warmShadows,
  type Agent,
  type Env,
} from "./helpers.ts";

// Collaboration (SPEC 12.1, 12.2): intents and the workboard, teams with declared signed shares.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

async function tipOf(e: Env): Promise<string> {
  return (await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).tip;
}

async function fileIntent(e: Env, a: Agent, o: { kind?: string; target?: unknown; ttl_s?: number; note?: string; tip?: string; sig?: string } = {}) {
  const tip = o.tip ?? (await tipOf(e));
  const kind = o.kind ?? "perf";
  const target = o.target ?? "ir";
  const ttl_s = o.ttl_s ?? 600;
  const norm = kind === "fix" ? [...new Set(target as string[])].sort() : target;
  const sig = o.sig ?? signStatement(a.key, "intent", intentStatement({ agent: a.id, lineage_id: e.lineage, tip, kind, target: norm as string, ttl_s, note: o.note ?? null }));
  return a.c.post("/v1/intents", { lineage_id: e.lineage, tip, kind, target, ttl_s, note: o.note, sig });
}

describe("intents (SPEC 12.1)", () => {
  test("advisory, validated, signed, capped; withdraw, expiry and staleness are public transitions", async () => {
    const e = (env = await setup({ verifiers: 4, over: { max_intents_per_agent: 2, intent_rate_per_hour: 3, intent_max_ttl_s: 900 } }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const i1 = await expectOk(fileIntent(e, a, { note: "trying a lookup table" }));
    expect(i1.status).toBe("open");
    expect(i1.target).toBe("ir");
    // a second agent may file on the same target: no exclusivity, no priority
    const i2 = await expectOk(fileIntent(e, b));
    expect(i2.agent).toBe(b.id);
    // validation
    expect((await fileIntent(e, a, { target: "size" })).status).toBe(400); // disabled metric
    expect((await fileIntent(e, a, { target: "nope" })).status).toBe(400);
    expect((await fileIntent(e, a, { kind: "fix", target: ["t1"] })).status).toBe(400); // not a known failure
    expect((await fileIntent(e, a, { ttl_s: 901 })).status).toBe(400);
    expect((await fileIntent(e, a, { tip: "f".repeat(64) })).status).toBe(409);
    expect((await fileIntent(e, a, { sig: signStatement(b.key, "intent", { x: 1 }) })).status).toBe(403);
    expect((await fileIntent(e, e.verifiers[0]!)).status).toBe(403); // verifiers do not author
    // cap: two open intents per agent, then 429
    await expectOk(fileIntent(e, a, { kind: "fix", target: ["bug2", "bug1"] }));
    const capped = await fileIntent(e, a, { kind: "perf", target: "ns" });
    expect(capped.status).toBe(429);
    expect(capped.body.error).toBe("too_many_intents");
    // withdraw frees a slot; the hourly rate then refuses the fourth filing in the hour
    await expectOk(a.c.request("DELETE", `/v1/intents/${i1.intent_id}`));
    expect((await b.c.request("DELETE", `/v1/intents/${i1.intent_id}`)).status).toBe(403);
    await expectOk(fileIntent(e, a, { target: "ns" }));
    const rated = await fileIntent(e, a, { target: "ns" });
    expect(rated.status).toBe(429);
    expect(["intent_rate", "too_many_intents"]).toContain(rated.body.error);
    const open = await expectOk<any[]>(e.anon.get(`/v1/intents?lineage=${e.lineage}`));
    expect(open.map((x) => x.agent).sort()).toEqual([a.id, a.id, b.id].sort());
    expect((await expectOk<any[]>(e.anon.get(`/v1/intents?lineage=${e.lineage}&target=bug1`))).length).toBe(1);
    // the workboard names holders per target
    const wb = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/workboard`));
    expect(wb.targets.find((t: any) => t.target === "ir").holders).toEqual([b.id]);
    expect(wb.targets.find((t: any) => t.kind === "fix" && t.target[0] === "bug1").holders).toEqual([a.id]);
    // TTL passes: expired, with an event
    e.clock.advance(601_000);
    e.core.tick();
    const after = await expectOk<any[]>(e.anon.get(`/v1/intents?lineage=${e.lineage}&status=all`));
    expect(after.find((x) => x.intent_id === i2.intent_id).status).toBe("expired");
    expect(after.find((x) => x.intent_id === i1.intent_id).status).toBe("withdrawn");
    const closed = e.core.events(0, 5000).filter((x) => x.type === "intent.closed").map((x) => (x.data as any).reason);
    expect(closed).toContain("expired");
    expect(closed).toContain("withdrawn");
  });

  test("an intent closes on commit for its author at once, publicly only once the candidate is final; a moved tip makes others stale", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const ia = await expectOk(fileIntent(e, a, { ttl_s: 3000 }));
    const ib = await expectOk(fileIntent(e, b, { ttl_s: 3000 }));
    const c = await submit(e, a, diff("intent_led"));
    // the author sees the link; the public sees the intent unchanged (its end would time the commit)
    const mine = await expectOk<any[]>(a.c.get(`/v1/intents?agent=${a.id}&status=all`, true));
    expect(mine[0].status).toBe("committed");
    expect(mine[0].candidate.commit_id).toBe(c.commit_id);
    e.core.tick();
    const pub = (await expectOk<any[]>(e.anon.get(`/v1/intents?agent=${a.id}&status=all`)))[0];
    expect(pub.status).toBe("open");
    expect(pub.candidate).toBeNull();
    expect(e.core.events(0, 5000).some((x) => x.type === "intent.closed" && (x.data as any).intent_id === ia.intent_id)).toBe(false);
    // still counts against the cap while it is publicly open
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/intents`))).stats.open).toBe(1);
    await runReplays(e, c.candidate_id, honest(result({}, 900)));
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    e.core.tick();
    const all = await expectOk<any[]>(e.anon.get(`/v1/intents?lineage=${e.lineage}&status=all`));
    const pa = all.find((x) => x.intent_id === ia.intent_id);
    expect(pa.status).toBe("committed");
    expect(pa.candidate.candidate_id).toBe(c.candidate_id);
    expect(pa.candidate.status).toBe("accepted");
    // the tip moved: the other author's intent is stale
    expect(all.find((x) => x.intent_id === ib.intent_id).status).toBe("stale");
    const stats = (await expectOk(e.anon.get(`/v1/agents/${a.id}/intents`))).stats;
    expect(stats).toMatchObject({ filed: 1, open: 0, led_to_candidate: 1, led_to_generation: 1 });
  });

  test("shadow parity: a canary's shadow files an intent on its target first, at the rate real authors do", async () => {
    const e = (env = await setup({ verifiers: 6, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("par1", "src/p1.rs") }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("par2", "src/p2.rs") }));
    const a = await makeAuthor(e);
    warmShadows(e);
    // real authors here always file an intent before committing
    await expectOk(fileIntent(e, a, { ttl_s: 3000 }));
    e.clock.advance(20_000);
    const real = await submit(e, a, diff("par_real"));
    for (let i = 0; i < 12; i++) {
      e.clock.advance(5_000);
      e.core.tick();
    }
    const all = await expectOk<any[]>(e.admin.c.get(`/v1/candidates?lineage=${e.lineage}`, true));
    const canary = all.find((c) => c.candidate_id !== real.candidate_id);
    expect(canary).toBeDefined();
    const intents = await expectOk<any[]>(e.admin.c.get(`/v1/intents?lineage=${e.lineage}&status=all`, true));
    const shadowIntent = intents.find((i) => i.agent === canary.author);
    expect(shadowIntent).toBeDefined();
    expect(shadowIntent.target).toBe("ir");
    expect(shadowIntent.created_at).toBeLessThan(canary.committed_at);
    expect(shadowIntent.status).toBe("committed");
    expect(shadowIntent.candidate.commit_id).toBe(canary.commit_id);
    // the public cannot tell it from the real author's: same fields, same open status while the canary is open
    const pub = await expectOk<any[]>(e.anon.get(`/v1/intents?lineage=${e.lineage}&status=all`));
    const ps = pub.find((i) => i.intent_id === shadowIntent.intent_id);
    const pr = pub.find((i) => i.agent === a.id);
    expect(Object.keys(ps).sort()).toEqual(Object.keys(pr).sort());
    expect(ps.status).toBe("open");
    settleCanaries(e);
  });
});

async function commitTeam(e: Env, lead: Agent, members: TeamMember[], signers: Agent[], patch: string, o: { skipSig?: string; target?: string } = {}) {
  const salt = sha256Hex(Math.random().toString()).slice(0, 32);
  const commitment = patchCommitment(patchHash(canonicalizeDiff(patch)), salt);
  const parent = await tipOf(e);
  const target = o.target ?? "ir";
  const st = teamStatement({ lineage_id: e.lineage, parent_gen_id: parent, commitment, kind: "perf", target, members });
  const sigs: Record<string, string> = {};
  for (const a of signers) if (a.id !== o.skipSig) sigs[a.id] = signStatement(a.key, "team", st);
  const r = await lead.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: parent, kind: "perf", target, commitment, claimed_effect: 0.1, team: { members, sigs } });
  return { r, salt, patch };
}

async function revealTeam(lead: Agent, x: { r: any; salt: string; patch: string }) {
  return expectOk(lead.c.post(`/v1/candidates/${x.r.body.commit_id}/reveal`, { patch: x.patch, salt: x.salt }));
}

const authorUnits = (e: Env, gen: string) =>
  e.core
    .events(0, 10000)
    .filter((x) => x.type === "units.awarded" && (x.data as any).kind === "author" && (x.data as any).ref === gen)
    .map((x) => x.data as { agent: string; units: number });

describe("teams with declared shares (SPEC 12.2)", () => {
  test("every member signs; shares split the solo total exactly; members, operators and owners' agents never replay or audit it; the cap stops steering", async () => {
    const e = (env = await setup({ verifiers: 0, over: { audit_rate: 1, audit_replayers: 1, max_team_excluded_bond_bps: 4000, max_open_replays: 4 } }));
    const launcher = generateAgentKey().id;
    // the lead and another agent of the same launcher (an owner's other agent)
    const lead = agentClient(e);
    await expectOk(e.admin.c.post("/v1/admin/launches", { agent: lead.id, mint: generateAgentKey().id, launcher, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "app" }));
    await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: lead.id, amount: ((e.cfg.wake_threshold * 10_000n) / BigInt(e.cfg.agent_compute_bps) + 1n).toString() }));
    const reviewer = await makeVerifier(e, { operator: "op-review" });
    const sameOp = await makeVerifier(e, { operator: "op-review" });
    const ownerMate = await makeVerifier(e);
    e.core.db.query("UPDATE agents SET chain_owner = ? WHERE agent_id = ?").run(launcher, ownerMate.id);
    for (let i = 0; i < 4; i++) e.verifiers.push(await makeVerifier(e));
    e.verifiers.push(reviewer, sameOp, ownerMate);
    const members: TeamMember[] = [
      { agent: lead.id, role: "author", share_bps: 7000 },
      { agent: reviewer.id, role: "reviewer", share_bps: 3000 },
    ];
    // refusals: an unsigned member, a lead that is not an author, shares not summing to 10000
    const unsigned = await commitTeam(e, lead, members, [lead, reviewer], diff("t_unsigned"), { skipSig: reviewer.id });
    expect(unsigned.r.status).toBe(403);
    expect(unsigned.r.body.error).toBe("unsigned_member");
    expect((await commitTeam(e, lead, [{ ...members[0]!, role: "reviewer" }, members[1]!], [lead, reviewer], diff("t_role"))).r.status).toBe(400);
    expect((await commitTeam(e, lead, [members[0]!, { ...members[1]!, share_bps: 2000 }], [lead, reviewer], diff("t_sum"))).r.status).toBe(400);
    expect((await commitTeam(e, lead, [members[0]!, { agent: generateAgentKey().id, role: "reviewer", share_bps: 3000 }], [lead], diff("t_unknown"))).r.status).toBe(403);
    // steering: adding two more independent verifiers excludes 4 of 7 eligible bonds, over the 40% cap
    const steer: TeamMember[] = [members[0]!, { ...members[1]!, share_bps: 1000 }, { agent: e.verifiers[0]!.id, role: "reviewer", share_bps: 1000 }, { agent: e.verifiers[1]!.id, role: "reviewer", share_bps: 1000 }];
    steer[0] = { ...steer[0]!, share_bps: 7000 };
    const steered = await commitTeam(e, lead, steer, [lead, reviewer, e.verifiers[0]!, e.verifiers[1]!], diff("t_steer"));
    expect(steered.r.status).toBe(409);
    expect(steered.r.body.error).toBe("team_excludes_too_much");
    // the real team: reviewer plus its operator mate excluded = 2 of 7 eligible bonds, under the cap
    const x = await commitTeam(e, lead, members, [lead, reviewer], diff("t_team"));
    expect(x.r.status).toBe(200);
    const c = await revealTeam(lead, x);
    // author-blind: the public sees neither the author nor the team; a member sees both
    const pub = await candidate(e, c.candidate_id);
    expect(pub.author).toBeNull();
    expect(pub.team).toBeNull();
    const asMember = await expectOk(reviewer.c.get(`/v1/candidates/${c.candidate_id}`, true));
    expect(asMember.team.members.map((m: any) => m.agent)).toEqual([lead.id, reviewer.id]);
    expect(asMember.team.team_digest).toMatch(/^[0-9a-f]{64}$/);
    for (const m of asMember.team.members) expect(verifyStatement(m.agent, m.sig, "team", asMember.team.statement)).toBe(true);
    expect(await authorLeaks(e, [{ ids: [c.commit_id, c.candidate_id], parties: [lead.id, reviewer.id], sealed: [asMember.commitment] }])).toEqual([]);
    expect(await expectOk<any[]>(e.anon.get(`/v1/agents/${reviewer.id}/teams`))).toHaveLength(0);
    expect(await expectOk<any[]>(reviewer.c.get(`/v1/agents/${reviewer.id}/teams`, true))).toHaveLength(1);
    // replays and the audit never draw a member, a member's operator or the owner's other agent
    await runReplays(e, c.candidate_id, honest(result({}, 900)));
    const fin = await candidate(e, c.candidate_id);
    expect(fin.status).toBe("accepted");
    expect(fin.team.members).toHaveLength(2);
    const excluded = new Set([lead.id, reviewer.id, sameOp.id, ownerMate.id]);
    const drawn = fin.replays.map((r: any) => r.replayer);
    expect(drawn.length).toBeGreaterThanOrEqual(3); // two replays plus at least one auditor
    expect(drawn.filter((d: string) => excluded.has(d))).toEqual([]);
    const rounds = e.core.db.query<{ exclude: string }, [string]>("SELECT exclude FROM assignment_rounds WHERE subject = ?").all(c.candidate_id);
    expect(rounds.length).toBeGreaterThan(0);
    for (const r of rounds) {
      expect(JSON.parse(r.exclude).agents).toEqual(expect.arrayContaining([lead.id, reviewer.id, ownerMate.id]));
      expect(JSON.parse(r.exclude).operators).toContain("op-review");
    }
    // units: the same total a solo author gets for the same effect, split 70/30 exactly
    const teamUnits = authorUnits(e, fin.gen_id);
    const solo = await submit(e, lead, diff("t_solo", "src/solo.rs"));
    await runReplays(e, solo.candidate_id, honest(result({}, 900)));
    const soloFin = await candidate(e, solo.candidate_id);
    expect(soloFin.status).toBe("accepted");
    const soloUnits = authorUnits(e, soloFin.gen_id);
    expect(soloUnits).toHaveLength(1);
    const total = soloUnits[0]!.units;
    expect(teamUnits.map((u) => u.agent).sort()).toEqual([lead.id, reviewer.id].sort());
    const micro = (a: string) => Math.round(teamUnits.find((u) => u.agent === a)!.units * 1e6);
    expect(micro(lead.id) + micro(reviewer.id)).toBe(Math.round(total * 1e6));
    expect(micro(lead.id)).toBe(Math.round(total * 1e6 * 0.7));
    expect(new Set(fin.replays.map((r: any) => r.replayer)).size).toBe(fin.replays.length);
  }, 60_000);

  test("splitByBps is exact and drops zero shares", () => {
    const parts = splitByBps(1.0000005, [
      { agent: "a", share_bps: 3333 },
      { agent: "b", share_bps: 3333 },
      { agent: "c", share_bps: 3334 },
      { agent: "z", share_bps: 0 },
    ]);
    expect(parts.map((p) => p[0])).toEqual(["a", "b", "c"]);
    expect(parts.reduce((s, p) => s + Math.round(p[1] * 1e6), 0)).toBe(Math.round(1.0000005 * 1e6));
  });

  test("shadow parity: where real candidates are teams, canaries are committed by signed shadow teams", async () => {
    const e = (env = await setup({ verifiers: 6, over: { canary_rate: 1, max_open_replays: 4, max_team_excluded_bond_bps: 10000, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("st1", "src/st1.rs") }));
    const lead = await makeAuthor(e);
    const co = await makeAuthor(e);
    warmShadows(e);
    const x = await commitTeam(e, lead, [{ agent: lead.id, role: "author", share_bps: 6000 }, { agent: co.id, role: "author", share_bps: 4000 }], [lead, co], diff("st_real"));
    expect(x.r.status).toBe(200);
    const real = await revealTeam(lead, x);
    settleCanaries(e, 10);
    const all = await expectOk<any[]>(e.admin.c.get(`/v1/candidates?lineage=${e.lineage}`, true));
    const canary = all.find((c) => c.candidate_id !== real.candidate_id);
    expect(canary).toBeDefined();
    const v = await expectOk(e.admin.c.get(`/v1/candidates/${canary.candidate_id}`, true));
    expect(v.team).not.toBeNull();
    expect(v.team.members.map((m: any) => [m.role, m.share_bps])).toEqual([["author", 6000], ["author", 4000]]);
    expect(v.team.members[0].agent).toBe(v.author);
    for (const m of v.team.members) expect(verifyStatement(m.agent, m.sig, "team", v.team.statement)).toBe(true);
    // publicly the same shape as the real team candidate while open: no author, no team
    const pc = await candidate(e, canary.candidate_id);
    const pr = await candidate(e, real.candidate_id);
    expect([pc.author, pc.team, pr.author, pr.team]).toEqual([null, null, null, null]);
  });
});
