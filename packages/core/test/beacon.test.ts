import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotBlock, SlotSource } from "@lineage/chain";
import { beaconBackoffMs, slotBeaconValue, slotDecisionSeed } from "../src/beacon.ts";
import { FakeClock } from "../src/clock.ts";
import { CoreClient } from "../src/client.ts";
import { Core } from "../src/core.ts";
import { serve } from "../src/http.ts";
import { assignmentSeed, assignReplayers, calibId, generateAgentKey, H, recipeId, Rng, signMessage } from "../src/protocol.ts";
import {
  CALIB,
  DEPS,
  RECIPE,
  allAgents,
  assignmentsFor,
  candidate,
  diff,
  expectOk,
  honest,
  makeAuthor,
  makeVerifier,
  runReplays,
  submit,
  testConfig,
  type Env,
} from "./helpers.ts";

// M2 slot-hash beacon (SPEC 10.3, plan W9a) against a scripted cluster: no live RPC.

/** A cluster whose tip, finalized height and skipped slots the test sets; `fail` makes every read throw. */
class FakeCluster implements SlotSource {
  tipSlot = 1_000;
  finalized = 0;
  skipped = new Set<number>();
  fail: string | null = null;
  reads = 0;
  hashOf = (s: number) => `hash${s}`;
  async tip() {
    this.reads++;
    if (this.fail) throw new Error(this.fail);
    return this.tipSlot;
  }
  async firstBlockAtOrAfter(slot: number): Promise<SlotBlock | null> {
    this.reads++;
    if (this.fail) throw new Error(this.fail);
    for (let s = slot; s <= this.finalized; s++) if (!this.skipped.has(s)) return { slot: s, hash: this.hashOf(s), blockTime: 1_700_000_000 + s };
    return null;
  }
}

const LAG = 8;
let env: (Env & { cluster: FakeCluster }) | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

async function slotEnv(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lineage-beacon-test-"));
  const clock = new FakeClock();
  const adminKey = generateAgentKey();
  const cfg = testConfig(over);
  const core = new Core({ dataDir: dir, network: cfg, adminId: adminKey.id, clock, slotBeacon: { lagSlots: LAG } });
  const server = serve(core, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { key: adminKey, id: adminKey.id, c: new CoreClient(base, adminKey, () => clock.now()) };
  const b = {
    core, clock, server, base, admin, dir, cfg, anon: new CoreClient(base, null),
    close() {
      server.stop(true);
      core.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  await expectOk(admin.c.post("/v1/admin/recipes", { recipe: RECIPE, recipe_id: recipeId(RECIPE) }));
  await expectOk(admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
  const ref = await makeVerifier(b, { bond: 0n });
  await expectOk(admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) }));
  const verifiers = [];
  for (let i = 0; i < 4; i++) verifiers.push(await makeVerifier(b));
  const e = { ...b, verifiers, reference: ref, lineage: lin.lineage_id, gen0: lin.gen0, cluster: new FakeCluster() };
  env = e;
  return e;
}

/** Finalizes everything the cluster has produced, resolves, ticks and drives replays until quiet. */
async function settle(e: Env & { cluster: FakeCluster }, id: string) {
  for (let i = 0; i < 12; i++) {
    e.cluster.tipSlot += 50;
    e.cluster.finalized = e.cluster.tipSlot;
    await e.core.slotBeacon!.resolve(e.cluster);
    e.core.tick();
    await runReplays(e, id, honest());
    e.clock.advance(1000);
  }
}

const openAssignments = async (e: Env, id: string) => (await Promise.all(allAgents(e).map((a) => assignmentsFor(a, id)))).flat();

describe("slot-hash beacon (SPEC 10.3, M2)", () => {
  test("a draw waits for a finalized slot at or after anchor + lag, anchored after the request", async () => {
    const e = await slotEnv();
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("a"));
    // requested, not drawn: nothing assigned and the request carries no slot yet
    expect(await openAssignments(e, c.candidate_id)).toHaveLength(0);
    const req = e.core.db.query<any, [string]>("SELECT * FROM slot_beacons WHERE subject = ?").get(c.candidate_id);
    expect(req).toMatchObject({ round: 0, anchor_slot: null, slot: null, lag_slots: LAG });

    // blocks that already exist at the request can never be the beacon: the anchor is read afterwards
    e.cluster.finalized = e.cluster.tipSlot; // everything up to the tip is final, yet below the target
    e.cluster.tipSlot = 1_003;
    let r = await e.core.slotBeacon!.resolve(e.cluster);
    expect(r).toMatchObject({ anchored: 1, resolved: 0, waiting: 1 });
    const anchored = e.core.db.query<any, [string]>("SELECT * FROM slot_beacons WHERE subject = ?").get(c.candidate_id);
    expect(anchored.anchor_slot).toBe(1_003);
    expect(anchored.target_slot).toBe(1_003 + LAG);
    e.core.tick();
    expect(await openAssignments(e, c.candidate_id)).toHaveLength(0);

    // the target slot is skipped: the first produced slot after it is the beacon
    e.cluster.skipped.add(1_011);
    e.cluster.finalized = 1_020;
    r = await e.core.slotBeacon!.resolve(e.cluster);
    expect(r).toMatchObject({ resolved: 1, waiting: 0 });
    const done = e.core.db.query<any, [string]>("SELECT * FROM slot_beacons WHERE subject = ?").get(c.candidate_id);
    expect(done).toMatchObject({ slot: 1_012, hash: "hash1012" });
    e.core.tick();
    expect((await openAssignments(e, c.candidate_id)).length).toBeGreaterThan(0);
    const round = e.core.db.query<any, [string]>("SELECT * FROM assignment_rounds WHERE subject = ?").get(c.candidate_id);
    expect(round.bucket).toBe(-1);
    const secret = e.core.currentEpoch().secret;
    expect(round.beacon).toBe(slotBeaconValue(secret, c.candidate_id, 0, 1_012, "hash1012"));
  });

  test("a failed slot read is retried with backoff and never replaced by a local random", async () => {
    const e = await slotEnv();
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("b"));
    e.cluster.fail = "getSlot: HTTP 429";
    const r1 = await e.core.slotBeacon!.resolve(e.cluster);
    expect(r1.error).toContain("429");
    // paused: an immediate second pass does not even call the cluster
    const reads = e.cluster.reads;
    await e.core.slotBeacon!.resolve(e.cluster);
    expect(e.cluster.reads).toBe(reads);
    for (let i = 0; i < 5; i++) {
      e.core.tick();
      e.clock.advance(500);
    }
    expect(await openAssignments(e, c.candidate_id)).toHaveLength(0);
    expect(e.core.db.query("SELECT COUNT(*) AS n FROM assignment_rounds").get()).toEqual({ n: 0 });

    // anchored, then the block read fails: the request keeps its anchor and retries after its backoff
    e.cluster.fail = null;
    e.clock.advance(beaconBackoffMs(1));
    await e.core.slotBeacon!.resolve(e.cluster);
    const anchor = e.core.db.query<any, [string]>("SELECT anchor_slot FROM slot_beacons WHERE subject = ?").get(c.candidate_id).anchor_slot;
    e.cluster.fail = "getBlocksWithLimit: HTTP 503";
    e.cluster.tipSlot += 100;
    e.cluster.finalized = e.cluster.tipSlot;
    await e.core.slotBeacon!.resolve(e.cluster);
    const row = e.core.db.query<any, [string]>("SELECT * FROM slot_beacons WHERE subject = ?").get(c.candidate_id);
    expect(row).toMatchObject({ anchor_slot: anchor, slot: null, attempts: 1 });
    expect(row.last_error).toContain("503");
    e.core.tick();
    expect(await openAssignments(e, c.candidate_id)).toHaveLength(0);
    e.cluster.fail = null;
    e.clock.advance(beaconBackoffMs(2));
    await e.core.slotBeacon!.resolve(e.cluster);
    e.core.tick();
    const after = e.core.db.query<any, [string]>("SELECT * FROM slot_beacons WHERE subject = ?").get(c.candidate_id);
    expect(after.anchor_slot).toBe(anchor); // never re-anchored
    expect(after.slot).toBe(anchor + LAG);
    expect((await openAssignments(e, c.candidate_id)).length).toBeGreaterThan(0);
  });

  test("every draw and the audit decision are recomputable from the published epoch record", async () => {
    const e = await slotEnv({ audit_rate: 1 });
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("c"));
    await settle(e, c.candidate_id);
    expect((await candidate(e, c.commit_id)).status).toBe("accepted");
    const n = e.core.currentEpoch().n;
    // sealed while the epoch is open
    const open = await expectOk(e.anon.get(`/v1/epochs/${n}`));
    expect(open.secret).toBeNull();
    expect(open.slot_beacon).toBeUndefined();
    await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    const ep = await expectOk(e.anon.get(`/v1/epochs/${n}`));
    expect(ep.secret).not.toBeNull();
    expect(H("beacon-commit", ep.secret)).toBe(ep.beacon_commit);
    const sb = ep.slot_beacon;
    expect(sb.lag_slots).toBe(LAG);
    expect(ep.assignment_rounds.length).toBeGreaterThanOrEqual(2); // the candidate and its audit
    for (const round of ep.assignment_rounds) {
      const d = sb.draws.find((x: any) => x.subject === round.subject && x.round === round.round);
      expect(d).toBeDefined();
      expect(d.target_slot).toBe(d.anchor_slot + d.lag_slots);
      expect(d.slot).toBeGreaterThanOrEqual(d.target_slot);
      expect(d.anchored_at).toBeGreaterThanOrEqual(d.requested_at);
      const beacon = slotBeaconValue(ep.secret, round.subject, round.round, d.slot, d.hash);
      expect(beacon).toBe(round.beacon);
      const seed = assignmentSeed(beacon, round.subject);
      expect(seed).toBe(round.assignment_seed);
      const pool = round.pool.map((p: any) => ({ agent: p.agent, bond: BigInt(p.bond), operator: p.operator ?? undefined }));
      const chosen = round.count > 0 ? assignReplayers(seed, pool, Math.min(round.count, pool.length), { agents: [] }, e.cfg.bond_cap) : [];
      expect(chosen).toEqual(round.chosen);
    }
    const audit = sb.decisions.find((x: any) => x.kind === "audit");
    expect(audit).toBeDefined();
    const first = sb.draws.filter((x: any) => x.subject === c.candidate_id).sort((a: any, b: any) => a.round - b.round)[0];
    expect(audit.draw_subject).toBe(c.candidate_id);
    const v = new Rng(slotDecisionSeed("audit", ep.secret, audit.subject, first.slot, first.hash)).next();
    expect(v).toBe(audit.value);
    expect(audit.outcome).toBe(true);
  });

  test("canary decisions use the candidate's first slot draw and are recorded", async () => {
    const e = await slotEnv({ canary_rate: 0.5 });
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, patch: diff("canary_x", "src/hidden.rs"), kind: "perf", target: "ir", expected_reason: "tests_fail" }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("d"));
    e.cluster.finalized = e.cluster.tipSlot + 100;
    await e.core.slotBeacon!.resolve(e.cluster);
    e.core.tick();
    const use = e.core.db.query<any, [string]>("SELECT * FROM beacon_uses WHERE kind = 'canary' AND subject = ?").get(c.candidate_id);
    expect(use).not.toBeNull();
    const d = e.core.slotBeacon!.firstDraw(c.candidate_id)!;
    expect(use.value).toBe(new Rng(slotDecisionSeed("canary", e.core.currentEpoch().secret, c.candidate_id, d.slot, d.hash)).next());
    const queued = e.core.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM canary_queue WHERE trigger_candidate_id = ?").get(c.candidate_id)!.n;
    expect(queued).toBe(use.value < 0.5 ? 1 : 0);
  });

  test("the epoch secret stays sealed while a draw requested with it is not made", async () => {
    const e = await slotEnv();
    const author = await makeAuthor(e);
    await submit(e, author, diff("e"));
    const n = e.core.currentEpoch().n;
    await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    expect(e.core.slotBeacon!.pendingIn(n)).toBe(true);
    expect((await expectOk(e.anon.get(`/v1/epochs/${n}`))).secret).toBeNull();
  });

  test("without the option Core keeps the M1 clock-bucket beacon", async () => {
    const e = await slotEnv();
    const dir = mkdtempSync(join(tmpdir(), "lineage-beacon-m1-"));
    const core = new Core({ dataDir: dir, network: testConfig(), adminId: generateAgentKey().id, clock: new FakeClock() });
    try {
      expect(core.slotBeacon).toBeNull();
    } finally {
      core.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(e.core.slotBeacon!.lagSlots).toBe(LAG);
  });
});
