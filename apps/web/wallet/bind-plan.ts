// A hosted launch binds in the same wallet approval as the launch (docs/plans/SEAMLESS-BIND.md). The
// parts of it that touch no page state, so they are tested without a browser (apps/web/test/bind-plan.test.ts):
// the reservation of the runtime's key while the launch is built, the one more transaction the wallet
// approves with the launch (rotate_agent_key to that key, the launcher as owner and fee payer), the
// runtime's co-signature on it before anything is sent, and what is kept when that did not happen so
// the bind can still finish without asking the wallet again.
import { base64Encode, computeBudget, JITO_MAX_TXS, nonce as nonceIx, registry } from "../../../packages/chain/src/browser/index.ts";
import type { BundlePart, LeftPart } from "./chain.ts";

export const BIND_LABEL = "bind";
/** The backup signature of the bind: a rotation over the reserved key's nonce account, kept by the hosted runtime (section 10). */
export const BACKUP_LABEL = "bind backup";
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
  /** the key's own nonce account and its stored value, when the key is from the runtime's pool: the backup signature is signed over it */
  nonce?: { account: string; value: string } | null;
}
const nonceOf = (j: { nonce?: unknown }): { account: string; value: string } | null => {
  const n = j.nonce as { account?: unknown; value?: unknown } | undefined;
  return n && typeof n.account === "string" && typeof n.value === "string" && n.account.length >= 32 && n.value.length >= 32 ? { account: n.account, value: n.value } : null;
};

/**
 * The runtime's key for an agent that is about to be launched. Null when the runtime did not give one
 * (down, full, an older runtime): the launch is then built without the bind, which follows it as before.
 */
export async function reserveRuntimeKey(agent: string, f: Fetch = fetch): Promise<RuntimeKey | null> {
  try {
    const r = await post(f, agent, { reserve: true });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<RuntimeKey>;
    return typeof j.new_key === "string" && j.new_key.length >= 32 && typeof j.status === "string" ? { agent, new_key: j.new_key, status: j.status, nonce: nonceOf(j) } : null;
  } catch {
    return null;
  }
}

/** A hosted launch could not get what its bind needs: nothing was built, signed or sent because of it. */
export class BindUnavailable extends Error {}
export const BIND_WAIT_LINE = "Getting the agent's runtime key…";
export const BIND_NO_KEY = "The hosted runtime did not give this agent its key, so the launch was not built. Nothing was signed or sent.";
export const BIND_NO_ANSWER = "The hosted runtime is not answering, so nothing was signed. Try again.";
export const BIND_NO_COSIGN = "The hosted runtime did not co-sign the agent's binding, so nothing was sent. Try again.";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The runtime's key for a hosted launch, REQUIRED (section 9): asked for again and again for `totalMs`
 * (the bind service restarts in well under a second; a full list frees slots as reservations expire),
 * `say` is told once that it is waiting. Throws BindUnavailable with `message` when there is still none.
 */
export async function reserveRequired(agent: string, o: { say?: (line: string) => void; totalMs?: number; gapMs?: number; message?: string; f?: Fetch; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}): Promise<RuntimeKey> {
  const now = o.now ?? Date.now;
  const until = now() + (o.totalMs ?? 20_000);
  for (let i = 0; ; i++) {
    const k = await reserveRuntimeKey(agent, o.f ?? fetch);
    if (k) return k;
    if (i === 0) o.say?.(BIND_WAIT_LINE);
    if (now() + (o.gapMs ?? 2_000) >= until) throw new BindUnavailable(o.message ?? BIND_NO_KEY);
    await (o.sleep ?? pause)(o.gapMs ?? 2_000);
  }
}

/** Whether a hosted launch can be bound right now (GET /runtime/bind/health); null when the answer could not be read. */
export async function bindHealth(f: Fetch = fetch): Promise<{ ok: boolean; backup: boolean } | null> {
  try {
    const r = await f("/runtime/bind/health", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = (await r.json()) as { ok?: unknown; backup?: { ok?: unknown } };
    return typeof j.ok === "boolean" ? { ok: j.ok, backup: j.backup?.ok === true } : null;
  } catch {
    return null;
  }
}
export const BIND_DOWN_LINE = "Hosted launches are paused for a moment: the hosted runtime is not handing out keys. You can fill in the form; Launch works again once it is back.";

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
export function bindPart(o: { owner: string; agent: string; newKey: string; v0?: boolean; cosign?: (agent: string, wire: Uint8Array) => Promise<Uint8Array>;
  /** the bind is required (section 9): without the wallet's and the runtime's signature on it nothing of the launch is sent */ required?: boolean }): BundlePart {
  const cosign = o.cosign ?? (o.required ? cosignRetrying : runtimeCosign);
  return {
    ixs: [registry.rotateAgentKey({ owner: o.owner, agent: o.agent, newKey: o.newKey })],
    units: BIND_UNITS,
    label: BIND_LABEL,
    v0: !!o.v0,
    optional: true,
    mustSign: !!o.required,
    cosign: { signer: o.newKey, sign: (wire) => cosign(o.agent, wire) },
  };
}

/**
 * The co-signature of a required bind: asked for again for `totalMs` while the runtime does not answer
 * (it never co-signs twice for nothing: the same bytes get the same signature). A refusal of the
 * transaction itself (400) is not retried. Throws BindUnavailable when there is still none.
 */
export async function cosignRetrying(agent: string, wire: Uint8Array, o: { totalMs?: number; gapMs?: number; f?: Fetch; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}): Promise<Uint8Array> {
  const now = o.now ?? Date.now;
  const until = now() + (o.totalMs ?? 20_000);
  for (;;) {
    let status = 0;
    try {
      const r = await post(o.f ?? fetch, agent, { tx: base64Encode(wire), sign_only: true });
      status = r.status;
      if (r.ok) {
        const j = (await r.json()) as { tx?: unknown };
        if (typeof j.tx === "string") return base64Decode(j.tx);
      } else if (status === 400) throw new BindUnavailable(`The hosted runtime refused the agent's binding (${await why(r)}), so nothing was sent.`);
    } catch (e) {
      if (e instanceof BindUnavailable) throw e;
    }
    if (now() + (o.gapMs ?? 1_500) >= until) throw new BindUnavailable(BIND_NO_COSIGN);
    await (o.sleep ?? pause)(o.gapMs ?? 1_500);
  }
}

/**
 * The backup signature (section 10): the same rotation signed over the reserved key's nonce account, so
 * it does not expire with the blockhash. AdvanceNonceAccount is its first instruction and nothing may
 * stand before it. The wallet signs it in the launch's approval; the runtime co-signs and KEEPS it and
 * sends it only if the agent is on chain without its bind. It is never sent from the page and costs
 * nothing unless it is used. Optional: a wallet that will not sign it, or changes it, leaves only this out.
 */
export function backupPart(o: { owner: string; agent: string; newKey: string; nonce: { account: string; value: string }; price?: number; v0?: boolean; cosign?: (agent: string, wire: Uint8Array) => Promise<Uint8Array> }): BundlePart {
  const cosign = o.cosign ?? runtimeCosign;
  return {
    ixs: [nonceIx.advance(o.nonce.account, o.newKey), computeBudget.limit(BIND_UNITS), computeBudget.price(o.price ?? 1), registry.rotateAgentKey({ owner: o.owner, agent: o.agent, newKey: o.newKey })],
    units: BIND_UNITS,
    raw: true,
    blockhash: o.nonce.value,
    label: BACKUP_LABEL,
    v0: !!o.v0,
    optional: true,
    keep: true,
    cosign: { signer: o.newKey, sign: (wire) => cosign(o.agent, wire) },
  };
}

// agents whose backup signature the runtime holds (this tab's knowledge: the launched screen says "nothing more to sign")
const backups = new Set<string>();
export const noteBackup = (agent: string, kept: string[]) => void (kept.includes(BACKUP_LABEL) && backups.add(agent));
export const hasBackup = (agent: string) => backups.has(agent);
export const BACKUP_WAIT_LINE = "Your agent will start as soon as the runtime is back. Nothing more to sign.";

/**
 * The launch's parts with the bind after them. A mainnet bundle holds at most `max` transactions: when
 * the launch already fills it, the bind is still approved with the others but held back (wallet-signed,
 * for the runtime to co-sign and send right after the launch lands) instead of pushing the launch out
 * of its all-or-nothing bundle.
 */
export function withBind(parts: BundlePart[], bind: BundlePart, o: { mainnet: boolean; max?: number }): BundlePart[] {
  const full = o.mainnet && parts.length + 1 > (o.max ?? JITO_MAX_TXS);
  // a required bind is co-signed before anything is sent even when the bundle is full (the runtime then holds it
  // too), and goes out by itself the moment the launch landed; an optional one is only kept wallet-signed, as before
  return [...parts, full ? (bind.mustSign ? { ...bind, hold: true } : { ...bind, cosign: undefined, hold: true }) : bind];
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
