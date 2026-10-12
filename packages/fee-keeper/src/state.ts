import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "@units/chain";

// The keeper's private state and its public log. The state is what makes a run safe to interrupt:
// what the wallet owes (lamports earmarked for compute and for the buyback, tokens bought and not yet
// burned, the fee reserve), the run in progress, and the one transaction that may be in flight. It is
// replaced atomically (write to a sibling, fsync, rename), so a crash leaves the old state or the new
// one, never half of either. The log is append-only, one JSON line per run that moved something.

export type Step = "collect" | "compute" | "buyback" | "burn";

/** What a transaction is meant to do, kept with it so its result can be booked after a restart. */
export type Action =
  | { kind: "collect" }
  | { kind: "compute"; lamports: bigint }
  /** Buys exactly `tokens` for at most `maxLamports`; `burn` true burns them in the same transaction. */
  | { kind: "buyback"; tokens: bigint; maxLamports: bigint; burn: boolean; venue: "curve" | "pool" }
  | { kind: "burn"; tokens: bigint };

export interface Pending {
  action: Action;
  signature: string;
  last_valid_block_height: number;
  /** The signed transaction, base64: resent as is until it lands or its blockhash expires. Not a secret. */
  wire: string;
  sent_at: string;
}

/** The public record of one run (the log line). Lamports and token base units as decimal strings. */
export interface RunRecord {
  v: 1;
  run_id: string;
  time: string;
  cluster: string;
  mint: Address;
  creator: Address;
  venue: "curve" | "pool" | "awaiting_migration";
  /** Creator fees pump.fun paid out to the wallet in this run. */
  collected_lamports: string;
  /** What the collection cost the wallet (transaction fee, rent it had to pay). */
  collect_cost_lamports: string;
  collect_signature: string | null;
  /** Kept in the wallet for the keeper's transaction fees. */
  reserve_lamports: string;
  /** This run's compute share and buyback share of what was collected. */
  compute_share_lamports: string;
  burn_share_lamports: string;
  /** SOL sent to the compute funding address in this run (this run's share plus anything owed from earlier runs). */
  compute_lamports: string;
  compute_address: Address;
  compute_signature: string | null;
  /** SOL spent buying $UNITS in this run. */
  buyback_lamports: string;
  units_bought: string;
  buyback_signature: string | null;
  units_burned: string;
  burn_signature: string | null;
  /** Transaction fees and account rent the keeper paid in this run, out of the reserve. */
  overhead_lamports: string;
  /** Owed after this run: carried to the next. */
  owed: { compute_lamports: string; buyback_lamports: string; burn_units: string; reserve_lamports: string };
  /** Why a step was left for a later run. */
  notes: string[];
}

export interface KeeperState {
  v: 1;
  mint: Address;
  creator: Address;
  /** Lamports in the wallet that belong to the compute address. */
  compute_owed: bigint;
  /** Lamports in the wallet that must buy $UNITS. */
  buyback_owed: bigint;
  /** $UNITS base units the keeper bought and has not burned yet. */
  burn_owed: bigint;
  /**
   * What the keeper's burn account held right before the first buy that was sent without its burn
   * (the lowest such balance while burn_owed is open). A separate burn is sent only while the account
   * holds at least burn_floor + burn_owed, so it destroys only what those buys added. Null: no debt
   * open, or a state written before this field existed (then nothing is burned until an operator sets
   * it by hand, docs/MAINNET-RUNBOOK.md "UNITS fee keeper").
   */
  burn_floor: bigint | null;
  /** The keeper's burn account (a token account of the wallet at a seeded address), once the keeper has bought into it. */
  burn_account: Address | null;
  /** Lamports in the wallet kept for the keeper's fees and rent. Never negative. */
  reserve: bigint;
  run: { record: RunRecord; done: Step[]; logged: boolean } | null;
  pending: Pending | null;
}

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
const unbig = (_k: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export const freshState = (mint: Address, creator: Address): KeeperState => ({ v: 1, mint, creator, compute_owed: 0n, buyback_owed: 0n, burn_owed: 0n, burn_floor: null, burn_account: null, reserve: 0n, run: null, pending: null });

/** Loads the state, or a fresh one when the file does not exist. Refuses a state written for another coin or wallet. */
export function loadState(file: string, mint: Address, creator: Address): KeeperState {
  if (!existsSync(file)) return freshState(mint, creator);
  const s = JSON.parse(readFileSync(file, "utf8"), unbig) as KeeperState;
  if (s.v !== 1) throw new Error(`${file}: unknown state version`);
  if (s.mint !== mint || s.creator !== creator) throw new Error(`${file} belongs to mint ${s.mint} and creator ${s.creator}, not the configured ones: refusing (use another state_path)`);
  for (const k of ["compute_owed", "buyback_owed", "burn_owed", "reserve"] as const) if (typeof s[k] !== "bigint" || s[k] < 0n) throw new Error(`${file}: ${k} is not a non-negative amount`);
  // a state written before burn_floor and burn_account existed has neither: null, never a guess
  s.burn_floor ??= null;
  s.burn_account ??= null;
  if (s.burn_floor !== null && (typeof s.burn_floor !== "bigint" || s.burn_floor < 0n)) throw new Error(`${file}: burn_floor is not null or a non-negative amount (write it as a string of digits ending in n, like "0n")`);
  if (s.burn_account !== null && typeof s.burn_account !== "string") throw new Error(`${file}: burn_account is not null or an address`);
  return s;
}

function writeDurable(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export const saveState = (file: string, s: KeeperState) => writeDurable(file, JSON.stringify(s, big, 2) + "\n");

/** Reads the log's records; lines that do not parse are skipped (a torn last line after a crash). */
export function readLog(file: string): RunRecord[] {
  if (!existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (r && r.v === 1 && typeof r.run_id === "string") out.push(r);
    } catch {
      // a torn line
    }
  }
  return out;
}

/** Appends a record unless a line with its run id is already there (a run resumed after the append). */
export function appendLog(file: string, r: RunRecord): boolean {
  if (readLog(file).some((x) => x.run_id === r.run_id)) return false;
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const fd = openSync(file, "a", 0o644);
  try {
    writeSync(fd, `${text && !text.endsWith("\n") ? "\n" : ""}${JSON.stringify(r)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** One keeper per state file: a lock file holding the pid. A lock whose process is gone is taken over. */
export function acquireLock(stateFile: string): () => void {
  const lock = `${stateFile}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          // already gone
        }
      };
    } catch {
      const pid = Number(readFileSync(lock, "utf8").trim());
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive) throw new Error(`another keeper run holds ${lock} (pid ${pid})`);
      unlinkSync(lock);
    }
  }
  throw new Error(`cannot take ${lock}`);
}
