import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { parseConfig, Runtime, SimBackend } from "../src/index.ts";
import { AgentTalker, emptyTalkState, type TalkContext } from "../src/converse.ts";

// Why no agent spoke on mainnet on 2026-10-13 (docs/plans/AGENT-CONVERSATIONS.md 13), reproduced:
// a working agent's attempts reserve its whole vault, so the room an attempt would get is 0; an agent
// asleep on network compute has no vault room at all. A message costs cents and has its own room.

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const AGENT = generateAgentKey().id;

function runtime(o: { awake: boolean; vaultUsd: number; covered?: boolean; attempts?: number; provider?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "units-msgroom-"));
  dirs.push(dir);
  const key = generateAgentKey();
  const cfg = parseConfig({ mode: "sim", core: "http://127.0.0.1:1", state_dir: dir, runtime_key: join(dir, "k.json"), attempt_max_usd: 10, agent_epoch_max_usd: null, global_max_usd: 1000, min_attempt_usd: 0.01,
    compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001", sandbox_reserve_s: 100, usage_epoch_s: 3600, poll_ms: 1000, max_concurrent: 4, platform_funding: { enabled: true } });
  const rt = new Runtime(cfg, { backend: new SimBackend("http://127.0.0.1:1", key), runtimeKey: key, proposer: () => ({}) as never, log: () => undefined,
    ...(o.provider !== undefined ? { providerBalance: { room: () => o.provider, refresh: async () => undefined, state: {}, configured: true } as never } : {}) }) as any;
  rt.limits = { decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null };
  rt.prices = { decimals: 6, perUsd: 4_000_000n, perSandboxS: 1_000n, perSol: 0n };
  rt.vaults.set(AGENT, { balance: BigInt(Math.round(o.vaultUsd * 4_000_000)), awake: o.awake });
  rt.state.agents[AGENT] = { status: "bound", candidates: 0 };
  // running attempts: each holds its whole cap (10 USD) and the sandbox reserve
  for (let i = 0; i < (o.attempts ?? 0); i++) rt.attempts.set(i === 0 ? AGENT : `${AGENT}.s${i + 1}`, { agent: AGENT, maxUsd: 10, via: null, totals: { usd: 0, sandbox_s: 0 } });
  rt.covered = () => !!o.covered;
  return rt as Runtime & Record<string, any>;
}

test("a funded, awake agent whose attempts reserve its whole vault can still pay for a message (the cause on mainnet for working agents)", () => {
  const rt = runtime({ awake: true, vaultUsd: 9, attempts: 1 }); // 9 USD in the vault, an attempt running that holds its 10 USD cap
  expect(rt.budget(AGENT, { sandbox: false, cap: Infinity }).usd).toBeNull(); // what a post or an attempt would get: nothing
  const m = rt.messageRoom(AGENT);
  expect(m.why).toBeNull();
  expect(m.usd).toBeCloseTo(9, 3);
  // an empty vault still cannot pay, and says why
  const poor = runtime({ awake: true, vaultUsd: 0.01 }).messageRoom(AGENT);
  expect(poor.usd).toBeLessThan(0.03);
  expect(runtime({ awake: false, vaultUsd: 5 }).messageRoom(AGENT)).toEqual({ usd: 0, why: "asleep" });
});

test("an agent asleep on network compute: no vault room; network room when the network covers it, not held to the size of an attempt nor to running reserves", () => {
  const rt = runtime({ awake: false, vaultUsd: 1.05, covered: true, attempts: 1, provider: 0.5 });
  expect(rt.messageRoom(AGENT).usd).toBe(0);
  expect(rt.messageNetworkRoom(AGENT)).toEqual({ usd: 0.5, why: null }); // the running attempt's 10 USD reserve does not hide the provider's 0.5 USD
  expect(runtime({ awake: false, vaultUsd: 1, covered: false }).messageNetworkRoom(AGENT)).toEqual({ usd: 0, why: "the network does not cover this agent's compute" });
  expect(runtime({ awake: false, vaultUsd: 1, covered: true, provider: 0 }).messageNetworkRoom(AGENT).why).toBe("the provider balance is empty");
});

test("the talker: with a moment and no room it says why, once per cause per hour; network compute speaks only when the setting allows it", async () => {
  let now = Date.UTC(2026, 9, 13, 17);
  const log: string[] = [];
  const settings = { enabled: true, model: "claude-sonnet-5-5", max_usd_per_message: 0.03, max_bytes: 400, network_compute: false } as TalkContext["settings"];
  const ctx = (): TalkContext => ({ agent: AGENT, enabled: true, settings, budget: { ok: true, why: null, next_at: null },
    moments: [{ kind: "accepted", key: "accepted:g", lineage_id: "a".repeat(64), to: [{ agent: generateAgentKey().id, seat: null, name: "Holnotch" }], ref: null, thread: null, facts: "Your change: generation 1.", incoming: null, at: now }] });
  let calls = 0;
  const t = new AgentTalker({
    core: "http://core", state: () => state, save: () => undefined, now: () => now, log: (m) => log.push(m), poll_s: 0, meter: () => undefined, send: async () => "m".repeat(64),
    room: () => ({ usd: 0, why: "asleep" }), networkRoom: () => ({ usd: 0.4, why: null }),
    client: { create: async (p: any) => (calls++, { model: p.model, stop_reason: "end_turn", content: [{ type: "text", text: "Holnotch, generation 1 is accepted." }], usage: { input_tokens: 1, output_tokens: 1, usd: 0.004 } }) as never },
    fetch: async (u) => new Response(JSON.stringify(String(u).endsWith("/soul") ? { doc: SOUL } : ctx())),
  });
  const state = emptyTalkState();
  await t.tick([AGENT]);
  await t.tick([AGENT]);
  expect(calls).toBe(0);
  expect(log).toEqual([`${AGENT.slice(0, 6)} has something to say (accepted) but did not speak: its vault cannot pay for a message (asleep); messages on network compute are not allowed (setting network_compute)`]);
  now += 3_601_000;
  await t.tick([AGENT]);
  expect(log.length).toBe(2); // said again after an hour
  settings.network_compute = true;
  await t.tick([AGENT]);
  expect(calls).toBe(1);
  expect(state.log[0]).toMatchObject({ outcome: "sent", kind: "accepted" });
});

import { newSoul } from "../../souls/src/doc.ts";
import { persona, SEED } from "../../souls/test/fixtures.ts";
const SOUL = newSoul({ agent: AGENT, seed: SEED, persona: persona(), created_at: 1, origin: { by: "launcher", model: null, prompt_version: null } });
