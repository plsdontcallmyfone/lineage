// A soul with nothing to fill in (owner 2026-10-12): the seed is derived, the model chooses the
// specialty and values, and a plain soul can be built with no model at all (src/auto.ts).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { SoulDrafts } from "../../../apps/web/wallet/souls.ts";
import { autoSeed, checkSoul, DEFAULT_VALUES, generateSoul, localPersona, localSoul, personaSafety, seedValuesFrom, signSoul, validatePersona, validateSeed, verifySoul, type ModelClient } from "../src/index.ts";
import { persona } from "./fixtures.ts";

const REPO = "https://github.com/keis/base58";
const usage = { input_tokens: 3000, output_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

describe("the derived seed", () => {
  test("nothing typed: a valid seed from the agent key and the repository, the same every time", () => {
    const agent = generateAgentKey().id;
    const a = autoSeed({ agent, repo: REPO });
    expect(validateSeed(a.seed)).toEqual([]);
    expect(a.given.vibe).toBe(false);
    expect(a.seed.vibe.length).toBeGreaterThan(0);
    expect(a.seed.specialty).toBe("keis/base58: measured improvements, same behaviour");
    expect(a.seed.values).toEqual(DEFAULT_VALUES);
    expect(autoSeed({ agent, repo: REPO })).toEqual(a);
  });
  test("a typed vibe is kept as typed (whitespace collapsed, clipped to the seed's limit) and marked as the launcher's", () => {
    const a = autoSeed({ agent: generateAgentKey().id, vibe: "  dry,   exact  ", repo: null, lines: "x".repeat(5000) });
    expect(a.seed.vibe).toBe("dry, exact");
    expect(a.given.vibe).toBe(true);
    expect(validateSeed(a.seed)).toEqual([]);
    expect(validateSeed(autoSeed({ agent: "A", vibe: "v".repeat(900) }).seed)).toEqual([]);
  });
});

describe("the model draft from a derived seed", () => {
  const run = async (vibe: string | null) => {
    const prompts: string[] = [];
    const client: ModelClient = { create: async (req: any) => (prompts.push(req.messages[0].content), { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(persona()) }], usage }) };
    const agent = generateAgentKey();
    const auto = autoSeed({ agent: agent.id, vibe, repo: REPO });
    const r = await generateSoul({ seed: auto.seed, auto: auto.given, agent: agent.id, repo: REPO, client, maxUsd: 0.4 });
    return { r, prompt: prompts[0]!, agent };
  };
  test("the model is told nothing was typed and that it chooses the specialty and values; the placeholders are not given as a brief", async () => {
    const { r, prompt } = await run(null);
    expect(prompt).toContain("The launcher typed nothing");
    expect(prompt).toContain("Choose the soul's own specialty and values from the target repository");
    expect(prompt).toContain(REPO);
    expect(prompt).not.toContain("measured improvements, same behaviour");
    expect(prompt).not.toContain(DEFAULT_VALUES[0]!);
    expect(r.doc).not.toBeNull();
  });
  test("only the vibe is passed on as the launcher's, and the signed document keeps its whole shape: specialty and values are still there", async () => {
    const { r, prompt, agent } = await run("dry, exact");
    expect(prompt).toContain("only a vibe: dry, exact");
    const doc = r.doc!;
    expect(checkSoul(doc)).toEqual([]);
    expect(Object.keys(doc.seed).sort()).toEqual(["lines", "specialty", "values", "vibe"]);
    expect(doc.seed.vibe).toBe("dry, exact");
    expect(doc.seed.specialty).toBe("keis/base58: measured improvements, same behaviour");
    // the seed's values are the soul's own, so the seed reads as the soul does
    expect(doc.seed.values).toEqual(seedValuesFrom(persona()));
    expect(doc.origin.by).toBe("model");
    expect(verifySoul(agent.id, signSoul(agent, doc), doc)).toBe(true);
  });
  test("a whole typed seed still works as before (no auto note in the prompt)", async () => {
    const prompts: string[] = [];
    const client: ModelClient = { create: async (req: any) => (prompts.push(req.messages[0].content), { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(persona()) }], usage }) };
    const seed = { vibe: "calm", specialty: "tokenizers", values: ["small diffs"], lines: "" };
    const r = await generateSoul({ seed, agent: generateAgentKey().id, client, maxUsd: 0.4 });
    expect(prompts[0]).toContain("Seed from the launcher:");
    expect(r.doc!.seed).toEqual(seed);
  });
});

describe("the draft service takes the inputs alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "units-soul-auto-"));
  test("{agent, repo} with no seed drafts a soul; {agent, repo, vibe} carries the vibe; a seed is still accepted", async () => {
    const seen: string[] = [];
    const client: ModelClient = { create: async (req: any) => (seen.push(req.messages[0].content), { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(persona()) }], usage }) };
    const d = new SoulDrafts({ client, stateFile: join(dir, "a.jsonl"), perHour: 5, dailyUsd: 100 });
    const agent = generateAgentKey().id;
    const a = await d.draft({ agent, repo: REPO }, "ip");
    expect(a.status).toBe(200);
    expect(checkSoul((a.body as any).doc)).toEqual([]);
    const b = await d.draft({ agent, repo: REPO, vibe: "warm and brief" }, "ip");
    expect((b.body as any).doc.seed.vibe).toBe("warm and brief");
    expect(seen[1]).toContain("only a vibe: warm and brief");
    expect((await d.draft({ agent, repo: REPO, seed: { vibe: "calm", specialty: "x", values: ["y"], lines: "" } }, "ip")).status).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the soul built without a model (the page's fallback)", () => {
  test("valid, safe, signable, deterministic, and it says by whom: the launcher's page, no model", () => {
    for (const vibe of [null, "dry, exact, cheerful about small wins", "x".repeat(200)]) {
      const agent = generateAgentKey();
      const p = localPersona({ agent: agent.id, vibe, repo: REPO });
      expect(validatePersona(p)).toEqual([]);
      expect(personaSafety(p)).toEqual([]);
      const doc = localSoul({ agent: agent.id, vibe, repo: REPO }, 1_791_800_000);
      expect(checkSoul(doc)).toEqual([]);
      expect(doc.origin).toEqual({ by: "launcher", model: null, prompt_version: "souls/local-1" });
      expect(localSoul({ agent: agent.id, vibe, repo: REPO }, 1_791_800_000)).toEqual(doc);
      expect(verifySoul(agent.id, signSoul(agent, doc), doc)).toBe(true);
      expect(JSON.stringify(doc)).not.toContain("—");
    }
  });
  test("it names the repository and claims nothing that has happened; without a repository it still builds", () => {
    const agent = generateAgentKey().id;
    const p = localPersona({ agent, repo: REPO });
    expect(p.tagline).toContain("keis/base58");
    expect(p.backstory).toContain("no accepted change");
    expect(checkSoul(localSoul({ agent, repo: null }, 1_791_800_000))).toEqual([]);
  });
});
