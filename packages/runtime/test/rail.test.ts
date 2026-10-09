// Credit rails (plan C) against a mocked OpenRouter: no real key, no real purchase, no network
// beyond 127.0.0.1. The mock speaks the shapes of OpenRouter's docs: POST /api/v1/messages
// (Anthropic format, bearer key), GET /api/v1/credits ({ data: { total_credits, total_usage } }),
// and the removed POST /api/v1/credits/coinbase (410 today; the legacy charge shape when told to).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { checkCorePrices, CreditMonitor, parseRail, railClient, railModel, railPrices, type CoinbaseCharge, type OpenRouterRailConfig } from "../src/rail.ts";

const KEY = "sk-or-v1-TESTONLY-not-a-real-key";
const MGMT = "sk-or-v1-MGMT-TESTONLY";
const SENDER = "0x1111111111111111111111111111111111111111";
const mock = {
  credits: 100,
  usage: 10,
  coinbase: "gone" as "gone" | "ok" | "wrong-chain" | "500",
  seen: [] as { method: string; path: string; auth: string | null; xkey: string | null; body: any }[],
};
let server: ReturnType<typeof Bun.serve>;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "lineage-rail-"));
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      mock.seen.push({ method: req.method, path: u.pathname, auth: req.headers.get("authorization"), xkey: req.headers.get("x-api-key"), body });
      if (u.pathname === "/api/v1/messages" && req.method === "POST") {
        if (req.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ error: { code: 401, message: "Missing Authentication header" } }, { status: 401 });
        return Response.json({ id: "gen-1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 18, cache_creation_input_tokens: null, cache_read_input_tokens: null, cost: 0.00051 } });
      }
      if (u.pathname === "/api/v1/credits" && req.method === "GET") {
        if (req.headers.get("authorization") !== `Bearer ${MGMT}`) return Response.json({ error: { code: 403, message: "management key required" } }, { status: 403 });
        return Response.json({ data: { total_credits: mock.credits, total_usage: mock.usage } });
      }
      if (u.pathname === "/api/v1/credits/coinbase" && req.method === "POST") {
        if (mock.coinbase === "gone")
          return Response.json({ error: { code: 410, message: "The Coinbase APIs used by this endpoint have been deprecated, so the Coinbase Commerce credits API has been removed. Use the web credits purchase flow instead." } }, { status: 410 });
        if (mock.coinbase === "500") return new Response("boom", { status: 500 });
        const charge: CoinbaseCharge = { id: `charge-${mock.seen.length}`, created_at: "2026-10-09T00:00:00Z", expires_at: "2026-10-09T01:00:00Z",
          web3_data: { transfer_intent: { metadata: { chain_id: mock.coinbase === "wrong-chain" ? 1 : body.chain_id, contract_address: "0x2222222222222222222222222222222222222222", sender: body.sender },
            call_data: { deadline: "2026-10-09T01:00:00Z", fee_amount: "1", id: "0xabc", operator: "0x3333333333333333333333333333333333333333", recipient: "0x4444444444444444444444444444444444444444", recipient_amount: "1", recipient_currency: "0x0", signature: "0xsig" } } } };
        return Response.json({ data: charge });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}/api`;
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const OR = (over: Partial<OpenRouterRailConfig> = {}): OpenRouterRailConfig => ({ enabled: true, base_url: base, model: "anthropic/claude-opus-4.5", price_as: "claude-opus-5-5", floor_usd: 50, ...over });
const env = { OPENROUTER_API_KEY: KEY, OPENROUTER_MANAGEMENT_KEY: MGMT };
const topup = (over: Partial<NonNullable<OpenRouterRailConfig["topup"]>> = {}) => ({ enabled: true, method: "coinbase" as const, amount_usd: 100, max_daily_usd: 150, chain_id: 8453 as const, sender: SENDER, ...over });

describe("rail config", () => {
  const rc = { mode: "sim", core: "http://x", runtime_key: "k", compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002" };
  test("anthropic is the default; openrouter is refused while OFF", () => {
    expect(parseConfig(rc).rail).toBe("anthropic");
    expect(() => parseConfig({ ...rc, rail: "openrouter" })).toThrow(/OFF/);
    expect(() => parseConfig({ ...rc, rail: "openrouter", openrouter: OR({ enabled: false }) })).toThrow(/OFF/);
    expect(parseConfig({ ...rc, rail: "openrouter", openrouter: OR() }).rail).toBe("openrouter");
    expect(() => parseConfig({ ...rc, rail: "other" })).toThrow(/rail is/);
  });
  test("top-up limits: 1 to 2000 USD, a daily cap, Ethereum/Polygon/Base, an EVM sender, a known price model", () => {
    expect(() => parseRail({ openrouter: OR({ topup: topup({ amount_usd: 2001, max_daily_usd: 5000 }) }) })).toThrow(/1 to 2000/);
    expect(() => parseRail({ openrouter: OR({ topup: topup({ max_daily_usd: 50 }) }) })).toThrow(/max_daily_usd/);
    expect(() => parseRail({ openrouter: OR({ topup: topup({ chain_id: 10 as any }) }) })).toThrow(/chain_id/);
    expect(() => parseRail({ openrouter: OR({ topup: topup({ sender: "0x12" }) }) })).toThrow(/sender/);
    expect(() => parseRail({ openrouter: OR({ price_as: "gpt" }) })).toThrow(/price_as/);
    expect(() => parseRail({ openrouter: OR({ base_url: "http://evil.example" }) })).toThrow(/https/);
    expect(railPrices({ rail: "openrouter", openrouter: OR() })!.input).toBe(railPrices({ rail: "openrouter", openrouter: OR({ price_as: "claude-opus-5-5" }) })!.input);
    expect(railPrices({ rail: "anthropic", openrouter: null })).toBeUndefined();
  });
});

describe("openrouter as the model endpoint", () => {
  test("the Claude proposer's client reaches /api/v1/messages with the bearer key only", async () => {
    const r = { rail: "openrouter" as const, openrouter: OR() };
    const client = railClient(r, env)!;
    const msg = await client.messages.create({ model: railModel(r, "claude-opus-5-5"), max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(msg.usage.input_tokens).toBe(12);
    const call = [...mock.seen].reverse().find((s) => s.path === "/api/v1/messages")!;
    expect(call.auth).toBe(`Bearer ${KEY}`);
    expect(call.xkey).toBeNull();
    expect(call.body.model).toBe("anthropic/claude-opus-4.5");
  });
  test("anthropic rail leaves the SDK default; a missing OpenRouter key is an error that names the variable, not the value", () => {
    expect(railClient({ rail: "anthropic", openrouter: null }, env)).toBeUndefined();
    expect(() => railClient({ rail: "openrouter", openrouter: OR() }, {})).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("balance monitor and top-up", () => {
  const mon = (o: OpenRouterRailConfig, extra: Partial<ConstructorParameters<typeof CreditMonitor>[1]> = {}) => {
    const alerts: string[] = [];
    const logs: string[] = [];
    const m = new CreditMonitor(o, { statePath: join(dir, `${Math.random()}.json`), env, log: (x) => logs.push(x), alert: (x) => alerts.push(x), ...extra });
    return { m, alerts, logs };
  };
  test("above the floor: nothing; below: one alert when it crosses, none while it stays", async () => {
    mock.credits = 100, mock.usage = 10;
    const { m, alerts } = mon(OR());
    expect(await m.tick()).toEqual({ balance: 90, action: "none" });
    mock.usage = 60;
    expect(await m.tick()).toEqual({ balance: 40, action: "alert" });
    expect(await m.tick()).toEqual({ balance: 40, action: "disabled" });
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatch(/below the floor 50/);
  });
  test("the real API today: 410 means purchase unavailable, one alert, no retry inside the window", async () => {
    mock.credits = 100, mock.usage = 60, mock.coinbase = "gone";
    let t = 1_000_000;
    const { m, alerts } = mon(OR({ topup: topup() }), { now: () => t, payer: { pay: async () => ({ tx_hash: "0xnever" }) } });
    const before = mock.seen.filter((s) => s.path.endsWith("/coinbase")).length;
    expect((await m.tick()).action).toBe("unavailable");
    expect(alerts.some((a) => /410/.test(a) && /settings\/credits/.test(a))).toBe(true);
    t += 3_600_000;
    expect((await m.tick()).action).toBe("unavailable");
    expect(mock.seen.filter((s) => s.path.endsWith("/coinbase")).length).toBe(before + 1);
    expect(m.state.purchases).toEqual([]);
    t += 86_400_000;
    expect((await m.tick()).action).toBe("unavailable"); // tried again after a day, still gone
    expect(mock.seen.filter((s) => s.path.endsWith("/coinbase")).length).toBe(before + 2);
  });
  test("legacy charge shape (mock only): request body, calldata handed to the treasury payer, daily cap", async () => {
    mock.credits = 100, mock.usage = 60, mock.coinbase = "ok";
    const paid: CoinbaseCharge[] = [];
    const { m } = mon(OR({ topup: topup() }), { payer: { pay: async (c) => (paid.push(c), { tx_hash: `0xtx${paid.length}` }) } });
    expect((await m.tick()).action).toBe("purchased");
    const req = [...mock.seen].reverse().find((s) => s.path.endsWith("/coinbase"))!;
    expect(req.body).toEqual({ amount: 100, sender: SENDER, chain_id: 8453 });
    expect(req.auth).toBe(`Bearer ${MGMT}`);
    expect(paid[0]!.web3_data.transfer_intent.metadata.chain_id).toBe(8453);
    expect(m.state.purchases[0]).toMatchObject({ amount_usd: 100, tx_hash: "0xtx1", chain_id: 8453, status: "sent" });
    // a second 100 USD would pass max_daily_usd 150
    expect((await m.tick()).action).toBe("capped");
    expect(paid.length).toBe(1);
  });
  test("a charge for another chain or sender is refused, nothing is paid; no payer configured sends nothing", async () => {
    mock.credits = 100, mock.usage = 60, mock.coinbase = "wrong-chain";
    let paid = 0;
    const a = mon(OR({ topup: topup() }), { payer: { pay: async () => (paid++, { tx_hash: "0x" }) } });
    expect((await a.m.tick()).action).toBe("error");
    expect(paid).toBe(0);
    mock.coinbase = "ok";
    const b = mon(OR({ topup: topup() }), { payer: null });
    expect((await b.m.tick()).action).toBe("error");
    expect(b.m.state.purchases[0]).toMatchObject({ status: "failed", tx_hash: null });
    mock.coinbase = "500";
    const c = mon(OR({ topup: topup() }), { payer: { pay: async () => (paid++, { tx_hash: "0x" }) } });
    expect((await c.m.tick()).action).toBe("error");
    expect(paid).toBe(0);
  });
  test("state file is mode 600 and holds no key; a wrong management key is an error, not an alert storm", async () => {
    mock.credits = 100, mock.usage = 60, mock.coinbase = "gone";
    const path = join(dir, "state-check.json");
    const m = new CreditMonitor(OR({ topup: topup() }), { statePath: path, env, log: () => {} });
    await m.tick();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(MGMT);
    const bad = new CreditMonitor(OR(), { statePath: join(dir, "bad.json"), env: { OPENROUTER_MANAGEMENT_KEY: "wrong" } });
    expect((await bad.tick()).action).toBe("error");
    expect(bad.state.last_error).toMatch(/403/);
  });
});

describe("Core price check", () => {
  test("warns when Core's prepay prices differ from the runtime's", async () => {
    const cfg = { compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5 };
    const core = (p: unknown) => (async () => Response.json({ network: { prepay: p } })) as unknown as typeof fetch;
    const logs: string[] = [];
    expect(await checkCorePrices("http://core", cfg, (m) => logs.push(m), core({ ...cfg }))).toBe(true);
    expect(await checkCorePrices("http://core", cfg, (m) => logs.push(m), core({ ...cfg, compute_price_line_per_usd: "25" }))).toBe(false);
    expect(logs.join("\n")).toMatch(/compute_price_line_per_usd 25/);
    expect(await checkCorePrices("http://core", cfg, (m) => logs.push(m), core(null))).toBe(true);
  });
});
