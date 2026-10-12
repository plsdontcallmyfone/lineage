// The risk layer in Core (docs/plans/AGENT-WALLET-SAFETY.md "Risk management"): the rules only Core
// can see across agents, one test per rule. Core checks them on the trader's dry run before a trade,
// again when the trade is recorded, and answers the transaction firewall with the same check.
import { afterEach, describe, expect, test } from "bun:test";
import { generateAgentKey } from "../src/protocol.ts";
import { eligibilityRefusal, riskLimits, TRADING_DEFAULTS } from "../src/scores.ts";
import { agentClient, bare, expectOk, type Agent } from "./helpers.ts";
import { LEGACY_LIMITS } from "./legacy-limits.ts";

const envs: { close(): void }[] = [];
afterEach(() => {
  while (envs.length) envs.pop()!.close();
});
const DAY = 86_400_000;

function trade(agent: string, mint: string, side: "buy" | "sell", at: number, over: Record<string, unknown> = {}) {
  return { kind: "trade", ref: `trade:${agent}:${mint}:${at}:${side}`, agent, at, mint, side, venue: "sim", amount_in: "1000000", amount_out: "900000", rule: "agent_decision", reason: "test", score: { project: 0.5 }, signature: `sim:${at}`, ...over };
}
async function world(config: Record<string, unknown> = {}) {
  const e = bare();
  envs.push(e);
  const mk = async () => {
    const a = agentClient(e);
    const mint = generateAgentKey().id;
    await expectOk(e.admin.c.post("/v1/admin/launches", { agent: a.id, mint, launcher: generateAgentKey().id, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "app" }));
    return { ...a, mint } as Agent & { mint: string };
  };
  const [A, B, C, T] = [await mk(), await mk(), await mk(), await mk()];
  // the older rules out of the way, the risk rule under test set by each test
  await expectOk(e.admin.c.post("/v1/admin/trading/config", { ...LEGACY_LIMITS, cooldown_s: 0, min_hold_s: 0, ...config }));
  const rule = async (agent: Agent, mint: string, side: "buy" | "sell", over: Record<string, unknown> = {}) => {
    const r = await e.admin.c.post("/v1/trades", { ...trade(agent.id, mint, side, e.clock.now(), over), dry_run: true });
    return r.status === 200 ? "ok" : String(r.body.error);
  };
  const put = (agent: Agent, mint: string, side: "buy" | "sell", over: Record<string, unknown> = {}) => expectOk(e.admin.c.post("/v1/trades", trade(agent.id, mint, side, e.clock.now(), over)));
  const check = async (agent: Agent, mint: string, side: string) => (await expectOk(e.anon.get(`/v1/trading/check?agent=${agent.id}&mint=${mint}&side=${side}`)));
  return { e, A, B, C, T, rule, put, check };
}

describe("token eligibility (buys only)", () => {
  test("the rule itself: accepted work, launch age, hidden list, in that order of report", () => {
    const cfg = TRADING_DEFAULTS;
    const now = 10 * DAY;
    expect(eligibilityRefusal({ accepted: 1, launched_at: now - DAY, hidden: false }, cfg, now)).toBeNull();
    expect(eligibilityRefusal({ accepted: 0, launched_at: now - 30 * DAY, hidden: false }, cfg, now)?.rule).toBe("ineligible_generations");
    expect(eligibilityRefusal({ accepted: 5, launched_at: now - DAY + 1, hidden: false }, cfg, now)?.rule).toBe("ineligible_age");
    expect(eligibilityRefusal({ accepted: 5, launched_at: null, hidden: false }, cfg, now)?.rule).toBe("ineligible_age");
    expect(eligibilityRefusal({ accepted: 5, launched_at: 0, hidden: true }, cfg, now)?.rule).toBe("ineligible_hidden");
    expect(eligibilityRefusal(null, cfg, now)?.rule).toBe("ineligible_unknown");
  });

  test("a token whose agent has no accepted generation cannot be bought; it can be sold", async () => {
    const w = await world({ eligibility_min_generations: 1 });
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ineligible_generations");
    expect(await w.rule(w.A, w.T.mint, "sell")).toBe("ok");
    const el = await expectOk(w.e.anon.get("/v1/trading/eligibility"));
    expect(el.tokens.find((t: any) => t.mint === w.T.mint)).toMatchObject({ accepted: 0, hidden: false, eligible: false, rule: "ineligible_generations" });
    expect(await w.check(w.A, w.T.mint, "buy")).toMatchObject({ ok: false, rule: "ineligible_generations" });
  });

  test("a launch younger than the minimum age cannot be bought until it is old enough", async () => {
    const w = await world({ eligibility_min_age_s: 86_400 });
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ineligible_age");
    w.e.clock.advance(DAY - 60_000);
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ineligible_age");
    w.e.clock.advance(61_000);
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ok");
  });

  test("a token on the hidden list cannot be bought", async () => {
    const w = await world();
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ok");
    await expectOk(w.e.admin.c.post("/v1/admin/hidden", { add: [{ mint: w.T.mint, agent: w.T.id, reason: "test launch" }] }));
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ineligible_hidden");
    expect(await w.rule(w.A, w.T.mint, "sell")).toBe("ok");
  });
});

describe("network-wide guards", () => {
  test("herding: no more than N agents buy the same token within the window", async () => {
    const w = await world({ herd_max_agents: 2, herd_window_s: 3600 });
    await w.put(w.A, w.T.mint, "buy");
    expect(await w.rule(w.C, w.T.mint, "buy")).toBe("ok");
    await w.put(w.B, w.T.mint, "buy");
    expect(await w.rule(w.C, w.T.mint, "buy")).toBe("herd_limit");
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ok"); // its own earlier buy does not count against it
    expect((await w.e.admin.c.post("/v1/trades", trade(w.C.id, w.T.mint, "buy", w.e.clock.now()))).body.error).toBe("herd_limit"); // the record itself is refused too
    w.e.clock.advance(3_600_000);
    expect(await w.rule(w.C, w.T.mint, "buy")).toBe("ok");
  });

  test("wash guard: no agent buys what another hosted agent sold within the window, nor sells what another bought; a risk exit is not held back", async () => {
    const w = await world({ wash_window_s: 86_400 });
    await w.put(w.A, w.T.mint, "buy");
    expect(await w.rule(w.B, w.T.mint, "sell")).toBe("wash_guard");
    expect(await w.rule(w.B, w.T.mint, "sell", { rule: "stop_loss" })).toBe("ok");
    expect(await w.rule(w.B, w.T.mint, "buy")).toBe("ok"); // the same side is not a wash
    expect(await w.rule(w.A, w.T.mint, "sell")).toBe("ok"); // its own position
    await w.put(w.A, w.T.mint, "sell");
    expect(await w.rule(w.B, w.T.mint, "buy")).toBe("wash_guard");
    w.e.clock.advance(DAY);
    expect(await w.rule(w.B, w.T.mint, "buy")).toBe("ok");
  });

  test("what hosted agents hold of a token is summed from the records, for the exposure cap", async () => {
    const w = await world();
    await w.put(w.A, w.T.mint, "buy", { amount_out: "700" });
    w.e.clock.advance(1000);
    await w.put(w.B, w.T.mint, "buy", { amount_out: "500" });
    w.e.clock.advance(1000);
    await w.put(w.A, w.T.mint, "sell", { amount_in: "200", rule: "take_profit" });
    const r = await expectOk(w.e.anon.get("/v1/trading/risk"));
    expect(r.tokens.find((t: any) => t.mint === w.T.mint)).toMatchObject({ network_held: "1000", holders_among_agents: 2 });
    expect((await w.check(w.C, w.T.mint, "buy")).network_held).toBe("1000");
  });
});

describe("per-agent limits Core counts", () => {
  test("trades per day: at the cap no further buy until the next UTC day; a sell still goes", async () => {
    const w = await world({ max_trades_per_day: 3 });
    for (let i = 0; i < 3; i++) (await w.put(w.A, w.T.mint, i === 1 ? "sell" : "buy"), w.e.clock.advance(1000));
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("max_trades_per_day");
    expect(await w.rule(w.A, w.T.mint, "sell")).toBe("ok");
    expect(await w.rule(w.B, w.T.mint, "buy")).toBe("ok");
    expect((await expectOk(w.e.anon.get(`/v1/agents/${w.A.id}/risk`))).exposure.trades_today).toBe(3);
    w.e.clock.advance(DAY);
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ok");
  });

  test("circuit breaker: a breaker halt stops the agent until the launcher or the admin resets it", async () => {
    const w = await world();
    await expectOk(w.e.admin.c.post("/v1/trades", { kind: "halt", ref: `halt:${w.A.id}:breaker:1`, agent: w.A.id, at: w.e.clock.now(), rule: "breaker", reason: "3 failed or refused transactions within 3600 s" }));
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("integrity_halted");
    w.e.clock.advance(3 * DAY);
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("integrity_halted"); // not until the day ends: until a reset
    expect((await expectOk(w.e.anon.get(`/v1/agents/${w.A.id}/risk`))).halt).toMatchObject({ rule: "breaker", until: null });
    expect((await expectOk(w.e.anon.get("/v1/trading/risk"))).network.halted).toEqual([expect.objectContaining({ agent: w.A.id, rule: "breaker" })]);
    await expectOk(w.e.admin.c.post(`/v1/agents/${w.A.id}/trading/reset`, { note: "looked at it" }));
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ok");
  });
});

describe("global circuit breakers", () => {
  test("the kill switch: an admin route and a config flag; no agent buys, every agent can still sell", async () => {
    const w = await world();
    expect((await agentClient(w.e).c.post("/v1/admin/trading/reduce-only", { on: true })).status).toBe(403);
    const on = await expectOk(w.e.admin.c.post("/v1/admin/trading/reduce-only", { on: true, reason: "incident 7" }));
    expect([on.reduce_only, on.reduce_only_reason]).toEqual([true, "incident 7"]);
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("reduce_only");
    expect(await w.rule(w.B, w.T.mint, "buy")).toBe("reduce_only");
    expect(await w.rule(w.A, w.T.mint, "sell")).toBe("ok");
    expect(await w.check(w.A, w.T.mint, "buy")).toMatchObject({ ok: false, rule: "reduce_only" });
    expect((await expectOk(w.e.anon.get("/v1/trading/risk")))).toMatchObject({ reduce_only: true, reduce_only_reason: "incident 7" });
    // the flag alone does the same, and clearing it clears the reason
    const off = await expectOk(w.e.admin.c.post("/v1/admin/trading/config", { reduce_only: false }));
    expect([off.reduce_only, off.reduce_only_reason]).toEqual([false, null]);
    expect(await w.rule(w.A, w.T.mint, "buy")).toBe("ok");
  });

  test("network drawdown past the threshold turns reduce-only on by itself; a funding is not gain", async () => {
    const w = await world({ network_drawdown_bps: 500 });
    const snap = (equity: string) => ({ treasury: { key: "k", line: equity, sol: "1", equity, positions: 0 } });
    await w.put(w.A, w.T.mint, "buy", snap("1000000000"));
    w.e.clock.advance(1000);
    await w.put(w.B, w.T.mint, "buy", snap("1000000000"));
    let r = await expectOk(w.e.anon.get("/v1/trading/risk"));
    expect(r.network).toMatchObject({ equity: "2000000000", peak: "2000000000", drawdown_bps: 0 });
    // 4.9% below the peak: nothing happens
    w.e.clock.advance(1000);
    await w.put(w.A, w.T.mint, "buy", snap("902000000"));
    expect((await expectOk(w.e.anon.get("/v1/trading/config"))).reduce_only).toBe(false);
    // 5.05% below: reduce only, with the reason
    w.e.clock.advance(1000);
    await w.put(w.A, w.T.mint, "sell", { ...snap("899000000"), rule: "stop_loss" });
    const c = await expectOk(w.e.anon.get("/v1/trading/config"));
    expect(c.reduce_only).toBe(true);
    expect(c.reduce_only_reason).toMatch(/^automatic: network equity 1899000000 fell more than 500 bps below its peak 2000000000$/);
    expect(await w.rule(w.B, w.T.mint, "buy")).toBe("reduce_only");
    expect(await w.rule(w.B, w.T.mint, "sell")).toBe("ok");
    r = await expectOk(w.e.anon.get("/v1/trading/risk"));
    expect(r.network.drawdown_bps).toBe(505);
  });
});

describe("reporting", () => {
  test("an agent's risk panel: the limits in force, exposure as last recorded, halts and refusals", async () => {
    const w = await world();
    await w.put(w.A, w.T.mint, "buy", { amount_out: "5000", treasury: { key: "k", line: "900000000", sol: "1", equity: "1000000000", positions: 1 } });
    await expectOk(w.e.admin.c.post("/v1/trades", { kind: "decision", ref: `decision:${w.A.id}:1`, agent: w.A.id, at: w.e.clock.now(), outcome: "refused", rule: "max_deployed", detail: "positions would exceed 2500 bps of equity", thesis: "x".repeat(30), action: "buy", mint: w.T.mint }));
    const r = await expectOk(w.e.anon.get(`/v1/agents/${w.A.id}/risk`));
    expect(r.exposure).toMatchObject({ equity: "1000000000", cash: "900000000", deployed: "100000000", deployed_bps: 1000, trades_today: 1, positions: [{ mint: w.T.mint, amount: "5000" }] });
    expect(r.refusals).toEqual([expect.objectContaining({ rule: "max_deployed" })]);
    expect(r.halt).toBeNull();
    expect(r.limits).toEqual(riskLimits((await expectOk(w.e.anon.get("/v1/trading/config")))));
    expect((await w.e.anon.get(`/v1/agents/${generateAgentKey().id}/risk`)).status).toBe(404);
  });
});
