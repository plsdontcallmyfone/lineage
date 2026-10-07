import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateAgentKey, recipeId, sha256Hex, signRequest } from "../src/protocol.ts";
import { agentClient, setup, type Env, RECIPE } from "./helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setup({ verifiers: 1 });
});
afterAll(() => env.close());

describe("request auth", () => {
  test("unsigned mutating request is rejected", async () => {
    const r = await env.anon.request("POST", "/v1/agents", {}, { sign: false });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unsigned");
  });

  test("signature by a different key is rejected", async () => {
    const a = agentClient(env);
    const other = generateAgentKey();
    const nonce = a.c.nonce();
    const body = JSON.stringify({});
    const res = await fetch(env.base + "/v1/agents", {
      method: "POST",
      headers: { "x-lineage-agent": a.id, "x-lineage-nonce": nonce, "x-lineage-sig": signRequest(other, "POST", "/v1/agents", body, nonce) },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");
  });

  test("tampered body fails verification", async () => {
    const a = env.verifiers[0]!;
    const nonce = a.c.nonce();
    const sig = signRequest(a.key, "POST", `/v1/agents/${a.id}/bond`, JSON.stringify({ amount: "1" }), nonce);
    const res = await fetch(env.base + `/v1/agents/${a.id}/bond`, {
      method: "POST",
      headers: { "x-lineage-agent": a.id, "x-lineage-nonce": nonce, "x-lineage-sig": sig },
      body: JSON.stringify({ amount: "1000" }),
    });
    expect(res.status).toBe(401);
  });

  test("a nonce is single use", async () => {
    const a = env.verifiers[0]!;
    const nonce = a.c.nonce();
    const first = await a.c.request("GET", "/v1/assignments", undefined, { nonce });
    expect(first.status).toBe(200);
    const again = await a.c.request("GET", "/v1/assignments", undefined, { nonce });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("replayed_nonce");
  });

  test("stale and malformed nonces are rejected", async () => {
    const a = env.verifiers[0]!;
    const stale = await a.c.request("GET", "/v1/assignments", undefined, { nonce: `${env.clock.now() - env.core.nonceWindowMs - 1}-x` });
    expect(stale.body.error).toBe("stale_nonce");
    const future = await a.c.request("GET", "/v1/assignments", undefined, { nonce: `${env.clock.now() + env.core.nonceWindowMs + 1}-x` });
    expect(future.body.error).toBe("stale_nonce");
    const junk = await a.c.request("GET", "/v1/assignments", undefined, { nonce: "hello" });
    expect(junk.body.error).toBe("bad_nonce");
  });

  test("signed GET binds the query string", async () => {
    const a = env.verifiers[0]!;
    const nonce = a.c.nonce();
    const sig = signRequest(a.key, "GET", "/v1/assignments", "", nonce);
    const res = await fetch(env.base + "/v1/assignments?x=1", { headers: { "x-lineage-agent": a.id, "x-lineage-nonce": nonce, "x-lineage-sig": sig } });
    expect(res.status).toBe(401);
  });

  test("admin endpoints need the admin key", async () => {
    const r = await env.verifiers[0]!.c.post("/v1/admin/faucet", { agent: env.verifiers[0]!.id, amount: "1" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_admin");
  });

  test("agents act only on themselves", async () => {
    const [a] = env.verifiers;
    const other = env.reference!;
    const r = await a!.c.post(`/v1/agents/${other.id}/bond`, { amount: "1" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_self");
  });

  test("calibrations come only from reference runners", async () => {
    const r = await env.verifiers[0]!.c.post("/v1/calibrations", { calibration: {}, sig: "x" });
    expect(r.body.error).toBe("not_reference");
  });

  test("recipe id is recomputed by the server", async () => {
    const r = await env.admin.c.post("/v1/admin/recipes", { recipe: { ...RECIPE, name: "other" }, recipe_id: recipeId(RECIPE) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("recipe_id_mismatch");
  });
});

describe("blobs", () => {
  test("PUT verifies the hash, GET serves the bytes", async () => {
    const a = env.verifiers[0]!;
    const bytes = new TextEncoder().encode("hello transcript");
    const sha = sha256Hex(bytes);
    const wrong = await a.c.putBlob("a".repeat(64), bytes);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("hash_mismatch");
    const ok = await a.c.putBlob(sha, bytes);
    expect(ok.status).toBe(200);
    expect(ok.body.created).toBe(true);
    expect((await a.c.putBlob(sha, bytes)).body.created).toBe(false);
    const got = await fetch(env.base + `/v1/blobs/${sha}`);
    expect(new TextDecoder().decode(await got.arrayBuffer())).toBe("hello transcript");
    expect(env.core.blobs.path(sha)).toContain(`/blobs/${sha.slice(0, 2)}/${sha}`);
    expect((await fetch(env.base + `/v1/blobs/${"b".repeat(64)}`)).status).toBe(404);
  });

  test("unregistered agents cannot upload", async () => {
    const stranger = agentClient(env);
    const bytes = new TextEncoder().encode("x");
    const r = await stranger.c.putBlob(sha256Hex(bytes), bytes);
    expect(r.status).toBe(403);
  });
});
