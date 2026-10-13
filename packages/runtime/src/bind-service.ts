// The bind service (docs/plans/SEAMLESS-BIND.md section 9): the hosted runtime's bind surface as a small
// process of its own, so a hosted launch gets its runtime key and its co-signature while the runtime
// itself drains (up to 25 minutes at a deploy), restarts or is down. It serves exactly what bind.ts
// serves (the same handler, the same checks, the same transaction firewall) and nothing else:
//
//   GET, POST /runtime/bind/<agent>     key, reservation, co-signature, co-signed send (bind.ts)
//   GET       /runtime/unbound/<wallet> the hosted agents a wallet launched that wait for their bind
//   GET       /runtime/bind/health      whether a launch can be bound right now, and the counters
//
// What it holds and what it does not. It runs as the runtime's user on the runtime's state directory
// and shares the key store (<state_dir>/keys, keystore.ts: one file per agent, made once whichever
// process asks first). It reads a key only for the agent a request names, and signs with it only what
// the co-signer and the firewall allow: the rotation of that agent's record to that key. It never
// loads the runtime authority key, a model key or a provider key, never takes the runtime's lock, and
// never writes the runtime's state.json (it reads it for the waiting list). Its own files live in
// <state_dir>/bind-service (lock, status, the rotations it keeps, its firewall log); the reservations
// list stays <state_dir>/reservations.json and is this process's alone while it runs.
//
// The safety net: every rotation it co-signs for a launcher to send is kept (the wallet-signed wire,
// not the key). It then watches the chain for that agent: bound with the launch, nothing to do; a
// hosted launch on chain without the bind, it co-signs and sends the kept rotation itself, again and
// again until it lands or its blockhash is gone. So a tab closed right after the approval, a bundle
// that left the bind out and an ordered send that stopped before the bind all end bound.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { compileMessage, registry } from "@units/chain";
import { cosign as placeOwnSignature } from "../../chain/src/cosign.ts";
import { decodeMessage, parseWire, unsignedWire } from "../../chain/src/browser/wire.ts";
import { bindHandler, checkBindTx, serveBind, waitingOf, type BindHost, type CosignOnly, type CosignSend } from "./bind.ts";
import { keyFileIn, keyIfAny, keyOnce, keyStoreWritable } from "./keystore.ts";
import { Reservations, RESERVE_MAX } from "./reserve.ts";
import { isAgentId } from "./state.ts";

/** What the service reads from chain: one agent's record as far as binding goes. Throws when the chain did not answer. */
export interface BindChain {
  /** null: no registry record. hosted: a hosted launch (its mint and launcher). */
  record(agent: string): Promise<{ hosted: boolean; signingKey: string | null; mint: string | null; launcher: string | null } | null>;
  /** false once a transaction with this blockhash can no longer land */
  blockhashValid(blockhash: string): Promise<boolean>;
  /** any cheap read, for the health answer */
  ping(): Promise<void>;
}

export interface BindCounters {
  /** keys reserved for agents not on chain yet */
  reservations: number;
  /** rotations co-signed for a launcher to send with the launch */
  cosigns: number;
  /** kept rotations whose agent was bound the first time its record was read (the bind landed with the launch) */
  bound_with_launch: number;
  /** kept rotations whose agent was on chain unbound first and bound after (sent from here, or by the page right after) */
  bound_after: number;
  /** of those, the ones this service sent */
  sent_by_service: number;
  /** hosted launches seen on chain without their bind when nothing more could be sent for them (they wait for their owner's signature) */
  launches_unbound: number;
}
const ZERO: BindCounters = { reservations: 0, cosigns: 0, bound_with_launch: 0, bound_after: 0, sent_by_service: 0, launches_unbound: 0 };

export interface PendingBind {
  agent: string;
  key_id: string;
  /** the rotation as the wallet signed it (base64); the runtime key's signature is added when it is sent */
  tx: string;
  blockhash: string;
  added_at: number;
  /** when the agent's record was first read on chain as a hosted launch without the bind */
  seen_unbound_at: number | null;
  sends: number;
  last_error: string | null;
}

export const PENDING_MAX = RESERVE_MAX;
/** a kept rotation is never held longer than this, whatever the chain says about its blockhash */
export const PENDING_MAX_AGE_MS = 5 * 60_000;
/** the page sends the bind itself right after the launch; the service steps in when the launch has been on chain unbound this long */
export const SEND_GRACE_MS = 2_500;
/** a blockhash is asked about only after this (a node may not know a fresh one yet) */
const BLOCKHASH_CHECK_AFTER_MS = 30_000;

const writeAtomic = (file: string, body: unknown) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(body, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
};
const readJson = <T>(file: string): T | null => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

/**
 * The rotations kept for agents whose launch may land without them, and the loop that finishes them.
 * `tick()` is one pass (tests drive it by hand; `start()` runs it on a timer, one pass at a time).
 */
export class PendingBinds {
  private list = new Map<string, PendingBind>();
  private file: string;
  private now: () => number;
  private log: (m: string) => void;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** hosted launches left unbound (nothing more to send): agent -> key id, for the waiting list */
  readonly unbound = new Map<string, { key_id: string; mint: string | null }>();

  constructor(private o: { dir: string; chain: BindChain; send: CosignSend; keyOf(agent: string): AgentKey | null; counters: BindCounters; changed?: () => void; now?: () => number; log?: (m: string) => void; graceMs?: number }) {
    this.file = join(o.dir, "pending.json");
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    for (const p of readJson<PendingBind[]>(this.file) ?? []) if (p && isAgentId(p.agent) && typeof p.tx === "string" && typeof p.key_id === "string") this.list.set(p.agent, p);
  }

  private save() {
    try {
      writeAtomic(this.file, [...this.list.values()]);
    } catch (e) {
      this.log(`kept rotations not saved: ${(e as Error).message}`);
    }
    this.o.changed?.();
  }

  get size() {
    return this.list.size;
  }
  get(agent: string): PendingBind | null {
    return this.list.get(agent) ?? null;
  }

  /** Keeps a wallet-signed rotation of `agent` to `keyId` (checked by the caller). The newest one replaces an older one. */
  keep(agent: string, keyId: string, tx: string): boolean {
    if (!this.list.has(agent) && this.list.size >= PENDING_MAX) return false;
    let blockhash: string;
    try {
      blockhash = decodeMessage(parseWire(new Uint8Array(Buffer.from(tx, "base64"))).message).blockhash;
    } catch {
      return false;
    }
    this.list.set(agent, { agent, key_id: keyId, tx, blockhash, added_at: this.now(), seen_unbound_at: null, sends: 0, last_error: null });
    this.unbound.delete(agent);
    this.save();
    return true;
  }

  private drop(p: PendingBind) {
    if (this.list.get(p.agent) === p) this.list.delete(p.agent);
    this.save();
  }

  /** One pass over everything kept; never two at once. */
  tick(): Promise<void> {
    return (this.running ??= this.pass().finally(() => (this.running = null)));
  }

  private async pass(): Promise<void> {
    for (const p of [...this.list.values()]) {
      try {
        await this.one(p);
      } catch (e) {
        p.last_error = String((e as Error).message).split("\n")[0]!.slice(0, 200);
      }
    }
  }

  private async one(p: PendingBind): Promise<void> {
    const c = this.o.counters;
    const rec = await this.o.chain.record(p.agent);
    const age = this.now() - p.added_at;
    if (rec?.signingKey === p.key_id) {
      if (p.seen_unbound_at === null) c.bound_with_launch++;
      else c.bound_after++;
      this.log(`agent ${p.agent} is bound to ${p.key_id} (${p.seen_unbound_at === null ? "with its launch" : p.sends ? "sent from here after its launch" : "after its launch"})`);
      return this.drop(p);
    }
    if (rec && !rec.hosted) return this.drop(p); // a record that is not a hosted launch: never this runtime's
    const expired = age > PENDING_MAX_AGE_MS || (age > BLOCKHASH_CHECK_AFTER_MS && !(await this.o.chain.blockhashValid(p.blockhash)));
    if (!rec) {
      // the launch is not on chain; once the rotation's blockhash is gone neither can land (they share it)
      if (expired) this.drop(p);
      return;
    }
    // a hosted launch on chain without its bind
    if (p.seen_unbound_at === null) {
      p.seen_unbound_at = this.now();
      this.save();
    }
    if (expired) {
      // read once more: a bind that landed in the last block before the blockhash went is found here
      const again = await this.o.chain.record(p.agent);
      if (again?.signingKey === p.key_id) return;
      c.launches_unbound++;
      this.unbound.set(p.agent, { key_id: p.key_id, mint: rec.mint });
      this.log(`agent ${p.agent} was launched and is NOT bound: the rotation its launcher signed ran out of time (${p.sends} send(s)${p.last_error ? `, last: ${p.last_error}` : ""}). It waits for its owner's signature.`);
      return this.drop(p);
    }
    if (this.now() - p.seen_unbound_at < (this.o.graceMs ?? SEND_GRACE_MS)) return;
    const key = this.o.keyOf(p.agent);
    if (!key || key.id !== p.key_id) {
      p.last_error = "the runtime key for this agent is not in the key store";
      return;
    }
    p.sends++;
    try {
      const r = await this.o.send(key, p.tx, p.agent);
      c.sent_by_service++;
      p.last_error = null;
      this.log(`sent the kept rotation of ${p.agent} to ${p.key_id} (${r.signature}); its launch was on chain without it`);
    } catch (e) {
      // "already processed" is the page's own send of the same transaction: the next pass reads it as bound
      p.last_error = String((e as Error).message).split("\n")[0]!.slice(0, 200);
    }
    this.save();
  }

  start(everyMs = 1_500): () => void {
    this.timer ??= setInterval(() => void (this.list.size && this.tick()), everyMs);
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }
}

/** The runtime's agents that wait for their owner, as its state.json says (read only, re-read when the file changed). */
export function runtimeWaiting(stateDir: string): () => Record<string, { key_id: string; status: string; mint: string | null }> {
  const file = join(stateDir, "state.json");
  let at = -1;
  let last: Record<string, { key_id: string; status: string; mint: string | null }> = {};
  return () => {
    try {
      const m = statSync(file).mtimeMs;
      if (m !== at) {
        const s = JSON.parse(readFileSync(file, "utf8")) as { agents?: Record<string, { key_id: string; status: string; mint?: string | null }> };
        last = Object.fromEntries(Object.entries(s.agents ?? {}).map(([a, v]) => [a, { key_id: v.key_id, status: v.status, mint: v.mint ?? null }]));
        at = m;
      }
    } catch {
      /* no runtime state yet: nothing waits there */
    }
    return last;
  };
}

export interface BindServiceOptions {
  stateDir: string;
  chain: BindChain;
  send: CosignSend;
  sign: CosignOnly;
  /** the firewall's view is handed this: agent -> key id of every key this process may sign with */
  guard(view: () => Record<string, { key_id: string }>): void;
  mode: string;
  log?: (m: string) => void;
  now?: () => number;
  graceMs?: number;
}

/** The service without its listener: the handler, the kept rotations and the health answer (tests use it as it is). */
export function bindService(o: BindServiceOptions) {
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const own = join(o.stateDir, "bind-service");
  mkdirSync(own, { recursive: true, mode: 0o700 });
  const statusFile = join(own, "status.json");
  const started = now();
  const counters: BindCounters = { ...ZERO, ...(readJson<{ counters?: Partial<BindCounters> }>(statusFile)?.counters ?? {}) };
  /** agents read on chain as hosted launches: agent -> this runtime's key id, and the status last read */
  const known = new Map<string, { key_id: string; status: string; mint: string | null }>();
  let chainOkAt = 0;
  const chain: BindChain = {
    record: async (a) => {
      const r = await o.chain.record(a);
      chainOkAt = now();
      return r;
    },
    blockhashValid: (b) => o.chain.blockhashValid(b),
    ping: async () => {
      await o.chain.ping();
      chainOkAt = now();
    },
  };
  const keyFile = (a: string) => keyFileIn(o.stateDir, a);
  const host: BindHost = {
    async bindTarget(agent) {
      if (!isAgentId(agent)) return null;
      const rec = await chain.record(agent);
      if (!rec?.hosted) return null;
      const key = keyOnce(keyFile(agent));
      const status = rec.signingKey === key.id ? "bound" : "awaiting_owner";
      known.set(agent, { key_id: key.id, status, mint: rec.mint });
      return { agent, new_key: key.id, status };
    },
    // never makes one: only an agent this process read as a hosted launch
    keyOf: (agent) => (known.has(agent) ? keyIfAny(keyFile(agent)) : null),
  };
  let selfTest: { agent: string; key_id: string } | null = null;
  const unboundCounted = new Set<string>();
  const reservations = new Reservations({
    dir: o.stateDir,
    keyFor: (a) => keyOnce(keyFile(a)),
    keyFile,
    adopted: (a) => known.has(a),
    adopt: async (a) => {
      const t = await host.bindTarget(a);
      // a reserved agent that is a hosted launch without its bind and with nothing kept for it
      if (t && t.status !== "bound" && !pending.get(a) && !unboundCounted.has(a)) {
        unboundCounted.add(a);
        counters.launches_unbound++;
        saveStatus();
      }
      return !!t;
    },
    now: () => Math.floor(now() / 1000),
    log,
  });
  o.guard(() => ({ ...reservations.agents(), ...Object.fromEntries(known), ...(selfTest ? { [selfTest.agent]: { key_id: selfTest.key_id } } : {}) }));

  let saveQueued = false;
  function saveStatus() {
    if (saveQueued) return;
    saveQueued = true;
    queueMicrotask(() => {
      saveQueued = false;
      try {
        writeAtomic(statusFile, { pid: process.pid, started_at: new Date(started).toISOString(), updated_at: new Date(now()).toISOString(), counters, kept: pending.size, reservations_live: reservations.count() });
      } catch (e) {
        log(`status not saved: ${(e as Error).message}`);
      }
    });
  }
  const pending = new PendingBinds({ dir: own, chain, send: o.send, keyOf: (a) => keyIfAny(keyFile(a)), counters, changed: saveStatus, now, log, graceMs: o.graceMs });

  /** The co-signer end to end on a throwaway agent and key that exist only in memory: the checks, the firewall, the signature. */
  let cosignerOkAt = 0;
  async function cosignerWorks(): Promise<boolean> {
    // a co-signer that worked in the last minute is not asked again (each test is a line in the firewall's log)
    if (cosignerOkAt && now() - cosignerOkAt < 60_000) return true;
    const owner = generateAgentKey();
    const agent = generateAgentKey().id;
    const key = generateAgentKey();
    try {
      const msg = compileMessage(owner.id, [registry.rotateAgentKey({ owner: owner.id, agent, newKey: key.id })], "11111111111111111111111111111111");
      // the throwaway owner signs as a wallet would (an unguarded key that exists only here)
      const wire = placeOwnSignature(unsignedWire(msg), owner);
      checkBindTx(wire, key.id, agent);
      selfTest = { agent, key_id: key.id };
      const r = await o.sign(key, Buffer.from(wire).toString("base64"), agent);
      if (typeof r.tx !== "string" || !r.tx.length) return false;
      cosignerOkAt = now();
      return true;
    } catch (e) {
      log(`co-signer self-test failed: ${(e as Error).message.split("\n")[0]}`);
      return false;
    } finally {
      selfTest = null;
    }
  }

  let healthAt = 0;
  let healthLast: ({ ok: boolean } & Record<string, unknown>) | null = null;
  let healthRun: Promise<{ ok: boolean } & Record<string, unknown>> | null = null;
  async function healthNow() {
    const store = keyStoreWritable(o.stateDir);
    let listOk = true;
    try {
      writeAtomic(join(own, "probe.json"), { at: now() });
    } catch {
      listOk = false;
    }
    const cosigner = await cosignerWorks();
    if (now() - chainOkAt > 20_000) await Promise.race([chain.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4_000))]).catch(() => undefined);
    const chainOk = now() - chainOkAt <= 60_000;
    const live = reservations.count();
    const h = {
      ok: store && listOk && cosigner && chainOk && live < RESERVE_MAX,
      service: "bind",
      mode: o.mode,
      pid: process.pid,
      started_at: new Date(started).toISOString(),
      reserve: { ok: store && listOk && chainOk, live, max: RESERVE_MAX, full: live >= RESERVE_MAX },
      key_store: { ok: store },
      cosigner: { ok: cosigner },
      chain: { ok: chainOk, last_read_s: chainOkAt ? Math.round((now() - chainOkAt) / 1000) : null },
      kept: pending.size,
      counters: { ...counters },
    };
    healthAt = now();
    healthLast = h;
    return h;
  }
  /** At most one check every 3 s; callers in between get the last answer. */
  const health = () => (healthLast && now() - healthAt < 3_000 ? Promise.resolve(healthLast) : (healthRun ??= healthNow().finally(() => (healthRun = null))));

  const fromRuntime = runtimeWaiting(o.stateDir);
  const handler = bindHandler({
    host,
    send: async (key, tx, agent) => {
      const r = await o.send(key, tx, agent);
      // the page finished a bind itself (the launched screen, the setup bar): nothing is kept for it any more
      known.set(agent, { ...(known.get(agent) ?? { key_id: key.id, mint: null }), status: "bound" });
      pending.unbound.delete(agent);
      return r;
    },
    reserve: { reservations, recordExists: async (a) => !!(await chain.record(a)), sign: o.sign },
    waiting: waitingOf({
      agents: () => ({
        ...Object.fromEntries([...pending.unbound].map(([a, v]) => [a, { key_id: v.key_id, status: "awaiting_owner", mint: v.mint }])),
        ...Object.fromEntries([...known].filter(([, v]) => v.status === "awaiting_owner")),
        ...fromRuntime(),
      }),
      launcherOf: async (a) => (await chain.record(a))?.launcher ?? null,
    }),
    hooks: {
      health,
      count: (what) => {
        counters[what]++;
        saveStatus();
      },
      cosigned: (agent, keyId, tx) => {
        if (!pending.keep(agent, keyId, tx)) log(`rotation of ${agent} co-signed but not kept (${pending.size} kept already)`);
      },
    },
    log,
  });
  saveStatus();
  return { handler, pending, reservations, counters, health, host, statusFile };
}

/** `BindChain` over the registry reader (the same reads the runtime's backend makes for a hosted agent). */
export function readerChain(reader: { agent(a: string): Promise<{ kind: string; hosted: boolean; signingKey?: string | null; mint: string } | null>; agentLaunch(mint: string): Promise<{ agent: string; hosted: boolean; mint: string; launcher: string } | null> }, rpc: { call<T>(method: string, params: unknown[]): Promise<T>; getBlockHeight(): Promise<number> }): BindChain {
  return {
    async record(agent) {
      const rec = await reader.agent(agent);
      if (!rec) return null;
      if (rec.kind !== "launched" || !rec.hosted) return { hosted: false, signingKey: rec.signingKey ?? null, mint: null, launcher: null };
      const l = await reader.agentLaunch(rec.mint);
      if (!l || l.agent !== agent || !l.hosted) return { hosted: false, signingKey: rec.signingKey ?? null, mint: null, launcher: null };
      return { hosted: true, signingKey: rec.signingKey ?? null, mint: l.mint, launcher: l.launcher };
    },
    blockhashValid: async (b) => (await rpc.call<{ value: boolean }>("isBlockhashValid", [b, { commitment: "processed" }])).value,
    ping: async () => void (await rpc.getBlockHeight()),
  };
}

/** Starts the listener and the loop; the returned `stop` closes both. */
export function startBindService(o: BindServiceOptions & { port: number }) {
  const log = o.log ?? (() => {});
  const svc = bindService(o);
  const server = serveBind(o.port, svc.handler, log);
  const stopLoop = svc.pending.start();
  log(`bind service: ${svc.reservations.count()} reservation(s) live, ${svc.pending.size} rotation(s) kept; it loads no runtime authority key and no model key`);
  // a stop lets the requests in flight finish (a co-signature being made is handed back), for at most 2 s
  const stop = async () => {
    stopLoop();
    await Promise.race([server.stop(), new Promise((r) => setTimeout(r, 2_000))]);
    await server.stop(true);
  };
  return { ...svc, server, stop };
}
