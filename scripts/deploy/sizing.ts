#!/usr/bin/env bun
// units site: what one machine carries, derived from its size (docs/plans/SCALE-OUT.md).
//
//   bun scripts/deploy/sizing.ts [--cores <n>] [--memory-mb <n>] [--role site|verifier|shard]
//
// Prints the settings as JSON. site-config.ts calls sizeFor() on every install and activate, so a
// resized server needs one deploy and nothing else; scripts/deploy/verifier-host and shard-host call
// it for their own machines. Every constant below is a measurement from the site (2026-10-12, the
// 4 vCPU / 8 GB server, minbpe-heavy and base58-py-heavy, SCALE-OUT.md section 1) or a stated rule.
// Nothing here is a benchmark of the larger machines: after a resize, read the same journals again.
import { cpus, totalmem } from "node:os";

/** Measured inputs (SCALE-OUT.md section 1). Change them there first, then here. */
export const MEASURED = {
  /** sandbox seconds of one authoring attempt, mean of 36 hosted attempts on the heavy recipes */
  attempt_sandbox_s: 432,
  /** seconds of an attempt outside its evaluations (model turns, setup, journal), mean */
  attempt_other_s: 59,
  /** runtime attempt_gap_s on the site */
  attempt_gap_s: 30,
  /** candidates per attempt (31 of 36) */
  candidates_per_attempt: 31 / 36,
  /** one replay of a heavy unit, seconds: 25th percentile of 54 replays, weighted by unit (506 s x 38, 428 s x 16) */
  replay_s: 483,
  /** config/network.json: replays per candidate, and the share of candidates audited once more */
  quorum: 2,
  audit_rate: 0.1,
  /** one running sandbox container holds one core (valgrind is single threaded): 96% of a core at most in 26 samples */
  cores_per_sandbox: 1,
  /** the recipes' memory limit per sandbox container (recipe.yml limits.memory_mb); 92 MiB was the most seen */
  sandbox_limit_mb: 2048,
} as const;

/** Dedicated vCPUs one agent working without a pause needs: authoring, verification, both. */
export function vcpuPerAgent(m: typeof MEASURED = MEASURED) {
  const cycle = m.attempt_sandbox_s + m.attempt_other_s + m.attempt_gap_s;
  const authoring = (m.attempt_sandbox_s * m.cores_per_sandbox) / cycle;
  const verification = (m.candidates_per_attempt * m.quorum * (1 + m.audit_rate) * m.replay_s * m.cores_per_sandbox) / cycle;
  return { cycle_s: cycle, authoring, verification, total: authoring + verification };
}

export type Role = "site" | "verifier" | "shard";

export interface Sizing {
  cores: number;
  memory_mb: number;
  role: Role;
  /** cores kept for everything that is not a sandbox (Core, indexer, web, gate, runtime, Docker, the OS) */
  reserved_cores: number;
  /** UNITS_SANDBOX_SLOTS: sandbox containers at once on the machine, across every service and instance */
  sandbox_slots: number;
  /** runtime max_concurrent_ceiling: authoring attempts at once, with verification keeping pace on this machine */
  attempts: number;
  /** UNITS_REPLAY_SLOTS: replays one verifier process runs at once */
  replay_slots: number;
  /** Core max_open_replays: open replays one verifier may hold (never under the network default of 2) */
  max_open_replays: number;
  /** UNITS_SANDBOX_CPU_SHARES: weight of a sandbox container under contention (services keep Docker's 1024) */
  cpu_shares: number;
  /** how many of the site's verifiers run on this machine (the reference runner is not counted) */
  verifiers: number;
}

const whole = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(x)));

/**
 * The settings for a machine of `cores` and `memory_mb`.
 *
 * Rules:
 * - reserve: 2 cores, or an eighth of the machine when that is more, stay out of the sandbox slots on
 *   a site machine (the 4 vCPU server ran 2 slots beside its services: load 4 to 7, was 16 to 28
 *   without the limit); a machine that only runs sandboxes (verifier host, shard) keeps 1, or a
 *   sixteenth.
 * - slots: the cores left, and never more than the memory holds at the recipes' limit (2 GiB kept
 *   for the services).
 * - site: the slots are shared by authoring and verification in the measured proportion
 *   (vcpuPerAgent), so verdicts keep pace with candidates; attempts = slots / vCPU per agent.
 * - verifier host: every slot replays; shard: every slot is authoring's (verification is elsewhere).
 * - a verifier process runs `replay_slots` replays at once; a site machine runs `verifiers` of them
 *   (two: the quorum), a verifier host one.
 */
export function sizeFor(o: { cores: number; memory_mb: number; role?: Role; verifiers?: number }): Sizing {
  const role = o.role ?? "site";
  if (!(Number.isInteger(o.cores) && o.cores >= 1)) throw new Error(`sizing: cores must be a whole number >= 1, got ${o.cores}`);
  if (!(o.memory_mb >= 512)) throw new Error(`sizing: memory_mb must be at least 512, got ${o.memory_mb}`);
  const reserved = role === "site" ? Math.max(2, Math.ceil(o.cores / 8)) : Math.max(1, Math.ceil(o.cores / 16));
  const byCpu = Math.max(1, o.cores - reserved);
  const byMem = Math.max(1, Math.floor((o.memory_mb - 2048) / MEASURED.sandbox_limit_mb));
  const slots = whole(Math.min(byCpu, byMem), 1, 256);
  const v = vcpuPerAgent();
  const verifiers = o.verifiers ?? (role === "site" ? MEASURED.quorum : role === "verifier" ? 1 : 0);
  let attempts: number;
  let replay: number;
  if (role === "verifier") {
    attempts = 0;
    replay = whole(slots / Math.max(1, verifiers), 1, 64);
  } else if (role === "shard") {
    // an attempt holds a slot for attempt_sandbox_s of every cycle
    attempts = whole(slots / v.authoring, 1, 64);
    replay = 0;
  } else {
    attempts = whole(slots / v.total, 2, 64);
    replay = whole((slots * (v.verification / v.total)) / Math.max(1, verifiers), 1, 64);
  }
  return {
    cores: o.cores,
    memory_mb: Math.floor(o.memory_mb),
    role,
    reserved_cores: reserved,
    sandbox_slots: slots,
    attempts,
    replay_slots: replay,
    max_open_replays: Math.max(2, replay),
    cpu_shares: 512,
    verifiers,
  };
}

/** How many agents working without a pause a machine of this size carries, by role (whole agents). */
export function agentsCarried(s: Sizing): number {
  const v = vcpuPerAgent();
  return Math.floor(s.sandbox_slots / (s.role === "shard" ? v.authoring : s.role === "verifier" ? v.verification : v.total));
}

/** This machine. UNITS_SIZE_CORES and UNITS_SIZE_MEMORY_MB stand in for it in tests and dry runs. */
export function thisMachine(env: Record<string, string | undefined> = process.env): { cores: number; memory_mb: number } {
  const c = Number(env.UNITS_SIZE_CORES);
  const m = Number(env.UNITS_SIZE_MEMORY_MB);
  return {
    cores: Number.isInteger(c) && c >= 1 ? c : cpus().length,
    memory_mb: Number.isFinite(m) && m >= 512 ? Math.floor(m) : Math.floor(totalmem() / 1048576),
  };
}

/**
 * The operator's overrides (a JSON object; on the site /etc/<instance>/sizing.json, written by root):
 * any of sandbox_slots, attempts, replay_slots, max_open_replays, cpu_shares, as whole numbers. An
 * unknown key or a value out of range is refused, never ignored.
 */
export function applyOverrides(s: Sizing, over: unknown): Sizing {
  if (over === undefined || over === null) return s;
  if (typeof over !== "object" || Array.isArray(over)) throw new Error("sizing overrides: a JSON object is expected");
  const range: Record<string, [number, number]> = { sandbox_slots: [1, 256], attempts: [1, 64], replay_slots: [1, 64], max_open_replays: [2, 64], cpu_shares: [2, 262144] };
  const out = { ...s };
  for (const [k, val] of Object.entries(over as Record<string, unknown>)) {
    if (k.startsWith("_")) continue; // notes
    const r = range[k];
    if (!r) throw new Error(`sizing overrides: unknown key ${JSON.stringify(k)} (known: ${Object.keys(range).join(", ")})`);
    if (!(typeof val === "number" && Number.isInteger(val) && val >= r[0] && val <= r[1])) throw new Error(`sizing overrides: ${k} is a whole number from ${r[0]} to ${r[1]}`);
    (out as Record<string, unknown>)[k] = val;
  }
  // a verifier never holds more open replays than Core hands it
  if (out.max_open_replays < out.replay_slots) out.max_open_replays = out.replay_slots;
  return out;
}

/** The lines of sizing.env (systemd EnvironmentFile, read after site.env by every unit that runs sandboxes). */
export function sizingEnv(s: Sizing): string {
  return [
    "# written by scripts/deploy/site-config.ts from this machine's size (scripts/deploy/sizing.ts); overrides: sizing.json beside site.env",
    `UNITS_SANDBOX_SLOTS=${s.sandbox_slots}`,
    `UNITS_SANDBOX_CPU_SHARES=${s.cpu_shares}`,
    `UNITS_REPLAY_SLOTS=${Math.max(1, s.replay_slots)}`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
  const here = thisMachine();
  const s = sizeFor({ cores: opt("cores") ? Number(opt("cores")) : here.cores, memory_mb: opt("memory-mb") ? Number(opt("memory-mb")) : here.memory_mb, role: (opt("role") as Role | undefined) ?? "site" });
  const v = vcpuPerAgent();
  console.log(JSON.stringify({ ...s, agents_carried: agentsCarried(s), vcpu_per_agent: { authoring: +v.authoring.toFixed(3), verification: +v.verification.toFixed(3), total: +v.total.toFixed(3) } }, null, 2));
}
