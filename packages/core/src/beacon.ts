import type { Database } from "bun:sqlite";
import type { SlotBlock, SlotSource } from "@lineage/chain";
import { H } from "./protocol.ts";

// M2 slot-hash beacon (SPEC 10.3, plan W9a). In chain mode an assignment draw of (subject, round)
// does not use Core's clock: Core records a request, anchors it at the cluster's current slot read
// AFTER the request, and draws once the first produced slot at or after `anchor + lag` is finalized,
// from that block's hash:
//
//   beacon = H("slot-beacon", epoch_secret, subject, round, slot, blockhash)
//
// Neither Core nor an author can pick the hash: it did not exist when the draw was requested, and the
// epoch secret was committed (beacon_commit) before either. The secret keeps the draw private until
// the epoch is revealed (10.7). A slot read that fails or is not final yet is retried with backoff;
// the draw waits and is never made from a local random. Canary injection and audit selection use the
// slot hash of the candidate's first draw: H("slot-canary" | "slot-audit", epoch_secret, subject, slot, hash).
// Every request, its anchor, target, slot, hash and block time, and every canary and audit decision,
// are published with the closed epoch so scripts/verify.ts recomputes the draws.

export interface BeaconHost {
  db: Database;
  now(): number;
}

export interface SlotDraw {
  subject: string;
  round: number;
  epoch: number;
  requested_at: number;
  anchor_slot: number;
  anchored_at: number;
  lag_slots: number;
  target_slot: number;
  slot: number;
  hash: string;
  block_time: number | null;
  resolved_at: number;
}

type Row = Omit<SlotDraw, "anchor_slot" | "anchored_at" | "target_slot" | "slot" | "hash" | "resolved_at"> & {
  anchor_slot: number | null;
  anchored_at: number | null;
  target_slot: number | null;
  slot: number | null;
  hash: string | null;
  resolved_at: number | null;
  attempts: number;
  next_try_at: number;
  last_error: string | null;
};

export const DEFAULT_LAG_SLOTS = 32;

export const slotBeaconValue = (secret: string, subject: string, round: number, slot: number, hash: string) =>
  H("slot-beacon", secret, subject, round, slot, hash);
export const slotDecisionSeed = (kind: "canary" | "audit", secret: string, subject: string, slot: number, hash: string) =>
  H(`slot-${kind}`, secret, subject, slot, hash);

/** Retry delay after `n` failed reads of one request: 2 s doubling, at most 60 s. */
export const beaconBackoffMs = (n: number) => Math.min(2_000 * 2 ** Math.max(0, n - 1), 60_000);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS slot_beacons (
    subject TEXT NOT NULL,
    round INTEGER NOT NULL,
    epoch INTEGER NOT NULL,            -- whose secret the beacon mixes in: the epoch open at the request
    requested_at INTEGER NOT NULL,     -- Core clock, ms
    lag_slots INTEGER NOT NULL,
    anchor_slot INTEGER,               -- cluster slot read after the request
    anchored_at INTEGER,
    target_slot INTEGER,               -- anchor_slot + lag_slots
    slot INTEGER,                      -- first produced (finalized) slot >= target_slot
    hash TEXT,                         -- its blockhash, base58
    block_time INTEGER,                -- its block time, unix s
    resolved_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (subject, round)
  );
  CREATE INDEX IF NOT EXISTS slot_beacons_epoch ON slot_beacons(epoch);
  CREATE TABLE IF NOT EXISTS beacon_uses (
    kind TEXT NOT NULL,                -- canary | audit
    subject TEXT NOT NULL,             -- candidate_id (canary) or gen_id (audit)
    epoch INTEGER NOT NULL,
    draw_subject TEXT NOT NULL,
    draw_round INTEGER NOT NULL,
    value REAL NOT NULL,               -- first Rng draw from the decision seed
    rate REAL NOT NULL,
    outcome INTEGER NOT NULL,          -- value < rate
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, subject)
  );
`;

export class SlotBeacon {
  readonly lagSlots: number;
  /** Earliest next pass after an RPC failure (Core clock, ms) and the consecutive failures. */
  private pause = { at: 0, failures: 0 };
  private running: Promise<unknown> | null = null;
  lastError: string | null = null;

  constructor(
    private host: BeaconHost,
    opts: { lagSlots?: number } = {},
  ) {
    this.lagSlots = opts.lagSlots ?? DEFAULT_LAG_SLOTS;
    if (!Number.isInteger(this.lagSlots) || this.lagSlots < 1) throw new Error("beacon lag must be a whole number of slots, at least 1");
    host.db.exec(SCHEMA);
  }

  private row(subject: string, round: number): Row | null {
    return this.host.db.query<Row, [string, number]>("SELECT * FROM slot_beacons WHERE subject = ? AND round = ?").get(subject, round);
  }

  /**
   * The beacon of (subject, round), or null while its slot is not final yet. The first call records
   * the request in `epoch`; later calls return the same answer, so a draw can be retried on any tick.
   */
  get(subject: string, round: number, epoch: { n: number }, secretOf: (n: number) => string): { beacon: string; epoch: number; draw: SlotDraw } | null {
    const r = this.row(subject, round);
    if (!r) {
      this.host.db
        .query("INSERT INTO slot_beacons (subject, round, epoch, requested_at, lag_slots) VALUES (?, ?, ?, ?, ?)")
        .run(subject, round, epoch.n, this.host.now(), this.lagSlots);
      return null;
    }
    if (r.slot === null || r.hash === null) return null;
    const draw = r as unknown as SlotDraw;
    return { beacon: slotBeaconValue(secretOf(r.epoch), subject, round, r.slot, r.hash), epoch: r.epoch, draw };
  }

  /** The subject's first resolved draw (lowest round), the slot its canary and audit decisions use. */
  firstDraw(subject: string): SlotDraw | null {
    return this.host.db
      .query<SlotDraw, [string]>("SELECT * FROM slot_beacons WHERE subject = ? AND slot IS NOT NULL ORDER BY round LIMIT 1")
      .get(subject);
  }

  /**
   * Seed of a canary or audit decision about `subject`, from the first draw of `drawSubject`; null
   * when that subject was never drawn with a slot (a draw made before the switch to the slot beacon).
   */
  decisionSeed(kind: "canary" | "audit", subject: string, drawSubject: string, epoch: { n: number; secret: string }): { seed: string; draw: SlotDraw } | null {
    const d = this.firstDraw(drawSubject);
    return d ? { seed: slotDecisionSeed(kind, epoch.secret, subject, d.slot, d.hash), draw: d } : null;
  }

  recordUse(kind: "canary" | "audit", subject: string, epoch: number, draw: SlotDraw, value: number, rate: number) {
    this.host.db
      .query("INSERT OR IGNORE INTO beacon_uses (kind, subject, epoch, draw_subject, draw_round, value, rate, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(kind, subject, epoch, draw.subject, draw.round, value, rate, value < rate ? 1 : 0, this.host.now());
  }

  /**
   * A canary decision names when a canary followed a candidate: public only once every canary it
   * queued is final or dropped (SPEC 10.5, 10.7). `final` is Core's subject check.
   */
  canaryFinal(trigger: string, final: (candidateId: string) => boolean): boolean {
    const rows = this.host.db
      .query<{ status: string; candidate_id: string | null }, [string]>(
        "SELECT q.status, c.candidate_id FROM canary_queue q LEFT JOIN candidates c ON c.commit_id = q.commit_id WHERE q.trigger_candidate_id = ?",
      )
      .all(trigger);
    return rows.every((r) => r.status === "dropped" || (!!r.candidate_id && final(r.candidate_id)));
  }

  /** True while a draw requested with epoch `n`'s secret has not been made: the secret must stay sealed. */
  pendingIn(n: number): boolean {
    return !!this.host.db.query("SELECT 1 FROM slot_beacons WHERE epoch = ? AND slot IS NULL LIMIT 1").get(n);
  }

  pending(): number {
    return this.host.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM slot_beacons WHERE slot IS NULL").get()!.n;
  }

  /** Resolved draws and decisions made with epoch `n`'s secret, for subjects `visible` allows. */
  epochRecord(n: number, visible: (subject: string, kind: "draw" | "canary" | "audit") => boolean) {
    const draws = this.host.db
      .query<SlotDraw, [number]>(
        "SELECT subject, round, epoch, requested_at, anchor_slot, anchored_at, lag_slots, target_slot, slot, hash, block_time, resolved_at FROM slot_beacons WHERE epoch = ? AND slot IS NOT NULL ORDER BY requested_at, subject, round",
      )
      .all(n)
      .filter((d) => visible(d.subject, "draw"));
    const uses = this.host.db
      .query<{ kind: "canary" | "audit"; subject: string; epoch: number; draw_subject: string; draw_round: number; value: number; rate: number; outcome: number }, [number]>(
        "SELECT kind, subject, epoch, draw_subject, draw_round, value, rate, outcome FROM beacon_uses WHERE epoch = ? ORDER BY created_at, kind, subject",
      )
      .all(n)
      .filter((u) => visible(u.subject, u.kind) && visible(u.draw_subject, "draw"))
      .map((u) => ({ ...u, outcome: !!u.outcome }));
    return { lag_slots: this.lagSlots, draws, decisions: uses };
  }

  /**
   * One pass over pending requests: anchors every unanchored one at a single tip read, then resolves
   * those whose target may be final. Never overlaps itself. An RPC failure (a 429 included, after
   * the transport's own retries) pauses the whole resolver with backoff; nothing is ever drawn
   * without the slot's hash.
   */
  resolve(src: SlotSource, opts: { max?: number } = {}): Promise<{ anchored: number; resolved: number; waiting: number; error?: string }> {
    if (!this.running)
      this.running = this.resolveInner(src, opts.max ?? 25).finally(() => {
        this.running = null;
      });
    return this.running as Promise<{ anchored: number; resolved: number; waiting: number; error?: string }>;
  }

  private async resolveInner(src: SlotSource, max: number) {
    const now = this.host.now();
    const out = { anchored: 0, resolved: 0, waiting: 0 } as { anchored: number; resolved: number; waiting: number; error?: string };
    if (now < this.pause.at) {
      out.waiting = this.pending();
      return out;
    }
    const db = this.host.db;
    try {
      const unanchored = db.query<Row, []>("SELECT * FROM slot_beacons WHERE anchor_slot IS NULL ORDER BY requested_at").all();
      if (unanchored.length) {
        const tip = await src.tip();
        const at = this.host.now();
        // the anchor is read after the request was recorded, so the target cannot be a slot that existed at the request
        for (const r of unanchored)
          db.query("UPDATE slot_beacons SET anchor_slot = ?, anchored_at = ?, target_slot = ? WHERE subject = ? AND round = ? AND anchor_slot IS NULL").run(
            tip, at, tip + r.lag_slots, r.subject, r.round);
        out.anchored = unanchored.length;
      }
      const due = db
        .query<Row, [number, number]>("SELECT * FROM slot_beacons WHERE slot IS NULL AND anchor_slot IS NOT NULL AND next_try_at <= ? ORDER BY target_slot LIMIT ?")
        .all(this.host.now(), max);
      // one read answers every request whose target is at or below the block found
      let known: SlotBlock | null = null;
      for (const r of due) {
        const target = r.target_slot!;
        // due is sorted by target: a block that was first at or after a lower target and is at or after
        // this one is also the first at or after this one
        let b: SlotBlock | null = known && known.slot >= target ? known : null;
        if (!b) {
          try {
            b = await src.firstBlockAtOrAfter(target);
          } catch (e) {
            const n = r.attempts + 1;
            db.query("UPDATE slot_beacons SET attempts = ?, next_try_at = ?, last_error = ? WHERE subject = ? AND round = ?").run(
              n, this.host.now() + beaconBackoffMs(n), String((e as Error).message).slice(0, 300), r.subject, r.round);
            throw e;
          }
        }
        if (!b || b.slot < target) {
          out.waiting++;
          continue; // not finalized yet: the next pass asks again
        }
        known = b;
        db.query("UPDATE slot_beacons SET slot = ?, hash = ?, block_time = ?, resolved_at = ?, last_error = NULL WHERE subject = ? AND round = ? AND slot IS NULL").run(
          b.slot, b.hash, b.blockTime, this.host.now(), r.subject, r.round);
        out.resolved++;
      }
      this.pause = { at: 0, failures: 0 };
      this.lastError = null;
    } catch (e) {
      const failures = this.pause.failures + 1;
      this.pause = { at: this.host.now() + beaconBackoffMs(failures), failures };
      this.lastError = (e as Error).message;
      out.error = this.lastError;
    }
    out.waiting = this.pending();
    return out;
  }
}
