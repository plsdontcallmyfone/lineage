import { contributionLeaf, recordLeaf, type AgentRecordDoc, type Contribution } from "./records.ts";
import {
  canonicalJson,
  costClass,
  effectValue,
  judge,
  leafHash,
  merkleRoot,
  proportionalSplit,
  type Calibration,
  type CandidateView,
  type Judgement,
  type JudgeConfig,
  type Recipe,
  type RevealedReplay,
} from "./protocol.ts";

// Replica mode (SPEC 10.8, milestone M4). A second Core started read-only with `--replica-of <url>`
// reads only the public API of the Core it follows and recomputes, from that public log alone:
//
// - every final verdict: the judge over the candidate's revealed replays of its final stage (the
//   same pure function, recipe, effective calibration and judge config) must give the published
//   verdict digest; the same for every settled audit and every resolved challenge judgement;
// - every unit award: each counted replay earned u_replay x cost class (and its rebate), each
//   accepted generation's author and finder units sum to u_author x cost class x effect value;
// - every closed epoch: the payout leaves and root from the units awarded and not voided in it (the
//   event log, in Core's order), the pool and rebate it paid; the lineage root from the
//   generations that existed at its close; the record root from the published records.
//
// It holds no key, writes nothing and never talks to the chain; any divergence is reported with the
// object, the field, Core's value and the replica's.

export interface PayoutUnit {
  agent: string;
  kind: string;
  units: number;
  rebate: bigint;
}
export interface ComputedLeaf {
  agent: string;
  dest: string;
  amount: string;
  units: number;
  rebate: string;
  leaf: string;
}

/**
 * Core's epoch payout rule (closeEpochInner) as a pure function: units by (agent, destination), the
 * pool split by units, rebates paid in full or, when the reserve is short, pro rata to it.
 */
export function computePayouts(p: { epoch: number; units: PayoutUnit[]; destFor: (agent: string, kind: string) => string; pool: bigint; reserve: bigint;
  walletOf: (agent: string) => string }): { leaves: ComputedLeaf[]; root: string; poolOut: bigint; rebateOut: bigint; totalUnits: number } {
  const key = (agent: string, dest: string) => `${agent}\n${dest}`;
  const unitMap = new Map<string, number>();
  const rebateMap = new Map<string, bigint>();
  for (const u of p.units) {
    const k = key(u.agent, p.destFor(u.agent, u.kind));
    unitMap.set(k, (unitMap.get(k) ?? 0) + u.units);
    if (u.rebate > 0n) {
      const rk = key(u.agent, p.walletOf(u.agent));
      rebateMap.set(rk, (rebateMap.get(rk) ?? 0n) + u.rebate);
    }
  }
  const split = proportionalSplit(p.pool, unitMap);
  const wanted = [...rebateMap.values()].reduce((a, b) => a + b, 0n);
  const rebates = wanted <= p.reserve ? rebateMap : proportionalSplit(p.reserve, new Map([...rebateMap].map(([k, v]) => [k, Number(v)])));
  const keys = [...new Set([...split.keys(), ...rebates.keys(), ...unitMap.keys()])].sort();
  const leaves: ComputedLeaf[] = [];
  let poolOut = 0n;
  let rebateOut = 0n;
  for (const k of keys) {
    const [agent, dest] = k.split("\n") as [string, string];
    const a = split.get(k) ?? 0n;
    const r = rebates.get(k) ?? 0n;
    poolOut += a;
    rebateOut += r;
    const amount = a + r;
    if (amount === 0n) continue;
    leaves.push({ agent, dest, amount: amount.toString(), units: unitMap.get(k) ?? 0, rebate: r.toString(),
      leaf: leafHash(canonicalJson({ epoch: p.epoch, agent, dest, amount: amount.toString() })) });
  }
  return { leaves, root: merkleRoot(leaves.map((l) => l.leaf)), poolOut, rebateOut, totalUnits: [...unitMap.values()].reduce((a, b) => a + b, 0) };
}

/** The lineage root Core posts with an epoch: every generation row that existed at its close. */
export function lineageRootOf(gens: { lineage_id: string; gen_id: string; parent_gen_id: string | null; height: number; entry_type: string }[]): string {
  const rows = [...gens].sort((a, b) => (a.lineage_id === b.lineage_id ? a.height - b.height : a.lineage_id < b.lineage_id ? -1 : 1));
  return merkleRoot(rows.map((g) => leafHash(canonicalJson({ lineage_id: g.lineage_id, gen_id: g.gen_id, parent_gen_id: g.parent_gen_id, height: g.height,
    entry_type: g.entry_type }))));
}

interface GenLite {
  gen_id: string;
  lineage_id: string;
  parent_gen_id: string | null;
  height: number;
  entry_type: string;
  kind: string | null;
  effect: unknown;
  epoch: number;
  reverts: string | null;
  candidate_id: string | null;
  author: string | null;
  target: unknown;
}

/** Core's effectiveCalibration: tests fixed by `fix` generations in the patch series join the stable set (SPEC 9.3). */
export function effectiveCalibration(calib: Calibration, gens: Map<string, GenLite>, gen: string): Calibration {
  const chain: GenLite[] = [];
  for (let g = gens.get(gen); g; g = g.parent_gen_id ? gens.get(g.parent_gen_id) : undefined) chain.push(g);
  const reverted = new Set(chain.filter((x) => x.entry_type === "revert").map((x) => x.reverts!));
  const fixed = new Set<string>();
  for (const g of chain) {
    if (g.entry_type !== "patch" || reverted.has(g.gen_id)) continue;
    if (g.kind === "fix" && g.effect) for (const t of (g.effect as { fixed: string[] }).fixed) fixed.add(t);
  }
  if (!fixed.size) return calib;
  return { ...calib, stable: [...new Set([...calib.stable, ...fixed])].sort(), known_failures: calib.known_failures.filter((t) => !fixed.has(t)) };
}

export interface Divergence {
  kind: "verdict" | "audit" | "challenge" | "units" | "epoch" | "fetch";
  id: string;
  field: string;
  core: unknown;
  replica: unknown;
}
export interface ReplicaReport {
  v: 1;
  source: string;
  started_at: number;
  finished_at: number;
  core_epoch: number | null;
  verdicts: { checked: number; skipped: number };
  audits: { checked: number };
  challenges: { checked: number; available: boolean };
  units: { checked: number; pending: number };
  epochs: { checked: number; closed: number };
  divergences: Divergence[];
  ok: boolean;
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

class Source {
  constructor(readonly base: string, readonly fetchImpl: typeof fetch = fetch) {}
  async get(path: string, allow404 = false): Promise<Json> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await this.fetchImpl(this.base.replace(/\/$/, "") + path, { headers: { accept: "application/json" } });
        if (r.status === 404 && allow404) return null;
        if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        last = e;
        await new Promise((res) => setTimeout(res, 250 * 2 ** attempt));
      }
    }
    throw last;
  }
}

const TERMINAL = new Set(["accepted", "rejected", "expired"]);
const REF_KINDS = new Set(["reference", "audit_reference", "challenge_reference"]);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Recomputes everything final on the Core at `url` from its public API. */
export async function replicate(url: string, opts: { fetch?: typeof fetch; log?: (m: string) => void } = {}): Promise<ReplicaReport> {
  const src = new Source(url, opts.fetch);
  const log = opts.log ?? (() => undefined);
  const started_at = Date.now();
  const div: Divergence[] = [];
  const report = (d: Divergence) => {
    div.push(d);
    log(`DIVERGENCE ${d.kind} ${d.id} ${d.field}: core ${JSON.stringify(d.core)} replica ${JSON.stringify(d.replica)}`);
  };
  const cfgView = await src.get("/v1/config");
  const net = cfgView.network as Json;
  const judgeCfg: JudgeConfig = { quorum: net.quorum, det_tolerance: net.det_tolerance, bootstrap_resamples: net.bootstrap_resamples };
  const health = await src.get("/v1/health");

  // lineages, recipes, calibrations, generations
  const lineageList = (await src.get("/v1/lineages")) as Json[];
  const lineages = new Map<string, { recipe: Recipe; calibration: Calibration }>();
  const gens = new Map<string, GenLite>();
  for (const l of lineageList) {
    const v = await src.get(`/v1/lineages/${l.lineage_id}`);
    lineages.set(v.lineage_id, { recipe: v.recipe, calibration: v.calibration });
    for (const g of v.generations as Json[]) gens.set(g.gen_id, { ...g, lineage_id: v.lineage_id });
  }

  // candidates: every final one with a verdict is recomputed
  const replays = new Map<string, { role: string | null; kind: string; replayer: string; candidate_id: string; lineage_id: string }>();
  const finalVerdicts = new Map<string, Judgement>();
  let checkedV = 0;
  let skipped = 0;
  let auditsChecked = 0;
  for (const l of lineageList) {
    const list = (await src.get(`/v1/candidates?lineage=${l.lineage_id}&limit=1000`)) as Json[];
    for (const s of list) {
      if (!TERMINAL.has(s.status)) continue;
      const c = await src.get(`/v1/candidates/${s.commit_id}`);
      for (const r of c.replays as Json[]) if (r.replay_id) replays.set(r.replay_id, { role: r.role, kind: r.kind, replayer: r.replayer, candidate_id: c.candidate_id, lineage_id: c.lineage_id });
      if (!c.verdict) {
        skipped++;
        continue;
      }
      finalVerdicts.set(c.candidate_id, c.verdict);
      const lin = lineages.get(c.lineage_id)!;
      const group = (c.replays as Json[]).filter((r) => r.audit_id === null && r.stage === c.stage && r.status === "revealed" && !String(r.kind).startsWith("challenge"));
      const evalParent = group[0]?.eval_parent_gen_id ?? c.eval_parent_gen_id;
      const calib = effectiveCalibration(lin.calibration, gens, evalParent);
      const view: CandidateView = { candidate_id: c.candidate_id, author: c.author, kind: c.kind, target: c.target };
      const revealed: RevealedReplay[] = group.map((r) => ({ replay_id: r.replay_id, replayer: r.replayer, seed: r.seed, result: r.result, reference: r.kind === "reference" }));
      const j = judge(lin.recipe, calib, view, revealed, judgeCfg);
      checkedV++;
      if (j.digest !== c.verdict.digest) report({ kind: "verdict", id: c.candidate_id, field: "digest", core: c.verdict.digest, replica: j.digest });
      else if (j.outcome !== c.verdict.outcome) report({ kind: "verdict", id: c.candidate_id, field: "outcome", core: c.verdict.outcome, replica: j.outcome });
      if (c.status === "accepted" && c.gen_id) {
        const g = gens.get(c.gen_id);
        const gv = await src.get(`/v1/generations/${c.gen_id}`);
        if (gv.verdict_digest !== c.verdict.digest) report({ kind: "verdict", id: c.gen_id, field: "generation.verdict_digest", core: gv.verdict_digest, replica: c.verdict.digest });
        // settled audit: the original counted replays plus the audit group, judged together
        if (gv.audit && gv.audit.status !== "pending" && gv.audit.verdict) {
          const auditGroup = (c.replays as Json[]).filter((r) => r.audit_id === gv.audit.audit_id && r.status === "revealed");
          const orig = group.filter((r) => (c.verdict.counted as string[]).includes(r.replay_id));
          const all = [...orig, ...auditGroup].map((r) => ({ replay_id: r.replay_id, replayer: r.replayer, seed: r.seed, result: r.result,
            reference: r.kind === "reference" || r.kind === "audit_reference" }));
          const ja = judge(lin.recipe, calib, view, all, judgeCfg);
          if (ja.digest !== gv.audit.verdict.digest) report({ kind: "audit", id: gv.audit.audit_id, field: "digest", core: gv.audit.verdict.digest, replica: ja.digest });
          auditsChecked++;
        }
        void g;
      }
    }
  }

  // resolved challenges (when the Core serves them): the combined judgement of a verdict challenge
  let challengesChecked = 0;
  const chList = (await src.get("/v1/challenges", true)) as Json[] | null;
  if (chList) {
    for (const ch of chList) {
      if (!["upheld", "failed", "void"].includes(ch.status) || ch.kind !== "verdict" || !ch.resolution?.combined) continue;
      const c = await src.get(`/v1/candidates/${ch.subject}`);
      const lin = lineages.get(c.lineage_id)!;
      const orig = (c.replays as Json[]).filter((r) => (ch.resolution.original_group as string[]).includes(r.replay_id));
      const fresh = (c.replays as Json[]).filter((r) => r.audit_id === ch.challenge_id && r.status === "revealed");
      const calib = effectiveCalibration(lin.calibration, gens, orig[0]?.eval_parent_gen_id ?? c.eval_parent_gen_id);
      const view: CandidateView = { candidate_id: c.candidate_id, author: c.author, kind: c.kind, target: c.target };
      const jc = judge(lin.recipe, calib, view, [...orig, ...fresh].map((r) => ({ replay_id: r.replay_id, replayer: r.replayer, seed: r.seed, result: r.result,
        reference: REF_KINDS.has(r.kind) })), judgeCfg);
      challengesChecked++;
      if (jc.digest !== ch.resolution.combined.digest) report({ kind: "challenge", id: ch.challenge_id, field: "combined.digest", core: ch.resolution.combined.digest, replica: jc.digest });
    }
  }

  // the event log: unit awards and voids in Core's order
  const awarded: { id: number; agent: string; kind: string; ref: string; units: number; rebate: bigint; epoch: number }[] = [];
  const voided = new Set<string>();
  for (let since = 0; ; ) {
    const page = (await src.get(`/v1/events/log?since=${since}&limit=5000`)) as Json[];
    for (const e of page) {
      if (e.type === "units.awarded") awarded.push({ id: e.id, agent: e.data.agent, kind: e.data.kind, ref: e.data.ref, units: e.data.units, rebate: BigInt(e.data.rebate),
        epoch: e.data.epoch });
      else if (e.type === "units.voided") voided.add(`${e.data.agent}\n${e.data.kind}\n${e.data.ref}\n${e.data.epoch}`);
    }
    if (page.length < 5000) break;
    since = page[page.length - 1].id;
  }
  const live = awarded.filter((u) => !voided.has(`${u.agent}\n${u.kind}\n${u.ref}\n${u.epoch}`));

  // unit awards follow from the verdicts
  let unitsChecked = 0;
  let unitsPending = 0;
  const lineageOfGen = (g: string) => gens.get(g)?.lineage_id;
  const authorTotals = new Map<string, number>();
  for (const u of awarded) {
    if (u.kind === "replay") {
      const r = replays.get(u.ref);
      if (r) unitsChecked++;
      if (!r) {
        // a replay of a candidate that is not final yet (a rebased stage 0 is paid when judged): checked once final
        unitsPending++;
        continue;
      }
      const lin = lineages.get(r.lineage_id)!;
      const cls = costClass(lin.calibration.median_eval_seconds);
      if (!close(u.units, net.u_replay * cls)) report({ kind: "units", id: u.ref, field: "replay.units", core: u.units, replica: net.u_replay * cls });
      if (u.rebate !== BigInt(net.rebate_per_class) * BigInt(cls)) report({ kind: "units", id: u.ref, field: "replay.rebate", core: u.rebate.toString(),
        replica: (BigInt(net.rebate_per_class) * BigInt(cls)).toString() });
      const wasCounted = r.role === "counted" || r.role === "canary_pass" || voided.has(`${u.agent}\nreplay\n${u.ref}\n${u.epoch}`);
      if (!wasCounted) report({ kind: "units", id: u.ref, field: "replay.role", core: r.role, replica: "counted" });
    } else if (u.kind === "author" || u.kind === "finder") {
      authorTotals.set(u.ref, (authorTotals.get(u.ref) ?? 0) + u.units);
    }
  }
  for (const [genId, total] of authorTotals) {
    const g = gens.get(genId);
    unitsChecked++;
    if (!g || g.entry_type !== "patch") {
      report({ kind: "units", id: genId, field: "author", core: total, replica: "no accepted generation" });
      continue;
    }
    const lin = lineages.get(lineageOfGen(genId)!)!;
    const target = g.target as string | string[];
    const metric = Array.isArray(target) ? target[0] : target;
    const minEffect = lin.recipe.metrics.find((m) => m.name === metric)?.min_effect ?? 1;
    const want = net.u_author * costClass(lin.calibration.median_eval_seconds) * effectValue(g.effect as never, minEffect, net.value_cap);
    if (!close(total, want)) report({ kind: "units", id: genId, field: "author+finder units", core: total, replica: want });
  }
  // every counted replay of a final candidate was paid (reference runners are paid from the reserve)
  const paid = new Set(awarded.filter((u) => u.kind === "replay").map((u) => u.ref));
  for (const [id, r] of replays) {
    if ((r.role === "counted" || r.role === "canary_pass") && !REF_KINDS.has(r.kind) && !paid.has(id)) {
      unitsChecked++;
      report({ kind: "units", id, field: "replay", core: "not awarded", replica: "counted" });
    }
  }

  // closed epochs
  const agents = (await src.get("/v1/agents")) as Json[];
  const agentById = new Map(agents.map((a) => [a.agent_id ?? a.id, a]));
  const destFor = (agent: string, kind: string) => {
    const a = agentById.get(agent);
    if ((kind === "author" || kind === "finder" || kind === "upstream") && a?.kind === "launched") return net.author_reward_to === "compute" ? `agent:${agent}:compute` : `wallet:${a.launcher}`;
    return `agent:${agent}:wallet`;
  };
  const epochs = (await src.get("/v1/epochs")) as Json[];
  let epochsChecked = 0;
  const recordLeavesByEpoch = new Map<number, Set<string>>();
  const closedEpochs = epochs.filter((e) => e.status === "closed");
  if (closedEpochs.length) {
    for (const a of agents) {
      const rv = await src.get(`/v1/agents/${a.agent_id ?? a.id}/records`, true);
      for (const ep of (rv?.epochs ?? []) as Json[]) {
        const set = recordLeavesByEpoch.get(ep.epoch) ?? new Set<string>();
        for (const l of ep.leaves as Json[]) {
          const want = l.kind === "record" ? recordLeaf(l.record as AgentRecordDoc) : contributionLeaf(l.contribution as Contribution);
          if (want !== l.leaf) report({ kind: "epoch", id: String(ep.epoch), field: `record leaf of ${a.agent_id ?? a.id}`, core: l.leaf, replica: want });
          set.add(l.leaf);
        }
        recordLeavesByEpoch.set(ep.epoch, set);
      }
    }
  }
  for (const e of closedEpochs) {
    const ep = await src.get(`/v1/epochs/${e.n}`);
    epochsChecked++;
    const units = live.filter((u) => u.epoch === ep.n).sort((a, b) => a.id - b.id);
    const p = computePayouts({ epoch: ep.n, units, destFor, pool: BigInt(ep.pool_amount ?? "0"), reserve: BigInt(ep.rebate_amount ?? "0"),
      walletOf: (agent) => `agent:${agent}:wallet` });
    const coreLeaves = (ep.payouts ?? []) as Json[];
    if (p.root !== ep.root) report({ kind: "epoch", id: String(ep.n), field: "payout root", core: ep.root, replica: p.root });
    if (p.poolOut.toString() !== String(ep.pool_amount)) report({ kind: "epoch", id: String(ep.n), field: "pool_amount", core: ep.pool_amount, replica: p.poolOut.toString() });
    if (p.rebateOut.toString() !== String(ep.rebate_amount)) report({ kind: "epoch", id: String(ep.n), field: "rebate_amount", core: ep.rebate_amount, replica: p.rebateOut.toString() });
    if (coreLeaves.length !== p.leaves.length || coreLeaves.some((l, i) => l.leaf !== p.leaves[i]?.leaf || l.amount !== p.leaves[i]?.amount))
      report({ kind: "epoch", id: String(ep.n), field: "payout leaves", core: coreLeaves.map((l) => `${l.dest}=${l.amount}`), replica: p.leaves.map((l) => `${l.dest}=${l.amount}`) });
    if (!close(Number(ep.total_units ?? 0), p.totalUnits)) report({ kind: "epoch", id: String(ep.n), field: "total_units", core: ep.total_units, replica: p.totalUnits });
    const lroot = lineageRootOf([...gens.values()].filter((g) => g.epoch <= ep.n));
    if (lroot !== ep.lineage_root) report({ kind: "epoch", id: String(ep.n), field: "lineage root", core: ep.lineage_root, replica: lroot });
    if (ep.record_root) {
      const rroot = merkleRoot([...(recordLeavesByEpoch.get(ep.n) ?? new Set<string>())].sort());
      if (rroot !== ep.record_root) report({ kind: "epoch", id: String(ep.n), field: "record root", core: ep.record_root, replica: rroot });
    }
  }
  return {
    v: 1,
    source: url,
    started_at,
    finished_at: Date.now(),
    core_epoch: health?.epoch ?? null,
    verdicts: { checked: checkedV, skipped },
    audits: { checked: auditsChecked },
    challenges: { checked: challengesChecked, available: !!chList },
    units: { checked: unitsChecked, pending: unitsPending },
    epochs: { checked: epochsChecked, closed: closedEpochs.length },
    divergences: div,
    ok: div.length === 0,
  };
}
/**
 * `bun packages/core/src/main.ts --replica-of <url> [--once] [--port 966x] [--interval-s 60] [--out report.json]`.
 * With --once: one pass, the report on stdout (and --out), exit 0 when nothing diverged. Otherwise
 * a pass every interval and the last report at GET /v1/replica on the given port (read-only).
 */
export async function replicaMain(argv: string[]): Promise<never> {
  const arg = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const url = arg("replica-of")!;
  const once = argv.includes("--once");
  const out = arg("out");
  const log = (m: string) => console.error(`[replica] ${m}`);
  const pass = async () => {
    const r = await replicate(url, { log });
    if (out) await Bun.write(out, JSON.stringify(r, null, 2) + "\n");
    log(`${r.ok ? "zero divergence" : `${r.divergences.length} divergences`}: ${r.verdicts.checked} verdicts, ${r.audits.checked} audits, ${r.challenges.checked} challenges, ` +
      `${r.units.checked} unit checks, ${r.epochs.checked} closed epochs`);
    return r;
  };
  if (once) {
    const r = await pass();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  const port = Number(arg("port") ?? "9667");
  if (port < 9660 || port > 9669) throw new Error("port must be in this repo's block 9660-9669");
  const busy = Bun.spawnSync(["lsof", "-ti", `:${port}`]).stdout.toString().trim();
  if (busy) throw new Error(`port ${port} is already in use by pid ${busy}; not binding`);
  let last: ReplicaReport | { error: string } | null = null;
  const run = async () => {
    try {
      last = await pass();
    } catch (e) {
      last = { error: (e as Error).message };
      log(`pass failed: ${(e as Error).message}`);
    }
  };
  await run();
  const interval = Number(arg("interval-s") ?? "60") * 1000;
  setInterval(() => void run(), interval);
  Bun.serve({
    port,
    hostname: arg("host") ?? "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (req.method !== "GET") return Response.json({ error: "read_only" }, { status: 405 });
      if (p === "/v1/health") return Response.json({ ok: true, replica_of: url, read_only: true });
      if (p === "/v1/replica") return Response.json(last ?? { pending: true });
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  log(`replica of ${url} on http://127.0.0.1:${port}/v1/replica (read-only, pid ${process.pid})`);
  return new Promise<never>(() => undefined);
}
