import { afterEach, describe, expect, test } from "bun:test";
import { foldMemory, newSoul, nextVersion, signSoul, soulDigest, type SoulDoc } from "@lineage/souls/doc";
import { persona, SEED } from "../../souls/test/fixtures.ts";
import { generateAgentKey, signStatement, type AgentKey } from "../src/protocol.ts";
import { agentClient, bare, CANARY_FAST, diff, expectOk, honest, makeAuthor, runReplays, settleCanaries, setup, submit, warmShadows, type Env } from "./helpers.ts";

// Souls (SPEC 14.8): self-authenticating versions, public once launched, memory only from final
// records, chain mirror, shadow parity from a private library.

let env: { close(): void } | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const seq1 = (k: AgentKey, over: Partial<SoulDoc> = {}): SoulDoc => ({ ...newSoul({ agent: k.id, seed: SEED, persona: persona(), created_at: 1_790_000_000, origin: { by: "launcher", model: null, prompt_version: null } }), ...over });
const put = (e: { anon: any }, doc: SoulDoc, sig: string) => e.anon.request("PUT", `/v1/agents/${doc.agent}/soul`, { doc, sig }, { sign: false });

describe("souls in Core", () => {
  test("stored before launch stays unseen; public once launched; checks signature, chain and safety", async () => {
    const e = bare();
    env = e;
    const k = generateAgentKey();
    const d1 = seq1(k);
    const r1 = await expectOk(put(e, d1, signSoul(k, d1)));
    expect(r1).toMatchObject({ digest: soulDigest(d1), seq: 1, created: true, public: false });
    expect((await e.anon.get(`/v1/agents/${k.id}/soul`)).status).toBe(404);
    expect((await e.anon.get(`/v1/souls/${r1.digest}`)).status).toBe(404);
    // the same version again is idempotent
    expect((await expectOk(put(e, d1, signSoul(k, d1)))).created).toBe(false);
    // launch: now public
    await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "purchased" }));
    const v = await expectOk(e.anon.get(`/v1/agents/${k.id}/soul`));
    expect(v).toMatchObject({ digest: r1.digest, seq: 1, signer: k.id, onchain: null });
    expect(v.doc.persona.name).toBe("Wren Halvard");
    expect((await expectOk(e.anon.get(`/v1/souls/${r1.digest}`))).agent).toBe(k.id);

    // a stranger's signature, a seq gap, a wrong prev and unsafe content are refused
    const d2 = nextVersion(d1, { identity: { github_login: "goodone", ssh_signing_key: null, profile_url: null } }, 1_790_000_100);
    expect((await put(e, d2, signSoul(generateAgentKey(), d2))).status).toBe(401);
    expect((await put(e, { ...d2, seq: 3 }, signSoul(k, { ...d2, seq: 3 }))).body.error).toBe("bad_seq");
    const wrongPrev = { ...d2, prev: "f".repeat(64) };
    expect((await put(e, wrongPrev, signSoul(k, wrongPrev))).body.error).toBe("bad_prev");
    const unsafe = nextVersion(d1, { persona: persona({ tagline: "Will pump the token price for holders." }) }, 1_790_000_100);
    const bad = await put(e, unsafe, signSoul(k, unsafe));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_soul");
    const other = { ...d2, agent: generateAgentKey().id };
    expect((await e.anon.request("PUT", `/v1/agents/${k.id}/soul`, { doc: other, sig: signSoul(k, other) }, { sign: false })).status).toBe(400);
    // the right next version lands and becomes the latest
    expect((await expectOk(put(e, d2, signSoul(k, d2)))).seq).toBe(2);
    const v2 = await expectOk(e.anon.get(`/v1/agents/${k.id}/soul`));
    expect(v2.seq).toBe(2);
    expect(v2.doc.identity.github_login).toBe("goodone");
    expect(v2.versions.map((x: any) => x.seq)).toEqual([2, 1]);
  });

  test("a rotated agent's soul is signed by its new key, never the old one", async () => {
    const e = bare();
    env = e;
    const k = generateAgentKey();
    await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "app" }));
    const next = generateAgentKey();
    const a = agentClient(e, k);
    await expectOk(a.c.post(`/v1/agents/${k.id}/keys/rotate`, { new_key: next.id, new_key_sig: signStatement(next, "rotate", { agent: k.id, new_key: next.id, seq: 1 }) }));
    const d1 = seq1(k);
    expect((await put(e, d1, signSoul(k, d1))).status).toBe(401);
    const v = await expectOk(put(e, d1, signSoul(next, d1)));
    expect(v.seq).toBe(1);
    expect((await expectOk(e.anon.get(`/v1/agents/${k.id}/soul`))).signer).toBe(next.id);
  });

  test("memory must be exactly what the agent's final records yield", async () => {
    const e = await setup({ verifiers: 2 });
    env = e;
    const author = await makeAuthor(e);
    const d1 = seq1(author.key);
    await expectOk(put(e, d1, signSoul(author.key, d1)));
    const s = await submit(e, author, diff("souls_mem"));
    await runReplays(e, s.candidate_id, honest());
    // nothing is final in a closed epoch yet: a memory naming an epoch is refused
    const early = nextVersion(d1, { memory: { through_epoch: 0, entries: [], reflection: null } }, 1_790_000_100);
    expect((await put(e, early, signSoul(author.key, early))).body.error).toBe("bad_memory");
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const recs = await expectOk(e.anon.get(`/v1/agents/${author.id}/records`));
    const mem = foldMemory(author.id, recs.epochs, closed.n, "Epoch " + closed.n + " ended with 1 accepted.");
    expect(mem.entries.length).toBeGreaterThan(0);
    expect(mem.entries[0]!.kind).toBe("accepted");
    // an invented entry is refused
    const lie = nextVersion(d1, { memory: { ...mem, entries: [{ ...mem.entries[0]!, summary: "Accepted five generations in a row." }] } }, 1_790_000_200);
    const r = await put(e, lie, signSoul(author.key, lie));
    expect(r.body.error).toBe("bad_memory");
    // the derived memory lands
    const d2 = nextVersion(d1, { memory: mem }, 1_790_000_200);
    expect((await expectOk(put(e, d2, signSoul(author.key, d2)))).seq).toBe(2);
    const v = await expectOk(e.anon.get(`/v1/agents/${author.id}/soul`));
    expect(v.doc.memory.entries[0].summary).toContain("1 accepted");
  });

  test("chain mirror: the view says whether the registry digest matches", async () => {
    const e = bare();
    env = e;
    const k = generateAgentKey();
    await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "app" }));
    const d1 = seq1(k);
    await expectOk(put(e, d1, signSoul(k, d1)));
    const { soulsOf } = await import("../src/souls.ts");
    (e.core as any).chainMode = true;
    soulsOf(e.core).syncChain(k.id, soulDigest(d1), 1);
    expect((await expectOk(e.anon.get(`/v1/agents/${k.id}/soul`))).onchain).toMatchObject({ digest: soulDigest(d1), seq: 1, matches: true });
    soulsOf(e.core).syncChain(k.id, "0".repeat(64), 1);
    expect((await expectOk(e.anon.get(`/v1/agents/${k.id}/soul`))).onchain.matches).toBe(false);
    (e.core as any).chainMode = false;
  });

  test("shadow parity: shadows publish souls from the private library at the real rate", async () => {
    const e = (await setup({ verifiers: 2, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } })) as Env;
    env = e;
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, patch: diff("soul_canary", "src/hidden.rs"), kind: "perf", target: "ir", expected_reason: "tests_fail" }));
    const lib = await expectOk(e.admin.c.post("/v1/admin/souls/library", { items: Array.from({ length: 6 }, (_, i) => ({ seed: SEED, persona: persona({ name: `Shadowless ${String.fromCharCode(65 + i)}` }) })) }));
    expect(lib).toEqual({ added: 6, unused: 6 });
    expect((await e.anon.post("/v1/admin/souls/library", { items: [] })).status).toBe(401);
    // one real launched agent with a soul: the real rate is 1
    const author = await makeAuthor(e);
    const d1 = seq1(author.key);
    e.clock.advance(20_000);
    await expectOk(put(e, d1, signSoul(author.key, d1)));
    warmShadows(e);
    settleCanaries(e, 12);
    const shadows = e.core.db.query<{ agent_id: string }, []>("SELECT agent_id FROM shadows WHERE launched_at IS NOT NULL").all();
    expect(shadows.length).toBeGreaterThan(0);
    let withSoul = 0;
    for (const s of shadows) {
      const r = await e.anon.get(`/v1/agents/${s.agent_id}/soul`);
      if (r.status === 200) {
        withSoul++;
        expect(r.body.doc.persona.name.startsWith("Shadowless")).toBe(true);
        expect(r.body.signer).toBe(s.agent_id);
      }
    }
    expect(withSoul).toBe(Math.min(shadows.length, 6));
    // the library is never served
    expect((await e.anon.get("/v1/admin/souls/library")).status).toBe(405);
  });
});

