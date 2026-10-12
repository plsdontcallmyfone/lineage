#!/usr/bin/env bun
// OFFICIAL go-live, single key (docs/MAINNET-RUNBOOK.md "Go-live (single key, today)"; owner decisions
// 2026-10-12: no multisig today, the dev wallet is admin and upgrade authority of everything and the
// recipient wherever a wallet is configurable; it creates $UNITS on pump.fun itself, and that is the
// owner's last manual action). Everything after the coin exists is this command sequence. Each step
// reads chain state first and skips what exists, so a stopped run resumes by running the same command
// again. Every step is DRY unless --send is given: it prints each transaction it would send, its size,
// its simulation when the chain state allows one, and the cost measured on the mainnet fork
// (GOLIVE-FORK-LAST.json). No key and no endpoint is ever printed; a dry run loads no key at all.
//
//   UNITS_NETWORK=mainnet bun scripts/mainnet/golive.ts <step> [options]
//
//   pre         BEFORE the coin exists (run it now, as often as wanted): the checks that need no mint account, and with
//               --send the two things that need none either: units_msg initialize and the launch lookup table (it
//               stores addresses only: the mint's address is known, every other entry is a fixed address or derived
//               from it). Writes <out>/pre.json
//   watch       waits for the mint account to appear as a SOL-paired pump.fun coin, then runs the post-coin preflight,
//               init and bond back to back (the two transactions in parallel) and, with --run-site, the server-side
//               registrations and the activation; one log line per step with its time; stops on the first failure
//               and prints the command that resumes. Needs --send
//   preflight   (post-coin) read only: the endpoint, the three programs against the builds, the upgrade authority, nothing
//               initialized (or initialized by this sequence), the $UNITS mint (pump.fun coin paired with SOL, not
//               mayhem, depth 0, Token-2022, 6 decimals), pump.fun Global.max_curve_depth, every wallet's balance, the
//               hot keys, the price against the band, the site. Refuses on any failure; writes golive-ready.json
//   params      read only: every official value, the dollar values turned into $UNITS at the live price
//   init        registry, launch and messages with admin = the dev wallet, the compute sink, the launch lookup
//               table, bounty and challenge configs, the slash cap; writes <out>/chain.json
//   bond        the $UNITS the verifiers need (what the dev wallet holds first, the shortfall bought on $UNITS's
//               curve with a slippage cap) and SOL, sent to the site's verifier owner key; then prints (or with
//               --run-site runs) the server-side registrations and bonds
//   switch      writes the instance's state file and profile overlay at the live price into <out>; prints the
//               change to config/profile.json and the deploy commands. --apply-config writes config/profile.json
//               and config/mainnet/state.json, --commit commits exactly those two files. --rate-only: the price
//               dependent values again. --rollback: config/profile.json back to the test deployment
//   status      read only: everything after go-live in one screen
//   retune      set_config on registry and launch with the dollar values resolved again at today's price
//
// Options: --mint <address> (default: official-params.json units_mint; a stand-in on the fork), --rpc <url>
// (default the local fork 127.0.0.1:9690; with --mainnet the keyed endpoint), --mainnet (required on a mainnet
// endpoint), --send (send; on mainnet also needs a READY preflight of the last 60 minutes for this mint),
// --admin-key <file> (default ~/.config/units/mainnet/official-deployer.keypair.json; read only with --send),
// --params <file>, --out <dir> (default ~/.config/units/mainnet/official), --build-dir <dir>, --site <url>,
// --no-site, --no-identity, --priority-micro-lamports <n>, --log <jsonl>, --allow-creator <address> and
// --unconfirmed-ok (fork only), --lookup-table <address>, --new-table, --sequential (init as nine separate
// transactions, the path the test deployment used), --bond-from-dev-wallet (never buy: the dev wallet must hold
// the $UNITS, bought with the coin's creation), --wait-s <n> (how long bond or watch wait for those coins),
// --chain-cmd / --go-cmd <shell command> (what watch runs for the server-side steps; default instance.sh).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ata,
  ChainReader,
  compileMessage,
  computeBudget,
  curveMigrated,
  decodeBondingCurve,
  decodeLoaderAuthority,
  decodeLookupTable,
  decodePumpGlobal,
  decodePumpPool,
  launch,
  launchTableAddresses,
  loadKeypair,
  lookupTable,
  msg,
  msgPdas,
  programDataAddress,
  PUMP,
  pumpPdas,
  readJupiterUsd,
  readMsgConfig,
  readQuotePair,
  registry,
  registryPdas,
  Rpc,
  sendAndConfirm,
  setDefaultFeePolicy,
  system,
  token,
  TOKEN_2022_PROGRAM,
  TxError,
  signMessageWith,
  wireSize,
  type Ix,
  type SendResult,
  type Signer,
} from "@units/chain";
import { rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { adminActions } from "./admin.ts";
import { checkEndpoint, computeSink, launchArgs, parseLaunchParams, programIdsNow, registryArgs, useActiveProfile, type Loaded } from "./steps.ts";
import { checkTest, initializeTest } from "./test-steps.ts";
import {
  assertDevWalletUnits, DEV_WALLET_UNITS_CEILING_WHOLE, devTransferDecision, loadOfficialParams, nextPostNotBefore, officialOverlay, officialState, resolveOfficial, rolledBackProfileJson, switchedProfileJson, unitsPerUsd, verifierNeed,
  type ChainFacts, type DevTransferMarker, type OfficialParams, type Resolved, type UnitsPrice,
} from "./golive-steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const FORK = "http://127.0.0.1:9690";
const SOL_QUOTE = "11111111111111111111111111111111";
const T22 = TOKEN_2022_PROGRAM;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const has = (n: string) => argv.includes(n);

const profile = useActiveProfile(); // UNITS_NETWORK=mainnet: the OFFICIAL program ids, whatever config/profile.json selects for the app
if (profile.network !== "mainnet") throw new Error("run with UNITS_NETWORK=mainnet: go-live uses the mainnet profile's official program ids");
const IDS = programIdsNow();
const P0: OfficialParams = loadOfficialParams(flag("--params") ?? join(import.meta.dir, "official-params.json"));
const OUT = flag("--out") ?? join(homedir(), ".config", "units", "mainnet", "official");
const BUILD = flag("--build-dir") ?? join(ROOT, "onchain", "target", "mainnet");
const ADMIN_KEY = flag("--admin-key") ?? join(homedir(), ".config", "units", "mainnet", "official-deployer.keypair.json");
const rpcUrl = flag("--rpc") ?? (has("--mainnet") ? rpcUrlFor(profile) : FORK);
const local = rpcUrl.startsWith("http://127.0.0.1:");
const rpc = Rpc.http(rpcUrl, "confirmed");
const reader = new ChainReader(rpc);
const SEND = has("--send");
const price = flag("--priority-micro-lamports") ? Number(flag("--priority-micro-lamports")) : undefined;
if (price !== undefined && (!Number.isInteger(price) || price < 0)) throw new Error("--priority-micro-lamports must be a whole number");
const LOG = flag("--log");
const SITE = has("--no-site") ? null : (flag("--site") ?? (JSON.parse(readFileSync(join(ROOT, "config/sites.json"), "utf8")).mainnet_site_url as string));
const READY = join(OUT, "golive-ready.json");
const FORK_RECORD = join(import.meta.dir, "GOLIVE-FORK-LAST.json");

/** Removes the endpoint and anything key-like in it from text that is about to be printed. */
const scrub = (() => {
  const parts = [rpcUrl];
  try {
    const u = new URL(rpcUrl);
    if (!local) parts.push(u.host, ...[...u.searchParams.values()], ...u.pathname.split("/"), u.username, u.password);
  } catch { /* not a URL */ }
  const sorted = [...new Set(parts)].filter((p) => p.length >= 8).sort((a, b) => b.length - a.length);
  return (s: string) => (local ? s : sorted.reduce((acc, p) => acc.split(p).join("[redacted]"), s));
})();
const say = (m: string) => console.log(`[golive] ${scrub(m)}`);
const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(9)} SOL`;
const units = (b: bigint, d = P0.line_decimals) => `${(Number(b) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: 6 })} UNITS`;
const lamports = (s: string) => {
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error(`${s} is not a SOL amount`);
  const [i, f = ""] = s.split(".");
  return BigInt(i!) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const trimZeros = (b: Uint8Array) => {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return b.subarray(0, n);
};
const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const note = (m: string) => say(`     ${m}`);

// ---------------------------------------------------------------- the endpoint and the mint
const genesis = await checkEndpoint(rpc, profile, { deployed: false, local });
const isMainnet = genesis === MAINNET_GENESIS;
if (isMainnet && !has("--mainnet")) throw new Error("mainnet endpoint: pass --mainnet to confirm");
if (!isMainnet && has("--mainnet")) throw new Error("--mainnet was passed but the endpoint is not mainnet");
if (isMainnet && (has("--allow-creator") || has("--unconfirmed-ok"))) throw new Error("--allow-creator and --unconfirmed-ok are for the fork only");
const priorChain = (): (ChainFacts & { registry_program?: string }) | null => (existsSync(join(OUT, "chain.json")) ? JSON.parse(readFileSync(join(OUT, "chain.json"), "utf8")) : null);
const priorPre = (): { mint: string; launch_lookup_table: string } | null => (existsSync(join(OUT, "pre.json")) ? JSON.parse(readFileSync(join(OUT, "pre.json"), "utf8")) : null);
const MINT = flag("--mint") ?? P0.units_mint;
if (isMainnet && MINT !== P0.units_mint) throw new Error("on mainnet the mint is official-params.json units_mint; --mint is for the fork's stand-in");
if (priorChain() && priorChain()!.mint !== MINT) throw new Error(`${OUT}/chain.json was written for another mint (${priorChain()!.mint}): use another --out for this one`);
say(`${isMainnet ? "MAINNET" : "not mainnet (a fork)"}: registry ${IDS.registry}, launch ${IDS.launch}, msg ${IDS.msg}; $UNITS ${MINT}; ${SEND ? "SENDING" : "dry run (nothing is signed or sent)"}`);
const ADMIN = P0.admin;
if (priorPre() && priorPre()!.mint !== MINT) throw new Error(`${OUT}/pre.json was written for another mint: use another --out for this one`);
// mainnet sends: a priority fee from recent fees, capped by the profile (config/profile.json fees), unless one is given
if (isMainnet && price === undefined && profile.fees.mode === "recent") setDefaultFeePolicy(profile.fees, profile.confirm);
const knownTable = () => (has("--new-table") ? undefined : (flag("--lookup-table") ?? priorChain()?.launch_lookup_table ?? priorPre()?.launch_lookup_table));
const T0 = Date.now();
const lap = (step: string, since: number) => say(`TIME ${step}: ${((Date.now() - since) / 1000).toFixed(1)} s (${((Date.now() - T0) / 1000).toFixed(1)} s since start)`);

function adminSigner(): Signer {
  const k = loadKeypair(ADMIN_KEY);
  if (k.id !== ADMIN) throw new Error("the admin key file is not the admin wallet of official-params.json");
  return k;
}
function requireReady() {
  if (!SEND) return;
  if (!isMainnet) return;
  if (!existsSync(READY)) throw new Error("no READY preflight: run `golive.ts preflight --mainnet` first");
  const r = JSON.parse(readFileSync(READY, "utf8")) as { at: string; mint: string; admin: string; genesis: string; builds: Record<string, string> };
  if (Date.now() - Date.parse(r.at) > 3600_000) throw new Error("the READY preflight is older than 60 minutes: run preflight again");
  if (r.mint !== MINT || r.admin !== ADMIN || r.genesis !== genesis) throw new Error("the READY preflight was for another mint, admin or endpoint");
  for (const n of ["registry", "launch", "msg"] as const) if (r.builds[n] !== sha(readFileSync(join(BUILD, `units_${n}.so`)))) throw new Error(`${n}: the build changed since the READY preflight`);
}

// ---------------------------------------------------------------- transactions: dry or sent
const forkCosts: { what: string; bytes: number | null; compute_units: number | null; payer_mainnet_lamports: string }[] =
  existsSync(FORK_RECORD) ? (JSON.parse(readFileSync(FORK_RECORD, "utf8")).transactions ?? []) : [];
/** The fork's measurement of the transaction whose description starts the same way. */
const measured = (what: string) => {
  const key = what.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "").replace(/\d[\d,.]*/g, "").slice(0, 28);
  return forkCosts.find((r) => r.what.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "").replace(/\d[\d,.]*/g, "").slice(0, 28) === key) ?? null;
};
let planned = 0;
type Opts = { signers?: Signer[]; computeUnits?: number; coSigners?: string[] };
/** Sends (with --send) or describes a transaction. `payer` is an address in a dry run, so no key is read. */
async function tx(what: string, payer: string, ixs: Ix[], o: Opts = {}): Promise<SendResult | null> {
  const units_ = o.computeUnits ?? (price ? 400_000 : undefined);
  const all = [...(units_ ? [computeBudget.limit(units_)] : []), ...(price ? [computeBudget.price(price)] : []), ...ixs];
  const { blockhash } = await rpc.getLatestBlockhash();
  const m = compileMessage(payer, all, blockhash);
  const bytes = wireSize({ bytes: m.bytes, numSigners: m.numSigners });
  // the owner's rule on the dev wallet's own $UNITS, checked on these very instructions before anything is signed:
  // this path (every transaction but the one transfer, which goes through sendDevTransfer) may not move any
  if (assertDevWalletUnits(all, devGuard()) !== 0n) throw new Error("refused: only the one guarded transfer may move the dev wallet's $UNITS");
  if (!SEND) {
    planned++;
    // an unsigned wire (zero signatures): simulateTransaction runs with sigVerify off, so nothing is ever signed in a dry run
    const wire = new Uint8Array(1 + 64 * m.numSigners + m.bytes.length);
    wire[0] = m.numSigners;
    wire.set(m.bytes, 1 + 64 * m.numSigners);
    const sim = await rpc.simulate(wire).catch((e) => ({ err: (e as Error).message, logs: null, unitsConsumed: undefined }));
    const f = measured(what);
    say(`WOULD SEND ${what}`);
    note(`${bytes} bytes, ${m.numSigners} signature${m.numSigners > 1 ? "s" : ""}, base fee ${5_000 * m.numSigners} lamports; simulation now: ${sim.err ? `not possible yet (${JSON.stringify(sim.err).slice(0, 90)}; it follows an earlier transaction of this step)` : `ok, ${sim.unitsConsumed ?? "?"} CU`}`);
    note(f ? `measured on the fork: ${f.compute_units ?? "?"} CU, costs the payer ${sol(BigInt(f.payer_mainnet_lamports))} at mainnet rent` : "no fork measurement recorded for this transaction");
    return null;
  }
  try {
    const key = adminSigner();
    if (payer !== key.id) throw new Error(`this step's payer ${payer} is not the admin key`);
    const r = await sendAndConfirm(rpc, key, ixs, { signers: o.signers, priorityMicroLamports: price, computeUnits: units_ });
    say(`${what}: ${r.signature} (${bytes} bytes, fee ${r.fee}, ${r.computeUnits ?? "?"} CU)`);
    if (LOG) appendFileSync(LOG, JSON.stringify({ cmd, what, signature: r.signature, payer, bytes }) + "\n");
    return r;
  } catch (e) {
    if (e instanceof TxError) for (const l of e.logs.slice(-15)) console.error(`    ${scrub(l)}`);
    throw new Error(scrub((e as Error).message));
  }
}

const devGuard = () => ({ devWallet: ADMIN, devUnitsAccount: ata(ADMIN, MINT, T22), mint: MINT, decimals: P0.line_decimals, destination: ata(P0.site.verifier_owner, MINT, T22) });
const MARKER = () => join(OUT, "dev-wallet-transfer.json");
const readMarker = (): DevTransferMarker | null => (existsSync(MARKER()) ? JSON.parse(readFileSync(MARKER(), "utf8")) : null);
/** What the chain says about the marker's transaction: landed, still able to land, or dead (its blockhash expired unlanded). */
async function markerState(mk: DevTransferMarker | null): Promise<"none" | "landed" | "pending" | "expired"> {
  if (!mk) return "none";
  const [st] = await rpc.getSignatureStatuses([mk.signature]);
  if (st && !st.err) return "landed";
  if (st?.err) return "expired"; // it failed on chain: nothing moved
  return (await rpc.getBlockHeight()) > mk.last_valid_block_height + 5 ? "expired" : "pending";
}
/**
 * The one transfer of the dev wallet's $UNITS: the verifiers' coins (at most 5,000,000, a constant) and,
 * when the owner key lacks it, its SOL. Signed ONCE; the signature is written to the marker file before
 * the bytes are sent, and only those bytes are ever sent, so a stop at any point cannot produce a second
 * transfer: a re-run reads the marker and the chain (devTransferDecision).
 */
async function sendDevTransfer(amount: bigint, solToOwner: bigint): Promise<void> {
  const owner = P0.site.verifier_owner;
  const ixs: Ix[] = [computeBudget.limit(100_000), ...(price ? [computeBudget.price(price)] : []), token.createAtaIdempotent(ADMIN, owner, MINT, T22),
    token.transferChecked(ata(ADMIN, MINT, T22), MINT, ata(owner, MINT, T22), ADMIN, amount, P0.line_decimals, T22), ...(solToOwner > 0n ? [system.transfer(ADMIN, owner, solToOwner)] : [])];
  const moved = assertDevWalletUnits(ixs, devGuard());
  if (moved !== amount || amount > DEV_WALLET_UNITS_CEILING_WHOLE * 10n ** BigInt(P0.line_decimals)) throw new Error("refused: the built transfer is not the one allowed");
  const what = `the one transfer from the dev wallet: ${units(amount)} to the verifier owner key${solToOwner > 0n ? ` and ${sol(solToOwner)}` : ""}`;
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const m = compileMessage(ADMIN, ixs, blockhash);
  const bytes = wireSize({ bytes: m.bytes, numSigners: m.numSigners });
  if (!SEND) {
    planned++;
    const wire = new Uint8Array(1 + 64 * m.numSigners + m.bytes.length);
    wire[0] = m.numSigners;
    wire.set(m.bytes, 1 + 64 * m.numSigners);
    const sim = await rpc.simulate(wire).catch((e) => ({ err: (e as Error).message, logs: null, unitsConsumed: undefined }));
    const f = measured(what);
    say(`WOULD SEND ${what}`);
    note(`${bytes} bytes; simulation now: ${sim.err ? `not possible yet (${JSON.stringify(sim.err).slice(0, 90)})` : `ok, ${sim.unitsConsumed ?? "?"} CU`}${f ? `; measured on the fork: ${f.compute_units} CU, ${sol(BigInt(f.payer_mainnet_lamports))}` : ""}`);
    return;
  }
  const signed = signMessageWith(m, [adminSigner()]);
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  // the marker first: from here on a re-run knows a transfer exists, whatever happens to this process
  writeFileSync(MARKER(), JSON.stringify({ mint: MINT, amount: amount.toString(), destination: ata(owner, MINT, T22), signature: signed.signature, last_valid_block_height: lastValidBlockHeight, at: new Date().toISOString() } satisfies DevTransferMarker, null, 2) + "\n");
  const sim = await rpc.simulate(signed.wire);
  if (sim.err) throw new Error(`the transfer's simulation failed (nothing sent; the marker's signature can never land): ${JSON.stringify(sim.err)}`);
  for (;;) {
    await rpc.sendRawTransaction(signed.wire, true).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 700));
    const [st] = await rpc.getSignatureStatuses([signed.signature]);
    if (st?.err) throw new Error(`the transfer failed on chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if ((await rpc.getBlockHeight()) > lastValidBlockHeight + 5) throw new Error("the transfer did not land before its blockhash expired; run the step again (it checks the chain first and never sends twice)");
  }
  writeFileSync(MARKER(), JSON.stringify({ ...readMarker()!, confirmed: true }, null, 2) + "\n");
  say(`${what}: ${signed.signature} (${bytes} bytes)`);
  if (LOG) appendFileSync(LOG, JSON.stringify({ cmd, what, signature: signed.signature, payer: ADMIN, bytes }) + "\n");
}
/** Decides and, when allowed, sends the one transfer. `need` in base units for every burn and bond of the file. */
async function fundOwnerOnce(need: bigint, received: bigint, waitS: number, workLeft = true): Promise<void> {
  const owner = P0.site.verifier_owner;
  const mk = readMarker();
  if (mk && (mk.mint !== MINT || mk.destination !== ata(owner, MINT, T22))) throw new Error(`${MARKER()} is for another mint or destination: not touching it`);
  let state = await markerState(mk);
  for (const until = Date.now() + 90_000; state === "pending" && Date.now() < until;) { await new Promise((r) => setTimeout(r, 1500)); state = await markerState(mk); }
  if (state === "landed") received = await receivedByOwner();
  const d = devTransferDecision({ need, received, decimals: P0.line_decimals, marker: mk, markerState: state });
  const ownerSol = await rpc.getBalance(owner);
  // SOL only while registrations or bonds are still to be sent by that key (it spends it as it goes)
  const solToOwner = workLeft && lamports(P0.bond.owner_sol) > ownerSol ? lamports(P0.bond.owner_sol) - ownerSol : 0n;
  if (d.action === "done") {
    say(`the verifier owner key has its coins (${d.why})`);
    if (solToOwner > 0n) await tx(`SOL to the verifier owner key for its fees and the agent records' rent: ${sol(solToOwner)}`, ADMIN, [system.transfer(ADMIN, owner, solToOwner)]);
    return;
  }
  if (d.action !== "send") throw new Error(d.why);
  // the coins come from the dev wallet's own holdings (bought with the coin's creation): wait for them, never buy
  const until = Date.now() + waitS * 1000;
  let have = (await reader.tokenBalance(ata(ADMIN, MINT, T22))) ?? 0n;
  while (have < d.amount && SEND && Date.now() < until) { await new Promise((r) => setTimeout(r, 400)); have = (await reader.tokenBalance(ata(ADMIN, MINT, T22))) ?? 0n; }
  say(`the dev wallet holds ${units(have)}; this takes ${units(d.amount)} (the ceiling is ${DEV_WALLET_UNITS_CEILING_WHOLE.toLocaleString("en-US")} UNITS, a constant) and leaves ${units(have > d.amount ? have - d.amount : 0n)}`);
  if (have < d.amount) {
    if (SEND) throw new Error(`the dev wallet holds ${units(have)}, the verifiers need ${units(d.amount)}: nothing was sent. The tooling never buys; once the dev wallet holds the coins, run this step again`);
    say("NOTE the dev wallet does not hold the coins yet: --send would stop here");
  }
  await sendDevTransfer(d.amount, solToOwner);
}
/** Everything the verifier owner key ever received for its verifiers: its balance plus what they burned and bonded. */
async function receivedByOwner(): Promise<bigint> {
  const owner = P0.site.verifier_owner;
  const mine = (await reader.registryConfig().catch(() => null)) ? (await reader.agents()).filter((a) => a.owner === owner && a.kind === "verifier") : [];
  return ((await reader.tokenBalance(ata(owner, MINT, T22))) ?? 0n) + mine.reduce((x, a) => x + a.burned + a.bond + a.unbondAmount, 0n);
}

// ---------------------------------------------------------------- reads
async function programCode(id: string) {
  const pd = await rpc.getAccountInfo(programDataAddress(id));
  return pd ? { code: trimZeros(pd.data.subarray(45)), authority: decodeLoaderAuthority(pd.data), bytes: pd.data.length } : null;
}
async function curveOf(mint: string) {
  const a = await rpc.getAccountInfo(pumpPdas.bondingCurve(mint));
  return a && a.owner === PUMP.program ? decodeBondingCurve(a.data) : null;
}
/** $UNITS in US dollars now: its own pump.fun market (curve, or pool after migration) times SOL/USD from Jupiter. The same two sources as the indexer (packages/indexer usd.ts). */
/**
 * SOL in US dollars from Jupiter Price API V3, read at most once in 90 s by this process and retried when Jupiter
 * throttles (the keyless API answered HTTP 429 on the fork proof when three steps asked within a second). `watch`
 * keeps it fresh while it waits, so nothing after the coin appears depends on Jupiter answering at that moment.
 */
let solUsdCache: { usd: number; block: number; at: number } | null = null;
async function solUsd(): Promise<{ usd: number; block: number }> {
  if (solUsdCache && Date.now() - solUsdCache.at < 90_000) return solUsdCache;
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const j = await readJupiterUsd(fetch, PUMP.wsol);
      if (!(j.usd > 1e-9 && j.usd < 1e7)) throw new Error("Jupiter's SOL price is outside the accepted band");
      solUsdCache = { ...j, at: Date.now() };
      return solUsdCache;
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last instanceof Error ? last : new Error("no SOL price");
}
async function livePrice(): Promise<UnitsPrice> {
  const pair = await readQuotePair(rpc, MINT, P0.line_decimals);
  if (pair.pairMint !== PUMP.wsol) throw new Error("$UNITS is not paired with SOL");
  const j = await solUsd();
  return { usd_per_units: pair.pairPerQuote * j.usd, sol_usd: j.usd, sol_per_units: pair.pairPerQuote, venue: pair.venue, read_at: new Date().toISOString() };
}
const inBand = (p: UnitsPrice) => p.usd_per_units >= P0.owner_decision.price_band.min_usd && p.usd_per_units <= P0.owner_decision.price_band.max_usd;
const priceLine = (p: UnitsPrice) => `${p.usd_per_units.toPrecision(4)} USD per UNITS (${p.sol_per_units.toPrecision(4)} SOL on its ${p.venue}, SOL at ${p.sol_usd.toFixed(2)} USD from Jupiter, read ${p.read_at})`;

/** The resolved on-chain values: the saved resolution for this mint (a resume uses the same numbers), else a new one at the live price. */
async function resolved(o: { fresh?: boolean } = {}): Promise<{ r: Resolved; P: Loaded; saved: boolean }> {
  const f = join(OUT, "official-resolved.json"), nf = join(OUT, "official-network.json");
  const prior = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Resolved) : null;
  const usePrior = !!prior && prior.mint === MINT && !o.fresh;
  const r = usePrior ? prior! : resolveOfficial(P0, MINT, await livePrice(), nf);
  if (!usePrior && !inBand(r.price)) throw new Error(`the $UNITS price ${r.price.usd_per_units} USD is outside the band ${P0.owner_decision.price_band.min_usd} to ${P0.owner_decision.price_band.max_usd} of official-params.json`);
  // parseLaunchParams reads the network file from disk: written beside the resolution (public values only)
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  writeFileSync(nf, JSON.stringify(r.network, null, 2) + "\n");
  const lineCurve = await curveOf(MINT);
  let line_pool: Loaded["line_pool"];
  if (lineCurve && curveMigrated(lineCurve)) {
    const pool = pumpPdas.pool(MINT, PUMP.wsol);
    const pa = await rpc.getAccountInfo(pool);
    if (pa) { const d = decodePumpPool(pa.data); line_pool = { pool, baseVault: d.poolBaseTokenAccount, quoteVault: d.poolQuoteTokenAccount }; }
  }
  const P = parseLaunchParams({ ...r.launch_params, network_file: nf, ...(line_pool ? { line_pool } : {}) });
  return { r, P, saved: usePrior };
}
const saveResolved = (r: Resolved) => writeFileSync(join(OUT, "official-resolved.json"), JSON.stringify(r, null, 2) + "\n");

function showParams(r: Resolved, P: Loaded) {
  const o = P0.owner_decision, p = P.params;
  say(`price used: ${priceLine(r.price)}`);
  const usd = (b: bigint) => `${((Number(b) / 1e6) * r.price.usd_per_units).toPrecision(3)} USD at that price`;
  const rows: [string, string][] = [
    ["admin, treasury, compute sink owner", ADMIN],
    ["Core authority / runtime authority", `${P0.core_authority} / ${P0.runtime_authority}`],
    ["fee split", `${P0.fee_split.agent_compute_bps} bps compute, ${P0.fee_split.protocol_bps} bps protocol`],
    ["register_burn", `${units(p.registerBurn)} (${usd(p.registerBurn)})`],
    ["min_bond / bond_cap", `${units(p.minBond)} / ${units(p.bondCap)} (${usd(p.minBond)})`],
    ["unbond_cooldown_s / on-chain epoch_length_s", `${p.unbondCooldownS} / ${p.epochLengthS}`],
    ["slashes: canary / minority / reveal / cap per epoch", `${p.canarySlashBps} / ${p.minoritySlashBps} / ${p.revealSlashBps} / ${o.max_slash_bps_per_epoch} bps, strike limit ${p.strikeLimit}`],
    ["reserve / pool", `${p.reserveBps} / ${p.poolBps} bps`],
    ["rebate_per_class / max_rebate_per_epoch", `${units(p.rebatePerClass)} / ${units(P.max_rebate_per_epoch)}`],
    ["challenge: window, bond, reward, resolve timeout", `${P.challenge.windowS} s, ${units(P.challenge.bond)}, ${units(P.challenge.reward)}, ${P.challenge.resolveTimeoutS} s`],
    ["bounty: min amount, self-hosted in cap", `${units(P.bounty.minAmount)}, ${units(P.bounty.selfHostedInCap)}`],
    ...r.resolved_usd.map((x): [string, string] => [x.key, `${x.usd} USD = ${units(BigInt(x.units) * 1_000_000n)}`]),
    ["pump_creator_fee_bps", `${P.pump_creator_fee_bps}`],
    ["credits at launch", `${o.credits_min_usd} USD = ${units(BigInt(unitsPerUsd(r.price.usd_per_units)) * BigInt(Math.round(Number(o.credits_min_usd) * 100)) * 10_000n)} at this price (set at switch)`],
    ["runtime price band / max age", `${o.price_band.min_usd} to ${o.price_band.max_usd} USD per UNITS, ${o.price_band.max_age_s} s`],
  ];
  for (const [k, v] of rows) say(`  ${k.padEnd(52)} ${v}`);
}

// ---------------------------------------------------------------- preflight
async function preflight() {
  check(`the endpoint is ${isMainnet ? "mainnet" : "a local fork of mainnet (not mainnet)"}`, isMainnet || local, genesis);
  check("official-params.json: the owner confirmed the values (owner_confirmed true)", P0.owner_confirmed || (!isMainnet && has("--unconfirmed-ok")), P0.owner_confirmed ? "" : "still false: every value under owner_decision is a proposal");
  const builds: Record<string, string> = {};
  for (const n of ["registry", "launch", "msg"] as const) {
    const so = readFileSync(join(BUILD, `units_${n}.so`));
    builds[n] = sha(so);
    const acct = await rpc.getAccountInfo(IDS[n]), c = await programCode(IDS[n]);
    check(`${n}: deployed at ${IDS[n]}, byte-identical to the build, upgrade authority = the dev wallet`, !!acct?.executable && !!c && sha(c.code) === sha(trimZeros(so)) && c.authority === ADMIN,
      c ? `sha256 ${sha(so).slice(0, 16)}..., ProgramData ${c.bytes} bytes, authority ${c.authority}` : "no program");
  }
  const rc = await reader.registryConfig().catch(() => null), lc = await reader.launchConfig().catch(() => null), mc = await readMsgConfig(rpc).catch(() => null);
  const ours = (!rc || (rc.admin === ADMIN && rc.mint === MINT)) && (!lc || (lc.admin === ADMIN && lc.lineMint === MINT)) && (!mc || mc.admin === ADMIN);
  check("registry, launch and messages: not initialized, or initialized by this sequence (admin = the dev wallet, mint = $UNITS)", ours,
    `registry ${rc ? `admin ${rc.admin}, mint ${rc.mint}` : "not initialized"}; launch ${lc ? `admin ${lc.admin}` : "not initialized"}; messages ${mc ? `admin ${mc.admin}` : "not initialized"}`);
  // the coin
  const m = await reader.mint(MINT);
  check("$UNITS exists: a Token-2022 mint with 6 decimals, no mint authority and no freeze authority", !!m && m.tokenProgram === T22 && m.decimals === P0.line_decimals && m.mintAuthority === null && m.freezeAuthority === null,
    m ? `token program ${m.tokenProgram}, decimals ${m.decimals}, supply ${m.supply}` : "no account at this address: not created yet");
  const c = await curveOf(MINT);
  check("$UNITS is a pump.fun coin (it has a bonding curve owned by Pump)", !!c, c ? `creator ${c.creator}` : "no bonding curve");
  if (c) {
    check("$UNITS is paired with SOL", c.quoteMint === SOL_QUOTE, c.quoteMint === SOL_QUOTE ? "SOL" : c.quoteMint);
    check("$UNITS is not itself quoted in a pump coin (curve depth 0)", c.depth === 0, `${c.depth}`);
    check("$UNITS is not mayhem mode", !c.isMayhemMode);
    const creatorOk = c.creator === ADMIN || c.creator === flag("--allow-creator");
    check("$UNITS was created by the dev wallet (its creator fees go there; the fee keeper needs it)", creatorOk, c.creator);
    if (curveMigrated(c)) {
      const pa = await rpc.getAccountInfo(pumpPdas.pool(MINT, PUMP.wsol));
      check("$UNITS has migrated to PumpSwap and its canonical pool exists (the launch table will name it; `bond` cannot buy on the curve: the dev wallet must already hold the $UNITS)", !!pa, pumpPdas.pool(MINT, PUMP.wsol));
    } else check("$UNITS trades on its bonding curve (not complete and awaiting migration)", !c.complete, `real reserves ${sol(c.realQuoteReserves)}, ${units(c.realTokenReserves)} left on the curve`);
  }
  const g = decodePumpGlobal((await rpc.getAccountInfo(PUMP.global))!.data);
  check("pump.fun Global.max_curve_depth is 1 or more (a coin can be quoted in $UNITS)", g.maxCurveDepth >= 1, `${g.maxCurveDepth}`);
  // the price
  let p: UnitsPrice | null = null;
  try { p = await livePrice(); } catch (e) { check("the $UNITS price can be read (its pump.fun market and Jupiter's SOL price)", false, (e as Error).message); }
  if (p) check("the $UNITS price is inside the band of official-params.json", inBand(p), priceLine(p));
  // wallets
  const bal = async (a: string) => rpc.getBalance(a);
  const tok = async (owner: string) => (await reader.tokenBalance(ata(owner, MINT, T22))) ?? 0n;
  const adminSol = await bal(ADMIN);
  const initCost = forkCosts.filter((r) => /^(units_|compute sink|launch lookup table|set_)/.test(r.what)).reduce((a, r) => a + BigInt(r.payer_mainnet_lamports), 0n);
  let bondNeed: Awaited<ReturnType<typeof bondPlan>> | null = null;
  if (c && m) bondNeed = await bondPlan(rc ? null : (await resolved({ fresh: !existsSync(join(OUT, "official-resolved.json")) }).catch(() => null))?.P ?? null).catch((e) => { note(`bond plan not computed: ${(e as Error).message}`); return null; });
  const ownerSolShort = bondNeed && lamports(P0.bond.owner_sol) > bondNeed.ownerSol ? lamports(P0.bond.owner_sol) - bondNeed.ownerSol : 0n;
  const needSol = initCost + ownerSolShort + 10_000_000n;
  check("the dev wallet holds the SOL this sequence needs", adminSol >= needSol && adminSol > 0n,
    `${sol(adminSol)} held; needs ${sol(needSol)} = init ${initCost ? sol(initCost) : "(no fork record)"} + ${sol(ownerSolShort)} to the verifier owner key + 0.01 SOL for fees and token accounts`);
  if (bondNeed) {
    const take = bondNeed.received >= bondNeed.total.units ? 0n : bondNeed.total.units, held = await tok(ADMIN), ceiling = DEV_WALLET_UNITS_CEILING_WHOLE * 10n ** BigInt(P0.line_decimals);
    check("the verifiers' coins fit the owner's ceiling: at most 5,000,000 $UNITS leave the dev wallet, once", bondNeed.total.units <= ceiling, `${units(bondNeed.total.units)} needed`);
    // not a failure when the coins are not there yet (a creation buy may still be landing): bond and watch wait for them and never buy
    say(`${held >= take ? "PASS" : "NOTE"} the dev wallet's own $UNITS: holds ${units(held)}; go-live takes ${units(take)} (to the verifier owner key, one transfer); ${units(held > take ? held - take : 0n)} remain${held >= take ? "" : ". NOT ENOUGH YET: the tooling never buys, it waits for the dev wallet to hold them"}`);
  }
  for (const [name, a, min] of [["Core authority", P0.core_authority, 50_000_000n], ["runtime authority", P0.runtime_authority, 50_000_000n]] as const) {
    const b = await bal(a);
    check(`${name} hot key ${a} holds SOL for its posts (at least 0.05)`, b >= min, sol(b));
  }
  note(`verifier owner key ${P0.site.verifier_owner}: ${sol(await bal(P0.site.verifier_owner))}, ${units(await tok(P0.site.verifier_owner))}`);
  for (const e of P0.site.extra_verifiers) note(`capacity verifier ${e.agent}: ${sol(await bal(e.agent))} (needs none: the owner key pays; it only co-signs its registration)`);
  // the hot keys on this machine are the ones named (public keys only)
  const keys = join(homedir(), ".config", "units", "mainnet");
  for (const [f, want] of [["core-authority.json", P0.core_authority], ["runtime-authority.json", P0.runtime_authority]] as const) {
    const pth = join(keys, f);
    if (isMainnet || existsSync(pth)) check(`${f} on this machine is ${want.slice(0, 8)}... (the instance deploy ships it)`, existsSync(pth) && spawnSync("solana-keygen", ["pubkey", pth], { encoding: "utf8" }).stdout.trim() === want);
  }
  // the site
  if (SITE) {
    // a site behind a password until the owner opens it: UNITS_SITE_AUTH="user:password" (never printed)
    const auth = process.env.UNITS_SITE_AUTH ? { authorization: `Basic ${Buffer.from(process.env.UNITS_SITE_AUTH).toString("base64")}` } : undefined;
    const h = (await fetch(`${SITE}/v1/health`, { headers: auth, signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null)) as { ok?: boolean } | null;
    const ch = (await fetch(`${SITE}/v1/chain`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null)) as { registry_program?: string; core_authority?: string } | null;
    check(`the site instance answers at ${SITE} and its Core authority is the one named`, !!h?.ok && ch?.core_authority === P0.core_authority,
      ch ? `serving ${ch.registry_program === IDS.registry ? "the OFFICIAL deployment" : `the deployment at registry ${ch.registry_program} (the test deployment until switch)`}` : "no answer");
  }
  if (failed) {
    say(`NOT READY: ${failed} check${failed > 1 ? "s" : ""} failed. Nothing may be sent.`);
    return;
  }
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  writeFileSync(READY, JSON.stringify({ at: new Date().toISOString(), mint: MINT, admin: ADMIN, genesis, builds }, null, 2) + "\n");
  say(`READY (${READY}; good for 60 minutes)`);
}

// ---------------------------------------------------------------- init
async function init() {
  requireReady();
  await checkEndpoint(rpc, profile, { deployed: true, local });
  const already = await reader.registryConfig();
  const { r, P, saved } = await resolved({ fresh: has("--reprice") && !already });
  if (!P0.owner_confirmed && (isMainnet || !has("--unconfirmed-ok"))) { if (SEND) throw new Error("official-params.json owner_confirmed is false: the owner confirms the values first"); say("NOTE official-params.json owner_confirmed is false: --send will refuse"); }
  say(saved ? "using the saved resolution (official-resolved.json), so a resumed run sends the same values" : "resolved the dollar values at the live price");
  showParams(r, P);
  const table = knownTable();
  if (SEND) {
    saveResolved(r);
    const admin = adminSigner();
    const send = async (what: string, payer: Signer, ixs: Ix[], o?: { signers?: Signer[]; computeUnits?: number }) => (await tx(what, payer.id, ixs, o))!;
    // the fast path: everything that needs the coin in two independent transactions sent together. --sequential, or no
    // table from `pre`, takes the step by step path below, which also finishes whatever a stopped run left undone
    if (!has("--sequential") && !!table && !!(await rpc.getAccountInfo(table))) {
      const lcNow = await reader.launchConfig();
      const packed = initPacked(P, !(await rpc.getAccountInfo(msgPdas.config()))).filter((g) => (g.needs === "registry" ? !already : !lcNow));
      // the two do not depend on each other: sent at the same time
      await Promise.all(packed.map((g) => tx(g.what, ADMIN, g.ixs, { computeUnits: 400_000 })));
    }
    const out = await initializeTest(rpc, send, check, admin, P, table);
    const cfg = (await reader.registryConfig())!;
    if (cfg.maxSlashBpsPerEpoch !== P0.owner_decision.max_slash_bps_per_epoch) await tx(`set_slash_cap ${P0.owner_decision.max_slash_bps_per_epoch} bps (admin = the dev wallet)`, ADMIN, adminActions.registrySetSlashCap(ADMIN, P0.owner_decision.max_slash_bps_per_epoch));
    check("slash cap per agent per epoch", (await reader.registryConfig())!.maxSlashBpsPerEpoch === P0.owner_decision.max_slash_bps_per_epoch, `${P0.owner_decision.max_slash_bps_per_epoch} bps`);
    await checkTest(rpc, check, ADMIN, P, out.lookupTable);
    if (failed) return;
    const lc = (await reader.launchConfig())!;
    const facts: ChainFacts = { mint: MINT, line_token_program: P.line_token_program, line_decimals: P.line_decimals, admin: ADMIN, core_authority: P.core_authority, runtime_authority: P.runtime_authority,
      launch_lookup_table: out.lookupTable, compute_sink: lc.computeSink, agent_compute_bps: lc.agentComputeBps, protocol_bps: lc.protocolBps };
    writeFileSync(join(OUT, "chain.json"), JSON.stringify({ ...facts, registry_program: IDS.registry, launch_program: IDS.launch, msg_program: IDS.msg, initialized_at: new Date().toISOString() }, null, 2) + "\n");
    say(`initialized; wrote ${join(OUT, "chain.json")}`);
    return;
  }
  // dry: the same instructions initializeTest sends, in its order, for what does not exist yet
  const T = P.line_token_program;
  const lcNow = await reader.launchConfig();
  if (!already) await tx("units_registry::initialize (admin = vault)", ADMIN, [registry.initialize({ upgradeAuthority: ADMIN, mint: MINT, tokenProgram: T, args: registryArgs(P, ADMIN) })]);
  if (!(await rpc.getAccountInfo(computeSink(P, ADMIN)))) await tx("compute sink: the vault's $UNITS token account", ADMIN, [token.createAtaIdempotent(ADMIN, ADMIN, MINT, T)]);
  if (!lcNow) await tx("units_launch::initialize_launch (admin = vault, sink = vault's account)", ADMIN, [launch.initialize({ upgradeAuthority: ADMIN, lineMint: MINT, lineTokenProgram: T, args: launchArgs(P, ADMIN) })]);
  if (!(await rpc.getAccountInfo(msgPdas.config()))) await tx("units_msg::initialize (admin = vault)", ADMIN, [msg.initialize({ upgradeAuthority: ADMIN, args: { admin: ADMIN, ...P.msg } })]);
  if (!table || !(await rpc.getAccountInfo(table))) {
    const want = launchTableAddresses({ lineMint: MINT, lineTokenProgram: T, linePool: P.line_pool });
    const c = lookupTable.create({ authority: ADMIN, payer: ADMIN, recentSlot: (await rpc.getSlot()) - 1 });
    await tx(`launch lookup table ${c.address}: create + extend (${want.length} addresses)`, ADMIN, [c.ix, lookupTable.extend({ table: c.address, authority: ADMIN, payer: ADMIN, addresses: want })]);
    await tx("launch lookup table: freeze", ADMIN, [lookupTable.freeze({ table: c.address, authority: ADMIN })]);
  }
  if (!(await reader.bountyConfig().catch(() => null))) await tx("set_bounty_config (admin = the deployer)", ADMIN, adminActions.bountySetConfig(ADMIN, P.bounty));
  if (!(await reader.challengeConfig().catch(() => null))) await tx("set_challenge_config (admin = the deployer)", ADMIN, adminActions.challengeSetConfig(ADMIN, MINT, T, P.challenge));
  if ((already?.maxSlashBpsPerEpoch ?? 7500) !== P0.owner_decision.max_slash_bps_per_epoch) await tx(`set_slash_cap ${P0.owner_decision.max_slash_bps_per_epoch} bps (admin = the dev wallet)`, ADMIN, adminActions.registrySetSlashCap(ADMIN, P0.owner_decision.max_slash_bps_per_epoch));
  say(planned ? `dry run: ${planned} transaction${planned > 1 ? "s" : ""} would be sent by the dev wallet; add --send to send` : "nothing to send: everything is initialized");
}

/**
 * Everything of init that needs the mint account, as two transactions that do not depend on each other (one
 * transaction with all of it measured 1,312 bytes, over the 1,232-byte limit): the registry with its challenge config
 * and slash cap, and the launch program with its compute sink and bounty config. Each lands whole or not at all.
 */
function initPacked(P: Loaded, withMsg: boolean): { what: string; ixs: Ix[]; needs: "registry" | "launch" }[] {
  const T = P.line_token_program, cap = P0.owner_decision.max_slash_bps_per_epoch;
  return [
    { needs: "registry", what: `init 1 of 2: units_registry::initialize, set_challenge_config${cap !== 7500 ? ", set_slash_cap" : ""} (admin = the dev wallet)`, ixs: [
      registry.initialize({ upgradeAuthority: ADMIN, mint: MINT, tokenProgram: T, args: registryArgs(P, ADMIN) }),
      ...adminActions.challengeSetConfig(ADMIN, MINT, T, P.challenge),
      ...(cap !== 7500 ? adminActions.registrySetSlashCap(ADMIN, cap) : [])] },
    { needs: "launch", what: `init 2 of 2: compute sink, units_launch::initialize_launch${withMsg ? ", units_msg::initialize" : ""}, set_bounty_config (admin = the dev wallet)`, ixs: [
      token.createAtaIdempotent(ADMIN, ADMIN, MINT, T),
      launch.initialize({ upgradeAuthority: ADMIN, lineMint: MINT, lineTokenProgram: T, args: launchArgs(P, ADMIN) }),
      ...(withMsg ? [msg.initialize({ upgradeAuthority: ADMIN, args: { admin: ADMIN, ...P.msg } })] : []),
      ...adminActions.bountySetConfig(ADMIN, P.bounty)] },
  ];
}

// ---------------------------------------------------------------- pre (before the coin exists)
async function pre() {
  check(`the endpoint is ${isMainnet ? "mainnet" : "a local fork of mainnet (not mainnet)"}`, isMainnet || local, genesis);
  check("official-params.json: the owner confirmed the values (owner_confirmed true)", P0.owner_confirmed || (!isMainnet && has("--unconfirmed-ok")), P0.owner_confirmed ? "" : "still false");
  for (const n of ["registry", "launch", "msg"] as const) {
    const so = readFileSync(join(BUILD, `units_${n}.so`)), c = await programCode(IDS[n]);
    check(`${n}: deployed at ${IDS[n]}, byte-identical to the build, upgrade authority = the dev wallet`, !!c && sha(c.code) === sha(trimZeros(so)) && c.authority === ADMIN, c ? `sha256 ${sha(so).slice(0, 16)}...` : "no program");
  }
  const rc = await reader.registryConfig().catch(() => null), lc = await reader.launchConfig().catch(() => null);
  check("registry and launch are not initialized yet (they need the coin)", !rc && !lc);
  const g = decodePumpGlobal((await rpc.getAccountInfo(PUMP.global))!.data);
  check("pump.fun Global.max_curve_depth is 1 or more", g.maxCurveDepth >= 1, `${g.maxCurveDepth}`);
  const j = await solUsd().catch(() => null);
  const ref = j ? (Number(g.initialVirtualSolReserves) / 1e9 / (Number(g.initialVirtualTokenReserves) / 1e6)) * j.usd : null;
  check("a new pump.fun coin's starting price is inside the price band of official-params.json", ref !== null && ref >= P0.owner_decision.price_band.min_usd && ref <= P0.owner_decision.price_band.max_usd,
    ref === null ? "Jupiter gave no SOL price" : `${ref.toPrecision(4)} USD per coin from Global's initial reserves (${Number(g.initialVirtualSolReserves) / 1e9} SOL against ${Number(g.initialVirtualTokenReserves) / 1e6} coins) at SOL ${j!.usd.toFixed(2)} USD`);
  const one = 10n ** BigInt(P0.line_decimals), od = P0.owner_decision, sv = P0.site.site_verifiers, nx = P0.site.extra_verifiers.length;
  const burns = sv.burn_only + sv.burn_and_bond + nx, bonds = sv.burn_and_bond + nx;
  const needUnits = (BigInt(burns) * BigInt(od.register_burn_units) + BigInt(bonds) * BigInt(od.min_bond_units)) * one;
  say(`the verifiers need ${units(needUnits)} in all (${burns} burns of ${units(BigInt(od.register_burn_units) * one)}, ${bonds} bonds of ${units(BigInt(od.min_bond_units) * one)}): with --bond-from-dev-wallet the dev wallet must hold that much after creating the coin${ref ? ` (about ${((Number(needUnits) / 1e6) * ref / j!.usd).toFixed(4)} SOL of coins at the starting price, before pump.fun's fee and the price moving as it buys)` : ""}`);
  check("the dev wallet holds SOL", (await rpc.getBalance(ADMIN)) > 100_000_000n, sol(await rpc.getBalance(ADMIN)));
  for (const [name, a] of [["Core authority", P0.core_authority], ["runtime authority", P0.runtime_authority]] as const) check(`${name} hot key holds at least 0.05 SOL`, (await rpc.getBalance(a)) >= 50_000_000n, sol(await rpc.getBalance(a)));
  if (SITE) {
    // a site behind a password until the owner opens it: UNITS_SITE_AUTH="user:password" (never printed)
    const auth = process.env.UNITS_SITE_AUTH ? { authorization: `Basic ${Buffer.from(process.env.UNITS_SITE_AUTH).toString("base64")}` } : undefined;
    const h = (await fetch(`${SITE}/v1/health`, { headers: auth, signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null)) as { ok?: boolean } | null;
    check(`the site answers at ${SITE}`, !!h?.ok);
  }
  if (failed) { say(`pre: ${failed} check${failed > 1 ? "s" : ""} failed`); return; }
  // the two things that need no mint account
  if (SEND && isMainnet && !P0.owner_confirmed) throw new Error("owner_confirmed is false");
  if (!(await rpc.getAccountInfo(msgPdas.config()))) {
    const P = { msg: P0.owner_decision.msg };
    await tx("units_msg::initialize (admin = vault)", ADMIN, [msg.initialize({ upgradeAuthority: ADMIN, args: { admin: ADMIN, ...P.msg } })]);
  } else check("messages: initialized, admin = the dev wallet", (await readMsgConfig(rpc))?.admin === ADMIN);
  // the Core authority pays every epoch post (one per core_epoch_length_s): topped up to the target from the dev wallet
  const target = lamports(P0.owner_decision.core_authority_target_sol), coreBal = await rpc.getBalance(P0.core_authority);
  if (coreBal < target) await tx(`SOL to the Core authority hot key: ${sol(target - coreBal)} (to ${P0.owner_decision.core_authority_target_sol} SOL, ${(Number(target) / (Math.ceil(86_400 / P0.owner_decision.core_epoch_length_s) * 1_493_440)).toFixed(1)} days of posts)`, ADMIN, [system.transfer(ADMIN, P0.core_authority, target - coreBal)]);
  const want = launchTableAddresses({ lineMint: MINT, lineTokenProgram: P0.line_token_program });
  const t = knownTable(), ta = t ? await rpc.getAccountInfo(t) : null;
  if (ta) check("launch lookup table: frozen with the addresses of this mint", decodeLookupTable(ta.data).authority === null && decodeLookupTable(ta.data).addresses.join() === want.join(), t);
  else {
    const c = lookupTable.create({ authority: ADMIN, payer: ADMIN, recentSlot: (await rpc.getSlot()) - 1 });
    const a = await tx(`launch lookup table ${c.address}: create + extend (${want.length} addresses)`, ADMIN, [c.ix, lookupTable.extend({ table: c.address, authority: ADMIN, payer: ADMIN, addresses: want })]);
    if (a) {
      // written before the freeze: a stop between the two resumes on this table instead of making a second one
      mkdirSync(OUT, { recursive: true, mode: 0o700 });
      writeFileSync(join(OUT, "pre.json"), JSON.stringify({ mint: MINT, launch_lookup_table: c.address, at: new Date().toISOString() }, null, 2) + "\n");
    }
    await tx("launch lookup table: freeze", ADMIN, [lookupTable.freeze({ table: c.address, authority: ADMIN })]);
    if (SEND) check("launch lookup table: frozen with the addresses of this mint", decodeLookupTable((await rpc.getAccountInfo(c.address))!.data).authority === null, c.address);
  }
  const tt = knownTable(), tta = tt ? await rpc.getAccountInfo(tt) : null;
  if (tta && decodeLookupTable(tta.data).authority !== null) { await tx("launch lookup table: freeze", ADMIN, [lookupTable.freeze({ table: tt!, authority: ADMIN })]); }
  say(SEND ? "pre done: messages initialized and the launch lookup table made; `switch --pre` writes the instance files to stage" : planned ? `dry run: ${planned} transaction${planned > 1 ? "s" : ""} would be sent; add --send` : "pre: nothing to send");
}

// ---------------------------------------------------------------- bond
/** What the verifier owner key still needs. `P` only before init (then the file's values stand in for the chain's). Never a buy: the coins are the dev wallet's own. */
async function bondPlan(P: Loaded | null) {
  const cfg = await reader.registryConfig().catch(() => null);
  const registerBurn = cfg?.params.registerBurn ?? P?.params.registerBurn, minBond = cfg?.params.minBond ?? P?.params.minBond;
  if (registerBurn === undefined || minBond === undefined) throw new Error("the registry is not initialized and no resolved values exist");
  const owner = P0.site.verifier_owner, sv = P0.site.site_verifiers, nx = P0.site.extra_verifiers.length;
  const mine = cfg ? (await reader.agents()).filter((a) => a.owner === owner && a.kind === "verifier") : [];
  const extraIds = new Set(P0.site.extra_verifiers.map((e) => e.agent));
  const site = mine.filter((a) => !extraIds.has(a.agent)), extra = mine.filter((a) => extraIds.has(a.agent));
  // the whole need of the file, and what is left to do on chain
  const total = verifierNeed({ registerBurn, minBond, site: sv, extra: nx, registered: { burnOnly: 0, bonded: 0, extra: 0 } });
  const bonded = site.filter((a) => a.bond >= minBond).length, burnOnly = Math.min(sv.burn_only, site.length - bonded);
  const left = verifierNeed({ registerBurn, minBond, site: sv, extra: nx, registered: { burnOnly, bonded, extra: extra.filter((a) => a.bond >= minBond).length } });
  const ownerUnits = (await reader.tokenBalance(ata(owner, MINT, T22))) ?? 0n;
  return { total, left, registerBurn, minBond, site: site.length, bonded, extraRegistered: extra.length, ownerUnits, ownerSol: await rpc.getBalance(owner), adminUnits: (await reader.tokenBalance(ata(ADMIN, MINT, T22))) ?? 0n, received: await receivedByOwner() };
}

async function bond() {
  requireReady();
  const cfg = await reader.registryConfig();
  if (!cfg) throw new Error("the registry is not initialized: run init first");
  if (cfg.mint !== MINT || cfg.admin !== ADMIN) throw new Error("the registry at the official id was not initialized by this sequence");
  const b = await bondPlan(null);
  const owner = P0.site.verifier_owner;
  say(`verifiers of owner key ${owner}: the site's ${P0.site.site_verifiers.burn_only} burn-only + ${P0.site.site_verifiers.burn_and_bond} bonded, and ${P0.site.extra_verifiers.length} on the capacity server; on chain now: ${b.site} site (${b.bonded} bonded), ${b.extraRegistered} capacity`);
  say(`in all ${b.total.burns} registration burns of ${units(b.registerBurn)} and ${b.total.bonds} bonds of ${units(b.minBond)} = ${units(b.total.units)}; still to do: ${b.left.burns} registration burns and ${b.left.bonds} bonds; the owner key holds ${units(b.ownerUnits)} and ${sol(b.ownerSol)} and has received ${units(b.received)} so far`);
  await fundOwnerOnce(b.total.units, b.received, Number(flag("--wait-s") ?? "0"), b.left.burns + b.left.bonds > 0);
  if (SEND) check("the verifier owner key has received the $UNITS for every burn and bond", (await receivedByOwner()) >= b.total.units, units(await receivedByOwner()));
  // the server side: the owner key lives on the site server and signs there (scripts/deploy/site-chain.ts through instance.sh chain)
  const env = `INSTANCE_STATE_FILE=${join(OUT, "state.json")} INSTANCE_PROFILE_FILE=${join(OUT, "profile.local.json")} UNITS_INSTANCE=mainnet`;
  const host = P0.site.host;
  say("then, on the server (the instance staged with the official state file that `switch` writes):");
  say(`  ${env} scripts/deploy/instance.sh ${host} chain-plan      # read only: what the site's three verifiers would send`);
  say(`  ${env} MAINNET_SEND=yes scripts/deploy/instance.sh ${host} chain   # 3 registrations, 2 bonds, signed on the server`);
  say("the capacity server's verifiers (after the site is live; the flow that registered them on the test deployment, scripts/deploy/capacity-host):");
  say(`  first: the official profile overlay (${join(OUT, "profile.local.json")}) to /etc/units-cap/profile.local.json on the host, and the host updated to the instance's release (provision.sh ... update)`);
  for (const e of P0.site.extra_verifiers) {
    say(`  ${e.agent}: on the machine with the owner key: verifier-chain.ts --registry ${IDS.registry} --register ${e.agent} --caps-digest ${P0.site.extra_capabilities_digest}`);
    say(`      on ${e.cosign_host}: cosign-register.ts --key ${e.cosign_key} --tx <base64>; back within about a minute: verifier-chain.ts --registry ${IDS.registry} --send <base64>, then --bond ${e.agent}`);
  }
  if (has("--run-site")) {
    if (!SEND || !isMainnet) throw new Error("--run-site runs the server-side registrations on mainnet: it needs --send and --mainnet");
    const r = spawnSync("bash", ["-c", `cd ${ROOT} && ${env} MAINNET_SEND=yes scripts/deploy/instance.sh ${host} chain`], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("instance.sh chain failed (above); run bond again to resume");
  }
  if (!SEND) say(planned ? `dry run: ${planned} transaction would be sent by the dev wallet; add --send to send` : "dry run: nothing for the dev wallet to send");
}

// ---------------------------------------------------------------- switch
async function switchSite() {
  const cfgFile = join(ROOT, "config/profile.json");
  if (has("--rollback")) {
    const next = rolledBackProfileJson(readFileSync(cfgFile, "utf8"));
    if (has("--apply-config")) { writeFileSync(cfgFile, next); say("config/profile.json: mainnet_deployment test (the official quote block stays, unused)"); }
    else say("would set config/profile.json mainnet_deployment to test; add --apply-config to write it");
    say("then: stop the instance, `instance.sh <host> restore-state <the label archived at switch>`, and activate WITHOUT INSTANCE_STATE_FILE and INSTANCE_PROFILE_FILE (the runbook has the exact lines)");
    return;
  }
  // every chain fact of the state file is known before the coin exists: the table from `pre`, the sink derived from the mint
  const table = knownTable();
  if (!table) throw new Error(`no launch lookup table known: run \`pre --send\` (or init --send) first, with the same --out`);
  const c: ChainFacts = priorChain() ?? { mint: MINT, line_token_program: P0.line_token_program, line_decimals: P0.line_decimals, admin: ADMIN, core_authority: P0.core_authority, runtime_authority: P0.runtime_authority,
    launch_lookup_table: table, compute_sink: ata(ADMIN, MINT, P0.line_token_program), agent_compute_bps: P0.fee_split.agent_compute_bps, protocol_bps: P0.fee_split.protocol_bps };
  const [rc, lc] = [await reader.registryConfig().catch(() => null), await reader.launchConfig().catch(() => null)];
  let p: UnitsPrice;
  if (has("--pre")) {
    // before the coin: staged with the price every pump.fun coin starts at (Global's initial reserves times SOL/USD). `switch --rate-only` after go-live replaces it with the live one
    if (rc || lc) throw new Error("--pre is for before init: the deployment is initialized, run switch without it");
    check("the launch lookup table exists", !!(await rpc.getAccountInfo(table)), table);
    const g = decodePumpGlobal((await rpc.getAccountInfo(PUMP.global))!.data), j = await solUsd();
    const spu = Number(g.initialVirtualSolReserves) / 1e9 / (Number(g.initialVirtualTokenReserves) / 1e6);
    p = { usd_per_units: spu * j.usd, sol_usd: j.usd, sol_per_units: spu, venue: "curve", read_at: new Date().toISOString() };
    say(`reference price (the coin does not exist yet): ${priceLine(p)}; a creation buy moves it, so run \`switch --rate-only\` after go-live`);
  } else {
    check("the chain agrees with the state file's facts (admin, mint, sink, table)", !!rc && !!lc && rc.admin === c.admin && rc.mint === c.mint && lc.computeSink === c.compute_sink && !!(await rpc.getAccountInfo(c.launch_lookup_table)));
    p = await livePrice();
  }
  check("the $UNITS price is inside the band", inBand(p), priceLine(p));
  if (failed) return;
  const identity = !has("--no-identity");
  const state = officialState(P0, IDS, c, p, { identity, indexerPort: 9768 });
  const overlay = officialOverlay(IDS, c, flag("--overlay-genesis") ? { genesis: flag("--overlay-genesis") } : {});
  if (flag("--overlay-genesis") && isMainnet) throw new Error("--overlay-genesis is for the fork only");
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  writeFileSync(join(OUT, "state.json"), JSON.stringify(state, null, 2) + "\n");
  writeFileSync(join(OUT, "profile.local.json"), JSON.stringify(overlay, null, 2) + "\n");
  writeFileSync(join(OUT, "sizing.json"), JSON.stringify({ _note: "the capacity server's verifiers carry replays: more open replays per verifier and more attempts at once (scripts/deploy/sizing.ts overrides, /etc/units-main/sizing.json)", ...P0.site.sizing }, null, 2) + "\n");
  say(`wrote state.json, profile.local.json and sizing.json into ${OUT} (public values only)`);
  const pre = state.network_overrides.prepay;
  say(`credits: ${pre.min_usd} USD at ${pre.line_per_usd} UNITS per USD (snapshot of now); sandbox ${pre.compute_price_line_per_sandbox_s} UNITS per second; runtime bills at the live price from ${state.runtime_price.api}, refused outside ${state.runtime_price.min_usd} to ${state.runtime_price.max_usd} USD or older than ${state.runtime_price.max_age_s} s`);
  say(`units account: ${identity ? `offered, ${sol(BigInt(pre.identity_account_price_lamports))} to ${pre.identity_account_recipient}` : "not offered (--no-identity)"}`);
  if (has("--rate-only")) { say("rate only: ship it with the stage + activate lines of the runbook (no state archive, no config change)"); return; }
  // the tracked files: the one edit that moves the default to the official deployment, and its public state file
  const tracked = "config/mainnet/state.json";
  const next = switchedProfileJson(readFileSync(cfgFile, "utf8"), c, tracked);
  const { network_overrides: _n, runtime_price: _r, price_at_switch: _p, ...publicState } = state;
  if (has("--apply-config")) {
    if (!isMainnet) throw new Error("--apply-config writes the repository's default deployment: only against mainnet");
    mkdirSync(join(ROOT, "config/mainnet"), { recursive: true });
    writeFileSync(join(ROOT, tracked), JSON.stringify({ ...publicState, network_overrides: { prepay: { identity_account_recipient: pre.identity_account_recipient } } }, null, 2) + "\n");
    writeFileSync(cfgFile, next);
    say(`wrote config/profile.json (mainnet_deployment official, quote ${c.mint} live, swap off) and ${tracked}`);
    if (has("--commit")) {
      const r = spawnSync("git", ["-C", ROOT, "commit", "-o", "config/profile.json", tracked, "-m", `go-live: the default deployment is the official one ($UNITS ${c.mint})\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], { encoding: "utf8" });
      if (r.status !== 0) { spawnSync("git", ["-C", ROOT, "add", tracked]); const r2 = spawnSync("git", ["-C", ROOT, "commit", "-o", "config/profile.json", tracked, "-m", `go-live: the default deployment is the official one ($UNITS ${c.mint})\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], { encoding: "utf8" }); if (r2.status !== 0) throw new Error(`git commit failed: ${(r2.stderr || r2.stdout).slice(-300)}`); }
      say("committed config/profile.json and config/mainnet/state.json (push, then deploy)");
    }
  } else {
    const a = JSON.parse(readFileSync(cfgFile, "utf8")), b = JSON.parse(next);
    say("config/profile.json would change (add --apply-config to write, --commit to commit):");
    say(`  mainnet_deployment: ${JSON.stringify(a.mainnet_deployment)} -> ${JSON.stringify(b.mainnet_deployment)}`);
    say(`  profiles.mainnet.quote: ${JSON.stringify(a.profiles.mainnet.quote)}`);
    say(`                       -> ${JSON.stringify(b.profiles.mainnet.quote)}`);
    say(`  profiles.mainnet.swap: ${a.profiles.mainnet.swap} -> ${b.profiles.mainnet.swap}; state_file: ${a.profiles.mainnet.state_file} -> ${b.profiles.mainnet.state_file} (new, public values)`);
  }
  const env = `INSTANCE_STATE_FILE=${join(OUT, "state.json")} INSTANCE_PROFILE_FILE=${join(OUT, "profile.local.json")} UNITS_INSTANCE=mainnet WITH_RUNTIME=1${identity ? " WITH_IDENTITY=1" : ""}`;
  const h = P0.site.host, label = `test-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  say("deploy (run by the owner or the coordinator; this script does not touch the server):");
  for (const l of [
    `UNITS_INSTANCE=mainnet scripts/deploy/instance.sh ${h} stop                       # the test deployment's site goes down here`,
    `UNITS_INSTANCE=mainnet scripts/deploy/instance.sh ${h} archive-state ${label}     # its Core, indexer and runtime state moved aside, fresh empty ones in place`,
    `scp -i ~/.ssh/lineage_site ${join(OUT, "sizing.json")} root@${h}:/etc/units-main/sizing.json`,
    `${env} scripts/deploy/instance.sh ${h} stage                                      # ships HEAD, the official state file and overlay; starts nothing`,
    `${env} scripts/deploy/instance.sh ${h} chain-plan && ${env} MAINNET_SEND=yes scripts/deploy/instance.sh ${h} chain`,
    `${env} scripts/deploy/instance.sh ${h} activate                                   # the official site comes up`,
  ]) say(`  ${l}`);
}

// ---------------------------------------------------------------- retune
async function retune() {
  requireReady();
  const cfg = await reader.registryConfig(), lc = await reader.launchConfig();
  if (!cfg || !lc) throw new Error("not initialized");
  const { r, P } = await resolved({ fresh: true });
  showParams(r, P);
  const ra = registryArgs(P, ADMIN), la = launchArgs(P, ADMIN);
  const regSame = JSON.stringify(cfg.params, big) === JSON.stringify(P.params, big) && cfg.maxRebatePerEpoch === P.max_rebate_per_epoch && cfg.coreAuthority === P.core_authority;
  const lSame = lc.sleepThreshold === la.sleepThreshold && lc.wakeThreshold === la.wakeThreshold && lc.maxDebitPerEpoch === la.maxDebitPerEpoch && lc.agentComputeBps === la.agentComputeBps && lc.pumpCreatorFeeBps === la.pumpCreatorFeeBps && lc.runtimeAuthority === la.runtimeAuthority;
  if (!regSame) await tx("registry set_config (admin = the dev wallet)", ADMIN, adminActions.registrySetConfig(ADMIN, ra));
  if (!lSame) await tx("launch set_config (admin = the dev wallet): thresholds and debit cap at today's price", ADMIN, adminActions.launchSetConfig(ADMIN, { ...la, computeSink: lc.computeSink, paused: lc.paused }));
  if (regSame && lSame) say("the chain already holds these values");
  else if (SEND) { saveResolved(r); say("saved the new resolution"); }
}

// ---------------------------------------------------------------- status
async function status() {
  const line = (k: string, v: string) => say(`${k.padEnd(26)} ${v}`);
  for (const n of ["registry", "launch", "msg"] as const) {
    const c = await programCode(IDS[n]);
    const so = existsSync(join(BUILD, `units_${n}.so`)) ? readFileSync(join(BUILD, `units_${n}.so`)) : null;
    line(`program ${n}`, c ? `${IDS[n]}, upgrade authority ${c.authority}, ${so && sha(c.code) === sha(trimZeros(so)) ? "equals the build" : "DIFFERS from the local build"}` : "not deployed");
  }
  const rc = await reader.registryConfig().catch(() => null), lc = await reader.launchConfig().catch(() => null), mc = await readMsgConfig(rpc).catch(() => null);
  if (!rc || !lc) { line("deployment", "NOT INITIALIZED"); return; }
  line("admin", `${rc.admin} (registry), ${lc.admin} (launch), ${mc?.admin ?? "none"} (messages)${rc.paused || lc.paused ? " PAUSED" : ""}`);
  {
    // the Core authority pays every epoch post: 0.001493440 SOL measured for one post (docs/MAINNET-COSTS.md, the fork rehearsal)
    const POST = 1_493_440n, perDay = BigInt(Math.ceil(86_400 / P0.owner_decision.core_epoch_length_s)) * POST, bal = await rpc.getBalance(rc.coreAuthority);
    const days = Number(bal) / Number(perDay);
    line("Core authority", `${rc.coreAuthority}: ${sol(bal)} = ${days.toFixed(1)} days of posts at one per ${P0.owner_decision.core_epoch_length_s} s (${sol(perDay)} a day; a week is ${sol(perDay * 7n)})${days < P0.owner_decision.core_authority_low_days ? `  LOW: under ${P0.owner_decision.core_authority_low_days} days, top it up` : ""}`);
  }
  line("runtime authority", `${lc.runtimeAuthority}: ${sol(await rpc.getBalance(lc.runtimeAuthority))}`);
  line("dev wallet", `${sol(await rpc.getBalance(rc.admin))}, ${units((await reader.tokenBalance(ata(rc.admin, rc.mint, T22))) ?? 0n)}`);
  const c = await curveOf(rc.mint);
  let p: UnitsPrice | null = null;
  try { p = await livePrice(); } catch (e) { line("$UNITS price", `unavailable: ${(e as Error).message}`); }
  line("$UNITS", `${rc.mint}; ${c ? (curveMigrated(c) ? "migrated to PumpSwap" : c.complete ? "curve COMPLETE, awaiting migration (launches fail until migrate)" : `on its curve, ${sol(c.realQuoteReserves)} raised`) : "no curve"}`);
  if (p) line("$UNITS price", `${priceLine(p)}${inBand(p) ? "" : "  OUTSIDE THE BAND: the runtime bills nothing"}`);
  line("fee split", `${lc.agentComputeBps} bps compute, ${lc.protocolBps} bps protocol; pump creator fee ${lc.pumpCreatorFeeBps} bps`);
  line("thresholds", `sleep ${units(lc.sleepThreshold)}, wake ${units(lc.wakeThreshold)}, debit cap per usage epoch ${units(lc.maxDebitPerEpoch ?? 0n)}${p ? ` (${((Number(lc.maxDebitPerEpoch ?? 0n) / 1e6) * p.usd_per_units).toPrecision(3)} USD now)` : ""}`);
  line("registry", `burn ${units(rc.params.registerBurn)}, min bond ${units(rc.params.minBond)}, cap ${units(rc.params.bondCap)}, slash cap ${rc.maxSlashBpsPerEpoch} bps, epoch ${rc.params.epochLengthS} s, cooldown ${rc.params.unbondCooldownS} s`);
  const v = await reader.vaults();
  line("vaults", `treasury ${units(v.treasury ?? 0n)}, reserve ${units(v.reserve ?? 0n)}, pool ${units(v.pool ?? 0n)}, payable ${units(v.payable ?? 0n)}, bonds ${units(v.bondVault ?? 0n)}; compute sink ${units((await reader.tokenBalance(lc.computeSink)) ?? 0n)}`);
  const agents = await reader.agents();
  const ver = agents.filter((a) => a.kind === "verifier");
  line("verifiers", `${ver.length} registered, ${ver.filter((a) => a.bond >= rc.params.minBond).length} bonded at min_bond or more`);
  for (const a of ver) line("", `${a.agent} owner ${a.owner.slice(0, 8)}... bond ${units(a.bond)}${P0.site.extra_verifiers.some((e) => e.agent === a.agent) ? " (capacity server)" : ""}`);
  const missing = P0.site.extra_verifiers.filter((e) => !ver.some((a) => a.agent === e.agent));
  if (missing.length) line("", `NOT registered yet: ${missing.map((e) => e.agent).join(", ")}`);
  const launches = await reader.launches();
  line("agents launched", `${launches.length} (${agents.filter((a) => a.kind === "launched").length} agent records)`);
  const nb = nextPostNotBefore({ epochsPosted: rc.epochsPosted, lastEpoch: rc.lastEpoch, epochAnchor: rc.epochAnchor, epochAnchorTs: rc.epochAnchorTs, epochLengthS: rc.params.epochLengthS });
  line("epochs on chain", `${rc.epochsPosted} posted by the Core authority${rc.epochsPosted > 0n ? `, last ${rc.lastEpoch}; the chain accepts the next one from ${new Date((nb ?? 0) * 1000).toISOString()}` : " (none yet: Core posts at its epoch close)"}; usage epochs posted by the runtime ${lc.usageEpochsPosted}`);
  const t = priorChain()?.launch_lookup_table;
  if (t) { const ta = await rpc.getAccountInfo(t); line("launch lookup table", ta ? `${t}, ${decodeLookupTable(ta.data).authority === null ? "frozen" : "NOT frozen"}, ${decodeLookupTable(ta.data).addresses.length} addresses` : `${t} MISSING`); }
  if (c) line("$UNITS creator fees", `creator ${c.creator}: ${sol(c.creatorFee)} waiting on the curve, ${sol(await rpc.getBalance(pumpPdas.creatorVault(c.creator)))} in the creator vault (fee keeper: ${existsSync(join(ROOT, "config/fee-keeper.official.json")) ? "config/fee-keeper.official.json, compute_address not set, off" : "no config"})`);
  if (SITE) {
    const get = async (pth: string) => fetch(`${SITE}${pth}`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>;
    const [h, ch, ep, qu, st, idn] = await Promise.all([get("/v1/health"), get("/v1/chain"), get("/v1/epochs?limit=1"), get("/market/quote-usd"), get("/v1/stats"), get("/identity/health")]);
    line("site", `${SITE}: ${h?.ok ? "Core up" : "Core NOT answering"}; serving ${ch ? (ch.registry_program === IDS.registry ? "the OFFICIAL deployment" : `registry ${ch.registry_program} (NOT the official one)`) : "unknown"}; Core signing ${ch?.core_signing === true ? "yes" : "NO (read only)"}`);
    const open = Array.isArray(ep) ? ep.find((e: any) => e.status === "open") ?? ep[0] : null;
    if (open) line("Core epoch", `epoch ${open.n} ${open.status}, closes ${new Date(open.end_ms).toISOString()} (in ${Math.max(0, Math.round((open.end_ms - Date.now()) / 60_000))} min); Core has posted ${ch?.epochs_posted ?? "?"} epoch(s) on chain${String(ch?.epochs_posted) === "0" ? ": accepted work is paid at the first close" : ""}`);
    if (st) line("Core", `${st.agents} agents, ${st.machines_awake}/${st.machines} machines awake, ${st.lineages} units, ${st.generations} generations, ${st.candidates} candidates`);
    line("site price", qu?.ok ? `${Number(qu.usd).toPrecision(4)} USD per UNITS, read ${qu.age_s} s ago (${qu.venue}); the runtime bills from this reading` : `unavailable: ${qu?.reason ?? "no answer"} (the runtime starts nothing without a price)`);
    line("identity service", idn ? JSON.stringify(idn).slice(0, 200) : "not answering on this site (the units account is not offered)");
  }
}

// ---------------------------------------------------------------- watch: one trigger
async function watch() {
  if (!SEND) throw new Error("watch sends: it needs --send (and --mainnet on mainnet). Nothing here starts it by itself");
  if (!P0.owner_confirmed && (isMainnet || !has("--unconfirmed-ok"))) throw new Error("official-params.json owner_confirmed is false");
  adminSigner(); // the key is checked now, not when the coin appears
  if (!knownTable() || !(await rpc.getAccountInfo(knownTable()!))) throw new Error("no launch lookup table yet: run `pre --send` first, so init is one transaction");
  const self = `UNITS_NETWORK=mainnet bun scripts/mainnet/golive.ts`;
  const common = argv.slice(1).filter((a, i, all) => !["--send", "--run-site"].includes(a) && !["--chain-cmd", "--go-cmd", "--wait-s"].includes(a) && !["--chain-cmd", "--go-cmd", "--wait-s"].includes(all[i - 1] ?? "")).join(" ");
  const env = `INSTANCE_STATE_FILE=${join(OUT, "state.json")} INSTANCE_PROFILE_FILE=${join(OUT, "profile.local.json")} INSTANCE_SIZING_FILE=${join(OUT, "sizing.json")} UNITS_INSTANCE=mainnet`;
  const chainCmd = flag("--chain-cmd") ?? (has("--run-site") ? `cd ${ROOT} && ${env} MAINNET_SEND=yes scripts/deploy/instance.sh ${P0.site.host} chain` : null);
  const goCmd = flag("--go-cmd") ?? (has("--run-site") ? `cd ${ROOT} && ${env} scripts/deploy/instance.sh ${P0.site.host} go` : null);
  say(`watching for ${MINT} (polling every 400 ms); the instance files in ${OUT} must be staged already`);
  let t = Date.now(), seen = 0;
  for (;;) {
    const [m, cv] = await rpc.getMultipleAccounts([MINT, pumpPdas.bondingCurve(MINT)]).catch(() => [null, null]);
    if (m && cv && cv.owner === PUMP.program) break;
    if (seen % 75 === 0) await solUsd().catch((e) => say(`SOL price not read (${(e as Error).message}); trying again`)); // every 30 s: fresh when the coin appears
    if (++seen % 150 === 0) say(`still waiting (${Math.round((Date.now() - T0) / 1000)} s)`);
    await new Promise((r) => setTimeout(r, 400));
  }
  const tCoin = Date.now();
  say(`the coin exists (seen ${new Date(tCoin).toISOString()})`);
  const step = async (name: string, resume: string, f: () => Promise<void>) => {
    t = Date.now();
    try { await f(); } catch (e) {
      console.error(`[golive] watch stopped at ${name}: ${scrub((e as Error).message)}`);
      console.error(`[golive] resume with: ${resume}`);
      process.exit(1);
    }
    if (failed) { console.error(`[golive] watch stopped at ${name}: a check failed (above)`); console.error(`[golive] resume with: ${resume}`); process.exit(1); }
    lap(name, t);
  };
  await step("post-coin preflight", `${self} watch ${common} --send`, preflight);
  // init (one transaction) and the transfer to the verifier owner key do not depend on each other: sent in parallel.
  // The transfer needs the registry's values only to know the amounts, which are the file's
  await step("init + bond funding, in parallel", `${self} init ${common} --send && ${self} bond ${common} --send`, async () => {
    const { P } = await resolved({ fresh: !existsSync(join(OUT, "official-resolved.json")) });
    await Promise.all([init(), fundOwner(P)]);
  });
  await step("instance files at the live price", `${self} switch ${common}`, async () => { await switchSite(); });
  if (chainCmd) await step("verifiers registered and bonded (server side)", chainCmd, async () => { const r = spawnSync("bash", ["-c", chainCmd], { stdio: "inherit" }); if (r.status !== 0) throw new Error("the registration command failed"); });
  if (goCmd) await step("activation", goCmd, async () => { const r = spawnSync("bash", ["-c", goCmd], { stdio: "inherit" }); if (r.status !== 0) throw new Error("the activation command failed"); });
  say(`TIME total since the coin was seen: ${((Date.now() - tCoin) / 1000).toFixed(1)} s`);
  if (!chainCmd) say("next (not run: no --run-site): the server-side registrations and the activation, the two lines `switch` printed");
}
/** The bond step's one transfer, sent while init is landing: the amounts are the file's (what init is writing in parallel). */
async function fundOwner(P: Loaded) {
  const sv = P0.site.site_verifiers, nx = P0.site.extra_verifiers.length;
  const need = BigInt(sv.burn_only + sv.burn_and_bond + nx) * P.params.registerBurn + BigInt(sv.burn_and_bond + nx) * P.params.minBond;
  await fundOwnerOnce(need, await receivedByOwner(), Number(flag("--wait-s") ?? "30"));
}

const commands: Record<string, () => Promise<void>> = {
  pre, watch, preflight, init, bond, switch: switchSite, status, retune,
  params: async () => { const { r, P, saved } = await resolved({ fresh: !existsSync(join(OUT, "official-resolved.json")) }); say(saved ? "saved resolution" : "resolved now (not saved: init --send saves it)"); showParams(r, P); },
};
if (!commands[cmd]) {
  console.log("usage: see the header of scripts/mainnet/golive.ts (preflight, params, init, bond, switch, status, retune)");
  process.exit(2);
}
try {
  await commands[cmd]!();
} catch (e) {
  console.error(`[golive] ${cmd} stopped: ${scrub((e as Error).message)}`);
  process.exit(1);
}
if (failed) process.exit(1);
