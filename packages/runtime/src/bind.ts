// Automatic binding of hosted launches (launch e2e lane). A hosted agent only authors once its owner
// rotated its signing key to the key this runtime made for it (identity plan I1): `rotate_agent_key`
// needs the owner's signature and the new key's. Before this file the new key co-signed by hand on the
// server (`lineage-runtime cosign`). Now the Wallet page does it right after a hosted launch:
//
//   GET  /runtime/bind/<agent>   { agent, new_key, status }: the runtime key for a hosted agent (made
//                                at once when the agent is a hosted launch on chain and the runtime has
//                                not discovered it yet); 404 for anything else
//   POST /runtime/bind/<agent>   { tx: base64 }: a legacy rotate_agent_key the owner's wallet signed as
//                                fee payer, to exactly that key; the runtime co-signs and sends it
//
// A launch binds in the same wallet approval as the launch itself (docs/plans/SEAMLESS-BIND.md), so two
// more requests exist for an agent that is not on chain yet:
//
//   POST /runtime/bind/<agent>   { reserve: true }: the runtime key reserved for this agent id
//                                { agent, new_key, status: "reserved", expires_at } (reserve.ts: capped,
//                                per address, expiring); an agent already a hosted launch on chain answers
//                                as GET does; an id with any other record on chain is refused
//   POST /runtime/bind/<agent>   { tx: base64, sign_only: true }: the same rotation, checked the same way,
//                                co-signed and handed back ({ tx }) instead of sent: the page sends it with
//                                the launch transactions. Nothing can be simulated (the record does not
//                                exist until the launch lands), and nothing else is different.
//
//   GET  /runtime/unbound/<wallet>   { owner, agents: [{ agent, new_key, mint }] }: the hosted agents this
//                                wallet launched that still wait for their bind (at most 20). What the
//                                site's "finish setting up" bar asks on every page, so it is one cheap
//                                read of the runtime's own state; the page checks each against the chain.
//
// What the runtime co-signs is checked by `inspectForCosign` (only units_registry and compute budget
// instructions; this key never pays and is never writable; every other signature verifies; the
// rotation targets this agent's record) and further here: every registry instruction is
// rotate_agent_key to this agent's runtime key (never `register`, which would make the runtime key a
// verifier agent owned by whoever asked). The chain then requires the owner to be the agent's owner.
// The worst a caller can do is bind a hosted agent they own to this runtime, which is what a hosted
// launch is for; spend stays under the global cap, the per-agent epoch cap and the agent's vault.
import type { AgentKey } from "@units/protocol";
import { inspectForCosign } from "../../chain/src/cosign.ts";
import { ixDisc } from "../../chain/src/codec.ts";
import { REGISTRY_PROGRAM_ID } from "../../chain/src/registry.ts";
import { COMPUTE_BUDGET_PROGRAM } from "../../chain/src/tx.ts";
import type { Reservations } from "./reserve.ts";
import { isAgentId } from "./state.ts";

export interface BindHost {
  /** The runtime key for a hosted agent, adopting it on demand; null when it is not a hosted launch. */
  bindTarget(agent: string): Promise<{ agent: string; new_key: string; status: string } | null>;
  /** The key of an agent this runtime already adopted. */
  keyOf(agent: string): AgentKey | null;
}

/** Co-signs a checked wire with `key`, simulates and sends it; the transaction signature. */
export type CosignSend = (key: AgentKey, txBase64: string, agent: string) => Promise<{ signature: string }>;
/** Co-signs a checked wire with `key` and returns it (base64), unsent. */
export type CosignOnly = (key: AgentKey, txBase64: string, agent: string) => Promise<{ tx: string; signature: string }>;

/** What reserving needs beyond the bind host: the reservations and one chain read. */
export interface ReserveHost {
  reservations: Reservations;
  /** true when `agent` has a registry record on chain (of any kind). Throws when the chain did not answer. */
  recordExists(agent: string): Promise<boolean>;
  sign: CosignOnly;
}

/** A hosted agent that waits for its owner's bind. */
export interface WaitingAgent { agent: string; new_key: string; mint: string | null }
/** The waiting agents `owner` launched (the runtime's state, the launcher read from chain once per agent). */
export type WaitingOf = (owner: string) => Promise<WaitingAgent[]>;
export const UNBOUND_MAX = 20;

/** `WaitingOf` over the runtime's agents: those in `awaiting_owner` whose launcher is the wallet. Launchers are read once and kept. */
export function waitingOf(o: { agents(): Record<string, { key_id: string; status: string; mint: string | null }>; launcherOf(agent: string): Promise<string | null> }): WaitingOf {
  const launchers = new Map<string, string>();
  return async (owner) => {
    const out: WaitingAgent[] = [];
    for (const [agent, st] of Object.entries(o.agents())) {
      if (st.status !== "awaiting_owner") continue;
      let l = launchers.get(agent);
      if (l === undefined) {
        const read = await o.launcherOf(agent).catch(() => null);
        if (read) launchers.set(agent, (l = read));
      }
      if (l === owner) out.push({ agent, new_key: st.key_id, mint: st.mint });
      if (out.length >= UNBOUND_MAX) break;
    }
    return out;
  };
}

export const BIND_MAX_BODY = 8 * 1024;
const ROTATE = ixDisc("rotate_agent_key");

const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

/** Refuses a wire that is not exactly a rotation of `agent` to `key` (plus compute budget). */
export function checkBindTx(wire: Uint8Array, key: string, agent: string): string[] {
  const plan = inspectForCosign(wire, key, { expectAgent: agent });
  let rotations = 0;
  for (const ix of plan.message.instructions) {
    if (ix.programId === COMPUTE_BUDGET_PROGRAM) continue;
    // a wallet's own guard (Phantom adds Lighthouse assertions): it only checks state and can fail the transaction, it moves nothing
    if (ix.programId === LIGHTHOUSE_PROGRAM) continue;
    if (ix.programId !== REGISTRY_PROGRAM_ID || ix.data.length < 8 || !ROTATE.every((b, i) => b === ix.data[i])) throw new Error("refusing to co-sign: only rotate_agent_key binds a hosted agent");
    rotations++;
  }
  if (rotations !== 1) throw new Error(`refusing to co-sign: expected one rotate_agent_key, got ${rotations}`);
  return [...plan.summary, `fee payer (wallet) ${plan.payer}`];
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The caller's address as the site gate forwarded it (the last entry is the gate's own; the first is whatever the client sent). */
const callerOf = (req: Request): string | null => req.headers.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean).pop() ?? null;

export function bindHandler(o: { host: BindHost; send: CosignSend; reserve?: ReserveHost; waiting?: WaitingOf; log?: (m: string) => void }) {
  const log = o.log ?? (() => {});
  // one send per agent at a time (a double click must not race two co-signs)
  const busy = new Set<string>();
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const m = /^\/runtime\/bind\/([^/]+)$/.exec(url.pathname);
    if (url.pathname === "/runtime/health") return json(200, { ok: true });
    const u = /^\/runtime\/unbound\/([^/]+)$/.exec(url.pathname);
    if (u) {
      if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
      if (!isAgentId(u[1])) return json(400, { error: "bad_wallet", message: "not a wallet address" });
      return json(200, { owner: u[1], agents: o.waiting ? await o.waiting(u[1]!).catch(() => []) : [] });
    }
    if (!m) return json(404, { error: "not_found" });
    const agent = m[1]!;
    if (!isAgentId(agent)) return json(400, { error: "bad_agent", message: "not an agent id" });
    if (req.method === "GET") {
      const t = await o.host.bindTarget(agent).catch((e) => (log(`bind lookup ${agent}: ${(e as Error).message}`), undefined));
      if (t === undefined) return json(503, { error: "chain_unavailable", message: "could not read the launch from chain; try again" });
      if (!t) return json(404, { error: "not_hosted", message: "not a hosted launched agent" });
      return json(200, t);
    }
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const raw = await req.arrayBuffer();
    if (raw.byteLength > BIND_MAX_BODY) return json(413, { error: "too_large" });
    let tx: string;
    let body: { tx?: unknown; reserve?: unknown; sign_only?: unknown };
    try {
      body = JSON.parse(new TextDecoder().decode(raw)) as typeof body;
      if (!body || typeof body !== "object") throw new Error();
      tx = String(body.tx ?? "");
      if (body.reserve !== true && !/^[A-Za-z0-9+/=]{100,4000}$/.test(tx)) throw new Error();
    } catch {
      return json(400, { error: "bad_body", message: "{ tx: <base64 wire> } expected" });
    }
    const signOnly = body.sign_only === true;
    let t = await o.host.bindTarget(agent).catch(() => undefined);
    if (t === undefined) return json(503, { error: "chain_unavailable" });
    if (body.reserve === true) {
      // an agent that is already a hosted launch needs no reservation: its key and status, as GET
      if (t) return json(200, t);
      if (!o.reserve) return json(404, { error: "not_hosted", message: "not a hosted launched agent" });
      const exists = await o.reserve.recordExists(agent).catch(() => undefined);
      if (exists === undefined) return json(503, { error: "chain_unavailable", message: "could not read the chain; try again" });
      // a record that is not a hosted launch (self-hosted, a verifier, a removed launch): never this runtime's
      if (exists) return json(404, { error: "not_hosted", message: "not a hosted launched agent" });
      const r = o.reserve.reservations.reserve(agent, callerOf(req));
      if (!r.ok) return json(429, { error: r.why === "full" ? "reservations_full" : "too_many_reservations", message: "the hosted runtime is holding as many unlaunched agents as it takes; the launch still works and binds right after it" });
      return json(200, { agent, new_key: r.key.id, status: "reserved", expires_at: r.expires_at });
    }
    // not on chain yet: a reserved agent's rotation is co-signed for its launcher to send with the launch, never sent from here
    const reserved = !t && signOnly ? (o.reserve?.reservations.get(agent) ?? null) : null;
    if (reserved) t = { agent, new_key: reserved.key_id, status: "reserved" };
    if (!t) return json(404, { error: "not_hosted", message: "not a hosted launched agent" });
    if (t.status === "bound") return json(409, { error: "already_bound", message: "this agent already speaks with this runtime's key", new_key: t.new_key });
    const key = reserved ? o.reserve!.reservations.keyOf(agent) : o.host.keyOf(agent);
    if (!key || key.id !== t.new_key) return json(500, { error: "no_key" });
    let summary: string[];
    try {
      summary = checkBindTx(new Uint8Array(Buffer.from(tx, "base64")), key.id, agent);
    } catch (e) {
      return json(400, { error: "refused", message: (e as Error).message });
    }
    if (signOnly) {
      if (!o.reserve) return json(404, { error: "not_supported", message: "this runtime sends the bind itself" });
      if (reserved && !o.reserve.reservations.takeSign(agent)) return json(429, { error: "too_many_signs", message: "this reservation was co-signed as often as it may be; the bind follows the launch" });
      try {
        const r = await o.reserve.sign(key, tx, agent);
        log(`co-signed the bind of ${reserved ? "reserved" : "hosted"} agent ${agent} to runtime key ${key.id} for its launcher to send (${r.signature}); ${summary.join("; ")}`);
        return json(200, { agent, new_key: key.id, tx: r.tx, signature: r.signature });
      } catch (e) {
        const msg = (e as Error).message.split("\n")[0]!.slice(0, 300);
        log(`bind ${agent} not co-signed: ${msg}`);
        return json(400, { error: "refused", message: msg });
      }
    }
    if (busy.has(agent)) return json(409, { error: "busy", message: "a bind for this agent is being sent" });
    busy.add(agent);
    try {
      const r = await o.send(key, tx, agent);
      log(`bound hosted agent ${agent} to runtime key ${key.id} (owner-signed rotation co-signed and sent: ${r.signature}); ${summary.join("; ")}`);
      return json(200, { agent, new_key: key.id, signature: r.signature });
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!.slice(0, 300);
      log(`bind ${agent} not sent: ${msg}`);
      return json(400, { error: "not_sent", message: msg });
    } finally {
      busy.delete(agent);
    }
  };
}

/** The production sender: lineage-chain's devnet co-sign path (checks again, simulates, sends, confirms). */
export function chainCosign(rpcUrl: string, log: (m: string) => void, genesis?: string): CosignSend {
  return async (key, tx, agent) => {
    const { cosignCommand } = await import("../../chain/src/cosign.ts");
    const r = await cosignCommand({ key, tx, rpcUrl, expectAgent: agent, log: (m) => log(`  ${m}`), genesis });
    return { signature: r.signature };
  };
}

/** The production co-signer for `sign_only`: the same checks as the sender (cosign.ts cosignWire), nothing simulated or sent. */
export const chainCosignOnly: CosignOnly = async (key, tx, agent) => {
  const { cosignWire } = await import("../../chain/src/cosign.ts");
  const r = await cosignWire({ key, tx, expectAgent: agent });
  return { tx: Buffer.from(r.wire).toString("base64"), signature: r.signature };
};

/** Serves the bind endpoints on 127.0.0.1 (the site gate forwards /runtime/bind/* here). */
export function serveBind(port: number, handler: (req: Request) => Promise<Response>, log: (m: string) => void) {
  const s = Bun.serve({ port, hostname: "127.0.0.1", fetch: handler });
  log(`bind endpoint on http://127.0.0.1:${s.port}/runtime/bind/<agent>`);
  return s;
}
