import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { diff, expectOk, makeAuthor, setup, submit, type Agent, type Env } from "./helpers.ts";

// Agent desktops (SPEC 17.7): a session may say it ran on a desktop; its unredacted recording is
// linked only once the session's gate is open for everyone, and only to an MP4 in the blob store.

let env: Env;
afterEach(() => env?.close());

const mp4 = (tag: string) => {
  const b = new Uint8Array(64);
  b.set([0, 0, 0, 24], 0);
  b.set(new TextEncoder().encode("ftypisom"), 4);
  b.set(new TextEncoder().encode(tag), 24);
  return b;
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function open(e: Env, a: Agent, desktop: boolean) {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic", desktop }));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/events`, { events: [{ kind: "edit", path: "src/lib.rs", start_line: 2, end_line: 2, before: "a", after: "b" }] }));
  return s.session_id as string;
}

describe("desktop recordings (SPEC 17.7)", () => {
  test("refused while live or sealed, accepted once the gate opens, MP4 only, set once", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const id = await open(e, author, true);
    let v = await expectOk(e.anon.get(`/v1/sessions/${id}`));
    expect(v.desktop).toBe(true);
    expect(v.recording).toBeNull();

    const rec = mp4("one");
    await expectOk(author.c.putBlob(sha(rec), rec));
    // live
    let r = await author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(rec), bytes: rec.length });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("sealed");
    // sealed: a committed, not final candidate; the agent's own full view does not open it
    await submit(e, author, diff("desk"));
    await expectOk(author.c.post(`/v1/sessions/${id}/end`, {}));
    expect((await expectOk(e.anon.get(`/v1/sessions/${id}`))).state).toBe("sealed");
    r = await author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(rec), bytes: rec.length });
    expect(r.status).toBe(409);
    expect((await expectOk(author.c.get(`/v1/sessions/${id}`, true))).recording).toBeNull();
  });

  test("an attempt that ended without a candidate links its recording", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const other = await makeAuthor(e);
    const id = await open(e, author, true);
    await expectOk(author.c.post(`/v1/sessions/${id}/end`, {}));
    const notMp4 = new TextEncoder().encode("this is not a video file at all, just text");
    await expectOk(author.c.putBlob(sha(notMp4), notMp4));
    expect((await author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(notMp4), bytes: notMp4.length })).body.error).toBe("bad_recording");
    const rec = mp4("two");
    expect((await author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(rec), bytes: rec.length })).body.error).toBe("missing_blob");
    await expectOk(author.c.putBlob(sha(rec), rec));
    expect((await other.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(rec), bytes: rec.length })).status).toBe(403);
    expect((await author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(rec), bytes: rec.length + 1 })).body.error).toBe("bad_recording");
    await expectOk(author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(rec), bytes: rec.length }));
    const v = await expectOk(e.anon.get(`/v1/sessions/${id}`));
    expect(v.recording).toEqual({ sha256: sha(rec), bytes: rec.length, url: `/v1/blobs/${sha(rec)}` });
    // set once
    const again = mp4("three");
    await expectOk(author.c.putBlob(sha(again), again));
    expect((await author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(again), bytes: again.length })).status).toBe(409);
    await expectOk(author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(rec), bytes: rec.length }));
  });

  test("a session without a desktop takes no recording; desktop must be a boolean", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const id = await open(e, author, false);
    await expectOk(author.c.post(`/v1/sessions/${id}/end`, {}));
    expect((await expectOk(e.anon.get(`/v1/sessions/${id}`))).desktop).toBe(false);
    const rec = mp4("x");
    await expectOk(author.c.putBlob(sha(rec), rec));
    expect((await author.c.post(`/v1/sessions/${id}/recording`, { sha256: sha(rec), bytes: rec.length })).body.error).toBe("no_desktop");
    const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    expect((await author.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "x", desktop: "yes" })).status).toBe(400);
  });
});
