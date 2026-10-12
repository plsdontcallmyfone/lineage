// The page's chain context: the RPC through the dashboard's /chain/rpc proxy, the public
// addresses, and the one transaction pipeline every flow uses (build, simulate, wallet signs, local
// fresh keys co-sign, send, confirm). Nothing is built until the RPC's genesis hash is the network
// profile's (/chain/config `profile`, SPEC 14.10; devnet when the server predates profiles). Devnet
// works exactly as before; mainnet prices compute units from recent prioritization fees (capped by
// config) and confirms with blockhash-expiry aware resends.
import {
  assertCluster,
  DEVNET_PUBLIC_PROFILE,
  priorityFee,
  sendWithRebuilds,
  setExplorerCluster,
  useProfilePrograms,
  writableAccounts,
  type PublicProfile,
  ChainReader,
  compileMessage,
  compileMessageV0,
  computeBudget,
  decodeMessage,
  missingSigners,
  parseWire,
  placeSignature,
  httpTransport,
  Rpc,
  sameBytes,
  sendJitoBundle,
  sendWire,
  base64Encode,
  wireSignature,
  simulateDetailed,
  unsignedWire,
  type Confirmed,
  type Ix,
  type LookupTable,
  type Simulation,
  type WebKey,
} from "../../../packages/chain/src/browser/index.ts";
import { DEVNET_CHAIN, MAINNET_CHAIN, setWalletChain, signTransaction, signTransactions, type StdAccount, type StdWallet } from "./standard.ts";

export interface DevnetPublic {
  registry_program: string;
  launch_program: string;
  line_mint: string;
  line_token_program: string;
  line_decimals: number;
  /** $UNITS's canonical PumpSwap pool and vaults once $UNITS has migrated (pump.fun launches name them) */
  line_pool?: { pool: string; baseVault: string; quoteVault: string };
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
  /** network profile (public view); absent from servers that predate it, read as devnet */
  profile?: PublicProfile;
}

/** The page's network profile: devnet until /chain/config says otherwise. */
export const NET: { p: PublicProfile } = { p: DEVNET_PUBLIC_PROFILE };
export const isMainnet = () => NET.p.network === "mainnet";
/** The quote token's symbol for labels, from the network profile (config, never the coin's on-chain metadata): UNITS. */
export const qsym = () => NET.p.quote.symbol;
/** The quote token as user-facing copy (owner direction 2026-10-11): "$UNITS" on devnet (with a "devnet test tokens, no value" note), the configured quote elsewhere. */
export const usym = () => (NET.p.network === "devnet" ? "$UNITS" : NET.p.quote.symbol);
/** TEST labels are shown only where the profile says so (devnet). */
export const testLabels = () => NET.p.test_labels;
/** The cluster name for copy ("devnet", "mainnet"). */
export const netName = () => (NET.p.network === "devnet" ? "devnet" : "mainnet");

// Busy chain reads (the site gate's 429, an upstream 5xx): retried with backoff (Retry-After when
// given); listeners show a readable line while it lasts, and an exhausted retry ends in a readable
// error, never "undefined" (packages/chain rpcErrorOf handles the gate's string `error`).
const busyListeners = new Set<(s: string | null) => void>();
/** Subscribes to the "chain reads are busy" line (null when a read went through again). */
export function onRpcBusy(fn: (s: string | null) => void): () => void {
  busyListeners.add(fn);
  return () => busyListeners.delete(fn);
}
let busy = false;
const setBusy = (s: string | null) => {
  if (!s && !busy) return;
  busy = !!s;
  for (const fn of busyListeners) fn(s);
};
const pageTransport = httpTransport("/chain/rpc", {
  retries: 5,
  onRetry: (attempt, waitMs) => setBusy(`Chain reads are busy, retrying (${attempt} of 5, in ${Math.ceil(waitMs / 1000)} s)…`),
});
export const rpc = new Rpc(async (method, params) => {
  try {
    const r = await pageTransport(method, params);
    setBusy(null);
    return r;
  } catch (e) {
    setBusy(null);
    throw e;
  }
}, "confirmed");
export const reader = new ChainReader(rpc);

let cfgLoad: Promise<ChainCfg> | null = null;
export async function loadChainCfg(): Promise<ChainCfg> {
  cfgLoad ??= fetch("/chain/config").then(async (r) => {
    if (!r.ok) throw new Error(`/chain/config: HTTP ${r.status}`);
    const c = (await r.json()) as ChainCfg;
    applyProfile(c.profile ?? DEVNET_PUBLIC_PROFILE);
    return c;
  });
  return cfgLoad.catch((e) => {
    cfgLoad = null;
    throw e;
  });
}
function applyProfile(p: PublicProfile) {
  NET.p = p;
  useProfilePrograms(p);
  setExplorerCluster(p.explorer_cluster);
  setWalletChain(p.network === "mainnet" ? MAINNET_CHAIN : DEVNET_CHAIN);
}

/** Checked once per page load and again before every build: the RPC's genesis must be the profile's. */
export async function clusterGate(): Promise<void> {
  await loadChainCfg().catch(() => undefined);
  await assertCluster(rpc, NET.p.genesis);
}
/** The name every flow used before profiles; the same gate. */
export const devnetGate = clusterGate;

export interface Built {
  ixs: Ix[];
  payer: string;
  wire: Uint8Array;
  lastValidBlockHeight: number;
  sim: Simulation;
}

/** The compute budget instructions every transaction of this page starts with (devnet: price 1, as before). */
export const budgetIxs = (units: number, price = 1) => [computeBudget.limit(units), computeBudget.price(price)];
/** The unit price for these instructions under the profile: fixed on devnet, recent fees with the cap on mainnet. */
export async function unitPrice(payer: string, ixs: Ix[]): Promise<number> {
  return (await priorityFee(rpc, writableAccounts(ixs, payer), NET.p.fees)).microLamports;
}
const withBudget = async (payer: string, ixs: Ix[], units: number) => [...budgetIxs(units, await unitPrice(payer, ixs)), ...ixs];

/** Builds and simulates (signatures not verified). Nothing is signed here. */
export async function buildAndSimulate(payer: string, ixs: Ix[], units = 200_000, table?: LookupTable | null): Promise<Built> {
  await clusterGate();
  const all = await withBudget(payer, ixs, units);
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
  await clusterGate();
  const all = await withBudget(o.account.address, o.ixs, o.units ?? 200_000);
  // one signing round: fresh blockhash, wallet signature, local co-signatures
  const signOnce = async () => {
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
    return { wire, lastValidBlockHeight };
  };
  if (o.leaveFor || !isMainnet()) {
    const { wire, lastValidBlockHeight } = await signOnce();
    const missing = missingSigners(wire);
    if (o.leaveFor) {
      if (missing.length !== 1 || missing[0] !== o.leaveFor) throw new Error(`expected only ${o.leaveFor} to be missing, got ${missing.join(", ") || "none"}`);
      return { partial: wire, lastValidBlockHeight };
    }
    if (missing.length) throw new Error(`signatures missing for ${missing.join(", ")}`);
    const confirmed = await sendWire(rpc, wire, lastValidBlockHeight, o.onStatus);
    return { confirmed, lastValidBlockHeight };
  }
  // mainnet: preflighted first send, resends of the same bytes, and on blockhash expiry a fresh signing round (profile confirm.rebuilds)
  let lvbh = 0;
  const landed = await sendWithRebuilds(rpc, async () => {
    const s = await signOnce();
    const missing = missingSigners(s.wire);
    if (missing.length) throw new Error(`signatures missing for ${missing.join(", ")}`);
    lvbh = s.lastValidBlockHeight;
    return s;
  }, NET.p.confirm, { onStatus: o.onStatus });
  return { confirmed: { signature: landed.signature, slot: landed.slot, fee: landed.fee, err: landed.err, logs: landed.logs }, lastValidBlockHeight: lvbh };
}

/** One transaction of a launch bundle: instructions (the compute budget is prepended here) or a prebuilt v0 message's parts. */
export interface BundlePart {
  ixs: Ix[];
  units: number;
  table?: LookupTable | null;
  /** extra lookup tables (a Jupiter swap); the budget is already in `ixs` when `raw` */
  tables?: LookupTable[];
  raw?: boolean;
  local?: WebKey[];
  label: string;
}

/**
 * The whole launch in one approval (owner direction 2026-10-11): every transaction is built on one
 * fresh blockhash and the wallet signs them all in one request. Mainnet sends them as one Jito bundle
 * (all or nothing, in order), and when Jito refuses the bundle or it does not land, the same signed
 * transactions go one by one in order with a clear status line (never sent twice); devnet sends them in order, simulating each before it goes, and stops at
 * the first that would fail or fails, reporting which landed. `skip(i)` is asked right before sending
 * transaction i (devnet): true leaves it out (what it carries is already on chain).
 */
export async function signAndSendAll(o: {
  wallet: StdWallet;
  account: StdAccount;
  parts: BundlePart[];
  onStatus?: (s: string) => void;
  skip?: (i: number) => Promise<boolean>;
}): Promise<{ landed: { label: string; confirmed: Confirmed }[]; failed: { index: number; label: string; error: string; logs?: string[] } | null; bundleId?: string; /** why the mainnet bundle was replaced by ordered sends, when it was */ ordered?: string }> {
  await clusterGate();
  const payer = o.account.address;
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const msgs = [];
  for (const p of o.parts) {
    const all = p.raw ? p.ixs : await withBudget(payer, p.ixs, p.units);
    const tables = p.tables ?? (p.table ? [p.table] : []);
    msgs.push(tables.length ? compileMessageV0(payer, all, blockhash, tables) : compileMessage(payer, all, blockhash));
  }
  o.onStatus?.(`waiting for the wallet to approve ${msgs.length === 1 ? "the transaction" : `all ${msgs.length} transactions at once`}`);
  const signed = await signTransactions(o.wallet, o.account, msgs.map((m) => unsignedWire(m)));
  const wires: Uint8Array[] = [];
  for (const [i, w] of signed.entries()) {
    if (!sameBytes(parseWire(w).message, msgs[i]!.bytes)) throw new Error(`the wallet changed transaction ${i + 1}; nothing was sent`);
    let wire = w;
    for (const k of o.parts[i]!.local ?? []) wire = placeSignature(wire, k.id, await k.sign(msgs[i]!.bytes));
    const missing = missingSigners(wire);
    if (missing.length) throw new Error(`transaction ${i + 1}: signatures missing for ${missing.join(", ")}; nothing was sent`);
    wires.push(wire);
  }
  let ordered: string | undefined;
  if (isMainnet()) {
    try {
      const { bundleId } = await sendJitoBundle(rpc, wires.map((w) => base64Encode(w)), { onStatus: o.onStatus });
      const sigs = wires.map((w) => wireSignature(w));
      const st = await rpc.call<{ value: ({ slot: number; err: unknown } | null)[] }>("getSignatureStatuses", [sigs]);
      return { bundleId, failed: null, landed: sigs.map((signature, i) => ({ label: o.parts[i]!.label, confirmed: { signature, slot: st.value[i]?.slot ?? 0, err: st.value[i]?.err ?? null, logs: [] } })) };
    } catch (e) {
      // The bundle was refused or did not land. The same signed transactions are sent one by one, in order: a
      // transaction that did land is found by its signature and never sent twice. They are then no longer all or
      // nothing, so a failure is reported with what landed before it.
      ordered = (e as Error).message;
      o.onStatus?.(`Jito did not take the bundle (${ordered}). Sending the same signed transactions one by one, in order; if one fails, the ones before it stay on chain and Launch again sends only what is missing.`);
    }
  }
  const landed: { label: string; confirmed: Confirmed }[] = [];
  for (const [i, wire] of wires.entries()) {
    const label = o.parts[i]!.label;
    if (await o.skip?.(i)) continue;
    if (ordered) {
      const [was] = (await rpc.call<{ value: ({ slot: number; err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[wireSignature(wire)]])).value;
      if (was && !was.err && (was.confirmationStatus === "confirmed" || was.confirmationStatus === "finalized")) {
        landed.push({ label, confirmed: { signature: wireSignature(wire), slot: was.slot, err: null, logs: [] } });
        continue;
      }
    }
    if (i > 0) {
      // the earlier transactions have landed: this one can be simulated on the state they left
      const tables = o.parts[i]!.tables ?? (o.parts[i]!.table ? [o.parts[i]!.table!] : []);
      const sim = await simulateDetailed(rpc, wire, new Map(tables.map((t) => [t.address, t.addresses])));
      if (sim.err) return { landed, ordered, failed: { index: i, label, error: `simulation failed: ${JSON.stringify(sim.err)}; not sent`, logs: sim.logs } };
    }
    o.onStatus?.(`sending ${label} (${i + 1} of ${wires.length})${ordered ? ", in order after Jito did not take the bundle" : ""}`);
    const c = await sendWire(rpc, wire, lastValidBlockHeight, o.onStatus).catch((e) => ({ signature: wireSignature(wire), slot: 0, err: (e as Error).message, logs: [] as string[] }) as Confirmed);
    if (c.err) return { landed, ordered, failed: { index: i, label, error: `failed on chain: ${typeof c.err === "string" ? c.err : JSON.stringify(c.err)}`, logs: c.logs } };
    landed.push({ label, confirmed: c });
  }
  return { landed, ordered, failed: null };
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
