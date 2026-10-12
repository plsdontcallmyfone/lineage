import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { Reader, type AgentLaunch, type AgentRecord, type ChainReader, type Ix } from "@units/chain";
import { ChainBridge, chainBootstrap, type ChainSettings } from "../src/chain.ts";
import { FakeClock } from "../src/clock.ts";
import { CoreClient } from "../src/client.ts";
import { Core } from "../src/core.ts";
import { deploymentsOf, RETIRED_BY } from "../src/deployments.ts";
import { serve } from "../src/http.ts";
import { calibId, generateAgentKey, recipeId, repoId, signMessage, snapshotId, type AgentKey, type Recipe } from "../src/protocol.ts";
import { CALIB, CAPS, DEPS, RECIPE, agentClient, candidate, diff, expectOk, honest, qualify, result, runReplays, submit, testConfig, type Agent, type Env } from "./helpers.ts";

// The switch of one Core database from a retired deployment to a fresh one (deployments.ts): the mainnet
// site moving from the mainnet TEST programs to the official ones. No RPC: both registries are fakes
// that answer what the bridge reads and apply what it sends with the program's own post_epoch rule
// (onchain/programs/units-registry/src/lib.rs: the first post sets the anchor, every later one is the
// next epoch; pool and rebate must be in the vaults).

const ZERO32 = "0".repeat(64);
const key = () => generateAgentKey().id;

class FakeRegistry {
  epochsPosted = 0n;
  lastEpoch = 0n;
  anchor: bigint | null = null;
  agents: AgentRecord[] = [];
  launches: AgentLaunch[] = [];
  compute: Record<string, bigint> = {};
  vault = { treasury: 0n, reserve: 0n, pool: 0n, payable: 0n, bondVault: 0n };
  posted = new Map<number, { payoutRoot: string; lineageRoot: string; pool: bigint; rebate: bigint }>();
  sent: string[] = [];
  reads = 0;
  readonly admin = key();
  readonly tokenProgram = key();
  constructor(
    readonly ids: { registry: string; launch: string; mint: string; decimals: number },
    readonly coreAuthority: string,
    readonly unit: bigint,
  ) {}

  get settings(): ChainSettings {
    return { mode: "mainnet", rpc_url: "http://127.0.0.1:1", registry_program: this.ids.registry, launch_program: this.ids.launch };
  }

  verifier(agent: string, bond: bigint) {
    this.agents.push(this.record(agent, "verifier", bond));
    this.vault.bondVault += bond;
  }
  launch(agent: string, mint: string, repoUrl: string, compute: bigint) {
    const launcher = key();
    this.agents.push({ ...this.record(agent, "launched", 0n), mint, hosted: true, owner: launcher });
    this.launches.push({ agent, mint, launcher, repoId: ZERO32, repoUrl, identityMode: 2, hosted: true, venue: "pump", bondingCurve: key(), pumpPool: key(), pumpCreator: key(),
      routes: 0, graduated: false, awake: true, createdAt: 1n, feesClaimed: 0n, toCompute: 0n, toProtocol: 0n, debited: 0n, withdrawn: 0n } as AgentLaunch);
    this.compute[agent] = compute;
  }
  private record(agent: string, kind: "verifier" | "launched", bond: bigint): AgentRecord {
    return { agent, owner: agent, kind, mint: agent, hosted: false, burned: this.unit, bond, unbondAmount: 0n, unbondRequestedAt: 0n, unbondReadyAt: 0n, strikesTotal: 0,
      strikesEpoch: 0n, strikesInEpoch: 0, suspendedThroughEpoch: 0n, slashedTotal: 0n, operator: ZERO32, capabilities: ZERO32, registeredAt: 1n, version: 2,
      signingKey: agent, keySeq: 0, keyChangedAt: 0n, profileDigest: null, profileSeq: 0, pendingOwner: null, ownerSince: 1n, slashWindow: 0n, slashedInWindow: 0n } as AgentRecord;
  }

  reader(): ChainReader {
    const read = <T>(v: T) => (this.reads++, Promise.resolve(v));
    const r = {
      rpc: { commitment: "confirmed", call: async (m: string) => read(m === "getSignaturesForAddress" ? [] : null), getAccountInfo: async () => read(null),
        getMultipleAccounts: async (a: string[]) => read(a.map(() => null)), getSlot: async () => read(1) },
      registryConfig: async () => read({ admin: this.admin, coreAuthority: this.coreAuthority, launchProgram: this.ids.launch, mint: this.ids.mint, tokenProgram: this.tokenProgram,
        params: { registerBurn: this.unit, minBond: 5n * this.unit, bondCap: 1000n * this.unit, unbondCooldownS: 60n, epochLengthS: 3600, reserveBps: 8000, poolBps: 2000, canarySlashBps: 5000,
          minoritySlashBps: 1000, revealSlashBps: 2000, strikeLimit: 3, uReplay: 1, uAuthor: 5, finderShareBps: 2000, valueCap: 10, rebatePerClass: this.unit / 1000n,
          maxOpenCandidatesPerAgent: 3, authorRewardTo: 0, quorum: 2 },
        paused: false, epochsPosted: this.epochsPosted, lastEpoch: this.lastEpoch, maxRebatePerEpoch: 1000n * this.unit, epochAnchor: this.anchor, epochAnchorTs: 0n, maxSlashBpsPerEpoch: 5000 }),
      launchConfig: async () => read({ admin: this.admin, runtimeAuthority: this.admin, registryProgram: this.ids.registry, lineMint: this.ids.mint, lineTokenProgram: this.tokenProgram,
        computeSink: this.admin, venue: this.admin, agentComputeBps: 7000, protocolBps: 3000, sleepThreshold: this.unit, wakeThreshold: 2n * this.unit, pumpCreatorFeeBps: 0n, features: 0,
        paused: false, maxDebitPerEpoch: 0n, usageEpochsPosted: 0n, lastUsageEpoch: 0n, usageAnchor: 0n, usageAnchorTs: 0n }),
      mint: async () => read({ decimals: this.ids.decimals, supply: 0n, tokenProgram: this.tokenProgram }),
      agents: async () => read(this.agents.map((a) => ({ ...a }))),
      launches: async () => read(this.launches.map((l) => ({ ...l }))),
      vaults: async (ids: string[] = []) => read({ slot: 1, ...this.vault, compute: Object.fromEntries(ids.map((a) => [a, this.compute[a] ?? null])) }),
      claimReceipts: async (_n: number, leaves: unknown[]) => read(leaves.map(() => null)),
      bounties: async () => read([]),
      bountyConfig: async () => read(null),
      challengeConfig: async () => read(null),
      challenges: async () => read([]),
      epoch: async (n: number) => read(this.posted.get(Number(n)) ?? null),
      slashReceipt: async () => read(null),
    };
    return r as unknown as ChainReader;
  }

  /** What the Core authority sends, applied as the program would. */
  send = async (label: string, ixs: Ix[]) => {
    this.sent.push(label);
    if (label.startsWith("post_epoch ")) {
      const rd = new Reader(ixs[0]!.data.subarray(8));
      const epoch = rd.u64();
      const payoutRoot = rd.hex32();
      const lineageRoot = rd.hex32();
      rd.u64();
      const pool = rd.u64();
      const rebate = rd.u64();
      if (this.epochsPosted > 0n && epoch !== this.lastEpoch + 1n) throw new Error("EpochOrder");
      if (pool > this.vault.pool || rebate > this.vault.reserve) throw new Error("InvalidAmount");
      this.vault.pool -= pool;
      this.vault.reserve -= rebate;
      this.vault.payable += pool + rebate;
      if (this.epochsPosted === 0n) this.anchor = epoch;
      this.epochsPosted += 1n;
      this.lastEpoch = epoch;
      this.posted.set(Number(epoch), { payoutRoot, lineageRoot, pool, rebate });
    }
    return { signature: `sig-${this.ids.registry.slice(0, 4)}-${this.sent.length}` };
  };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

interface Running {
  core: Core;
  bridge: ChainBridge;
  server: Server<undefined>;
  base: string;
  anon: CoreClient;
  stop(): void;
}

/** A Core in chain mode on `dir`, started the way main.ts starts it: parameters from chain, then the bridge. */
async function start(dir: string, chain: FakeRegistry, clock: FakeClock, adminId: string, coreKey: string | null): Promise<Running> {
  const reader = chain.reader();
  const boot = await chainBootstrap(testConfig(), reader);
  const core = new Core({ dataDir: dir, network: boot.network, adminId, clock, chainMode: true, firstEpoch: boot.firstEpoch });
  const bridge = new ChainBridge(core, chain.settings, { reader, coreKey: coreKey ? { id: coreKey, secret: new Uint8Array(64) } : null, send: chain.send });
  const server = serve(core, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    core.close();
  };
  cleanup.push(stop);
  return { core, bridge, server, base, anon: new CoreClient(base, null), stop };
}

const UNITS = 5;
const recipes: Recipe[] = Array.from({ length: UNITS }, (_, i) => ({ ...RECIPE, name: `fx${i}`, repo: `https://github.com/example/fx${i}` }));

/** The public listings the retired agent and its coin must leave. */
const LISTINGS = ["/v1/agents", "/v1/leaderboard", "/v1/feed", "/v1/activity", "/v1/sessions", "/v1/stats", "/v1/epochs", "/v1/viewers", "/v1/analytics/overview", "/v1/analytics/generations",
  "/v1/analytics/launches", "/v1/analytics/work", "/v1/analytics/results", "/v1/analytics/dashboard", "/v1/analytics/projects", "/v1/analytics/ops", "/v1/analytics/spend",
  "/v1/analytics/models", "/v1/analytics/verifiers", "/v1/analytics/social", "/v1/analytics/revenue", "/v1/learnings/agents", "/v1/learnings/stats"];
async function listings(anon: CoreClient, suffix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of LISTINGS) {
    const r = await anon.get(p + suffix);
    if (r.status !== 200) throw new Error(`${p}: ${r.status} ${JSON.stringify(r.body)}`);
    out[p] = JSON.stringify(r.body);
  }
  return out;
}

/**
 * The state the mainnet site holds before go-live: 5 calibrated units, the reference runner and two
 * verifiers bonded, both verifiers qualified on every unit, one launched agent with one accepted generation, epoch 0 open,
 * nothing posted on chain, and one slash decided but not sent.
 */
async function testDeployment() {
  const dir = mkdtempSync(join(tmpdir(), "units-switch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = new FakeClock();
  const adminKey = generateAgentKey();
  const coreAuthority = key();
  const keys = { ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey(), author: generateAgentKey() };
  const TEST = new FakeRegistry({ registry: key(), launch: key(), mint: key(), decimals: 9 }, coreAuthority, 1_000_000_000n);
  const coin = key();
  for (const k of [keys.ref, keys.v1, keys.v2]) TEST.verifier(k.id, 5n * TEST.unit);
  TEST.launch(keys.author.id, coin, recipes[0]!.repo, 50n * TEST.unit);
  TEST.vault.pool = 3n * TEST.unit;
  TEST.vault.reserve = 100n * TEST.unit;

  // the test deployment's Core holds no authority key here: nothing is posted, as on the site (0 epochs posted)
  const a = await start(dir, TEST, clock, adminKey.id, null);
  await a.bridge.tick();
  /** The same keys as clients of one running Core (a restart listens on a new port). */
  const on = (r: Running) => {
    const who = (k: AgentKey): Agent => agentClient({ base: r.base, clock }, k);
    const [admin, ref, v1, v2, author] = [who(adminKey), who(keys.ref), who(keys.v1), who(keys.v2), who(keys.author)];
    const env = (lineage: string): Env =>
      ({ core: r.core, clock, server: r.server, base: r.base, admin, anon: r.anon, dir, cfg: r.core.cfg, verifiers: [v1, v2], reference: ref, lineage, gen0: "", close() {} }) as Env;
    return { admin, ref, v1, v2, author, env };
  };
  const { admin, ref, v1, v2 } = on(a);
  for (const v of [ref, v1, v2]) await expectOk(v.c.put(`/v1/agents/${v.id}/capabilities`, { capabilities: CAPS }));
  await expectOk(admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  const lineages: string[] = [];
  for (const r of recipes) {
    await expectOk(admin.c.post("/v1/admin/recipes", { recipe: r, recipe_id: recipeId(r) }));
    await expectOk(admin.c.post("/v1/admin/snapshots", { repo: r.repo, commit: r.commit, deps_digest: DEPS }));
    const calib = { ...CALIB, recipe_id: recipeId(r), snapshot_id: snapshotId(repoId(r.repo), r.commit, DEPS) };
    const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: calib, sig: signMessage(ref.key, calibId(calib.recipe_id, calib.snapshot_id, calib)) }));
    lineages.push(lin.lineage_id);
  }
  // Core issues one qualification per verifier at a time (the reference runner calibrates, it is not drawn)
  for (let i = 0; i < UNITS; i++) {
    a.core.tick();
    for (const v of [v1, v2]) await qualify(v);
  }
  return { dir, clock, adminKey, coreAuthority, keys, TEST, coin, a, lineages, on, ...on(a) };
}

describe("deployment switch: one Core database from the mainnet test deployment to the official one", () => {
  test("units, calibrations and qualifications carry over; the test agent, its coin, its generation, its epoch and its slash stay behind", async () => {
    const t = await testDeployment();
    const { a, TEST, clock, author, v1, v2, ref, lineages } = t;

    // ---- the test deployment's life: a session, activity, one accepted generation, an unsent slash
    const e0 = t.env(lineages[0]!);
    const lv = await expectOk(a.anon.get(`/v1/lineages/${lineages[0]}`));
    const sess = await expectOk(author.c.post("/v1/sessions", { lineage_id: lineages[0], gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
    await expectOk(author.c.post(`/v1/sessions/${sess.session_id}/events`, { events: [{ kind: "read", path: "src/lib.rs", start_line: 1, end_line: 3 }] }));
    await expectOk(author.c.post("/v1/activity", { events: [{ lineage_id: lineages[0], gen_id: lv.tip, commit: lv.snapshot.commit_sha, kind: "search", query: "slow_" }] }));
    const c0 = await submit(e0, author, diff("test_one"));
    await runReplays(e0, c0.candidate_id, honest(result({}, 800)));
    const cand0 = await candidate(e0, c0.candidate_id);
    expect(cand0.status).toBe("accepted");
    const gen0 = cand0.gen_id as string;
    a.core.tx(() => (a.core as any).slash(v1.id, 1000, "minority", "replay-on-the-test-deployment"));
    await a.bridge.tick();

    const one = <T>(core: Core, sql: string, ...p: any[]) => core.db.query<T, any[]>(sql).get(...p);
    const all = <T>(core: Core, sql: string, ...p: any[]) => core.db.query<T, any[]>(sql).all(...p);
    const quals = (core: Core) => all<{ agent_id: string; lineage_id: string; status: string }>(core, "SELECT agent_id, lineage_id, status FROM qualifications ORDER BY agent_id, lineage_id, attempt");
    const calibs = (core: Core) => all(core, "SELECT * FROM calibrations ORDER BY calib_id");
    const before = {
      epoch: a.core.currentEpoch().n,
      lineages: await expectOk<any[]>(a.anon.get("/v1/lineages")),
      views: await Promise.all(lineages.map((l) => expectOk(a.anon.get(`/v1/lineages/${l}`)))),
      quals: quals(a.core),
      calibs: calibs(a.core),
      listings: await listings(a.anon),
      units: all<{ agent_id: string; kind: string; epoch: number }>(a.core, "SELECT agent_id, kind, epoch FROM units ORDER BY id"),
    };
    expect(before.epoch).toBe(0);
    expect(before.lineages.length).toBe(UNITS);
    expect(before.lineages.every((l) => l.status === "active")).toBe(true);
    expect(before.calibs.length).toBe(UNITS);
    // both verifiers passed on every unit; the reference runner calibrated each of them
    for (const v of [v1, v2]) expect(before.quals.filter((q) => q.agent_id === v.id && q.status === "passed").length).toBe(UNITS);
    expect(before.quals.length).toBe(2 * UNITS);
    expect(a.core.agentView(ref.id).reference).toBe(true);
    // the test agent is in the listings today, and earned units in the open epoch (not paid: nothing was posted)
    for (const p of ["/v1/agents", "/v1/leaderboard", "/v1/feed", "/v1/activity", "/v1/sessions"]) expect([p, before.listings[p]!.includes(author.id)]).toEqual([p, true]);
    expect(before.units.filter((u) => u.agent_id === author.id).map((u) => [u.kind, u.epoch])).toEqual([["author", 0]]);
    expect(before.units.some((u) => u.kind === "replay" && u.agent_id === v2.id)).toBe(true);
    expect(TEST.sent).toEqual([]);
    expect(a.core.chainPendingSlashes().map((s) => s.agent_id)).toEqual([v1.id]);
    // on the test registry the bond mirror is net of the slash Core decided and has not sent
    expect(BigInt(a.core.agentView(v1.id).bond)).toBe(5n * TEST.unit - (5n * TEST.unit) / 10n);
    expect(a.core.agentView(author.id)).toMatchObject({ awake: true, compute: (50n * TEST.unit).toString() });
    a.stop();

    // ---- go-live: the same database, a Core restarted against the official programs
    const OFFICIAL = new FakeRegistry({ registry: key(), launch: key(), mint: key(), decimals: 6 }, t.coreAuthority, 1_000_000n);
    for (const k of [t.keys.ref, t.keys.v1, t.keys.v2]) OFFICIAL.verifier(k.id, 7n * OFFICIAL.unit); // registered and bonded before Core restarts
    OFFICIAL.vault.pool = 2n * OFFICIAL.unit;
    OFFICIAL.vault.reserve = 40n * OFFICIAL.unit;
    clock.advance(60_000);
    const b = await start(t.dir, OFFICIAL, clock, t.adminKey.id, t.coreAuthority);
    expect(b.core.cfg.token_decimals).toBe(6);
    expect(b.core.cfg.min_bond).toBe(5n * OFFICIAL.unit);
    await b.bridge.tick();
    const d = deploymentsOf(b.core);

    // the registry program id is what tells the deployments apart; the earlier one is retired through epoch 0
    const deps = (await expectOk(b.anon.get("/v1/chain/deployments"))).deployments;
    expect(deps.map((x: any) => [x.registry_program, x.retired_at !== null, x.through_epoch, x.last_posted_epoch, x.unposted_epochs])).toEqual([
      [TEST.ids.registry, true, 0, null, "[0]"],
      [OFFICIAL.ids.registry, false, null, null, null],
    ]);

    // kept: every unit active with its calibration, tip and height; every qualification as it was
    expect(await expectOk<any[]>(b.anon.get("/v1/lineages"))).toEqual(before.lineages);
    expect(calibs(b.core)).toEqual(before.calibs);
    expect(quals(b.core)).toEqual(before.quals);
    const viewsAfter = await Promise.all(lineages.map((l) => expectOk(b.anon.get(`/v1/lineages/${l}`))));
    expect(viewsAfter.map((v) => [v.lineage_id, v.status, v.tip, v.height, v.calibration])).toEqual(before.views.map((v) => [v.lineage_id, v.status, v.tip, v.height, v.calibration]));

    // bonds: zeroed at the switch and read again from the official registry (7 tokens at 6 decimals, not 5 at 9
    // net of a slash the official registry never saw)
    for (const v of [ref, v1, v2]) {
      expect(b.core.agentView(v.id).bond).toBe((7n * OFFICIAL.unit).toString());
      const hist = all<{ action: string; amount: string }>(b.core, "SELECT action, amount FROM bonds WHERE agent_id = ? ORDER BY id DESC LIMIT 2", v.id);
      expect(hist.map((h) => h.action)).toEqual(["bond", "unbond_release"]);
      expect(hist[0]!.amount).toBe((7n * OFFICIAL.unit).toString());
    }
    const bal = b.core.ledger.balances();
    expect([bal.pool, bal.reserve]).toEqual([OFFICIAL.vault.pool.toString(), OFFICIAL.vault.reserve.toString()]);
    expect(b.core.ledger.reconcile().ok).toBe(true);

    // retired: the test agent sleeps with no vault, carries a retired marker and a hidden entry, and is in no listing
    const av = await expectOk(b.anon.get(`/v1/agents/${author.id}`));
    expect(av).toMatchObject({ agent_id: author.id, awake: false, compute: "0", mint: t.coin, retired: { registry_program: TEST.ids.registry, mint: t.coin }, hidden: { mint: t.coin } });
    expect(av.hidden.reason).toContain(TEST.ids.registry);
    expect(av.hidden.reason).not.toContain(String.fromCharCode(0x2014));
    expect((await expectOk(b.anon.get("/v1/hidden"))).hidden).toMatchObject([{ mint: t.coin, added_by: RETIRED_BY }]);
    const after = await listings(b.anon);
    for (const [p, text] of Object.entries(after)) expect([p, text.includes(author.id), text.includes(t.coin)]).toEqual([p, false, false]);
    // the generation itself is the unit's state (its tip, the metric it improved): only the unit's own views
    // show it, by id and without its author; no agent or generation listing does
    expect(Object.entries(after).filter(([, text]) => text.includes(gen0)).map(([p]) => p).sort()).toEqual(["/v1/analytics/projects", "/v1/analytics/results"]);
    // still there when asked for, and in the database
    const withHidden = await listings(b.anon, "?hidden=1");
    for (const p of ["/v1/agents", "/v1/leaderboard", "/v1/feed", "/v1/activity", "/v1/sessions"]) expect([p, withHidden[p]!.includes(author.id)]).toEqual([p, true]);
    expect(one<{ kind: string }>(b.core, "SELECT kind FROM agents WHERE agent_id = ?", author.id)?.kind).toBe("launched");
    expect(one<{ author: string }>(b.core, "SELECT author FROM generations WHERE gen_id = ?", gen0)?.author).toBe(author.id);
    expect((await expectOk(b.anon.get(`/v1/generations/${gen0}`))).retired).toMatchObject({ agent_id: author.id, registry_program: TEST.ids.registry });
    // counts: the retired agent and what it authored are out of the public numbers and named beside them
    const stats = await expectOk(b.anon.get("/v1/stats"));
    expect(stats).toMatchObject({ lineages: UNITS, generations: 0, candidates: 0, epoch: 1, hidden_agents: 1, retired: { agents: 1, generations: 1, candidates: 1 } });
    expect(stats.agents).toBe(3);

    // the epoch open across the switch: closed with the retired registry, never posted, out of the list, marked
    expect(b.core.currentEpoch().n).toBe(1);
    expect((await expectOk<any[]>(b.anon.get("/v1/epochs"))).map((e) => [e.n, e.status])).toEqual([[1, "open"]]);
    expect((await expectOk<any[]>(b.anon.get("/v1/epochs?retired=1"))).map((e) => [e.n, e.status, e.retired ?? null])).toEqual([[1, "open", null], [0, "closed", "unposted"]]);
    const ep0 = await expectOk(b.anon.get("/v1/epochs/0"));
    expect(ep0).toMatchObject({ n: 0, status: "closed", retired: "unposted" });
    expect(ep0.units.map((u: any) => u.agent)).toContain(author.id); // what it earned stays on record there
    for (const who of [author, v1, v2]) expect(await expectOk<unknown[]>(b.anon.get(`/v1/epochs/0/proofs/${who.id}`))).toEqual([]);
    expect(b.core.chainPendingEpochs()).toEqual([]);
    expect(b.core.chainPostedLeaves()).toEqual([]);

    // the slash decided on the test deployment: kept on record, never sent to the official registry
    expect(one<{ c: number }>(b.core, "SELECT COUNT(*) AS c FROM slashes WHERE agent_id = ?", v1.id)!.c).toBe(1);
    expect(b.core.chainPendingSlashes()).toEqual([]);
    expect(OFFICIAL.sent).toEqual([]);

    // ---- the official deployment's first work: a new agent launches, the same verifiers take its replays
    const onB = t.on(b);
    const e1 = onB.env(lineages[1]!);
    expect((b.core as any).eligiblePool(new Set(), new Set(), (b.core as any).lineageRow(lineages[1])).map((x: any) => x.agent).sort()).toEqual([v1.id, v2.id].sort());
    const fresh = agentClient({ base: b.base, clock });
    const freshMint = key();
    OFFICIAL.launch(fresh.id, freshMint, recipes[1]!.repo, 50n * OFFICIAL.unit);
    await b.bridge.tick();
    expect(b.core.agentView(fresh.id)).toMatchObject({ awake: true, mint: freshMint });
    expect(d.isRetired(fresh.id)).toBe(false);
    // the retired agent cannot author on the official deployment, and nothing later credits it
    expect((await onB.author.c.post("/v1/candidates", { lineage_id: lineages[1], parent_gen_id: viewsAfter[1]!.tip, kind: "perf", target: "ir", commitment: "c".repeat(64), claimed_effect: 0.1 })).status).toBe(403);
    b.core.tx(() => (b.core as any).addUnits(author.id, "author", "a-port-credit", 5));
    b.core.tx(() => (b.core as any).refreshAwake(author.id));
    expect(b.core.agentView(author.id).awake).toBe(false);
    const c1 = await submit(e1, fresh, diff("official_one"));
    await runReplays(e1, c1.candidate_id, honest(result({}, 800)));
    expect((await candidate(e1, c1.candidate_id)).status).toBe("accepted");
    const unitsNow = all<{ agent_id: string; epoch: number }>(b.core, "SELECT agent_id, epoch FROM units WHERE epoch > 0 ORDER BY id");
    expect(unitsNow.length).toBeGreaterThan(0);
    expect(unitsNow.every((u) => u.epoch === 1 && u.agent_id !== author.id)).toBe(true);
    expect(all(b.core, "SELECT 1 FROM units WHERE agent_id = ? AND epoch > 0", author.id)).toEqual([]);

    // ---- Core's first post on the official registry: epoch 1 sets the anchor, pays only official work
    const closed = b.core.closeEpoch();
    expect(closed.n).toBe(1);
    await b.bridge.tick();
    expect(OFFICIAL.sent).toEqual(["post_epoch 1"]);
    expect([OFFICIAL.epochsPosted, OFFICIAL.anchor, OFFICIAL.lastEpoch]).toEqual([1n, 1n, 1n]);
    expect(OFFICIAL.posted.get(1)!.payoutRoot).toBe(closed.root!);
    const leaves = closed.payouts as { agent: string; dest: string; amount: string }[];
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.some((l) => l.agent === author.id || l.dest.includes(author.id))).toBe(false);
    expect(leaves.map((l) => l.agent).sort()).toEqual([fresh.id, v1.id, v2.id].sort());
    // the whole official pool went to official work; nothing of the test deployment's pool or units is in it
    expect(OFFICIAL.posted.get(1)!.pool).toBe(2n * OFFICIAL.unit);
    expect(b.core.chainEpochs().map((e) => [e.n, !!e.signature])).toEqual([[1, true]]);
    // later syncs and epochs: the retired epoch and slash never come back
    b.core.closeEpoch();
    await b.bridge.tick();
    await b.bridge.tick();
    expect(OFFICIAL.sent).toEqual(["post_epoch 1", "post_epoch 2"]);
    expect(OFFICIAL.sent.some((l) => l.startsWith("slash"))).toBe(false);
    expect(b.core.ledger.reconcile().ok).toBe(true);
    expect((await expectOk<any[]>(b.anon.get("/v1/epochs"))).map((e) => e.n)).toEqual([3, 2, 1]);
  });

  test("a registry that carries no agent yet: nothing of the earlier one counts until its records are read", async () => {
    const t = await testDeployment();
    const { a, TEST, clock, author, v1, v2, ref, lineages } = t;
    expect(BigInt(a.core.agentView(v1.id).bond)).toBe(5n * TEST.unit);
    a.stop();
    const OFFICIAL = new FakeRegistry({ registry: key(), launch: key(), mint: key(), decimals: 6 }, t.coreAuthority, 1_000_000n);
    const b = await start(t.dir, OFFICIAL, clock, t.adminKey.id, t.coreAuthority);
    await b.bridge.tick();
    // no verifier is registered on the official registry: no bond, nobody eligible, the test agent asleep
    for (const v of [ref, v1, v2]) expect(b.core.agentView(v.id).bond).toBe("0");
    expect(b.core.agentView(author.id)).toMatchObject({ awake: false, compute: "0" });
    const pool = () => (b.core as any).eligiblePool(new Set(), new Set(), (b.core as any).lineageRow(lineages[0])).map((x: any) => x.agent).sort();
    expect(pool()).toEqual([]);
    // registered and bonded: eligible on the next sync, with the qualifications they already hold
    for (const k of [t.keys.ref, t.keys.v1, t.keys.v2]) OFFICIAL.verifier(k.id, 5n * OFFICIAL.unit);
    await b.bridge.tick();
    expect(pool()).toEqual([v1.id, v2.id].sort());
    expect(b.core.ledger.reconcile().ok).toBe(true);
    // a second sync against the same registry retires nothing more
    const events = () => b.core.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events WHERE type = 'chain.deployment_retired'").get()!.c;
    expect(events()).toBe(1);
    await b.bridge.tick();
    expect(events()).toBe(1);
    expect(b.core.currentEpoch().n).toBe(1);
  });

  test("an agent the new registry carries is not retired: a relaunch under the same key, or the same launch read again", async () => {
    const t = await testDeployment();
    const { a, TEST, clock, author } = t;
    a.stop();
    const NEXT = new FakeRegistry({ registry: key(), launch: key(), mint: key(), decimals: 6 }, t.coreAuthority, 1_000_000n);
    const newCoin = key();
    NEXT.launch(author.id, newCoin, recipes[0]!.repo, 50n * NEXT.unit);
    const b = await start(t.dir, NEXT, clock, t.adminKey.id, t.coreAuthority);
    await b.bridge.tick();
    const d = deploymentsOf(b.core);
    expect(d.isRetired(author.id)).toBe(false);
    expect(b.core.agentView(author.id)).toMatchObject({ awake: true, mint: newCoin, compute: (50n * NEXT.unit).toString() });
    // its earlier coin stays hidden as history; the agent itself is listed
    expect((await expectOk(b.anon.get("/v1/hidden"))).hidden.map((h: any) => h.mint)).toEqual([t.coin]);
    expect((await expectOk<any[]>(b.anon.get("/v1/agents"))).map((x) => x.agent_id)).toContain(author.id);
    expect(d.previousOf(author.id).map((p) => p.mint)).toEqual([t.coin]);
    b.stop();
    // back on the earlier registry (a rollback): its own launch is carried again and its coin unhidden
    const c = await start(t.dir, TEST, clock, t.adminKey.id, null);
    c.core.db.query("UPDATE agents SET mint = ? WHERE agent_id = ?").run(t.coin, author.id); // as a Core that never saw the relaunch
    c.core.db.query("DELETE FROM retired_agents").run();
    c.core.db.query("INSERT INTO retired_agents (agent_id, mint, registry_program, label, retired_at) VALUES (?, ?, ?, NULL, 1)").run(author.id, t.coin, TEST.ids.registry);
    await c.bridge.tick();
    expect(deploymentsOf(c.core).isRetired(author.id)).toBe(false);
    expect((await expectOk(c.anon.get("/v1/hidden"))).hidden).toEqual([]);
  });
});
