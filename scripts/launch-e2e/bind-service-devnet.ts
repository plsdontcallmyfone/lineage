#!/usr/bin/env bun
// The bind service on DEVNET, end to end (docs/plans/SEAMLESS-BIND.md sections 9 and 10). Real devnet
// transactions with the launch lane's devnet test key; nothing here can reach mainnet (devnet-process
// pins the network and every send asserts the devnet genesis).
//
// What is real: the bind service as its own process (`packages/runtime/src/main.ts bind`, the command
// the units-bind unit runs) on a throwaway state directory; the page's own code (apps/web/wallet
// chain.ts signAndSendAll, bind-plan.ts) run under bun with /chain/rpc routed to devnet and /runtime/*
// to that process; the deployed devnet programs; a Wallet Standard wallet object that signs with the
// test key and counts every request. The hosted runtime's agent loop is a stand-in process that holds
// the runtime's lock and state on the same directory; after each case the real Runtime class adopts the
// agent from that directory and must find the key the service reserved.
//
//   A1  the agent loop gets SIGTERM while the wallet is approving, drains and starts again; the bind
//       service stays up: launch and bind land from the one approval
//   A2  the co-signature never reaches the page and the tab is closed right after the launch was sent:
//       the service sends the rotation it kept; nothing more is signed
//   B   (--backup) the key pool and the backup signature: the launch lands without its bind, the bind
//       service is stopped for longer than a blockhash lives, then started: bound from the kept
//       never-expiring signature, the nonce advanced, a second send refused, the rent back to the payer
//   C   (--required) no reservation can be had: the launch is refused and the wallet is never asked
//
// Usage: bun scripts/launch-e2e/bind-service-devnet.ts [--port 9666] [--backup] [--required] [--down-s 300]
import "../../packages/chain/src/devnet-process.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { ChainReader, computeBudget, IDENTITY_MODE, loadKeypair, planLaunch, pumpLaunchMain, Rpc, sendAndConfirm, signBytes, system, TOKEN_2022_PROGRAM, type Ix, type LookupTable } from "@units/chain";
import { assertDevnet, DEVNET_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { decodeMessage, parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { DEVNET_PUBLIC_PROFILE } from "../../packages/chain/src/profile.ts";
import { parseConfig, Runtime, type Backend } from "../../packages/runtime/src/index.ts";
import { launchTable } from "../devnet/pump-lib.ts";

const has = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string, d?: string) => (has(n) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PORT = Number(arg("port", "9666"));
if (![9663, 9666, 9667, 9668, 9669].includes(PORT)) throw new Error("ports 9663 and 9666 to 9669 only");
const DOWN_S = Number(arg("down-s", "300"));
const ROOT = join(import.meta.dir, "../..");
const T0 = Date.now();
const log = (m: string) => console.log(`[bind-service-devnet +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  return ok;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A read that is tried again: after minutes of silence the first request may meet a connection the other side has closed. */
async function retryRead<T>(f: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1500);
    }
  }
}

const RPC_URL = devnetRpcUrl();
const rpc = Rpc.http(RPC_URL, "confirmed");
const reader = new ChainReader(rpc);
await assertDevnet(rpc);
const state = JSON.parse(await Bun.file(join(import.meta.dir, "..", "devnet", "devnet.json")).text());
const launcher = loadKeypair(join(homedir(), ".config", "lineage", "devnet", "launch-e2e-test.json"));
if ((await Bun.$`lsof -ti :${PORT}`.nothrow().text()).trim()) throw new Error(`port ${PORT} is in use; pass --port with a free one of 9663, 9666 to 9669`);

// ---------------------------------------------------------------- the processes
const dir = mkdtempSync(join(tmpdir(), "units-bindsvc-devnet-"));
const stateDir = join(dir, "runtime");
const cfgFile = join(dir, "runtime.json");
// the pool's payer in case B: a throwaway key funded from the test launcher, standing in for the runtime authority
const poolPayer = generateAgentKey();
const payerFile = join(dir, "payer.json");
writeFileSync(payerFile, JSON.stringify(Array.from(poolPayer.secret)), { mode: 0o600 });
const cfgBody = { mode: "devnet", core: "http://127.0.0.1:1", runtime_key: has("backup") ? payerFile : "/dev/null", state_dir: stateDir, rpc_url: RPC_URL, compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002", bind_port: 1, bind_service_port: PORT,
  bind_pool: { enabled: true, target: 2, low: 2, cap: 4, per_pass: 2, payer_floor_lamports: 1_000_000 } };
writeFileSync(cfgFile, JSON.stringify(cfgBody), { mode: 0o600 });
const env = { ...process.env, UNITS_NETWORK: "devnet" };
const svcLog = join(dir, "bind.log");
// the runtime this state directory belongs to (its state file names it): the stand-in loop and the real Runtime class below are the same runtime
const rtKey = generateAgentKey();
const children = new Set<ReturnType<typeof Bun.spawn>>();
const spawn = (cmd: string[], out?: string) => {
  const p = Bun.spawn(cmd, { cwd: ROOT, env, stdout: out ? Bun.file(out) : "ignore", stderr: out ? Bun.file(`${out}.err`) : "inherit" });
  children.add(p);
  void p.exited.then(() => children.delete(p));
  return p;
};
let svcRuns = 0;
const startBind = () => spawn([process.execPath, "packages/runtime/src/main.ts", "bind", "--config", cfgFile, "--port", String(PORT)], `${svcLog}.${++svcRuns}`);
const svcLines = () => Array.from({ length: svcRuns }, (_, i) => (existsSync(`${svcLog}.${i + 1}`) ? readFileSync(`${svcLog}.${i + 1}`, "utf8") : "")).join("");
/** The agent loop's stand-in: the runtime's lock and state on the same directory; SIGTERM makes it drain 3 s, then leave. */
const startLoop = () =>
  spawn([process.execPath, "-e", `
    import { Lock, StateStore } from ${JSON.stringify(join(ROOT, "packages/runtime/src/state.ts"))};
    const lock = new Lock(${JSON.stringify(stateDir)}); lock.acquire();
    const store = new StateStore(${JSON.stringify(stateDir)}, { mode: "devnet", runtime: ${JSON.stringify(rtKey.id)}, now: 0 });
    const t = setInterval(() => store.save(), 200);
    process.on("SIGTERM", () => { clearInterval(t); setTimeout(() => { lock.release(); process.exit(0); }, 3000); });
    await new Promise(() => {});`]);
const RUNTIME = `http://127.0.0.1:${PORT}`;
const health = async () => (await fetch0(`${RUNTIME}/runtime/bind/health`).then((r) => r.json()).catch(() => null)) as null | { ok: boolean; kept: number; counters: { bound_with_launch: number; bound_after: number; sent_by_service: number; launches_unbound: number; bound_by_backup: number }; backup?: { ok: boolean; ready: number; why: string | null } };
const realFetch = globalThis.fetch;
const fetch0 = (u: string, i?: RequestInit) => realFetch(u, { ...i, signal: AbortSignal.timeout(8000) });
const up = async (ms = 30_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) if ((await health())?.ok !== undefined) return;
  throw new Error("the bind service did not come up");
};

// ---------------------------------------------------------------- the page's modules, outside a page
(globalThis as any).window ??= globalThis;
let runtimeDown = false;
const runtimeCalls: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url === "/chain/config") return Response.json({ rpc: "/chain/rpc", rpc_upstream: "devnet", genesis: DEVNET_GENESIS, cluster: "devnet", devnet: true, state, faucet: null, profile: DEVNET_PUBLIC_PROFILE });
  if (url === "/chain/rpc") return realFetch(RPC_URL, init);
  if (url.startsWith("/runtime/")) {
    runtimeCalls.push(`${init?.method ?? "GET"} ${url.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/, "<id>")}${init?.body ? ` ${Object.keys(JSON.parse(init.body)).join("+")}` : ""}`);
    // what the site's gate answers when the bind service does not answer it
    if (runtimeDown) return Response.json({ error: "upstream_unreachable" }, { status: 502 });
    return realFetch(`${RUNTIME}${url}`, init);
  }
  return realFetch(input, init);
}) as any;
const C = await import("../../apps/web/wallet/chain.ts");
const P = (await import("../../apps/web/wallet/bind-plan.ts")) as any;
await C.loadChainCfg();
if (C.isMainnet()) throw new Error("the page profile is not devnet");

const requests: { txs: number; programs: string[][] }[] = [];
let onApprove: (() => void | Promise<void>) | null = null;
const wallet: any = {
  name: "units devnet test wallet",
  features: {
    "standard:connect": { connect: async () => ({ accounts: [account] }) },
    "solana:signTransaction": {
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
        const ds = inputs.map((i) => decodeMessage(parseWire(i.transaction).message));
        requests.push({ txs: inputs.length, programs: ds.map((d) => [...new Set(d.instructions.map((x) => x.programId.slice(0, 6)))]) });
        await onApprove?.();
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
async function launchParts(tag: string) {
  const agent = generateAgentKey(), mint = generateAgentKey();
  const n = `${Date.now().toString(36).slice(-5)}${seq++}`.toUpperCase();
  const main = pumpLaunchMain({ launcher: launcher.id, agent: agent.id, agentMint: mint.id, line: { mint: state.line_mint, tokenProgram: TOKEN_2022_PROGRAM, pool: state.line_pool }, name: `TEST bindsvc ${tag} ${n}`.slice(0, 32),
    symbol: `TS${n}`.slice(0, 10), uri: `https://units.invalid/devnet/bindsvc-${tag}-${n}.json`, args: { repoUrl: "https://github.com/keis/base58", identityMode: IDENTITY_MODE.app, hosted: true } });
  const plan = planLaunch({ payer: launcher.id, main, soul: null, budget: [computeBudget.limit(600_000)], table, v0: true });
  const parts = plan.txs.map((t: { ixs: Ix[]; table: LookupTable | null }, i: number) => {
    const named = new Set(t.ixs.flatMap((x) => x.keys.filter((k) => k.isSigner).map((k) => k.pubkey)));
    return { ixs: t.ixs, units: 600_000, table: t.table, label: i === 0 ? "launch" : `launch ${i + 1}`, local: [agent, mint].filter((k) => named.has(k.id)).map(webKey) };
  });
  return { agent, mint, parts };
}
const boundTo = async (agent: string, key: string, ms: number) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(1500)) if ((await reader.agent(agent).catch(() => null))?.signingKey === key) return true;
  return false;
};
/** The real Runtime class on the same state directory (the agent loop is stopped for it): the agent it adopts must carry the reserved key. */
async function runtimeAdopts(agent: string): Promise<string | null> {
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
  const rt = new Runtime(cfg, { backend, runtimeKey: rtKey, proposer: () => ({ name: "none", propose: async () => null }), log: () => {}, telemetry: false } as any);
  try {
    return (await rt.bindTarget(agent))?.new_key ?? null;
  } finally {
    (rt as any).lock?.release?.();
  }
}

const out: Record<string, unknown> = { at: new Date().toISOString(), network: "devnet", launcher: launcher.id, commit: (await Bun.$`git -C ${ROOT} rev-parse --short HEAD`.text()).trim(), bind_service: "its own process: packages/runtime/src/main.ts bind" };
let bind = startBind();
let loop = startLoop();
try {
  await up();
  await fund();
  table = await launchTable(rpc, state as never);
  const sol0 = await rpc.getBalance(launcher.id);
  const h0 = (await health())!;

  // ================================================================ A1: the agent loop restarts while the wallet approves
  {
    const { agent, mint, parts } = await launchParts("a1");
    const key = await P.reserveRuntimeKey(agent.id);
    if (!key) throw new Error("no reservation");
    let restarted = "";
    onApprove = async () => {
      const t = Date.now();
      loop.kill("SIGTERM"); // it drains for 3 s; the launch goes on meanwhile
      void loop.exited.then(() => {
        loop = startLoop();
        restarted = `left after ${Date.now() - t} ms, started again`;
      });
    };
    const all = P.withBind(parts, P.bindPart({ owner: launcher.id, agent: agent.id, newKey: key.new_key, v0: true, required: true }), { mainnet: false });
    const r0 = requests.length, t0 = Date.now();
    const r = await C.signAndSendAll({ wallet, account, parts: all });
    onApprove = null;
    const ms = Date.now() - t0;
    const rec = await reader.agent(agent.id);
    check("A1: the agent loop was told to stop while the wallet approved, and the launch still got its co-signature from the bind service", !r.failed && r.left.length === 0 && r.landed.some((x: any) => x.label === P.BIND_LABEL), `${r.landed.map((x: any) => `${x.label} ${x.confirmed.signature.slice(0, 12)}…`).join("; ")}`);
    check("A1: one wallet request; on chain the signing key is the reserved runtime key after one rotation", requests.length === r0 + 1 && rec?.signingKey === key.new_key && rec?.keySeq === 1 && !!rec?.hosted, `requests ${requests.length - r0}, ${requests[r0]?.txs} transactions; signing key ${rec?.signingKey}; ${ms} ms from asking the wallet to bound`);
    for (let i = 0; i < 80 && !restarted; i++) await sleep(100);
    check("A1: the agent loop drained and started again during the launch", !!restarted, restarted);
    for (let i = 0; i < 20 && ((await health())?.kept ?? 1) > 0; i++) await sleep(1000);
    const h = (await health())!;
    // devnet sends in order, so the service may read the record between the launch and the bind ("bound after"); either way it sent nothing
    check("A1: the service saw it bound by the page's own send and sent nothing itself", h.counters.bound_with_launch + h.counters.bound_after === h0.counters.bound_with_launch + h0.counters.bound_after + 1 && h.counters.sent_by_service === h0.counters.sent_by_service && h.kept === 0, JSON.stringify(h.counters));
    out.A1 = { agent: agent.id, mint: mint.id, runtime_key: key.new_key, signatures: r.landed.map((x: any) => ({ label: x.label, signature: x.confirmed.signature })), ms_from_approval_request_to_bound: ms, agent_loop: restarted };
    loop.kill("SIGTERM");
    await loop.exited;
    check("A1: the runtime adopts the agent from the shared key store with the key the service reserved", (await runtimeAdopts(agent.id)) === key.new_key);
    loop = startLoop();
  }

  // ================================================================ A2: no co-signature reaches the page, the tab is closed
  {
    const { agent, mint, parts } = await launchParts("a2");
    const key = (await P.reserveRuntimeKey(agent.id))!;
    const h1 = (await health())!;
    // the service gets the wallet-signed rotation and co-signs it; its answer never reaches the page
    const lost = async (a: string, wire: Uint8Array) => {
      await P.runtimeCosign(a, wire);
      throw new Error("the answer was lost on the way back");
    };
    const all = P.withBind(parts, P.bindPart({ owner: launcher.id, agent: agent.id, newKey: key.new_key, v0: true, cosign: lost }), { mainnet: false });
    const r0 = requests.length, t0 = Date.now();
    const r = await C.signAndSendAll({ wallet, account, parts: all });
    const before = await reader.agent(agent.id);
    check("A2: the launch landed without its bind (the page never had the co-signed rotation)", !r.failed && r.landed.length === parts.length && before?.signingKey === agent.id, `left: ${r.left.map((l: any) => l.why).join("; ")}`);
    // the tab is closed here: nothing of the page runs any more for this agent
    const ok = await boundTo(agent.id, key.new_key, 60_000);
    const ms = Date.now() - t0;
    const h = (await health())!;
    check("A2: the bind service sent the rotation it kept: bound, with one wallet request in all and nothing asked of the page", ok && requests.length === r0 + 1, `${ms} ms from asking the wallet to bound`);
    for (let i = 0; i < 10 && ((await health())?.kept ?? 1) > 0; i++) await sleep(1000);
    const hEnd = (await health())!;
    check("A2: counted as sent by the service and bound after the launch", hEnd.counters.sent_by_service === h1.counters.sent_by_service + 1 && hEnd.counters.bound_after === h1.counters.bound_after + 1 && hEnd.counters.launches_unbound === h1.counters.launches_unbound, JSON.stringify(hEnd.counters));
    void h;
    const line = svcLines().split("\n").find((l) => l.includes("sent the kept rotation") && l.includes(agent.id)) ?? "";
    out.A2 = { agent: agent.id, mint: mint.id, runtime_key: key.new_key, ms_from_approval_request_to_bound: ms, service_log: line.replace(/^\[[^\]]*\]\s*/, "") };
    loop.kill("SIGTERM");
    await loop.exited;
    check("A2: the runtime adopts it with the same key", (await runtimeAdopts(agent.id)) === key.new_key);
    loop = startLoop();
  }

  // ================================================================ C: bind required, no reservation to be had
  if (has("required")) {
    const { agent } = await launchParts("c");
    runtimeDown = true;
    const r0 = requests.length, c0 = runtimeCalls.length, t0 = Date.now();
    const said: string[] = [];
    let err: Error | null = null;
    try {
      await P.reserveRequired(agent.id, { say: (l: string) => void said.push(l), totalMs: 8_000 });
    } catch (e) {
      err = e as Error;
    }
    runtimeDown = false;
    check("C: with no reservation to be had the launch is refused in one sentence, after trying for a while", err instanceof P.BindUnavailable && (err as Error).message === P.BIND_NO_KEY && said[0] === P.BIND_WAIT_LINE, `after ${Date.now() - t0} ms and ${runtimeCalls.length - c0} tries; said "${said.join(" | ")}"; refused with "${err?.message}"`);
    check("C: the wallet was never asked and nothing is on chain for that agent", requests.length === r0 && (await reader.agent(agent.id)) === null);
    // and it comes back by itself: a reservation that is slow, then answers
    runtimeDown = true;
    setTimeout(() => (runtimeDown = false), 3_000);
    const t1 = Date.now();
    const k = await P.reserveRequired(agent.id, { totalMs: 15_000 }).catch(() => null);
    check("C: a reservation that answers late is waited for, not refused", !!k?.new_key, `key after ${Date.now() - t1} ms`);
    out.C = { refusal: err?.message, waiting_line: said[0], tries: runtimeCalls.length - c0 };
  }

  // ================================================================ B: the backup signature across a long stop
  if (has("backup")) {
    const { nonceAccountFor, decodeNonceAccount } = await import("../../packages/chain/src/nonce.ts");
    const fundSig = (await sendAndConfirm(rpc, launcher, [system.transfer(launcher.id, poolPayer.id, 12_000_000n)])).signature;
    log(`B: pool payer ${poolPayer.id} (a throwaway key standing in for the runtime authority) funded with 0.012 devnet SOL: ${fundSig}`);
    const pool = async (fill = true) => {
      const p = Bun.spawn([process.execPath, "packages/runtime/src/main.ts", "pool", "--config", cfgFile, ...(fill ? ["--fill"] : [])], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
      const text = await new Response(p.stdout).text();
      await p.exited;
      return { status: JSON.parse(text.slice(text.lastIndexOf("\n{") + 1)) as Record<string, any>, log: text };
    };
    const payer0 = await rpc.getBalance(poolPayer.id);
    const filled = await pool();
    const rent = BigInt(filled.status.rent_lamports);
    check("B: the pool made its keys, each with a nonce account the payer funded", filled.status.ok && filled.status.ready === 2 && filled.status.alive === 2 && filled.status.locked_lamports === (rent * 2n).toString(), `ready ${filled.status.ready}, rent ${rent} lamports each, locked ${filled.status.locked_lamports}; payer ${payer0} -> ${filled.status.payer_lamports}`);
    const { agent, mint, parts } = await launchParts("b");
    const key = await P.reserveRuntimeKey(agent.id);
    if (!key?.nonce) throw new Error(`the reservation carries no nonce account: ${JSON.stringify(key)}`);
    const onChain0 = decodeNonceAccount((await rpc.getAccountInfo(key.nonce.account))!.data);
    check("B: the reservation hands out a pool key with its nonce account and the value stored on chain", key.nonce.account === nonceAccountFor(poolPayer.id, key.new_key) && onChain0?.authority === key.new_key && onChain0?.value === key.nonce.value, `key ${key.new_key}, nonce account ${key.nonce.account}, value ${key.nonce.value}`);
    // what the live service refuses to co-sign as a backup, asked over HTTP with real wallet signatures
    {
      const { nonce: nonceIx, registry, compileMessage } = await import("@units/chain");
      const { unsignedWire } = await import("../../packages/chain/src/browser/wire.ts");
      const other = generateAgentKey().id;
      const k2 = await P.reserveRuntimeKey(other);
      const post = async (ixs: Ix[], value: string) => {
        const m = compileMessage(launcher.id, ixs, value);
        const tx = Buffer.from(placeSignature(unsignedWire(m), launcher.id, signBytes(launcher, m.bytes))).toString("base64");
        const x = await realFetch(`${RUNTIME}/runtime/bind/${agent.id}`, { method: "POST", body: JSON.stringify({ tx, sign_only: true }) });
        return { status: x.status, message: String(((await x.json().catch(() => ({}))) as any).message ?? "").slice(0, 120) };
      };
      const adv = nonceIx.advance(key.nonce.account, key.new_key);
      const rot = registry.rotateAgentKey({ owner: launcher.id, agent: agent.id, newKey: key.new_key });
      const d = {
        with_a_transfer: await post([adv, rot, system.transfer(launcher.id, agent.id, 1n)], key.nonce.value),
        another_nonce_account: k2?.nonce ? await post([nonceIx.advance(k2.nonce.account, key.new_key), rot], k2.nonce.value) : { status: 0, message: "no second pool key" },
        another_agent: await post([adv, registry.rotateAgentKey({ owner: launcher.id, agent: other, newKey: key.new_key })], key.nonce.value),
        advance_not_first: await post([computeBudget.limit(200_000), adv, rot], key.nonce.value),
        a_withdrawal: await post([nonceIx.withdraw(key.nonce.account, launcher.id, key.new_key, 1n), rot], key.nonce.value),
      };
      check("B: the live service refuses a backup with another instruction, over another key's nonce account, for another agent, with the advance not first, or with a withdrawal", Object.values(d).every((x) => x.status === 400), Object.entries(d).map(([k, v]) => `${k} ${v.status} ${v.message}`).join("; "));
      (out as any).B_refusals = d;
    }
    // the bind in the bundle fails to get its co-signature back (as in A2), so only the backup can bind;
    // and the bind service is stopped the moment the wallet has signed and both were handed over
    const lost = async (a: string, wire: Uint8Array) => {
      await P.runtimeCosign(a, wire);
      throw new Error("the answer was lost on the way back");
    };
    const all = [...P.withBind(parts, P.bindPart({ owner: launcher.id, agent: agent.id, newKey: key.new_key, v0: true, cosign: lost }), { mainnet: false }), P.backupPart({ owner: launcher.id, agent: agent.id, newKey: key.new_key, nonce: key.nonce, v0: true })];
    const r0 = requests.length, t0 = Date.now();
    const sendAll = C.signAndSendAll({ wallet, account, parts: all, onStatus: (s: string) => {
      // the first send: both rotations are with the service by now; it goes down before it can send anything
      if (/^sending launch/.test(s) && !stopped) {
        stopped = Date.now();
        bind.kill("SIGKILL");
        loop.kill("SIGKILL");
      }
    } });
    let stopped = 0;
    const r = (await sendAll) as any;
    await bind.exited;
    const rec0 = await reader.agent(agent.id);
    check("B: one approval carried the launch, the bind and the backup; the backup was co-signed and kept, never sent by the page", requests.length === r0 + 1 && requests[r0]!.txs === parts.length + 2 && r.kept?.includes(P.BACKUP_LABEL) && !r.landed.some((x: any) => x.label === P.BACKUP_LABEL), `${requests[r0]!.txs} transactions in the one request; kept: ${r.kept?.join(", ")}`);
    check("B: the launch is on chain WITHOUT its bind, and the bind service and the agent loop are stopped", !r.failed && rec0?.signingKey === agent.id && !!stopped && (await health()) === null, `signing key on chain is still the launch key; stopped ${Date.now() - stopped} ms ago`);
    log(`B: everything stays down for ${DOWN_S} s (a blockhash lives about 60 to 90 s) …`);
    const bh = decodeMessage(parseWire((r.left.find((l: any) => l.label === P.BIND_LABEL)?.partial ?? new Uint8Array()) as Uint8Array).message).blockhash;
    await sleep(DOWN_S * 1000);
    const bhValid = (await retryRead(() => rpc.call<{ value: boolean }>("isBlockhashValid", [bh, { commitment: "processed" }]))).value;
    const still = await retryRead(() => reader.agent(agent.id));
    check("B: after the stop the launch's own blockhash is gone, so the bind signed with it can never land, and the agent is still unbound", !bhValid && still?.signingKey === agent.id, `blockhash ${bh.slice(0, 12)}… valid: ${bhValid}`);
    const tUp = Date.now();
    bind = startBind();
    loop = startLoop();
    await up();
    const ok = await boundTo(agent.id, key.new_key, 120_000);
    const rec = await reader.agent(agent.id);
    check("B: the service is back and binds the agent from the kept backup signature: no wallet request since the launch", ok && rec?.signingKey === key.new_key && rec?.keySeq === 1 && requests.length === r0 + 1, `bound ${Date.now() - tUp} ms after the service started, ${Math.round((Date.now() - t0) / 1000)} s after the wallet signed`);
    const n1 = await rpc.getAccountInfo(key.nonce.account);
    const after = n1 ? decodeNonceAccount(n1.data) : null;
    check("B: landing advanced the nonce", !!after && after.value !== key.nonce.value, `${key.nonce.value.slice(0, 12)}… -> ${after?.value.slice(0, 12)}…`);
    const line = svcLines().split("\n").find((l) => l.includes("sent the backup signature") && l.includes(agent.id)) ?? "";
    const sig = /\(([1-9A-HJ-NP-Za-km-z]{80,90})\)/.exec(line)?.[1] ?? null;
    // the same signed bytes again: read back from chain and sent raw
    let again = "not tried: the signature was not found in the service's log";
    if (sig) {
      const raw = await rpc.call<{ transaction: [string, string] } | null>("getTransaction", [sig, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      again = raw ? await rpc.call<string>("sendTransaction", [raw.transaction[0], { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }]).then((s) => `ACCEPTED ${s}`).catch((e) => String((e as Error).message)) : "the transaction was not read back";
    }
    check("B: the same signed transaction sent a second time is refused", !!sig && !again.startsWith("ACCEPTED") && !again.startsWith("not") && !again.startsWith("the transaction"), again.slice(0, 160));
    for (let i = 0; i < 10 && ((await health())?.kept ?? 1) > 0; i++) await sleep(1000);
    const h = (await health())!;
    check("B: counted as bound by its backup signature, none launched unbound", h.counters.bound_by_backup === 1 && h.counters.launches_unbound === 0, JSON.stringify(h.counters));
    // cleanup needs the runtime side to know the agent: the real Runtime adopts it, then one pool pass closes its nonce account
    loop.kill("SIGTERM");
    await loop.exited;
    check("B: the runtime adopts the agent with the pool key", (await runtimeAdopts(agent.id)) === key.new_key);
    const payer1 = await rpc.getBalance(poolPayer.id);
    const closed = await pool();
    const gone = await rpc.getAccountInfo(key.nonce.account);
    const payer2 = await rpc.getBalance(poolPayer.id);
    check("B: one pool pass closed the bound agent's nonce account and its rent is back with the payer (the pass also refilled the pool)", closed.status.closed === 1 && !gone && /closed the nonce account/.test(closed.log), `closed ${closed.status.closed}, made ${closed.status.made}; payer ${payer1} -> ${payer2} lamports; ${closed.log.split("\n").find((l) => l.includes("closed the nonce account"))?.replace(/^\[[^\]]*\]\s*/, "").slice(0, 200)}`);
    out.B = { agent: agent.id, mint: mint.id, runtime_key: key.new_key, nonce_account: key.nonce.account, nonce_value_signed: key.nonce.value, nonce_value_after: after?.value, backup_signature: sig, down_s: DOWN_S, s_from_wallet_to_bound: Math.round((Date.now() - t0) / 1000), second_send: again.slice(0, 200), rent_lamports: rent.toString(), pool_payer: poolPayer.id, pool_after: closed.status };
    loop = startLoop();
    // what is left of the throwaway payer goes back to the test launcher (the remaining pool keys' nonce accounts stay on devnet: 2 x rent)
    const left = await rpc.getBalance(poolPayer.id);
    if (left > 10_000n) await sendAndConfirm(rpc, poolPayer, [system.transfer(poolPayer.id, launcher.id, left - 5_000n)]).catch(() => undefined);
  }

  out.devnet_sol_spent = Number(sol0 - (await rpc.getBalance(launcher.id))) / 1e9;
  out.runtime_requests = runtimeCalls;
  out.health_after = await health();
} catch (e) {
  check("run completed", false, String((e as Error).stack ?? e).slice(0, 900));
} finally {
  for (const p of [...children]) p.kill("SIGTERM");
  await sleep(500);
  globalThis.fetch = realFetch;
  out.results = results;
  out.passed = results.filter((r) => r.ok).length;
  out.total = results.length;
  const name = arg("out", join(import.meta.dir, "BIND-SERVICE-DEVNET-LAST.json"))!;
  writeFileSync(name, JSON.stringify(out, null, 2) + "\n");
  rmSync(dir, { recursive: true, force: true }); // throwaway runtime keys of TEST agents on devnet
  log(`${results.filter((r) => r.ok).length}/${results.length} checks passed; ${name}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
