#!/usr/bin/env bun
// Independent verdict check (SPEC 10.1: "anyone holding the transcripts can recompute it").
// Fetches a final candidate, its recipe, the calibration in force at its parent and every revealed
// replay from Core's public API, recomputes the verdict with the protocol package, and compares
// the outcome and digest with what Core recorded. Trusts nothing Core computed.
//
// Draws (SPEC 10.3): for every closed epoch whose secret is published, recomputes each assignment
// round from the secret and its beacon input (M1: the clock bucket; M2: the Solana slot and hash),
// and every recorded canary and audit decision. With --rpc (or --chain, the devnet resolver) it also
// reads each slot from the cluster: the block hash, that no block was produced between the target and
// the slot used, and that the block is not older than the request.
//
// Usage: bun scripts/verify.ts --core http://127.0.0.1:9660 [--candidate <id>] [--lineage <id>]
//          [--no-draws] [--epoch <n>] [--rpc <url> | --chain]
//        (no candidate: verifies every final candidate, or every one in the lineage)
import { assignmentSeed, assignReplayers, H, judge, measuredSplit, Rng, type Calibration, type RevealedReplay } from "@lineage/protocol";
import { blockAt, blocksBetween, Rpc } from "@lineage/chain";
import { devnetRpcUrl } from "../packages/chain/src/endpoint.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const CORE = opt("core") ?? "http://127.0.0.1:9660";
const get = async (p: string) => {
  const r = await fetch(CORE + p);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json() as Promise<any>;
};

const cfg = (await get("/v1/config")).network;
const judgeCfg = { quorum: cfg.quorum, det_tolerance: cfg.det_tolerance, bootstrap_resamples: cfg.bootstrap_resamples };

/** Stable set in force at a generation: the lineage calibration plus tests fixed by fix generations on its path. */
function effectiveCalibration(lineage: any, gen: string): Calibration {
  const byId = new Map<string, any>(lineage.generations.map((g: any) => [g.gen_id, g]));
  const path: any[] = [];
  for (let g = byId.get(gen); g; g = g.parent_gen_id ? byId.get(g.parent_gen_id) : undefined) path.push(g);
  const reverted = new Set(path.filter((g) => g.entry_type === "revert").map((g) => g.reverts));
  const fixed = new Set<string>();
  for (const g of path) if (g.entry_type === "patch" && g.kind === "fix" && !reverted.has(g.gen_id) && g.effect?.fixed) for (const t of g.effect.fixed) fixed.add(t);
  const c = lineage.calibration as Calibration;
  if (!fixed.size) return c;
  return { ...c, stable: [...new Set([...c.stable, ...fixed])].sort(), known_failures: c.known_failures.filter((t) => !fixed.has(t)) };
}

async function verifyOne(id: string): Promise<{ id: string; ok: boolean; detail: string }> {
  const c = await get(`/v1/candidates/${id}`);
  if (!c.verdict) return { id, ok: true, detail: `${c.status}${c.reason ? ` (${c.reason})` : ""}: no replay verdict to check` };
  const lineage = await get(`/v1/lineages/${c.lineage_id}`);
  const calib = effectiveCalibration(lineage, c.eval_parent_gen_id);
  const replays: RevealedReplay[] = c.replays
    .filter((r: any) => r.stage === c.stage && !r.audit_id && r.status === "revealed" && r.result)
    .map((r: any) => ({ replay_id: r.replay_id, replayer: r.replayer, seed: r.seed, result: r.result, reference: r.kind === "reference" }));
  const j = judge(lineage.recipe, calib, { candidate_id: c.candidate_id, author: c.author, kind: c.kind, target: c.target }, replays, judgeCfg);
  const recorded = c.verdict;
  let same = j.digest === recorded.digest && j.outcome === recorded.outcome;
  // measured split (SPEC 12.6): the shares recomputed from the counted replays' revealed coalition reports
  let splitNote = "";
  if (same && c.split?.outcome) {
    const reports = (j.counted as string[]).map((rid) => {
      const r = (c.split.reports as any[]).find((x) => x.replay_id === rid);
      return { replay_id: rid, report: r && r.status === "revealed" ? r.report : null };
    });
    const o = measuredSplit({ recipe: lineage.recipe, calib, metric: c.split.metric, n: c.split.n, effect: j.effect, reports, det_tolerance: judgeCfg.det_tolerance });
    same = o.status === c.split.outcome.status && JSON.stringify(o.share_bps) === JSON.stringify(c.split.outcome.share_bps);
    splitNote = same ? `, split ${o.status}${o.share_bps ? ` ${o.share_bps.join("/")} bps` : ""} matches` : `, split MISMATCH: recomputed ${o.status} ${o.share_bps}, Core recorded ${c.split.outcome.status} ${c.split.outcome.share_bps}`;
  }
  return {
    id,
    ok: same,
    detail: splitNote.includes("MISMATCH")
      ? `${j.outcome} digest matches${splitNote}`
      : same
      ? `${j.outcome}${j.reason ? ` (${j.reason})` : ""}, ${replays.length} replays, digest ${j.digest.slice(0, 12)} matches${splitNote}`
      : `MISMATCH: recomputed ${j.outcome} ${j.digest.slice(0, 12)}, Core recorded ${recorded.outcome} ${String(recorded.digest).slice(0, 12)}`,
  };
}

const ids: string[] = opt("candidate")
  ? [opt("candidate")!]
  : (await get(`/v1/candidates${opt("lineage") ? `?lineage=${opt("lineage")}` : ""}`)).filter((c: any) => ["accepted", "rejected"].includes(c.status)).map((c: any) => c.commit_id);
let bad = 0;
for (const id of ids) {
  const r = await verifyOne(id);
  if (!r.ok) bad++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${id.slice(0, 12)} ${r.detail}`);
}
console.log(`${ids.length - bad}/${ids.length} verdicts independently recomputed`);

// ------------------------------------------------------------------------------------------- draws
/** Allowed difference between Core's clock and the cluster's block times when checking a slot is not older than its request. */
const SKEW_S = 5;

async function verifyDraws(): Promise<number> {
  const rpcUrl = opt("rpc") ?? (argv.includes("--chain") ? devnetRpcUrl() : null);
  const rpc = rpcUrl ? Rpc.http(rpcUrl) : null;
  const epochs = opt("epoch") ? [{ n: Number(opt("epoch")) }] : ((await get("/v1/epochs")) as any[]).filter((e) => e.status === "closed");
  let rounds = 0, slotRounds = 0, decisions = 0, chainChecked = 0, sealed = 0, fails = 0;
  const fail = (m: string) => {
    fails++;
    console.log(`FAIL ${m}`);
  };
  for (const { n } of epochs) {
    const ep = await get(`/v1/epochs/${n}`);
    if (ep.status !== "closed") continue;
    if (!ep.secret) {
      sealed++;
      continue;
    }
    if (H("beacon-commit", ep.secret) !== ep.beacon_commit) fail(`epoch ${n}: the revealed secret does not match beacon_commit`);
    const sb = ep.slot_beacon as { lag_slots: number; draws: any[]; decisions: any[] } | undefined;
    const drawOf = (subject: string, round: number) => sb?.draws.find((d) => d.subject === subject && d.round === round);
    for (const r of ep.assignment_rounds ?? []) {
      rounds++;
      const tag = `epoch ${n} ${String(r.subject).slice(0, 12)} round ${r.round}`;
      let beacon: string;
      if (r.bucket >= 0) beacon = H("m1-beacon", ep.secret, r.subject, r.round, r.bucket);
      else {
        const d = drawOf(r.subject, r.round);
        if (!d) {
          fail(`${tag}: slot draw not published`);
          continue;
        }
        slotRounds++;
        if (d.target_slot !== d.anchor_slot + d.lag_slots || d.lag_slots < 1) fail(`${tag}: target ${d.target_slot} is not anchor ${d.anchor_slot} + lag ${d.lag_slots}`);
        if (d.slot < d.target_slot) fail(`${tag}: slot ${d.slot} is before its target ${d.target_slot}`);
        if (d.anchored_at < d.requested_at) fail(`${tag}: anchored before the request`);
        beacon = H("slot-beacon", ep.secret, r.subject, r.round, d.slot, d.hash);
      }
      if (beacon !== r.beacon) fail(`${tag}: beacon recomputes to ${beacon.slice(0, 12)}, Core recorded ${String(r.beacon).slice(0, 12)}`);
      const seed = assignmentSeed(beacon, r.subject);
      if (seed !== r.assignment_seed) fail(`${tag}: assignment seed differs`);
      const pool = r.pool.map((p: any) => ({ agent: p.agent, bond: BigInt(p.bond), operator: p.operator ?? undefined }));
      const chosen = r.count > 0 ? assignReplayers(seed, pool, Math.min(r.count, pool.length), { agents: [] }, BigInt(cfg.bond_cap)) : [];
      if (JSON.stringify(chosen) !== JSON.stringify(r.chosen)) fail(`${tag}: draw recomputes to ${JSON.stringify(chosen)}, Core recorded ${JSON.stringify(r.chosen)}`);
    }
    for (const u of sb?.decisions ?? []) {
      decisions++;
      const d = drawOf(u.draw_subject, u.draw_round);
      if (!d) {
        fail(`epoch ${n} ${u.kind} ${String(u.subject).slice(0, 12)}: its slot draw is not published`);
        continue;
      }
      const v = new Rng(H(`slot-${u.kind}`, ep.secret, u.subject, d.slot, d.hash)).next();
      if (v !== u.value || (v < u.rate) !== u.outcome) fail(`epoch ${n} ${u.kind} ${String(u.subject).slice(0, 12)}: recomputes to ${v} (${v < u.rate}), Core recorded ${u.value} (${u.outcome})`);
    }
    if (rpc)
      for (const d of sb?.draws ?? []) {
        const tag = `epoch ${n} ${String(d.subject).slice(0, 12)} round ${d.round} slot ${d.slot}`;
        const b = await blockAt(rpc, d.slot);
        if (!b) {
          fail(`${tag}: no block at this slot on the cluster`);
          continue;
        }
        if (b.hash !== d.hash) fail(`${tag}: cluster hash ${b.hash} differs from ${d.hash}`);
        const produced = await blocksBetween(rpc, d.target_slot, d.slot);
        if (produced.length !== 1 || produced[0] !== d.slot) fail(`${tag}: blocks ${JSON.stringify(produced)} between target ${d.target_slot} and slot ${d.slot}`);
        if (b.blockTime !== null && b.blockTime < Math.floor(d.requested_at / 1000) - SKEW_S) fail(`${tag}: block time ${b.blockTime} is before the request ${d.requested_at}`);
        chainChecked++;
      }
  }
  console.log(
    `draws: ${rounds} assignment rounds (${slotRounds} on a slot hash) and ${decisions} canary/audit decisions recomputed in ${epochs.length - sealed} revealed epochs` +
      `${sealed ? `, ${sealed} still sealed` : ""}${rpc ? `; ${chainChecked} slots checked on the cluster` : ""}; ${fails ? `${fails} FAIL` : "all match"}`,
  );
  return fails;
}
if (!argv.includes("--no-draws")) bad += await verifyDraws();
process.exit(bad ? 1 : 0);
