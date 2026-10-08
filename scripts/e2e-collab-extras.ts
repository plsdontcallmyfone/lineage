// End-to-end checks for plan W4 (docs/plans/FINISH.md): measured split (SPEC 12.6, plan C5) and
// cross-lineage ports (SPEC 12.7, plan C7), run by scripts/e2e.ts on a second lineage of the
// fixture repository, with the same real Core, real verifier processes and real Docker sandboxes.
//
// Importing this module creates the second recipe of fixture:b58 (the fixture recipe under another
// name, so another recipe id and another lineage of the same repository) in a temporary directory
// and points LINEAGE_RECIPES_EXTRA at it, so every worker the e2e starts afterwards knows it.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeDiff, H, judge, measuredSplit, patchCommitment, patchHash, signStatement, subCommitment, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { teamStatement } from "../packages/core/src/collab.ts";
import type { CoreClient } from "../packages/core/src/client.ts";
import { Worker } from "../packages/worker/src/index.ts";

const ROOT = join(import.meta.dir, "..");
export const EXTRA_RECIPES = mkdtempSync(join(tmpdir(), "lineage-e2e-recipes-"));
const PORT_RECIPE = join(EXTRA_RECIPES, "fixture-b58-port");
cpSync(join(ROOT, "recipes/fixture-b58"), PORT_RECIPE, { recursive: true });
writeFileSync(join(PORT_RECIPE, "recipe.yml"), readFileSync(join(PORT_RECIPE, "recipe.yml"), "utf8").replace(/^name: fixture-b58$/m, "name: fixture-b58-port"));
process.env.LINEAGE_RECIPES_EXTRA = [process.env.LINEAGE_RECIPES_EXTRA, EXTRA_RECIPES].filter(Boolean).join(":");

export interface ExtrasCtx {
  core: string;
  admin: CoreClient;
  as: (k: AgentKey) => CoreClient;
  keys: Record<"ref" | "author" | "author2" | "v5", AgentKey> & Record<string, AgentKey>;
  ok: <T = any>(p: Promise<{ status: number; body: T }>, what: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: string) => void;
  waitFor: <T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs?: number) => Promise<T>;
  candidateFinal: (id: string) => Promise<any>;
  log: (m: string) => void;
  /** the first lineage and its accepted two-member team generation (perf_encode, 70/30) */
  L: string;
  teamGen: string;
  libDiff: (before: string, after: string) => string;
  DECODE_LOOP: string;
  A_LOOP: string;
  net: Record<string, any>;
}

const DIGIT_OLD = `fn digit_value(c: u8) -> Option<u8> {
    ALPHABET.iter().position(|&a| a == c).map(|p| p as u8)
}
`;
const DIGIT_NEW = `const DIGITS: [u8; 128] = {
    let mut t = [0xffu8; 128];
    let mut i = 0;
    while i < 58 {
        t[ALPHABET[i] as usize] = i as u8;
        i += 1;
    }
    t
};

fn digit_value(c: u8) -> Option<u8> {
    match DIGITS.get(c as usize) {
        Some(&v) if v != 0xff => Some(v),
        _ => None,
    }
}
`;

export async function collabExtras(x: ExtrasCtx): Promise<void> {
  const { admin, ok, check, log, keys } = x;
  // ---------------------------------------------------------------- a second lineage of the same repository
  const loaded2 = loadRecipe(PORT_RECIPE);
  const deps2 = await prepareDeps(loaded2);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded2.recipe, recipe_id: loaded2.recipe_id }), "port recipe");
  const snap2 = await ok(admin.post("/v1/admin/snapshots", { repo: loaded2.recipe.repo, commit: loaded2.recipe.commit, deps_digest: deps2.digest }), "port snapshot");
  log("reference runner calibrating the second lineage of fixture:b58");
  const ref = new Worker({ core: x.core, key: keys.ref, log: (m) => console.log(`   ref2 ${m}`) });
  await ref.submitCalibration(loaded2.recipe_id, snap2.snapshot_id, 3);
  const all = await ok<any[]>(admin.get("/v1/lineages"), "lineages");
  const l1 = all.find((l) => l.lineage_id === x.L);
  const l2 = all.find((l) => l.lineage_id !== x.L && l.recipe_id === loaded2.recipe_id);
  check("a second lineage of the same repository is calibrated (another recipe, same repo)", !!l2 && l2.repo === l1?.repo, l2 ? `${l2.lineage_id.slice(0, 10)} on ${l2.repo}` : "missing");
  if (!l2) return;
  const L2 = l2.lineage_id as string;
  await x.waitFor("verifiers qualified on the second lineage", async () => {
    const vs = await Promise.all(["v1", "v2", "v3", "v4"].map((n) => ok(admin.get(`/v1/agents/${keys[n]!.id}`), n)));
    return vs.filter((v) => v.qualified_lineages.includes(L2)).length >= 3 ? true : null;
  });
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.author2.id, amount: (BigInt(x.net.wake_threshold) * 10n).toString() }), "author2 fees");

  // ---------------------------------------------------------------- C5: a two-member team with a measured split
  // sub-patch 0 (author2, the lead): digit_value as a lookup table; sub-patch 1 (author): decode's
  // inner loop on 2^32 limbs. Two independent functions, both on the decode_ir path.
  const tip0 = (await ok(admin.get(`/v1/lineages/${L2}`), "lineage 2")).tip as string;
  const text = String((await ok(admin.get(`/v1/lineages/${L2}/file?gen=${tip0}&path=src/lib.rs`), "tip file")).text ?? "");
  if (!text.includes(DIGIT_OLD) || !text.includes(x.DECODE_LOOP)) {
    check("measured split: the second lineage's tip has the functions the sub-patches expect", false);
    return;
  }
  const textA = text.replace(DIGIT_OLD, DIGIT_NEW);
  const textB = text.replace(x.DECODE_LOOP, x.A_LOOP);
  const both = textA.replace(x.DECODE_LOOP, x.A_LOOP);
  const subs = [x.libDiff(text, textA), x.libDiff(text, textB)];
  const patch = x.libDiff(text, both);
  const salt = H("split-salt", String(Date.now()));
  const commitment = patchCommitment(patchHash(patch), salt);
  const split = { mode: "shapley" as const, sub_commitment: subCommitment(subs.map((s) => patchHash(canonicalizeDiff(s))), salt) };
  const members = [
    { agent: keys.author2.id, role: "author" as const, share_bps: 5000 },
    { agent: keys.author.id, role: "author" as const, share_bps: 5000 },
  ];
  const st = teamStatement({ lineage_id: L2, parent_gen_id: tip0, commitment, kind: "perf", target: "decode_ir", members, split });
  const sigs = { [keys.author2.id]: signStatement(keys.author2, "team", st), [keys.author.id]: signStatement(keys.author, "team", st) };
  const lead = x.as(keys.author2);
  const leadBefore = BigInt((await ok(admin.get(`/v1/agents/${keys.author2.id}`), "author2")).compute);
  const committed = await ok(lead.post("/v1/candidates", { lineage_id: L2, parent_gen_id: tip0, kind: "perf", target: "decode_ir", commitment, team: { members, sigs, split } }), "commit split candidate");
  const leadAfter = BigInt((await ok(admin.get(`/v1/agents/${keys.author2.id}`), "author2")).compute);
  await ok(lead.post(`/v1/candidates/${committed.commit_id}/reveal`, { patch, salt, subs }), "reveal split candidate");
  const fin = await x.candidateFinal(committed.commit_id);
  log(`split candidate: ${fin.status}${fin.reason ? ` (${fin.reason})` : ""}`);
  check("measured split: the team candidate (two sub-patches on independent functions) is accepted on decode_ir", fin.status === "accepted", fin.verdict?.effect ? `ratio ${fin.verdict.effect.ratio}` : `${fin.reason ?? ""} ${fin.detail ?? ""}`);
  const counted: string[] = fin.verdict?.counted ?? [];
  const reports = (fin.split?.reports ?? []) as any[];
  const lineage2 = await ok(admin.get(`/v1/lineages/${L2}`), "lineage 2");
  const cfg = (await ok(admin.get("/v1/config"), "config")).network;
  const perReplay = counted.map((rid) => {
    const r = reports.find((y) => y.replay_id === rid);
    return measuredSplit({ recipe: lineage2.recipe, calib: lineage2.calibration, metric: "decode_ir", n: 2, effect: fin.verdict?.effect, reports: [{ replay_id: rid, report: r?.status === "revealed" ? r.report : null }], det_tolerance: cfg.det_tolerance });
  });
  const o = fin.split?.outcome;
  check(
    "measured split: Shapley shares computed from each of two replayers' coalition reports agree, and match Core's",
    counted.length >= 2 && o?.status === "measured" && perReplay.every((p) => p.status === "measured" && JSON.stringify(p.share_bps) === JSON.stringify(o.share_bps)),
    `${counted.length} counted, shares ${perReplay.map((p) => p.share_bps?.join("/") ?? p.status).join(" | ")}, Core ${o?.share_bps?.join("/") ?? o?.status}; ${o?.detail ?? ""}`,
  );
  const gain = fin.verdict?.effect ? 1 - fin.verdict.effect.ratio : NaN;
  const phiSum = (o?.phi ?? []).reduce((a: number, b: number) => a + b, 0);
  check("measured split: the Shapley values sum to the whole patch's gain", Math.abs(phiSum - gain) < 1e-12, `sum ${phiSum.toFixed(6)} vs gain ${gain.toFixed(6)}; v(lookup) ${o?.v?.[1]?.toFixed(6)}, v(limbs) ${o?.v?.[2]?.toFixed(6)}`);
  const replays = (fin.replays as any[]).filter((r) => r.stage === fin.stage && !r.audit_id && r.status === "revealed" && r.result).map((r) => ({ replay_id: r.replay_id, replayer: r.replayer, seed: r.seed, result: r.result, reference: r.kind === "reference" }));
  const j = judge(lineage2.recipe, lineage2.calibration, { candidate_id: fin.candidate_id, author: keys.author2.id, kind: "perf", target: "decode_ir" }, replays, { quorum: cfg.quorum, det_tolerance: cfg.det_tolerance, bootstrap_resamples: cfg.bootstrap_resamples });
  check("measured split: the verdict is identical without the split (recomputed from the whole-patch results alone)", j.outcome === fin.verdict?.outcome && j.digest === fin.verdict?.digest, `${j.outcome} ${j.digest.slice(0, 12)}`);
  const ev = await ok<any[]>(admin.get("/v1/events/log?since=0&limit=20000"), "events");
  const au = ev.filter((e) => e.type === "units.awarded" && e.data.kind === "author" && e.data.ref === fin.gen_id).map((e) => e.data);
  const mu = (a: string) => Math.round(au.filter((u) => u.agent === a).reduce((s: number, u: any) => s + u.units, 0) * 1e6);
  const totalMu = mu(keys.author2.id) + mu(keys.author.id);
  const want = o?.share_bps ? Math.round((totalMu * o.share_bps[0]) / 10_000) : -1;
  check("measured split: author units follow the measured shares, not the declared 50/50", o?.status === "measured" && Math.abs(mu(keys.author2.id) - want) <= 1, `${mu(keys.author2.id)} + ${mu(keys.author.id)} micro-units`);
  const fee = (fin.split?.fee_paid ?? []).reduce((s: bigint, p: any) => s + BigInt(p.amount), 0n);
  const extraUnits = ev.filter((e) => e.type === "units.awarded" && e.data.kind === "replay" && counted.includes(e.data.ref)).length;
  const costs = reports.filter((r) => counted.includes(r.replay_id) && r.report?.cost).map((r) => `${r.report.cost.subsets_s}s for 2 extra trees vs ${r.report.cost.main_s}s main`);
  check(
    "measured split: the extra measurement is billed to the team and paid to the counted replayers",
    fee > 0n && leadBefore - leadAfter > 0n && extraUnits >= counted.filter((rid) => !(fin.replays as any[]).find((r) => r.replay_id === rid && r.kind === "reference")).length * 2,
    `fee ${fee}, ${extraUnits} replay unit rows; measured cost ${costs.join("; ")}`,
  );

  // ---------------------------------------------------------------- C7: an undeclared port credits the original author
  const orig = await ok(admin.get(`/v1/generations/${x.teamGen}`), "original generation");
  const pSalt = H("port-salt", String(Date.now()));
  const tip1 = (await ok(admin.get(`/v1/lineages/${L2}`), "lineage 2")).tip as string;
  const pc = await ok(lead.post("/v1/candidates", { lineage_id: L2, parent_gen_id: tip1, kind: "perf", target: "encode_ir", commitment: patchCommitment(patchHash(orig.patch), pSalt) }), "commit port");
  await ok(lead.post(`/v1/candidates/${pc.commit_id}/reveal`, { patch: orig.patch, salt: pSalt }), "reveal port");
  const pf = await x.candidateFinal(pc.commit_id);
  log(`port of perf_encode: ${pf.status}${pf.reason ? ` (${pf.reason})` : ""}`);
  check("port: the same change on the second lineage is accepted (not a duplicate there)", pf.status === "accepted", `${pf.status} ${pf.reason ?? ""}`);
  check("port: Core detects the undeclared port of the first lineage's generation", pf.port?.ported_from === x.teamGen && pf.port?.source === "detected", JSON.stringify(pf.port ?? null).slice(0, 200));
  const ev2 = await ok<any[]>(admin.get("/v1/events/log?since=0&limit=20000"), "events");
  const pu = ev2.filter((e) => e.type === "units.awarded" && e.data.kind === "author" && e.data.ref === pf.gen_id).map((e) => e.data);
  const pm = (a: string) => Math.round(pu.filter((u) => u.agent === a).reduce((s: number, u: any) => s + u.units, 0) * 1e6);
  const ptotal = pm(keys.author2.id) + pm(keys.author.id) + pm(keys.v5.id);
  const bps = Number(cfg.port_share_bps);
  const origMu = pm(keys.author.id) + pm(keys.v5.id);
  check(
    "port: the original authors are credited port_share_bps of the port's author units, in their original 70/30 proportion",
    ptotal > 0 && Math.abs(origMu - Math.round((ptotal * bps) / 10_000)) <= 1 && Math.abs(pm(keys.author.id) - Math.round(origMu * 0.7)) <= 1,
    `porter ${pm(keys.author2.id)}, original author ${pm(keys.author.id)}, original reviewer ${pm(keys.v5.id)} micro-units (port_share_bps ${bps})`,
  );

  // audits of the second lineage settle before the dishonest phase starts
  await x.waitFor("second-lineage audits", async () => {
    const v = await ok(admin.get(`/v1/lineages/${L2}`), "lineage 2");
    return v.generations.filter((g: any) => g.entry_type === "patch").every((g: any) => g.audit_status && g.audit_status !== "pending" && g.audit_status !== "running") ? true : null;
  });
  const lv = await ok(admin.get(`/v1/lineages/${L2}`), "lineage 2");
  check("second-lineage audits agree with its generations (split and port)", lv.generations.filter((g: any) => g.entry_type === "patch").every((g: any) => g.audit_status === "agreed"), lv.generations.map((g: any) => g.audit_status).join(","));
}
