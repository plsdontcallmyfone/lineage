// A second site instance (instance.ts): the layout, and the unit files and Caddy site block rendered
// from the first instance's own files. Unset is the first instance, untouched.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CADDY_IMPORT, INSTANCE_UNIT_FILES, instanceLayout, renderCaddySite, renderUnit } from "./instance.ts";

const SYSTEMD = join(import.meta.dir, "systemd");
const TMPL = readFileSync(join(import.meta.dir, "caddy/Caddyfile.tmpl"), "utf8");

describe("instance layout", () => {
  test("unset is the devnet site as it always was", () => {
    for (const n of [undefined, null, "", "  "]) {
      const L = instanceLayout(n);
      expect(L).toMatchObject({ name: "", network: "devnet", prefix: "units", base: "/opt/units", state: "/var/lib/units", etc: "/etc/units", etcCore: "/etc/units-core", home: "/home/units",
        keysDir: "devnet", stateFile: "scripts/devnet/devnet.json", caddyFile: null, profileLocal: null });
      expect(L.ports).toEqual({ core: 9660, web: 9661, gate: 9662, identity: 9665, bind: 9667, indexer: 9668 });
    }
  });
  test("mainnet: its own names, directories, accounts and ports, none shared with the first instance", () => {
    const L = instanceLayout("mainnet"), D = instanceLayout("");
    expect(L).toMatchObject({ network: "mainnet", prefix: "units-main", base: "/opt/units-main", state: "/var/lib/units-main", etc: "/etc/units-main", etcCore: "/etc/units-main-core",
      home: "/home/units-main", keysDir: "mainnet", stateFile: "/etc/units-main/state.json", profileLocal: "/etc/units-main/profile.local.json", caddyFile: "/etc/caddy/sites.d/units-main.caddy" });
    expect(L.ports).toEqual({ core: 9760, web: 9761, gate: 9762, identity: 9765, bind: 9767, indexer: 9768 });
    expect(Object.values(L.ports).filter((p) => Object.values(D.ports).includes(p))).toEqual([]);
    expect(Object.values(L.users).filter((u) => Object.values(D.users).includes(u))).toEqual([]);
    expect(L.units.public).toEqual(["units-main-core", "units-main-indexer", "units-main-web", "units-main-gate"]);
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
    expect(Object.keys(all).sort()).toEqual(["units-main-bootstrap.service", "units-main-core.service", "units-main-gate.service", "units-main-indexer.service", "units-main-reference.service",
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
    expect(all["units-main-gate.service"]).toContain("--port 9762 --host 127.0.0.1 --web http://127.0.0.1:9761 --core http://127.0.0.1:9760 --indexer http://127.0.0.1:9768 --origin ${GATE_ORIGINS} --runtime http://127.0.0.1:9767");
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
