import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKey, keyFromSolanaJson, type AgentKey } from "@lineage/protocol";

// Persisted runtime state (crash recovery), the single-process lock, runtime-generated agent keys
// and log redaction. State is one JSON file written atomically (temp file, then rename) after every
// change that matters: a model response, an attempt, a closed epoch, each post and each debit.

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number;
  sandbox_s: number;
  models: string[];
  attempts: number;
  candidates: string[];
}

export const emptyUsage = (): AgentUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  usd: 0,
  sandbox_s: 0,
  models: [],
  attempts: 0,
  candidates: [],
});

export const modelTokens = (u: AgentUsage) => u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens;

export interface AgentState {
  /** runtime-generated signing key for this agent (identity plan I1); the launcher's key is never held */
  key_id: string;
  key_file: string;
  status: "awaiting_owner" | "bound" | "unbound";
  discovered_at: number;
  bound_at: number | null;
  mint: string | null;
  target_repo: string | null;
  candidates: number;
}

/** One usage epoch's records once closed: what is posted (leaves) and what landed. */
export interface ClosedEpoch {
  /** devnet: the onchain usage epoch; sim: the runtime's own period number */
  epoch: number;
  opened_at: number;
  closed_at: number;
  leaves: { agent: string; amount: string; cost: string; model_tokens: number; sandbox_s: number; usd: number }[];
  root: string | null;
  post: string | null;
  /** agent -> devnet debit signature, or sim usage id */
  debits: Record<string, string>;
  done: boolean;
}

export interface RuntimeState {
  v: 1;
  mode: "sim" | "devnet";
  runtime: string;
  spent_usd_total: number;
  agents: Record<string, AgentState>;
  open: { period: number; opened_at: number; usage: Record<string, AgentUsage> };
  closed: ClosedEpoch[];
  runs: { started_at: number; stopped_at: number | null; spent_usd: number; pid: number }[];
}

export class StateStore {
  readonly file: string;
  readonly keysDir: string;
  state: RuntimeState;

  constructor(readonly dir: string, init: { mode: "sim" | "devnet"; runtime: string; now: number }) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "state.json");
    this.keysDir = join(dir, "keys");
    mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });
    chmodSync(this.keysDir, 0o700);
    if (existsSync(this.file)) {
      this.state = JSON.parse(readFileSync(this.file, "utf8")) as RuntimeState;
      if (this.state.mode !== init.mode || this.state.runtime !== init.runtime)
        throw new Error(`state in ${dir} belongs to a ${this.state.mode} runtime ${this.state.runtime}; use another state_dir`);
    } else {
      this.state = { v: 1, mode: init.mode, runtime: init.runtime, spent_usd_total: 0, agents: {}, open: { period: 0, opened_at: init.now, usage: {} }, closed: [], runs: [] };
      this.save();
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Generates (once) and stores the runtime's signing key for `agent`. */
  keyFor(agent: string): AgentKey {
    const file = join(this.keysDir, `${agent}.json`);
    if (existsSync(file)) return keyFromSolanaJson(JSON.parse(readFileSync(file, "utf8")));
    const k = generateAgentKey();
    writeFileSync(file, JSON.stringify(Array.from(k.secret)), { mode: 0o600, flag: "wx" });
    return k;
  }

  keyFile(agent: string): string {
    return join(this.keysDir, `${agent}.json`);
  }
}

// ------------------------------------------------------------------------------------------------
// one process per runtime

export class Lock {
  readonly file: string;
  private held = false;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "runtime.lock");
  }

  /** Takes the lock, or throws naming the live process that holds it. A stale lock is taken over. */
  acquire(): void {
    if (existsSync(this.file)) {
      const pid = Number(readFileSync(this.file, "utf8").split("\n")[0]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) throw new Error(`runtime state is locked by live pid ${pid} (${this.file}); one process per runtime`);
      unlinkSync(this.file);
    }
    writeFileSync(this.file, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600 });
    this.held = true;
  }

  release(): void {
    if (!this.held) return;
    try {
      if (Number(readFileSync(this.file, "utf8").split("\n")[0]) === process.pid) unlinkSync(this.file);
    } catch {
      /* already gone */
    }
    this.held = false;
  }
}

/** True when `pid` is a live process that is a bun process (a recycled pid of another program is not our runtime). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const p = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
  return /\bbun\b/.test(p.stdout.toString());
}

// ------------------------------------------------------------------------------------------------
// secrets never reach logs

const SECRET_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "HELIUS_DEVNET_RPC", "LINEAGE_DEVNET_RPC"];

/** Replaces model keys, keyed RPC URLs and any value of a secret environment variable. */
export function redact(s: string): string {
  let out = s.replace(/sk-ant-[A-Za-z0-9_\-]{8,}/g, "[redacted]").replace(/(api-key=|api_key=)[^&\s"']+/gi, "$1[redacted]");
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (v && v.length >= 8) out = out.split(v).join("[redacted]");
  }
  return out;
}
