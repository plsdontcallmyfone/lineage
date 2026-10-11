#!/usr/bin/env bun
// Repeated-failure rate before and after the shared findings block (docs/plans/AGENT-LEARNINGS.md 12.5).
//
//   bun scripts/findings/measure.ts --core <url> --at <ISO time the block went live> [--hours <h>] [--all] [--json <file>]
//
// A candidate repeats a failure when, at the time it was committed, the dump already held a failed
// (rejected or expired) candidate of ANOTHER agent on the same unit and target, published before
// that commit time (so it was in the dump and, after the switch, in the shared block). Three
// strengths are counted: same target on the same parent generation, same target on any parent, and
// the same patch (semantic hash). Subjects are candidates of agents that ran a model (provider set;
// --all counts every agent). Windows: [at - hours, at) and [at, at + hours] (or until now).
// Read-only: public Core routes only. Every number printed is counted from the episodes.

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const core = (arg("core", "https://157-245-71-188.sslip.io") as string).replace(/\/+$/, "");
const atRaw = arg("at");
if (!atRaw) {
  console.error("usage: measure.ts --core <url> --at <ISO time> [--hours <h>] [--all] [--json <file>]");
  process.exit(2);
}
const at = Date.parse(atRaw);
const hours = Number(arg("hours", "6"));
const all = process.argv.includes("--all");

const eps: any[] = [];
for (let since = 0; ; ) {
  const r = await fetch(`${core}/v1/learnings/episodes?since=${since}&limit=200`);
  if (!r.ok) throw new Error(`episodes answered ${r.status}`);
  const j = (await r.json()) as { episodes: any[]; next_since: number; more: boolean };
  eps.push(...j.episodes);
  since = j.next_since;
  if (!j.more) break;
}

const key = (t: any) => (t ? `${t.kind}:${Array.isArray(t.target) ? t.target.join(",") : t.target}` : "none");
const failedOutcome = (e: any) => e.outcome === "rejected" || e.outcome === "expired";
const failures = eps.filter((e) => e.candidate && failedOutcome(e));
const subjects = eps.filter((e) => e.candidate?.committed_at && (all || e.model?.provider));

function classify(c: any) {
  const t = c.candidate.committed_at;
  const prior = failures.filter((f) => f.agent.id !== c.agent.id && f.task.lineage_id === c.task.lineage_id && (f.times?.published_at ?? Infinity) < t);
  const sameTarget = prior.filter((f) => key(f.task.target) === key(c.task.target));
  return {
    target_parent: sameTarget.some((f) => f.task.parent_gen_id === c.task.parent_gen_id),
    target: sameTarget.length > 0,
    patch: !!c.candidate.semantic_hash && prior.some((f) => f.candidate.semantic_hash === c.candidate.semantic_hash),
  };
}

function windowStats(from: number, to: number) {
  const list = subjects.filter((c) => c.candidate.committed_at >= from && c.candidate.committed_at < to);
  const out = { candidates: list.length, accepted: 0, failed: 0, repeats: { target_parent: 0, target: 0, patch: 0 }, repeats_failed_again: { target_parent: 0, target: 0, patch: 0 }, reasons: {} as Record<string, number>, agents: new Set<string>(), harness: {} as Record<string, number> };
  for (const c of list) {
    out.agents.add(c.agent.id);
    if (c.outcome === "accepted") out.accepted++;
    if (failedOutcome(c)) {
      out.failed++;
      const r = c.candidate.reason ?? "unknown";
      out.reasons[r] = (out.reasons[r] ?? 0) + 1;
    }
    const h = c.model?.harness?.digest ? String(c.model.harness.digest).slice(0, 12) : "unknown";
    out.harness[h] = (out.harness[h] ?? 0) + 1;
    const k = classify(c);
    for (const x of ["target_parent", "target", "patch"] as const) if (k[x]) (out.repeats[x]++, failedOutcome(c) && out.repeats_failed_again[x]++);
  }
  const rate = (n: number) => (out.candidates ? n / out.candidates : null);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...out, agents: out.agents.size, rates: { target_parent: rate(out.repeats.target_parent), target: rate(out.repeats.target), patch: rate(out.repeats.patch), failed: rate(out.failed) } };
}

const now = Date.now();
const before = windowStats(at - hours * 3600e3, at);
const after = windowStats(at, Math.min(at + hours * 3600e3, now));
// sessions still waiting for publication cannot be counted yet: report how many ended in each window
const pending = { note: "episodes publish once their candidate is final (plus up to 2 h for the journal); the after window may still grow" };
const res = { core, at: new Date(at).toISOString(), hours, subjects: all ? "every agent" : "agents that ran a model", episodes_read: eps.length, failures_in_dump: failures.length, before, after, pending, measured_at: new Date(now).toISOString() };
const p = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
for (const [name, w] of [["before", before], ["after", after]] as const) {
  console.log(`${name} ${w.from} .. ${w.to}: ${w.candidates} candidates from ${w.agents} agents, ${w.accepted} accepted, ${w.failed} failed (${p(w.rates.failed)}); repeats of another agent's earlier failure: same target and parent ${w.repeats.target_parent} (${p(w.rates.target_parent)}), same target ${w.repeats.target} (${p(w.rates.target)}), same patch ${w.repeats.patch} (${p(w.rates.patch)}); of those repeats failed again: ${w.repeats_failed_again.target_parent}, ${w.repeats_failed_again.target}, ${w.repeats_failed_again.patch}; reasons ${JSON.stringify(w.reasons)}; harness ${JSON.stringify(w.harness)}`);
}
const out = arg("json");
if (out) await Bun.write(out, JSON.stringify(res, null, 2) + "\n");
export {};
