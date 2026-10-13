// Seamless bind (docs/plans/SEAMLESS-BIND.md): the runtime reserves its key for an agent that is not
// on chain yet and co-signs, without sending, only an owner-signed rotation of exactly that agent to
// exactly that key. Every bound and every refusal is here.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { AgentFirewall, ata, compileMessage, compileMessageV0, registry, signBytes, system } from "@units/chain";
import { DEVNET_GENESIS } from "../../chain/src/browser/client.ts";
import { missingSigners, parseWire, placeSignature, unsignedWire } from "../../chain/src/browser/wire.ts";
import { resetGuardForTest } from "../../chain/src/guard.ts";
import { bindHandler, chainCosignOnly, type BindHost } from "../src/bind.ts";
import { Reservations } from "../src/reserve.ts";
import { StateStore } from "../src/state.ts";

const owner = generateAgentKey();
const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");
const ownerSigned = (ixs: Parameters<typeof compileMessage>[1], payer: AgentKey = owner, v0 = false, tables: Parameters<typeof compileMessageV0>[3] = []) => {
  const msg = v0 ? compileMessageV0(payer.id, ixs, DEVNET_GENESIS, tables) : compileMessage(payer.id, ixs, DEVNET_GENESIS);
  return placeSignature(unsignedWire(msg), payer.id, signBytes(payer, msg.bytes));
};
const rotate = (agent: string, key: string, o = owner.id) => registry.rotateAgentKey({ owner: o, agent, newKey: key });

const dirs: string[] = [];
afterEach(() => {
  resetGuardForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A world: a state store, the agents the runtime adopted, what the chain holds, and the reservations over them. */
function world(o: { ttlS?: number; max?: number; perAddress?: number; maxSigns?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "units-reserve-"));
  dirs.push(dir);
  const store = new StateStore(dir, { mode: "devnet", runtime: generateAgentKey().id, now: 0 });
  const w = {
    dir,
    store,
    now: 1000,
    adopted: new Map<string, { key_id: string; status: string }>(),
    /** agent ids that are hosted launches on chain */
    hosted: new Set<string>(),
    /** agent ids with any other registry record */
    others: new Set<string>(),
    chainDown: false,
    logs: [] as string[],
    res: null as unknown as Reservations,
    host: null as unknown as BindHost,
  };
  w.host = {
    async bindTarget(a) {
      if (w.chainDown) throw new Error("rpc down");
      if (!w.adopted.has(a) && w.hosted.has(a)) w.adopted.set(a, { key_id: store.keyFor(a).id, status: "awaiting_owner" });
      const s = w.adopted.get(a);
      return s ? { agent: a, new_key: s.key_id, status: s.status } : null;
    },
    keyOf: (a) => (w.adopted.has(a) ? store.keyFor(a) : null),
  };
  w.res = new Reservations({ dir, keyFor: (a) => store.keyFor(a), keyFile: (a) => store.keyFile(a), adopted: (a) => w.adopted.has(a), adopt: async (a) => !!(await w.host.bindTarget(a)), now: () => w.now, log: (m) => w.logs.push(m), ...o });
  return w;
}

/** The handler over a world, with the real sign-only co-signer behind a real firewall whose identities are the world's. */
function handler(w: ReturnType<typeof world>, sent: string[] = []) {
  new AgentFirewall({ rpc: { getAccountInfo: async () => null } as any, dir: w.dir, identity: (key) => {
    for (const [agent, s] of Object.entries({ ...w.res.agents(), ...Object.fromEntries(w.adopted) })) if (s.key_id === key) return { agent };
    return null;
  } }).install();
  const f = bindHandler({
    host: w.host,
    send: async (k, _tx, a) => (sent.push(`${k.id}|${a}`), { signature: "sent1" }),
    reserve: { reservations: w.res, recordExists: async (a) => { if (w.chainDown) throw new Error("rpc down"); return w.hosted.has(a) || w.others.has(a); }, sign: chainCosignOnly },
    log: (m) => w.logs.push(m),
  });
  const post = (agent: string, body: unknown, from?: string) => f(new Request(`http://x/runtime/bind/${agent}`, { method: "POST", body: JSON.stringify(body), headers: from ? { "x-forwarded-for": `1.1.1.1, ${from}` } : {} }));
  return { f, post };
}

describe("Reservations", () => {
  test("the same agent gets the same key and one slot; the key is the one adoption will use", () => {
    const w = world();
    const a = generateAgentKey().id;
    const r1 = w.res.reserve(a, "9.9.9.9");
    const r2 = w.res.reserve(a, "8.8.8.8");
    if (!r1.ok || !r2.ok) throw new Error("not reserved");
    expect(r2.key.id).toBe(r1.key.id);
    expect(w.res.count()).toBe(1);
    expect(w.res.count("9.9.9.9")).toBe(1); // the first caller's slot, not a second one
    expect(w.store.keyFor(a).id).toBe(r1.key.id);
    expect(w.res.agents()).toEqual({ [a]: { key_id: r1.key.id } });
    expect(() => w.res.reserve("../../etc/passwd", null)).toThrow(/not an agent id/);
  });

  test("bounded: a global cap and a cap per caller address; neither counts expired or adopted ones", () => {
    const w = world({ max: 3, perAddress: 2, ttlS: 100 });
    const ids = Array.from({ length: 5 }, () => generateAgentKey().id);
    expect(w.res.reserve(ids[0]!, "a").ok).toBe(true);
    expect(w.res.reserve(ids[1]!, "a").ok).toBe(true);
    expect(w.res.reserve(ids[2]!, "a")).toEqual({ ok: false, why: "address_full" });
    expect(w.res.reserve(ids[2]!, "b").ok).toBe(true);
    expect(w.res.reserve(ids[3]!, "c")).toEqual({ ok: false, why: "full" });
    // nothing was made for a refused reservation
    expect(existsSync(w.store.keyFile(ids[3]!))).toBe(false);
    // one is adopted (its launch landed): its slot is free again
    w.adopted.set(ids[0]!, { key_id: w.store.keyFor(ids[0]!).id, status: "awaiting_owner" });
    expect(w.res.reserve(ids[3]!, "c").ok).toBe(true);
    // the rest expire
    w.now += 101;
    expect(w.res.count()).toBe(0);
    expect(w.res.get(ids[1]!)).toBeNull();
    expect(w.res.keyOf(ids[1]!)).toBeNull();
    expect(w.res.reserve(ids[4]!, "a").ok).toBe(true);
  });

  test("an expired reservation loses its key: removed when never signed with, set aside when it was; an adopted agent keeps it", async () => {
    const w = world({ ttlS: 100 });
    const [never, signed, launched] = [generateAgentKey().id, generateAgentKey().id, generateAgentKey().id];
    for (const a of [never, signed, launched]) expect(w.res.reserve(a, null).ok).toBe(true);
    expect(w.res.takeSign(signed)).toBe(true);
    const launchedKey = w.store.keyFor(launched).id;
    w.hosted.add(launched); // its launch landed, the runtime has not discovered it yet
    w.now += 101;
    await w.res.sweep();
    expect(existsSync(w.store.keyFile(never))).toBe(false);
    expect(existsSync(w.store.keyFile(signed))).toBe(false);
    expect(existsSync(join(w.dir, "expired-keys", `${signed}.json`))).toBe(true);
    // adopted on the sweep's chain read, with the reserved key
    expect(w.adopted.get(launched)?.key_id).toBe(launchedKey);
    expect(existsSync(w.store.keyFile(launched))).toBe(true);
    expect(w.res.agents()).toEqual({});
  });

  test("a sweep that cannot read the chain removes nothing", async () => {
    const w = world({ ttlS: 100 });
    const a = generateAgentKey().id;
    w.res.reserve(a, null);
    w.now += 101;
    w.chainDown = true;
    await w.res.sweep();
    expect(existsSync(w.store.keyFile(a))).toBe(true);
    expect(Object.keys(w.res.agents())).toEqual([a]);
  });

  test("co-signs per reservation are counted, and asking again does not reset the count", () => {
    const w = world({ maxSigns: 2 });
    const a = generateAgentKey().id;
    w.res.reserve(a, null);
    expect(w.res.takeSign(a)).toBe(true);
    expect(w.res.takeSign(a)).toBe(true);
    expect(w.res.takeSign(a)).toBe(false);
    w.res.reserve(a, null);
    expect(w.res.takeSign(a)).toBe(false);
    expect(w.res.takeSign(generateAgentKey().id)).toBe(false);
  });

  test("reservations survive a restart", () => {
    const w = world();
    const a = generateAgentKey().id;
    const r = w.res.reserve(a, "a");
    const again = new Reservations({ dir: w.dir, keyFor: (x) => w.store.keyFor(x), keyFile: (x) => w.store.keyFile(x), adopted: () => false, adopt: async () => false, now: () => w.now });
    expect(again.keyOf(a)?.id).toBe(r.ok ? r.key.id : "");
  });
});

describe("POST /runtime/bind/<agent> { reserve: true }", () => {
  test("an agent id with no record on chain gets the runtime's key, status reserved", async () => {
    const w = world();
    const { post } = handler(w);
    const a = generateAgentKey().id;
    const r = await post(a, { reserve: true }, "7.7.7.7");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({ agent: a, new_key: w.store.keyFor(a).id, status: "reserved", expires_at: w.now + 15 * 60 });
    expect(w.res.get(a)?.from).toBe("7.7.7.7"); // the gate's entry of the forwarded header, never the client's own
  });

  test("a hosted launch already on chain answers as GET does; any other record is refused", async () => {
    const w = world();
    const { post } = handler(w);
    const hosted = generateAgentKey().id, self = generateAgentKey().id;
    w.hosted.add(hosted);
    w.others.add(self);
    expect(await (await post(hosted, { reserve: true })).json()).toEqual({ agent: hosted, new_key: w.store.keyFor(hosted).id, status: "awaiting_owner" });
    const r = await post(self, { reserve: true });
    expect(r.status).toBe(404);
    expect(w.res.count()).toBe(0);
    expect(existsSync(w.store.keyFile(self))).toBe(false);
  });

  test("refused when full, when the chain cannot be read, and on a runtime without reservations", async () => {
    const w = world({ max: 1 });
    const { post } = handler(w);
    expect((await post(generateAgentKey().id, { reserve: true })).status).toBe(200);
    const full = await post(generateAgentKey().id, { reserve: true });
    expect(full.status).toBe(429);
    expect((await full.json()).error).toBe("reservations_full");
    w.chainDown = true;
    expect((await post(generateAgentKey().id, { reserve: true })).status).toBe(503);
    const plain = bindHandler({ host: world().host, send: async () => ({ signature: "s" }) });
    expect((await plain(new Request(`http://x/runtime/bind/${generateAgentKey().id}`, { method: "POST", body: JSON.stringify({ reserve: true }) }))).status).toBe(404);
    expect((await post("not-a-key", { reserve: true })).status).toBe(400);
  });
});

describe("POST /runtime/bind/<agent> { tx, sign_only: true }", () => {
  test("a reserved agent's owner-signed rotation comes back fully signed and unsent, legacy or v0 without a lookup table", async () => {
    const w = world();
    const sent: string[] = [];
    const { post } = handler(w, sent);
    const a = generateAgentKey().id;
    const key = (await (await post(a, { reserve: true })).json()).new_key as string;
    for (const v0 of [false, true]) {
      const partial = ownerSigned([rotate(a, key)], owner, v0);
      const r = await post(a, { tx: b64(partial), sign_only: true });
      expect(r.status).toBe(200);
      const j = await r.json();
      const full = new Uint8Array(Buffer.from(j.tx, "base64"));
      expect(missingSigners(full)).toEqual([]);
      expect(Buffer.from(parseWire(full).message).equals(Buffer.from(parseWire(partial).message))).toBe(true);
      expect(j.new_key).toBe(key);
    }
    expect(sent).toEqual([]);
    expect(w.res.get(a)?.signs).toBe(2);
  });

  test("the reserved key signs nothing else: every refusal", async () => {
    const w = world();
    const { post } = handler(w);
    const a = generateAgentKey().id, other = generateAgentKey().id;
    const key = (await (await post(a, { reserve: true })).json()).new_key as string;
    const otherKey = (await (await post(other, { reserve: true })).json()).new_key as string;
    const refused = async (wire: Uint8Array, why: RegExp, agent = a) => {
      const r = await post(agent, { tx: b64(wire), sign_only: true });
      expect(r.status).toBe(400);
      expect((await r.json()).message).toMatch(why);
    };
    // another agent's record, with this agent's key
    await refused(ownerSigned([rotate(other, key)]), /not the record of/);
    // this agent's record, to another reserved key (asked under this agent)
    await refused(ownerSigned([rotate(a, otherKey)]), /not a signer/);
    // register (would make the runtime's key an agent of the caller's)
    const mint = generateAgentKey().id;
    await refused(ownerSigned([registry.register({ owner: owner.id, agent: key, mint, ownerToken: ata(owner.id, mint), operator: new Uint8Array(32), capabilities: new Uint8Array(32) } as any)]), /only rotate_agent_key/);
    // the rotation plus anything else
    await refused(ownerSigned([rotate(a, key), system.transfer(owner.id, key, 1n)]), /refusing to co-sign/);
    await refused(ownerSigned([rotate(a, key), rotate(other, key)]), /refusing/);
    // the owner has not signed
    await refused(unsignedWire(compileMessage(owner.id, [rotate(a, key)], DEVNET_GENESIS)), /has not signed/);
    // the runtime's key would pay
    await refused(unsignedWire(compileMessage(key, [rotate(a, key, key)], DEVNET_GENESIS)), /fee payer/);
    // and the key itself refuses to sign outside the firewall (a guarded key needs a ticket for the exact bytes)
    expect(() => signBytes(w.store.keyFor(a), new Uint8Array(40))).toThrow(/firewall/);
    // a v0 message that reads a lookup table hides accounts
    const table = { address: generateAgentKey().id, addresses: [registry.rotateAgentKey({ owner: owner.id, agent: a, newKey: key }).keys[0]!.pubkey] };
    await refused(ownerSigned([rotate(a, key)], owner, true, [table]), /lookup table/);
    expect(w.res.get(a)?.signs).toBe(0);
  });

  test("no reservation, no signature: an unknown agent, an expired reservation, a spent one, a bound agent", async () => {
    const w = world({ ttlS: 100, maxSigns: 1 });
    const { post } = handler(w);
    const a = generateAgentKey().id;
    const stranger = generateAgentKey();
    expect((await post(a, { tx: b64(ownerSigned([rotate(a, stranger.id)])), sign_only: true })).status).toBe(404);
    const key = (await (await post(a, { reserve: true })).json()).new_key as string;
    const wire = b64(ownerSigned([rotate(a, key)]));
    // sending needs the agent on chain: a reserved one is never sent from the runtime
    expect((await post(a, { tx: wire })).status).toBe(404);
    expect((await post(a, { tx: wire, sign_only: true })).status).toBe(200);
    const spent = await post(a, { tx: wire, sign_only: true });
    expect(spent.status).toBe(429);
    expect((await spent.json()).error).toBe("too_many_signs");
    w.now += 101;
    expect((await post(a, { tx: wire, sign_only: true })).status).toBe(404);
    // on chain and bound: nothing more to sign
    w.adopted.set(a, { key_id: key, status: "bound" });
    expect((await post(a, { tx: wire, sign_only: true })).status).toBe(409);
  });

  test("the firewall is the second lock: a reserved key whose agent it does not know signs nothing", async () => {
    const w = world();
    const { post } = handler(w);
    const a = generateAgentKey().id;
    const key = (await (await post(a, { reserve: true })).json()).new_key as string;
    // a firewall that knows no agent for any key (the reservation is not in its view)
    new AgentFirewall({ rpc: { getAccountInfo: async () => null } as any, dir: w.dir, identity: () => null }).install();
    const r = await post(a, { tx: b64(ownerSigned([rotate(a, key)])), sign_only: true });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/firewall/);
  });

  test("an agent on chain that waits for its owner can be co-signed for sending by the page, and still sent by the runtime", async () => {
    const w = world();
    const sent: string[] = [];
    const { post } = handler(w, sent);
    const a = generateAgentKey().id;
    w.hosted.add(a);
    const key = w.store.keyFor(a).id;
    const wire = b64(ownerSigned([rotate(a, key)]));
    expect((await post(a, { tx: wire, sign_only: true })).status).toBe(200);
    expect(sent).toEqual([]);
    expect(await (await post(a, { tx: wire })).json()).toEqual({ agent: a, new_key: key, signature: "sent1" });
    expect(sent).toEqual([`${key}|${a}`]);
  });
});

describe("GET /runtime/unbound/<wallet>", () => {
  test("lists only the waiting agents this wallet launched, reading each launcher once; never the bound ones or another wallet's", async () => {
    const { waitingOf, UNBOUND_MAX } = await import("../src/bind.ts");
    const me = generateAgentKey().id, them = generateAgentKey().id;
    const mk = (status: string) => ({ key_id: generateAgentKey().id, status, mint: generateAgentKey().id });
    const agents: Record<string, ReturnType<typeof mk>> = {};
    const launcher = new Map<string, string>();
    const add = (owner: string, status: string) => {
      const a = generateAgentKey().id;
      agents[a] = mk(status);
      launcher.set(a, owner);
      return a;
    };
    const mine = add(me, "awaiting_owner"), bound = add(me, "bound"), theirs = add(them, "awaiting_owner"), moved = add(me, "unbound");
    let reads = 0;
    const w = waitingOf({ agents: () => agents, launcherOf: async (a) => (reads++, launcher.get(a) ?? null) });
    const f = bindHandler({ host: world().host, send: async () => ({ signature: "s" }), waiting: w });
    const get = (wallet: string, method = "GET") => f(new Request(`http://x/runtime/unbound/${wallet}`, { method }));
    expect(await (await get(me)).json()).toEqual({ owner: me, agents: [{ agent: mine, new_key: agents[mine]!.key_id, mint: agents[mine]!.mint }] });
    expect((await (await get(them)).json()).agents.map((x: any) => x.agent)).toEqual([theirs]);
    expect((await (await get(generateAgentKey().id)).json()).agents).toEqual([]);
    expect(reads).toBe(2); // only the waiting ones are ever looked up, and only once
    void bound; void moved;
    // once bound it is gone from the list
    agents[mine]!.status = "bound";
    expect((await (await get(me)).json()).agents).toEqual([]);
    expect((await get("not-a-wallet")).status).toBe(400);
    expect((await get(me, "POST")).status).toBe(405);
    // a runtime without the read answers an empty list, and the list is capped
    const plain = bindHandler({ host: world().host, send: async () => ({ signature: "s" }) });
    expect(await (await plain(new Request(`http://x/runtime/unbound/${me}`))).json()).toEqual({ owner: me, agents: [] });
    for (let i = 0; i < UNBOUND_MAX + 5; i++) add(me, "awaiting_owner");
    expect((await (await get(me)).json()).agents).toHaveLength(UNBOUND_MAX);
    // a launcher the chain could not give is asked for again next time, never guessed
    const flaky = waitingOf({ agents: () => ({ x: mk("awaiting_owner") }), launcherOf: async () => { throw new Error("rpc"); } });
    expect(await flaky(me)).toEqual([]);
  });
});
