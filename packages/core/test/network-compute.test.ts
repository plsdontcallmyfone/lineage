import { afterEach, describe, expect, test } from "bun:test";
import { agent, makeAuthor, setup, type Env } from "./helpers.ts";
import { expectOk } from "./helpers.ts";

// Plan MODELS-AND-SELF-FUNDING section D in Core: an asleep agent stays asleep (the vault decides),
// and its candidates are accepted only while the hosted runtime's last spend report says its compute
// is covered by the network, and that report is fresh.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const PRICE = { source: "config", status: "test", usd_per_token: null, line_per_usd: "1000000", why: null };
const row = (covered: unknown) => ({ vault: "0", vault_usd: 0, burn_per_h: null, burn_usd_per_h: null, burn_window_s: null, runway_h: null, model: { provider: "anthropic", id: "claude-opus-5-5" }, via: "openrouter", waiting: null, ...(covered === undefined ? {} : { covered }) });

describe("network compute in Core", () => {
  test("an asleep hosted agent commits only while the runtime reports it as covered; awake is never changed", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const body = (c: string) => ({ lineage_id: e.lineage, parent_gen_id: e.gen0, kind: "perf", target: "ir", commitment: c.repeat(64) });
    const a = await makeAuthor(e, { fees: 0n });
    expect(await agent(e, a.id)).toMatchObject({ awake: false, compute_covered: false });
    expect((await a.c.post("/v1/candidates", body("a"))).body.error).toBe("asleep");
    // a report without the field changes nothing
    await expectOk(e.admin.c.post("/v1/admin/runtime/spend", { price: PRICE, agents: { [a.id]: row(undefined) } }));
    expect((await a.c.post("/v1/candidates", body("a"))).body.error).toBe("asleep");
    // malformed: refused
    expect((await e.admin.c.post("/v1/admin/runtime/spend", { price: PRICE, agents: { [a.id]: row({ min_interval_s: -5 }) } })).status).toBe(400);
    // covered
    await expectOk(e.admin.c.post("/v1/admin/runtime/spend", { price: PRICE, agents: { [a.id]: row({ min_interval_s: 900 }) } }));
    expect(await agent(e, a.id)).toMatchObject({ awake: false, compute_covered: true, compute: "0" });
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/spend`))).spend.covered).toEqual({ min_interval_s: 900 });
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/profile`))).compute_covered).toBe(true);
    await expectOk(a.c.post("/v1/candidates", body("a")));
    // the report grows old (the runtime stopped): refused again
    e.clock.advance((e.cfg.network_compute_report_max_age_s + 1) * 1000);
    expect(await agent(e, a.id)).toMatchObject({ awake: false, compute_covered: false });
    expect((await a.c.post("/v1/candidates", body("b"))).body.error).toBe("asleep");
    // covered again, then the runtime reports it without the field (its vault pays again, or the setting went off)
    await expectOk(e.admin.c.post("/v1/admin/runtime/spend", { price: PRICE, agents: { [a.id]: row({ min_interval_s: 900 }) } }));
    expect((await agent(e, a.id)).compute_covered).toBe(true);
    await expectOk(e.admin.c.post("/v1/admin/runtime/spend", { price: PRICE, agents: { [a.id]: row(undefined) } }));
    expect((await a.c.post("/v1/candidates", body("b"))).body.error).toBe("asleep");
  });

  test("a self-hosted agent is never covered, whatever a report says", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await makeAuthor(e, { fees: 0n, hosted: false });
    await expectOk(e.admin.c.post("/v1/admin/runtime/spend", { price: PRICE, agents: { [a.id]: row({ min_interval_s: 900 }) } }));
    expect((await agent(e, a.id)).compute_covered).toBe(false);
    expect((await a.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: e.gen0, kind: "perf", target: "ir", commitment: "a".repeat(64) })).body.error).toBe("asleep");
  });

  test("the setting has a default and refuses a bad value", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    expect(e.cfg.network_compute_report_max_age_s).toBe(600);
  });
});
