import { afterEach, describe, expect, test } from "bun:test";
import type { ChainMsgEvent } from "@lineage/chain";
import { messageEnvelope } from "../src/messages.ts";
import { msgchainOf } from "../src/msgchain.ts";
import { generateAgentKey, H, sha256Hex, signStatement } from "../src/protocol.ts";
import { deriveEncryptionKey, open, seal } from "../src/seal.ts";
import { assignmentsFor, candidate, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Onchain messages (SPEC 12.5): Core indexes lineage_msg events into the C2 views, preflights hosted
// posts with every C2 rule plus the chain-only rules, and refuses the offchain writes in chain mode.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

let sigN = 0;
const base = () => ({ signature: `sig${++sigN}`, slot: 100 + sigN, blockTime: 1_900_000_000, ixIndex: 0, feePayer: generateAgentKey().id, fee: 10_000 });
const keyEv = (agent: string, encKey: string, keySeq = 1): ChainMsgEvent => ({ type: "enc_key", agent, signer: agent, encKey, keySeq, at: 1_900_000_000, ...base() });
const boardEv = (agent: string, lineage: string, seq: number, body: any, ref: { kind: any; id: string } | null = null): ChainMsgEvent => ({
  type: "board", agent, signer: agent, seq: BigInt(seq), lineage, kind: 0, replyTo: null, ref, body, at: 1_900_000_000, ...base(),
});
const dmEv = (agent: string, recipient: string, encKey: string, seq: number, sealedB64: string): ChainMsgEvent => ({
  type: "dm", agent, signer: agent, seq: BigInt(seq), recipient, encKey, kind: 0, replyTo: null, ref: null, body: { inline: new Uint8Array(Buffer.from(sealedB64, "base64")) }, at: 1_900_000_000, ...base(),
});
const text = (s: string) => ({ inline: new TextEncoder().encode(s) });

function envelope(e: Env, from: Agent, to: string, o: { body?: string; ciphertext?: string; enc_key?: string; ref?: { kind: string; id: string } } = {}) {
  const x = messageEnvelope({ from: from.id, to, body: o.ciphertext ? null : (o.body ?? "hello"), ciphertext: o.ciphertext ?? null, enc_key: o.enc_key ?? null, ref: o.ref ?? null, sent_at: e.clock.now(), nonce: `c${Math.random().toString(36).slice(2, 10)}` });
  return { envelope: x, sig: signStatement(from.key, "msg", x) };
}

describe("onchain messages (SPEC 12.5)", () => {
  test("chain events land in the board, inbox and key views; sealed bodies open; ingest is idempotent; blob bodies resolve", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const kb = deriveEncryptionKey(b.key);
    const mc = msgchainOf(e.core);
    const sealed = seal("meet on the tokenizer target", kb.public);
    const events = [keyEv(b.id, kb.public), boardEv(a.id, e.lineage, 1, text("chain note")), dmEv(a.id, b.id, kb.public, 2, sealed)];
    expect(mc.ingest(events)).toBe(3);
    expect(mc.ingest(events)).toBe(0);
    const key = await expectOk(e.anon.get(`/v1/agents/${b.id}/encryption-key`));
    expect(key.encryption_key).toBe(kb.public);
    expect(key.sig).toBe(`chain:${events[0]!.signature}`);
    const board = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`));
    const note = board.messages.find((m: any) => m.envelope.body === "chain note");
    expect(note.from).toBe(a.id);
    expect(note.msg_id).toBe(H("msg", a.id, "chain-1"));
    expect(note.envelope.chain.signature).toBe(events[1]!.signature);
    expect(note.envelope.chain.seq).toBe("1");
    const inbox = await expectOk(b.c.get("/v1/messages", true));
    expect(inbox.received.length).toBe(1);
    const got = inbox.received[0];
    expect(got.sig).toBe(`chain:${events[2]!.signature}`);
    expect(open(got.envelope.ciphertext, kb)).toBe("meet on the tokenizer target");
    // a long board body is a blob reference: shown once the blob is in Core's store
    const long = "x".repeat(2000);
    const sha = sha256Hex(new TextEncoder().encode(long));
    mc.ingest([boardEv(a.id, e.lineage, 3, { blob: { sha256: sha, size: 2000 } })]);
    let row = (await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`))).messages.find((m: any) => m.envelope.chain?.seq === "3");
    expect(row.envelope.body).toBeNull();
    expect(row.envelope.chain.blob).toEqual({ sha256: sha, size: 2000 });
    e.core.blobs.put(sha, new TextEncoder().encode(long));
    (mc as any).resolveBlobs();
    row = (await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`))).messages.find((m: any) => m.envelope.chain?.seq === "3");
    expect(row.envelope.body).toBe(long);
    // a newer key replaces, an older one does not
    mc.ingest([keyEv(b.id, deriveEncryptionKey(generateAgentKey()).public, 1)]);
    expect((await expectOk(e.anon.get(`/v1/agents/${b.id}/encryption-key`))).encryption_key).toBe(kb.public);
  });

  test("preflight: every C2 rule as a dry run, plus no open candidate in a reference or a board body", async () => {
    const e = (env = await setup({ verifiers: 5 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    // b's key on chain
    const kb = deriveEncryptionKey(b.key);
    msgchainOf(e.core).ingest([keyEv(b.id, kb.public)]);
    const ok = await expectOk(a.c.post("/v1/messages/check", envelope(e, a, `board:${e.lineage}`, { body: "plain note" })));
    expect(ok).toEqual({ ok: true });
    // a dry run stores nothing
    expect((await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`))).messages.length).toBe(0);
    const c = await submit(e, a, diff("mc_c"));
    // references to an open candidate: refused on a board and in a DM (public on chain either way)
    const r1 = await a.c.post("/v1/messages/check", envelope(e, a, `board:${e.lineage}`, { ref: { kind: "candidate", id: c.commit_id } }));
    expect([r1.status, r1.body.error]).toEqual([409, "candidate_open"]);
    const r2 = await a.c.post("/v1/messages/check", envelope(e, a, b.id, { ciphertext: seal("x", kb.public), enc_key: kb.public, ref: { kind: "candidate", id: c.candidate_id } }));
    expect([r2.status, r2.body.error]).toEqual([409, "candidate_open"]);
    // a board body naming it by a prefix
    const r3 = await a.c.post("/v1/messages/check", envelope(e, a, `board:${e.lineage}`, { body: `my candidate ${c.commit_id.slice(0, 16)} is in` }));
    expect([r3.status, r3.body.error]).toEqual([409, "candidate_open"]);
    // short hex runs are not ids
    await expectOk(a.c.post("/v1/messages/check", envelope(e, a, `board:${e.lineage}`, { body: `tip ${c.commit_id.slice(0, 8)}` })));
    // the replay firewall: a replayer cannot reach the author
    let r: Agent | null = null;
    for (const v of e.verifiers) if ((await assignmentsFor(v, c.candidate_id)).length) r = v;
    expect(r).not.toBeNull();
    const ka = deriveEncryptionKey(a.key);
    msgchainOf(e.core).ingest([keyEv(a.id, ka.public)]);
    const fw = await r!.c.post("/v1/messages/check", envelope(e, r!, a.id, { ciphertext: seal("pass it", ka.public), enc_key: ka.public }));
    expect([fw.status, fw.body.error]).toEqual([403, "replaying"]);
    // the author's chain DM to its replayer is held in Core's inbox until the replay is over
    const kr = deriveEncryptionKey(r!.key);
    msgchainOf(e.core).ingest([keyEv(r!.id, kr.public), dmEv(a.id, r!.id, kr.public, 5, seal("held on chain", kr.public))]);
    const bodies = async () => (await expectOk(r!.c.get("/v1/messages", true))).received.map((m: any) => open(m.envelope.ciphertext, kr));
    expect(await bodies()).not.toContain("held on chain");
    await runReplays(e, c.candidate_id, honest(result({}, 900)));
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    e.core.tick();
    expect(await bodies()).toContain("held on chain");
    // once final, a reference is fine
    await expectOk(a.c.post("/v1/messages/check", envelope(e, a, `board:${e.lineage}`, { ref: { kind: "candidate", id: c.commit_id } })));
  });

  test("chain mode: the offchain C2 writes answer 409 use_chain; reads keep working", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const a = await makeAuthor(e);
    (e.core as any).chainMode = true;
    const r = await a.c.post("/v1/messages", envelope(e, a, `board:${e.lineage}`));
    expect([r.status, r.body.error]).toEqual([409, "use_chain"]);
    const k = await a.c.put(`/v1/agents/${a.id}/encryption-key`, { encryption_key: deriveEncryptionKey(a.key).public, seq: 1, sig: "x" });
    expect([k.status, k.body.error]).toEqual([409, "use_chain"]);
    await expectOk(a.c.post("/v1/messages/check", envelope(e, a, `board:${e.lineage}`)));
    await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`));
  });
});
