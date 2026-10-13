#!/usr/bin/env bun
// Reservations and co-signs across restarts, measured on this machine (docs/plans/SEAMLESS-BIND.md 9).
// Nothing here reaches a network: the chain is a JSON-RPC stand-in on 127.0.0.1 that knows no account.
//
// What runs: the real bind service (`packages/runtime/src/main.ts bind`, its own process), the real
// site gate (scripts/deploy/gate.ts --bind) in front of it, and a stand-in for the hosted runtime's
// agent loop: a process that holds the runtime's lock on the same state directory and makes keys in
// the same key store, as discovery does. A launcher is simulated every STEP ms: reserve a fresh agent
// id, sign the rotation, ask for the co-signature; once straight at the service and once through the
// gate, the path a browser takes.
//
// The timeline: the agent loop gets SIGTERM, "drains" for 3 s and leaves; a new one starts; then the
// bind service itself is restarted the way systemd restarts a unit (SIGTERM, start when it has left).
// Reported: every request that was not answered 200, the longest answer, and for the service's own
// restart the gap between its last answer before and its first after.
//
//   bun scripts/launch-e2e/bind-restart.ts [--port 9666] [--seconds 14] [--out <file>]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { compileMessage, registry } from "@units/chain";
import { DEVNET_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { missingSigners, unsignedWire } from "../../packages/chain/src/browser/wire.ts";
import { cosign } from "../../packages/chain/src/cosign.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PORT = Number(arg("port", "9666"));
if (![9663, 9666, 9667, 9668, 9669].includes(PORT)) throw new Error("ports 9663 and 9666 to 9669 only");
if ((await Bun.$`lsof -ti :${PORT}`.nothrow().text()).trim()) throw new Error(`port ${PORT} is in use`);
const SECONDS = Number(arg("seconds", "14"));
const STEP = 25;
const ROOT = join(import.meta.dir, "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (m: string) => console.log(`[bind-restart +${((Date.now() - T0) / 1000).toFixed(1).padStart(5)}s] ${m}`);

// ---- the chain stand-in: every account is absent, every blockhash valid
const rpc = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const b = (await req.json()) as { id: unknown; method: string };
    const result = b.method === "getGenesisHash" ? DEVNET_GENESIS : b.method === "getBlockHeight" ? 1 : b.method === "isBlockhashValid" ? { value: true } : b.method === "getMultipleAccounts" ? { value: [] } : { value: null };
    return Response.json({ jsonrpc: "2.0", id: b.id, result });
  },
});

const dir = mkdtempSync(join(tmpdir(), "units-bind-restart-"));
const stateDir = join(dir, "runtime");
const cfgFile = join(dir, "runtime.json");
writeFileSync(cfgFile, JSON.stringify({ mode: "devnet", core: "http://127.0.0.1:1", runtime_key: "/dev/null", state_dir: stateDir, rpc_url: `http://127.0.0.1:${rpc.port}`, compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002", bind_port: 1, bind_service_port: PORT }));
const env = { ...process.env, UNITS_NETWORK: "devnet" };

const children = new Set<ReturnType<typeof Bun.spawn>>();
const spawn = (cmd: string[], quiet = true) => {
  const p = Bun.spawn(cmd, { cwd: ROOT, env, stdout: quiet ? "ignore" : "inherit", stderr: "inherit" });
  children.add(p);
  void p.exited.then(() => children.delete(p));
  return p;
};
const startBind = () => spawn([process.execPath, "packages/runtime/src/main.ts", "bind", "--config", cfgFile]);
/** The agent loop's stand-in: the runtime's lock on the state directory, and keys made in the shared store as discovery makes them. */
const startLoop = () =>
  spawn([process.execPath, "-e", `
    import { Lock, StateStore } from ${JSON.stringify(join(ROOT, "packages/runtime/src/state.ts"))};
    import { generateAgentKey } from "@units/protocol";
    const lock = new Lock(${JSON.stringify(stateDir)}); lock.acquire();
    const store = new StateStore(${JSON.stringify(stateDir)}, { mode: "devnet", runtime: "stand-in", now: 0 });
    const t = setInterval(() => { store.keyFor(generateAgentKey().id); store.save(); }, 50);
    process.on("SIGTERM", () => { clearInterval(t); setTimeout(() => { lock.release(); process.exit(0); }, 3000); });
    await new Promise(() => {});`]);

const up = async (url: string, ms = 20_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.status).catch(() => 0)) === 200) return;
    await sleep(25);
  }
  throw new Error(`${url} did not come up`);
};

const gateSrv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
const GATE = gateSrv.port!;
gateSrv.stop(true);
const DIRECT = `http://127.0.0.1:${PORT}`;
const VIA_GATE = `http://127.0.0.1:${GATE}`;

interface Row { at: number; ms: number; ok: boolean; step: string; status: number }
const rows: Record<"direct" | "gate", Row[]> = { direct: [], gate: [] };
const owner = generateAgentKey();

/** One launcher: reserve, sign, co-sign. */
async function launcher(base: string, into: Row[]) {
  const at = Date.now();
  const agent = generateAgentKey().id;
  const headers = { "content-type": "application/json", origin: `http://127.0.0.1:${GATE}`, "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  const post = (body: unknown) => fetch(`${base}/runtime/bind/${agent}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  let step = "reserve";
  let status = 0;
  try {
    const r = await post({ reserve: true });
    status = r.status;
    if (!r.ok) throw new Error();
    const key = ((await r.json()) as { new_key: string }).new_key;
    step = "cosign";
    const msg = compileMessage(owner.id, [registry.rotateAgentKey({ owner: owner.id, agent, newKey: key })], DEVNET_GENESIS);
    const c = await post({ tx: Buffer.from(cosign(unsignedWire(msg), owner)).toString("base64"), sign_only: true });
    status = c.status;
    if (!c.ok) throw new Error();
    const back = new Uint8Array(Buffer.from(((await c.json()) as { tx: string }).tx, "base64"));
    if (missingSigners(back).length) throw new Error();
    into.push({ at, ms: Date.now() - at, ok: true, step: "done", status: 200 });
  } catch {
    into.push({ at, ms: Date.now() - at, ok: false, step, status });
  }
}

let bind = startBind();
let loop = startLoop();
await up(`${DIRECT}/runtime/bind/health`);
const gate = spawn([process.execPath, "scripts/deploy/gate.ts", "--port", String(GATE), "--host", "127.0.0.1", "--web", "http://127.0.0.1:1", "--core", "http://127.0.0.1:1", "--indexer", "http://127.0.0.1:1", "--runtime", "http://127.0.0.1:1", "--bind", DIRECT, "--origin", `http://127.0.0.1:${GATE}`]);
await up(`${VIA_GATE}/gate/health`);
log(`bind service on ${PORT}, gate on ${GATE}, chain stand-in on ${rpc.port}; a launcher every ${STEP} ms on each path for ${SECONDS} s`);

const events: { at: number; what: string }[] = [];
const mark = (what: string) => (events.push({ at: Date.now(), what }), log(what));
const start = Date.now();
const load = (async () => {
  const inflight: Promise<void>[] = [];
  let n = 0;
  while (Date.now() - start < SECONDS * 1000) {
    inflight.push(launcher(DIRECT, rows.direct));
    // through the gate at half the rate (each launcher names its own forwarded address, as Caddy would for different people)
    if (n++ % 2 === 0) inflight.push(launcher(VIA_GATE, rows.gate));
    await sleep(STEP);
  }
  await Promise.all(inflight);
})();

await sleep(2500);
mark("agent loop: SIGTERM (it drains for 3 s)");
loop.kill("SIGTERM");
await loop.exited;
mark("agent loop: left");
loop = startLoop();
mark("agent loop: started again");
await sleep(2500);
mark("bind service: SIGTERM (restart, as systemd restarts a unit)");
const tStop = Date.now();
bind.kill("SIGTERM");
await bind.exited;
const tLeft = Date.now();
bind = startBind();
await up(`${DIRECT}/runtime/bind/health`);
const tUp = Date.now();
mark(`bind service: answering again (${tLeft - tStop} ms to leave, ${tUp - tLeft} ms to start)`);
await load;

const health = (await (await fetch(`${DIRECT}/runtime/bind/health`)).json()) as { counters: Record<string, number>; reserve: { live: number } };
for (const p of [...children]) p.kill("SIGTERM");
await sleep(300);
rpc.stop(true);
rmSync(dir, { recursive: true, force: true });

const sum = (r: Row[], from = 0, to = Infinity) => {
  const w = r.filter((x) => x.at >= from && x.at < to);
  return { requests: w.length, answered: w.filter((x) => x.ok).length, failed: w.filter((x) => !x.ok).length, longest_ms: Math.max(0, ...w.map((x) => x.ms)) };
};
const loopFrom = events[0]!.at;
const loopTo = events[2]!.at + 1000;
// the service's own restart: the last launcher answered that started before the stop, the first that was answered after it
const okDirect = rows.direct.filter((x) => x.ok).map((x) => x.at + x.ms).sort((a, b) => a - b);
const lastBefore = Math.max(...okDirect.filter((t) => t <= tLeft));
const firstAfter = Math.min(...okDirect.filter((t) => t > tLeft));
const out = {
  at: new Date().toISOString(),
  machine: `${process.platform} ${process.arch}, bun ${Bun.version}`,
  step_ms: STEP,
  seconds: SECONDS,
  agent_loop_restart: { window_ms: loopTo - loopFrom, direct: sum(rows.direct, loopFrom, loopTo), through_gate: sum(rows.gate, loopFrom, loopTo) },
  bind_service_restart: {
    ms_to_leave: tLeft - tStop,
    ms_to_start: tUp - tLeft,
    gap_between_answers_ms: firstAfter - lastBefore,
    direct: sum(rows.direct, tStop - 200, tUp + 500),
    through_gate: sum(rows.gate, tStop - 200, tUp + 500),
  },
  whole_run: { direct: sum(rows.direct), through_gate: sum(rows.gate) },
  service_counters_after: health.counters,
  reservations_live_after: health.reserve.live,
};
console.log(JSON.stringify(out, null, 2));
const outFile = arg("out", join(import.meta.dir, "BIND-RESTART-LAST.json"))!;
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
const ok = out.agent_loop_restart.direct.failed === 0 && out.agent_loop_restart.through_gate.failed === 0 && out.bind_service_restart.through_gate.failed === 0;
log(ok ? "PASS: no launcher lost its key or its co-signature across the agent loop's restart, nor through the gate across the bind service's own" : "FAIL");
process.exit(ok ? 0 : 1);
