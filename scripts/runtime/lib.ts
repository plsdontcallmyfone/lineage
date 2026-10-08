import { spawn, type Subprocess } from "bun";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Shared pieces of the hosted runtime proofs (scripts/runtime/sim-run.ts, devnet-run.ts).

export const ROOT = join(import.meta.dir, "..", "..");
export const T0 = Date.now();
export const log = (m: string) => console.log(`[runtime-proof +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

export const results: { check: string; ok: boolean; detail: string }[] = [];
export function check(name: string, ok: boolean, detail = "") {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

export function portFree(port: number): void {
  const busy = Bun.spawnSync(["lsof", "-ti", `:${port}`]).stdout.toString().trim();
  if (busy) throw new Error(`port ${port} busy (pid ${busy}); pick another in 9662-9669`);
}

export const procs: Subprocess[] = [];
/** Starts a child process with prefixed output; every child is ours and is stopped by PID. */
export function child(name: string, cmd: string[], onLine?: (l: string) => void): Subprocess {
  const p = spawn(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
  for (const s of [p.stdout, p.stderr])
    (async () => {
      let buf = "";
      for await (const c of s) {
        buf += new TextDecoder().decode(c);
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines)
          if (l.trim()) {
            console.log(`   ${name.padEnd(4)} ${l}`);
            onLine?.(l);
          }
      }
    })();
  procs.push(p);
  return p;
}

export async function stopAll(): Promise<void> {
  for (const p of procs.reverse()) {
    if (p.exitCode !== null) continue;
    p.kill("SIGTERM");
    const t = setTimeout(() => p.exitCode === null && p.kill("SIGKILL"), 15_000);
    await p.exited;
    clearTimeout(t);
  }
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 600_000, everyMs = 2000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await Bun.sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

// ------------------------------------------------------------------------------------------------
// the lane's Claude spend ledger (hard cap for the hosted runtime lane: 3 USD in total)

export const SPEND_LOG = join(ROOT, "scripts", "runtime", "RUNS.md");
export const LANE_CAP_USD = 3;

/** Claude spend of every earlier proof run, from scripts/runtime/RUNS.md (measured by the runtime). */
export function laneSpent(): number {
  if (!existsSync(SPEND_LOG)) return 0;
  let s = 0;
  for (const l of readFileSync(SPEND_LOG, "utf8").split("\n")) {
    const m = /^\| [^|]+ \| [^|]+ \| ([0-9.]+) \|/.exec(l);
    if (m) s += Number(m[1]);
  }
  return s;
}

export function logRun(kind: string, usd: number, note: string): void {
  if (!existsSync(SPEND_LOG))
    writeFileSync(
      SPEND_LOG,
      "# Hosted runtime proof runs\n\nClaude spend of each real run, as metered by the runtime from the API's usage fields at the published per-token prices. The lane's hard cap is 3 USD in total.\n\n| When (UTC) | Run | Claude USD | Note |\n|---|---|---|---|\n",
    );
  appendFileSync(SPEND_LOG, `| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | ${kind} | ${usd.toFixed(4)} | ${note.replace(/\|/g, "/")} |\n`);
}
