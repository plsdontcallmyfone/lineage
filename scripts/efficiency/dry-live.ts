#!/usr/bin/env bun
// The dry rule (packages/core/src/unit-dry.ts, docs/plans/AGENT-EFFICIENCY.md 8.1) applied to any
// Core from its public read routes only: GET /v1/lineages, /v1/lineages/:id and
// /v1/learnings/episodes. Read-only; nothing is signed or sent. It is the same pure function Core's
// GET /v1/units/dry uses, so it says what a Core that does not run this release yet would answer.
// Usage: bun scripts/efficiency/dry-live.ts --core https://... [--json] [--window 12 ...]
import { DRY_DEFAULTS, dryVerdict, parseDrySettings, type DryAttempt, type DryFixed } from "../../packages/core/src/unit-dry.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const CORE = (opt("core") ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(CORE)) throw new Error("--core <url> expected");
const over: Record<string, number> = {};
for (const k of Object.keys(DRY_DEFAULTS)) if (opt(k) !== undefined) over[k] = Number(opt(k));
const settings = parseDrySettings(over);

async function get<T = any>(path: string): Promise<T> {
  // a public Core limits reads per address: wait as long as it asks and try again, a few times
  for (let i = 0; ; i++) {
    const r = await fetch(`${CORE}${path}`, { signal: AbortSignal.timeout(60_000) });
    if (r.status === 429 && i < 6) {
      await Bun.sleep(Math.min(60, Math.max(2, Number(r.headers.get("retry-after")) || 10)) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }
}

const now = Date.now();
const out: any[] = [];
for (const u of await get<any[]>("/v1/lineages")) {
  if (u.status !== "active") continue;
  const view = await get(`/v1/lineages/${u.lineage_id}`);
  const attempts: DryAttempt[] = [];
  let since = 0;
  for (let page = 0; page < 40; page++) {
    const r = await get(`/v1/learnings/episodes?lineage=${u.lineage_id}&hidden=1&limit=200&since=${since}`);
    for (const e of r.episodes ?? []) {
      if (e.outcome === "abandoned" || e.model?.harness?.name === "scripted") continue;
      attempts.push({ outcome: e.outcome, reason: e.candidate?.reason ?? null, gain_pct: typeof e.effect?.gain_pct === "number" ? e.effect.gain_pct : null, at: e.times?.ended_at ?? e.candidate?.finalized_at ?? 0 });
    }
    if (!r.more) break;
    since = r.next_since;
  }
  attempts.sort((a, b) => b.at - a.at);
  const gens = (view.generations as any[]).filter((g) => g.entry_type === "patch" && !g.reverted_by);
  const ratio = new Map<string, number>();
  for (const g of gens) if (typeof g.effect?.metric === "string" && typeof g.effect?.ratio === "number") ratio.set(g.effect.metric, (ratio.get(g.effect.metric) ?? 1) * g.effect.ratio);
  const fixed: Record<string, DryFixed> = {};
  for (const [name, m] of Object.entries<any>(view.calibration?.metrics ?? {})) {
    if (!m.enabled || typeof m.fixed_value !== "number" || !(m.base_value > 0)) continue;
    const tip = m.base_value * (ratio.get(name) ?? 1);
    fixed[name] = { fixed_value: m.fixed_value, tip_value: tip, share: Math.min(1, m.fixed_value / tip) };
  }
  const v = dryVerdict({ attempts, created_at: view.created_at, last_accepted_at: gens.length ? Math.max(...gens.map((g) => g.accepted_at)) : null, fixed, now }, settings);
  out.push({ unit: view.recipe?.name, lineage_id: u.lineage_id, repo: view.repo, height: view.height, accepted: gens.length, final_attempts: attempts.length, ...v });
}
if (argv.includes("--json")) console.log(JSON.stringify({ core: CORE, at: new Date(now).toISOString(), settings, units: out }, null, 2));
else {
  console.log(`${CORE} at ${new Date(now).toISOString()}; settings ${JSON.stringify(settings)}`);
  for (const u of out) {
    const f = u.facts;
    console.log(
      `${String(u.unit).padEnd(18)} height ${String(u.height).padStart(3)}  final attempts ${String(u.final_attempts).padStart(3)}  window: ${f.attempts} (${f.no_candidate} no candidate, ${f.no_improvement} no_improvement, ${f.accepted} accepted, ${f.other} other)` +
        `  best gain ${f.best_gain_pct === null ? "none" : f.best_gain_pct.toFixed(1) + "%"}  quiet ${f.quiet_hours.toFixed(1)} h, ${f.attempts_since_accepted} attempts since  ` +
        `=> ${u.dry ? `DRY (${u.rule})` : u.fresh ? "fresh" : "not dry"}${u.line ? `: ${u.line}` : ""}`,
    );
  }
}
