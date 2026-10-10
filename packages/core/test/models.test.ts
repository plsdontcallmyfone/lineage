import { afterEach, describe, expect, test } from "bun:test";
import { newSoul, signSoul, type SoulDoc } from "@lineage/souls/doc";
import { persona, SEED } from "../../souls/test/fixtures.ts";
import { generateAgentKey } from "../src/protocol.ts";
import { agentClient, bare, expectOk } from "./helpers.ts";

// Model registry (plan M): seeded from config/models.json, admin-editable, availability reported by
// the runtime (never keys), and a soul may only name a priced registry model.

let env: { close(): void } | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe("model registry in Core", () => {
  test("GET /v1/models serves the seed; nothing is pickable until the runtime reports keys", async () => {
    const e = bare();
    env = e;
    const v = await expectOk(e.anon.get("/v1/models"));
    expect(v.source).toBe("seed");
    expect(v.registry.models.length).toBeGreaterThan(10);
    expect(v.models.every((m: any) => !m.pickable)).toBe(true);
    // a stranger may not report availability; the admin (or runtime) may
    expect((await agentClient(e).c.post("/v1/admin/models/availability", { providers: { anthropic: true } })).status).toBe(403);
    await expectOk(e.admin.c.post("/v1/admin/models/availability", { providers: { anthropic: true, deepseek: false, meta: true } }));
    const v2 = await expectOk(e.anon.get("/v1/models"));
    const ant = v2.models.filter((m: any) => m.provider === "anthropic");
    expect(ant.length).toBeGreaterThan(0);
    expect(ant.every((m: any) => m.pickable)).toBe(true);
    expect(v2.models.find((m: any) => m.provider === "deepseek").why).toMatch(/no key/);
    // Meta has a key flag but no price and no API adapter: still not pickable
    expect(v2.models.find((m: any) => m.provider === "meta").pickable).toBe(false);
    expect((await e.admin.c.post("/v1/admin/models/availability", { providers: { anthropic: "yes" } })).status).toBe(400);
  });

  test("the admin replaces the registry; a bad registry is refused; only the admin may", async () => {
    const e = bare();
    env = e;
    const reg = (await expectOk(e.anon.get("/v1/models"))).registry;
    const next = structuredClone(reg);
    next.models = next.models.filter((m: any) => m.provider !== "openai");
    next.providers = next.providers.filter((p: any) => p.id !== "openai");
    expect((await agentClient(e).c.post("/v1/admin/models", { registry: next })).status).toBe(403);
    const bad = structuredClone(next);
    bad.models[0].rate.output = -1;
    expect((await e.admin.c.post("/v1/admin/models", { registry: bad })).body.error).toBe("bad_registry");
    const out = await expectOk(e.admin.c.post("/v1/admin/models", { registry: next }));
    expect(out.source).toBe("admin");
    expect(out.registry.models.some((m: any) => m.provider === "openai")).toBe(false);
  });

  test("a soul may name a priced registry model; an unknown or unpriced one is refused", async () => {
    const e = bare();
    env = e;
    const reg = (await expectOk(e.anon.get("/v1/models"))).registry;
    const priced = reg.models.find((m: any) => m.provider === "deepseek" && m.status === "verified");
    const meta = reg.models.find((m: any) => m.provider === "meta");
    const k = generateAgentKey();
    const base = newSoul({ agent: k.id, seed: SEED, persona: persona(), created_at: 1_790_000_000, origin: { by: "launcher", model: null, prompt_version: null } });
    const put = (doc: SoulDoc) => e.anon.request("PUT", `/v1/agents/${k.id}/soul`, { doc, sig: signSoul(k, doc) }, { sign: false });
    const unknown = { ...base, model: { provider: "deepseek", id: "no-such-model" } };
    expect((await put(unknown)).body.message).toMatch(/not in the model registry/);
    expect((await put({ ...base, model: { provider: meta.provider, id: meta.id } })).body.message).toMatch(/no published price/);
    expect((await put({ ...base, model: { provider: "deepseek" } } as never)).status).toBe(400);
    const ok = { ...base, model: { provider: priced.provider, id: priced.id } };
    expect((await expectOk(put(ok))).seq).toBe(1);
    // a soul without a model stays valid (the registry default)
    const k2 = generateAgentKey();
    const plain = { ...base, agent: k2.id };
    expect((await e.anon.request("PUT", `/v1/agents/${k2.id}/soul`, { doc: plain, sig: signSoul(k2, plain) }, { sign: false })).status).toBe(200);
  });
});
