// The page's chain context: the devnet RPC through the dashboard's /chain/rpc proxy, the public
// devnet addresses, and the one transaction pipeline every flow uses (build, simulate, wallet
// signs, local fresh keys co-sign, send, confirm). Devnet only: nothing is built until the RPC's
// genesis hash is devnet's.
import {
  assertDevnet,
  ChainReader,
  compileMessage,
  compileMessageV0,
  computeBudget,
  decodeMessage,
  missingSigners,
  parseWire,
  placeSignature,
  Rpc,
  RpcError,
  sameBytes,
  sendWire,
  simulateDetailed,
  unsignedWire,
  type Confirmed,
  type Ix,
  type LookupTable,
  type Simulation,
  type WebKey,
} from "../../../packages/chain/src/browser/index.ts";
import { signTransaction, type StdAccount, type StdWallet } from "./standard.ts";

export interface DevnetPublic {
  registry_program: string;
  launch_program: string;
  line_mint: string;
  line_token_program: string;
  line_decimals: number;
  dbc_config: string;
  [k: string]: unknown;
}
export interface ChainCfg {
  rpc: string;
  rpc_upstream: string;
  genesis: string | null;
  cluster: string;
  devnet: boolean;
  state: DevnetPublic | null;
  faucet: string | null;
}

let id = 0;
export const rpc = new Rpc(async (method, params) => {
  const res = await fetch("/chain/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message: string; code: number; data?: unknown } } | null;
  if (!body) throw new RpcError(`${method}: HTTP ${res.status}`);
  if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code, body.error.data);
  return body.result;
}, "confirmed");
export const reader = new ChainReader(rpc);

export async function loadChainCfg(): Promise<ChainCfg> {
  const r = await fetch("/chain/config");
  if (!r.ok) throw new Error(`/chain/config: HTTP ${r.status}`);
  return r.json();
}

/** Checked once per page load and again before every build. */
export async function devnetGate(): Promise<void> {
  await assertDevnet(rpc);
}

export interface Built {
  ixs: Ix[];
  payer: string;
  wire: Uint8Array;
  lastValidBlockHeight: number;
  sim: Simulation;
}

/** The compute budget instructions every transaction of this page starts with. */
export const budgetIxs = (units: number) => [computeBudget.limit(units), computeBudget.price(1)];
const withBudget = (ixs: Ix[], units: number) => [...budgetIxs(units), ...ixs];

/** Builds and simulates (signatures not verified). Nothing is signed here. */
export async function buildAndSimulate(payer: string, ixs: Ix[], units = 200_000, table?: LookupTable | null): Promise<Built> {
  await devnetGate();
  const all = withBudget(ixs, units);
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const wire = unsignedWire(compile(payer, all, blockhash, table));
  const sim = await simulateDetailed(rpc, wire, table ? new Map([[table.address, table.addresses]]) : undefined);
  return { ixs, payer, wire, lastValidBlockHeight, sim };
}

/** A legacy message, or a v0 message reading `table` (a frozen lookup table checked by the caller; plan C). */
const compile = (payer: string, ixs: Ix[], blockhash: string, table?: LookupTable | null) =>
  table ? compileMessageV0(payer, ixs, blockhash, [table]) : compileMessage(payer, ixs, blockhash);

/**
 * Rebuilds with a fresh blockhash, asks the wallet to sign, adds the signatures of fresh local keys,
 * and (unless `leaveFor` names a signer someone else adds) sends and confirms.
 */
export async function signAndSend(o: {
  wallet: StdWallet;
  account: StdAccount;
  ixs: Ix[];
  units?: number;
  local?: WebKey[];
  leaveFor?: string;
  onStatus?: (s: string) => void;
  /** v0 message reading this lookup table (plan C) */
  table?: LookupTable | null;
}): Promise<{ confirmed?: Confirmed; partial?: Uint8Array; lastValidBlockHeight: number }> {
  await devnetGate();
  const all = withBudget(o.ixs, o.units ?? 200_000);
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const msg = compile(o.account.address, all, blockhash, o.table);
  const unsigned = unsignedWire(msg);
  o.onStatus?.("waiting for the wallet to sign");
  const signed = await signTransaction(o.wallet, o.account, unsigned);
  const back = parseWire(signed);
  if (!sameBytes(back.message, msg.bytes)) {
    // A wallet that rewrites the message (extra instructions) would invalidate the co-signatures and
    // change what was reviewed: refuse rather than sign something else.
    const d = decodeMessage(back.message, o.table ? new Map([[o.table.address, o.table.addresses]]) : undefined);
    throw new Error(`the wallet changed the transaction (${d.instructions.length} instructions, built ${all.length}); nothing was sent`);
  }
  let wire = signed;
  for (const k of o.local ?? []) wire = placeSignature(wire, k.id, await k.sign(msg.bytes));
  const missing = missingSigners(wire);
  if (o.leaveFor) {
    if (missing.length !== 1 || missing[0] !== o.leaveFor) throw new Error(`expected only ${o.leaveFor} to be missing, got ${missing.join(", ") || "none"}`);
    return { partial: wire, lastValidBlockHeight };
  }
  if (missing.length) throw new Error(`signatures missing for ${missing.join(", ")}`);
  const confirmed = await sendWire(rpc, wire, lastValidBlockHeight, o.onStatus);
  return { confirmed, lastValidBlockHeight };
}

// ---------- amounts ----------

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Base units to a decimal string with `decimals`, trailing zeros trimmed to at least `min` places. */
export function units(base: bigint | null | undefined, decimals: number, min = 0): string {
  if (base === null || base === undefined) return "TBA";
  const neg = base < 0n;
  let v = neg ? -base : base;
  const scale = 10n ** BigInt(decimals);
  const i = v / scale;
  let f = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (f.length < min) f = f.padEnd(min, "0");
  return `${neg ? "-" : ""}${group(i.toString())}${f ? "." + f : ""}`;
}
export const sol = (lamports: bigint | null | undefined) => units(lamports, 9, 0);
/** A decimal string typed by a person to base units; null when it is not a positive amount. */
export function parseUnits(s: string, decimals: number): bigint | null {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [i, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  const v = BigInt(i!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
  return v > 0n ? v : null;
}
