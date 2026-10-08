#!/usr/bin/env bun
// Independent verdict check (SPEC 10.1: "anyone holding the transcripts can recompute it").
// Fetches a final candidate, its recipe, the calibration in force at its parent and every revealed
// replay from Core's public API, recomputes the verdict with the protocol package, and compares
// the outcome and digest with what Core recorded. Trusts nothing Core computed.
//
// Usage: bun scripts/verify.ts --core http://127.0.0.1:9660 [--candidate <id>] [--lineage <id>]
//        (no candidate: verifies every final candidate, or every one in the lineage)
import { judge, measuredSplit, type Calibration, type RevealedReplay } from "@lineage/protocol";

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
process.exit(bad ? 1 : 0);
