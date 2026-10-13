// A second site instance (instance.ts): the layout, and the unit files and Caddy site block rendered
// from the first instance's own files. Unset is the first instance, untouched.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CADDY_IMPORT, IDENTITY_UNIT_FILES, INSTANCE_UNIT_FILES, instanceIdentity, instanceLayout, instanceUnitFiles, renderCaddySite, renderUnit } from "./instance.ts";

const SYSTEMD = join(import.meta.dir, "systemd");
const TMPL = readFileSync(join(import.meta.dir, "caddy/Caddyfile.tmpl"), "utf8");

describe("instance layout", () => {
  test("unset is the devnet site as it always was", () => {
    for (const n of [undefined, null, "", "  "]) {
      const L = instanceLayout(n);
      expect(L).toMatchObject({ name: "", network: "devnet", prefix: "units", base: "/opt/units", state: "/var/lib/units", etc: "/etc/units", etcCore: "/etc/units-core", home: "/home/units",
        keysDir: "devnet", stateFile: "scripts/devnet/devnet.json", caddyFile: null, profileLocal: null });
      expect(L.ports).toEqual({ core: 9660, web: 9661, gate: 9662, identity: 9665, bindService: 9666, bind: 9667, indexer: 9668 });
    }
  });
  test("mainnet: its own names, directories, accounts and ports, none shared with the first instance", () => {
    const L = instanceLayout("mainnet"), D = instanceLayout("");
    expect(L).toMatchObject({ network: "mainnet", prefix: "units-main", base: "/opt/units-main", state: "/var/lib/units-main", etc: "/etc/units-main", etcCore: "/etc/units-main-core",
      home: "/home/units-main", keysDir: "mainnet", stateFile: "/etc/units-main/state.json", profileLocal: "/etc/units-main/profile.local.json", caddyFile: "/etc/caddy/sites.d/units-main.caddy" });
    expect(L.ports).toEqual({ core: 9760, web: 9761, gate: 9762, identity: 9765, bindService: 9766, bind: 9767, indexer: 9768 });
    expect(Object.values(L.ports).filter((p) => Object.values(D.ports).includes(p))).toEqual([]);
    expect(Object.values(L.users).filter((u) => Object.values(D.users).includes(u))).toEqual([]);
    expect(L.units.public).toEqual(["units-main-core", "units-main-indexer", "units-main-web", "units-main-bind", "units-main-gate"]);
  });
  test("an unknown name is refused", () => {
    expect(() => instanceLayout("staging")).toThrow(/unknown UNITS_INSTANCE/);
  });
});

describe("unit files", () => {
  const L = instanceLayout("mainnet");
  const all = Object.fromEntries(INSTANCE_UNIT_FILES.map((f) => {
    const r = renderUnit(f, readFileSync(join(SYSTEMD, f), "utf8"), L);
    return [r.file, r.text];
  }));
  test("every instance unit file exists in the kit and the first instance's render is the file itself", () => {
    const have = readdirSync(SYSTEMD);
    for (const f of INSTANCE_UNIT_FILES) {
      expect(have).toContain(f);
      const t = readFileSync(join(SYSTEMD, f), "utf8");
      expect(renderUnit(f, t, instanceLayout(""))).toEqual({ file: f, text: t });
    }
  });
  test("names, accounts, paths and ports are the instance's; nothing of the first instance is left", () => {
    expect(Object.keys(all).sort()).toEqual(["units-main-bind.service", "units-main-bootstrap.service", "units-main-core.service", "units-main-gate.service", "units-main-indexer.service", "units-main-reference.service",
      "units-main-runtime.service", "units-main-verifier@.service", "units-main-web.service"]);
    for (const [f, t] of Object.entries(all)) {
      expect(t).not.toMatch(/\b966\d\b/);
      expect(t).not.toMatch(/\/(opt|var\/lib|etc|home)\/units[\/\s]/);
      expect(t).not.toMatch(/^(User|Group)=units(-(core|web|gate|indexer))?$/m);
      expect(t).not.toMatch(/(Conflicts|After)=lineage-/);
      expect(t).toContain("WorkingDirectory=/opt/units-main/current");
      expect(t).toContain("EnvironmentFile=-/etc/units-main/site.env");
      expect(f.startsWith("units-main-")).toBe(true);
    }
    const core = all["units-main-core.service"]!;
    expect(core).toContain("User=units-main-core");
    expect(core).toContain("Group=units-main");
    expect(core).toContain("--data /var/lib/units-main/core --port 9760 --host 127.0.0.1 --config /etc/units-main-core/network.json --admin-key /etc/units-main-core/admin.json");
    expect(core).toContain("Environment=UNITS_PORT_BLOCK=9760-9769");
    expect(core).toContain("EnvironmentFile=-/etc/units-main/core.env");
    expect(core).toContain("ReadWritePaths=/var/lib/units-main/core");
    expect(core).toContain("InaccessiblePaths=-/home/units-main/.config -/home/units-main/.ssh");
    expect(all["units-main-web.service"]).toContain("--port 9761 --host 127.0.0.1 --core http://127.0.0.1:9760");
    expect(all["units-main-web.service"]).toContain("After=units-main-core.service");
    expect(all["units-main-gate.service"]).toContain("--port 9762 --host 127.0.0.1 --web http://127.0.0.1:9761 --core http://127.0.0.1:9760 --indexer http://127.0.0.1:9768 --bind http://127.0.0.1:9766 --origin ${GATE_ORIGINS} --runtime http://127.0.0.1:9767");
    expect(all["units-main-indexer.service"]).toContain("--port 9768 --host 127.0.0.1 --db /var/lib/units-main/indexer/market.db --interval 15 --core http://127.0.0.1:9760");
    const rt = all["units-main-runtime.service"]!;
    expect(rt).toContain("User=units-main\n");
    expect(rt).toContain("ConditionPathExists=/home/units-main/.config/lineage/mainnet/runtime-authority.json");
    expect(rt).toContain("--config /var/lib/units-main/site/runtime.json");
    expect(rt).toContain("EnvironmentFile=-/etc/units-main/runtime.env");
    expect(all["units-main-verifier@.service"]).toContain("--core http://127.0.0.1:9760 --key /home/units-main/.config/lineage/site/verifier-%i.json --capabilities /var/lib/units-main/site/caps.json");
  });
  test("the hardening lines of the first instance's units are kept", () => {
    for (const f of ["units-core.service", "units-web.service", "units-gate.service", "units-indexer.service"]) {
      const src = readFileSync(join(SYSTEMD, f), "utf8").split("\n").filter((l) => /^(NoNewPrivileges|Protect|Restrict|CapabilityBoundingSet|SystemCall|PrivateTmp|PrivateDevices|LockPersonality|MemoryMax)/.test(l));
      const out = all[f.replace("units-", "units-main-")]!;
      expect(src.length).toBeGreaterThan(10);
      for (const l of src) expect(out).toContain(l);
    }
  });
});

describe("Caddy site block", () => {
  const L = instanceLayout("mainnet");
  test("the main template imports the instances' site blocks", () => {
    expect(TMPL.trimEnd().endsWith(CADDY_IMPORT)).toBe(true);
  });
  test("the instance's block: its host, its gate port, its log, no identity route, no global options, no import", () => {
    const b = renderCaddySite(TMPL, L, "main-157-245-71-188.sslip.io");
    expect(b).toContain("main-157-245-71-188.sslip.io {");
    expect(b).not.toMatch(/\b966\d\b/);
    expect(b.match(/127\.0\.0\.1:9762/g)?.length).toBe(2);
    expect(b).not.toContain("/identity/*");
    expect(b).not.toContain("admin unix/");
    expect(b).not.toContain("import ");
    expect(b).not.toMatch(/@(SITES|TLS|GLOBAL)@/);
    expect(b).toContain("/var/log/caddy/units-main-access.log");
    expect(b).not.toContain("api.devnet.solana.com");
    expect(b).toContain("Content-Security-Policy");
    expect(b).toContain("max_size 256KB");
    expect(b.trimEnd().endsWith("}")).toBe(true);
    expect((b.match(/\{/g) ?? []).length).toBe((b.match(/\}/g) ?? []).length);
  });
  test("dry run: internal TLS line", () => {
    expect(renderCaddySite(TMPL, L, "main.localhost", "\ttls internal")).toContain("main.localhost {\n\ttls internal\n");
  });
});

// The identity service on an instance is opt-in (WITH_IDENTITY=1). Off is what the kit always rendered.
describe("identity service flag", () => {
  const L = instanceLayout("mainnet");
  const SITE = "main-157-245-71-188.sslip.io";
  const REMOTE = readFileSync(join(import.meta.dir, "remote-instance.sh"), "utf8");
  const LOCAL = readFileSync(join(import.meta.dir, "instance.sh"), "utf8");

  test("off (the default): the same unit files and the same Caddy block as without the option, byte for byte", () => {
    expect(instanceUnitFiles()).toEqual(INSTANCE_UNIT_FILES);
    expect(instanceUnitFiles({ identity: false })).toEqual(INSTANCE_UNIT_FILES);
    expect(INSTANCE_UNIT_FILES.filter((f) => f.includes("identity"))).toEqual([]);
    for (const tls of ["", "\ttls internal"]) {
      const plain = renderCaddySite(TMPL, L, SITE, tls);
      expect(renderCaddySite(TMPL, L, SITE, tls, {})).toBe(plain);
      expect(renderCaddySite(TMPL, L, SITE, tls, { identity: false })).toBe(plain);
      expect(plain).not.toContain("/identity/*");
      expect(plain).not.toContain("9765");
    }
    // no unit of the default set changes with the option: renderUnit has no option at all, and no default unit names the identity account or its paths
    for (const f of INSTANCE_UNIT_FILES) {
      const t = renderUnit(f, readFileSync(join(SYSTEMD, f), "utf8"), L).text;
      expect(t).not.toContain("units-main-identity");
      expect(t).not.toContain("/etc/units-main/identity.env");
    }
  });

  test("the CLI: without --identity it writes the 9 unit files and the block without the route; with it, 12 and the route", () => {
    const out = mkdtempSync(join(tmpdir(), "units-instance-cli-"));
    try {
      const run = (...a: string[]) => spawnSync("bun", [join(import.meta.dir, "instance.ts"), ...a], { encoding: "utf8" });
      expect(run("units", "mainnet", SYSTEMD, join(out, "off")).stdout).toContain("rendered 9 unit files");
      expect(readdirSync(join(out, "off")).filter((f) => f.includes("identity"))).toEqual([]);
      expect(run("units", "mainnet", SYSTEMD, join(out, "on"), "--identity").stdout).toContain("rendered 12 unit files");
      expect(readdirSync(join(out, "on")).filter((f) => f.includes("identity")).sort()).toEqual(["units-main-identity-cycle.service", "units-main-identity-cycle.timer", "units-main-identity.service"]);
      for (const f of readdirSync(join(out, "off"))) expect(readFileSync(join(out, "on", f), "utf8")).toBe(readFileSync(join(out, "off", f), "utf8"));
      const tmplPath = join(import.meta.dir, "caddy/Caddyfile.tmpl");
      expect(run("caddy", "mainnet", tmplPath, SITE, "").stdout).toBe(renderCaddySite(TMPL, L, SITE));
      // the flag after an empty TLS argument, as remote-instance.sh passes it
      expect(run("caddy", "mainnet", tmplPath, SITE, "", "--identity").stdout).toBe(renderCaddySite(TMPL, L, SITE, "", { identity: true }));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("on: the Caddy block is the off block plus the /identity/* route on the instance's identity port", () => {
    const off = renderCaddySite(TMPL, L, SITE), on = renderCaddySite(TMPL, L, SITE, "", { identity: true });
    const route = "\n\treverse_proxy /identity/* 127.0.0.1:9765 {\n\t\tlb_try_duration 15s\n\t\tlb_try_interval 250ms\n\t}";
    expect(on).toContain(route);
    expect(on.replace(route, "")).toBe(off);
    expect(on).not.toMatch(/\b966\d\b/);
  });

  test("on: the identity units are the instance's own (account, store, key directory, port, network, its Core, the root-only RPC env file)", () => {
    const I = instanceIdentity(L);
    expect(I).toEqual({ user: "units-main-identity", store: "/var/lib/units-main/identity", keyDir: "/etc/units-main-identity", envFile: "/etc/units-main/identity.env", port: 9765,
      units: { service: "units-main-identity", cycle: "units-main-identity-cycle", timer: "units-main-identity-cycle.timer" } });
    const all = Object.fromEntries(IDENTITY_UNIT_FILES.map((f) => {
      const r = renderUnit(f, readFileSync(join(SYSTEMD, f), "utf8"), L);
      return [r.file, r.text];
    }));
    expect(Object.keys(all).sort()).toEqual(["units-main-identity-cycle.service", "units-main-identity-cycle.timer", "units-main-identity.service"]);
    for (const t of Object.values(all)) {
      expect(t).not.toMatch(/\b966\d\b/);
      expect(t).not.toMatch(/\/(opt|var\/lib|etc|home)\/units[\/\s]/);
      expect(t).not.toMatch(/\/etc\/units-identity|\/run\/units-identity|=units-identity/);
      expect(t).not.toMatch(/(Conflicts|After)=lineage-/);
      expect(t).not.toContain("UNITS_NETWORK=devnet");
      expect(t).not.toContain("UNITS_MAINNET_RPC");
    }
    const svc = all["units-main-identity.service"]!;
    for (const need of ["User=units-main-identity", "Group=units-main-identity", "WorkingDirectory=/opt/units-main/current", "Environment=UNITS_NETWORK=mainnet",
      "Environment=HOME=/var/lib/units-main/identity/home", "UNITS_IDENTITY_DIR=/var/lib/units-main/identity UNITS_IDENTITY_KEY=/etc/units-main-identity/master.key UNITS_IDENTITY_RUN=/run/units-main-identity",
      "ConditionPathExists=/etc/units-main-identity/master.key", "ReadWritePaths=/var/lib/units-main/identity", "RuntimeDirectory=units-main-identity",
      "EnvironmentFile=-/etc/units-main/site.env\nEnvironmentFile=-/etc/units-main/identity.env\n",
      "Environment=UNITS_CORE=http://127.0.0.1:9760 UNITS_INDEXER=http://127.0.0.1:9768 UNITS_GENESIS_SIGNER=http://127.0.0.1:9767\nExecStart=/usr/local/bin/bun packages/identity/src/main.ts serve --port 9765 --host 127.0.0.1 --interval 30",
      "After=network-online.target units-main-core.service"]) expect(svc).toContain(need);
    const cyc = all["units-main-identity-cycle.service"]!;
    expect(cyc).toContain("Environment=UNITS_IDENTITY_CORE_KEY=/etc/units-main-identity/core-key.json");
    expect(cyc).toContain("UNITS_CORE=http://127.0.0.1:9760");
    expect(cyc).toContain("EnvironmentFile=-/etc/units-main/identity.env");
    expect(all["units-main-identity-cycle.timer"]).toContain("Unit=units-main-identity-cycle.service");
    // the hardening lines of the first instance's identity unit are kept
    const src = readFileSync(join(SYSTEMD, "units-identity.service"), "utf8").split("\n").filter((l) => /^(NoNewPrivileges|Protect|Restrict|PrivateTmp|PrivateDevices|LockPersonality|MemoryMax|UMask)/.test(l));
    expect(src.length).toBeGreaterThan(8);
    for (const l of src) expect(svc).toContain(l);
    // the first instance's own identity units are untouched
    for (const f of IDENTITY_UNIT_FILES) expect(renderUnit(f, readFileSync(join(SYSTEMD, f), "utf8"), instanceLayout(""))).toEqual({ file: f, text: readFileSync(join(SYSTEMD, f), "utf8") });
  });

  test("the shell side: the flag is read from site.env, written only when on, and no default mode ships a GitHub account", () => {
    expect(REMOTE).toContain('WITH_IDENTITY="${WITH_IDENTITY:-0}"');
    expect(REMOTE).toContain('[ "$WITH_IDENTITY" = 1 ] && PUBLIC_UNITS=("$P-core" "$P-indexer" "$IDU" "$P-web" "$P-bind" "$P-gate")');
    expect(REMOTE).toContain('"$IDU") echo "http://127.0.0.1:$PORT_ID/identity/health" ;;');
    // the heredoc of site.env gains its line only with the flag on
    expect(LOCAL).toContain("WITH_RUNTIME=${with_rt:-0}${id_line:+$nl$id_line}$feat\nEOF");
    expect(LOCAL).toContain('if [ "${with_id:-0}" = 1 ]; then id_line="WITH_IDENTITY=1"; fi');
    // the pool: never named in the kit's shell files; the only sender is the identity-pool mode, behind IDENTITY_POOL_SEND=yes
    for (const t of [LOCAL, REMOTE]) expect(t).not.toMatch(/github-pool\.json/);
    expect(LOCAL.match(/ship-pool\.ts" ship /g)?.length).toBe(1);
    const mode = LOCAL.slice(LOCAL.indexOf("\n  identity-pool)"), LOCAL.indexOf("\n  remove)"));
    expect(mode.indexOf('[ "${IDENTITY_POOL_SEND:-}" = yes ] ||')).toBeGreaterThan(0);
    expect(mode.indexOf('[ "${IDENTITY_POOL_SEND:-}" = yes ] ||')).toBeLessThan(mode.indexOf("ship-pool.ts"));
    const stage = LOCAL.slice(LOCAL.indexOf("do_stage() {"), LOCAL.indexOf("runtime_secrets() {"));
    expect(stage).not.toMatch(/identity-pool|ship-pool|reserve-add/);
    expect(REMOTE.match(/run_identity_tool reserve-add/g)?.length).toBe(1);
    expect(REMOTE.slice(REMOTE.indexOf("\nidentity-pool)"), REMOTE.indexOf("\nidentity-pool-list)"))).toContain("identity_ready || exit 1");
    // every mode of the usage header is handled, and the header prints
    for (const m of ["stage", "activate", "go", "chain-plan", "chain", "sweep-plan", "sweep", "status", "archive-state", "restore-state", "identity-pool-plan", "identity-pool", "identity-pool-sync", "remove"]) {
      expect(LOCAL).toMatch(new RegExp(`\\n#   ${m}[ <\\[|]`));
      expect(LOCAL).toMatch(new RegExp(`\\n  [a-z|-]*\\b${m}\\)|\\n  ${m}\\|`));
    }
    const usage = spawnSync("bash", [join(import.meta.dir, "instance.sh")], { encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stdout).toContain("archive-state <label>");
    expect(usage.stdout).toContain("WITH_IDENTITY=1");
    expect(usage.stdout).not.toContain("set -euo pipefail");
  });
});

// Core's bounty switches (UNITS_FEATURE_OPEN_BOUNTIES, UNITS_FEATURE_BOUNTIES) reach the mainnet Core
// through the instance's site.env: the block of instance.sh between its markers, run by bash.
describe("feature switches in site.env", () => {
  const LOCAL = readFileSync(join(import.meta.dir, "instance.sh"), "utf8");
  const block = LOCAL.slice(LOCAL.indexOf("# >>> feature-lines"), LOCAL.indexOf("# <<< feature-lines"));
  const run = (env: Record<string, string>, cur: string, call = 'printf "[%s]" "$(feature_lines "$CUR")"') =>
    spawnSync("bash", ["-c", `set -euo pipefail\n${block}\n${call}`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", CUR: cur, ...env } });
  const BOTH = "\nUNITS_FEATURE_OPEN_BOUNTIES=1\nUNITS_FEATURE_BOUNTIES=1";
  test("off by default: site.env gains nothing", () => {
    expect(block.length).toBeGreaterThan(100);
    expect(run({}, "UNITS_NETWORK=mainnet\nWITH_RUNTIME=1").stdout).toBe("[]");
  });
  test("given as 1 they are written; a later deploy without them keeps the server's lines", () => {
    expect(run({ UNITS_FEATURE_OPEN_BOUNTIES: "1", UNITS_FEATURE_BOUNTIES: "1" }, "WITH_RUNTIME=1").stdout).toBe(`[${BOTH}]`);
    expect(run({}, `WITH_RUNTIME=1${BOTH}`).stdout).toBe(`[${BOTH}]`);
    // one given now, the other kept
    expect(run({ UNITS_FEATURE_BOUNTIES: "1" }, "WITH_RUNTIME=1\nUNITS_FEATURE_OPEN_BOUNTIES=1").stdout).toBe(`[${BOTH}]`);
  });
  test("0 turns one off and leaves the other; anything else is refused", () => {
    expect(run({ UNITS_FEATURE_BOUNTIES: "0" }, `WITH_RUNTIME=1${BOTH}`).stdout).toBe("[\nUNITS_FEATURE_OPEN_BOUNTIES=1]");
    const bad = run({ UNITS_FEATURE_BOUNTIES: "yes" }, "", 'feat="$(feature_lines "$CUR")" || exit 2');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("UNITS_FEATURE_BOUNTIES must be 1 or 0");
  });
  test("go writes site.env again when a switch is given, and only then", () => {
    expect(run({ UNITS_FEATURE_BOUNTIES: "1" }, "", "feature_given && echo yes").stdout.trim()).toBe("yes");
    expect(run({}, "UNITS_FEATURE_BOUNTIES=1", "feature_given || echo no").stdout.trim()).toBe("no");
    expect(LOCAL).toContain('${UNITS_RECIPES:-}" ] || feature_given; then write_env;');
    expect(LOCAL).toContain('feat="$(feature_lines "$(r "cat /etc/$P/site.env 2>/dev/null" || true)")" || exit 2');
  });
  test("the mainnet Core unit reads that site.env, and Core reads exactly these names", () => {
    const L = instanceLayout("mainnet");
    const core = renderUnit("units-core.service", readFileSync(join(SYSTEMD, "units-core.service"), "utf8"), L).text;
    expect(core).toContain(`EnvironmentFile=-${L.etc}/site.env`);
    const src = (f: string) => readFileSync(join(import.meta.dir, "../../packages/core/src", f), "utf8");
    expect(src("bounties.ts")).toContain('process.env.UNITS_FEATURE_BOUNTIES !== "1"');
    expect(src("features.ts")).toContain("UNITS_FEATURE_${name.toUpperCase()}");
    expect(src("features.ts")).toContain('"open_bounties"');
    for (const n of ["UNITS_FEATURE_OPEN_BOUNTIES", "UNITS_FEATURE_BOUNTIES"]) expect(block).toContain(n);
  });
});

// archive-state / restore-state and the next-deployment side path: the blocks of remote-instance.sh
// between their markers, run by bash in a temporary directory. The helpers that need root or systemd
// (owners, the unit list) are stubbed; the moves, copies, refusals and messages are the script's own.
describe("deployment state on the server (remote-instance.sh blocks)", () => {
  const REMOTE = readFileSync(join(import.meta.dir, "remote-instance.sh"), "utf8");
  const block = (name: string) => {
    const a = REMOTE.indexOf(`# >>> ${name}`), b = REMOTE.indexOf(`# <<< ${name}`);
    if (a < 0 || b < a) throw new Error(`remote-instance.sh has no ${name} block`);
    return REMOTE.slice(a, b);
  };
  const roots: string[] = [];
  function box() {
    const root = mkdtempSync(join(tmpdir(), "units-instance-state-"));
    roots.push(root);
    const p = { state: join(root, "var"), etc: join(root, "etc"), etcCore: join(root, "etc-core"), base: join(root, "opt") };
    for (const d of [join(p.state, "core"), join(p.state, "indexer"), join(p.state, "runtime/keys"), join(p.state, "site"), join(p.state, "canaries"), p.etc, p.etcCore, join(p.base, "incoming")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(p.state, "core/core.db"), "core of deployment A");
    writeFileSync(join(p.state, "indexer/market.db"), "indexer of deployment A");
    writeFileSync(join(p.state, "runtime/keys/agent1.json"), "agent key of deployment A");
    writeFileSync(join(p.state, "site/caps.json"), "caps");
    writeFileSync(join(p.state, "site/network.json"), "network A");
    writeFileSync(join(p.state, "site/runtime.json"), "runtime A");
    writeFileSync(join(p.state, "canaries/c1"), "canary");
    writeFileSync(join(p.etc, "state.json"), '{"registry":"A"}');
    writeFileSync(join(p.etc, "profile.local.json"), JSON.stringify({ profiles: { mainnet: { quote: "A", state_file: join(p.etc, "state.json") } } }));
    writeFileSync(join(p.etc, "site.env"), "SITE=1");
    writeFileSync(join(p.etcCore, "network.json"), "core network A");
    const run = (call: string, active = "") =>
      spawnSync("bash", ["-c", `set -euo pipefail
NAME=mainnet; NETWORK=mainnet; P=units-main; CMD=test
STATE='${p.state}'; ETC='${p.etc}'; ETCCORE='${p.etcCore}'; BASE='${p.base}'
DEPLOYMENT_DIRS=(core indexer runtime)
mk_state_dir() { mkdir -p "$STATE/$1"; case "$1" in core|indexer) chmod 770 "$STATE/$1" ;; runtime) chmod 750 "$STATE/$1" ;; esac; }
mk_archive_root() { mkdir -p "$STATE/archive"; chmod 700 "$STATE/archive"; }
active_units() { printf '%s' "$ACTIVE" | tr ' ' '\\n' | sed '/^$/d'; }
${block("next-deployment")}
${block("state-archive")}
${call}`], { encoding: "utf8", env: { ...process.env, ACTIVE: active } });
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    return { root, p, run, read, has: (f: string) => existsSync(join(root, f)), ls: (d: string) => readdirSync(join(root, d)).sort() };
  }
  const cleanup = () => roots.forEach((r) => rmSync(r, { recursive: true, force: true }));

  test("the real helpers give the state directories the owners and modes users_dirs always gave them", () => {
    expect(REMOTE).toContain('core) install -d -m 0770 -o "$P-core" -g "$P" "$STATE/core" ;;');
    expect(REMOTE).toContain('indexer) install -d -m 0770 -o "$P-indexer" -g "$P" "$STATE/indexer" ;;');
    expect(REMOTE).toContain('runtime) install -d -m 750 -o "$P" -g "$P" "$STATE/runtime" ;;');
    expect(REMOTE).toContain('for d in "${DEPLOYMENT_DIRS[@]}"; do mk_state_dir "$d"; done');
    expect(REMOTE).toContain('mk_archive_root() { install -d -m 700 -o root -g root "$STATE/archive"; }');
    expect(REMOTE).toContain("DEPLOYMENT_DIRS=(core indexer runtime)");
    // nothing in the two blocks deletes
    for (const b of [block("state-archive"), block("next-deployment")]) expect(b.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")).not.toMatch(/\brm\b|\brmdir\b|shred|--purge/);
  });

  test("archive-state: refused while a unit runs, for a bad label and for a label that exists; nothing moves on a refusal", () => {
    try {
      const b = box();
      const running = b.run("archive_state test-a", "units-main-core.service(active) units-main-verifier@v1.service(deactivating)");
      expect(running.status).toBe(1);
      expect(running.stderr).toContain("REFUSED: units of the mainnet instance are not stopped: units-main-core.service(active) units-main-verifier@v1.service(deactivating)");
      expect(b.read("var/core/core.db")).toBe("core of deployment A");
      expect(b.has("var/archive")).toBe(false);
      for (const bad of ["", "Test", "a_b", "x".repeat(41), "../up", "a b"]) {
        const r = b.run(`archive_state '${bad}'`);
        expect(r.status).toBe(2);
        expect(b.has("var/archive")).toBe(false);
      }
      expect(b.run("archive_state test-a").status).toBe(0);
      const again = b.run("archive_state test-a");
      expect(again.status).toBe(1);
      expect(again.stderr).toContain("REFUSED: an archive named test-a exists");
    } finally {
      cleanup();
    }
  });

  test("archive-state: core, indexer and runtime move into the archive and are left empty; the two files are copied; the rest stays; sizes are printed, contents never", () => {
    try {
      const b = box();
      const r = b.run("archive_state test-deployment-1");
      expect(r.status).toBe(0);
      expect(b.read("var/archive/test-deployment-1/core/core.db")).toBe("core of deployment A");
      expect(b.read("var/archive/test-deployment-1/indexer/market.db")).toBe("indexer of deployment A");
      expect(b.read("var/archive/test-deployment-1/runtime/keys/agent1.json")).toBe("agent key of deployment A");
      for (const d of ["core", "indexer", "runtime"]) expect(b.ls(`var/${d}`)).toEqual([]);
      expect(statSync(join(b.root, "var/core")).mode & 0o777).toBe(0o770);
      expect(statSync(join(b.root, "var/runtime")).mode & 0o777).toBe(0o750);
      expect(statSync(join(b.root, "var/archive")).mode & 0o777).toBe(0o700);
      expect(statSync(join(b.root, "var/archive/test-deployment-1")).mode & 0o777).toBe(0o700);
      // copied, not moved
      expect(b.read("var/archive/test-deployment-1/etc/state.json")).toBe('{"registry":"A"}');
      expect(b.read("etc/state.json")).toBe('{"registry":"A"}');
      expect(b.has("etc/profile.local.json") && b.has("var/archive/test-deployment-1/etc/profile.local.json")).toBe(true);
      expect(b.ls("var/archive/test-deployment-1/derived").length).toBe(3);
      // kept
      expect(b.read("var/site/caps.json")).toBe("caps");
      expect(b.read("var/canaries/c1")).toBe("canary");
      expect(b.read("etc/site.env")).toBe("SITE=1");
      expect(b.read("var/archive/test-deployment-1/ARCHIVE")).toMatch(/^label test-deployment-1\ninstance mainnet\narchived_at \d{4}-\d\d-\d\dT[\d:]+Z\nrelease none\npart core [\dT:Z-]+\npart indexer [\dT:Z-]+\npart runtime [\dT:Z-]+\n$/);
      expect(r.stdout).toMatch(/moved {4}.*\/var\/core \([0-9.]+[BKMG]?\) -> .*\/archive\/test-deployment-1\/core/);
      expect(r.stdout).toContain("archived: core,indexer,runtime of the mainnet instance in");
      for (const secret of ["core of deployment A", "agent key of deployment A", '"registry"']) expect(r.stdout + r.stderr).not.toContain(secret);
    } finally {
      cleanup();
    }
  });

  test("restore-state: refused while running or for an unknown label; otherwise the current state is archived first and the old one comes back with its files", () => {
    try {
      const b = box();
      expect(b.run("archive_state dep-a").status).toBe(0);
      // deployment B runs for a while on the emptied directories and its own state files
      writeFileSync(join(b.root, "var/core/core.db"), "core of deployment B");
      writeFileSync(join(b.root, "etc/state.json"), '{"registry":"B"}');
      writeFileSync(join(b.root, "etc-core/network.json"), "core network B");
      expect(b.run("restore_state dep-a", "units-main-web.service(active)").status).toBe(1);
      const unknown = b.run("restore_state nope");
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain("REFUSED: no archive named nope");
      expect(b.read("var/core/core.db")).toBe("core of deployment B");
      const r = b.run("restore_state dep-a");
      expect(r.status).toBe(0);
      expect(b.read("var/core/core.db")).toBe("core of deployment A");
      expect(b.read("var/indexer/market.db")).toBe("indexer of deployment A");
      expect(b.read("var/runtime/keys/agent1.json")).toBe("agent key of deployment A");
      expect(b.read("etc/state.json")).toBe('{"registry":"A"}');
      expect(b.read("etc-core/network.json")).toBe("core network A");
      const autos = b.ls("var/archive");
      expect(autos.length).toBe(1);
      expect(autos[0]).toMatch(/^pre-restore-\d{8}-\d{6}$/);
      expect(autos[0]!.length).toBeLessThanOrEqual(40);
      expect(b.read(`var/archive/${autos[0]}/core/core.db`)).toBe("core of deployment B");
      expect(b.read(`var/archive/${autos[0]}/etc/state.json`)).toBe('{"registry":"B"}');
      expect(b.has(`var/archive/${autos[0]}/restored-from-dep-a/ARCHIVE`)).toBe(true);
      expect(r.stdout).toContain("before the next stage or activate");
      // the label is free again, and the round trip can go the other way
      Bun.sleepSync(1100); // the automatic label carries the second
      expect(b.run(`restore_state ${autos[0]}`).status).toBe(0);
      expect(b.read("var/core/core.db")).toBe("core of deployment B");
      expect(b.read("etc/state.json")).toBe('{"registry":"B"}');
    } finally {
      cleanup();
    }
  });

  test("archive-state --only: just the named parts move; an existing label may gain a part it lacks; restore brings back what the label holds", () => {
    try {
      const b = box();
      for (const bad of ["--only", "--only nope", "--only core,web", "--all core"]) expect(b.run(`archive_state part-a ${bad}`).status).toBe(2);
      expect(b.run("archive_state part-a --only indexer", "units-main-indexer.service(active)").status).toBe(1);
      const r = b.run("archive_state part-a --only indexer");
      expect(r.status).toBe(0);
      expect(b.read("var/archive/part-a/indexer/market.db")).toBe("indexer of deployment A");
      expect(b.ls("var/indexer")).toEqual([]);
      expect(statSync(join(b.root, "var/indexer")).mode & 0o777).toBe(0o770);
      // core and runtime were not touched
      expect(b.read("var/core/core.db")).toBe("core of deployment A");
      expect(b.read("var/runtime/keys/agent1.json")).toBe("agent key of deployment A");
      expect(b.has("var/archive/part-a/core") || b.has("var/archive/part-a/runtime")).toBe(false);
      expect(b.read("var/archive/part-a/etc/state.json")).toBe('{"registry":"A"}');
      // the same part again is refused; another part joins the label, whose first state copies stay
      const twice = b.run("archive_state part-a --only indexer");
      expect(twice.status).toBe(1);
      expect(twice.stderr).toContain("REFUSED: the archive part-a already holds a indexer part");
      expect(b.run("archive_state part-a").status).toBe(1);
      writeFileSync(join(b.root, "etc/state.json"), '{"registry":"B"}');
      expect(b.run("archive_state part-a --only runtime,core").status).toBe(0);
      expect(b.read("var/archive/part-a/core/core.db")).toBe("core of deployment A");
      expect(b.read("var/archive/part-a/etc/state.json")).toBe('{"registry":"A"}');
      expect(b.read("var/archive/part-a/ARCHIVE")).toMatch(/\npart indexer .*\npart runtime .*\npart core .*\n$/);

      // a label with one part: only that part is exchanged on a restore
      const c = box();
      expect(c.run("archive_state only-idx --only indexer").status).toBe(0);
      writeFileSync(join(c.root, "var/indexer/market.db"), "indexer of deployment B");
      writeFileSync(join(c.root, "var/core/core.db"), "core kept across the switch");
      writeFileSync(join(c.root, "etc/state.json"), '{"registry":"B"}');
      const back = c.run("restore_state only-idx");
      expect(back.status).toBe(0);
      expect(c.read("var/indexer/market.db")).toBe("indexer of deployment A");
      expect(c.read("var/core/core.db")).toBe("core kept across the switch");
      expect(c.read("var/runtime/keys/agent1.json")).toBe("agent key of deployment A");
      expect(c.read("etc/state.json")).toBe('{"registry":"A"}');
      const auto = c.ls("var/archive")[0]!;
      expect(c.read(`var/archive/${auto}/indexer/market.db`)).toBe("indexer of deployment B");
      expect(c.has(`var/archive/${auto}/core`)).toBe(false);
      // a label that holds no part at all is refused
      mkdirSync(join(c.root, "var/archive/empty"), { recursive: true });
      writeFileSync(join(c.root, "var/archive/empty/ARCHIVE"), "label empty\n");
      const none = c.run("restore_state empty");
      expect(none.status).toBe(1);
      expect(none.stderr).toContain("holds no part");
    } finally {
      cleanup();
    }
  });

  test("go: the Core backup and the indexer set-aside are checked before anything moves, made with only their own unit stopped, and one restore undoes both", () => {
    try {
      const b = box();
      const others = "units-main-web.service(active) units-main-gate.service(active) units-main-verifier@v1.service(active)";
      // refusals of the precheck: bad label, a unit that still runs without the stop, a part the label already holds
      expect(b.run("go_precheck 'Bad Label' '' ''").status).toBe(2);
      expect(b.run("go_precheck '' 'x_y' ''").status).toBe(2);
      const coreUp = b.run("go_precheck golive '' ''", `units-main-core.service(active) ${others}`);
      expect(coreUp.status).toBe(1);
      expect(coreUp.stderr).toContain("GO_BACKUP_CORE needs units-main-core stopped");
      expect(b.run("go_precheck '' golive ''", "units-main-indexer.service(active)").status).toBe(1);
      // with the stop announced (GO_SWITCH_RUNNING=yes) running units do not refuse it; nothing given refuses nothing
      expect(b.run("go_precheck golive golive yes", `units-main-core.service(active) units-main-indexer.service(active) ${others}`).status).toBe(0);
      expect(b.run("go_precheck '' '' ''", others).status).toBe(0);
      expect(b.has("var/archive")).toBe(false);
      // the steps themselves refuse while their unit runs, and work with the other units still up
      expect(b.run("backup_core golive", "units-main-core.service(active)").status).toBe(1);
      expect(b.run("set_aside_indexer golive", "units-main-indexer.service(deactivating)").status).toBe(1);
      expect(b.has("var/archive/golive/core-backup") || b.has("var/archive/golive/indexer")).toBe(false);
      const bk = b.run("backup_core golive", others);
      expect(bk.status).toBe(0);
      expect(bk.stdout).toMatch(/copied {3}.*\/var\/core \([0-9.]+[BKMG]?\) -> .*\/archive\/golive\/core-backup in \d+ s/);
      // a copy: Core's database is still in place
      expect(b.read("var/core/core.db")).toBe("core of deployment A");
      expect(b.read("var/archive/golive/core-backup/core.db")).toBe("core of deployment A");
      const idx = b.run("set_aside_indexer golive", others);
      expect(idx.status).toBe(0);
      expect(b.read("var/archive/golive/indexer/market.db")).toBe("indexer of deployment A");
      expect(b.ls("var/indexer")).toEqual([]);
      expect(statSync(join(b.root, "var/indexer")).mode & 0o777).toBe(0o770);
      expect(b.read("var/runtime/keys/agent1.json")).toBe("agent key of deployment A");
      // a second go with the same label is refused before anything is stopped
      expect(b.run("go_precheck golive '' yes").status).toBe(1);
      expect(b.run("go_precheck '' golive yes").status).toBe(1);
      expect(b.run("backup_core golive").status).toBe(1);
      expect(b.run("set_aside_indexer golive").status).toBe(1);

      // the switch happened: Core migrated its database in place, the indexer filled a new one, new state files
      writeFileSync(join(b.root, "var/core/core.db"), "core after the one-way switch");
      writeFileSync(join(b.root, "var/indexer/market.db"), "indexer of the official deployment");
      writeFileSync(join(b.root, "etc/state.json"), '{"registry":"OFFICIAL"}');
      writeFileSync(join(b.root, "etc-core/network.json"), "core network OFFICIAL");
      // rollback: one restore brings the Core backup, the indexer and the previous state files back
      expect(b.run("restore_state golive", others).status).toBe(1);
      const r = b.run("restore_state golive");
      expect(r.status).toBe(0);
      expect(b.read("var/core/core.db")).toBe("core of deployment A");
      expect(b.read("var/indexer/market.db")).toBe("indexer of deployment A");
      expect(b.read("var/runtime/keys/agent1.json")).toBe("agent key of deployment A");
      expect(b.read("etc/state.json")).toBe('{"registry":"A"}');
      expect(b.read("etc-core/network.json")).toBe("core network A");
      const auto = b.ls("var/archive")[0]!;
      expect(b.read(`var/archive/${auto}/core/core.db`)).toBe("core after the one-way switch");
      expect(b.read(`var/archive/${auto}/indexer/market.db`)).toBe("indexer of the official deployment");
      expect(b.has(`var/archive/${auto}/runtime`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("go with GO_SWITCH_RUNNING=yes: runtime, indexer, Core stop in that order before any file changes; the copy and the set-aside come before the new state", () => {
    const arm = REMOTE.slice(REMOTE.indexOf("\nactivate|activate-staged)"), REMOTE.indexOf("\nchain)"));
    const at = (t: string) => {
      const i = arm.indexOf(t);
      if (i < 0) throw new Error(`the activate arm has no ${t}`);
      return i;
    };
    const order = ["go_precheck ", 'systemctl stop "$P-runtime"', 'systemctl stop "$P-indexer"', 'systemctl stop "$P-core"', 'backup_core "$GO_BACKUP_CORE"', 'set_aside_indexer "$GO_ARCHIVE_INDEXER"', "    promote_next\n", '\n  site_config "$REL"\n', "instance-preflight.ts", 'restart_checked "$u"', "finish_next"].map(at);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    // the public units start Core first, then the indexer
    expect(REMOTE).toContain('PUBLIC_UNITS=("$P-core" "$P-indexer" "$P-web" "$P-bind" "$P-gate")');
    const LOCAL = readFileSync(join(import.meta.dir, "instance.sh"), "utf8");
    expect(LOCAL).toContain("GO_SWITCH_RUNNING=${GO_SWITCH_RUNNING:-} GO_BACKUP_CORE=${GO_BACKUP_CORE:-} GO_ARCHIVE_INDEXER=${GO_ARCHIVE_INDEXER:-} $RI activate-staged");
    expect(LOCAL).toContain('ONLY="--only $5"');
  });

  test("the next deployment's files wait in next/ and reach the live paths only through promote_next, never under running units", () => {
    try {
      const b = box();
      writeFileSync(join(b.root, "opt/incoming/next.state.json"), '{"registry":"OFFICIAL"}');
      writeFileSync(join(b.root, "opt/incoming/next.profile.local.json"), JSON.stringify({ profiles: { mainnet: { quote: "OFFICIAL" } } }));
      writeFileSync(join(b.root, "opt/incoming/next.sizing.json"), '{"max_open_replays":4}');
      expect(b.run("place_next").status).toBe(0);
      // the live files are untouched; next/ holds the pair, its overlay naming the state file beside it
      expect(b.read("etc/state.json")).toBe('{"registry":"A"}');
      expect(JSON.parse(b.read("etc/profile.local.json")).profiles.mainnet.quote).toBe("A");
      expect(b.read("etc/next/state.json")).toBe('{"registry":"OFFICIAL"}');
      expect(JSON.parse(b.read("etc/next/profile.local.json")).profiles.mainnet).toEqual({ quote: "OFFICIAL", state_file: join(b.p.etc, "next/state.json") });
      expect(b.run("have_next").status).toBe(0);
      const refused = b.run("promote_next", "units-main-core.service(active)");
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("REFUSED: the next deployment's state would replace the live one while units of the mainnet instance run");
      expect(b.read("etc/state.json")).toBe('{"registry":"A"}');
      const ok = b.run("promote_next");
      expect(ok.status).toBe(0);
      expect(b.read("etc/state.json")).toBe('{"registry":"OFFICIAL"}');
      expect(JSON.parse(b.read("etc/profile.local.json")).profiles.mainnet).toEqual({ quote: "OFFICIAL", state_file: join(b.p.etc, "state.json") });
      expect(b.read("etc/state.json.prev")).toBe('{"registry":"A"}');
      expect(JSON.parse(b.read("etc/profile.local.json.prev")).profiles.mainnet.quote).toBe("A");
      expect(JSON.parse(b.read("etc/sizing.json"))).toEqual({ max_open_replays: 4 });
      // within one run: a failed activation puts the previous pair back and next/ keeps waiting; a completed one empties next/
      const back = b.run("promote_next; rollback_next");
      expect(back.status).toBe(0);
      expect(b.read("etc/state.json")).toBe('{"registry":"OFFICIAL"}'); // the previous of this second run is the first run's result
      const b2 = box();
      writeFileSync(join(b2.root, "opt/incoming/next.state.json"), '{"registry":"OFFICIAL"}');
      writeFileSync(join(b2.root, "opt/incoming/next.profile.local.json"), JSON.stringify({ profiles: { mainnet: { quote: "OFFICIAL" } } }));
      expect(b2.run("place_next; promote_next; rollback_next").status).toBe(0);
      expect(b2.read("etc/state.json")).toBe('{"registry":"A"}');
      expect(JSON.parse(b2.read("etc/profile.local.json")).profiles.mainnet.quote).toBe("A");
      expect(b2.run("have_next").status).toBe(0);
      expect(b.run("have_next").status).toBe(0);
      expect(b.run("promote_next; finish_next").status).toBe(0);
      // nothing waits any more: chain reads the live files again, a second promote changes nothing
      expect(b.run("have_next").status).not.toBe(0);
      const again = b.run("promote_next");
      expect(again.status).toBe(0);
      expect(again.stdout).toContain("nothing waiting");
      // with the owner's word, the switch may happen under running units (Core keeping its database)
      writeFileSync(join(b.root, "opt/incoming/next.state.json"), '{"registry":"C"}');
      writeFileSync(join(b.root, "opt/incoming/next.profile.local.json"), JSON.stringify({ profiles: { mainnet: { quote: "C" } } }));
      expect(b.run("place_next").status).toBe(0);
      expect(b.run("GO_SWITCH_RUNNING=yes promote_next; finish_next", "units-main-core.service(active)").status).toBe(0);
      expect(b.read("etc/state.json")).toBe('{"registry":"C"}');
      // one file of the pair alone is refused; a sizing file that is not an object is not placed
      writeFileSync(join(b.root, "opt/incoming/next.state.json"), '{"registry":"D"}');
      expect(b.run("place_next").status).toBe(0);
      expect(b.run("promote_next").status).toBe(1);
      writeFileSync(join(b.root, "opt/incoming/next.sizing.json"), "[1]");
      expect(b.run("place_next").status).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("chain reads next/ through its own environment, and activate-staged keeps activate's refusals", () => {
    expect(REMOTE).toContain('CHAIN_STATE="$NEXT/state.json"; CHAIN_PROFILE="$NEXT/profile.local.json"');
    expect(REMOTE).toContain('[ -n "${CHAIN_STATE:-}" ] && extra=(-E UNITS_INSTANCE_STATE="$CHAIN_STATE")');
    expect(REMOTE).toContain('-E UNITS_PROFILE_LOCAL="${CHAIN_PROFILE:-$ETC/profile.local.json}"');
    // one case arm serves both: the checks, the preflight and the port test are shared code
    const arm = REMOTE.slice(REMOTE.indexOf("\nactivate|activate-staged)"), REMOTE.indexOf("\nchain)"));
    for (const need of ["go_precheck \"${GO_BACKUP_CORE:-}\" \"${GO_ARCHIVE_INDEXER:-}\" \"${GO_SWITCH_RUNNING:-}\" && promote_check ||", "promote_next\n", "rollback_next", "finish_next", "miss+=(\"the keyed RPC", "miss+=(\"the Core authority key", "instance-preflight.ts", "lsof -t -iTCP", "restart_checked \"$u\"", "phase \"chain preflight\""]) expect(arm).toContain(need);
    expect(arm).not.toMatch(/bun install|git clone|docker build|arch-recipes/);
    expect(REMOTE).toContain('echo "$SHA" > "$BASE/staged"');
  });
});
