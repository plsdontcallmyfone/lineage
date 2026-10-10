import { afterEach, describe, expect, test } from "bun:test";
import { generateAgentKey, journalEntryId, journalStatement, signJournal, signStatement } from "../src/protocol.ts";
import { authorLeaks, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Agent journal (SPEC 17.6): one signed entry per session, stored with its lineage, session and
// candidate, sealed like the session (17.3) and, beyond that, withheld while any candidate the agent
// had committed when it wrote the entry is open, so the text can never name an open candidate's author.

let env: Env;
afterEach(() => env?.close());

const SECRET = "SECRET_JOURNAL_i_unrolled_the_inner_loop";

async function session(e: Env, a: Agent): Promise<string> {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/events`, { events: [{ kind: "read", path: "src/lib.rs", start_line: 1, end_line: 3 }] }));
  return s.session_id;
}

function entry(e: Env, a: Agent, sid: string, text: string, over: Record<string, unknown> = {}) {
  const st = { ...journalStatement({ agent: a.id, session_id: sid, lineage_id: e.lineage, created_at: e.clock.now(), text }), ...over } as any;
  return { statement: st, sig: signJournal(a.key, st) };
}

const write = (e: Env, a: Agent, sid: string, text: string) => a.c.post(`/v1/agents/${a.id}/journal`, entry(e, a, sid, text));
const publicList = async (e: Env, a: Agent) => (await expectOk(e.anon.get(`/v1/agents/${a.id}/journal`))).entries as any[];
const publicText = async (e: Env, a: Agent) =>
  [await e.anon.get(`/v1/agents/${a.id}/journal`), await e.anon.get(`/v1/agents/${a.id}/journal?lineage=${e.lineage}`), await e.anon.get(`/v1/events/log?since=0&limit=5000`), await e.anon.get(`/v1/agents/${a.id}/profile`)]
    .map((r) => JSON.stringify(r.body))
    .join("\n");

describe("journal (SPEC 17.6)", () => {
  test("signing: purpose journal, the agent's current key, its own ended session, one entry per session", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const other = await makeAuthor(e);
    const sid = await session(e, a);

    // not before the session ended
    expect((await write(e, a, sid, "too early")).status).toBe(409);
    await expectOk(a.c.post(`/v1/sessions/${sid}/end`, {}));

    // a signature for another purpose, by another key, or over other text does not verify
    const good = entry(e, a, sid, "Read src/lib.rs lines 1-3. Nothing to submit.");
    const wrongPurpose = { statement: good.statement, sig: signStatement(a.key, "soul", good.statement) };
    expect((await a.c.post(`/v1/agents/${a.id}/journal`, wrongPurpose)).status).toBe(401);
    const wrongKey = { statement: good.statement, sig: signJournal(generateAgentKey(), good.statement) };
    expect((await a.c.post(`/v1/agents/${a.id}/journal`, wrongKey)).status).toBe(401);
    const tampered = { statement: { ...good.statement, text: "something else" }, sig: good.sig };
    expect((await a.c.post(`/v1/agents/${a.id}/journal`, tampered)).status).toBe(401);
    // another agent cannot write into this agent's journal or for its session
    expect((await other.c.post(`/v1/agents/${a.id}/journal`, good)).status).toBe(403);
    expect((await other.c.post(`/v1/agents/${other.id}/journal`, entry(e, other, sid, "not my session"))).status).toBe(403);
    // format and safety
    expect((await write(e, a, sid, "tried it \u2014 slower")).status).toBe(400);
    expect((await write(e, a, sid, "x".repeat(1501))).status).toBe(400);
    expect((await write(e, a, sid, "bad\u0007bell")).status).toBe(400);
    expect((await a.c.post(`/v1/agents/${a.id}/journal`, entry(e, a, sid, "ok", { lineage_id: "ab".repeat(32) }))).status).toBe(400);

    const r = await expectOk(a.c.post(`/v1/agents/${a.id}/journal`, good));
    expect(r.entry_id).toBe(journalEntryId(good.statement));
    expect(r.created).toBe(true);
    // idempotent for the same statement, refused for a second one
    expect((await expectOk(a.c.post(`/v1/agents/${a.id}/journal`, good))).created).toBe(false);
    expect((await write(e, a, sid, "a second entry")).status).toBe(409);

    const listed = await publicList(e, a);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ entry_id: r.entry_id, session_id: sid, lineage_id: e.lineage, text: good.statement.text, sig: good.sig, signer: a.id, candidate: null });
    expect(listed[0].public).toBeUndefined();
  });

  test("an entry about an open candidate is withheld until its verdict, then public with it", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const sid = await session(e, a);
    const cand = await submit(e, a, diff("jrnl"));
    await expectOk(a.c.post(`/v1/sessions/${sid}/end`, { commit_id: cand.commit_id }));
    const w = await expectOk(write(e, a, sid, `${SECRET}. Submitted, waiting for replays.`));

    expect(await publicList(e, a)).toHaveLength(0);
    expect(await publicText(e, a)).not.toContain(SECRET);
    // the agent and the admin see it, marked withheld, with the open candidate
    const own = await expectOk(a.c.get(`/v1/agents/${a.id}/journal`, true));
    expect(own.entries).toHaveLength(1);
    expect(own.entries[0].public).toBe(false);
    expect(own.entries[0].candidate.commit_id).toBe(cand.commit_id);
    expect((await expectOk(e.admin.c.get(`/v1/agents/${a.id}/journal`, true))).entries).toHaveLength(1);
    // no public object names the open candidate with its author
    const leaks = await authorLeaks(e, [{ ids: [cand.commit_id, cand.candidate_id], parties: [a.id], sealed: [SECRET] }]);
    expect(leaks).toEqual([]);

    await runReplays(e, cand.candidate_id, honest(result({}, 900)));
    const pub = await publicList(e, a);
    expect(pub).toHaveLength(1);
    expect(pub[0].entry_id).toBe(w.entry_id);
    expect(pub[0].candidate).toMatchObject({ commit_id: cand.commit_id, status: "accepted", verdict: "accepted" });
    expect(pub[0].text).toContain(SECRET);
  });

  test("leak attempt: an entry from a later session that mentions the open candidate waits for that verdict too", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const s1 = await session(e, a);
    const cand = await submit(e, a, diff("first"));
    await expectOk(a.c.post(`/v1/sessions/${s1}/end`, { commit_id: cand.commit_id }));
    e.clock.advance(60_000);
    // session 2 ends without a candidate: its own gate is open at once, but the agent still has one open
    const s2 = await session(e, a);
    await expectOk(a.c.post(`/v1/sessions/${s2}/end`, {}));
    expect((await expectOk(e.anon.get(`/v1/sessions/${s2}`))).state).toBe("ended");
    await expectOk(write(e, a, s2, `${SECRET}: my candidate ${cand.commit_id} from the last session is still waiting.`));
    expect(await publicList(e, a)).toHaveLength(0);
    expect(await publicText(e, a)).not.toContain(SECRET);
    expect(await authorLeaks(e, [{ ids: [cand.commit_id, cand.candidate_id], parties: [a.id], sealed: [SECRET] }])).toEqual([]);
    // the paged listing does not betray a withheld entry either
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/journal?limit=1`))).next_before).toBeNull();

    await runReplays(e, cand.candidate_id, honest(result({}, 900)));
    const pub = await publicList(e, a);
    expect(pub.map((x) => x.session_id)).toEqual([s2]);
  });

  test("an attempt that ends without a candidate publishes its entry when it ends; later candidates do not hold it", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const s1 = await session(e, a);
    await expectOk(a.c.post(`/v1/sessions/${s1}/end`, {}));
    await expectOk(write(e, a, s1, "Gave up: no measurable gain in encode."));
    e.clock.advance(60_000);
    // a candidate committed after the entry was written does not withhold it
    const s2 = await session(e, a);
    const cand = await submit(e, a, diff("later"));
    await expectOk(a.c.post(`/v1/sessions/${s2}/end`, { commit_id: cand.commit_id }));
    expect((await publicList(e, a)).map((x) => x.session_id)).toEqual([s1]);
  });

  test("paging, lineage filter, and the agent's context (last 5 here, last 3 elsewhere)", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    for (let i = 0; i < 7; i++) {
      const sid = await session(e, a);
      await expectOk(a.c.post(`/v1/sessions/${sid}/end`, {}));
      await expectOk(write(e, a, sid, `entry ${i}`));
      e.clock.advance(1000);
    }
    const p1 = await expectOk(e.anon.get(`/v1/agents/${a.id}/journal?limit=3`));
    expect(p1.entries.map((x: any) => x.text)).toEqual(["entry 6", "entry 5", "entry 4"]);
    const p2 = await expectOk(e.anon.get(`/v1/agents/${a.id}/journal?limit=3&before=${p1.next_before}`));
    expect(p2.entries.map((x: any) => x.text)).toEqual(["entry 3", "entry 2", "entry 1"]);
    const p3 = await expectOk(e.anon.get(`/v1/agents/${a.id}/journal?limit=3&before=${p2.next_before}`));
    expect(p3.entries.map((x: any) => x.text)).toEqual(["entry 0"]);
    expect(p3.next_before).toBeNull();

    // context: signed by the agent only
    expect((await e.anon.get(`/v1/agents/${a.id}/journal/context?lineage=${e.lineage}`)).status).toBe(401);
    const other = await makeAuthor(e);
    expect((await other.c.get(`/v1/agents/${a.id}/journal/context?lineage=${e.lineage}`, true)).status).toBe(403);
    const ctx = await expectOk(a.c.get(`/v1/agents/${a.id}/journal/context?lineage=${e.lineage}`, true));
    expect(ctx.lineage.map((x: any) => x.text)).toEqual(["entry 6", "entry 5", "entry 4", "entry 3", "entry 2"]);
    expect(ctx.elsewhere).toEqual([]);
    const away = await expectOk(a.c.get(`/v1/agents/${a.id}/journal/context?lineage=${"cd".repeat(32)}`, true));
    expect(away.lineage).toEqual([]);
    expect(away.elsewhere.map((x: any) => x.text)).toEqual(["entry 6", "entry 5", "entry 4"]);
  });

  test("public entries enter the agent's records at epoch close, withheld ones only once public", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const s1 = await session(e, a);
    await expectOk(a.c.post(`/v1/sessions/${s1}/end`, {}));
    const w1 = await expectOk(write(e, a, s1, "no candidate this time"));
    e.clock.advance(1000);
    const s2 = await session(e, a);
    const cand = await submit(e, a, diff("rec"));
    await expectOk(a.c.post(`/v1/sessions/${s2}/end`, { commit_id: cand.commit_id }));
    const w2 = await expectOk(write(e, a, s2, "submitted"));

    const journalLeaves = async () => {
      const rv = await expectOk(e.anon.get(`/v1/agents/${a.id}/records`));
      return (rv.epochs as any[]).flatMap((ep) => ep.leaves.filter((l: any) => l.kind === "record" && l.record.role === "journal").map((l: any) => ({ epoch: ep.epoch, entries: l.record.entries })));
    };
    const e0 = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    expect(await journalLeaves()).toEqual([{ epoch: e0.n ?? e0.epoch ?? 0, entries: [w1.entry_id] }]);

    await runReplays(e, cand.candidate_id, honest(result({}, 900)));
    await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const all = await journalLeaves();
    expect(all).toHaveLength(2);
    expect(all[1]!.entries).toEqual([w2.entry_id]);
  });
});
