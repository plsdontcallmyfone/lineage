#!/usr/bin/env bun
// Seamless bind on DEVNET, end to end, with a LOCAL hosted runtime bind endpoint
// (docs/plans/SEAMLESS-BIND.md). Real transactions on devnet; nothing here can reach mainnet
// (devnet-process pins the network and every send asserts the devnet genesis).
//
// What is real: the page's own code (apps/web/wallet/chain.ts signAndSendAll, bind-plan.ts, bind.ts
// finishBind) run under bun with the page's /chain/rpc and /runtime/* requests routed to devnet and to
// the local runtime; the runtime's own code (Runtime.bindTarget and adoption, reserve.ts, bind.ts
// bindHandler, the transaction firewall, cosign.ts) served on 127.0.0.1; the deployed devnet programs;
// a Wallet Standard wallet object that signs with the lane's devnet test key and counts every request.
// What is not: the wizard's screens (tests/ui/setup-bar.spec.ts and the web tests cover the page side),
// the full runtime loop (no Core, no model: only its bind surface runs), and a real wallet extension.
//
//   A  one approval: the wallet is asked once, for the launch transactions and the bind together; the
//      runtime co-signs before anything is sent; the agent is bound when the launch has landed
//   B  the runtime's co-signature cannot be had before the send: the launch goes out alone, and the
//      bind the wallet already signed is sent by the runtime right after; still one approval
//   C  an agent launched with no bind at all (as before this work): the runtime lists it for its
//      launcher, and finishing it takes one signature
//   D  what the live runtime refuses, asked over HTTP
//
// Usage: bun scripts/launch-e2e/bind-devnet.ts [--port 9668]      (ports 9663, 9666-9669 only)
import "../../packages/chain/src/devnet-process.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { ChainReader, compileMessage, computeBudget, guardKey, IDENTITY_MODE, loadKeypair, planLaunch, pumpLaunchMain, registry, Rpc, sendAndConfirm, signBytes, system, TOKEN_2022_PROGRAM, type Ix, type LookupTable } from "@units/chain";
import { assertDevnet, DEVNET_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { decodeMessage, parseWire, placeSignature, unsignedWire } from "../../packages/chain/src/browser/wire.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { DEVNET_PUBLIC_PROFILE } from "../../packages/chain/src/profile.ts";
import { bindHandler, chainCosign, chainCosignOnly, serveBind, waitingOf } from "../../packages/runtime/src/bind.ts";
import { installAgentFirewall } from "../../packages/runtime/src/firewall.ts";
import { parseConfig, Runtime, type Backend } from "../../packages/runtime/src/index.ts";
import { Reservations } from "../../packages/runtime/src/reserve.ts";
import { launchTable } from "../devnet/pump-lib.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PORT = Number(arg("port", "9668"));
if (![9663, 9666, 9667, 9668, 9669].includes(PORT)) throw new Error("ports 9663 and 9666 to 9669 only");
const T0 = Date.now();
const log = (m: string) => console.log(`[bind-devnet +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 400)}` : ""}`);
  return ok;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC_URL = devnetRpcUrl();
const rpc = Rpc.http(RPC_URL, "confirmed");
const reader = new ChainReader(rpc);
await assertDevnet(rpc);
const state = JSON.parse(await Bun.file(join(import.meta.dir, "..", "devnet", "devnet.json")).text());
const launcher = loadKeypair(join(homedir(), ".config", "lineage", "devnet", "launch-e2e-test.json"));

// ---------------------------------------------------------------- the local runtime's bind endpoint
if ((await Bun.$`lsof -ti :${PORT}`.nothrow().text()).trim()) throw new Error(`port ${PORT} is in use; pass --port with a free one of 9663, 9666 to 9669`);
const stateDir = mkdtempSync(join(tmpdir(), "units-bind-devnet-"));
const rtLog: string[] = [];
const rlog = (m: string) => void rtLog.push(m);
const backend = {
  mode: "devnet",
  hostedAgent: async (a: string) => {
    const rec = await reader.agent(a);
    if (!rec || rec.kind !== "launched" || !rec.hosted) return null;
    const l = await reader.agentLaunch(rec.mint);
    return l && l.agent === a && l.hosted ? { agent: a, mint: l.mint, launcher: l.launcher, target_repo: l.repoUrl } : null;
  },
  discover: async () => [],
  bindRequest: async (a: string, k: AgentKey) => ({ agent: a, new_key: k.id }),
  signingKey: async (a: string) => (await reader.agent(a))?.signingKey ?? null,
} as unknown as Backend;
const cfg = parseConfig({ mode: "devnet", core: "http://127.0.0.1:1", runtime_key: "/dev/null", state_dir: stateDir, compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002" });
const rt = new Runtime(cfg, { backend, runtimeKey: generateAgentKey(), proposer: () => ({ name: "none", propose: async () => null }), log: rlog, telemetry: false });
const reservations = new Reservations({ dir: stateDir, keyFor: (a) => rt.store.keyFor(a), keyFile: (a) => rt.store.keyFile(a), adopted: (a) => !!rt.state.agents[a], adopt: async (a) => !!(await rt.bindTarget(a)), log: rlog });
installAgentFirewall({ rpc, stateDir, view: { agents: () => ({ ...reservations.agents(), ...rt.state.agents }) }, log: rlog });
for (const s of Object.values(rt.state.agents)) guardKey(s.key_id);
const server = serveBind(PORT, bindHandler({
  host: rt,
  send: chainCosign(RPC_URL, rlog, DEVNET_GENESIS),
  reserve: { reservations, recordExists: async (a) => !!(await reader.agent(a)), sign: chainCosignOnly },
  waiting: waitingOf({ agents: () => rt.state.agents, launcherOf: async (a) => (await backend.hostedAgent!(a))?.launcher ?? null }),
  log: rlog,
}), rlog);
const RUNTIME = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- the page's modules, outside a page
const realFetch = globalThis.fetch;
(globalThis as any).window ??= globalThis;
const runtimeCalls: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url === "/chain/config") return Response.json({ rpc: "/chain/rpc", rpc_upstream: "devnet", genesis: DEVNET_GENESIS, cluster: "devnet", devnet: true, state, faucet: null, profile: DEVNET_PUBLIC_PROFILE });
  if (url === "/chain/rpc") return realFetch(RPC_URL, init);
  if (url.startsWith("/runtime/")) {
    runtimeCalls.push(`${init?.method ?? "GET"} ${url.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/, "<id>")}${init?.body ? ` ${Object.keys(JSON.parse(init.body)).join("+")}` : ""}`);
    return realFetch(`${RUNTIME}${url}`, init);
  }
  return realFetch(input, init);
}) as any;
const C = await import("../../apps/web/wallet/chain.ts");
const P = await import("../../apps/web/wallet/bind-plan.ts");
const B = await import("../../apps/web/wallet/bind.ts");
await C.loadChainCfg();
if (C.isMainnet()) throw new Error("the page profile is not devnet");

/** A Wallet Standard wallet that signs with the test key; every request it gets is recorded (how many transactions, which programs). */
const requests: { txs: number; versions: string[]; programs: string[][] }[] = [];
const wallet: any = {
  name: "units devnet test wallet",
  features: {
    "standard:connect": { connect: async () => ({ accounts: [account] }) },
    "solana:signTransaction": {
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
        const ds = inputs.map((i) => decodeMessage(parseWire(i.transaction).message));
        requests.push({ txs: inputs.length, versions: ds.map((d) => String(d.version)), programs: ds.map((d) => [...new Set(d.instructions.map((x) => x.programId.slice(0, 6)))]) });
        return inputs.map((i) => ({ signedTransaction: placeSignature(i.transaction, launcher.id, signBytes(launcher, parseWire(i.transaction).message)) }));
      },
    },
  },
};
const account: any = { address: launcher.id, publicKey: launcher.secret.subarray(32), chains: ["solana:devnet"] };
const webKey = (k: AgentKey) => ({ id: k.id, sign: async (m: Uint8Array) => signBytes(k, m), exportSolanaJson: async () => [] });

async function fund() {
  const bal = await rpc.getBalance(launcher.id);
  if (bal >= 250_000_000n) return;
  const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
  const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, launcher.id, 400_000_000n - bal)]);
  log(`funded the test launcher with ${Number(400_000_000n - bal) / 1e9} devnet SOL from the units devnet deployer: ${r.signature}`);
}

let table: LookupTable | null = null;
let seq = 0;
/** The launch transactions of a fresh hosted agent, as the page's bundle parts (the launcher pays; the agent and mint keys co-sign locally). */
async function launchParts(tag: string) {
  const agent = generateAgentKey(), mint = generateAgentKey();
  const n = `${Date.now().toString(36).slice(-5)}${seq++}`.toUpperCase();
  const main = pumpLaunchMain({ launcher: launcher.id, agent: agent.id, agentMint: mint.id, line: { mint: state.line_mint, tokenProgram: TOKEN_2022_PROGRAM, pool: state.line_pool }, name: `TEST bind ${tag} ${n}`.slice(0, 32),
    symbol: `TB${n}`.slice(0, 10), uri: `https://units.invalid/devnet/bind-${tag}-${n}.json`, args: { repoUrl: "https://github.com/keis/base58", identityMode: IDENTITY_MODE.app, hosted: true } });
  const plan = planLaunch({ payer: launcher.id, main, soul: null, budget: [computeBudget.limit(600_000)], table, v0: true });
  const parts = plan.txs.map((t: { ixs: Ix[]; table: LookupTable | null }, i: number) => {
    const named = new Set(t.ixs.flatMap((x) => x.keys.filter((k) => k.isSigner).map((k) => k.pubkey)));
    return { ixs: t.ixs, units: 600_000, table: t.table, label: i === 0 ? "launch" : `launch ${i + 1}`, local: [agent, mint].filter((k) => named.has(k.id)).map(webKey) };
  });
  return { agent, mint, parts };
}
const slotOf = async (sig: string) => (await rpc.getTransaction(sig))?.slot ?? null;
const out: Record<string, unknown> = { at: new Date().toISOString(), network: "devnet", launcher: launcher.id, runtime: "local bind endpoint (Runtime.bindTarget, reserve.ts, bind.ts, firewall, cosign.ts); no Core, no model" };

try {
  await fund();
  table = await launchTable(rpc, state as never);
  const sol0 = await rpc.getBalance(launcher.id);

  // ================================================================ A: one approval ends in a bound agent
  {
    const { agent, mint, parts } = await launchParts("a");
    const key = await P.reserveRuntimeKey(agent.id);
    check("A: the runtime reserves its key for an agent that is not on chain yet", !!key && key.status === "reserved" && (await reader.agent(agent.id)) === null, key ? `runtime key ${key.new_key}, status ${key.status}; agent ${agent.id} has no record on chain` : "no key");
    if (!key) throw new Error("no reservation");
    const all = P.withBind(parts, P.bindPart({ owner: launcher.id, agent: agent.id, newKey: key.new_key, v0: parts.some((p: any) => p.table) }), { mainnet: false });
    const r0 = requests.length, t0 = Date.now();
    const h0 = await rpc.getBlockHeight();
    const lines: string[] = [];
    const r = await C.signAndSendAll({ wallet, account, parts: all, onStatus: (s) => void lines.push(s) });
    const ms = Date.now() - t0;
    const mine = requests.slice(r0);
    check("A: the wallet was asked once, for the launch and the bind together", mine.length === 1 && mine[0]!.txs === parts.length + 1, `requests ${JSON.stringify(mine.map((x) => x.txs))}; message versions ${mine[0]?.versions.join(", ")}`);
    check("A: everything landed, the bind among it; nothing was left over", !r.failed && r.left.length === 0 && r.landed.map((x) => x.label).join(",") === [...parts.map((p: any) => p.label), P.BIND_LABEL].join(","), `${r.landed.map((x) => `${x.label} ${x.confirmed.signature}`).join("; ")}${r.failed ? `; failed ${JSON.stringify(r.failed)}` : ""}${r.left.length ? `; left ${JSON.stringify(r.left.map((l) => l.why))}` : ""}`);
    const rec = await reader.agent(agent.id);
    check("A: on chain the agent's signing key is the runtime's reserved key (one rotation), its owner the launcher, hosted", rec?.signingKey === key.new_key && rec?.keySeq === 1 && rec?.owner === launcher.id && !!rec?.hosted, `signing key ${rec?.signingKey}, key changes ${rec?.keySeq}`);
    const [ls, bs] = [await slotOf(r.landed[0]!.confirmed.signature), await slotOf(r.landed.at(-1)!.confirmed.signature)];
    const h1 = await rpc.getBlockHeight();
    const t = await B.finishBind({ agent: agent.id, wallet, account, say: () => {}, tries: 3 });
    check("A: nothing more to do afterwards: the page's finish routine finds it bound and asks the wallet for nothing", t.signature === null && t.newKey === key.new_key && requests.length === r0 + 1, `runtime GET status ${(await P.runtimeKeyOf(agent.id))?.status}`);
    check("A: the runtime adopted the agent with the reserved key (no second key was made)", rt.keyOf(agent.id)?.id === key.new_key && reservations.get(agent.id) === null, `state ${rt.state.agents[agent.id]?.status}`);
    out.A = { agent: agent.id, mint: mint.id, runtime_key: key.new_key, signatures: r.landed.map((x) => ({ label: x.label, signature: x.confirmed.signature })), launch_slot: ls, bind_slot: bs, ms_from_approval_request_to_bound: ms, block_heights_used: h1 - h0, wallet_requests: mine };
    log(`A: ${ms} ms from asking the wallet to the bind confirmed; ${h1 - h0} block heights of the blockhash's 150 used; launch slot ${ls}, bind slot ${bs}`);
  }

  // ================================================================ B: no co-signature before the send; still one approval
  {
    const { agent, mint, parts } = await launchParts("b");
    const key = (await P.reserveRuntimeKey(agent.id))!;
    // the runtime cannot be reached at that one moment
    const bind = P.bindPart({ owner: launcher.id, agent: agent.id, newKey: key.new_key, v0: parts.some((p: any) => p.table), cosign: async () => { throw new Error("the hosted runtime did not answer"); } });
    const r0 = requests.length, t0 = Date.now(), h0 = await rpc.getBlockHeight();
    const r = await C.signAndSendAll({ wallet, account, parts: P.withBind(parts, bind, { mainnet: false }) });
    const why = P.keepSignedBind(agent.id, key.new_key, r.left);
    const before = await reader.agent(agent.id);
    check("B: the launch landed without the bind, which was not sent and is kept signed", !r.failed && r.landed.length === parts.length && r.left.length === 1 && !!r.left[0]!.partial && before?.signingKey === agent.id, `left: ${why}; signing key on chain still the launch key`);
    const said: string[] = [];
    const t = await B.finishBind({ agent: agent.id, wallet, account, say: (l) => void said.push(l), tries: 5 });
    const ms = Date.now() - t0, h1 = await rpc.getBlockHeight();
    const rec = await reader.agent(agent.id);
    check("B: the runtime co-signed and sent the bind the wallet had already signed: bound, and the wallet was asked only once in all", rec?.signingKey === key.new_key && requests.length === r0 + 1 && !!t.signature, `rotation ${t.signature}; the page said: ${said.join(" | ")}`);
    out.B = { agent: agent.id, mint: mint.id, runtime_key: key.new_key, rotation: t.signature, ms_from_approval_request_to_bound: ms, block_heights_used: h1 - h0, page_lines: said };
    log(`B: ${ms} ms from asking the wallet to bound; ${h1 - h0} block heights of 150 used`);
  }

  // ================================================================ C: an agent launched with no bind at all
  {
    const { agent, mint, parts } = await launchParts("c");
    const r0 = requests.length;
    const r = await C.signAndSendAll({ wallet, account, parts });
    check("C: a hosted agent launched the old way sits unbound", !r.failed && (await reader.agent(agent.id))?.signingKey === agent.id, r.landed.map((x) => x.confirmed.signature).join(", "));
    // the runtime learns of it (on the site its discovery does; here the page's first question does the same on demand)
    const first = await P.runtimeKeyOf(agent.id);
    const list = await (await fetch(`/runtime/unbound/${launcher.id}`)).json();
    const other = await (await fetch(`/runtime/unbound/${generateAgentKey().id}`)).json();
    check("C: the runtime lists it for its launcher (the bar's one read) and for nobody else", first?.status === "awaiting_owner" && list.agents.some((x: any) => x.agent === agent.id && x.new_key === first.new_key) && other.agents.length === 0,
      `unbound for the launcher: ${list.agents.length}; for another wallet: ${other.agents.length}`);
    const said: string[] = [];
    const t = await B.finishBind({ agent: agent.id, wallet, account, say: (l) => void said.push(l), tries: 3 });
    const rec = await reader.agent(agent.id);
    const mine = requests.slice(r0 + 1);
    check("C: Finish setup binds it with one signature of one transaction", rec?.signingKey === first!.new_key && mine.length === 1 && mine[0]!.txs === 1 && !!t.signature, `rotation ${t.signature}; the page said: ${said.join(" | ")}`);
    out.C = { agent: agent.id, mint: mint.id, runtime_key: first!.new_key, rotation: t.signature, page_lines: said };

    // ============================================================== D: what the live runtime refuses
    const post = async (a: string, body: unknown) => {
      const x = await realFetch(`${RUNTIME}/runtime/bind/${a}`, { method: "POST", body: JSON.stringify(body) });
      return { status: x.status, body: (await x.json().catch(() => ({}))) as any };
    };
    const signed = (ixs: Ix[]) => {
      const m = compileMessage(launcher.id, ixs, DEVNET_GENESIS);
      return Buffer.from(placeSignature(unsignedWire(m), launcher.id, signBytes(launcher, m.bytes))).toString("base64");
    };
    const fresh = generateAgentKey().id;
    const k2 = (await post(fresh, { reserve: true })).body.new_key as string;
    const d = {
      bound_again: await post(agent.id, { tx: signed([registry.rotateAgentKey({ owner: launcher.id, agent: agent.id, newKey: first!.new_key })]), sign_only: true }),
      other_record: await post(fresh, { tx: signed([registry.rotateAgentKey({ owner: launcher.id, agent: agent.id, newKey: k2 })]), sign_only: true }),
      with_transfer: await post(fresh, { tx: signed([registry.rotateAgentKey({ owner: launcher.id, agent: fresh, newKey: k2 }), system.transfer(launcher.id, k2, 1n)]), sign_only: true }),
      send_before_launch: await post(fresh, { tx: signed([registry.rotateAgentKey({ owner: launcher.id, agent: fresh, newKey: k2 })]) }),
      no_reservation: await post(generateAgentKey().id, { tx: signed([registry.rotateAgentKey({ owner: launcher.id, agent: fresh, newKey: k2 })]), sign_only: true }),
      existing_self_reserve: await post(launcher.id, { reserve: true }),
    };
    // the runtime only learns that C is bound on its next pass; its state still says awaiting, and the chain would refuse nothing here, so the co-sign is allowed: reported as it is
    check("D: the live runtime refuses a rotation of another record, a rotation with a transfer beside it, sending for an agent that is not on chain, and signing with no reservation",
      d.other_record.status === 400 && d.with_transfer.status === 400 && d.send_before_launch.status === 404 && d.no_reservation.status === 404,
      Object.entries(d).map(([k, v]) => `${k} ${v.status} ${v.body.error ?? "ok"}`).join("; "));
    out.D = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { status: v.status, error: v.body.error ?? null, message: v.body.message ?? null }]));
  }
  const sol1 = await rpc.getBalance(launcher.id);
  out.devnet_sol_spent = Number(sol0 - sol1) / 1e9;
  out.runtime_requests = runtimeCalls;
  out.firewall = { log: "every co-sign passed the transaction firewall", allowed: rtLog.filter((l) => /co-signed|bound hosted/.test(l)).length };
} catch (e) {
  check("run completed", false, String((e as Error).stack ?? e).slice(0, 900));
} finally {
  server.stop(true);
  globalThis.fetch = realFetch;
  out.results = results;
  out.passed = results.filter((r) => r.ok).length;
  out.total = results.length;
  writeFileSync(join(import.meta.dir, "BIND-DEVNET-LAST.json"), JSON.stringify(out, null, 2) + "\n");
  rmSync(stateDir, { recursive: true, force: true }); // throwaway runtime keys of TEST agents on devnet
  log(`${results.filter((r) => r.ok).length}/${results.length} checks passed; scripts/launch-e2e/BIND-DEVNET-LAST.json`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
