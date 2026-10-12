import { afterEach, describe, expect, test } from "bun:test";
import { generateAgentKey } from "../src/protocol.ts";
import { agentClient, bare, expectOk } from "./helpers.ts";

// Plan MODELS-AND-SELF-FUNDING in Core: OpenRouter-routed models become pickable once the runtime
// reports the OpenRouter key (with the route and its listed price), and the runtime's spend summary
// (vault, burn, runway, provider balance) is served per agent exactly as reported.

let env: { close(): void } | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe("models through OpenRouter", () => {
  test("with Anthropic and OpenRouter keys: every model via OpenRouter with OpenRouter's price, Claude included (owner 2026-10-12), Meta's Llama 4 Maverick too", async () => {
    const e = bare();
    env = e;
    await expectOk(e.admin.c.post("/v1/admin/models/availability", { providers: { anthropic: true, openrouter: true } }));
    const v = await expectOk(e.anon.get("/v1/models"));
    const one = (p: string, id: string) => v.models.find((m: any) => m.provider === p && m.id === id);
    expect(one("anthropic", "claude-opus-5-5")).toMatchObject({ pickable: true, via: "openrouter", route: { id: "anthropic/claude-opus-5.5", rate: { input: 4, output: 20, cached_input: 0.2, cache_write: 5 }, funding_fee_bps: 550 } });
    const gpt = one("openai", "gpt-5.5");
    expect(gpt).toMatchObject({ pickable: true, via: "openrouter", route: { id: "openai/gpt-5.5", funding_fee_bps: 550 } });
    expect(one("meta", "llama-4-maverick")).toMatchObject({ pickable: true, via: "openrouter" });
    // every model in the registry is pickable (Meta's unpriced placeholder was removed 2026-10-12)
    expect(v.models.filter((m: any) => !m.pickable).map((m: any) => `${m.provider}/${m.id}`)).toEqual([]);
  });
});

describe("runtime spend summary", () => {
  test("only the runtime (or admin) reports; GET /v1/agents/:id/spend serves it; the balance-low note only for a routed agent", async () => {
    const e = bare();
    env = e;
    const a = generateAgentKey().id, b = generateAgentKey().id;
    const row = (via: string) => ({ vault: "12000000", vault_usd: 12, burn_per_h: "500000", burn_usd_per_h: 0.5, burn_window_s: 14400, runway_h: 24, model: { provider: "openai", id: "gpt-5.5" }, via, waiting: via === "openrouter" ? "provider balance low (OpenRouter has 0.30 USD, 0.0200 free of running reserves)" : null });
    const body = { at: 1, price: { source: "config", status: "test", usd_per_token: null, line_per_usd: "1000000", why: null }, provider_balance: { openrouter: { usd: 0.3, source: "key_limit", read_at: 1, low: true } }, agents: { [a]: row("openrouter"), [b]: row("direct") } };
    expect((await agentClient(e).c.post("/v1/admin/runtime/spend", body)).status).toBe(403);
    expect((await e.admin.c.post("/v1/admin/runtime/spend", { agents: { [a]: { ...row("x") } } })).status).toBe(400);
    await expectOk(e.admin.c.post("/v1/admin/runtime/spend", body));
    const ra = await expectOk(e.anon.get(`/v1/agents/${a}/spend`));
    expect(ra.spend).toMatchObject({ runway_h: 24, via: "openrouter", vault_usd: 12 });
    expect(ra.provider_balance_low).toBe(true);
    expect(ra.price).toMatchObject({ status: "test" });
    expect((await expectOk(e.anon.get(`/v1/agents/${b}/spend`))).provider_balance_low).toBe(false);
    const none = await expectOk(e.anon.get(`/v1/agents/${generateAgentKey().id}/spend`));
    expect(none.spend).toBeNull();
  });
  test("an agent's own desktop (runtime desktop_mode per_agent) is served as reported: state, why, since; a malformed one reads null; absent stays absent", async () => {
    const e = bare();
    env = e;
    const a = generateAgentKey().id, b = generateAgentKey().id, c = generateAgentKey().id;
    const row = { vault: "1", vault_usd: 1, burn_per_h: null, burn_usd_per_h: null, burn_window_s: null, runway_h: null, model: null, via: null, waiting: null };
    await expectOk(
      e.admin.c.post("/v1/admin/runtime/spend", {
        price: { source: "config", status: "test", usd_per_token: null, line_per_usd: "1000000", why: null },
        agents: { [a]: { ...row, desktop: { state: "paused", why: "agent idle", since: 1791824956000, sandbox_id: "never served" } }, [b]: { ...row, desktop: { state: "exploded" } }, [c]: row },
      }),
    );
    expect((await expectOk(e.anon.get(`/v1/agents/${a}/spend`))).spend.desktop).toEqual({ state: "paused", why: "agent idle", since: 1791824956000 });
    expect((await expectOk(e.anon.get(`/v1/agents/${b}/spend`))).spend.desktop).toBeNull();
    expect("desktop" in (await expectOk(e.anon.get(`/v1/agents/${c}/spend`))).spend).toBe(false);
    // the stream id of a running desktop (64 hex, the desktop route's own shape) and the runtime's mask setting
    const sid = "ab".repeat(32);
    await expectOk(
      e.admin.c.post("/v1/admin/runtime/spend", {
        price: { source: "config", status: "test", usd_per_token: null, line_per_usd: "1000000", why: null },
        desktops: { required: true, masked: false, local: null, hosts: null, e2b: { running: 1, max: 50, spent_today_usd: 0, cap_usd: 200 } },
        agents: { [a]: { ...row, desktop: { state: "running", why: null, since: 5, stream: sid } }, [b]: { ...row, desktop: { state: "running", why: null, since: 5, stream: "../../etc/passwd" } } },
      }),
    );
    const ra = await expectOk(e.anon.get(`/v1/agents/${a}/spend`));
    expect(ra.spend.desktop).toEqual({ state: "running", why: null, since: 5, stream: sid });
    expect(ra.desktop_masked).toBe(false);
    expect((await expectOk(e.anon.get(`/v1/agents/${b}/spend`))).spend.desktop.stream).toBeNull();
  });
});
