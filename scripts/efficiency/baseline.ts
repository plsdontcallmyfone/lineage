#!/usr/bin/env bun
// Agent efficiency baseline (docs/plans/AGENT-EFFICIENCY.md): per agent and model, what an authoring
// attempt costs and what it buys, measured from the hosted runtime's own log and Core's records.
//
//   bun scripts/efficiency/baseline.ts --fetch <dir> [--host 157.245.71.188] [--ssh-key ~/.ssh/lineage_site]
//   bun scripts/efficiency/baseline.ts --dir <dir> [--since 2026-10-09T22:00:00Z] [--until ...] [--json out.json]
//   bun scripts/efficiency/baseline.ts --local-log <worker log> ...   (A/B runs: scripts/efficiency/ab.ts writes JSON itself)
//
// Sources (read only):
// - runtime.log: `journalctl -u lineage-runtime -o short-iso`. One hosted attempt runs per agent at a
//   time, so each agent's lines between "attempt starts" and "attempt done" belong to one attempt:
//   its cap, model turns (cumulative USD), evaluations, the stop reason, USD, sandbox seconds and the
//   candidate (12 hex) when one was committed.
// - core.json: hosted agents' candidates (status, reason) and provenance records (token breakdown
//   incl. cache writes) from Core's SQLite, read with `sqlite3 -readonly -json`. Provenance exists
//   only for attempts that committed a candidate, so the token columns cover those attempts only;
//   attempts that end with nothing are counted by USD, turns and time from the log.
// Every number this prints is computed from those two files; nothing is estimated.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};

export interface Attempt {
  agent: string; // 6-char prefix as logged
  model: string;
  started: number; // ms
  ended: number | null;
  cap: number;
  turns: number; // "turn N" lines: model calls whose tool results went back
  calls: number; // model calls: turns plus the final call (submit, give_up, no tool call), none after a cap stop
  evals: number;
  wrapUp: boolean;
  usd: number | null;
  sandbox_s: number | null;
  candidate: string | null; // 12 hex prefix
  end: string; // why it ended: candidate | cap_reached | gave_up | no_submit | turn_limit | refusal | failed | no_change | interrupted
  detail?: string;
  turnUsd: number[]; // cumulative USD after each turn
}

const ts = (line: string) => Date.parse(line.slice(0, 25));

/** Parses `journalctl -o short-iso` lines of lineage-runtime into attempts. */
export function parseRuntimeLog(text: string): Attempt[] {
  const open = new Map<string, Attempt>();
  const route = new Map<string, string>();
  const out: Attempt[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/runtime\] ([1-9A-HJ-NP-Za-km-z]{6}) (.*)$/);
    if (!m) {
      // a stop with attempts still open: those attempts end with the process
      if (/runtime\] stopped;/.test(line)) for (const [k, a] of open) (a.end = "interrupted"), (a.ended = ts(line)), out.push(a), open.delete(k);
      continue;
    }
    const [, ag, msg] = m as unknown as [string, string, string];
    const at = ts(line);
    let r: RegExpMatchArray | null;
    if ((r = msg.match(/^model route: (\S+)/))) route.set(ag, r[1]!.replace(/^anthropic\//, ""));
    else if ((r = msg.match(/^attempt starts, cap ([\d.]+) USD/))) {
      const prev = open.get(ag);
      if (prev) (prev.end = "interrupted"), out.push(prev);
      open.set(ag, { agent: ag, model: route.get(ag) ?? "unknown", started: at, ended: null, cap: Number(r[1]), turns: 0, calls: 0, evals: 0, wrapUp: false, usd: null, sandbox_s: null, candidate: null, end: "interrupted", turnUsd: [] });
    } else {
      const a = open.get(ag);
      if (!a) continue;
      if ((r = msg.match(/^model route: (\S+)/))) a.model = r[1]!.replace(/^anthropic\//, "");
      else if ((r = msg.match(/^\S+: turn (\d+), ([\d.]+) USD so far/))) (a.turns = Math.max(a.turns, Number(r[1]))), a.turnUsd.push(Number(r[2]));
      else if (/^\S+: evaluating \(/.test(msg)) a.evals++;
      else if (/budget wrap-up notice sent/.test(msg)) a.wrapUp = true;
      else if (/: spend cap reached/.test(msg)) a.end = "cap_reached";
      else if ((r = msg.match(/: gave up: (.*)$/))) (a.end = "gave_up"), (a.detail = r[1]!.slice(0, 160));
      else if (/: ended without submit/.test(msg)) a.end = "no_submit";
      else if (/: turn limit reached/.test(msg)) a.end = "turn_limit";
      else if (/: refusal/.test(msg)) a.end = "refusal";
      else if (/proposer made no change/.test(msg)) a.end = "no_change";
      else if (/early stop/.test(msg)) a.end = "early_stop";
      else if ((r = msg.match(/^attempt failed: (.*)$/))) (a.end = "failed"), (a.detail = r[1]!.slice(0, 160));
      else if ((r = msg.match(/^attempt done: ([\d.]+) USD model spend, (\d+) sandbox s, cost \d+ base units, (?:candidate ([0-9a-f]{12})|no candidate)/))) {
        a.usd = Number(r[1]);
        a.sandbox_s = Number(r[2]);
        a.ended = at;
        a.calls = a.turns + (["cap_reached", "turn_limit", "no_model_turn", "interrupted"].includes(a.end) ? 0 : 1);
        if (r[3]) (a.candidate = r[3]), a.end === "failed" || (a.end = "candidate");
        else if (a.end === "interrupted") a.end = a.turns === 0 ? "no_model_turn" : "unknown";
        // a turn counter reached without an explicit message: the proposer's own count is the turn lines
        out.push(a);
        open.delete(ag);
      }
    }
  }
  // attempts still open when the log ends are running, not finished: left out
  return out.sort((x, y) => x.started - y.started);
}

interface CoreDump {
  agents: { agent_id: string }[];
  candidates: { commit_id: string; author: string; status: string; reason: string | null; committed_at: number; finalized_at: number | null }[];
  provenance: { commit_id: string; record: string }[];
}

const med = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const f = (x: number | null | undefined, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : "n/a");

export interface Row {
  group: string;
  attempts: number;
  usd_total: number;
  usd_per_attempt: number | null;
  candidates: number;
  accepted: number;
  rejected: Record<string, number>;
  pending: number;
  attempts_per_accepted: number | null;
  usd_per_accepted: number | null;
  minutes_per_accepted: number | null;
  turns_median: number | null;
  minutes_median: number | null;
  sandbox_s_median: number | null;
  evals_median: number | null;
  nothing: Record<string, number>;
  usd_nothing: number;
  tokens: { attempts: number; in_per_turn: number | null; out_per_turn: number | null; cache_read_per_turn: number | null; cache_write_per_turn: number | null; cache_hit: number | null; out_usd_share: number | null };
}

/** Joins attempts with Core candidates and provenance; one row per group key. */
export function summarize(attempts: Attempt[], core: CoreDump | null, key: (a: Attempt) => string, prices?: Record<string, { input: number; output: number; cache_read: number; cache_write: number }>): Row[] {
  const cands = new Map((core?.candidates ?? []).map((c) => [c.commit_id.slice(0, 12), c]));
  const prov = new Map((core?.provenance ?? []).map((p) => [p.commit_id.slice(0, 12), JSON.parse(p.record)]));
  // attempts from before the runtime logged its route: the model their provenance attests, when they committed
  for (const a of attempts) if (a.model === "unknown" && a.candidate && prov.get(a.candidate)?.models?.length === 1) a.model = prov.get(a.candidate).models[0];
  const groups = new Map<string, Attempt[]>();
  for (const a of attempts) groups.set(key(a), [...(groups.get(key(a)) ?? []), a]);
  const rows: Row[] = [];
  for (const [g, as] of [...groups.entries()].sort()) {
    const done = as.filter((a) => a.usd !== null);
    const usd = sum(done.map((a) => a.usd!));
    let accepted = 0,
      pending = 0;
    const rejected: Record<string, number> = {};
    for (const a of as) {
      if (!a.candidate) continue;
      const c = cands.get(a.candidate);
      if (!c) pending++;
      else if (c.status === "accepted") accepted++;
      else if (["rejected", "expired"].includes(c.status)) rejected[c.reason ?? c.status] = (rejected[c.reason ?? c.status] ?? 0) + 1;
      else pending++;
    }
    const nothing: Record<string, number> = {};
    for (const a of as) if (!a.candidate) nothing[a.end] = (nothing[a.end] ?? 0) + 1;
    const withProv = as.map((a) => (a.candidate ? prov.get(a.candidate) : null)).filter(Boolean) as any[];
    const tk = withProv.map((r) => r.usage as { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number });
    const turnsOfProv = as.filter((a) => a.candidate && prov.has(a.candidate)).map((a) => a.turns + 1); // + the final submit call, which logs no turn line
    const turnsTotal = sum(turnsOfProv);
    const tin = sum(tk.map((t) => t.input_tokens)),
      tout = sum(tk.map((t) => t.output_tokens)),
      tcr = sum(tk.map((t) => t.cache_read_tokens)),
      tcw = sum(tk.map((t) => t.cache_write_tokens));
    const p = prices?.[as[0]!.model];
    const outShare = p ? (tout * p.output) / (tin * p.input + tout * p.output + tcr * p.cache_read + tcw * p.cache_write) : null;
    const timed = done.filter((a) => a.ended !== null);
    rows.push({
      group: g,
      attempts: as.length,
      usd_total: usd,
      usd_per_attempt: done.length ? usd / done.length : null,
      candidates: as.filter((a) => a.candidate).length,
      accepted,
      rejected,
      pending,
      attempts_per_accepted: accepted ? as.length / accepted : null,
      usd_per_accepted: accepted ? usd / accepted : null,
      minutes_per_accepted: accepted ? sum(timed.map((a) => (a.ended! - a.started) / 60000)) / accepted : null,
      turns_median: med(as.map((a) => a.calls)),
      minutes_median: med(timed.map((a) => (a.ended! - a.started) / 60000)),
      sandbox_s_median: med(done.map((a) => a.sandbox_s!)),
      evals_median: med(as.map((a) => a.evals)),
      nothing,
      usd_nothing: sum(done.filter((a) => !a.candidate).map((a) => a.usd!)),
      tokens: {
        attempts: tk.length,
        in_per_turn: turnsTotal ? tin / turnsTotal : null,
        out_per_turn: turnsTotal ? tout / turnsTotal : null,
        cache_read_per_turn: turnsTotal ? tcr / turnsTotal : null,
        cache_write_per_turn: turnsTotal ? tcw / turnsTotal : null,
        cache_hit: tin + tcr + tcw ? tcr / (tin + tcr + tcw) : null,
        out_usd_share: outShare !== null && Number.isFinite(outShare) ? outShare : null,
      },
    });
  }
  return rows;
}

/**
 * Author-blind (SPEC 10.7): a row never says that one agent has a candidate still open, since that
 * names the author of an open candidate on the agent's lineage. Pending counts appear only in rows
 * that are not about one agent (`showPending`).
 */
export function markdown(rows: Row[], showPending = false): string {
  const h = [
    "| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const nothingN = Object.values(r.nothing).reduce((a, b) => a + b, 0);
    const rej = Object.values(r.rejected).reduce((a, b) => a + b, 0);
    const t = r.tokens;
    h.push(
      `| ${r.group} | ${r.attempts} | ${f(r.usd_per_attempt)} | ${f(r.attempts_per_accepted, 2)} | ${f(r.usd_per_accepted)} | ${f(r.minutes_per_accepted, 1)} | ${r.turns_median ?? "n/a"} | ${f(r.minutes_median, 1)} | ${r.sandbox_s_median ?? "n/a"} | ${r.evals_median ?? "n/a"} | ${pct(nothingN, r.attempts)}${nothingN ? ": " + Object.entries(r.nothing).map(([k, v]) => `${k} ${v}`).join(", ") : ""} | ${f(r.usd_nothing)} | ${pct(rej, r.candidates)}${rej ? ": " + Object.entries(r.rejected).map(([k, v]) => `${k} ${v}`).join(", ") : ""}${showPending && r.pending ? `; ${r.pending} pending` : ""} | ${t.attempts ? `${f(t.in_per_turn, 0)} / ${f(t.out_per_turn, 0)} / ${f(t.cache_read_per_turn, 0)} / ${f(t.cache_write_per_turn, 0)} (${t.attempts} attempts)` : "n/a"} | ${t.cache_hit === null ? "n/a" : (100 * t.cache_hit).toFixed(0) + "%"} | ${t.out_usd_share === null ? "n/a" : (100 * t.out_usd_share).toFixed(0) + "%"} |`,
    );
  }
  return h.join("\n");
}

async function fetchSite(dir: string, host: string, keyPath: string) {
  mkdirSync(dir, { recursive: true });
  const ssh = (cmd: string) => {
    const p = Bun.spawnSync(["ssh", "-i", keyPath, "-o", "ConnectTimeout=15", `root@${host}`, cmd], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`ssh: ${p.stderr.toString().slice(0, 300)}`);
    return p.stdout.toString();
  };
  writeFileSync(join(dir, "runtime.log"), ssh("journalctl -u lineage-runtime --no-pager -o short-iso"));
  const q = (sql: string) => JSON.parse(ssh(`sqlite3 -readonly -json /var/lib/lineage/core/core.db "${sql.replace(/"/g, '\\"')}"`) || "[]");
  const agents = q("SELECT agent_id FROM agents WHERE hosted = 1");
  const candidates = q("SELECT c.commit_id, c.author, c.status, c.reason, c.committed_at, c.finalized_at FROM candidates c JOIN agents a ON a.agent_id = c.author WHERE a.hosted = 1");
  const provenance = q("SELECT commit_id, record FROM provenance");
  writeFileSync(join(dir, "core.json"), JSON.stringify({ fetched_at: new Date().toISOString(), host, agents, candidates, provenance }, null, 1));
  console.log(`fetched ${dir}/runtime.log and core.json (${candidates.length} hosted candidates, ${provenance.length} provenance records)`);
}

if (import.meta.main) {
  const fetchDir = arg("--fetch");
  if (fetchDir) await fetchSite(fetchDir, arg("--host", "157.245.71.188")!, arg("--ssh-key", join(homedir(), ".ssh", "lineage_site"))!);
  const dir = arg("--dir", fetchDir);
  if (!dir) {
    console.error("usage: baseline.ts --fetch <dir> | --dir <dir> [--since ISO] [--until ISO] [--json out]");
    process.exit(2);
  }
  const since = arg("--since") ? Date.parse(arg("--since")!) : -Infinity;
  const until = arg("--until") ? Date.parse(arg("--until")!) : Infinity;
  const attempts = parseRuntimeLog(readFileSync(join(dir, "runtime.log"), "utf8")).filter((a) => a.started >= since && a.started < until);
  const core = existsSync(join(dir, "core.json")) ? (JSON.parse(readFileSync(join(dir, "core.json"), "utf8")) as CoreDump) : null;
  const { MODEL_PRICES } = await import("../../packages/worker/src/proposers/anthropic.ts");
  const byAgent = summarize(attempts, core, (a) => `${a.agent} ${a.model}`, MODEL_PRICES);
  const byModel = summarize(attempts, core, (a) => a.model, MODEL_PRICES);
  const all = summarize(attempts, core, () => "all", MODEL_PRICES);
  const span = attempts.length ? `${new Date(attempts[0]!.started).toISOString()} to ${new Date(attempts[attempts.length - 1]!.started).toISOString()}` : "none";
  console.log(`attempts ${attempts.length}, started ${span}\n\nPer agent and model:\n${markdown(byAgent)}\n\nPer model:\n${markdown(byModel, true)}\n\nAll:\n${markdown(all, true)}`);
  const capStops = attempts.filter((a) => a.end === "cap_reached");
  console.log(`\ncap_reached attempts: ${capStops.length}; their caps ${capStops.map((a) => a.cap.toFixed(2)).join(", ")}; last turn before the stop cost ${capStops.map((a) => f(a.turnUsd.length > 1 ? a.turnUsd.at(-1)! - a.turnUsd.at(-2)! : a.turnUsd[0] ?? NaN, 3)).join(", ")} USD`);
  const out = arg("--json");
  // the JSON is safe to publish: no candidate ids, and no per-agent pending counts (author-blind, SPEC 10.7)
  const finals = new Map((core?.candidates ?? []).filter((c) => ["accepted", "rejected", "expired"].includes(c.status)).map((c) => [c.commit_id.slice(0, 12), c.reason ?? c.status]));
  // an attempt whose candidate is still open is left out of the list (it would name that candidate's author)
  const pub = attempts.filter((a) => !a.candidate || finals.has(a.candidate)).map(({ candidate, ...a }) => ({ ...a, committed: !!candidate, verdict: candidate ? finals.get(candidate)! : null }));
  const strip = (rows: Row[]) => rows.map(({ pending, ...r }) => r);
  if (out) writeFileSync(out, JSON.stringify({ span, attempts: pub, byAgent: strip(byAgent), byModel, all }, null, 1));
}
