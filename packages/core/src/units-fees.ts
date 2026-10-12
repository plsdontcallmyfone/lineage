import { existsSync, readFileSync, statSync } from "node:fs";

// GET /v1/units-fees: what the $UNITS fee keeper did with the $UNITS coin's own pump.fun creator fees
// (owner decision 2026-10-12: 50% funds compute, 50% buys $UNITS and burns it; packages/fee-keeper,
// docs/MAINNET-RUNBOOK.md "UNITS fee keeper"). Read-only, from the keeper's public log: one JSON line
// per run that moved something, every amount measured from the landed transaction. Core adds nothing
// to it: the totals are the sums of the lines, and where there is no log the route says so and gives
// no figure. The log is a file on this machine (UNITS_FEES_LOG, default the keeper unit's path).

export const UNITS_FEES_LOG_DEFAULT = "/var/lib/units/fee-keeper/public/runs.jsonl";
const DEFAULT_RUNS = 20;
const MAX_RUNS = 100;

interface Line {
  v: 1;
  run_id: string;
  time: string;
  [k: string]: unknown;
}
const AMOUNT = /^\d+$/;
const amount = (v: unknown): bigint => (typeof v === "string" && AMOUNT.test(v) ? BigInt(v) : 0n);

/** The fields of a log line the route serves: amounts as decimal strings (lamports, $UNITS base units), signatures, the time. */
function publicRun(l: Line) {
  const s = (k: string) => (typeof l[k] === "string" ? (l[k] as string) : null);
  const a = (k: string) => amount(l[k]).toString();
  return {
    run_id: l.run_id, time: l.time, cluster: s("cluster"), venue: s("venue"),
    collected_lamports: a("collected_lamports"), collect_cost_lamports: a("collect_cost_lamports"), collect_signature: s("collect_signature"),
    reserve_lamports: a("reserve_lamports"), compute_share_lamports: a("compute_share_lamports"), burn_share_lamports: a("burn_share_lamports"),
    compute_lamports: a("compute_lamports"), compute_address: s("compute_address"), compute_signature: s("compute_signature"),
    buyback_lamports: a("buyback_lamports"), units_bought: a("units_bought"), buyback_signature: s("buyback_signature"),
    units_burned: a("units_burned"), burn_signature: s("burn_signature"), overhead_lamports: a("overhead_lamports"),
  };
}

let cache: { file: string; size: number; mtimeMs: number; lines: Line[] } | null = null;
function readLines(file: string): Line[] {
  const st = statSync(file);
  if (cache && cache.file === file && cache.size === st.size && cache.mtimeMs === st.mtimeMs) return cache.lines;
  const lines: Line[] = [];
  const seen = new Set<string>();
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw) as Line;
      if (l && l.v === 1 && typeof l.run_id === "string" && typeof l.time === "string" && !seen.has(l.run_id)) {
        seen.add(l.run_id);
        lines.push(l);
      }
    } catch {
      // a torn line (the keeper was stopped mid-append): not a run
    }
  }
  cache = { file, size: st.size, mtimeMs: st.mtimeMs, lines };
  return lines;
}

export function unitsFees(o: { file?: string | null; limit?: number | null } = {}) {
  const file = o.file?.trim() || UNITS_FEES_LOG_DEFAULT;
  const limit = Math.min(MAX_RUNS, Math.max(0, o.limit ?? DEFAULT_RUNS));
  const split = { note: "owner decision 2026-10-12: half of the $UNITS coin's creator fees funds compute, half buys $UNITS and burns it; the keeper's config holds the live basis points" };
  if (!existsSync(file)) return { available: false as const, reason: "the $UNITS fee keeper has not written a log on this machine", ...split, totals: null, mint: null, compute_address: null, runs: [] };
  const lines = readLines(file);
  let collected = 0n, cost = 0n, compute = 0n, buyback = 0n, bought = 0n, burned = 0n, overhead = 0n;
  for (const l of lines) {
    collected += amount(l.collected_lamports);
    cost += amount(l.collect_cost_lamports);
    compute += amount(l.compute_lamports);
    buyback += amount(l.buyback_lamports);
    bought += amount(l.units_bought);
    burned += amount(l.units_burned);
    overhead += amount(l.overhead_lamports);
  }
  const last = lines[lines.length - 1];
  return {
    available: true as const, reason: null, ...split,
    mint: typeof last?.mint === "string" ? last.mint : null,
    compute_address: typeof last?.compute_address === "string" ? last.compute_address : null,
    totals: {
      runs: lines.length, first_run_at: lines[0]?.time ?? null, last_run_at: last?.time ?? null,
      collected_lamports: collected.toString(), collect_cost_lamports: cost.toString(), compute_lamports: compute.toString(), buyback_lamports: buyback.toString(),
      units_bought: bought.toString(), units_burned: burned.toString(), overhead_lamports: overhead.toString(),
    },
    runs: lines.slice(lines.length - Math.min(limit, lines.length)).reverse().map(publicRun),
  };
}
