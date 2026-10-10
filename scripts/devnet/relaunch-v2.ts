#!/usr/bin/env bun
// Devnet v2: relaunch the site's listed hosted agents on pump.fun (onchain/DEVNET.md "Devnet v2",
// owner decision 2026-10-10). The real launch path, as the /launch wizard builds it: create_v2 quoted
// in the devnet tLINE + register_pump_launch, the launcher's initial buy of initial_buy_bps of the
// supply delivered to the agent key, the prepaid credits (10 USD at the TEST rate) into the compute
// vault with refresh_awake, and the soul digest (set_profile) when the agent has one; then, per agent,
// the soul into Core (new agent keys), the bind to the site's hosted runtime (owner signs
// rotate_agent_key, the runtime co-signs) and the launch holding moved to the runtime key (D3).
//
// Identity continuity: an agent whose key is kept (TMBPE, TRTA, TSOUL) relaunches under the same agent
// id, so all of its Core history stays its own and Core records its Meteora token as the previous one.
// An agent whose key was not kept (Wick Radix, Neap: made in a browser tab) relaunches under a new key
// with the same soul as a new version (the doc names the agent), the same GitHub account (identity
// `adopt` rekey, run before the launch so no reserve account is assigned) and a Core link to its
// earlier agent (POST /v1/admin/agent-previous).
//
//   bun scripts/devnet/relaunch-v2.ts plan            keys, quotes and needs; sends nothing
//   bun scripts/devnet/relaunch-v2.ts launch [--only SYM,...]
//   bun scripts/devnet/relaunch-v2.ts after  [--only SYM,...]   soul, bind, holding move, trading funds
//
// Keys are passed explicitly (never `solana config`); only public keys and signatures are printed.
// State and every transaction: scripts/devnet/RELAUNCH-V2.json (signatures, fees, costs).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ata,
  base58Encode,
  compileMessage,
  decodeBondingCurve,
  decodePumpFeeConfig,
  decodePumpGlobal,
  decodeT22Metadata,
  IDENTITY_MODE,
  initialBuyAmount,
  maxBuyInput,
  moveLaunchHolding,
  parsePrepayConfig,
  PUMP,
  pumpPdas,
  pumpQuotedCurve,
  quoteInitialBuy,
  launchPdas,
  registry,
  requiredCredits,
  signBytes,
  system,
  token,
  TOKEN_2022_PROGRAM,
  type Signer,
} from "@lineage/chain";
import { signSoul, soulDigest, type SoulDoc } from "../../packages/souls/src/doc.ts";
import { unsignedWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import { deployer, key, LAMPORTS, loadState, log, reader, ROOT, rpc, sol } from "./lib.ts";
import { launchTable, pumpLaunchTx, sendTx } from "./pump-lib.ts";

const SITE = "https://157-245-71-188.sslip.io";
const T22 = TOKEN_2022_PROGRAM;
const OUT = join(import.meta.dir, "RELAUNCH-V2.json");
const argv = process.argv.slice(2);
const phase = argv[0] ?? "plan";
const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1]!.split(",")) : null;

interface Spec {
  sym: string;
  /** the agent id on devnet v1 */
  old: string;
  /** key file under ~/.config/lineage/devnet: the same agent key, or a new one */
  key: string;
  same: boolean;
  /** the owner (launcher) key file */
  owner: string;
  /** soul documents to carry (same key: none in the site's Core, the on-chain digest is kept) */
  soulDigest?: { digest: string; seq: number };
}
const AGENTS: Spec[] = [
  { sym: "TMBPE", old: "BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV", key: "agent-minbpe", same: true, owner: "launcher" },
  { sym: "TRTA", old: "5t9wKLssXQ1ZFdM74UdiXj9QxFphjVxBmo6rmLaSK91R", key: "runtime-test-agent", same: true, owner: "runtime-test-launcher" },
  // TSOUL's soul (Slackwater) v2 digest, on the v1 registry at seq 2 (scripts/souls/DEVNET-LAST.json)
  { sym: "TSOUL", old: "6C8N2z5LwktukWEP6g8sUnf9ky1L9rxyngBLbdomUzHc", key: "souls-test-agent", same: true, owner: "souls-test-launcher",
    soulDigest: { digest: "de7c81ec3357cc1e6692fe2d89b9c99e9dda8ad46cbd83f3eff538690d9fe58f", seq: 2 } },
  { sym: "TESTB58", old: "5iCWSoXAsvhdDiwsexnuAXU3RcNXgbXw7TzuRZH2LYoA", key: "v2-agent-wick-radix", same: false, owner: "launch-e2e-test" },
  { sym: "TLAMP", old: "CLy55wj9ETTkksqcdJjkowNt9Y5m4ZoXxyhR7Buwo5TG", key: "v2-agent-neap", same: false, owner: "app-launch-test" },
];

type Tx = { what: string; signature: string; fee: number | null; at: string };
interface Row {
  sym: string;
  old_agent: string;
  old_mint: string;
  agent: string;
  mint: string;
  launcher: string;
  repo: string;
  identity_mode: string;
  name: string;
  symbol: string;
  uri: string;
  same_key: boolean;
  credits?: string;
  initial_buy?: { amount_out: string; quote: string; max_in: string };
  launch?: { signatures: string[]; plan: string; launcher_sol_spent: string; launcher_tline_spent: string; at: string };
  soul?: { digest: string; seq: number; stored?: boolean };
  bind?: { runtime_key: string; signature: string | null; status: string };
  holding?: { amount: string; to: string; signature: string };
  txs: Tx[];
}
const state: { started_at: string; rows: Record<string, Row> } = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { started_at: new Date().toISOString(), rows: {} };
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2) + "\n");
const devnet = loadState();
const LINE = devnet.line_mint!;
const dep = deployer();
const treasury = key("tline-pump-treasury");
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const prepay = parsePrepayConfig(net.prepay);
const ONE = 1_000_000n;

async function site<T = any>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(`${SITE}${path}`, { ...init, headers: { accept: "application/json", ...(init?.method && init.method !== "GET" ? { origin: SITE } : {}), ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  return { status: r.status, body: (await r.json().catch(() => null)) as T };
}

async function tx(row: Row, what: string, payer: Signer, ixs: Parameters<typeof sendTx>[2], signers: Signer[] = []) {
  const r = await sendTx(rpc, payer, ixs, { signers, computeUnits: 200_000 });
  row.txs.push({ what, signature: r.signature, fee: r.fee, at: new Date().toISOString() });
  save();
  log(`${row.sym}: ${what}: ${r.signature}`);
  return r;
}

async function resolve(s: Spec): Promise<{ row: Row; agent: Signer; mint: Signer; owner: Signer }> {
  const agent = key(s.key);
  const owner = key(s.owner);
  const mint = key(`v2-mint-${s.sym.toLowerCase()}`);
  if (s.same && agent.id !== s.old) throw new Error(`${s.sym}: ${s.key}.json is ${agent.id}, not ${s.old}`);
  let row = state.rows[s.sym];
  if (!row) {
    const { body: a } = await site(`/v1/agents/${s.old}`);
    if (!a?.mint) throw new Error(`${s.sym}: the site's Core does not know ${s.old}`);
    if (a.launcher !== owner.id) throw new Error(`${s.sym}: owner ${a.launcher} is not ${s.owner}.json (${owner.id})`);
    const meta = decodeT22Metadata((await rpc.getAccountInfo(a.mint))!.data);
    if (!meta) throw new Error(`${s.sym}: no Token-2022 metadata on the old mint ${a.mint}`);
    row = state.rows[s.sym] = {
      sym: s.sym, old_agent: s.old, old_mint: a.mint, agent: agent.id, mint: mint.id, launcher: owner.id, repo: a.target_repo, identity_mode: a.identity_mode,
      name: meta.name, symbol: meta.symbol, uri: meta.uri, same_key: s.same, txs: [],
    };
    save();
  }
  return { row, agent, mint, owner };
}

/** The initial buy for a coin create_v2 is about to write, quoted in tLINE (as the wizard's pump-venue.ts). */
async function buyQuote(agentId: string) {
  const [gA, fcA, curveA] = await rpc.getMultipleAccounts([PUMP.global, PUMP.feeConfig, pumpPdas.bondingCurve(LINE)]);
  const g = decodePumpGlobal(gA!.data);
  const seedRule = JSON.parse(readFileSync(join(ROOT, "config/profile.json"), "utf8")).profiles.devnet.pump_quote_seed ?? "swap";
  const fresh = pumpQuotedCurve(g, { curve: decodeBondingCurve(curveA!.data) }, launchPdas.pumpCreator(agentId), LINE, 0n, seedRule);
  const amountOut = initialBuyAmount(g.tokenTotalSupply, prepay.initial_buy_bps);
  const quote = quoteInitialBuy(g, decodePumpFeeConfig(fcA!.data), fresh, amountOut);
  return { amountOut, quote, maxIn: maxBuyInput(quote, prepay.initial_buy_slippage_bps) };
}

/** The soul a relaunch under a new key carries: the earlier agent's latest version, naming the new agent. */
async function newKeySoul(row: Row, agent: Signer): Promise<{ doc: SoulDoc; sig: string; digest: string }> {
  const { body } = await site(`/v1/agents/${row.old_agent}/soul`);
  if (!body?.doc) throw new Error(`${row.sym}: no soul for ${row.old_agent} in the site's Core`);
  const prev = body.doc as SoulDoc;
  const doc = { ...prev, agent: agent.id, seq: 1, prev: null, created_at: Math.floor(Date.now() / 1000) } as SoulDoc;
  if ((doc as any).memory?.entries?.length) (doc as any).memory = { through_epoch: null, entries: [], reflection: null };
  delete (doc as any).media; // images were uploaded for the earlier agent id
  return { doc, sig: signSoul(agent as never, doc), digest: soulDigest(doc) };
}

async function plan() {
  for (const s of AGENTS.filter((x) => !only || only.has(x.sym))) {
    const { row, agent, owner } = await resolve(s);
    const q = await buyQuote(agent.id);
    const credits = requiredCredits(prepay, 6);
    const [ls, ll] = [await rpc.getBalance(owner.id), (await reader.tokenBalance(ata(owner.id, LINE, T22))) ?? 0n];
    log(`${s.sym}: agent ${agent.id}${s.same ? " (same key)" : ` (new key; was ${s.old})`}, mint ${row.mint}, owner ${owner.id}: ${sol(ls)} SOL, ${ll} tLINE base units; ` +
      `"${row.name}" ${row.symbol} ${row.uri}; repo ${row.repo} (${row.identity_mode}); credits ${credits}, initial buy ${q.amountOut} for ${q.quote} (max ${q.maxIn}) tLINE base units`);
  }
}

async function launchOne(s: Spec) {
  const { row, agent, mint, owner } = await resolve(s);
  if (await reader.agentLaunch(row.mint)) return log(`${s.sym}: launched already (${row.mint})`);
  const credits = requiredCredits(prepay, 6);
  const q = await buyQuote(agent.id);
  // fund the launcher: SOL for the launch and tLINE for credits + buy (from the devnet treasury)
  const wantSol = LAMPORTS / 10n;
  const haveSol = await rpc.getBalance(owner.id);
  if (haveSol < wantSol / 2n) await tx(row, `fund launcher ${owner.id} with ${sol(wantSol - haveSol)} SOL from the deployer`, dep, [system.transfer(dep.id, owner.id, wantSol - haveSol)]);
  const needLine = credits + q.maxIn + ONE;
  const haveLine = (await reader.tokenBalance(ata(owner.id, LINE, T22))) ?? 0n;
  if (haveLine < needLine)
    await tx(row, `send ${needLine - haveLine} tLINE base units to launcher ${owner.id} from the devnet treasury`, dep, [
      token.createAtaIdempotent(dep.id, owner.id, LINE, T22),
      token.transferChecked(ata(treasury.id, LINE, T22), LINE, ata(owner.id, LINE, T22), treasury.id, needLine - haveLine, 6, T22),
    ], [treasury]);
  // soul digest on chain (set_profile signed by the agent key, its signing key at launch)
  let soulIx = null;
  if (s.soulDigest) {
    row.soul = { ...s.soulDigest };
    soulIx = registry.setProfile({ signingKey: agent.id, agent: agent.id, digest: s.soulDigest.digest, seq: s.soulDigest.seq });
  } else if (!s.same) {
    const sd = await newKeySoul(row, agent);
    row.soul = { digest: sd.digest, seq: 1 };
    writeFileSync(join(import.meta.dir, `relaunch-v2-soul-${s.sym}.json`), JSON.stringify({ doc: sd.doc, sig: sd.sig }, null, 2) + "\n");
    soulIx = registry.setProfile({ signingKey: agent.id, agent: agent.id, digest: sd.digest, seq: 1 });
  }
  const mode = row.identity_mode === "purchased" ? IDENTITY_MODE.purchased : row.identity_mode === "token" ? IDENTITY_MODE.token : IDENTITY_MODE.app;
  const sol0 = await rpc.getBalance(owner.id);
  const line0 = (await reader.tokenBalance(ata(owner.id, LINE, T22))) ?? 0n;
  const table = await launchTable(rpc, devnet as never);
  const r = await pumpLaunchTx(rpc, {
    launcher: owner, agent, mint, lineMint: LINE, name: row.name, symbol: row.symbol, uri: row.uri,
    args: { repoUrl: row.repo, identityMode: mode, hosted: true }, table,
    deposit: { amount: credits, decimals: 6 }, buy: { amountOut: q.amountOut, maxIn: q.maxIn }, soul: soulIx,
  });
  const sol1 = await rpc.getBalance(owner.id);
  const line1 = (await reader.tokenBalance(ata(owner.id, LINE, T22))) ?? 0n;
  for (const t of r.sent) row.txs.push({ what: `create_v2 + register_pump_launch ${row.symbol} (${r.plan.mode}, ${t.size} bytes, ${t.computeUnits ?? "?"} CU)`, signature: t.signature, fee: t.fee, at: new Date().toISOString() });
  row.credits = credits.toString();
  row.initial_buy = { amount_out: q.amountOut.toString(), quote: q.quote.toString(), max_in: q.maxIn.toString() };
  row.launch = { signatures: r.sent.map((t) => t.signature), plan: r.plan.mode, launcher_sol_spent: sol(sol0 - sol1), launcher_tline_spent: (line0 - line1).toString(), at: new Date().toISOString() };
  save();
  const l = await reader.agentLaunch(row.mint);
  const held = (await reader.tokenBalance(ata(agent.id, row.mint, T22))) ?? 0n;
  const vault = (await reader.tokenBalance(launchPdas.computeVault(agent.id))) ?? 0n;
  const rec = await reader.agent(agent.id);
  log(`${s.sym}: launched ${row.mint} in ${r.sent.length} tx (${r.plan.mode}): ${r.sent.map((t) => t.signature).join(", ")}; launcher spent ${row.launch.launcher_sol_spent} SOL and ${line0 - line1} tLINE base units`);
  log(`${s.sym}: AgentLaunch venue ${l?.venue}, hosted ${l?.hosted}; agent key holds ${held} (want ${q.amountOut}); compute vault ${vault} (credits ${credits}); profile ${rec?.profileDigest ?? "none"} seq ${rec?.profileSeq ?? 0}`);
  if (l?.venue !== "pump" || held !== q.amountOut || vault < credits) throw new Error(`${s.sym}: launch read back does not match`);
}

/** rotate_agent_key signed by the owner as fee payer, the runtime's signature slot left empty (the bind endpoint fills it). */
async function bindWire(owner: Signer, agent: string, newKey: string): Promise<string> {
  const { blockhash } = await rpc.getLatestBlockhash();
  const msg = compileMessage(owner.id, [registry.rotateAgentKey({ owner: owner.id, agent, newKey })], blockhash);
  const wire = placeSignature(unsignedWire(msg), owner.id, signBytes(owner, msg.bytes));
  return Buffer.from(wire).toString("base64");
}

async function afterOne(s: Spec) {
  const { row, agent, owner } = await resolve(s);
  if (!(await reader.agentLaunch(row.mint))) throw new Error(`${s.sym}: not launched yet`);
  // 1. Core knows the agent (the bridge mirrors the launch)
  for (let i = 0; i < 40; i++) {
    const { body } = await site(`/v1/agents/${row.agent}`);
    if (body?.mint === row.mint) break;
    if (i === 39) throw new Error(`${s.sym}: the site's Core has not mirrored ${row.agent} with ${row.mint}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  // 2. the soul of a relaunch under a new key, stored in Core while the agent key still signs for it
  const soulFile = join(import.meta.dir, `relaunch-v2-soul-${s.sym}.json`);
  if (!s.same && existsSync(soulFile) && !row.soul?.stored) {
    // the launch page's path: POST /souls/publish (the dashboard PUTs it to Core; the gate allows only this)
    const r = await site(`/souls/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: readFileSync(soulFile, "utf8") });
    if (r.status >= 300) throw new Error(`${s.sym}: soul PUT ${r.status} ${JSON.stringify(r.body)}`);
    row.soul = { ...row.soul!, stored: true };
    save();
    log(`${s.sym}: soul stored in Core: ${r.body.digest} seq ${r.body.seq}`);
  }
  // 3. bind to the hosted runtime
  let t: { new_key: string; status: string } | null = null;
  for (let i = 0; i < 30 && !t; i++) {
    const r = await site<{ new_key: string; status: string }>(`/runtime/bind/${row.agent}`);
    if (r.status === 200) t = r.body;
    else await new Promise((res) => setTimeout(res, 5000));
  }
  if (!t) throw new Error(`${s.sym}: the hosted runtime did not answer for ${row.agent}`);
  let rec = await reader.agent(row.agent);
  if (rec?.signingKey !== t.new_key) {
    const p = await site<{ signature: string; message?: string }>(`/runtime/bind/${row.agent}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: await bindWire(owner, row.agent, t.new_key) }) });
    if (p.status !== 200) throw new Error(`${s.sym}: bind POST ${p.status} ${JSON.stringify(p.body)}`);
    const got = await rpc.getTransaction(p.body.signature).catch(() => null);
    row.txs.push({ what: `rotate_agent_key ${row.symbol} to the hosted runtime key ${t.new_key} (owner signed, runtime co-signed)`, signature: p.body.signature, fee: got?.meta?.fee ?? null, at: new Date().toISOString() });
    row.bind = { runtime_key: t.new_key, signature: p.body.signature, status: "bound" };
    save();
    log(`${s.sym}: bound to ${t.new_key}: ${p.body.signature}`);
    for (let i = 0; i < 20 && rec?.signingKey !== t.new_key; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      rec = await reader.agent(row.agent);
    }
  } else row.bind = { runtime_key: t.new_key, signature: row.bind?.signature ?? null, status: "bound" };
  if (rec?.signingKey !== t.new_key) throw new Error(`${s.sym}: the registry does not show the runtime key yet`);
  // 4. D3: the launch holding moves from the agent key to the runtime key (the agent's treasury)
  const held = (await reader.tokenBalance(ata(row.agent, row.mint, T22))) ?? 0n;
  if (held > 0n) {
    const r = await tx(row, `launch holding ${held} ${row.symbol} base units from the agent key to its treasury ${t.new_key} (agent key signs, launcher pays)`, owner,
      moveLaunchHolding({ payer: owner.id, agentKey: row.agent, treasury: t.new_key, agentMint: row.mint, amount: held, decimals: 6 }), [agent]);
    row.holding = { amount: held.toString(), to: t.new_key, signature: r.signature };
    save();
  }
  const moved = (await reader.tokenBalance(ata(t.new_key, row.mint, T22))) ?? 0n;
  log(`${s.sym}: treasury ${t.new_key} holds ${moved} ${row.symbol} base units; agent key ${(await reader.tokenBalance(ata(row.agent, row.mint, T22))) ?? 0n}`);
  save();
}

try {
  if (phase === "plan") await plan();
  else if (phase === "launch")
    for (const s of AGENTS.filter((x) => !only || only.has(x.sym)))
      await launchOne(s).catch((e) => {
        for (const l of (e as { logs?: string[] }).logs ?? []) console.error(`    ${l}`);
        throw e;
      });
  else if (phase === "after") for (const s of AGENTS.filter((x) => !only || only.has(x.sym))) await afterOne(s);
  else throw new Error(`unknown phase ${phase}`);
} finally {
  save();
}
log(`deployer ${sol(await rpc.getBalance(dep.id))} SOL`);
void base58Encode;
