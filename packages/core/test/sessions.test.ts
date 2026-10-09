import { afterEach, describe, expect, test } from "bun:test";
import { authorLeaks, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Authoring sessions (SPEC 17.3): the gate. Navigation and run phases are public in real time; edit
// contents, evaluation output, notes and the submit are served to nobody but the agent and the admin
// until the attempt's candidate is final, or the attempt ended without one.

const SECRET_BEFORE = "SECRET_BEFORE_slow_path_xyz";
const SECRET_AFTER = "SECRET_AFTER_fast_path_xyz";
const SECRET_OUT = "SECRET_OUTPUT_ratio_0_8123";
const SECRET_NOTE = "SECRET_NOTE_i_will_unroll";

let env: Env;
afterEach(() => env?.close());

async function start(e: Env, author: Agent) {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(author.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  await expectOk(
    author.c.post(`/v1/sessions/${s.session_id}/events`, {
      events: [
        { kind: "list", path: ".", count: 3 },
        { kind: "read", path: "src/lib.rs", start_line: 1, end_line: 3 },
        { kind: "search", query: "slow_", matches: 2 },
        { kind: "note", text: SECRET_NOTE },
        { kind: "edit", path: "src/lib.rs", start_line: 2, end_line: 2, before: SECRET_BEFORE, after: SECRET_AFTER },
        { kind: "evaluate", target: "ir", eval_kind: "perf" },
        { kind: "phase", phase: "build" },
        { kind: "phase", phase: "metrics" },
        { kind: "result", outcome: "accepted", output: SECRET_OUT, steps: [{ step: "build", side: "cand", exit: 0, duration_ms: 1200, timed_out: false, tail: SECRET_OUT }] },
        { kind: "submit" },
      ],
    }),
  );
  return s.session_id as string;
}

/** Every public place a sealed string could appear: the session reads and the whole event log. */
async function publicText(e: Env, id: string, agent: string): Promise<string> {
  const parts = await Promise.all([
    e.anon.get(`/v1/sessions/${id}`),
    e.anon.get(`/v1/sessions?lineage=${e.lineage}`),
    e.anon.get(`/v1/sessions?agent=${agent}`),
    e.anon.get(`/v1/sessions`),
    e.anon.get(`/v1/events/log?since=0&limit=5000`),
  ]);
  return parts.map((p) => JSON.stringify(p.body)).join("\n");
}

const SECRETS = [SECRET_BEFORE, SECRET_AFTER, SECRET_OUT, SECRET_NOTE];

describe("sessions (SPEC 17.3)", () => {
  test("edit contents are never served before the candidate is final; navigation is public live", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const id = await start(e, author);

    // live: navigation, ranges and phases public, agent named, contents withheld, submit hidden
    let v = await expectOk(e.anon.get(`/v1/sessions/${id}`));
    expect(v.state).toBe("live");
    expect(v.agent).toBe(author.id);
    expect(v.event_list.map((x: any) => x.kind)).toEqual(["list", "read", "search", "note", "edit", "evaluate", "phase", "phase", "result"]);
    const edit = v.event_list.find((x: any) => x.kind === "edit");
    expect(edit).toMatchObject({ path: "src/lib.rs", start_line: 2, end_line: 2, sealed: true });
    expect(edit.before).toBeUndefined();
    expect(edit.after).toBeUndefined();
    for (const s of SECRETS) expect(await publicText(e, id, author.id)).not.toContain(s);

    // the agent itself sees everything
    const own = await expectOk(author.c.get(`/v1/sessions/${id}`, true));
    expect(own.event_list.find((x: any) => x.kind === "edit").after).toBe(SECRET_AFTER);
    expect(own.event_list.some((x: any) => x.kind === "submit")).toBe(true);

    // committed and revealed, still open: sealed, no agent, no candidate, not listed by agent
    const cand = await submit(e, author, diff("sess"));
    await expectOk(author.c.post(`/v1/sessions/${id}/end`, { commit_id: cand.commit_id }));
    v = await expectOk(e.anon.get(`/v1/sessions/${id}`));
    expect(v.state).toBe("sealed");
    expect(v.agent).toBeNull();
    expect(v.candidate).toBeNull();
    expect(v.event_list.find((x: any) => x.kind === "edit").sealed).toBe(true);
    expect(await expectOk<any[]>(e.anon.get(`/v1/sessions?agent=${author.id}`))).toHaveLength(0);
    for (const s of SECRETS) expect(await publicText(e, id, author.id)).not.toContain(s);
    // and no public object names the open candidate together with its author (SPEC 10.7)
    const all = await expectOk<any[]>(e.admin.c.get(`/v1/candidates?lineage=${e.lineage}`, true));
    const leaks = await authorLeaks(e, all.map((c) => ({ ids: [c.commit_id, c.candidate_id], parties: [c.author], sealed: [c.commitment] })));
    expect(leaks).toEqual([]);

    // final: everything is public, the event log still holds no sealed content
    await runReplays(e, cand.candidate_id, honest(result({}, 900)));
    v = await expectOk(e.anon.get(`/v1/sessions/${id}`));
    expect(v.state).toBe("final");
    expect(v.agent).toBe(author.id);
    expect(v.candidate.status).toBe("accepted");
    expect(v.candidate.commit_id).toBe(cand.commit_id);
    const opened = v.event_list.find((x: any) => x.kind === "edit");
    expect(opened.before).toBe(SECRET_BEFORE);
    expect(opened.after).toBe(SECRET_AFTER);
    expect(opened.sealed).toBeUndefined();
    expect(v.event_list.find((x: any) => x.kind === "result").steps[0].tail).toBe(SECRET_OUT);
    expect(v.event_list.some((x: any) => x.kind === "submit")).toBe(true);
    const log = JSON.stringify((await e.anon.get(`/v1/events/log?since=0&limit=5000`)).body);
    for (const s of SECRETS) expect(log).not.toContain(s);
  });

  test("a worker cannot open the gate early by claiming it committed nothing", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const id = await start(e, author);
    await submit(e, author, diff("liar"));
    await expectOk(author.c.post(`/v1/sessions/${id}/end`, {}));
    const v = await expectOk(e.anon.get(`/v1/sessions/${id}`));
    expect(v.state).toBe("sealed");
    for (const s of SECRETS) expect(await publicText(e, id, author.id)).not.toContain(s);
  });

  test("an attempt that ends without a candidate publishes its edits when it ends", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const id = await start(e, author);
    expect((await expectOk(e.anon.get(`/v1/sessions/${id}`))).event_list.find((x: any) => x.kind === "edit").after).toBeUndefined();
    await expectOk(author.c.post(`/v1/sessions/${id}/events`, { events: [{ kind: "give_up", reason: "no gain" }] }));
    await expectOk(author.c.post(`/v1/sessions/${id}/end`, {}));
    const v = await expectOk(e.anon.get(`/v1/sessions/${id}`));
    expect(v.state).toBe("ended");
    expect(v.agent).toBe(author.id);
    expect(v.event_list.find((x: any) => x.kind === "edit").after).toBe(SECRET_AFTER);
    expect(v.event_list.find((x: any) => x.kind === "give_up").reason).toBe("no gain");
    // the stream never carried it
    const log = JSON.stringify((await e.anon.get(`/v1/events/log?since=0&limit=5000`)).body);
    expect(log).not.toContain(SECRET_AFTER);
    // and a session that ended takes no more events
    expect((await author.c.post(`/v1/sessions/${id}/events`, { events: [{ kind: "list", path: "." }] })).status).toBe(409);
  });

  test("only the agent writes its session; bad events are refused whole", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const other = await makeAuthor(e);
    const id = await start(e, author);
    expect((await other.c.post(`/v1/sessions/${id}/events`, { events: [{ kind: "list", path: "." }] })).status).toBe(403);
    expect((await e.verifiers[0]!.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: "0".repeat(64), commit: "0".repeat(40), proposer: "x" })).status).toBe(403);
    const bad = [
      { kind: "read", path: "../etc/passwd", start_line: 1, end_line: 1 },
      { kind: "edit", path: "src/lib.rs" },
      { kind: "read", path: "src/lib.rs", before: "x" },
      { kind: "read", path: "src/lib.rs", text_leak: "x" },
      { kind: "phase", phase: "commit" },
    ];
    for (const ev of bad) expect((await author.c.post(`/v1/sessions/${id}/events`, { events: [{ kind: "list", path: "." }, ev] })).status).toBe(400);
    expect((await expectOk(author.c.get(`/v1/sessions/${id}`, true))).events).toBe(10);
  });
});
