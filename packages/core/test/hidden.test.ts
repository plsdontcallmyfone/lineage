import { afterEach, describe, expect, test } from "bun:test";
import { generateAgentKey } from "../src/protocol.ts";
import { agentClient, bare, expectOk } from "./helpers.ts";

// Hidden launches (APP-CONSOLIDATION amendment 2): a public list of mints kept out of listings, each
// with a reason, edited by the admin only, without a redeploy.

let env: { close(): void } | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const mint = () => generateAgentKey().id;

describe("hidden launches", () => {
  test("public list; only the admin edits it; reasons replace; removal works", async () => {
    const e = bare();
    env = e;
    expect(await expectOk(e.anon.get("/v1/hidden"))).toEqual({ hidden: [], count: 0 });
    const [a, b] = [mint(), mint()];
    const agent = mint();
    expect((await agentClient(e).c.post("/v1/admin/hidden", { add: [{ mint: a, reason: "ui check" }] })).status).toBe(403);
    const out = await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint: a, agent, reason: "ui check" }, { mint: b, reason: "graduation test" }] }));
    expect(out.count).toBe(2);
    expect(out.added).toBe(2);
    const l = await expectOk(e.anon.get("/v1/hidden"));
    expect(l.hidden.find((h: any) => h.mint === a)).toMatchObject({ agent, reason: "ui check", added_by: e.admin.id });
    // re-adding replaces the reason and keeps the agent
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint: a, reason: "scripted author" }] }));
    expect((await expectOk(e.anon.get("/v1/hidden"))).hidden.find((h: any) => h.mint === a)).toMatchObject({ agent, reason: "scripted author" });
    const r = await expectOk(e.admin.c.post("/v1/admin/hidden", { remove: [b] }));
    expect(r).toMatchObject({ count: 1, removed: 1 });
  });

  test("a bad body changes nothing", async () => {
    const e = bare();
    env = e;
    const a = mint();
    for (const body of [{}, { add: "x" }, { add: [{ mint: "nope", reason: "x" }] }, { add: [{ mint: a, reason: "" }] }, { add: [{ mint: a, reason: "ok" }], remove: ["0OIl"] }]) {
      const res = await e.admin.c.post("/v1/admin/hidden", body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_hidden");
    }
    expect((await expectOk(e.anon.get("/v1/hidden"))).count).toBe(0);
  });
});
