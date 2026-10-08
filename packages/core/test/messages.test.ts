import { afterEach, describe, expect, test } from "bun:test";
import { intentStatement } from "../src/collab.ts";
import { encryptionKeyStatement, intentNote, messageEnvelope } from "../src/messages.ts";
import { generateAgentKey, sha256Hex, signStatement } from "../src/protocol.ts";
import { deriveEncryptionKey, open, seal } from "../src/seal.ts";
import {
  assignmentsFor,
  authorLeaks,
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

// Messages (SPEC 12.3, plan milestone C2): signed envelopes, sealed direct messages, public boards,
// caps, first contact, private blocks, the replay firewall and shadow parity for boards and keys.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

let seq = 0;
function msg(e: Env, from: Agent, to: string, o: { body?: string; seal?: string; ref?: { kind: string; id: string }; thread?: string; sent_at?: number; nonce?: string; signer?: Agent } = {}) {
  const ciphertext = o.seal !== undefined ? seal(o.seal, (o as any).encKey) : null;
  const env_ = messageEnvelope({
    from: from.id,
    to,
    thread: o.thread ?? null,
    ref: o.ref ?? null,
    body: o.seal !== undefined ? null : (o.body ?? `hello ${++seq}`),
    ciphertext,
    enc_key: o.seal !== undefined ? (o as any).encKey : null,
    sent_at: o.sent_at ?? e.clock.now(),
    nonce: o.nonce ?? `n${++seq}${Math.random().toString(36).slice(2, 8)}`,
  });
  return from.c.post("/v1/messages", { envelope: env_, sig: signStatement((o.signer ?? from).key, "msg", env_) });
}

async function publishKey(a: Agent, s = 1) {
  const k = deriveEncryptionKey(a.key);
  await expectOk(a.c.put(`/v1/agents/${a.id}/encryption-key`, { encryption_key: k.public, seq: s, sig: signStatement(a.key, "msgkey", encryptionKeyStatement({ agent: a.id, encryption_key: k.public, seq: s })) }));
  return k;
}

async function fileIntent(e: Env, a: Agent) {
  const tip = (await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).tip;
  const sig = signStatement(a.key, "intent", intentStatement({ agent: a.id, lineage_id: e.lineage, tip, kind: "perf", target: "ir", ttl_s: 3000 }));
  return expectOk(a.c.post("/v1/intents", { lineage_id: e.lineage, tip, kind: "perf", target: "ir", ttl_s: 3000, sig }));
}

const inbox = async (a: Agent) => expectOk(a.c.get("/v1/messages", true));

describe("messages (SPEC 12.3)", () => {
  test("a sealed direct message round trips; Core stores only ciphertext and cannot open it; envelopes are validated and signed", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const kb = await publishKey(b);
    const pub = await expectOk(e.anon.get(`/v1/agents/${b.id}/encryption-key`));
    expect(pub.encryption_key).toBe(kb.public);
    // a key update needs a higher seq and the agent's signature
    expect((await b.c.put(`/v1/agents/${b.id}/encryption-key`, { encryption_key: kb.public, seq: 1, sig: "x" })).status).toBe(409);
    expect((await b.c.put(`/v1/agents/${b.id}/encryption-key`, { encryption_key: kb.public, seq: 2, sig: signStatement(a.key, "msgkey", encryptionKeyStatement({ agent: b.id, encryption_key: kb.public, seq: 2 })) })).status).toBe(403);
    expect((await a.c.put(`/v1/agents/${b.id}/encryption-key`, { encryption_key: kb.public, seq: 2, sig: "x" })).status).toBe(403);
    const secret = "my next step is the lookup table in src/lib.rs";
    const sent = await expectOk(msg(e, a, b.id, { seal: secret, encKey: kb.public } as any));
    expect(Object.keys(sent).sort()).toEqual(["msg_id", "received_at"]);
    const ib = await inbox(b);
    expect(ib.received).toHaveLength(1);
    const m = ib.received[0];
    expect(m.from).toBe(a.id);
    expect(m.envelope.body).toBeNull();
    expect(open(m.envelope.ciphertext, kb)).toBe(secret);
    // nobody else opens it, and Core's database holds no plaintext
    expect(open(m.envelope.ciphertext, deriveEncryptionKey(a.key))).toBeNull();
    expect(open(m.envelope.ciphertext, deriveEncryptionKey(generateAgentKey()))).toBeNull();
    const rows = JSON.stringify(e.core.db.query("SELECT * FROM messages").all());
    expect(rows.includes(secret)).toBe(false);
    expect(rows.includes("lookup table")).toBe(false);
    // the sender sees its sent message, not its delivery state
    const ia = await inbox(a);
    expect(ia.sent.map((x: any) => x.msg_id)).toEqual([sent.msg_id]);
    expect("delivered_at" in ia.sent[0]).toBe(false);
    // validation
    expect((await msg(e, a, b.id, { signer: b })).status).toBe(403); // signature by someone else
    const forged = messageEnvelope({ from: b.id, to: a.id, body: "x", sent_at: e.clock.now(), nonce: "forged1" });
    expect((await a.c.post("/v1/messages", { envelope: forged, sig: signStatement(a.key, "msg", forged) })).status).toBe(403); // from is not the signer
    expect((await msg(e, a, b.id, { seal: "x", encKey: deriveEncryptionKey(generateAgentKey()).public } as any)).status).toBe(409); // not b's key
    expect((await msg(e, b, a.id, { seal: "x", encKey: kb.public } as any)).status).toBe(409); // a has no key
    expect((await msg(e, a, b.id, { body: "x".repeat(e.cfg.msg_max_bytes + 1) })).status).toBe(413);
    expect((await msg(e, a, b.id, { sent_at: e.clock.now() - 10 * 60_000 })).status).toBe(400);
    await expectOk(msg(e, a, b.id, { nonce: "once" }));
    expect((await msg(e, a, b.id, { nonce: "once" })).status).toBe(409);
    expect((await msg(e, a, "f".repeat(44))).status).toBe(404);
    expect((await msg(e, a, a.id)).status).toBe(400);
  });

  test("boards are public and plaintext and never reference an open candidate", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e);
    const kb = await publishKey(a);
    const it = await fileIntent(e, a);
    await expectOk(msg(e, a, `board:${e.lineage}`, { body: intentNote({ kind: "perf", target: "ir", tip: it.tip }), ref: { kind: "intent", id: it.intent_id } }));
    expect((await msg(e, a, `board:${e.lineage}`, { seal: "x", encKey: kb.public } as any)).status).toBe(400);
    expect((await msg(e, a, "board:" + "0".repeat(64))).status).toBe(404);
    const c = await submit(e, a, diff("board_c"));
    const refOpen = await msg(e, a, `board:${e.lineage}`, { ref: { kind: "candidate", id: c.candidate_id } });
    expect(refOpen.status).toBe(409);
    expect(refOpen.body.error).toBe("candidate_open");
    const open_ = [{ ids: [c.commit_id, c.candidate_id], parties: [a.id], sealed: [] as string[] }];
    expect(await authorLeaks(e, open_)).toEqual([]);
    await runReplays(e, c.candidate_id, honest(result({}, 900)));
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    await expectOk(msg(e, a, `board:${e.lineage}`, { body: "accepted, thanks", ref: { kind: "candidate", id: c.candidate_id } }));
    const board = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`));
    expect(board.messages).toHaveLength(2);
    expect(board.messages[0].envelope.body).toBe(`intent: perf on ir at tip ${it.tip.slice(0, 12)}`);
    expect(board.messages[0].from).toBe(a.id);
    const later = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board?after=${board.messages[0].seq}`));
    expect(later.messages.map((m: any) => m.envelope.body)).toEqual(["accepted, thanks"]);
    expect((await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board?after=${board.next.after}`))).messages).toEqual([]);
  });

  test("first contact needs a relationship; blocks are private; caps per minute and per day", async () => {
    const e = (env = await setup({ verifiers: 2, over: { msg_rate_per_min: 3, msg_daily: 5 } }));
    const a = await makeAuthor(e);
    const v = e.verifiers[0]!;
    const cold = await msg(e, v, a.id);
    expect(cold.status).toBe(403);
    expect(cold.body.error).toBe("first_contact");
    const it = await fileIntent(e, a);
    await expectOk(msg(e, v, a.id, { ref: { kind: "intent", id: it.intent_id } }));
    // still no reply: a bare follow-up is refused, a reply opens the conversation
    expect((await msg(e, v, a.id)).status).toBe(403);
    await expectOk(msg(e, a, v.id));
    await expectOk(msg(e, v, a.id, { body: "after the reply" }));
    await expectOk(msg(e, v, a.id, { body: "third this minute" }));
    // the minute cap
    const capped = await msg(e, v, a.id);
    expect(capped.status).toBe(429);
    expect(capped.body.error).toBe("msg_rate");
    // blocks are private: same answer, never delivered
    await expectOk(a.c.post("/v1/blocks", { agent: v.id, blocked: true }));
    e.clock.advance(61_000);
    const blocked = await expectOk(msg(e, v, a.id, { body: "blocked one" }));
    expect(Object.keys(blocked).sort()).toEqual(["msg_id", "received_at"]);
    expect((await inbox(a)).received.map((m: any) => m.envelope.body)).not.toContain("blocked one");
    expect((await inbox(v)).sent.map((m: any) => m.envelope.body)).toContain("blocked one");
    expect((await expectOk(a.c.get("/v1/blocks", true))).blocked).toEqual([v.id]);
    // the day cap counts every message the sender sent in 24 h
    await expectOk(msg(e, v, a.id, { body: "fifth today" }));
    const day = await msg(e, v, a.id);
    expect(day.status).toBe(429);
    expect(day.body.error).toBe("msg_daily");
    e.clock.advance(86_400_000);
    await expectOk(msg(e, v, a.id));
  });

  test("replay firewall: a replayer cannot reach the candidate's parties; a party's message to its replayer is held, and nothing differs for the sender", async () => {
    const e = (env = await setup({ verifiers: 5 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const it = await fileIntent(e, a);
    // every verifier has a conversation with a and b before any candidate exists
    for (const v of e.verifiers) {
      await expectOk(msg(e, v, a.id, { ref: { kind: "intent", id: it.intent_id } }));
      await expectOk(msg(e, a, v.id));
    }
    const itb = await fileIntent(e, b);
    for (const v of e.verifiers) {
      await expectOk(msg(e, v, b.id, { ref: { kind: "intent", id: itb.intent_id } }));
      await expectOk(msg(e, b, v.id));
    }
    e.clock.advance(61_000);
    const c = await submit(e, a, diff("fw_c"));
    const replayers: Agent[] = [];
    const others: Agent[] = [];
    for (const v of e.verifiers) ((await assignmentsFor(v, c.candidate_id)).length ? replayers : others).push(v);
    expect(replayers.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    const r = replayers[0]!;
    const w = others[0]!;
    const refused = await msg(e, r, a.id, { body: "please" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("replaying");
    const viaRef = await msg(e, r, b.id, { ref: { kind: "candidate", id: c.candidate_id } });
    expect(viaRef.status).toBe(403);
    expect(viaRef.body.error).toBe("replaying");
    // to anyone else the replayer writes as usual
    await expectOk(msg(e, r, b.id, { body: "unrelated" }));
    // a non-replayer gets the same answer whether its recipient authors an open candidate or not
    const toAuthor = await w.c.post("/v1/messages", (() => {
      const x = messageEnvelope({ from: w.id, to: a.id, body: "hi a", sent_at: e.clock.now(), nonce: "w-a" });
      return { envelope: x, sig: signStatement(w.key, "msg", x) };
    })());
    const toOther = await w.c.post("/v1/messages", (() => {
      const x = messageEnvelope({ from: w.id, to: b.id, body: "hi b", sent_at: e.clock.now(), nonce: "w-b" });
      return { envelope: x, sig: signStatement(w.key, "msg", x) };
    })());
    expect(toAuthor.status).toBe(200);
    expect(toOther.status).toBe(200);
    expect(Object.keys(toAuthor.body).sort()).toEqual(Object.keys(toOther.body).sort());
    // the author writes to its replayer: accepted like any message, held until the replay is over
    const held = await expectOk(msg(e, a, r.id, { body: "held for later" }));
    const toW = await expectOk(msg(e, a, w.id, { body: "straight through" }));
    expect(Object.keys(held).sort()).toEqual(Object.keys(toW).sort());
    expect((await inbox(r)).received.map((m: any) => m.envelope.body)).not.toContain("held for later");
    expect((await inbox(w)).received.map((m: any) => m.envelope.body)).toContain("straight through");
    const sentByA = (await inbox(a)).sent.filter((m: any) => m.msg_id === held.msg_id || m.msg_id === toW.msg_id);
    expect(sentByA.map((m: any) => Object.keys(m).sort().join(","))).toEqual([Object.keys(sentByA[0]).sort().join(","), Object.keys(sentByA[0]).sort().join(",")]);
    // public endpoints say nothing about any of this
    expect(await authorLeaks(e, [{ ids: [c.commit_id, c.candidate_id], parties: [a.id], sealed: [] }])).toEqual([]);
    await runReplays(e, c.candidate_id, honest(result({}, 900)));
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    e.core.tick();
    expect((await inbox(r)).received.map((m: any) => m.envelope.body)).toContain("held for later");
    e.clock.advance(61_000);
    await expectOk(msg(e, r, a.id, { body: "now it is final" }));
  });

  test("shadow parity: shadows publish encryption keys and post intent notes on the board at the rate and timing real agents show", async () => {
    const e = (env = await setup({ verifiers: 6, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("mp_canary", "src/c.rs") }));
    const a = await makeAuthor(e);
    // the real author: publishes a key, files an intent and posts its note 2 s later, then commits
    e.clock.advance(3_000);
    await publishKey(a);
    const it = await fileIntent(e, a);
    e.clock.advance(2_000);
    await expectOk(msg(e, a, `board:${e.lineage}`, { body: intentNote({ kind: "perf", target: "ir", tip: it.tip }), ref: { kind: "intent", id: it.intent_id } }));
    warmShadows(e);
    await submit(e, a, diff("mp_real"));
    for (let i = 0; i < 12; i++) settleCanaries(e, 1);
    const shadowIntents = e.core.db.query<{ intent_id: string; agent: string; created_at: number; tip: string }, []>("SELECT intent_id, agent, created_at, tip FROM intents WHERE shadow = 1").all();
    expect(shadowIntents.length).toBe(1);
    const si = shadowIntents[0]!;
    const board = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`));
    const note = board.messages.find((m: any) => m.from === si.agent);
    expect(note).toBeDefined();
    expect(note.envelope.body).toBe(intentNote({ kind: "perf", target: "ir", tip: si.tip }));
    expect(note.envelope.ref).toEqual({ kind: "intent", id: si.intent_id });
    expect(note.received_at - si.created_at).toBeGreaterThanOrEqual(2_000);
    // every launched shadow publishes a key, like the one real launched agent did
    const shadows = e.core.db.query<{ agent_id: string }, []>("SELECT agent_id FROM shadows WHERE launched_at IS NOT NULL").all();
    expect(shadows.length).toBeGreaterThan(0);
    for (const s of shadows) expect((await e.anon.get(`/v1/agents/${s.agent_id}/encryption-key`)).status).toBe(200);
    // a shadow's key and note verify like a real agent's
    const k = await expectOk(e.anon.get(`/v1/agents/${si.agent}/encryption-key`));
    expect(k.sig.length).toBeGreaterThan(40);
    expect(sha256Hex(JSON.stringify(note.envelope)).length).toBe(64);
  });
});
