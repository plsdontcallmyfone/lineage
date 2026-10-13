// The key pool and the backup bind signature (docs/plans/SEAMLESS-BIND.md section 10). The chain is
// stood in (scripts/launch-e2e/nonce-devnet.ts and bind-devnet.ts run the same rules on devnet); the
// key files, the co-signer and the transaction firewall are the real ones.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58Decode, base58Encode, generateAgentKey, type AgentKey } from "@units/protocol";
import { AgentFirewall, compileMessage, computeBudget, nonce, nonceAccountFor, registry, signBytes, system, type Ix } from "@units/chain";
import { DEVNET_GENESIS } from "../../chain/src/browser/client.ts";
import { decodeMessage, missingSigners, parseWire, placeSignature, unsignedWire } from "../../chain/src/browser/wire.ts";
import { resetGuardForTest } from "../../chain/src/guard.ts";
import { isAdvanceOf, withdrawOf } from "../../chain/src/nonce.ts";
import { chainCosignOnly } from "../src/bind.ts";
import { BACKUP_NO_LAUNCH_MS, bindService, type BindChain } from "../src/bind-service.ts";
import { keyFileIn, keyIfAny } from "../src/keystore.ts";
import { issuedKeys, PoolKeeper, poolNonceOf, poolPayer, poolStatus, readyPoolKeys, returnPoolKey, takePoolKey, type PoolChain } from "../src/pool.ts";
import { RESERVE_TTL_S } from "../src/reserve.ts";

const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");
const dirs: string[] = [];
afterEach(() => {
  resetGuardForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const RENT = 1_056_640n;
const value = (n: number) => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));

/** A chain that holds nonce accounts and registry records, a payer with a balance, and the pool over it. */
function world(o: { balance?: bigint; config?: Record<string, number>; graceMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "units-pool-"));
  dirs.push(dir);
  const payer = generateAgentKey();
  const w = {
    dir, payer, now: 1_000_000,
    balance: o.balance ?? 1_000_000_000n,
    nonces: new Map<string, { authority: string; value: string; lamports: bigint }>(),
    records: new Map<string, { hosted: boolean; signingKey: string | null; mint: string | null; launcher: string | null }>(),
    agents: {} as Record<string, { key_id: string }>,
    reserved: {} as Record<string, { key_id: string }>,
    sent: [] as { what: string; signers: string[] }[],
    binds: [] as { agent: string; key: string; nonce: string | null }[],
    sendFails: null as string | null,
    logs: [] as string[],
    owner: generateAgentKey(),
    n: 1,
  };
  const chain: PoolChain = {
    rent: async () => RENT,
    balance: async () => w.balance,
    accounts: async (list) => list.map((a) => {
      const n = w.nonces.get(a);
      if (!n) return null;
      const data = new Uint8Array(80);
      new DataView(data.buffer).setUint32(4, 1, true);
      data.set(base58Decode(n.authority), 8);
      data.set(base58Decode(n.value), 40);
      return { data, lamports: n.lamports, owner: "11111111111111111111111111111111" };
    }),
    send: async (ixs: Ix[], extra: AgentKey[]) => {
      if (w.sendFails) throw new Error(w.sendFails);
      // what the System program would do with it; a pool key signs through the firewall like every guarded key
      const msg = compileMessage(payer.id, ixs, DEVNET_GENESIS);
      for (const k of extra) {
        const { authorizeSigners } = await import("../../chain/src/guard.ts");
        await authorizeSigners(msg.bytes, [k.id]);
        signBytes(k, msg.bytes);
      }
      const parsed = decodeMessage(msg.bytes).instructions;
      if (ixs.length === 2 && ixs[1]!.data[0] === 6) {
        const authority = base58Encode(ixs[1]!.data.subarray(4));
        w.nonces.set(ixs[1]!.keys[0]!.pubkey, { authority, value: value(w.n++), lamports: RENT });
        w.balance -= RENT + 5_000n;
        w.sent.push({ what: "create", signers: [payer.id] });
      } else {
        const account = ixs[0]!.keys[0]!.pubkey;
        const n = w.nonces.get(account)!;
        const lamports = withdrawOf(parsed[0]!, account, payer.id, n.authority);
        if (lamports === null) throw new Error("not a withdrawal to the payer");
        w.nonces.delete(account);
        w.balance += lamports - 5_000n;
        w.sent.push({ what: "close", signers: [payer.id, ...extra.map((k) => k.id)] });
      }
      return `sig${w.sent.length}`;
    },
    signingKey: async (agent) => w.records.get(agent)?.signingKey ?? null,
  };
  const bindChain: BindChain = {
    record: async (a) => w.records.get(a) ?? null,
    blockhashValid: async () => true,
    ping: async () => {},
    nonce: async (a) => w.nonces.get(a) ?? null,
  };
  let fwInstalled = false;
  const firewall = (view: () => Record<string, { key_id: string }>, nonceOf: (k: string) => { account: string; payer: string } | null) => {
    fwInstalled = true;
    new AgentFirewall({ rpc: { getAccountInfo: async () => null } as any, dir: join(dir, "fw"), identity: (key) => {
      const n = nonceOf(key);
      for (const [agent, s] of Object.entries(view())) if (s.key_id === key) return { agent, nonce: n };
      return n ? { agent: null, nonce: n } : null;
    } }).install();
  };
  const keeper = () => new PoolKeeper({ stateDir: dir, payer: payer.id, chain, owners: { agents: () => w.agents, reserved: () => w.reserved }, config: o.config, now: () => w.now, log: (m) => w.logs.push(m) });
  const service = () => bindService({
    stateDir: dir, chain: bindChain, mode: "devnet", now: () => w.now, graceMs: o.graceMs ?? 0, log: (m) => w.logs.push(m),
    sign: chainCosignOnly,
    send: async (key, _tx, agent, n) => {
      if (w.sendFails) throw new Error(w.sendFails);
      w.binds.push({ agent, key: key.id, nonce: n ?? null });
      const r = w.records.get(agent);
      if (r) r.signingKey = key.id;
      // a durable rotation advances its nonce when it lands
      if (n) w.nonces.get(n)!.value = value(w.n++);
      return { signature: `bind${w.binds.length}` };
    },
    guard: firewall,
  });
  const sign = (ixs: Ix[], blockhash: string) => {
    const m = compileMessage(w.owner.id, ixs, blockhash);
    return b64(placeSignature(unsignedWire(m), w.owner.id, signBytes(w.owner, m.bytes)));
  };
  return { w, keeper, service, sign, firewall, get fwInstalled() { return fwInstalled; } };
}
const call = (svc: ReturnType<typeof bindService>, method: string, path: string, body?: unknown, from = "7.7.7.7") =>
  svc.handler(new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "x-forwarded-for": `1.1.1.1, ${from}` } }));

describe("key pool: filling, within its bounds", () => {
  test("fills to the target a few a pass, each key with its own nonce account, the payer its only signer", async () => {
    const x = world({ config: { target: 6, low: 3, cap: 10, per_pass: 4 } });
    const k = x.keeper();
    const a = await k.pass();
    expect(a).toMatchObject({ ok: true, ready: 4, alive: 4, made: 4, target: 6, low: 3, cap: 10, rent_lamports: RENT.toString(), locked_lamports: (RENT * 4n).toString() });
    // 4 ready is not under the low mark of 3: nothing more is made until some are taken
    expect((await k.pass()).made).toBe(0);
    const ids = readyPoolKeys(x.w.dir);
    expect(ids.length).toBe(4);
    for (const id of ids) {
      expect(x.w.nonces.get(nonceAccountFor(x.w.payer.id, id))).toMatchObject({ authority: id, lamports: RENT });
      expect(statSync(join(x.w.dir, "pool-keys", `${id}.json`)).mode & 0o777).toBe(0o600);
      expect(poolNonceOf(x.w.dir, id)).toEqual({ account: nonceAccountFor(x.w.payer.id, id), payer: x.w.payer.id });
    }
    expect(statSync(join(x.w.dir, "pool-keys")).mode & 0o777).toBe(0o700);
    expect(x.w.sent.every((s) => s.what === "create" && s.signers.length === 1 && s.signers[0] === x.w.payer.id)).toBe(true);
    expect(poolPayer(x.w.dir)).toBe(x.w.payer.id);
    expect(poolStatus(x.w.dir)?.ready).toBe(4);
    // a key that is not the pool's has no nonce account here
    expect(poolNonceOf(x.w.dir, generateAgentKey().id)).toBeNull();
  });

  test("never more alive than the cap, counting the ones handed out", async () => {
    const x = world({ config: { target: 4, low: 4, cap: 5, per_pass: 10 } });
    const k = x.keeper();
    await k.pass();
    expect(readyPoolKeys(x.w.dir).length).toBe(4);
    // three are handed out to agents that have not launched (reserved)
    for (let i = 0; i < 3; i++) {
      const agent = generateAgentKey().id;
      const key = takePoolKey(x.w.dir, agent)!;
      x.w.reserved[agent] = { key_id: key.id };
    }
    const s = await k.pass();
    expect(s).toMatchObject({ ready: 2, alive: 5, made: 1 });
    expect((await k.pass()).made).toBe(0);
    expect(x.w.nonces.size).toBe(5);
  });

  test("a payer that cannot fund a refill: nothing is made, and the status says so", async () => {
    const x = world({ balance: 50_000_000n + RENT, config: { payer_floor_lamports: 50_000_000 } });
    const s = await x.keeper().pass();
    expect(s.ok).toBe(false);
    expect(s.why).toContain("under its floor");
    expect(s.made).toBe(0);
    expect(x.w.sent).toEqual([]);
    expect(readyPoolKeys(x.w.dir)).toEqual([]);
  });

  test("a creation that fails leaves no key behind; an interrupted one is promoted or removed at the next pass", async () => {
    const x = world({ config: { target: 2, low: 2, cap: 4, per_pass: 2 } });
    x.w.sendFails = "node is behind";
    const s = await x.keeper().pass();
    expect(s).toMatchObject({ ok: false, made: 0, ready: 0 });
    expect(readdirSync(join(x.w.dir, "pool-keys")).filter((f) => f.endsWith(".json") && f !== "issued.json" && f !== "status.json")).toEqual([]);
    expect(issuedKeys(x.w.dir)).toEqual({});
    x.w.sendFails = null;
    expect((await x.keeper().pass()).ready).toBe(2);
  });

  test("another payer may not take over a pool: its nonce accounts are derived from the first one", async () => {
    const x = world();
    await x.keeper().pass();
    expect(() => new PoolKeeper({ stateDir: x.w.dir, payer: generateAgentKey().id, chain: {} as PoolChain, owners: { agents: () => ({}), reserved: () => ({}) } })).toThrow(/was made by payer/);
  });
});

describe("key pool: a key belongs to one agent", () => {
  test("taken: it IS the agent's key file, it leaves the pool, and a second agent gets another", async () => {
    const x = world({ config: { target: 3, low: 3, cap: 6, per_pass: 3 } });
    await x.keeper().pass();
    const [a, b] = [generateAgentKey().id, generateAgentKey().id];
    const ka = takePoolKey(x.w.dir, a)!, kb = takePoolKey(x.w.dir, b)!;
    expect(ka.id).not.toBe(kb.id);
    expect(keyIfAny(keyFileIn(x.w.dir, a))!.id).toBe(ka.id);
    expect(readyPoolKeys(x.w.dir)).not.toContain(ka.id);
    expect(readyPoolKeys(x.w.dir).length).toBe(1);
    // an agent that already has a key keeps it: no pool key is spent
    expect(takePoolKey(x.w.dir, a)).toBeNull();
    expect(readyPoolKeys(x.w.dir).length).toBe(1);
  });

  test("an empty pool gives nothing (the launch still binds in its bundle with an ordinary key)", () => {
    const x = world();
    expect(takePoolKey(x.w.dir, generateAgentKey().id)).toBeNull();
  });

  test("returned only when it never signed: back in the pool with its nonce account untouched", async () => {
    const x = world({ config: { target: 1, low: 1, cap: 2, per_pass: 1 } });
    await x.keeper().pass();
    const agent = generateAgentKey().id;
    const key = takePoolKey(x.w.dir, agent)!;
    const before = { ...x.w.nonces.get(nonceAccountFor(x.w.payer.id, key.id))! };
    expect(returnPoolKey(x.w.dir, agent, key.id)).toBe(true);
    expect(readyPoolKeys(x.w.dir)).toEqual([key.id]);
    expect(existsSync(keyFileIn(x.w.dir, agent))).toBe(false);
    expect(x.w.nonces.get(nonceAccountFor(x.w.payer.id, key.id))).toEqual(before);
    // a key that is not from the pool is never put into it
    expect(returnPoolKey(x.w.dir, agent, generateAgentKey().id)).toBe(false);
  });
});

describe("key pool: closing a nonce account, the rent back to the payer", () => {
  test("closed once its agent is bound; kept while the agent is launched and unbound or still reserved", async () => {
    const x = world({ config: { target: 3, low: 3, cap: 6, per_pass: 3 } });
    x.firewall(() => x.w.agents, (k) => poolNonceOf(x.w.dir, k));
    const k = x.keeper();
    await k.pass();
    const [bound, waiting, reserved] = [generateAgentKey().id, generateAgentKey().id, generateAgentKey().id];
    const kb = takePoolKey(x.w.dir, bound)!, kw = takePoolKey(x.w.dir, waiting)!, kr = takePoolKey(x.w.dir, reserved)!;
    x.w.agents[bound] = { key_id: kb.id };
    x.w.agents[waiting] = { key_id: kw.id };
    x.w.reserved[reserved] = { key_id: kr.id };
    x.w.records.set(bound, { hosted: true, signingKey: kb.id, mint: "m", launcher: "l" });
    x.w.records.set(waiting, { hosted: true, signingKey: "the launch key", mint: "m", launcher: "l" });
    const before = x.w.balance;
    const s = await k.pass();
    expect(s.closed).toBe(1);
    expect(x.w.nonces.has(nonceAccountFor(x.w.payer.id, kb.id))).toBe(false);
    expect(x.w.nonces.has(nonceAccountFor(x.w.payer.id, kw.id))).toBe(true);
    expect(x.w.nonces.has(nonceAccountFor(x.w.payer.id, kr.id))).toBe(true);
    const close = x.w.sent.filter((t) => t.what === "close");
    expect(close).toEqual([{ what: "close", signers: [x.w.payer.id, kb.id] }]);
    // the rent came back (less the fee); the refill of the same pass took 3 more
    expect(issuedKeys(x.w.dir)[kb.id]!.closed_at).toBe(x.w.now);
    expect(poolNonceOf(x.w.dir, kb.id)).toBeNull(); // from here it is an ordinary agent key
    expect(x.w.balance).toBe(before + RENT - 5_000n - 3n * (RENT + 5_000n));
  });

  test("a retired key (its reservation expired after it had co-signed) is closed too, and can sign nothing else", async () => {
    const x = world({ config: { target: 1, low: 1, cap: 2, per_pass: 1 }, graceMs: 0 });
    await x.keeper().pass();
    const svc = x.service();
    const agent = generateAgentKey().id;
    const r = (await (await call(svc, "POST", `/runtime/bind/${agent}`, { reserve: true })).json()) as { new_key: string; nonce: { account: string; value: string } };
    expect(r.nonce.account).toBe(nonceAccountFor(x.w.payer.id, r.new_key));
    const tx = x.sign([nonce.advance(r.nonce.account, r.new_key), computeBudget.limit(200_000), computeBudget.price(1), registry.rotateAgentKey({ owner: x.w.owner.id, agent, newKey: r.new_key })], r.nonce.value);
    expect((await call(svc, "POST", `/runtime/bind/${agent}`, { tx, sign_only: true })).status).toBe(200);
    // the launch never lands; the reservation expires: the key co-signed, so it is set aside, never given to another agent
    x.w.now += (RESERVE_TTL_S + 1) * 1000;
    await svc.reservations.sweep();
    expect(existsSync(join(x.w.dir, "expired-keys", `${agent}.json`))).toBe(true);
    expect(readyPoolKeys(x.w.dir)).not.toContain(r.new_key);
    const s = await x.keeper().pass();
    expect(s.closed).toBe(1);
    expect(x.w.nonces.has(r.nonce.account)).toBe(false);
    // and the backup signature it co-signed is dead with the account
    x.w.records.set(agent, { hosted: true, signingKey: "the launch key", mint: "m", launcher: x.w.owner.id });
    x.w.now += 10_000;
    await svc.pending.tick();
    expect(x.w.binds).toEqual([]);
  });

  test("the firewall lets a pool key close its own account to the payer and nothing else", async () => {
    const x = world({ config: { target: 1, low: 1, cap: 2, per_pass: 1 } });
    await x.keeper().pass();
    const id = readyPoolKeys(x.w.dir)[0]!;
    const key = keyIfAny(join(x.w.dir, "pool-keys", `${id}.json`))!;
    x.firewall(() => ({}), (k) => poolNonceOf(x.w.dir, k));
    const { authorizeSigners } = await import("../../chain/src/guard.ts");
    const acct = nonceAccountFor(x.w.payer.id, id);
    const m = (ixs: Ix[]) => compileMessage(x.w.payer.id, ixs, DEVNET_GENESIS).bytes;
    await authorizeSigners(m([nonce.withdraw(acct, x.w.payer.id, id, RENT)]), [id]);
    await expect(authorizeSigners(m([nonce.withdraw(acct, generateAgentKey().id, id, RENT)]), [id])).rejects.toThrow();
    await expect(authorizeSigners(m([nonce.advance(acct, id), registry.rotateAgentKey({ owner: x.w.payer.id, agent: generateAgentKey().id, newKey: id })]), [id])).rejects.toThrow();
    await expect(authorizeSigners(m([system.transfer(x.w.payer.id, id, 1n), nonce.withdraw(acct, x.w.payer.id, id, RENT)]), [id])).rejects.toThrow();
    // without the firewall's word a guarded key signs nothing at all
    expect(() => signBytes(key, m([nonce.withdraw(acct, x.w.payer.id, id, RENT + 1n)]))).toThrow();
  });
});

describe("bind service: the backup signature", () => {
  const launchWith = async (x: ReturnType<typeof world>, svc: ReturnType<typeof bindService>) => {
    const agent = generateAgentKey().id;
    const r = (await (await call(svc, "POST", `/runtime/bind/${agent}`, { reserve: true })).json()) as { new_key: string; nonce?: { account: string; value: string } };
    const rot = registry.rotateAgentKey({ owner: x.w.owner.id, agent, newKey: r.new_key });
    const budget = [computeBudget.limit(200_000), computeBudget.price(1)];
    const bind = x.sign([...budget, rot], DEVNET_GENESIS);
    const backup = r.nonce ? x.sign([nonce.advance(r.nonce.account, r.new_key), ...budget, rot], r.nonce.value) : null;
    return { agent, r, rot, budget, bind, backup };
  };
  const land = (x: ReturnType<typeof world>, agent: string, signingKey = "the launch key") => x.w.records.set(agent, { hosted: true, signingKey, mint: "mint1", launcher: x.w.owner.id });

  test("a reservation hands out a pool key with its nonce account and value; with no pool, an ordinary key and no nonce", async () => {
    const x = world({ config: { target: 2, low: 2, cap: 4, per_pass: 2 } });
    const svc = x.service();
    const none = await launchWith(x, svc);
    expect(none.r.nonce).toBeUndefined();
    await x.keeper().pass();
    const pooled = readyPoolKeys(x.w.dir);
    const some = await launchWith(x, svc);
    expect(pooled).toContain(some.r.new_key);
    expect(some.r.nonce).toEqual({ account: nonceAccountFor(x.w.payer.id, some.r.new_key), value: x.w.nonces.get(nonceAccountFor(x.w.payer.id, some.r.new_key))!.value });
    // asking again is the same key and the same nonce account
    const again = (await (await call(svc, "POST", `/runtime/bind/${some.agent}`, { reserve: true })).json()) as typeof some.r;
    expect(again).toMatchObject({ new_key: some.r.new_key, nonce: some.r.nonce });
    expect(((await (await call(svc, "GET", "/runtime/bind/health")).json()) as any).backup).toMatchObject({ ok: true, ready: 1 });
  });

  test("co-signed and kept; both signatures present; the bind in the bundle landed, so it is never sent", async () => {
    const x = world({ config: { target: 1, low: 1, cap: 2, per_pass: 1 } });
    await x.keeper().pass();
    const svc = x.service();
    const l = await launchWith(x, svc);
    const c = await call(svc, "POST", `/runtime/bind/${l.agent}`, { tx: l.backup, sign_only: true });
    expect(c.status).toBe(200);
    const wire = new Uint8Array(Buffer.from(((await c.json()) as { tx: string }).tx, "base64"));
    expect(missingSigners(wire)).toEqual([]);
    expect(isAdvanceOf(decodeMessage(parseWire(wire).message).instructions[0]!, l.r.nonce!.account, l.r.new_key)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.pending.backup(l.agent)).toMatchObject({ key_id: l.r.new_key, durable: l.r.nonce });
    expect(svc.counters.backups_kept).toBe(1);
    land(x, l.agent, l.r.new_key);
    await svc.pending.tick();
    expect(x.w.binds).toEqual([]);
    expect(svc.pending.backup(l.agent)).toBeNull();
    expect(svc.counters.bound_by_backup).toBe(0);
  });

  test("the launch landed without its bind and the ordinary signature ran out: the backup binds the agent, hours later", async () => {
    const x = world({ config: { target: 1, low: 1, cap: 2, per_pass: 1 } });
    await x.keeper().pass();
    let svc = x.service();
    const l = await launchWith(x, svc);
    await call(svc, "POST", `/runtime/bind/${l.agent}`, { tx: l.bind, sign_only: true });
    await call(svc, "POST", `/runtime/bind/${l.agent}`, { tx: l.backup, sign_only: true });
    await new Promise((r) => setTimeout(r, 5));
    land(x, l.agent);
    // nothing can be sent for three hours (the service is down, then its sender fails)
    x.w.sendFails = "the node did not answer";
    await svc.pending.tick();
    x.w.now += 3 * 3600_000;
    resetGuardForTest();
    svc = x.service(); // a restart in between: what was kept is still there
    expect(svc.pending.backup(l.agent)?.tx).toBe(l.backup!);
    await svc.pending.tick(); // the ordinary one is past its ceiling: dropped, the backup takes over
    expect(svc.pending.get(l.agent)).toBeNull();
    expect(svc.counters.launches_unbound).toBe(0);
    x.w.sendFails = null;
    x.w.now += 5_000; // the failed try's gap
    await svc.pending.tick();
    expect(x.w.binds).toEqual([{ agent: l.agent, key: l.r.new_key, nonce: l.r.nonce!.account }]);
    await svc.pending.tick();
    expect(svc.pending.backup(l.agent)).toBeNull();
    expect(svc.counters).toMatchObject({ bound_by_backup: 1, launches_unbound: 0 });
    // sending it again cannot happen: nothing is kept, and its nonce moved
    expect(x.w.nonces.get(l.r.nonce!.account)!.value).not.toBe(l.r.nonce!.value);
  });

  test("a failed send is tried again with growing gaps, never in a tight loop", async () => {
    const x = world({ config: { target: 1, low: 1, cap: 2, per_pass: 1 } });
    await x.keeper().pass();
    const svc = x.service();
    const l = await launchWith(x, svc);
    await call(svc, "POST", `/runtime/bind/${l.agent}`, { tx: l.backup, sign_only: true });
    await new Promise((r) => setTimeout(r, 5));
    land(x, l.agent);
    x.w.sendFails = "busy";
    await svc.pending.tick();
    await svc.pending.tick();
    await svc.pending.tick();
    expect(svc.pending.backup(l.agent)!.sends).toBe(1);
    x.w.now += 4_100;
    await svc.pending.tick();
    expect(svc.pending.backup(l.agent)!.sends).toBe(2);
  });

  test("the owner voided it (the nonce moved, or the account is gone): counted and listed, nothing is sent", async () => {
    for (const how of ["moved", "gone"] as const) {
      const x = world({ config: { target: 1, low: 1, cap: 2, per_pass: 1 } });
      await x.keeper().pass();
      const svc = x.service();
      const l = await launchWith(x, svc);
      await call(svc, "POST", `/runtime/bind/${l.agent}`, { tx: l.backup, sign_only: true });
      await new Promise((r) => setTimeout(r, 5));
      land(x, l.agent);
      if (how === "moved") x.w.nonces.get(l.r.nonce!.account)!.value = value(200);
      else x.w.nonces.delete(l.r.nonce!.account);
      await svc.pending.tick();
      await svc.pending.tick();
      expect(x.w.binds).toEqual([]);
      expect(svc.pending.backup(l.agent)).toBeNull();
      expect(svc.counters.launches_unbound).toBe(1);
      resetGuardForTest();
    }
  });

  test("a launch that never appeared: the backup is dropped after a quarter of an hour and its key retired by the reservation's expiry", async () => {
    const x = world({ config: { target: 1, low: 1, cap: 2, per_pass: 1 } });
    await x.keeper().pass();
    const svc = x.service();
    const l = await launchWith(x, svc);
    await call(svc, "POST", `/runtime/bind/${l.agent}`, { tx: l.backup, sign_only: true });
    await new Promise((r) => setTimeout(r, 5));
    x.w.now += BACKUP_NO_LAUNCH_MS + 1;
    await svc.pending.tick();
    expect(svc.pending.backup(l.agent)).toBeNull();
    expect(x.w.binds).toEqual([]);
  });

  test("refused: a backup over another key's nonce account, with another instruction, for another agent, or not signed over the stored value", async () => {
    const x = world({ config: { target: 2, low: 2, cap: 4, per_pass: 2 } });
    await x.keeper().pass();
    const svc = x.service();
    const a = await launchWith(x, svc), b = await launchWith(x, svc);
    const post = (agent: string, tx: string) => call(svc, "POST", `/runtime/bind/${agent}`, { tx, sign_only: true });
    const adv = nonce.advance(a.r.nonce!.account, a.r.new_key);
    // b's nonce account in a's rotation
    expect((await post(a.agent, x.sign([nonce.advance(b.r.nonce!.account, a.r.new_key), a.rot], b.r.nonce!.value))).status).toBe(400);
    // a transfer beside it, a second advance, the advance not first
    expect((await post(a.agent, x.sign([adv, a.rot, system.transfer(x.w.owner.id, a.agent, 1n)], a.r.nonce!.value))).status).toBe(400);
    expect((await post(a.agent, x.sign([adv, a.rot, adv], a.r.nonce!.value))).status).toBe(400);
    expect((await post(a.agent, x.sign([computeBudget.limit(200_000), adv, a.rot], a.r.nonce!.value))).status).toBe(400);
    // a's key asked to sign the rotation of b's record
    expect((await post(a.agent, x.sign([adv, registry.rotateAgentKey({ owner: x.w.owner.id, agent: b.agent, newKey: a.r.new_key })], a.r.nonce!.value))).status).toBe(400);
    // a withdrawal dressed as a bind
    expect((await post(a.agent, x.sign([nonce.withdraw(a.r.nonce!.account, x.w.owner.id, a.r.new_key, RENT), a.rot], a.r.nonce!.value))).status).toBe(400);
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.pending.backup(a.agent)).toBeNull();
    // well formed but signed over a value that is not the account's: co-signed (it can never land), not kept
    expect((await post(a.agent, x.sign([adv, a.rot], DEVNET_GENESIS))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.pending.backup(a.agent)).toBeNull();
    expect(x.w.logs.some((l) => l.includes("not signed over the current value"))).toBe(true);
  });

  test("an ordinary key (no pool) is refused any System instruction, as before", async () => {
    const x = world();
    const svc = x.service();
    const l = await launchWith(x, svc);
    const fake = nonceAccountFor(generateAgentKey().id, l.r.new_key);
    expect((await call(svc, "POST", `/runtime/bind/${l.agent}`, { tx: x.sign([nonce.advance(fake, l.r.new_key), l.rot], DEVNET_GENESIS), sign_only: true })).status).toBe(400);
  });
});
