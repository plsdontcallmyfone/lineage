import { describe, expect, test } from "bun:test";
import { generateAgentKey } from "@units/protocol";
import { soul } from "../../souls/test/fixtures.ts";
import { ModelRouteError } from "../../souls/src/routed-client.ts";
import { AgentPoster, emptyPostState, POSTS_DEFAULTS } from "../src/posts.ts";

// A post that fails is not tried again on the next tick (5 s on the site): the agent waits, twice
// as long after every failure in a row up to a cap, and a provider without credit is left alone for
// as long as its mark lasts. On the mainnet runtime a refused post was repeated every 5 seconds.

function setup(create: () => Promise<any>, cfg: Partial<typeof POSTS_DEFAULTS> = {}) {
  const key = generateAgentKey();
  const doc = soul(key.id);
  const clock = { t: Date.UTC(2026, 9, 12, 12) };
  const logs: string[] = [];
  let calls = 0;
  const sent: string[] = [];
  const state = emptyPostState();
  state.seen[key.id] = clock.t - 3_600_000;
  const gen = { id: "g".repeat(64), at: clock.t - 60_000, lineage_id: "l".repeat(64), recipe_name: "base58-py", generation: { height: 3, kind: "perf", target: "encode_ir", effect: { ratio: 0.9, metric: "encode_ir" }, gain_pct: 10, fixed: 0, reverted: false } };
  const poster = new AgentPoster({
    core: "http://core",
    client: { create: async () => (calls++, create()) },
    cfg: { ...POSTS_DEFAULTS, ...cfg },
    state: () => state,
    save: () => {},
    now: () => clock.t,
    log: (m) => logs.push(m),
    room: () => 1,
    meter: () => {},
    send: async (_a, _to, text) => (sent.push(text), "m".repeat(64)),
    keyOf: () => key,
    fetch: async (u) => {
      if (u.endsWith("/soul")) return Response.json({ doc });
      if (u.includes("/v1/feed")) return Response.json({ items: [gen] });
      if (u.endsWith("/media")) return Response.json({});
      return new Response("{}", { status: 404 });
    },
  });
  return { poster, agent: key.id, clock, logs, calls: () => calls, sent };
}

describe("post backoff", () => {
  test("a failing post waits 60 s, then twice as long each time, at most the cap; ticks in between make no call and no log line", async () => {
    const s = setup(async () => Promise.reject(new Error("503 upstream")), { retry_base_s: 60, retry_max_s: 300 });
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = s.calls();
      await s.poster.tick([s.agent]);
      expect(s.calls()).toBe(before + 1);
      const until = s.poster.retryAt(s.agent)!;
      waits.push((until - s.clock.t) / 1000);
      // every 5 s tick inside the wait: nothing happens
      const lines = s.logs.length;
      for (let t = 0; t < 3; t++) {
        s.clock.t += 5_000;
        await s.poster.tick([s.agent]);
      }
      expect(s.calls()).toBe(before + 1);
      expect(s.logs.length).toBe(lines);
      s.clock.t = until;
    }
    expect(waits).toEqual([60, 120, 240, 300, 300, 300]);
    expect(s.logs.filter((l) => /post skipped: 503 upstream; next try in/.test(l))).toHaveLength(6);
    expect(s.logs[0]).toMatch(/next try in 60 s \(failure 1 in a row\)/);
  });

  test("a provider without credit: the agent waits at least as long as the provider's mark; a post that works clears the count", async () => {
    let mode: "credit" | "ok" = "credit";
    const s = setup(async () => {
      if (mode === "credit") throw new ModelRouteError("openrouter has no credit", "openrouter", true, 900_000);
      return { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Generation 3 landed. Link: /generations/" + "g".repeat(64) }], usage: { input_tokens: 900, output_tokens: 60, usd: 0.003 } };
    });
    await s.poster.tick([s.agent]);
    expect(s.poster.retryAt(s.agent)! - s.clock.t).toBe(900_000);
    s.clock.t += 600_000;
    await s.poster.tick([s.agent]);
    expect(s.calls()).toBe(1);
    s.clock.t += 300_000;
    mode = "ok";
    await s.poster.tick([s.agent]);
    expect(s.calls()).toBe(2);
    expect(s.sent).toHaveLength(1);
    expect(s.poster.retryAt(s.agent)).toBeNull();
  });
});
