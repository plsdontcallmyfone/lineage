import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { intentTarget } from "./collab.ts";
import type { Core } from "./core.ts";
import { H, generateAgentKey, patchCommitment, Rng, type Calibration } from "./protocol.ts";

// Hardening against the attacks found in the 2026-10-07 adversarial review (SPEC 10.5, 10.6, 13.6,
// 17.1). Everything here runs inside a Core transaction, reads time only from Core's clock and draws
// randomness from the epoch secret, like the rest of Core.
//
// - Canaries (10.5): shadow authors come from a pool launched ahead of time at staggered random
//   times and funded through the ordinary fee path; a canary is injected on a later scheduler tick
//   at a random offset from the assignment that triggered it, committed by a shadow, and revealed
//   on another later tick after a delay drawn from real authors' commit-to-reveal gaps. Each canary
//   patch is used once: after its epoch closes the patch is public.
// - Unbonding (13.6): the bond is released only once every replay, dispute and audit the agent took
//   part in has resolved, and the cooldown counts from the last of them.
// - Patch theft (10.4): a later commitment revealing the same change as an earlier one is a
//   duplicate; a measured-accepted candidate waits while an earlier twin is still open.
// - Audits (10.6): a group short of independent auditors for too long is judged with what arrived.

/** The parts of Core this module drives. Core passes itself; the private members exist at runtime. */
interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  ledger: Core["ledger"];
  now(): number;
  currentEpoch(): { n: number; secret: string; start_ms: number; end_ms: number };
  emitEvent(type: string, data: unknown): void;
  launchAgent(body: unknown, opts: { shadow?: boolean }): unknown;
  agentFees(body: unknown, opts?: { shadow?: boolean }): unknown;
  commitCandidateInner(author: string, body: unknown, opts: { canary?: string }): { commit_id: string };
  revealCandidateInner(author: string, id: string, body: unknown): unknown;
  candRow(id: string): CandLite | null;
  calibOf(id: string): Calibration;
  replayWindowMs(calib: Calibration): number;
  judgeStage(c: CandLite): void;
  progress(grp: string): void;
  collab: Core["collab"];
  slotBeacon: Core["slotBeacon"];
}

interface CandLite {
  commit_id: string;
  candidate_id: string | null;
  lineage_id: string;
  author: string;
  status: string;
  reason: string | null;
  committed_at: number;
  revealed_at: number | null;
  patch_hash: string | null;
  semantic_hash: string | null;
  claimed_effect: number | null;
  is_canary: number;
  gen_id: string | null;
  want_replays: number;
  want_reference: number;
}

const OPEN = ["committed", "waiting", "queued", "replaying", "disputed"];
const OPEN_SQL = OPEN.map((s) => `'${s}'`).join(",");

export class Hardening {
  private readonly c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
  }

  private get db() {
    return this.c.db;
  }

  /** Called from Core.tick(): shadows, canary queue, deferred twins, stalled audits. */
  tick() {
    this.planShadows();
    this.launchDueShadows();
    this.runCanaryQueue();
    this.rejudgeDeferred();
    this.unstickAudits();
    this.c.collab.tick();
  }

  // ---------------------------------------------------------------------------------------------
  // Shadow author pool (SPEC 10.5)

  /** Canaries of a lineage that were never queued: each canary patch is used at most once. */
  private unusedCanaries(lineage: string) {
    return this.db
      .query<{ canary_id: string; patch: string; patch_hash: string; kind: string; target: string }, [string]>(
        "SELECT * FROM canaries WHERE lineage_id = ? AND uses = 0 AND canary_id NOT IN (SELECT canary_id FROM canary_queue WHERE status != 'dropped') ORDER BY canary_id",
      )
      .all(lineage);
  }

  /**
   * Keeps `shadow_pool` shadows planned or live for every active lineage with unused canaries. A
   * planned shadow launches at a uniformly random time within `shadow_launch_spread_s`, so shadow
   * registrations are spread out like real launches and never coincide with a canary.
   */
  planShadows() {
    if (this.c.cfg.canary_rate <= 0 || this.c.cfg.shadow_pool <= 0) return;
    const now = this.c.now();
    const ep = this.c.currentEpoch();
    const lineages = this.db.query<{ lineage_id: string }, []>("SELECT lineage_id FROM lineages WHERE status = 'active' ORDER BY lineage_id").all();
    for (const { lineage_id } of lineages) {
      if (!this.unusedCanaries(lineage_id).length) continue;
      const live = this.db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM shadows WHERE lineage_id = ? AND retired_at IS NULL").get(lineage_id)!.c;
      let total = this.db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM shadows WHERE lineage_id = ?").get(lineage_id)!.c;
      for (let k = live; k < this.c.cfg.shadow_pool; k++, total++) {
        const rng = new Rng(H("m1-shadow", ep.secret, lineage_id, String(total)));
        const launchAt = now + Math.floor(rng.next() * this.c.cfg.shadow_launch_spread_s * 1000);
        const maxUses = 1 + rng.int(3);
        // the shadow keeps its key (Core only) so it can sign what real agents sign: intents, teams
        const key = generateAgentKey();
        this.c.collab.rememberShadowKey(key);
        this.db
          .query("INSERT INTO shadows (agent_id, lineage_id, planned_at, launch_at, max_uses) VALUES (?, ?, ?, ?, ?)")
          .run(key.id, lineage_id, now, launchAt, maxUses);
      }
    }
  }

  /**
   * Launches planned shadows whose time has come, exactly as a real launch is recorded (same
   * fields, same `agent.launched` event), then funds the compute vault through the ordinary agent
   * fee path (same ledger reasons, same `ledger.agent_fees` event). Hosting and identity mode are
   * copied from a random real launched agent so the population mix matches.
   */
  launchDueShadows() {
    const now = this.c.now();
    const due = this.db
      .query<{ agent_id: string; lineage_id: string }, [number]>("SELECT agent_id, lineage_id FROM shadows WHERE launched_at IS NULL AND retired_at IS NULL AND launch_at <= ? ORDER BY launch_at, agent_id")
      .all(now);
    const ep = this.c.currentEpoch();
    for (const s of due) {
      const l = this.db
        .query<{ url: string; status: string }, [string]>("SELECT r.url AS url, l.status AS status FROM lineages l JOIN repos r ON r.repo_id = l.repo_id WHERE l.lineage_id = ?")
        .get(s.lineage_id);
      if (!l || l.status !== "active") {
        this.db.query("UPDATE shadows SET retired_at = ? WHERE agent_id = ?").run(now, s.agent_id);
        continue;
      }
      const rng = new Rng(H("m1-shadow-launch", ep.secret, s.agent_id));
      const real = this.db
        .query<{ hosted: number; identity_mode: string | null }, []>("SELECT hosted, identity_mode FROM agents WHERE kind = 'launched' AND shadow = 0 ORDER BY agent_id")
        .all();
      const like = real.length ? real[rng.int(real.length)]! : { hosted: 1, identity_mode: "app" };
      this.c.launchAgent(
        { agent: s.agent_id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: l.url, hosted: !!like.hosted, identity_mode: like.identity_mode ?? "app" },
        { shadow: true },
      );
      // enough fees to wake the agent, scaled by a random factor in [1, 4)
      const wake = (this.c.cfg.wake_threshold * 10_000n) / BigInt(Math.max(1, this.c.cfg.agent_compute_bps)) + 1n;
      const amount = (wake * BigInt(1000 + Math.floor(rng.next() * 3000))) / 1000n;
      this.c.agentFees({ agent: s.agent_id, amount: amount.toString() }, { shadow: true });
      this.db.query("UPDATE shadows SET launched_at = ? WHERE agent_id = ?").run(now, s.agent_id);
    }
  }

  /** A shadow is retired once used up, or once any of its canaries became recognisable as one. */
  private retireExposedShadows() {
    const now = this.c.now();
    const rows = this.db
      .query<{ agent_id: string }, []>(
        `SELECT s.agent_id FROM shadows s WHERE s.retired_at IS NULL AND (
           s.uses >= s.max_uses OR EXISTS (
             SELECT 1 FROM candidates c WHERE c.author = s.agent_id AND (c.reason = 'canary' OR EXISTS (
               SELECT 1 FROM replays r WHERE r.candidate_id = c.candidate_id AND r.role = 'canary_fail'))) OR EXISTS (
             -- a canary listed at its epoch's close names its shadow publicly: reused, the shadow's
             -- intents and notes would announce its next canary (audit A2, OFF-07)
             SELECT 1 FROM candidates c JOIN epochs e ON e.n = c.epoch WHERE c.author = s.agent_id AND c.is_canary = 1
               AND c.status IN ('accepted', 'rejected', 'expired') AND e.status = 'closed'))`,
      )
      .all();
    for (const r of rows) this.db.query("UPDATE shadows SET retired_at = ? WHERE agent_id = ?").run(now, r.agent_id);
  }

  // ---------------------------------------------------------------------------------------------
  // Canary injection (SPEC 10.5)

  /**
   * Called when a real candidate's first replays are assigned. With probability canary_rate a
   * canary is queued; it is committed on a later tick at a random offset, never in this transaction.
   */
  scheduleCanary(trigger: { candidate_id: string | null; lineage_id: string }) {
    if (this.c.cfg.canary_rate <= 0 || !trigger.candidate_id) return;
    const canaries = this.unusedCanaries(trigger.lineage_id);
    if (!canaries.length) return;
    const ep = this.c.currentEpoch();
    // slot beacon (M2, src/beacon.ts): the slot hash of the candidate's first draw replaces the M1 seed
    const slot = this.c.slotBeacon?.decisionSeed("canary", trigger.candidate_id, trigger.candidate_id, ep) ?? null;
    const rng = new Rng(slot?.seed ?? H("m1-canary", ep.secret, trigger.candidate_id));
    const v = rng.next();
    if (slot) this.c.slotBeacon!.recordUse("canary", trigger.candidate_id, ep.n, slot.draw, v, this.c.cfg.canary_rate);
    if (v >= this.c.cfg.canary_rate) return;
    const pick = canaries[rng.int(canaries.length)]!;
    const [lo, hi] = this.c.cfg.canary_inject_delay_s;
    const delay = Math.max(1000, Math.round((lo + rng.next() * (hi - lo)) * 1000));
    const now = this.c.now();
    const ins = this.db
      .query("INSERT INTO canary_queue (lineage_id, canary_id, trigger_candidate_id, inject_at, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(trigger.lineage_id, pick.canary_id, trigger.candidate_id, now + delay, now);
    // shadow parity (SPEC 10.7): the shadow files an intent first, as often and as early as real authors do
    const live = this.db
      .query<{ agent_id: string }, [string]>(
        `SELECT s.agent_id FROM shadows s WHERE s.lineage_id = ? AND s.retired_at IS NULL AND s.launched_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.author = s.agent_id AND c.status IN (${OPEN_SQL})) ORDER BY s.agent_id`,
      )
      .all(trigger.lineage_id)
      .map((r) => r.agent_id);
    this.c.collab.planShadowIntent(
      { id: Number(ins.lastInsertRowid), lineage_id: trigger.lineage_id, kind: pick.kind, target: pick.target, inject_at: now + delay },
      new Rng(H("m1-shadow-intent", ep.secret, trigger.candidate_id)),
      live,
    );
  }

  /** Commit-to-reveal delay for a canary: a real author's gap in this lineage, else the configured range. */
  private revealDelayMs(lineage: string, rng: Rng): number {
    const gaps = this.db
      .query<{ g: number }, [string]>(
        "SELECT revealed_at - committed_at AS g FROM candidates WHERE lineage_id = ? AND is_canary = 0 AND revealed_at IS NOT NULL ORDER BY committed_at DESC LIMIT 50",
      )
      .all(lineage)
      .map((r) => r.g);
    let ms: number;
    if (gaps.length >= 5) ms = gaps[rng.int(gaps.length)]! * (0.9 + 0.2 * rng.next());
    else {
      const [lo, hi] = this.c.cfg.canary_reveal_delay_s;
      ms = (lo + rng.next() * (hi - lo)) * 1000;
    }
    // never in the commit's tick, always inside the reveal window
    return Math.round(Math.min(Math.max(ms, 1000), Math.max(1000, this.c.cfg.reveal_window_s * 1000 - 5000)));
  }

  runCanaryQueue() {
    this.retireExposedShadows();
    const now = this.c.now();
    const ep = this.c.currentEpoch();
    const pending = this.db
      .query<{ id: number; lineage_id: string; canary_id: string; inject_at: number }, [number]>(
        "SELECT id, lineage_id, canary_id, inject_at FROM canary_queue WHERE status = 'pending' AND inject_at <= ? ORDER BY inject_at, id",
      )
      .all(now);
    for (const q of pending) {
      const tip = this.db.query<{ tip: string; status: string }, [string]>("SELECT tip, status FROM lineages WHERE lineage_id = ?").get(q.lineage_id);
      const canary = this.db
        .query<{ patch: string; patch_hash: string; kind: string; target: string }, [string]>("SELECT patch, patch_hash, kind, target FROM canaries WHERE canary_id = ?")
        .get(q.canary_id);
      if (!tip || tip.status !== "active" || !canary) {
        this.db.query("UPDATE canary_queue SET status = 'dropped', detail = 'lineage or canary gone' WHERE id = ?").run(q.id);
        continue;
      }
      const minAge = now - this.c.cfg.shadow_min_age_s * 1000;
      const shadows = this.db
        .query<{ agent_id: string }, [string, number]>(
          `SELECT s.agent_id FROM shadows s JOIN agents a ON a.agent_id = s.agent_id
           WHERE s.lineage_id = ? AND s.retired_at IS NULL AND s.launched_at IS NOT NULL AND a.registered_at <= ? AND a.awake = 1
             AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.author = s.agent_id AND c.status IN (${OPEN_SQL}))
           ORDER BY s.agent_id`,
        )
        .all(q.lineage_id, minAge);
      if (!shadows.length) {
        // wait for the pool; give up after an epoch length
        if (now - q.inject_at > this.c.cfg.epoch_length_s * 1000) this.db.query("UPDATE canary_queue SET status = 'dropped', detail = 'no shadow available' WHERE id = ?").run(q.id);
        continue;
      }
      const rng = new Rng(H("m1-canary-inject", ep.secret, String(q.id)));
      const pick = shadows[rng.int(shadows.length)]!.agent_id;
      // the shadow that filed this canary's intent commits it, when it still can
      const shadow = this.c.collab.plannedShadow(q.id, shadows.map((s) => s.agent_id)) ?? pick;
      // claimed effect copied from a random real candidate of this lineage, as authors state them
      const claims = this.db
        .query<{ claimed_effect: number | null }, [string]>("SELECT claimed_effect FROM candidates WHERE lineage_id = ? AND is_canary = 0 ORDER BY committed_at DESC LIMIT 50")
        .all(q.lineage_id);
      const claimed = claims.length ? claims[rng.int(claims.length)]!.claimed_effect : null;
      const salt = H("canary-salt", ep.secret, String(q.id)).slice(0, 32);
      try {
        const body: Record<string, unknown> = { lineage_id: q.lineage_id, parent_gen_id: tip.tip, kind: canary.kind, target: JSON.parse(canary.target), commitment: patchCommitment(canary.patch_hash, salt), claimed_effect: claimed };
        // shadow parity (SPEC 10.7): committed as a team of shadows as often as real candidates are teams
        const team = this.c.collab.shadowTeam(shadow, { lineage_id: q.lineage_id, parent_gen_id: tip.tip, commitment: body.commitment as string, kind: canary.kind, target: intentTarget(canary.kind, body.target) }, new Rng(H("m1-shadow-team", ep.secret, String(q.id))));
        if (team) body.team = team;
        const committed = this.c.commitCandidateInner(shadow, body, { canary: q.canary_id });
        const revealAt = now + this.revealDelayMs(q.lineage_id, new Rng(H("m1-canary-reveal", ep.secret, committed.commit_id)));
        this.db
          .query("UPDATE canary_queue SET status = 'committed', shadow_id = ?, commit_id = ?, salt = ?, reveal_at = ? WHERE id = ?")
          .run(shadow, committed.commit_id, salt, revealAt, q.id);
        this.db.query("UPDATE canaries SET uses = uses + 1 WHERE canary_id = ?").run(q.canary_id);
        this.db.query("UPDATE shadows SET uses = uses + 1 WHERE agent_id = ?").run(shadow);
      } catch (e) {
        this.db.query("UPDATE canary_queue SET status = 'dropped', detail = ? WHERE id = ?").run(`commit refused: ${String((e as Error).message).slice(0, 200)}`, q.id);
      }
    }
    const due = this.db
      .query<{ id: number; canary_id: string; shadow_id: string; commit_id: string; salt: string }, [number]>(
        "SELECT id, canary_id, shadow_id, commit_id, salt FROM canary_queue WHERE status = 'committed' AND reveal_at <= ? ORDER BY reveal_at, id",
      )
      .all(now);
    for (const q of due) {
      const patch = this.db.query<{ patch: string }, [string]>("SELECT patch FROM canaries WHERE canary_id = ?").get(q.canary_id)!.patch;
      try {
        this.c.revealCandidateInner(q.shadow_id, q.commit_id, { patch, salt: q.salt });
        this.db.query("UPDATE canary_queue SET status = 'revealed' WHERE id = ?").run(q.id);
      } catch (e) {
        this.db.query("UPDATE canary_queue SET status = 'dropped', detail = ? WHERE id = ?").run(`reveal refused: ${String((e as Error).message).slice(0, 200)}`, q.id);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Patch theft (SPEC 10.4)

  /**
   * At reveal: an earlier-committed candidate of the same lineage carrying the same change, which is
   * still open, accepted (and not reverted), or itself a duplicate, makes this one a duplicate.
   */
  earlierTwin(c: { commit_id: string; lineage_id: string; committed_at: number }, patchHash: string, semHash: string): CandLite | null {
    return this.db
      .query<CandLite, [string, string, string, string, number, number, string]>(
        `SELECT * FROM candidates WHERE lineage_id = ? AND commit_id != ? AND (patch_hash = ? OR semantic_hash = ?)
           AND (committed_at < ? OR (committed_at = ? AND commit_id < ?))
           AND (status IN (${OPEN_SQL})
             OR (status = 'accepted' AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.gen_id = candidates.gen_id AND g.reverted_by IS NOT NULL))
             OR (status = 'rejected' AND reason = 'duplicate'))
         ORDER BY committed_at, commit_id LIMIT 1`,
      )
      .get(c.lineage_id, c.commit_id, patchHash, semHash, c.committed_at, c.committed_at, c.commit_id);
  }

  /**
   * At acceptance: if an earlier-committed twin is still open, hold this candidate (no roles settled,
   * nothing paid) until the twin is final; Core.tick re-judges it then. Returns true when held.
   */
  deferIfTwinOpen(c: CandLite): boolean {
    if (!c.semantic_hash && !c.patch_hash) return false;
    const twin = this.db
      .query<{ commit_id: string; candidate_id: string | null }, [string, string, string, string, number, number, string]>(
        `SELECT commit_id, candidate_id FROM candidates WHERE lineage_id = ? AND commit_id != ? AND (semantic_hash = ? OR patch_hash = ?)
           AND (committed_at < ? OR (committed_at = ? AND commit_id < ?)) AND status IN (${OPEN_SQL})
         ORDER BY committed_at, commit_id LIMIT 1`,
      )
      .get(c.lineage_id, c.commit_id, c.semantic_hash ?? "", c.patch_hash ?? "", c.committed_at, c.committed_at, c.commit_id);
    if (!twin) return false;
    const now = this.c.now();
    this.db.query("INSERT OR REPLACE INTO candidate_deferrals (commit_id, behind, at) VALUES (?, ?, ?)").run(c.commit_id, twin.commit_id, now);
    this.db
      .query("UPDATE candidates SET detail = ? WHERE commit_id = ?")
      .run(`held: an earlier commitment with the same change (${twin.candidate_id ?? twin.commit_id}) is still open`, c.commit_id);
    this.c.emitEvent("candidate.deferred", { candidate_id: c.candidate_id, behind: twin.candidate_id });
    return true;
  }

  /** The non-reverted generation carrying the same change, if any (used when a held candidate is re-judged). */
  acceptedTwin(c: CandLite): string | null {
    const g = this.db
      .query<{ gen_id: string }, [string, string, string]>(
        "SELECT gen_id FROM generations WHERE lineage_id = ? AND entry_type = 'patch' AND reverted_by IS NULL AND (patch_hash = ? OR semantic_hash = ?) LIMIT 1",
      )
      .get(c.lineage_id, c.patch_hash ?? "", c.semantic_hash ?? "");
    return g?.gen_id ?? null;
  }

  private rejudgeDeferred() {
    const rows = this.db
      .query<{ commit_id: string }, []>(
        `SELECT d.commit_id FROM candidate_deferrals d JOIN candidates b ON b.commit_id = d.behind WHERE b.status NOT IN (${OPEN_SQL}) ORDER BY d.at, d.commit_id`,
      )
      .all();
    for (const r of rows) {
      this.db.query("DELETE FROM candidate_deferrals WHERE commit_id = ?").run(r.commit_id);
      const c = this.c.candRow(r.commit_id);
      if (c && OPEN.includes(c.status)) this.c.judgeStage(c);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Unbonding (SPEC 13.6)

  /**
   * Whether an agent still has involvement that could end in a slash, and when its last resolved
   * involvement resolved. Involvement: an open replay; a revealed or committed replay of a candidate
   * that is not final (replaying, disputed); an audit still pending that it replayed for, or whose
   * generation it replayed; a replay revealed within its lineage's replay window.
   */
  involvement(agent: string): { open: string[]; last_resolved_at: number | null } {
    const now = this.c.now();
    const open: string[] = [];
    let last: number | null = null;
    const bump = (t: number | null) => {
      if (t !== null && (last === null || t > last)) last = t;
    };
    const rows = this.db
      .query<
        { replay_id: string; status: string; revealed_at: number | null; audit_id: string | null; c_status: string; finalized_at: number | null; lineage_id: string; candidate_id: string },
        [string]
      >(
        `SELECT r.replay_id, r.status, r.revealed_at, r.audit_id, c.status AS c_status, c.finalized_at, c.lineage_id, c.candidate_id
         FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id WHERE r.replayer = ?`,
      )
      .all(agent);
    const windows = new Map<string, number>();
    const windowOf = (lineage: string) => {
      let w = windows.get(lineage);
      if (w === undefined) {
        const l = this.db.query<{ calib_id: string }, [string]>("SELECT calib_id FROM lineages WHERE lineage_id = ?").get(lineage)!;
        w = this.c.replayWindowMs(this.c.calibOf(l.calib_id));
        windows.set(lineage, w);
      }
      return w;
    };
    for (const r of rows) {
      if (r.status === "assigned" || r.status === "committed") {
        open.push(`open replay ${r.replay_id}`);
        continue;
      }
      if (r.status !== "revealed" && r.status !== "invalid") continue;
      if (r.revealed_at !== null) {
        const until = r.revealed_at + windowOf(r.lineage_id);
        if (until > now) open.push(`replay ${r.replay_id} revealed within the replay window`);
        else bump(until);
      }
      if (!r.audit_id) {
        if (OPEN.includes(r.c_status)) open.push(`candidate ${r.candidate_id} not final (${r.c_status})`);
        else bump(r.finalized_at);
      }
    }
    const audits = this.db
      .query<{ audit_id: string; status: string; resolved_at: number | null }, [string, string]>(
        `SELECT DISTINCT a.audit_id, a.status, a.resolved_at FROM audits a WHERE
           EXISTS (SELECT 1 FROM replays r WHERE r.audit_id = a.audit_id AND r.replayer = ?)
           OR EXISTS (SELECT 1 FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id
                      WHERE r.candidate_id = a.candidate_id AND r.audit_id IS NULL AND r.stage = c.stage AND r.role = 'counted' AND r.replayer = ?)`,
      )
      .all(agent, agent);
    for (const a of audits) {
      if (a.status === "pending") open.push(`audit ${a.audit_id} pending`);
      else bump(a.resolved_at);
    }
    return { open, last_resolved_at: last };
  }

  /**
   * Releases unbond requests whose cooldown has run, counting the cooldown from the later of the
   * request and the agent's last resolved involvement. While anything is unresolved the request
   * waits (unbond_ready_at is NULL) and the bond stays slashable.
   */
  matureUnbonds(release: (agent: string) => void) {
    const now = this.c.now();
    const cooling = this.db.query<{ agent_id: string; unbond_ready_at: number | null }, []>("SELECT agent_id, unbond_ready_at FROM agents WHERE unbond_amount != '0' ORDER BY agent_id").all();
    for (const a of cooling) {
      const inv = this.involvement(a.agent_id);
      let ready: number | null = null;
      if (!inv.open.length) {
        const req = this.db
          .query<{ at: number }, [string]>("SELECT at FROM bonds WHERE agent_id = ? AND action = 'unbond_request' ORDER BY id DESC LIMIT 1")
          .get(a.agent_id);
        ready = Math.max(req?.at ?? 0, inv.last_resolved_at ?? 0) + this.c.cfg.unbond_cooldown_s * 1000;
      }
      if (ready !== a.unbond_ready_at) this.db.query("UPDATE agents SET unbond_ready_at = ? WHERE agent_id = ?").run(ready, a.agent_id);
      if (ready !== null && ready <= now) release(a.agent_id);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Audits (SPEC 10.6)

  /**
   * An audit that still lacks auditors twice its replay window after it opened, with nothing
   * outstanding, is judged with the replays that arrived (fewer independent auditors than wanted).
   */
  private unstickAudits() {
    const now = this.c.now();
    const rows = this.db
      .query<{ audit_id: string; created_at: number; calib_id: string }, []>(
        `SELECT a.audit_id, a.created_at, l.calib_id FROM audits a JOIN candidates c ON c.candidate_id = a.candidate_id JOIN lineages l ON l.lineage_id = c.lineage_id
         WHERE a.status = 'pending' AND (a.want_replays > 0 OR a.want_reference > 0)`,
      )
      .all();
    for (const a of rows) {
      if (now < a.created_at + 2 * this.c.replayWindowMs(this.c.calibOf(a.calib_id))) continue;
      const grp = `audit:${a.audit_id}`;
      if (this.db.query("SELECT 1 FROM replays WHERE grp = ? AND status IN ('assigned','committed')").get(grp)) continue;
      this.db.query("UPDATE audits SET want_replays = 0, want_reference = 0 WHERE audit_id = ?").run(a.audit_id);
      this.c.emitEvent("audit.short", { audit_id: a.audit_id });
      this.c.progress(grp);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Private canary library (SPEC 10.5)

/** True when `dir` lies inside `repoRoot`: a public checkout, whose canaries anyone can read. */
export function canaryDirIsPublic(dir: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, dir);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/**
 * Loads canaries from a private directory laid out like the public fixtures:
 * `<dir>/<recipe name>/index.json` ({ <name>: { kind, target, expect } }) plus `<name>.diff`. Each
 * active lineage whose recipe name has a directory gets its canaries (idempotent). The canaries in
 * `recipes/<name>/canaries` of the public repository are test fixtures: a live network must use a
 * library nobody else has seen, or replayers can recognise canaries by their patch hash.
 */
export function loadCanaryDir(core: Core, dir: string): { loaded: number; lineages: number; errors: string[] } {
  const errors: string[] = [];
  let loaded = 0;
  let lineages = 0;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { loaded, lineages, errors: [`${dir} is not a directory`] };
  const active = core.listLineages().filter((l) => l.status === "active");
  for (const l of active) {
    const sub = join(dir, l.recipe_name);
    const indexPath = join(sub, "index.json");
    if (!existsSync(indexPath)) continue;
    lineages++;
    let index: Record<string, { kind?: string; target?: unknown; expect?: string }>;
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch (e) {
      errors.push(`${indexPath}: ${(e as Error).message}`);
      continue;
    }
    const diffs = new Set(readdirSync(sub).filter((f) => f.endsWith(".diff")));
    for (const [name, m] of Object.entries(index)) {
      if (!diffs.has(`${name}.diff`)) {
        errors.push(`${sub}: ${name}.diff missing`);
        continue;
      }
      try {
        const r = core.addCanary({ lineage_id: l.lineage_id, kind: m.kind, target: m.target, expected_reason: m.expect, patch: readFileSync(join(sub, `${name}.diff`), "utf8") });
        if (r.created) loaded++;
      } catch (e) {
        errors.push(`${sub}/${name}: ${(e as Error).message}`);
      }
    }
  }
  return { loaded, lineages, errors };
}
