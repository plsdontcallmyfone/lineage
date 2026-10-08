import { afterEach, describe, expect, test } from "bun:test";
import { CoreClient } from "../src/client.ts";
import { generateAgentKey, signStatement, type AgentKey } from "../src/protocol.ts";
import { agent, candidate, diff, expectOk, makeAuthor, runReplays, result, setup, submit, type Agent, type Env } from "./helpers.ts";

// Identity plan I1: the agent id never changes; Core authenticates the agent's current signing key
// and refuses a revoked one.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const rotateBody = (agentId: string, k: AgentKey, seq: number) => ({ new_key: k.id, new_key_sig: signStatement(k, "rotate", { agent: agentId, new_key: k.id, seq }) });
/** The same agent, speaking with another key. */
const speaking = (e: Env, a: Agent, k: AgentKey): Agent => ({ key: k, id: a.id, c: new CoreClient(e.base, { ...k, agent: a.id }, () => e.clock.now()) });

describe("key rotation (M1 endpoint)", () => {
  test("rotate needs the current key and the new key; the old key then gets 401, the new key works", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const v = e.verifiers[0]!;
    const k1 = generateAgentKey();
    // the new key must sign for exactly this agent, key and sequence number
    const wrongSeq = await v.c.post(`/v1/agents/${v.id}/keys/rotate`, rotateBody(v.id, k1, 2));
    expect([wrongSeq.status, wrongSeq.body.error]).toEqual([403, "bad_new_key_sig"]);
    const other = generateAgentKey();
    const notNew = await v.c.post(`/v1/agents/${v.id}/keys/rotate`, { new_key: k1.id, new_key_sig: signStatement(other, "rotate", { agent: v.id, new_key: k1.id, seq: 1 }) });
    expect(notNew.status).toBe(403);
    // only the agent itself (its current key) may rotate it
    const w = e.verifiers[1]!;
    const foreign = await w.c.post(`/v1/agents/${v.id}/keys/rotate`, rotateBody(v.id, k1, 1));
    expect(foreign.body.error).toBe("not_self");
    const ok = await expectOk(v.c.post(`/v1/agents/${v.id}/keys/rotate`, rotateBody(v.id, k1, 1)));
    expect([ok.signing_key, ok.seq, ok.revoked]).toEqual([k1.id, 1, false]);
    expect(ok.keys.map((k: any) => [k.seq, k.signing_key])).toEqual([[0, v.id], [1, k1.id]]);

    const old = await v.c.get("/v1/assignments", true);
    expect([old.status, old.body.error]).toEqual([401, "bad_signature"]);
    const now = speaking(e, v, k1);
    expect((await now.c.get("/v1/assignments", true)).status).toBe(200);
    // the agent id is unchanged everywhere
    const view = await agent(e, v.id);
    expect([view.agent_id, view.identity.signing_key, view.identity.key_seq]).toEqual([v.id, k1.id, 1]);
    expect((await expectOk(e.anon.get(`/v1/agents/${v.id}/keys`))).signing_key).toBe(k1.id);
    // a second rotation is signed by the new current key with seq 2
    const k2 = generateAgentKey();
    await expectOk(now.c.post(`/v1/agents/${v.id}/keys/rotate`, rotateBody(v.id, k2, 2)));
    expect((await now.c.get("/v1/assignments", true)).status).toBe(401);
    expect((await speaking(e, v, k2).c.get("/v1/assignments", true)).status).toBe(200);
  });

  test("a rotated author commits under its unchanged agent id", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const author = await makeAuthor(e);
    const k = generateAgentKey();
    await expectOk(author.c.post(`/v1/agents/${author.id}/keys/rotate`, rotateBody(author.id, k, 1)));
    const refused = await author.c.post("/v1/candidates", {});
    expect(refused.status).toBe(401);
    const c = await submit(e, speaking(e, author, k), diff("rotated"));
    await runReplays(e, c.candidate_id, () => result());
    const v = await candidate(e, c.candidate_id);
    expect([v.status, v.author]).toEqual(["accepted", author.id]);
  });

  test("revoked (chain mirror) refuses every key until a rotation; chain mode owns rotation", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const v = e.verifiers[0]!;
    const k = generateAgentKey();
    // what ChainBridge does when it reads the registry: revoke at seq 1, then rotate to k at seq 2
    e.core.tx(() => e.core.identity.syncChain(v.id, null, 1, 1_900_000_000n));
    const r = await v.c.get("/v1/assignments", true);
    expect([r.status, r.body.error]).toEqual([401, "key_revoked"]);
    expect((await agent(e, v.id)).identity.revoked).toBe(true);
    e.core.tx(() => e.core.identity.syncChain(v.id, k.id, 2, 1_900_000_100n));
    expect((await v.c.get("/v1/assignments", true)).status).toBe(401);
    expect((await speaking(e, v, k).c.get("/v1/assignments", true)).status).toBe(200);
    // an older read never moves the key backwards
    e.core.tx(() => e.core.identity.syncChain(v.id, null, 1, 1_900_000_000n));
    expect((await speaking(e, v, k).c.get("/v1/assignments", true)).status).toBe(200);
    // rotate back to the original key
    e.core.tx(() => e.core.identity.syncChain(v.id, v.id, 3, 1_900_000_200n));
    expect((await v.c.get("/v1/assignments", true)).status).toBe(200);
    const h = await expectOk(e.anon.get(`/v1/agents/${v.id}/keys`));
    expect(h.keys.map((x: any) => [x.seq, x.signing_key, x.source])).toEqual([[0, v.id, "chain"], [1, null, "chain"], [2, k.id, "chain"], [3, v.id, "chain"]]);
    expect(e.core.identity.keyAt(v.id, 1_900_000_150_000)).toBe(k.id);
    expect(e.core.identity.keyAt(v.id, 1_900_000_050_000)).toBe(null);
    // in chain mode the M1 endpoint answers 409 use_chain
    (e.core as unknown as { chainMode: boolean }).chainMode = true;
    const m1 = await v.c.post(`/v1/agents/${v.id}/keys/rotate`, rotateBody(v.id, generateAgentKey(), 4));
    expect([m1.status, m1.body.error]).toEqual([409, "use_chain"]);
    (e.core as unknown as { chainMode: boolean }).chainMode = false;
  });

  test("owner transfers mirrored from chain set controller_since", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const v = e.verifiers[0]!;
    const o1 = generateAgentKey().id;
    const o2 = generateAgentKey().id;
    e.core.tx(() => e.core.identity.syncOwner(v.id, o1, 1_900_000_000n, null));
    e.core.tx(() => e.core.identity.syncOwner(v.id, o1, 1_900_000_000n, o2));
    expect((await agent(e, v.id)).identity).toMatchObject({ owner: o1, pending_owner: o2, controller_since: 1_900_000_000_000 });
    e.core.tx(() => e.core.identity.syncOwner(v.id, o2, 1_900_000_500n, null));
    expect((await agent(e, v.id)).identity).toMatchObject({ owner: o2, pending_owner: null, controller_since: 1_900_000_500_000 });
    const types = (await expectOk<any[]>(e.anon.get("/v1/events/log?since=0&limit=5000"))).map((x) => x.type);
    expect(types).toContain("agent.owner_proposed");
    expect(types).toContain("agent.owner_changed");
    expect((await expectOk(e.anon.get(`/v1/agents/${v.id}/credential`))).controller_since).toBe(1_900_000_500_000);
  });
});
