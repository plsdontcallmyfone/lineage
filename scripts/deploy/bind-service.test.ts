// The bind service in the deploy kit (docs/plans/SEAMLESS-BIND.md section 9; incident 2026-10-13: the
// hosted runtime closed its bind listener at SIGTERM and drained for up to 25 minutes, and every hosted
// launch in that window went out without its bind). These tests pin what keeps a deploy from opening
// that window again: the bind surface is a unit of its own, restarted with the public units and never
// drained, the gate forwards to it, the runtime no longer owns it, and the monitor reads its health.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "./gate.ts";
import { instanceLayout, INSTANCE_UNIT_FILES, renderUnit } from "./instance.ts";
import { evaluate, type Inputs } from "./monitor.ts";

const DIR = import.meta.dir;
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const unit = read("systemd/units-bind.service");
const live = (t: string) => t.split("\n").filter((l) => !l.startsWith("#")).join("\n");

describe("units-bind.service", () => {
  test("runs the bind command on the runtime's config, as the runtime's user, on its own port", () => {
    expect(unit).toContain("ExecStart=/usr/local/bin/bun packages/runtime/src/main.ts bind --config /var/lib/units/site/runtime.json --port 9666");
    const rt = read("systemd/units-runtime.service");
    for (const same of ["User=units", "Group=units", "WorkingDirectory=/opt/units/current", "EnvironmentFile=-/etc/units/site.env", "Environment=UNITS_NETWORK=devnet"]) {
      expect(unit).toContain(`\n${same}\n`);
      expect(rt).toContain(`\n${same}\n`);
    }
  });

  test("it never drains and comes back at once: a short stop, Restart=always within a second", () => {
    expect(Number(/TimeoutStopSec=(\d+)/.exec(unit)![1])).toBeLessThanOrEqual(15);
    expect(unit).toContain("\nRestart=always\n");
    expect(unit).toContain("\nRestartSec=1\n");
    // the runtime keeps its long drain; the two are different units, so one never waits for the other
    expect(Number(/TimeoutStopSec=(\d+)/.exec(read("systemd/units-runtime.service"))![1])).toBeGreaterThanOrEqual(1500);
    expect(live(unit)).not.toMatch(/units-runtime|PartOf=|BindsTo=|Requires=/);
  });

  test("it is given no secret the runtime has: no model key, no Docker, no authority key path in its command", () => {
    expect(live(unit)).not.toMatch(/model\.env|providers\.env|docker|sizing\.env|sandbox/i);
    expect(unit).not.toMatch(/ExecStart=.*authority/);
    // the authority key file only conditions the unit (an instance with a hosted runtime); the process is never told its path
    expect(live(unit).match(/runtime-authority\.json/g)?.length).toBe(1);
    expect(unit).toContain("ConditionPathExists=/home/units/.config/lineage/devnet/runtime-authority.json");
    expect(unit).toContain("\nNoNewPrivileges=yes\n");
    expect(unit).toContain("\nCapabilityBoundingSet=\n");
  });

  test("the bind command itself loads no authority key and no model key (packages/runtime/src/main.ts)", () => {
    const main = readFileSync(join(DIR, "../../packages/runtime/src/main.ts"), "utf8");
    const block = main.slice(main.indexOf('case "bind": {'), main.indexOf('case "pool": {'));
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/loadKey\(|runtime_key|loadModelEnv|loadProviderKeys|backendFor\(/);
    expect(block).toContain("installAgentFirewall(");
    const svc = readFileSync(join(DIR, "../../packages/runtime/src/bind-service.ts"), "utf8");
    expect(svc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")).not.toMatch(/runtime_key|model\.env|providers|loadKeypair/);
  });

  test("an instance gets it too: its own name, port, state and the runtime's keyed RPC file", () => {
    expect(INSTANCE_UNIT_FILES).toContain("units-bind.service");
    const L = instanceLayout("mainnet");
    const r = renderUnit("units-bind.service", unit, L);
    expect(r.file).toBe("units-main-bind.service");
    expect(r.text).toContain("ExecStart=/usr/local/bin/bun packages/runtime/src/main.ts bind --config /var/lib/units-main/site/runtime.json --port 9766");
    expect(r.text).toContain("\nUser=units-main\n");
    expect(r.text).toContain("\nEnvironment=UNITS_NETWORK=mainnet\n");
    expect(r.text).toContain("\nEnvironmentFile=-/etc/units-main/runtime.env\n");
    expect(r.text).toContain("ConditionPathExists=/home/units-main/.config/lineage/mainnet/runtime-authority.json");
    expect(L.ports.bindService).toBe(9766);
    expect(L.ports.bindService).not.toBe(L.ports.bind);
  });
});

describe("deploy order: the bind service is a public unit, before the gate, never with the workers", () => {
  const remote = read("remote.sh");
  const inst = read("remote-instance.sh");

  test("first instance: restarted one by one with a health check, right before the gate", () => {
    expect(remote).toContain('PUBLIC_UNITS=("$UP-core" "$UP-indexer" "$UP-identity" "$UP-web" "$UP-bind" "$UP-gate")');
    expect(remote).toContain("bind) echo http://127.0.0.1:9666/runtime/bind/health ;;");
    // a unit whose condition is not met (no hosted runtime here) is skipped, not a failed deploy
    expect(remote).toContain("skipped (unit condition not met)");
  });

  test("second instance: the same, on its own port, and its port is checked before activation", () => {
    expect(inst).toContain('PUBLIC_UNITS=("$P-core" "$P-indexer" "$P-web" "$P-bind" "$P-gate")');
    expect(inst).toContain('PUBLIC_UNITS=("$P-core" "$P-indexer" "$IDU" "$P-web" "$P-bind" "$P-gate")');
    expect(inst).toContain('"$P-bind") echo "http://127.0.0.1:$PORT_BINDSVC/runtime/bind/health" ;;');
    expect(inst).toContain("PORT_BINDSVC=$((9666 + OFF))");
    expect(inst).toMatch(/for port in \$PORT_CORE \$PORT_WEB \$PORT_GATE \$PORT_BINDSVC /);
    expect(inst).toContain("skipped (unit condition not met)");
    // stopping the whole instance stops it as well
    expect(inst).toContain('"$P-web" "$P-bind" "$P-gate"; }');
    // up but not ready (the chain did not answer) never fails a deploy: the monitor reports it
    for (const t of [remote, inst]) expect(t).toMatch(/-bind"? \]|= bind \]/);
    expect(remote).toContain('if [ "${u#*-}" = bind ] && [ "$code" = 503 ]; then code=200; break; fi');
    expect(inst).toContain('if [ "$u" = "$P-bind" ] && [ "$code" = 503 ]; then code=200; break; fi');
  });

  test("no background stop, drain wait or worker list names it: a deploy never waits for it and it never waits for a drain", () => {
    for (const [name, text] of [["remote.sh", remote], ["remote-instance.sh", inst]] as const) {
      for (const line of text.split("\n").filter((l) => /WORKER_UNITS=|active_background|optional_units\(\)|--no-block/.test(l) && !l.trim().startsWith("#")))
        expect(`${name}: ${line}`).not.toMatch(/-bind\b/);
    }
  });

  test("the gate forwards the bind routes to it; the runtime is told the bind surface is not its own", () => {
    expect(read("systemd/units-gate.service")).toContain("--bind http://127.0.0.1:9666 ");
    for (const [m, p] of [["GET", "/runtime/bind/health"], ["POST", "/runtime/bind/6suZFaDgb7VRxuLGMc9UDwCCieqTat92GxGkSxZxp6Sn"], ["GET", "/runtime/unbound/6suZFaDgb7VRxuLGMc9UDwCCieqTat92GxGkSxZxp6Sn"]] as const)
      expect(classify(m, p)).toMatchObject({ upstream: "bind" });
    // the desktops stay the runtime's
    expect(classify("GET", "/desktops/x")).not.toMatchObject({ upstream: "bind" });
    expect(read("site-config.ts")).toContain("bind_service_port: L.ports.bindService,");
    // the key pool for backup signatures: on, with its bounds written out (the runtime authority funds it)
    expect(read("site-config.ts")).toContain("bind_pool: { enabled: true, target: 20, low: 8, cap: 40, per_pass: 4, payer_floor_lamports: 50_000_000 },");
    const main = readFileSync(join(DIR, "../../packages/runtime/src/main.ts"), "utf8");
    expect(main).toContain("const ownBind = !cfg.bind_service_port;");
    // a runtime that still serves the bind surface itself keeps it up while it drains
    expect(main).toMatch(/void rt\.stop\(\)\.then\(\(\) => \(bindServer\?\.stop\(true\), process\.exit\(0\)\)\);/);
  });
});

describe("monitor: the bind surface", () => {
  const NOW = 1_800_000_000_000;
  const MIN = {
    now: NOW, units: {}, coreHealth: { ok: true }, gateHealth: { ok: true }, publicHealth: null, epochs: [{ n: 5, status: "open", end_ms: NOW + 3600_000 }, { n: 4, status: "closed", end_ms: NOW - 1000, closed_at: NOW - 1000 }],
    chain: { mode: "devnet", core_signing: true, last_epoch: "4" }, expectSigning: true, heartbeats: [], verifiers: [], spend: null, runtimeEnabled: false, souls: null, balances: [], faucet: null, disk: [],
    newestBackupMs: NOW, backupsExpected: false, secretsBackups: [],
  } as unknown as Inputs;
  const checks = (bind: Inputs["bind"]) => evaluate({ ...MIN, bind }).filter((c) => c.id.startsWith("bind:"));
  const counters = { reservations: 3, cosigns: 3, bound_with_launch: 2, bound_after: 1, sent_by_service: 1, launches_unbound: 0 };

  test("healthy is ok with the counters; not ready or not answering fails and says what", () => {
    expect(checks([{ name: "mainnet", health: { ok: true, counters } }])).toEqual([{ id: "bind:mainnet", level: "ok", msg: "bind service ok: 3 reservations, 3 co-signs, 2 bound with the launch, 1 bound after, 0 launched unbound" }]);
    const down = checks([{ name: "mainnet", health: { ok: false, reserve: { ok: false }, key_store: { ok: true }, cosigner: { ok: true }, chain: { ok: false }, counters } }])[0]!;
    expect(down.level).toBe("fail");
    expect(down.msg).toContain("(reserve, chain)");
    expect(down.msg).toContain("hosted launches are refused");
    expect(checks([{ name: "devnet", health: null }])).toMatchObject([{ id: "bind:devnet", level: "fail" }]);
  });

  test("every further unbound launch is a warning of its own", () => {
    const one = checks([{ name: "mainnet", health: { ok: true, counters: { ...counters, launches_unbound: 1 } } }]);
    const two = checks([{ name: "mainnet", health: { ok: true, counters: { ...counters, launches_unbound: 2 } } }]);
    expect(one.map((c) => [c.id, c.level])).toEqual([["bind:mainnet", "ok"], ["bind:mainnet:unbound-1", "warn"]]);
    expect(two.map((c) => [c.id, c.level])).toEqual([["bind:mainnet", "ok"], ["bind:mainnet:unbound-2", "warn"]]);
  });

  test("no bind service named (an instance without a hosted runtime) adds no check", () => {
    expect(checks(undefined)).toEqual([]);
    expect(checks([])).toEqual([]);
  });

  test("remote.sh names the services to read, and the monitor reads only loopback", () => {
    expect(read("remote.sh")).toContain("printf 'MONITOR_BIND=%s\\n'");
    const m = read("monitor.ts");
    expect(m).toContain("env.MONITOR_BIND");
    expect(m).toContain("127\\.0\\.0\\.1:\\d+$/.test(p[1]!)");
  });
});
