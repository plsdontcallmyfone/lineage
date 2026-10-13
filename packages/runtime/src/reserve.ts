// Reserved runtime keys (docs/plans/SEAMLESS-BIND.md). A hosted launch binds in the same wallet
// approval as the launch itself, so the page needs the runtime's key for the agent BEFORE the agent
// exists on chain: it asks for a reservation while the launch is being built, puts a
// `rotate_agent_key` to that key next to the launch transactions, and the runtime co-signs it.
//
// A reservation is the key file the runtime would make for the agent anyway (state.ts keyFor, the same
// path), so when the launch lands discovery adopts the agent with exactly that key. Until then the key
// is guarded by the transaction firewall with this agent as its identity: it signs nothing but the
// rotation of this agent's record to itself (bind.ts checks that before the firewall does).
//
// Bounds: at most `max` live reservations, at most `perAddress` per caller address (the gate's
// forwarded address), each expiring `ttlS` after it was last asked for, at most `maxSigns` co-signs
// each. An expired reservation whose agent is a hosted launch on chain was adopted by then and is only
// dropped from the list. Any other expired reservation loses its key: deleted when the runtime never
// signed with it, moved to <state_dir>/expired-keys when it did (a rotation to it may have landed on a
// record that is not a hosted launch; nothing loads a key from there).
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKey } from "@units/protocol";
import { isAgentId } from "./state.ts";

export interface Reservation {
  key_id: string;
  reserved_at: number;
  expires_at: number;
  /** the caller's address as the gate forwarded it; null for a local caller */
  from: string | null;
  /** co-signs made with this key while reserved */
  signs: number;
}

export interface ReservationsOptions {
  /** the runtime's state directory (reservations.json, expired-keys/) */
  dir: string;
  /** the runtime's key for an agent, made once (state.ts StateStore.keyFor) */
  keyFor(agent: string): AgentKey;
  keyFile(agent: string): string;
  /** true when the runtime already holds this agent in its state (adopted) */
  adopted(agent: string): boolean;
  /** reads the chain: adopts the agent when it is a hosted launch and returns true; false when it is not one. Throws when the chain did not answer. */
  adopt(agent: string): Promise<boolean>;
  now?: () => number;
  ttlS?: number;
  max?: number;
  perAddress?: number;
  maxSigns?: number;
  /**
   * An expired reservation whose agent never launched and whose key never signed anything: true when the
   * caller took the key back (a pool key returns to the pool with its nonce account); the key file is then
   * left to the caller.
   */
  release?(agent: string, keyId: string): boolean;
  log?: (m: string) => void;
}

export const RESERVE_TTL_S = 15 * 60;
// 1,000 since the bind became required for a hosted launch (docs/plans/SEAMLESS-BIND.md 9.6): a full list now refuses launches
export const RESERVE_MAX = 1000;
export const RESERVE_PER_ADDRESS = 6;
// 16: one launch try takes two (the bind in the bundle and the backup signature)
export const RESERVE_MAX_SIGNS = 16;

export type ReserveResult = { ok: true; key: AgentKey; expires_at: number } | { ok: false; why: "full" | "address_full" };

export class Reservations {
  private file: string;
  private list: Record<string, Reservation> = {};
  private now: () => number;
  private ttl: number;
  private max: number;
  private perAddress: number;
  private maxSigns: number;
  private log: (m: string) => void;
  private sweeping: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  constructor(private o: ReservationsOptions) {
    this.file = join(o.dir, "reservations.json");
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.ttl = o.ttlS ?? RESERVE_TTL_S;
    this.max = o.max ?? RESERVE_MAX;
    this.perAddress = o.perAddress ?? RESERVE_PER_ADDRESS;
    this.maxSigns = o.maxSigns ?? RESERVE_MAX_SIGNS;
    this.log = o.log ?? (() => {});
    try {
      if (existsSync(this.file)) {
        const saved = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Reservation>;
        for (const [agent, r] of Object.entries(saved)) if (isAgentId(agent) && r && typeof r.key_id === "string" && Number.isFinite(r.expires_at)) this.list[agent] = { ...r, signs: Number(r.signs) || 0 };
      }
    } catch (e) {
      this.log(`reservations: ${this.file} not read (${(e as Error).message}); starting empty`);
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.list, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private live(agent: string): Reservation | null {
    const r = this.list[agent];
    return r && r.expires_at > this.now() && !this.o.adopted(agent) ? r : null;
  }

  /** How many reservations count against the caps right now. */
  count(from?: string | null): number {
    return Object.keys(this.list).filter((a) => this.live(a) && (from === undefined || this.list[a]!.from === from)).length;
  }

  /**
   * Reserves the runtime's key for `agent` (an id with no record on chain; the caller checked). Asking
   * again for the same agent returns the same key and pushes the expiry out; it never takes a second slot.
   */
  reserve(agent: string, from: string | null): ReserveResult {
    if (!isAgentId(agent)) throw new Error("not an agent id");
    void this.sweep();
    const now = this.now();
    const cur = this.live(agent);
    if (!cur) {
      if (this.count() >= this.max) return { ok: false, why: "full" };
      if (from !== null && this.count(from) >= this.perAddress) return { ok: false, why: "address_full" };
    }
    const key = this.o.keyFor(agent);
    // an expired entry not swept yet keeps its co-sign count: asking again never resets the bound
    const signs = this.list[agent]?.key_id === key.id ? this.list[agent]!.signs : 0;
    this.list[agent] = { key_id: key.id, reserved_at: cur?.reserved_at ?? now, expires_at: now + this.ttl, from: cur?.from ?? from, signs };
    this.save();
    if (!cur) this.log(`reserved runtime key ${key.id} for agent ${agent} (not on chain yet); expires in ${this.ttl} s; ${this.count()} of ${this.max} reservations`);
    return { ok: true, key, expires_at: now + this.ttl };
  }

  /** The live reservation of `agent`, or null (none, expired, or the agent was adopted since). */
  get(agent: string): Reservation | null {
    return isAgentId(agent) ? this.live(agent) : null;
  }

  /** The reserved key, only while the reservation is live. */
  keyOf(agent: string): AgentKey | null {
    const r = this.get(agent);
    if (!r) return null;
    const k = this.o.keyFor(agent);
    return k.id === r.key_id ? k : null;
  }

  /** Counts one co-sign against the reservation; false when it has none left (nothing is signed then). */
  takeSign(agent: string): boolean {
    const r = this.get(agent);
    if (!r || r.signs >= this.maxSigns) return false;
    r.signs++;
    this.save();
    return true;
  }

  /** agent -> key id of every reservation still listed: the transaction firewall's identity for a reserved key. */
  agents(): Record<string, { key_id: string }> {
    return Object.fromEntries(Object.entries(this.list).map(([a, r]) => [a, { key_id: r.key_id }]));
  }

  /**
   * Drops what expired or was adopted (see the header). One sweep at a time, and at most one more
   * waiting behind it (so a sweep asked for while one runs still sees what changed since); a chain read
   * that fails leaves the entry for the next one.
   */
  sweep(): Promise<void> {
    if (!this.sweeping) return (this.sweeping = this.sweepOnce().finally(() => (this.sweeping = null)));
    return (this.queued ??= this.sweeping.then(() => {
      this.queued = null;
      return this.sweep();
    }));
  }

  private async sweepOnce(): Promise<void> {
    const now = this.now();
    for (const [agent, r] of Object.entries(this.list)) {
      if (this.o.adopted(agent)) {
        delete this.list[agent];
        this.save();
        continue;
      }
      if (r.expires_at > now) continue;
      let hosted: boolean;
      try {
        hosted = await this.o.adopt(agent);
      } catch {
        continue;
      }
      // asked for again while the chain was being read: it is live again
      if (this.list[agent] !== r || r.expires_at > this.now()) continue;
      delete this.list[agent];
      this.save();
      if (hosted || this.o.adopted(agent)) continue;
      try {
        const file = this.o.keyFile(agent);
        if (!existsSync(file)) continue;
        if (r.signs === 0 && this.o.release?.(agent, r.key_id)) {
          this.log(`reservation for ${agent} expired (no hosted launch on chain); its key ${r.key_id} never signed and went back to the pool`);
          continue;
        }
        if (r.signs > 0) {
          const dir = join(this.o.dir, "expired-keys");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          renameSync(file, join(dir, `${agent}.json`));
        } else unlinkSync(file);
        this.log(`reservation for ${agent} expired (no hosted launch on chain); its key ${r.key_id} was ${r.signs > 0 ? "set aside" : "removed"}`);
      } catch (e) {
        this.log(`reservation for ${agent} expired; its key file was not removed: ${(e as Error).message}`);
      }
    }
  }
}
