// Automatic binding of hosted launches (launch e2e lane, src/bind.ts): the runtime hands out its key
// for a hosted launch, co-signs only an owner-signed rotate_agent_key of that agent to that key, and
// adopts a hosted agent on demand before discovery has seen it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@lineage/protocol";
import { ata, compileMessage, registry, signBytes, system } from "@lineage/chain";
import { DEVNET_GENESIS } from "../../chain/src/browser/client.ts";
import { placeSignature, unsignedWire } from "../../chain/src/browser/wire.ts";
import { bindHandler, checkBindTx, type BindHost } from "../src/bind.ts";
import { parseConfig, Runtime, type Backend, type HostedAgent } from "../src/index.ts";

const owner = generateAgentKey();
const agent = generateAgentKey();
const runtimeKey = generateAgentKey();

/** A wire the owner's wallet signed (fee payer), with the runtime key's signature still missing. */
function ownerSigned(ixs: Parameters<typeof compileMessage>[1], payer: AgentKey = owner) {
  const msg = compileMessage(payer.id, ixs, DEVNET_GENESIS);
  return placeSignature(unsignedWire(msg), payer.id, signBytes(payer, msg.bytes));
}
const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");
const rotate = (a = agent.id, k = runtimeKey.id, o = owner.id) => registry.rotateAgentKey({ owner: o, agent: a, newKey: k });

function host(status = "awaiting_owner"): BindHost & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async bindTarget(a) {
      asked.push(a);
      return a === agent.id ? { agent: a, new_key: runtimeKey.id, status } : null;
    },
    keyOf: (a) => (a === agent.id ? runtimeKey : null),
  };
}

describe("checkBindTx", () => {
  test("accepts exactly an owner-signed rotation of this agent to this key", () => {
    const s = checkBindTx(ownerSigned([rotate()]), runtimeKey.id, agent.id);
    expect(s.join(" ")).toContain(`to new key ${runtimeKey.id}`);
  });
  test("refuses register, a second rotation, other agents, other programs and an unsigned owner", () => {
    const mint = generateAgentKey().id;
    const reg = registry.register({ owner: owner.id, agent: runtimeKey.id, mint, ownerToken: ata(owner.id, mint), operator: new Uint8Array(32), capabilities: new Uint8Array(32) } as any);
    expect(() => checkBindTx(ownerSigned([reg]), runtimeKey.id, runtimeKey.id)).toThrow(/only rotate_agent_key/);
    const other = generateAgentKey();
    expect(() => checkBindTx(ownerSigned([rotate(other.id)]), runtimeKey.id, agent.id)).toThrow(/not the record of/);
    expect(() => checkBindTx(ownerSigned([rotate(), rotate(other.id)]), runtimeKey.id, agent.id)).toThrow(/refusing/);
    expect(() => checkBindTx(ownerSigned([rotate(), system.transfer(owner.id, runtimeKey.id, 1n)]), runtimeKey.id, agent.id)).toThrow(/refusing to co-sign/);
    const msg = compileMessage(owner.id, [rotate()], DEVNET_GENESIS);
    expect(() => checkBindTx(unsignedWire(msg), runtimeKey.id, agent.id)).toThrow(/has not signed/);
    // the runtime key as fee payer would let a page spend its SOL
    expect(() => checkBindTx(ownerSigned([rotate()], runtimeKey), runtimeKey.id, agent.id)).toThrow(/fee payer|not a signer|writable/);
  });
});

describe("bind endpoint", () => {
  const url = (a: string) => `http://x/runtime/bind/${a}`;
  test("GET gives the runtime key of a hosted agent and 404 otherwise", async () => {
    const h = host();
    const f = bindHandler({ host: h, send: async () => ({ signature: "s" }) });
    expect(await (await f(new Request(url(agent.id)))).json()).toEqual({ agent: agent.id, new_key: runtimeKey.id, status: "awaiting_owner" });
    expect((await f(new Request(url(generateAgentKey().id)))).status).toBe(404);
    expect((await f(new Request(url("not-a-key")))).status).toBe(400);
  });
  test("POST co-signs and sends a valid rotation once; refuses bad ones before sending", async () => {
    const sent: string[] = [];
    const f = bindHandler({ host: host(), send: async (k, tx, a) => (sent.push(`${k.id}|${a}|${tx.length}`), { signature: "sig1" }) });
    const post = (a: string, body: unknown) => f(new Request(url(a), { method: "POST", body: JSON.stringify(body) }));
    const bad = await post(agent.id, { tx: b64(ownerSigned([rotate(generateAgentKey().id)])) });
    expect(bad.status).toBe(400);
    expect((await post(agent.id, { tx: "!!" })).status).toBe(400);
    expect((await post(agent.id, { tx: "A".repeat(9000) })).status).toBe(413);
    expect(sent).toEqual([]);
    const ok = await post(agent.id, { tx: b64(ownerSigned([rotate()])) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ agent: agent.id, new_key: runtimeKey.id, signature: "sig1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(`${runtimeKey.id}|${agent.id}|`)).toBe(true);
  });
  test("an agent already bound is not co-signed again", async () => {
    const f = bindHandler({ host: host("bound"), send: async () => { throw new Error("must not send"); } });
    const r = await f(new Request(url(agent.id), { method: "POST", body: JSON.stringify({ tx: b64(ownerSigned([rotate()])) }) }));
    expect(r.status).toBe(409);
  });
  test("a failed send is reported, not thrown", async () => {
    const f = bindHandler({ host: host(), send: async () => { throw new Error("simulation failed: owner mismatch\nlogs"); } });
    const r = await f(new Request(url(agent.id), { method: "POST", body: JSON.stringify({ tx: b64(ownerSigned([rotate()])) }) }));
    expect(r.status).toBe(400);
    expect((await r.json()).message).toBe("simulation failed: owner mismatch");
  });
});

describe("Runtime.bindTarget", () => {
  test("adopts a hosted launch on demand (key made once, bind request written), refuses others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-bind-"));
    try {
      const hosted: HostedAgent = { agent: agent.id, mint: generateAgentKey().id, launcher: owner.id, target_repo: "https://github.com/keis/base58" };
      let lookups = 0;
      const backend = {
        mode: "devnet",
        hostedAgent: async (a: string) => (lookups++, a === agent.id ? hosted : null),
        discover: async () => [],
        bindRequest: async (a: string, k: AgentKey) => ({ agent: a, new_key: k.id }),
      } as unknown as Backend;
      const cfg = parseConfig({ mode: "devnet", core: "http://127.0.0.1:1", runtime_key: "/dev/null", state_dir: dir, compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002" });
      const rt = new Runtime(cfg, { backend, runtimeKey, proposer: () => ({ name: "none", propose: async () => null }), log: () => {}, telemetry: false });
      const a = await rt.bindTarget(agent.id);
      expect(a?.status).toBe("awaiting_owner");
      expect(rt.keyOf(agent.id)?.id).toBe(a!.new_key);
      expect(rt.state.agents[agent.id]?.target_repo).toBe(hosted.target_repo);
      // a second ask reuses the key without another chain read
      expect((await rt.bindTarget(agent.id))?.new_key).toBe(a!.new_key);
      expect(lookups).toBe(1);
      expect(await rt.bindTarget(generateAgentKey().id)).toBeNull();
      expect(rt.keyOf(owner.id)).toBeNull();
      expect(await rt.bindTarget("../../etc")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("attempt slots go round robin (launch e2e lane)", () => {
  test("least recently started first; never started before any started; ties keep state order", async () => {
    const { fairOrder } = await import("../src/runtime.ts");
    const e: [string, number][] = [["a", 1], ["b", 2], ["c", 3]];
    expect(fairOrder(e, new Map()).map((x) => x[0])).toEqual(["a", "b", "c"]);
    // a just ran: b and c (never started) go first, then a
    expect(fairOrder(e, new Map([["a", 100]])).map((x) => x[0])).toEqual(["b", "c", "a"]);
    expect(fairOrder(e, new Map([["a", 300], ["b", 100], ["c", 200]])).map((x) => x[0])).toEqual(["b", "c", "a"]);
  });
});
