import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { sha256Hex } from "../../protocol/src/hash.ts";
import { E2BBackend } from "../../desktop/src/e2b.ts";
import { FakeE2B } from "../../desktop/test/fake-e2b.ts";
import { parseConfig, Runtime, type Backend } from "../src/index.ts";
import { desktopPool } from "../src/desktops.ts";

// A launch Core purged (packages/core/src/purge.ts, GET /v1/purged: sha256 digests) still exists on
// chain. The runtime drops everything it holds of it, removes its desktop, and never adopts or binds
// it again, also after a restart with Core unreachable.

const tmp: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
const T0 = Date.UTC(2026, 9, 12, 12);

const RUNTIME_KEY = generateAgentKey();
function setup(dir: string, core: string, world: { hosted: { agent: string; mint: string }[]; signing: Map<string, string | null> }, clock: { t: number }, e2b: FakeE2B) {
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);
  const cfg = parseConfig({ mode: "sim", core, runtime_key: "k", state_dir: dir, compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 1, sandbox_reserve_s: 0, min_attempt_usd: 0.05, max_candidates_per_agent: 0, desktops_max: 0, e2b_max: 100, desktop_usd_per_day: 50, desktop_mode: "per_agent", e2b: { template: "lineage-desktop", vcpu: 2, ram_gib: 4, session_max_s: 86400 } });
  const pool = desktopPool(cfg, log, { e2b: new E2BBackend({ root: join(dir, "desktops"), key: "k", vcpu: 2, ram_gib: 4, api: e2b }), now: () => clock.t, timers: false })!;
  const backend: Backend = {
    mode: "sim",
    init: async () => ({ decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null }),
    discover: async () => world.hosted.map((h) => ({ agent: h.agent, mint: h.mint, launcher: null, target_repo: null })),
    hostedAgent: async (agent: string) => {
      const h = world.hosted.find((x) => x.agent === agent);
      return h ? { agent: h.agent, mint: h.mint, launcher: null, target_repo: null } : null;
    },
    signingKey: async (a) => world.signing.get(a) ?? null,
    vault: async () => ({ balance: 5_000_000n, awake: true }),
    bindRequest: async () => ({}),
    nextEpoch: async (n) => ({ epoch: n, earliestS: 0 }),
    post: async () => {},
    refreshAwake: async () => false,
  };
  const rt = new Runtime(cfg, { backend, runtimeKey: RUNTIME_KEY, proposer: () => ({ name: "none", propose: async () => null }), log, telemetry: false, now: () => clock.t, desktop: pool });
  return { rt, pool, lines };
}

describe("a purged launch in the hosted runtime", () => {
  test("dropped with its desktop, its key set aside, never adopted or bound again, also after a restart without Core", async () => {
    const dir = mkdtempSync(join(tmpdir(), "units-rt-purged-"));
    tmp.push(dir);
    const purged: { agent_sha256: string; mint_sha256: string | null }[] = [];
    let coreUp = true;
    const core = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (coreUp && new URL(req.url).pathname === "/v1/purged" ? Response.json({ purged, count: purged.length }) : new Response("{}", { status: 503 })) });
    servers.push(core);
    const clock = { t: T0 };
    const e2b = new FakeE2B(() => clock.t);
    const a = { agent: generateAgentKey().id, mint: generateAgentKey().id };
    const b = { agent: generateAgentKey().id, mint: generateAgentKey().id };
    const world = { hosted: [a, b], signing: new Map<string, string | null>() };
    const s = setup(dir, `http://127.0.0.1:${core.port}`, world, clock, e2b);
    await s.rt.start();
    await s.rt.tick();
    for (const x of [a, b]) world.signing.set(x.agent, s.rt.state.agents[x.agent]!.key_id);
    await s.rt.tick();
    await s.pool.agents!.settle();
    expect(s.rt.state.agents[a.agent]!.status).toBe("bound");
    expect(e2b.ofAgent(a.agent)).toHaveLength(1);
    expect(e2b.ofAgent(b.agent)).toHaveLength(1);
    const keyFile = join(dir, "keys", `${a.agent}.json`);
    const key = readFileSync(keyFile, "utf8");
    expect(existsSync(join(dir, "bind-requests", `${a.agent}.json`))).toBe(true);

    // Core purges a: the chain still lists it
    purged.push({ agent_sha256: sha256Hex(a.agent), mint_sha256: sha256Hex(a.mint) });
    await s.rt.tick();
    expect(s.rt.state.agents[a.agent]).toBeUndefined();
    expect(s.rt.state.open.usage[a.agent]).toBeUndefined();
    expect(s.rt.state.agents[b.agent]!.status).toBe("bound");
    expect(existsSync(keyFile)).toBe(false);
    expect(existsSync(join(dir, "bind-requests", `${a.agent}.json`))).toBe(false);
    // the key is the agent's wallet on chain: set aside under its digest, never loaded from there
    expect(readFileSync(join(dir, "purged-keys", `${sha256Hex(a.agent)}.json`), "utf8")).toBe(key);
    expect(s.rt.keyOf(a.agent)).toBeNull();
    expect(await s.rt.bindTarget(a.agent)).toBeNull();
    expect((await s.rt.bindTarget(b.agent))!.status).toBe("bound");
    // nothing on disk names it but the list of digests
    expect(readFileSync(join(dir, "state.json"), "utf8")).not.toContain(a.agent);
    expect(readFileSync(join(dir, "purged.json"), "utf8")).not.toContain(a.agent);
    expect(readdirSync(join(dir, "keys"))).toEqual([`${b.agent}.json`]);
    // its desktop: no longer listed for the pool, removed after the removal delay
    await s.pool.agents!.settle();
    clock.t += 301_000;
    await s.rt.tick();
    s.pool.agents!.maintain();
    await s.pool.agents!.settle();
    expect(e2b.ofAgent(a.agent)).toHaveLength(0);
    expect(e2b.ofAgent(b.agent)).toHaveLength(1);
    // many discovery passes later it is still not adopted
    for (let i = 0; i < 8; i++) await s.rt.tick();
    expect(s.rt.state.agents[a.agent]).toBeUndefined();
    expect(readdirSync(join(dir, "keys"))).toEqual([`${b.agent}.json`]);
    await s.rt.stop({ flush: false });
    s.pool.stop();

    // a restart while Core cannot be read: the list on disk still keeps it out
    coreUp = false;
    const s2 = setup(dir, `http://127.0.0.1:${core.port}`, world, clock, e2b);
    await s2.rt.start();
    for (let i = 0; i < 3; i++) await s2.rt.tick();
    expect(s2.rt.state.agents[a.agent]).toBeUndefined();
    expect(await s2.rt.bindTarget(a.agent)).toBeNull();
    expect(readdirSync(join(dir, "keys"))).toEqual([`${b.agent}.json`]);
    // the same coin under another agent key is refused too
    const c = { agent: generateAgentKey().id, mint: a.mint };
    world.hosted = [a, b, c];
    for (let i = 0; i < 3; i++) await s2.rt.tick();
    expect(s2.rt.state.agents[c.agent]).toBeUndefined();
    await s2.rt.stop({ flush: false });
    s2.pool.stop();
  });
});
