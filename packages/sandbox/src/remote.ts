// Sandbox hosts (scale-out lane, docs/plans/SCALE-OUT.md section 6): evaluations of authoring attempts
// run on other machines, the hosted runtime stays one process on the site.
//
// An evaluation is a function of the recipe, the parent patches, the candidate patch and the seed
// (evaluate() in evaluate.ts). A sandbox host holds the same release (the same re-pinned recipes), the
// same sandbox images and Docker; the runtime sends the inputs as one JSON document over ssh to the
// host's forced command (scripts/deploy/capacity-host/units-sandbox-gw, which runs
// packages/worker/src/eval-job.ts) and reads the result and transcript back. Nothing else lives on a
// host: no agent key, no model key, no journal, no session. A patch is on the host only for the run
// (the job removes its work directory) and the host publishes nothing, so the author-blind rules hold
// as they do on the site: the candidate stays sealed in Core until it is final.
//
// Off unless a hosts file is installed (installSandboxHosts; the runtime does it from
// `sandbox_hosts_file`). Verifiers and the reference runner never install one: a replay is always run
// by the verifier itself.
//
// Placement: the host with the lowest share of its slots in use, among hosts that are up and have a
// free slot. A host whose connection or job runner fails is marked down for `retry_s` and the same
// evaluation is run on the next host; with no host free or up it runs on this machine, as before.
// A verdict of the evaluation itself (EvalError: a broken parent series, a guard) is not a host
// failure and is thrown to the caller unchanged.
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Hex } from "@units/protocol";
import type { DepsLayer, EvalOutput, PhaseCallback } from "./evaluate.ts";
import type { LoadedRecipe } from "./recipe.ts";

export interface SandboxHost {
  name: string;
  address: string;
  port?: number;
  /** ssh user whose authorized_keys runs only units-sandbox-gw (capacity-host/provision.sh: units-cap) */
  user?: string;
  /** private key of the runtime's user on the site, and the known_hosts file holding the host's own key */
  key: string;
  known_hosts: string;
  /** evaluations at once on this host (register.ts: from the host's measured cores, sizing.ts) */
  slots: number;
  /** test and local proof: run this command instead of ssh (the gateway's argument is appended) */
  command?: string[];
}

export interface SandboxHostsFile {
  _note?: string;
  hosts: SandboxHost[];
  /** seconds a failed host is left alone (default 60) */
  retry_s?: number;
  /** false: with no host available an evaluation fails instead of running on this machine (default true) */
  local_fallback?: boolean;
}

/** What goes to the host: everything evaluate() needs that is not already there with the release. */
export interface EvalJob {
  v: 1;
  recipe_id: string;
  deps_digest: Hex;
  parent_patches: string[];
  candidate_patch: string;
  seed: Hex;
  enabled_metrics?: string[];
}

export type EvalJobAnswer =
  | { ok: true; host?: string; result: EvalOutput["result"]; transcript: EvalOutput["transcript"] }
  | { ok: false; kind: "eval" | "host"; error: string };

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one command line with stdin; `onStderrLine` sees the job's phase lines as they come. */
export type RunCommand = (argv: string[], stdin: string, timeoutMs: number, onStderrLine: (l: string) => void) => Promise<ExecResult>;

export const PHASE_PREFIX = "@phase ";

export function hostError(v: unknown): string | null {
  if (!v || typeof v !== "object") return "not an object";
  const h = v as Record<string, unknown>;
  if (typeof h.name !== "string" || !/^[a-z0-9-]{1,32}$/.test(h.name)) return "name is a-z 0-9 - (1 to 32)";
  if (!(Number.isInteger(h.slots) && (h.slots as number) >= 1 && (h.slots as number) <= 256)) return `${h.name}: slots is a whole number from 1 to 256`;
  if (h.command !== undefined) return Array.isArray(h.command) && h.command.length > 0 && h.command.every((x) => typeof x === "string") ? null : `${h.name}: command is a list of strings`;
  if (typeof h.address !== "string" || !/^[A-Za-z0-9.:-]{1,253}$/.test(h.address)) return `${h.name}: address is a host name or an IP address`;
  if (typeof h.key !== "string" || !h.key.startsWith("/") || typeof h.known_hosts !== "string" || !h.known_hosts.startsWith("/")) return `${h.name}: key and known_hosts are absolute paths`;
  if (h.port !== undefined && !(Number.isInteger(h.port) && (h.port as number) > 0 && (h.port as number) < 65536)) return `${h.name}: port is a TCP port`;
  if (h.user !== undefined && (typeof h.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(h.user))) return `${h.name}: user is a login name`;
  return null;
}

export function parseHostsFile(text: string): SandboxHostsFile {
  const d = JSON.parse(text) as SandboxHostsFile;
  if (!d || typeof d !== "object" || !Array.isArray(d.hosts)) throw new Error("sandbox hosts file: { hosts: [...] } expected");
  const seen = new Set<string>();
  for (const h of d.hosts) {
    const e = hostError(h);
    if (e) throw new Error(`sandbox hosts file: ${e}`);
    if (seen.has(h.name)) throw new Error(`sandbox hosts file: ${h.name} is listed twice`);
    seen.add(h.name);
  }
  if (d.retry_s !== undefined && !(typeof d.retry_s === "number" && d.retry_s >= 1 && d.retry_s <= 3600)) throw new Error("sandbox hosts file: retry_s is 1 to 3600 seconds");
  if (d.local_fallback !== undefined && typeof d.local_fallback !== "boolean") throw new Error("sandbox hosts file: local_fallback is true or false");
  return d;
}

/** ssh to the host's gateway: our key and known_hosts only, fail fast, notice a dead host within about 30 s. */
export function sshArgv(h: SandboxHost, cmd: string): string[] {
  if (h.command) return [...h.command, cmd];
  return [
    "ssh", "-i", h.key, "-p", String(h.port ?? 22),
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${h.known_hosts}`,
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", "LogLevel=ERROR",
    `${h.user ?? "units-cap"}@${h.address}`, "--", cmd,
  ];
}

/** The real transport: the command line as a child process, the job on its stdin. */
export const spawnRun: RunCommand = async (argv, stdin, timeoutMs, onStderrLine) => {
  const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, timeoutMs);
  try {
    p.stdin.write(stdin);
    await p.stdin.end();
    let err = "";
    let buf = "";
    const dec = new TextDecoder();
    const readErr = (async () => {
      for await (const chunk of p.stderr as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.startsWith(PHASE_PREFIX)) onStderrLine(line);
          else if (err.length < 8192) err += line + "\n";
        }
      }
      if (buf && err.length < 8192) err += buf;
    })();
    const [stdout] = await Promise.all([new Response(p.stdout).text(), readErr]);
    const code = await p.exited;
    return { code: timedOut ? 255 : code, stdout, stderr: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s\n${err}` : err };
  } finally {
    clearTimeout(t);
  }
};

export interface RemoteSandboxesOpts {
  file: string;
  log?: (m: string) => void;
  now?: () => number;
  /** test hook */
  run?: RunCommand;
  /** seconds between re-reads of the hosts file (default 60; the file's mtime is checked) */
  reload_s?: number;
}

export class RemoteSandboxes {
  private doc: SandboxHostsFile = { hosts: [] };
  private readAt = -Infinity;
  private mtime = -1;
  private inflight = new Map<string, number>();
  private down = new Map<string, { until: number; why: string }>();
  private log: (m: string) => void;
  private now: () => number;
  private run: RunCommand;
  /** evaluations finished per host, and on this machine (status, proofs) */
  readonly done = new Map<string, number>();

  constructor(private o: RemoteSandboxesOpts) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    this.run = o.run ?? spawnRun;
  }

  /** The hosts as the file lists them now. A file that is missing lists none; one that does not parse keeps the last good list. */
  hosts(): SandboxHost[] {
    const every = (this.o.reload_s ?? 60) * 1000;
    if (this.now() - this.readAt >= every) {
      this.readAt = this.now();
      try {
        if (!existsSync(this.o.file)) {
          if (this.doc.hosts.length) this.log(`sandbox hosts: ${this.o.file} is gone; evaluations run here`);
          this.doc = { hosts: [] };
          this.mtime = -1;
        } else {
          const m = statSync(this.o.file).mtimeMs;
          if (m !== this.mtime) {
            const next = parseHostsFile(readFileSync(this.o.file, "utf8"));
            const before = this.doc.hosts.map((h) => h.name).join(",");
            this.doc = next;
            this.mtime = m;
            const after = next.hosts.map((h) => `${h.name} (${h.slots})`).join(", ");
            if (before !== next.hosts.map((h) => h.name).join(",")) this.log(`sandbox hosts: ${after || "none"}`);
          }
        }
      } catch (e) {
        this.log(`sandbox hosts: ${this.o.file} not read (${(e as Error).message.slice(0, 160)}); keeping ${this.doc.hosts.length} host(s)`);
      }
    }
    return this.doc.hosts;
  }

  private isDown(name: string): boolean {
    const d = this.down.get(name);
    if (!d) return false;
    if (this.now() >= d.until) {
      this.down.delete(name);
      return false;
    }
    return true;
  }

  /** The host to use next: up, a free slot, the lowest share of slots in use (ties: fewest finished, then name). */
  pick(exclude: Set<string> = new Set()): SandboxHost | null {
    let best: SandboxHost | null = null;
    let bestKey: [number, number, string] | null = null;
    for (const h of this.hosts()) {
      if (exclude.has(h.name) || this.isDown(h.name)) continue;
      const n = this.inflight.get(h.name) ?? 0;
      if (n >= h.slots) continue;
      const key: [number, number, string] = [n / h.slots, this.done.get(h.name) ?? 0, h.name];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        best = h;
        bestKey = key;
      }
    }
    return best;
  }

  status() {
    return {
      hosts: this.hosts().map((h) => ({ name: h.name, slots: h.slots, running: this.inflight.get(h.name) ?? 0, up: !this.isDown(h.name), why: this.down.get(h.name)?.why ?? null, done: this.done.get(h.name) ?? 0 })),
      local_done: this.done.get("(local)") ?? 0,
    };
  }

  /** The gateway's health answer of one host, or the reason it gave none. */
  async health(h: SandboxHost): Promise<{ ok: true; health: Record<string, unknown> } | { ok: false; why: string }> {
    const r = await this.run(sshArgv(h, "health"), "", 20_000, () => {}).catch((e) => ({ code: 255, stdout: "", stderr: (e as Error).message }));
    if (r.code !== 0) return { ok: false, why: (r.stderr.trim().split("\n").pop() ?? `exit ${r.code}`).slice(0, 200) };
    try {
      return { ok: true, health: JSON.parse(r.stdout.trim().split("\n").pop()!) as Record<string, unknown> };
    } catch {
      return { ok: false, why: "health answer is not JSON" };
    }
  }

  /**
   * Runs one evaluation on a host, or with `local` when no host can take it. `timeoutMs` bounds one
   * try on one host (the caller derives it from the recipe's wall limit).
   */
  async evaluate(job: EvalJob, o: { local: () => Promise<EvalOutput>; onPhase?: PhaseCallback; timeoutMs: number; EvalError: new (m: string) => Error }): Promise<EvalOutput> {
    const tried = new Set<string>();
    const stdin = JSON.stringify(job);
    for (;;) {
      const h = this.pick(tried);
      if (!h) {
        if (this.doc.local_fallback === false && this.hosts().length) throw new Error(`no sandbox host can take the evaluation (${[...tried].join(", ") || "all busy or down"}) and local_fallback is off`);
        if (tried.size) this.log(`sandbox hosts: none left for this evaluation after ${[...tried].join(", ")}; running it here`);
        const out = await o.local();
        this.done.set("(local)", (this.done.get("(local)") ?? 0) + 1);
        return out;
      }
      tried.add(h.name);
      this.inflight.set(h.name, (this.inflight.get(h.name) ?? 0) + 1);
      let r: ExecResult;
      try {
        r = await this.run(sshArgv(h, "eval"), stdin, o.timeoutMs, (line) => {
          const [name, at] = line.slice(PHASE_PREFIX.length).trim().split(" ");
          if (name && ["prepare", "build", "test", "equivalence", "metrics"].includes(name)) o.onPhase?.(name as Parameters<PhaseCallback>[0], Number(at) || this.now());
        }).catch((e) => ({ code: 255, stdout: "", stderr: (e as Error).message }));
      } finally {
        const n = (this.inflight.get(h.name) ?? 1) - 1;
        if (n > 0) this.inflight.set(h.name, n);
        else this.inflight.delete(h.name);
      }
      let a: EvalJobAnswer | null = null;
      try {
        const last = r.stdout.trim().split("\n").pop();
        a = last ? (JSON.parse(last) as EvalJobAnswer) : null;
      } catch {
        a = null;
      }
      if (a && a.ok && a.result && a.transcript) {
        this.done.set(h.name, (this.done.get(h.name) ?? 0) + 1);
        return { result: a.result, transcript: a.transcript };
      }
      if (a && !a.ok && a.kind === "eval") throw new o.EvalError(a.error);
      const why = (a && !a.ok ? a.error : r.stderr.trim().split("\n").pop() || `exit ${r.code}`).slice(0, 200);
      const retry = this.doc.retry_s ?? 60;
      this.down.set(h.name, { until: this.now() + retry * 1000, why });
      this.log(`sandbox host ${h.name} failed an evaluation (${why}); left alone for ${retry} s, the evaluation goes to the next host`);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// the process-wide pool evaluate() consults (evaluate.ts)

let installed: RemoteSandboxes | null = null;
let envChecked = false;

/** Sends this process's evaluations to the hosts in `file` from now on. Call once, from the hosted runtime only. */
export function installSandboxHosts(o: RemoteSandboxesOpts): RemoteSandboxes {
  installed = new RemoteSandboxes(o);
  const n = installed.hosts().length;
  (o.log ?? (() => {}))(`sandbox hosts: evaluations of attempts go to the hosts in ${o.file} (${n} now; the file is re-read every ${o.reload_s ?? 60} s); with none free or up they run here`);
  return installed;
}

export function uninstallSandboxHosts(): void {
  installed = null;
}

/**
 * The installed pool. A process whose environment names a hosts file (UNITS_SANDBOX_HOSTS_FILE: only
 * the hosted runtime's unit sets it, scripts/deploy/systemd/units-runtime.service) installs it on
 * first use, so the runtime needs no code of its own for this. Until scripts/deploy/capacity-host
 * registers a host the file does not exist and every evaluation runs here, as before.
 */
export function sandboxHosts(): RemoteSandboxes | null {
  if (!installed && !envChecked) {
    envChecked = true;
    const file = process.env.UNITS_SANDBOX_HOSTS_FILE?.trim();
    if (file && file.startsWith("/")) installSandboxHosts({ file, log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)} sandbox] ${m}`) });
  }
  return installed;
}

export function evalJobOf(input: { loaded: LoadedRecipe; deps: DepsLayer; parentPatches: string[]; candidatePatch: string; seed: Hex; enabledMetrics?: string[] }): EvalJob {
  return { v: 1, recipe_id: input.loaded.recipe_id, deps_digest: input.deps.digest, parent_patches: input.parentPatches, candidate_patch: input.candidatePatch, seed: input.seed, ...(input.enabledMetrics ? { enabled_metrics: input.enabledMetrics } : {}) };
}
