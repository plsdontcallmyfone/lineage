// The bind service (docs/plans/SEAMLESS-BIND.md section 9): the bind surface as its own process. Its
// handler is the runtime's (bind.test.ts and bind-reserve.test.ts cover every refusal of that); here is
// what the service adds: the shared key store, the rotations it keeps and finishes by itself, the
// counters and the health answer, and that nothing of it needs the runtime process.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { AgentFirewall, compileMessage, registry, signBytes } from "@units/chain";
import { DEVNET_GENESIS } from "../../chain/src/browser/client.ts";
import { missingSigners, parseWire, placeSignature, unsignedWire } from "../../chain/src/browser/wire.ts";
import { resetGuardForTest } from "../../chain/src/guard.ts";
import { chainCosignOnly } from "../src/bind.ts";
import { bindService, PENDING_MAX_AGE_MS, runtimeWaiting, type BindChain } from "../src/bind-service.ts";
import { keyFileIn, keyIfAny, keyOnce } from "../src/keystore.ts";
import { RESERVE_MAX } from "../src/reserve.ts";
import { StateStore } from "../src/state.ts";

const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");
const dirs: string[] = [];
afterEach(() => {
  resetGuardForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Rec = { hosted: boolean; signingKey: string | null; mint: string | null; launcher: string | null };

/** A service over a stood-in chain and sender, the real co-signer and the real firewall. */
function world(o: { graceMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "units-bindsvc-"));
  dirs.push(dir);
  const w = {
    dir,
    now: 1_000_000,
    chain: new Map<string, Rec>(),
    chainDown: false,
    blockhashGone: false,
    sent: [] as { key: string; agent: string; tx: string }[],
    sendFails: null as string | null,
    logs: [] as string[],
    owner: generateAgentKey(),
  };
  const chain: BindChain = {
    record: async (a) => {
      if (w.chainDown) throw new Error("rpc down");
      return w.chain.get(a) ?? null;
    },
    blockhashValid: async () => !w.blockhashGone,
    ping: async () => {
      if (w.chainDown) throw new Error("rpc down");
    },
  };
  const make = () =>
    bindService({
      stateDir: dir, chain, mode: "devnet", now: () => w.now, graceMs: o.graceMs ?? 2_500, log: (m) => w.logs.push(m),
      sign: chainCosignOnly,
      send: async (key, tx, agent) => {
        if (w.sendFails) throw new Error(w.sendFails);
        w.sent.push({ key: key.id, agent, tx });
        // what the chain does with it: the record's signing key becomes the runtime's
        const r = w.chain.get(agent);
        if (r) r.signingKey = key.id;
        return { signature: `sig${w.sent.length}` };
      },
      guard: (view) => void new AgentFirewall({ rpc: { getAccountInfo: async () => null } as any, dir: join(dir, "bind-service"), identity: (key) => {
        for (const [agent, s] of Object.entries(view())) if (s.key_id === key) return { agent };
        return null;
      } }).install(),
    });
  let svc = make();
  const call = (method: string, path: string, body?: unknown, from = "7.7.7.7") => svc.handler(new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "x-forwarded-for": `1.1.1.1, ${from}` } }));
  const rotation = (agent: string, key: string, owner: AgentKey = w.owner) => {
    const msg = compileMessage(owner.id, [registry.rotateAgentKey({ owner: owner.id, agent, newKey: key })], DEVNET_GENESIS);
    return b64(placeSignature(unsignedWire(msg), owner.id, signBytes(owner, msg.bytes)));
  };
  /** reserve, sign with the wallet, co-sign: what the launch page does before it sends anything */
  const approve = async (agent = generateAgentKey().id) => {
    const r = (await (await call("POST", `/runtime/bind/${agent}`, { reserve: true })).json()) as { new_key: string };
    const tx = rotation(agent, r.new_key);
    const c = await call("POST", `/runtime/bind/${agent}`, { tx, sign_only: true });
    return { agent, key: r.new_key, tx, cosigned: (await c.json()) as { tx?: string; error?: string }, status: c.status };
  };
  /** the launch lands on chain (hosted), with or without the bind */
  const land = (agent: string, signingKey: string | null = "agentkey") => w.chain.set(agent, { hosted: true, signingKey, mint: "mint1", launcher: w.owner.id });
  return { w, get svc() { return svc; }, restart: () => (resetGuardForTest(), (svc = make())), call, rotation, approve, land };
}

describe("key store shared by the runtime and the bind service", () => {
  test("the same file whichever asks first; a key is never overwritten; no temporary file is left", () => {
    const dir = mkdtempSync(join(tmpdir(), "units-keystore-"));
    dirs.push(dir);
    const agent = generateAgentKey().id;
    const store = new StateStore(dir, { mode: "devnet", runtime: generateAgentKey().id, now: 0 });
    const viaService = keyOnce(keyFileIn(dir, agent));
    expect(store.keyFor(agent).id).toBe(viaService.id);
    expect(store.keyFile(agent)).toBe(keyFileIn(dir, agent));
    const other = generateAgentKey().id;
    expect(keyOnce(keyFileIn(dir, other)).id).toBe(store.keyFor(other).id);
    expect(readdirSync(join(dir, "keys")).sort()).toEqual([`${agent}.json`, `${other}.json`].sort());
    expect(statSync(keyFileIn(dir, agent)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700);
    expect(keyIfAny(keyFileIn(dir, generateAgentKey().id))).toBeNull();
    expect(() => keyFileIn(dir, "../../etc/passwd")).toThrow(/not an agent id/);
  });

  test("two processes making the same agent's key at the same moment end with one key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "units-keystore-"));
    dirs.push(dir);
    const agent = generateAgentKey().id;
    const src = `import { keyOnce, keyFileIn } from ${JSON.stringify(join(import.meta.dir, "../src/keystore.ts"))}; await new Promise((r) => setTimeout(r, Math.max(0, ${Date.now() + 700} - Date.now()))); console.log(keyOnce(keyFileIn(${JSON.stringify(dir)}, ${JSON.stringify(agent)})).id);`;
    const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", src], { stdout: "pipe", stderr: "pipe" }));
    const ids = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(keyIfAny(keyFileIn(dir, agent))!.id);
    expect(readdirSync(join(dir, "keys"))).toEqual([`${agent}.json`]);
  });
});

describe("bind service: reserve and co-sign with no runtime process", () => {
  test("a reservation and its co-signature need nothing but the state directory and the chain", async () => {
    const x = world();
    const a = await x.approve();
    expect(a.status).toBe(200);
    expect(missingSigners(new Uint8Array(Buffer.from(a.cosigned.tx!, "base64")))).toEqual([]);
    expect(existsSync(join(x.w.dir, "state.json"))).toBe(false); // the runtime never ran here
    expect(existsSync(join(x.w.dir, "runtime.lock"))).toBe(false);
    expect(x.svc.counters.reservations).toBe(1);
    expect(x.svc.counters.cosigns).toBe(1);
    // asking again is not a second reservation
    await x.call("POST", `/runtime/bind/${a.agent}`, { reserve: true });
    expect(x.svc.counters.reservations).toBe(1);
  });

  test("a restart of the service keeps the reservations, the kept rotations and the counters", async () => {
    const x = world();
    const a = await x.approve();
    await new Promise((r) => setTimeout(r, 5)); // the status is written in a microtask
    x.restart();
    expect(x.svc.reservations.get(a.agent)?.key_id).toBe(a.key);
    expect(x.svc.pending.get(a.agent)?.tx).toBe(a.tx);
    expect(x.svc.counters).toMatchObject({ reservations: 1, cosigns: 1 });
    // and co-signs the same reservation again
    const c = await x.call("POST", `/runtime/bind/${a.agent}`, { tx: a.tx, sign_only: true });
    expect(c.status).toBe(200);
  });

  test("it signs nothing but the reserved agent's rotation to its own key", async () => {
    const x = world();
    const a = await x.approve();
    const b = await x.approve();
    // a's key asked to sign b's rotation, and a rotation to some other key
    expect((await x.call("POST", `/runtime/bind/${a.agent}`, { tx: x.rotation(b.agent, a.key), sign_only: true })).status).toBe(400);
    expect((await x.call("POST", `/runtime/bind/${a.agent}`, { tx: x.rotation(a.agent, generateAgentKey().id), sign_only: true })).status).toBe(400);
    // an id that was never reserved and is not on chain
    const stranger = generateAgentKey().id;
    expect((await x.call("POST", `/runtime/bind/${stranger}`, { tx: x.rotation(stranger, a.key), sign_only: true })).status).toBe(404);
    expect(existsSync(keyFileIn(x.w.dir, stranger))).toBe(false);
  });

  test("the chain not answering is a 503, never a key or a signature", async () => {
    const x = world();
    x.w.chainDown = true;
    const agent = generateAgentKey().id;
    expect((await x.call("POST", `/runtime/bind/${agent}`, { reserve: true })).status).toBe(503);
    expect((await x.call("GET", `/runtime/bind/${agent}`)).status).toBe(503);
    expect(existsSync(keyFileIn(x.w.dir, agent))).toBe(false);
  });
});

describe("bind service: the kept rotation finishes a bind by itself", () => {
  test("bound with the launch: nothing is sent, counted as landed with the launch", async () => {
    const x = world();
    const a = await x.approve();
    await x.svc.pending.tick(); // the launch is not on chain yet
    expect(x.svc.pending.size).toBe(1);
    x.land(a.agent, a.key);
    await x.svc.pending.tick();
    expect(x.w.sent).toEqual([]);
    expect(x.svc.pending.size).toBe(0);
    expect(x.svc.counters).toMatchObject({ bound_with_launch: 1, bound_after: 0, sent_by_service: 0, launches_unbound: 0 });
  });

  test("the launch landed without the bind (the tab was closed): the service sends the rotation the wallet signed", async () => {
    const x = world({ graceMs: 2_500 });
    const a = await x.approve();
    x.land(a.agent);
    await x.svc.pending.tick();
    expect(x.w.sent).toEqual([]); // the page sends it itself right after the launch: a short grace first
    x.w.now += 2_600;
    await x.svc.pending.tick();
    expect(x.w.sent).toEqual([{ key: a.key, agent: a.agent, tx: a.tx }]);
    await x.svc.pending.tick();
    expect(x.svc.pending.size).toBe(0);
    expect(x.svc.counters).toMatchObject({ bound_with_launch: 0, bound_after: 1, sent_by_service: 1, launches_unbound: 0 });
  });

  test("a send that fails is tried again on every pass until it lands", async () => {
    const x = world({ graceMs: 0 });
    const a = await x.approve();
    x.land(a.agent);
    x.w.sendFails = "simulation failed: BlockhashNotFound";
    await x.svc.pending.tick();
    await x.svc.pending.tick();
    expect(x.svc.pending.get(a.agent)).toMatchObject({ sends: 2, last_error: "simulation failed: BlockhashNotFound" });
    x.w.sendFails = null;
    await x.svc.pending.tick();
    await x.svc.pending.tick();
    expect(x.svc.pending.size).toBe(0);
    expect(x.svc.counters.bound_after).toBe(1);
  });

  test("the page's own send of the same transaction is found as bound, never counted as a failure", async () => {
    const x = world({ graceMs: 0 });
    const a = await x.approve();
    x.land(a.agent);
    x.w.sendFails = "transaction failed: already been processed";
    await x.svc.pending.tick();
    x.w.chain.get(a.agent)!.signingKey = a.key; // the page's send landed
    await x.svc.pending.tick();
    expect(x.svc.pending.size).toBe(0);
    expect(x.svc.counters).toMatchObject({ bound_after: 1, sent_by_service: 0, launches_unbound: 0 });
  });

  test("the blockhash ran out with the launch on chain unbound: counted, listed for its launcher, nothing more is sent", async () => {
    const x = world({ graceMs: 0 });
    const a = await x.approve();
    x.land(a.agent);
    x.w.sendFails = "simulation failed: BlockhashNotFound";
    await x.svc.pending.tick();
    x.w.now += 31_000;
    x.w.blockhashGone = true;
    await x.svc.pending.tick();
    expect(x.svc.pending.size).toBe(0);
    expect(x.svc.counters.launches_unbound).toBe(1);
    expect(x.w.logs.some((l) => l.includes("NOT bound"))).toBe(true);
    const list = (await (await x.call("GET", `/runtime/unbound/${x.w.owner.id}`)).json()) as { agents: { agent: string; new_key: string }[] };
    expect(list.agents).toEqual([{ agent: a.agent, new_key: a.key, mint: "mint1" } as any]);
    // the owner's later signature binds it through the same service, and it leaves the list
    const r = await x.call("POST", `/runtime/bind/${a.agent}`, { tx: x.rotation(a.agent, a.key) });
    expect(r.status).toBe(400); // the stood-in sender still fails
    x.w.sendFails = null;
    expect((await x.call("POST", `/runtime/bind/${a.agent}`, { tx: x.rotation(a.agent, a.key) })).status).toBe(200);
    expect(((await (await x.call("GET", `/runtime/unbound/${x.w.owner.id}`)).json()) as { agents: unknown[] }).agents).toEqual([]);
  });

  test("a launch that never landed: the kept rotation is dropped when its blockhash is gone, and nothing was sent", async () => {
    const x = world({ graceMs: 0 });
    await x.approve();
    x.w.now += 31_000;
    await x.svc.pending.tick();
    expect(x.svc.pending.size).toBe(1); // the blockhash still lives
    x.w.blockhashGone = true;
    await x.svc.pending.tick();
    expect(x.svc.pending.size).toBe(0);
    expect(x.w.sent).toEqual([]);
    expect(x.svc.counters).toMatchObject({ bound_with_launch: 0, bound_after: 0, launches_unbound: 0 });
  });

  test("nothing is kept longer than its ceiling, and a chain that does not answer drops nothing", async () => {
    const x = world({ graceMs: 0 });
    await x.approve();
    x.w.chainDown = true;
    x.w.now += PENDING_MAX_AGE_MS + 1;
    await x.svc.pending.tick();
    expect(x.svc.pending.size).toBe(1);
    x.w.chainDown = false;
    await x.svc.pending.tick();
    expect(x.svc.pending.size).toBe(0);
  });

  test("a record that is not a hosted launch is never sent a rotation", async () => {
    const x = world({ graceMs: 0 });
    const a = await x.approve();
    x.w.chain.set(a.agent, { hosted: false, signingKey: "other", mint: null, launcher: null });
    await x.svc.pending.tick();
    expect(x.w.sent).toEqual([]);
    expect(x.svc.pending.size).toBe(0);
  });
});

describe("bind service: health and counters", () => {
  test("healthy: the reserve path, the key store, the co-signer and the chain, with the counters", async () => {
    const x = world();
    await x.approve();
    const r = await x.call("GET", "/runtime/bind/health");
    expect(r.status).toBe(200);
    const h = (await r.json()) as any;
    expect(h).toMatchObject({ ok: true, service: "bind", reserve: { ok: true, live: 1, max: RESERVE_MAX }, key_store: { ok: true }, cosigner: { ok: true }, chain: { ok: true }, kept: 1 });
    expect(h.counters).toMatchObject({ reservations: 1, cosigns: 1 });
    // the self-test's throwaway agent and key left nothing in the key store
    expect(readdirSync(join(x.w.dir, "keys")).filter((f) => !f.startsWith(".")).length).toBe(1);
    expect((await x.call("POST", "/runtime/bind/health")).status).toBe(405);
  });

  test("the chain not answering is unhealthy (503): a launch could not get a key", async () => {
    const x = world();
    x.w.chainDown = true;
    x.w.now += 120_000;
    const r = await x.call("GET", "/runtime/bind/health");
    expect(r.status).toBe(503);
    expect(((await r.json()) as any)).toMatchObject({ ok: false, chain: { ok: false }, cosigner: { ok: true } });
  });

  test("the counters are in the status file the runtime's status command prints", async () => {
    const x = world();
    await x.approve();
    await new Promise((r) => setTimeout(r, 5));
    const s = JSON.parse(readFileSync(x.svc.statusFile, "utf8"));
    expect(s.counters).toMatchObject({ reservations: 1, cosigns: 1, bound_with_launch: 0, bound_after: 0, launches_unbound: 0 });
    expect(s.kept).toBe(1);
  });

  test("the waiting list also reads the runtime's state file, read only", async () => {
    const x = world();
    const agent = generateAgentKey().id;
    const file = join(x.w.dir, "state.json");
    writeFileSync(file, JSON.stringify({ agents: { [agent]: { key_id: "K", status: "awaiting_owner", mint: "m" } } }));
    const before = readFileSync(file, "utf8");
    expect(runtimeWaiting(x.w.dir)()).toEqual({ [agent]: { key_id: "K", status: "awaiting_owner", mint: "m" } });
    x.land(agent);
    const list = (await (await x.call("GET", `/runtime/unbound/${x.w.owner.id}`)).json()) as { agents: { agent: string }[] };
    expect(list.agents.map((y) => y.agent)).toEqual([agent]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

test("a co-signed rotation is the page's to send: it is the wallet's message with both signatures", async () => {
  const x = world();
  const a = await x.approve();
  const back = parseWire(new Uint8Array(Buffer.from(a.cosigned.tx!, "base64")));
  const sent = parseWire(new Uint8Array(Buffer.from(a.tx, "base64")));
  expect(Buffer.from(back.message).equals(Buffer.from(sent.message))).toBe(true);
});
