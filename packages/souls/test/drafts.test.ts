import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { SoulDrafts } from "../../../apps/web/wallet/souls.ts";
import type { ModelClient } from "../src/index.ts";
import { persona, SEED } from "./fixtures.ts";

// The Wallet page's soul draft service (apps/web/wallet/souls.ts): caps and rate limits, fake model.
const dir = mkdtempSync(join(tmpdir(), "lineage-soul-drafts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const client: ModelClient = { create: async () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(persona()) }], usage: { input_tokens: 3000, output_tokens: 5000 } }) };

describe("soul draft service", () => {
  test("drafts for a valid agent key, then holds the per-address and daily caps", async () => {
    const d = new SoulDrafts({ client, stateFile: join(dir, "a.jsonl"), perHour: 2, dailyUsd: 0.6, perSoulUsd: 0.4 });
    const agent = generateAgentKey().id;
    const ok = await d.draft({ seed: SEED, agent }, "1.2.3.4");
    expect(ok.status).toBe(200);
    expect((ok.body as any).doc.agent).toBe(agent);
    expect((await d.draft({ seed: SEED, agent: "nope" }, "1.2.3.4")).status).toBe(400);
    expect((await d.draft({ seed: SEED, agent }, "1.2.3.4")).status).toBe(200);
    expect(((await d.draft({ seed: SEED, agent }, "1.2.3.4")).body as any).error).toBe("rate");
    // 0.112 USD per draft: two spent (0.224), and 0.224 + the 0.4 per-soul reserve crosses 0.6
    expect(d.spentToday()).toBeCloseTo(0.224, 6);
    expect(((await d.draft({ seed: SEED, agent }, "5.6.7.8")).body as any).error).toBe("daily_cap");
  });
  test("disabled without a model key", async () => {
    const d = new SoulDrafts({ client: null, stateFile: join(dir, "b.jsonl") });
    expect((await d.draft({ seed: SEED, agent: generateAgentKey().id }, "x")).status).toBe(503);
    expect((await d.info()).enabled).toBe(false);
  });
});
