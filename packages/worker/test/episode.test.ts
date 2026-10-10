import { describe, expect, test } from "bun:test";
import { EpisodeCapture } from "../src/episode.ts";
import type { Meter } from "../src/proposers/types.ts";

// Agent learnings (docs/plans/AGENT-LEARNINGS.md 1.1): the worker report is collected by wrapping the
// attempt's meter; every call must reach the runtime's meter unchanged.

describe("episode capture", () => {
  test("records usage, sandbox time, harness and route while forwarding every call", () => {
    const seen: string[] = [];
    const inner: Meter = {
      model: (u) => seen.push(`model ${u.model} ${u.usd}`),
      sandbox: (s) => seen.push(`sandbox ${s}`),
      harness: (h) => seen.push(`harness ${h.name}`),
      upstream: (n) => seen.push(`upstream ${n}`),
      route: (r) => seen.push(`route ${r.via}`),
    };
    const cap = new EpisodeCapture();
    const m = cap.wrap(inner);
    m.harness!({ name: "openai-compat", version: "openai-compat/1", digest: "b".repeat(64), provider: "deepseek" });
    m.route!({ via: "openrouter", model: { provider: "deepseek", id: "deepseek-v4-pro" }, requested: "deepseek-v4-pro" });
    m.model({ input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 0, usd: 0.1, model: "deepseek/deepseek-v4-pro" });
    m.model({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, usd: 0.05, model: "deepseek/deepseek-v4-pro" });
    m.upstream!("DeepSeek");
    m.sandbox(12.5);
    m.sandbox(7.5);
    cap.plan({ kind: "perf", target: "encode_ir", note: "the divmod loop — maybe" });
    cap.outcome("no candidate: the working tree had no change to submit");
    expect(seen).toEqual(["harness openai-compat", "route openrouter", "model deepseek/deepseek-v4-pro 0.1", "model deepseek/deepseek-v4-pro 0.05", "upstream DeepSeek", "sandbox 12.5", "sandbox 7.5"]);
    const r = cap.report();
    expect(r.usage).toEqual({ input_tokens: 101, output_tokens: 52, cache_read_tokens: 13, cache_write_tokens: 4, usd: 0.15 });
    expect(r.sandbox_s).toBe(20);
    expect(r.models).toEqual(["deepseek/deepseek-v4-pro"]);
    expect(r.route).toEqual({ via: "openrouter", model: { provider: "deepseek", id: "deepseek-v4-pro" }, upstream: ["DeepSeek"] });
    expect(r.harness?.provider).toBe("deepseek");
    expect(r.planned).toEqual({ kind: "perf", target: "encode_ir", note: "the divmod loop - maybe" });
    expect(r.outcome).toBe("no candidate: the working tree had no change to submit");
  });

  test("without a runtime meter nothing is forwarded and an unmetered attempt reports null usage", () => {
    const cap = new EpisodeCapture();
    cap.wrap(undefined).sandbox(3);
    expect(cap.report()).toMatchObject({ usage: null, sandbox_s: 3, planned: null, outcome: null, models: [] });
  });

  test("post never throws and logs a refusal", async () => {
    const logs: string[] = [];
    const client = { post: async () => ({ status: 409, body: { error: "too_late" } }) } as any;
    expect(await new EpisodeCapture().post(client, "a".repeat(64), (m) => logs.push(m))).toBe(false);
    const broken = { post: async () => { throw new Error("down"); } } as any;
    expect(await new EpisodeCapture().post(broken, "a".repeat(64), (m) => logs.push(m))).toBe(false);
    expect(logs).toHaveLength(2);
  });
});
