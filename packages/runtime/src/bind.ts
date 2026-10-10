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
// What the runtime co-signs is checked by `inspectForCosign` (only lineage_registry and compute budget
// instructions; this key never pays and is never writable; every other signature verifies; the
// rotation targets this agent's record) and further here: every registry instruction is
// rotate_agent_key to this agent's runtime key (never `register`, which would make the runtime key a
// verifier agent owned by whoever asked). The chain then requires the owner to be the agent's owner.
// The worst a caller can do is bind a hosted agent they own to this runtime, which is what a hosted
// launch is for; spend stays under the global cap, the per-agent epoch cap and the agent's vault.
import type { AgentKey } from "@lineage/protocol";
import { inspectForCosign } from "../../chain/src/cosign.ts";
import { ixDisc } from "../../chain/src/codec.ts";
import { REGISTRY_PROGRAM_ID } from "../../chain/src/registry.ts";
import { COMPUTE_BUDGET_PROGRAM } from "../../chain/src/tx.ts";
import { isAgentId } from "./state.ts";

export interface BindHost {
  /** The runtime key for a hosted agent, adopting it on demand; null when it is not a hosted launch. */
  bindTarget(agent: string): Promise<{ agent: string; new_key: string; status: string } | null>;
  /** The key of an agent this runtime already adopted. */
  keyOf(agent: string): AgentKey | null;
}

/** Co-signs a checked wire with `key`, simulates and sends it; the transaction signature. */
export type CosignSend = (key: AgentKey, txBase64: string, agent: string) => Promise<{ signature: string }>;

export const BIND_MAX_BODY = 8 * 1024;
const ROTATE = ixDisc("rotate_agent_key");

/** Refuses a wire that is not exactly a rotation of `agent` to `key` (plus compute budget). */
export function checkBindTx(wire: Uint8Array, key: string, agent: string): string[] {
  const plan = inspectForCosign(wire, key, { expectAgent: agent });
  let rotations = 0;
  for (const ix of plan.message.instructions) {
    if (ix.programId === COMPUTE_BUDGET_PROGRAM) continue;
    if (ix.programId !== REGISTRY_PROGRAM_ID || ix.data.length < 8 || !ROTATE.every((b, i) => b === ix.data[i])) throw new Error("refusing to co-sign: only rotate_agent_key binds a hosted agent");
    rotations++;
  }
  if (rotations !== 1) throw new Error(`refusing to co-sign: expected one rotate_agent_key, got ${rotations}`);
  return [...plan.summary, `fee payer (wallet) ${plan.payer}`];
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function bindHandler(o: { host: BindHost; send: CosignSend; log?: (m: string) => void }) {
  const log = o.log ?? (() => {});
  // one send per agent at a time (a double click must not race two co-signs)
  const busy = new Set<string>();
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const m = /^\/runtime\/bind\/([^/]+)$/.exec(url.pathname);
    if (url.pathname === "/runtime/health") return json(200, { ok: true });
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
    try {
      tx = String((JSON.parse(new TextDecoder().decode(raw)) as { tx?: unknown }).tx ?? "");
      if (!/^[A-Za-z0-9+/=]{100,4000}$/.test(tx)) throw new Error();
    } catch {
      return json(400, { error: "bad_body", message: "{ tx: <base64 wire> } expected" });
    }
    const t = await o.host.bindTarget(agent).catch(() => undefined);
    if (t === undefined) return json(503, { error: "chain_unavailable" });
    if (!t) return json(404, { error: "not_hosted", message: "not a hosted launched agent" });
    if (t.status === "bound") return json(409, { error: "already_bound", message: "this agent already speaks with this runtime's key", new_key: t.new_key });
    const key = o.host.keyOf(agent);
    if (!key || key.id !== t.new_key) return json(500, { error: "no_key" });
    let summary: string[];
    try {
      summary = checkBindTx(new Uint8Array(Buffer.from(tx, "base64")), key.id, agent);
    } catch (e) {
      return json(400, { error: "refused", message: (e as Error).message });
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
export function chainCosign(rpcUrl: string, log: (m: string) => void): CosignSend {
  return async (key, tx, agent) => {
    const { cosignCommand } = await import("../../chain/src/cosign.ts");
    const r = await cosignCommand({ key, tx, rpcUrl, expectAgent: agent, log: (m) => log(`  ${m}`) });
    return { signature: r.signature };
  };
}

/** Serves the bind endpoints on 127.0.0.1 (the site gate forwards /runtime/bind/* here). */
export function serveBind(port: number, handler: (req: Request) => Promise<Response>, log: (m: string) => void) {
  const s = Bun.serve({ port, hostname: "127.0.0.1", fetch: handler });
  log(`bind endpoint on http://127.0.0.1:${s.port}/runtime/bind/<agent>`);
  return s;
}
