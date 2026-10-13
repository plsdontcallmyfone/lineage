// A hosted launch binds in the same wallet approval as the launch (docs/plans/SEAMLESS-BIND.md). The
// parts of it that touch no page state, so they are tested without a browser (apps/web/test/bind-plan.test.ts):
// the reservation of the runtime's key while the launch is built, the one more transaction the wallet
// approves with the launch (rotate_agent_key to that key, the launcher as owner and fee payer), the
// runtime's co-signature on it before anything is sent, and what is kept when that did not happen so
// the bind can still finish without asking the wallet again.
import { base64Encode, JITO_MAX_TXS, registry } from "../../../packages/chain/src/browser/index.ts";
import type { BundlePart, LeftPart } from "./chain.ts";

export const BIND_LABEL = "bind";
/** The compute limit the bind has always been sent with (it leaves room for a wallet's own guard instructions). */
export const BIND_UNITS = 200_000;
const TIMEOUT_MS = 8_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const base64Decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const post = (f: Fetch, agent: string, body: unknown) =>
  f(`/runtime/bind/${agent}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
const why = async (r: Response) => {
  const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  return j.message ?? j.error ?? `the hosted runtime answered HTTP ${r.status}`;
};

export interface RuntimeKey {
  agent: string;
  new_key: string;
  /** "reserved" before the launch; "awaiting_owner" or "bound" for an agent already on chain */
  status: string;
}

/**
 * The runtime's key for an agent that is about to be launched. Null when the runtime did not give one
 * (down, full, an older runtime): the launch is then built without the bind, which follows it as before.
 */
export async function reserveRuntimeKey(agent: string, f: Fetch = fetch): Promise<RuntimeKey | null> {
  try {
    const r = await post(f, agent, { reserve: true });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<RuntimeKey>;
    return typeof j.new_key === "string" && j.new_key.length >= 32 && typeof j.status === "string" ? { agent, new_key: j.new_key, status: j.status } : null;
  } catch {
    return null;
  }
}

/** The runtime's key and status for an agent on chain (GET); null when it is not a hosted launch there or the runtime did not answer. */
export async function runtimeKeyOf(agent: string, f: Fetch = fetch): Promise<RuntimeKey | null> {
  try {
    const r = await f(`/runtime/bind/${agent}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<RuntimeKey>;
    return typeof j.new_key === "string" && typeof j.status === "string" ? { agent, new_key: j.new_key, status: j.status } : null;
  } catch {
    return null;
  }
}

/** The runtime checks the wallet-signed bind, adds its key's signature and hands the wire back; it sends nothing. */
export async function runtimeCosign(agent: string, wire: Uint8Array, f: Fetch = fetch): Promise<Uint8Array> {
  const r = await post(f, agent, { tx: base64Encode(wire), sign_only: true });
  if (!r.ok) throw new Error(await why(r));
  const j = (await r.json()) as { tx?: unknown };
  if (typeof j.tx !== "string") throw new Error("the hosted runtime returned no transaction");
  return base64Decode(j.tx);
}

/** The runtime checks the wallet-signed bind, co-signs and sends it (the agent must be on chain); the transaction signature. */
export async function runtimeSend(agent: string, wire: Uint8Array, f: Fetch = fetch): Promise<{ signature: string; bound?: boolean }> {
  const r = await f(`/runtime/bind/${agent}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ tx: base64Encode(wire) }) });
  if (r.status === 409 && ((await r.clone().json().catch(() => ({}))) as { error?: string }).error === "already_bound") return { signature: "", bound: true };
  if (!r.ok) throw Object.assign(new Error(await why(r)), { status: r.status });
  return (await r.json()) as { signature: string };
}

/**
 * The bind as one more transaction of the launch approval: rotate_agent_key of `agent` to the runtime's
 * key, the launcher as owner and fee payer, co-signed by the runtime after the wallet signed. Optional
 * and last: a launch never fails or waits because of it. `v0`: the other transactions are v0 messages,
 * so this one is too (it reads no lookup table; the runtime co-signs nothing that does).
 */
export function bindPart(o: { owner: string; agent: string; newKey: string; v0?: boolean; cosign?: (agent: string, wire: Uint8Array) => Promise<Uint8Array> }): BundlePart {
  const cosign = o.cosign ?? runtimeCosign;
  return {
    ixs: [registry.rotateAgentKey({ owner: o.owner, agent: o.agent, newKey: o.newKey })],
    units: BIND_UNITS,
    label: BIND_LABEL,
    v0: !!o.v0,
    optional: true,
    cosign: { signer: o.newKey, sign: (wire) => cosign(o.agent, wire) },
  };
}

/**
 * The launch's parts with the bind after them. A mainnet bundle holds at most `max` transactions: when
 * the launch already fills it, the bind is still approved with the others but held back (wallet-signed,
 * for the runtime to co-sign and send right after the launch lands) instead of pushing the launch out
 * of its all-or-nothing bundle.
 */
export function withBind(parts: BundlePart[], bind: BundlePart, o: { mainnet: boolean; max?: number }): BundlePart[] {
  const full = o.mainnet && parts.length + 1 > (o.max ?? JITO_MAX_TXS);
  return [...parts, full ? { ...bind, cosign: undefined, hold: true } : bind];
}

// what the wallet already signed for an agent's bind, kept in this tab until it is sent or expires
const signedBinds = new Map<string, { wire: Uint8Array; newKey: string; lastValidBlockHeight: number }>();

/** After the launch was sent: keeps a bind the wallet signed but that did not go with it. Returns why it did not, or null when it did. */
export function keepSignedBind(agent: string, newKey: string, left: LeftPart[]): string | null {
  const l = left.find((x) => x.label === BIND_LABEL);
  if (!l) return null;
  if (l.partial) signedBinds.set(agent, { wire: l.partial, newKey, lastValidBlockHeight: l.lastValidBlockHeight });
  return l.why;
}

/** The kept wallet-signed bind for this agent and key, once (taken out of the store). */
export function takeSignedBind(agent: string, newKey: string): { wire: Uint8Array; lastValidBlockHeight: number } | null {
  const s = signedBinds.get(agent);
  signedBinds.delete(agent);
  return s && s.newKey === newKey ? s : null;
}

/** True for an error that means the person said no in the wallet: never retried automatically. */
export const declined = (e: unknown): boolean => (e as { code?: number })?.code === 4001 || /reject|denied|declin|cancel/i.test(String((e as Error)?.message ?? e));
