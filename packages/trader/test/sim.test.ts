import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { registerScoreInputs, type TradingConfig } from "../../core/src/scores.ts";
import { agentClient, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "../../core/test/helpers.ts";
import { emptyUsage, type DecisionModel, type Usage } from "../src/analyst.ts";
import { Trader, type MarketToken, type TradingAgent } from "../src/trader.ts";
import { SimVenue, type Fill, type TraderKey } from "../src/venue.ts";
import type { TokenView } from "../src/policy.ts";

// The simulated market (plan T exit, owner amendment 2026-10-10): a real Core (in process, fake clock)
// publishes scores and stores records; constant-product pools with a 3% fee stand in for DBC and DAMM
// v2; outside traders move prices. Each hosted agent's "model" is scripted and partly adversarial: it
// answers with valid decisions, oversized ones, its own token, a same-launcher token, an excluded
// token, extra fields and garbage. Afterwards every published record is checked against every limit
// and integrity rule, and the posts against their order (never before the trade is recorded).

const L = 1_000_000n;
const dirs: string[] = [];
const envs: Env[] = [];
afterEach(() => {
  while (envs.length) envs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

type A = Agent & { mint: string; launcher: string };
interface World {
  env: Env;
  venue: SimVenue;
  agents: A[];
  scores: Map<string, number>;
  trader: Trader;
  calls: { agent: string; maxUsd: number; at: number }[];
  posts: { agent: string; board: string; text: string; at: number; recordsAtPost: number }[];
  events: string[];
  metered: Usage[];
  room: { usd: number };
}

type Script = (agent: A, w: World, user: string) => string;

async function world(n: number, script: Script, o: { siblings?: boolean; excluded?: boolean; poolQuote?: bigint; config?: Record<string, unknown>; treasury?: bigint } = {}): Promise<World> {
  const env = await setup({ verifiers: 3 });
  envs.push(env);
  const venue = new SimVenue();
  const agents: A[] = [];
  for (let i = 0; i < n; i++) {
    const a = await makeAuthor(env);
    const row = env.core.db.query<{ mint: string; launcher: string }, [string]>("SELECT mint, launcher FROM agents WHERE agent_id = ?").get(a.id)!;
    agents.push({ ...a, ...row });
  }
  const extra: A[] = [];
  if (o.siblings) {
    const sib = agentClient(env);
    const mint = generateAgentKey().id;
    await expectOk(env.admin.c.post("/v1/admin/launches", { agent: sib.id, mint, launcher: agents[0]!.launcher, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "app" }));
    extra.push({ ...sib, mint, launcher: agents[0]!.launcher });
  }
  if (o.excluded) {
    const x = await makeAuthor(env);
    const row = env.core.db.query<{ mint: string; launcher: string }, [string]>("SELECT mint, launcher FROM agents WHERE agent_id = ?").get(x.id)!;
    extra.push({ ...x, ...row });
    await expectOk(env.admin.c.post("/v1/admin/trading/config", { excluded_agents: { [x.id]: "standing TEST agent: never talks about tokens" } }));
  }
  const all = [...agents, ...extra];
  for (const a of all) {
    venue.addPool(a.mint, { base: 1_000_000n * L, quote: (o.poolQuote ?? 100_000n) * L, fee_bps: 300, decimals: 6 });
    venue.fund(a.key.id, o.treasury ?? 1000n * L);
  }
  const scores = new Map<string, number>();
  registerScoreInputs(env.core, { leaderboardRank: (a) => scores.get(a) ?? null });
  await expectOk(env.admin.c.post("/v1/admin/trading/config", { round_s: 60, ...(o.config ?? {}) }));
  const tokens = (): MarketToken[] => all.map((a) => ({ mint: a.mint, agent: a.id, price: venue.price(a.mint), decimals: 6, change_24h: null, venue: "sim", info: { symbol: `T${a.mint.slice(0, 4)}`, phase: "curve", volume_24h: null, trades_24h: null, holders: null, curve_progress: null, repo_url: null, class: null, lineage_id: env.lineage } }));
  const dir = mkdtempSync(join(tmpdir(), "lineage-trader-sim-"));
  dirs.push(dir);
  const w = { env, venue, agents: all, scores, calls: [], posts: [], events: [], metered: [], room: { usd: 1 } } as unknown as World;
  const byId = new Map(all.map((a) => [a.id, a]));
  // the venue logs fills so the order fill -> record -> post can be checked
  const exec = venue.execute.bind(venue);
  venue.execute = async (owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint, minOut: bigint): Promise<Fill> => {
    const f = await exec(owner, t, side, amountIn, minOut);
    w.events.push(`fill ${f.signature}`);
    return f;
  };
  const model = (agent: string): DecisionModel => ({
    id: "test/scripted",
    async complete(q) {
      w.calls.push({ agent, maxUsd: q.maxUsd, at: env.clock.now() });
      const u = { ...emptyUsage(), input_tokens: 1000, output_tokens: 100, usd: 0.003, calls: 1, models: ["test/scripted"] };
      return { text: script(byId.get(agent)!, w, q.user), usage: u };
    },
  });
  w.trader = new Trader({
    core: env.base,
    runtimeKey: env.admin.key,
    venue,
    tokens: async () => tokens(),
    agents: async (): Promise<TradingAgent[]> => all.map((a) => ({ agent: a.id, mint: a.mint, key: a.key })),
    stateDir: dir,
    lineDecimals: 6,
    now: () => env.clock.now(),
    log: process.env.TRADER_SIM_DEBUG ? (m) => console.log(m) : () => {},
    analysis: {
      model: async (agent) => ({ model: model(agent) }),
      room: () => w.room.usd,
      meter: (_agent, u) => w.metered.push(u),
      post: async (agent, board, text) => {
        const recs = await records(env);
        w.posts.push({ agent, board, text, at: env.clock.now(), recordsAtPost: recs.length });
        w.events.push(`post ${text}`);
        return `msg-${w.posts.length}`;
      },
    },
  });
  // record publication order (Core's events, in order)
  env.core.subscribe((e) => {
    if (e.type.startsWith("trade.")) w.events.push(`record ${(e.data as any).ref}`);
  });
  return w;
}

async function records(env: Env): Promise<any[]> {
  const out: any[] = [];
  let before: number | undefined;
  for (;;) {
    const r = await expectOk(env.anon.get(`/v1/trades?limit=500${before ? `&before=${before}` : ""}`));
    out.push(...r.records);
    if (r.records.length < 500) break;
    before = r.records[r.records.length - 1].id;
  }
  return out.reverse();
}

const decision = (action: string, token: string | null, size: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ thesis: "Public accepted work is strong and the token trades with depth.", action, token, size_pct: size, reason: "public record", ...extra });

describe("simulated market with the agents' own (scripted, partly adversarial) decisions", () => {
  test("six hours: every trade within every limit, every refusal published with its rule, posts only after the record", async () => {
    const r = rng(11);
    const script: Script = (me, w) => {
      const others = w.agents.filter((a) => a.id !== me.id);
      const pick = others[Math.floor(r() * others.length)]!;
      const x = r();
      if (x < 0.4) return decision("buy", pick.mint, [1, 2, 3][Math.floor(r() * 3)]!);
      if (x < 0.55) return decision("sell", pick.mint, [25, 50, 100][Math.floor(r() * 3)]!);
      if (x < 0.62) return decision("buy", pick.mint, 50); // oversize
      if (x < 0.68) return decision("buy", me.mint, 1); // own token
      if (x < 0.72) return decision("buy", pick.mint, 1, { max_trade_bps: 10000 }); // tries to change a limit
      if (x < 0.76) return "Sure! Buying everything.";
      if (x < 0.8) return decision("buy", w.agents[w.agents.length - 1]!.mint, 1); // the excluded token
      return decision("hold", null, 0);
    };
    const w = await world(4, script, { siblings: true, excluded: true });
    const { env, venue, agents, scores } = w;
    const excluded = agents[agents.length - 1]!;
    const tr = rng(5);
    agents.forEach((a, i) => scores.set(a.id, i + 1));
    for (let i = 0; i < 360; i++) {
      for (const a of agents) {
        const buy = tr() < 0.5;
        const size = BigInt(Math.floor(tr() * 400)) * L;
        if (size > 0n) venue.shock(a.mint, buy, buy ? size : size * 10n);
      }
      await w.trader.tick();
      env.clock.advance(60_000);
    }
    const recs = await records(env);
    const trades = recs.filter((x) => x.kind === "trade");
    const decisions = recs.filter((x) => x.kind === "decision");
    const cfg = (await env.anon.get("/v1/trading/config")).body as TradingConfig;
    if (process.env.TRADER_SIM_DEBUG) console.log(JSON.stringify({ trades: trades.length, decisions: decisions.length, rules: decisions.map((d) => d.rule), hits: w.trader.state.limit_hits }, null, 1));
    expect(trades.length).toBeGreaterThan(30);
    expect(trades.some((t) => t.side === "sell")).toBe(true);
    // the excluded agent never analysed, never traded, and nobody traded its token
    expect(w.calls.some((c) => c.agent === excluded.id)).toBe(false);
    expect(recs.some((x) => x.agent === excluded.id)).toBe(false);
    // not even gas or a balance read: its treasury was never touched
    expect(w.venue.wallet(excluded.key.id).sol).toBe(1_000_000_000n);
    expect(trades.some((t) => t.mint === excluded.mint)).toBe(false);
    // every round's cost was capped at the configured per-round cap and metered
    expect(w.calls.every((c) => c.maxUsd === cfg.analysis_max_usd)).toBe(true);
    expect(w.metered.length).toBe(w.calls.length);
    // adversarial decisions were refused with their rule, never executed
    const rules = new Set(decisions.filter((d) => d.outcome === "refused").map((d) => d.rule));
    for (const r of ["invalid_decision", "temperament_size", "integrity_own_token", "integrity_excluded"]) expect(rules.has(r)).toBe(true);
    const mintOwner = new Map(agents.map((a) => [a.mint, a]));
    const byAgent = new Map(agents.map((a) => [a.id, a]));
    const lastIn = new Map<string, any>();
    for (const t of trades) {
      expect(typeof t.reason).toBe("string");
      if (t.rule === "agent_decision") {
        expect(t.thesis.length).toBeGreaterThan(10);
        expect(t.model).toBe("test/scripted");
      } else expect(["stop_loss", "take_profit"]).toContain(t.rule);
      const me = byAgent.get(t.agent)!;
      const owner = mintOwner.get(t.mint)!;
      expect(owner.id).not.toBe(t.agent);
      expect(owner.launcher).not.toBe(me.launcher);
      const eq = BigInt(t.equity_before);
      if (t.side === "buy") {
        expect(BigInt(t.amount_in) * 10_000n).toBeLessThanOrEqual(eq * BigInt(cfg.max_trade_bps));
        expect((BigInt(t.position_before) + BigInt(t.amount_in)) * 10_000n).toBeLessThanOrEqual(eq * BigInt(cfg.max_position_bps) + 10_000n);
        if (t.decision) expect(BigInt(t.amount_in)).toBe(BigInt(t.planned_in)); // never resized
      }
      expect(BigInt(t.amount_out)).toBeGreaterThanOrEqual(BigInt(t.min_out));
      expect(t.impact_bps).toBeLessThanOrEqual(cfg.max_impact_bps);
      expect(t.treasury.positions).toBeLessThanOrEqual(cfg.max_open_positions);
      const k = `${t.agent}:${t.mint}`;
      const prev = lastIn.get(k);
      if (prev) {
        expect(t.at - prev.at).toBeGreaterThanOrEqual(cfg.cooldown_s * 1000);
        if (prev.side !== t.side) expect(t.at - prev.at).toBeGreaterThanOrEqual(cfg.min_hold_s * 1000);
      }
      lastIn.set(k, t);
    }
    // posts: one per filled or refused decision, never for a hold; each after its fill and its record
    const filled = trades.filter((t) => t.rule === "agent_decision").length;
    const refused = decisions.filter((d) => d.outcome === "refused").length;
    expect(w.posts.length).toBe(filled + refused);
    for (let i = 0; i < w.events.length; i++) {
      const e = w.events[i]!;
      if (!e.startsWith("post ")) continue;
      const id = /#r(\d+)/.exec(e)?.[1];
      expect(id).toBeDefined();
      const rec = recs.find((x) => String(x.id) === id)!;
      expect(rec).toBeDefined();
      // the record's event came before the post
      expect(w.events.slice(0, i).includes(`record ${rec.ref}`)).toBe(true);
      if (rec.kind === "trade") {
        expect(w.events.slice(0, i).includes(`fill ${rec.signature}`)).toBe(true);
        expect(e).toContain("Filled");
      } else expect(e).toMatch(new RegExp(`refused by the engine: ${rec.rule}`, "i"));
      expect(new TextEncoder().encode(e.slice(5)).length).toBeLessThanOrEqual(560);
    }
  }, 180_000);

  test("no analysis without room under the caps; nothing posted, nothing spent", async () => {
    const w = await world(3, (me, w) => decision("buy", w.agents.find((a) => a.id !== me.id)!.mint, 1));
    w.room.usd = 0.01; // below the per-round cap of 0.05
    await w.trader.tick();
    expect(w.calls).toHaveLength(0);
    expect(w.posts).toHaveLength(0);
    expect(w.trader.state.limit_hits.analysis_budget).toBe(3);
  });

  test("slippage: a price moved beyond 2% between quote and fill fails the trade; the refusal is published, then posted", async () => {
    const w = await world(3, (me, w) => decision("buy", w.agents.find((a) => a.id !== me.id)!.mint, 2));
    const exec = w.venue.execute.bind(w.venue);
    w.venue.execute = async (owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint, minOut: bigint): Promise<Fill> => {
      w.venue.shock(t.mint, side === "buy", 20_000n * L);
      return exec(owner, t, side, amountIn, minOut);
    };
    await w.trader.tick();
    const recs = await records(w.env);
    expect(recs.filter((x) => x.kind === "trade")).toHaveLength(0);
    expect(recs.filter((x) => x.kind === "decision").every((d) => d.rule === "execution_failed")).toBe(true);
    expect(w.posts.length).toBe(3);
    expect(w.posts.every((p) => p.text.includes("Refused by the engine: execution_failed"))).toBe(true);
  });

  test("price impact over 1%: refused, never shrunk", async () => {
    const w = await world(3, (me, w) => decision("buy", w.agents.find((a) => a.id !== me.id)!.mint, 3), { poolQuote: 1000n });
    await w.trader.tick();
    const recs = await records(w.env);
    expect(recs.filter((x) => x.kind === "trade")).toHaveLength(0);
    expect(recs.filter((x) => x.kind === "decision").map((d) => d.rule)).toEqual(["max_impact", "max_impact", "max_impact"]);
  });

  test("verdict window: an agent with an open candidate neither analyses nor trades until its verdict plus the window", async () => {
    const w = await world(3, (me, w) => decision("buy", w.agents.find((a) => a.id !== me.id)!.mint, 1));
    const { env, agents } = w;
    const busy = agents[0]!;
    const c = await submit(env, busy, diff("perf"));
    await w.trader.tick();
    expect(w.calls.some((x) => x.agent === busy.id)).toBe(false);
    expect(w.calls.some((x) => x.agent !== busy.id)).toBe(true);
    expect(JSON.stringify(await records(env))).not.toContain("verdict_window");
    await runReplays(env, c.candidate_id, honest(result()));
    env.clock.advance(60_000);
    await w.trader.tick();
    expect(w.calls.some((x) => x.agent === busy.id)).toBe(false);
    env.clock.advance(300_000);
    await w.trader.tick();
    expect(w.calls.some((x) => x.agent === busy.id)).toBe(true);
  });

  test("drawdown halt: published, no model call while halted, lifted only by a reset", async () => {
    const w = await world(3, (me, w) => decision("buy", w.agents.find((a) => a.id !== me.id)!.mint, 1), { config: { daily_loss_bps: 10_000 } });
    const { env, agents, venue } = w;
    await w.trader.tick();
    const victim = agents[0]!;
    const wal = venue.wallet(victim.key.id);
    wal.line = (wal.line * 3n) / 4n - 100n * L;
    env.clock.advance(120_000);
    await w.trader.tick();
    expect((await records(env)).some((x) => x.kind === "halt" && x.agent === victim.id && x.rule === "max_drawdown")).toBe(true);
    const before = w.calls.filter((c) => c.agent === victim.id).length;
    env.clock.advance(2 * 86_400_000);
    await w.trader.tick();
    expect(w.calls.filter((c) => c.agent === victim.id).length).toBe(before);
    await expectOk(env.admin.c.post(`/v1/agents/${victim.id}/trading/reset`, { note: "test" }));
    env.clock.advance(120_000);
    await w.trader.tick();
    expect(w.calls.filter((c) => c.agent === victim.id).length).toBeGreaterThan(before);
  });
});
