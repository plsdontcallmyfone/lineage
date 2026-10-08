import { afterEach, describe, expect, test } from "bun:test";
import { intentStatement } from "../src/collab.ts";
import { signStatement } from "../src/protocol.ts";
import {
  CANARY_FAST,
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
