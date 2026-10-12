// Whether "A units account" can be sold right now (owner direction 2026-10-12: an account is given to
// exactly one agent, and a launch must not pay for one when none is free).
//
// The launch wizard offers the option when GET /v1/config names a recipient for its payment
// (network.prepay.identity_account_recipient) and disables it, with "not offered here", when that is
// null. A SOL transfer in a launch cannot be taken back, so Core hides the recipient there while the
// identity service has no free account: it reads the service's GET /identity/pool over loopback
// (UNITS_IDENTITY_URL, the same base the revenue records use) every 15 seconds and serves the prepay
// block with identity_account_recipient null and identity_account_unavailable set to the reason when
//   - the pool has no account on offer (`offer` false: none available, or the free ones are owed to
//     launches that already paid), or
//   - the service has not answered for STALE_MS (it cannot hand out an account while it is down).
// Core's own config is not changed: GET /v1/launch-fronting, the admin routes, the analytics and the
// identity service's payment check (which reads /v1/launch-fronting) keep the configured recipient,
// so a launch that paid a moment before the pool ran out is still recognised as paid.
// Without UNITS_IDENTITY_URL (a local Core with no identity service) nothing is hidden.

import type { Core } from "./core.ts";

export const STALE_MS = 5 * 60_000;
export const SAMPLE_MS = 15_000;

export interface PoolCounts {
  available: number;
  offer: boolean;
  low: boolean;
  waiting_paid: number;
}

/** GET /identity/pool as Core understands it, or null. */
export function parsePool(v: unknown): PoolCounts | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.available !== "number" || !Number.isFinite(o.available) || typeof o.offer !== "boolean") return null;
  return { available: o.available, offer: o.offer, low: o.low === true, waiting_paid: typeof o.waiting_paid === "number" ? o.waiting_paid : 0 };
}

const instances = new WeakMap<Core, IdentityOffer>();
export function identityOfferOf(core: Core): IdentityOffer {
  let m = instances.get(core);
  if (!m) instances.set(core, (m = new IdentityOffer()));
  return m;
}

export class IdentityOffer {
  /** the identity service's base URL; null: this Core has none and hides nothing */
  url: string | null = null;
  private last: { pool: PoolCounts; at: number } | null = null;
  private lastError: string | null = null;

  constructor(private now: () => number = Date.now) {}

  record(pool: PoolCounts) {
    this.last = { pool, at: this.now() };
    this.lastError = null;
  }

  async sample(fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; error?: string }> {
    if (!this.url) return { ok: true };
    try {
      const r = await fetchImpl(`${this.url.replace(/\/+$/, "")}/identity/pool`, { signal: AbortSignal.timeout(5_000) });
      if (!r.ok) throw new Error(`answered ${r.status}`);
      const p = parsePool(await r.json());
      if (!p) throw new Error("answer not understood");
      this.record(p);
      return { ok: true };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return { ok: false, error: this.lastError };
    }
  }

  /** Why the option cannot be sold now, or null when it can (or when this Core watches no identity service). */
  unavailable(): string | null {
    if (!this.url) return null;
    if (!this.last || this.now() - this.last.at > STALE_MS) return "the units account service is not answering right now";
    if (!this.last.pool.offer) return "no units account is free right now";
    return null;
  }

  /** The network config as GET /v1/config serves it: the prepay block without a recipient while no account can be sold. */
  view(network: Record<string, unknown>): Record<string, unknown> {
    const why = this.unavailable();
    const p = network.prepay as Record<string, unknown> | null | undefined;
    if (!why || !p || !p.identity_account_recipient) return network;
    return { ...network, prepay: { ...p, identity_account_recipient: null, identity_account_unavailable: why } };
  }

  status() {
    return { watching: !!this.url, unavailable: this.unavailable(), pool: this.last?.pool ?? null, read_at: this.last ? Math.floor(this.last.at / 1000) : null, error: this.lastError };
  }
}
