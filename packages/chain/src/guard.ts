import { bytesToHex, sha256, type Address } from "./codec.ts";

// The signing guard (docs/plans/AGENT-WALLET-SAFETY.md section 3.1). An agent's treasury key is
// "guarded": the one function that makes transaction signatures in this codebase (`signBytes` in
// tx.ts) signs a message with a guarded key only when the firewall has authorized exactly those
// bytes. Authorization leaves a single-use ticket keyed by key and message hash; signing consumes
// it. A guarded key with no firewall installed signs nothing (default deny), and there is no call
// that takes a key out of the set.
//
// This file has no dependency on the policy (firewall.ts) so that tx.ts can import it without a
// cycle; the policy is installed at process start with `installAuthorizer`.

/** Thrown before any signature exists. `rule` is the policy rule that refused. */
export class FirewallRefusal extends Error {
  constructor(
    readonly rule: string,
    readonly detail: string,
    readonly key: Address | null = null,
  ) {
    super(`firewall: ${rule}: ${detail}`);
    this.name = "FirewallRefusal";
  }
}

/** Decides one (key, message): resolves when the key may sign it, throws FirewallRefusal otherwise. */
export type Authorizer = (key: Address, message: Uint8Array) => Promise<void>;

const guarded = new Set<Address>();
let authorizer: Authorizer | null = null;
/** `${key}:${sha256(message)}` -> how many signatures are authorized and until when */
const tickets = new Map<string, { n: number; until: number }>();
const TICKET_MS = 120_000;

const ticketId = (key: Address, message: Uint8Array) => `${key}:${bytesToHex(sha256(message))}`;

/** Marks `key` as an agent treasury key: from now on it signs transactions only through the firewall. */
export function guardKey(key: Address): void {
  guarded.add(key);
}
export const isGuarded = (key: Address): boolean => guarded.has(key);
export const guardedKeys = (): Address[] => [...guarded];

/** Installs the process's firewall. Installing a second one replaces the first (a restart of the runtime in one process, tests). */
export function installAuthorizer(a: Authorizer | null): void {
  authorizer = a;
}
export const hasAuthorizer = (): boolean => authorizer !== null;

/**
 * Asks the firewall about `message` for every guarded key among `keys`, in order. Unguarded keys
 * (the runtime authority, a fee payer wallet, an escrow) pass through. Called by every sender right
 * before signing; throws FirewallRefusal and signs nothing when any guarded key is refused.
 */
export async function authorizeSigners(message: Uint8Array, keys: Address[]): Promise<void> {
  for (const k of new Set(keys)) {
    if (!guarded.has(k)) continue;
    if (!authorizer) throw new FirewallRefusal("no_firewall", "this key is guarded and no firewall is installed in this process", k);
    await authorizer(k, message);
    const id = ticketId(k, message);
    const cur = tickets.get(id);
    tickets.set(id, { n: (cur && cur.until > Date.now() ? cur.n : 0) + 1, until: Date.now() + TICKET_MS });
  }
  if (tickets.size > 256) for (const [id, t] of tickets) if (t.until <= Date.now()) tickets.delete(id);
}

/**
 * The check inside `signBytes`: an unguarded key passes; a guarded key needs an unused, unexpired
 * ticket for exactly these bytes. Synchronous on purpose: nothing can run between the check and the
 * signature.
 */
export function consumeTicket(key: Address, message: Uint8Array): void {
  if (!guarded.has(key)) return;
  const id = ticketId(key, message);
  const t = tickets.get(id);
  if (!t || t.until <= Date.now() || t.n <= 0) {
    tickets.delete(id);
    throw new FirewallRefusal("not_authorized", "a guarded key signs only a message the firewall authorized (no ticket for these bytes)", key);
  }
  if (--t.n <= 0) tickets.delete(id);
}

/** Tests only: forgets every guarded key, ticket and the installed firewall. Never called by a service. */
export function resetGuardForTest(): void {
  guarded.clear();
  tickets.clear();
  authorizer = null;
}
