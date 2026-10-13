// Network compute (docs/plans/MODELS-AND-SELF-FUNDING.md section D): the deploy kit writes it OFF for
// the devnet site and ON for the mainnet instance, and the runtime accepts both files' blocks.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../packages/runtime/src/config.ts";

function runtimeJson(instance: "" | "mainnet") {
  const dir = mkdtempSync(join(tmpdir(), "network-compute-site-"));
  try {
    mkdirSync(join(dir, "etc"), { recursive: true });
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ registry_program: "11111111111111111111111111111111", launch_program: "11111111111111111111111111111111", line_mint: "11111111111111111111111111111111", runtime_authority: "11111111111111111111111111111111" }));
    writeFileSync(join(dir, "caps.json"), JSON.stringify({ arch: "amd64", cpus: 4, memory_mb: 7941, gpus: [] }));
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "site-config.ts"), "--out", dir], {
      env: { ...process.env, UNITS_INSTANCE: instance, UNITS_INSTANCE_STATE: state, UNITS_SIZE_CORES: "4", UNITS_SIZE_MEMORY_MB: "7941", UNITS_SIZING_FILE: join(dir, "etc", "sizing.json"), HOME: dir, UNITS_NETWORK: instance || "devnet" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = p.stdout.toString() + p.stderr.toString();
    if (p.exitCode !== 0) throw new Error(out);
    return { out, runtime: JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("devnet site: network compute off, every other spend value as it was", () => {
  const r = runtimeJson("");
  expect(r.runtime.mode).toBe("devnet");
  expect(r.runtime.platform_funding).toEqual({ enabled: false, min_interval_s: 900, attempt_max_usd: null, charge_vault: false });
  expect(r.runtime).toMatchObject({ global_max_usd: 100, global_cap_scope: "all", global_window_s: 86400, attempt_max_usd: 1, attempt_gap_s: 30, agent_epoch_max_usd: null });
  expect(r.out).toContain("network compute off");
  expect(parseConfig({ ...r.runtime, core: "http://x", runtime_key: "k" }).platform_funding?.enabled).toBe(false);
});

test("mainnet instance: network compute on, one attempt every 900 s, under the 800 USD per UTC day cap that counts every dollar", () => {
  const r = runtimeJson("mainnet");
  expect(r.runtime.mode).toBe("mainnet");
  expect(r.runtime.platform_funding).toEqual({ enabled: true, min_interval_s: 900, attempt_max_usd: null, charge_vault: false });
  expect(r.runtime).toMatchObject({ global_max_usd: 800, global_cap_scope: "all", global_window_s: 86400 });
  expect(r.out).toContain("network compute on (one attempt every 900 s");
  expect(parseConfig({ ...r.runtime, core: "http://x", runtime_key: "k" }).platform_funding).toEqual({ enabled: true, min_interval_s: 900, attempt_max_usd: null, charge_vault: false });
});
