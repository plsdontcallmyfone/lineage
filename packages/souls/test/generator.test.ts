import { describe, expect, test } from "bun:test";
import { generateAgentKey } from "@lineage/protocol";
import { checkSoul, generateSoul, type ModelClient } from "../src/index.ts";
import { persona, SEED } from "./fixtures.ts";

function fake(responses: unknown[], usage = { input_tokens: 3000, output_tokens: 5000 }) {
  const calls: Record<string, any>[] = [];
  const client: ModelClient = {
    async create(p) {
      calls.push(p);
      const r = responses.shift();
      return { model: "claude-opus-5-5", stop_reason: (r as any)?.stop ?? "end_turn", content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }], usage };
    },
  };
  return { client, calls };
}

describe("generator", () => {
  test("one call, structured output, priced at the published rate", async () => {
    const { client, calls } = fake([persona()]);
    const agent = generateAgentKey().id;
    const r = await generateSoul({ seed: SEED, agent, client, maxUsd: 0.4, now: () => 1_790_000_000_000 });
    expect(r.problems).toEqual([]);
    expect(checkSoul(r.doc)).toEqual([]);
    expect(r.doc!.agent).toBe(agent);
    expect(r.doc!.origin).toEqual({ by: "model", model: "claude-opus-5-5", prompt_version: "souls/1" });
    expect(r.usage.usd).toBeCloseTo((3000 * 4 + 5000 * 20) / 1e6, 9);
    expect(calls[0]!.output_config.format.type).toBe("json_schema");
    expect(calls[0]!.thinking).toEqual({ type: "adaptive" });
    expect(calls[0]!.fallbacks).toBe("default");
    // the worst case of the call fits the cap: max_tokens at the output rate stays below it
    expect((calls[0]!.max_tokens * 20) / 1e6).toBeLessThanOrEqual(0.4);
  });

  test("an unsafe or invalid persona gets one repair with the problems listed", async () => {
    const { client, calls } = fake([persona({ tagline: "Here to pump the token price." }), persona()]);
    const r = await generateSoul({ seed: SEED, agent: generateAgentKey().id, client, maxUsd: 0.6 });
    expect(r.doc).not.toBeNull();
    expect(calls.length).toBe(2);
    expect(calls[1]!.messages.at(-1).content).toContain("prices");
  });

  test("the cap stops before a call that could cross it", async () => {
    const { client, calls } = fake([persona({ name: "" }), persona()]);
    const r = await generateSoul({ seed: SEED, agent: generateAgentKey().id, client, maxUsd: 0.2 });
    expect(calls.length).toBe(1);
    expect(r.doc).toBeNull();
    expect(r.problems.at(-1)).toContain("spend cap");
  });

  test("a refusal ends without a soul", async () => {
    const { client } = fake([{ stop: "refusal" }]);
    const r = await generateSoul({ seed: SEED, agent: generateAgentKey().id, client, maxUsd: 0.4 });
    expect(r.doc).toBeNull();
    expect(r.problems[0]).toContain("declined");
  });

  test("variety draws differ by salt and the seed is validated", async () => {
    const a = fake([persona()]);
    const b = fake([persona()]);
    await generateSoul({ seed: SEED, agent: generateAgentKey().id, client: a.client, maxUsd: 0.4, salt: "one" });
    await generateSoul({ seed: SEED, agent: generateAgentKey().id, client: b.client, maxUsd: 0.4, salt: "two-other" });
    expect(a.calls[0]!.messages[0].content).not.toBe(b.calls[0]!.messages[0].content);
    const bad = await generateSoul({ seed: { ...SEED, values: [] }, agent: generateAgentKey().id, client: a.client, maxUsd: 0.4 });
    expect(bad.problems[0]).toContain("seed.values");
  });
});
