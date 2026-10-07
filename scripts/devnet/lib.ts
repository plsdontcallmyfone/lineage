// Shared pieces of the devnet scripts: the RPC, the key directory, the public state file, and the
// transaction log in onchain/DEVNET.md. Nothing here reads or changes `solana config`; every key is
// passed explicitly. Secret keys are never printed; keys are reported by public key only.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ChainReader,
  loadKeypair,
  loadOrCreateKeypair,
  Rpc,
  sendAndConfirm,
  system,
  TxError,
  type Ix,
  type SendOptions,
  type SendResult,
  type Signer,
} from "@lineage/chain";

export const ROOT = join(import.meta.dir, "..", "..");
export const RPC_URL = process.env.LINEAGE_DEVNET_RPC ?? "https://api.devnet.solana.com";
export const KEY_DIR = join(homedir(), ".config", "lineage", "devnet");
export const DEPLOYER_PATH = join(homedir(), ".config", "lineage", "devnet-deployer.json");
export const STATE_PATH = join(ROOT, "scripts", "devnet", "devnet.json");
const LOG_PATH = join(ROOT, "onchain", "DEVNET.md");
export const LAMPORTS = 1_000_000_000n;

export const rpc = Rpc.http(RPC_URL, "confirmed");
export const reader = new ChainReader(rpc);

export const log = (m: string) => console.log(`[devnet] ${m}`);
export const sol = (l: bigint) => (Number(l) / 1e9).toFixed(9);

export function deployer(): Signer {
  return loadKeypair(DEPLOYER_PATH);
}

/** A devnet key under ~/.config/lineage/devnet (created mode 600 on first use). */
export function key(name: string): Signer {
  const { key: k, created } = loadOrCreateKeypair(join(KEY_DIR, `${name}.json`));
  if (created) log(`new key ${name}: ${k.id} (~/.config/lineage/devnet/${name}.json)`);
  return k;
}

/** Public addresses and parameters the scripts and Core chain mode share (no secrets). */
export interface DevnetState {
  mode: "devnet";
  rpc_url: string;
  registry_program: string;
  launch_program: string;
  line_mint?: string;
  line_token_program?: string;
  line_decimals?: number;
  core_authority?: string;
  /** Path of the Core authority keypair, `~` for the home directory. */
  core_authority_key?: string;
  runtime_authority?: string;
  compute_sink?: string;
  dbc_config?: string;
  admin?: string;
  agents?: Record<string, { agent: string; mint?: string; launcher?: string; repo_url?: string; owner?: string }>;
  [k: string]: unknown;
}
export function loadState(): DevnetState {
  const base: DevnetState = {
    mode: "devnet",
    rpc_url: "https://api.devnet.solana.com",
    registry_program: "2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY",
    launch_program: "8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT",
  };
  return existsSync(STATE_PATH) ? { ...base, ...JSON.parse(readFileSync(STATE_PATH, "utf8")) } : base;
}
export function saveState(s: DevnetState) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

let headerChecked = false;
function ensureLogHeader() {
  if (headerChecked) return;
  headerChecked = true;
  const text = readFileSync(LOG_PATH, "utf8");
  if (!text.includes("## Transactions (devnet wiring lane)")) {
    appendFileSync(
      LOG_PATH,
      "\n## Transactions (devnet wiring lane)\n\nEvery devnet transaction the scripts in `scripts/devnet/` sent, in order. Fee is the network fee in lamports as returned by the RPC.\n\n| When (UTC) | Step | What | Fee | Signature |\n|---|---|---|---|---|\n",
    );
  }
}
export function logTx(step: string, what: string, r: SendResult) {
  ensureLogHeader();
  const when = new Date().toISOString().replace("T", " ").slice(0, 19);
  appendFileSync(LOG_PATH, `| ${when} | ${step} | ${what.replace(/\|/g, "/")} | ${r.fee ?? "?"} | \`${r.signature}\` |\n`);
}

/** Sends, confirms and logs one transaction. */
export async function send(step: string, what: string, payer: Signer, ixs: Ix[], o: SendOptions = {}): Promise<SendResult> {
  try {
    const r = await sendAndConfirm(rpc, payer, ixs, { log: (m) => log(`  ${m}`), ...o });
    logTx(step, what, r);
    log(`${step}: ${what}: ${r.signature}${r.computeUnits ? ` (${r.computeUnits} CU)` : ""}`);
    return r;
  } catch (e) {
    if (e instanceof TxError) {
      console.error(`[devnet] ${step}: ${what} FAILED: ${e.message}`);
      for (const l of e.logs.slice(-25)) console.error(`    ${l}`);
    }
    throw e;
  }
}

/** When `to` holds less than `min` lamports, funds it up to `target` (default `min`) from `from`. */
export async function topUp(step: string, from: Signer, to: string, min: bigint, label: string, target: bigint = min): Promise<string | null> {
  const bal = await rpc.getBalance(to);
  if (bal >= min) return null;
  const amount = target - bal;
  const fromBal = await rpc.getBalance(from.id);
  if (fromBal < amount + 10_000_000n) throw new Error(`${from.id} holds ${sol(fromBal)} SOL, not enough to send ${sol(amount)} to ${label}`);
  const r = await send(step, `fund ${label} ${to} with ${sol(amount)} SOL`, from, [system.transfer(from.id, to, amount)]);
  return r.signature;
}

export function check(name: string, ok: boolean, detail = ""): void {
  console.log(`[devnet] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
