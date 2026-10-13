import { describe, expect, test } from "bun:test";
import { generateAgentKey } from "@units/protocol";
import { buildSwarm, checkSoul, defaultLead, defaultSeatNames, newSoul, nextVersion, soulDigest, swarmSeat, swarmSeats, type SoulDoc } from "../src/doc.ts";
import { persona, SEED } from "./fixtures.ts";

// The soul's swarm block (docs/plans/SWARMS.md, src/swarm.ts).

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };
const base = (): SoulDoc => newSoul({ agent: generateAgentKey().id, seed: SEED, persona: persona(), created_at: 1_790_000_000, origin: { by: "launcher", model: null, prompt_version: null } });
const swarm = (models = [OPUS, HAIKU, HAIKU], lead = 1): SoulDoc => ({ ...base(), model: models[0]!, swarm: buildSwarm(models.map((m, i) => ({ name: `Wren ${i + 1}`, model: m })), lead) });

describe("soul swarm block", () => {
  test("a soul without the block is unchanged: same fields, same digest as before the block existed", () => {
    const d = base();
    expect(checkSoul(d)).toEqual([]);
    expect(Object.keys(d)).not.toContain("swarm");
    expect(swarmSeats(d)).toBeNull();
    // the digest is over the canonical document, which has no swarm key at all
    expect(soulDigest(d)).toBe(soulDigest(JSON.parse(JSON.stringify(d))));
  });

  test("a well-formed block validates and its seats read back", () => {
    const d = swarm();
    expect(checkSoul(d)).toEqual([]);
    expect(swarmSeats(d)!.map((m) => [m.seat, m.role])).toEqual([[1, "lead"], [2, "builder"], [3, "builder"]]);
    expect(swarmSeat(d, 2)!.model).toEqual(HAIKU);
    expect(swarmSeat(d, 4)).toBeNull();
    // the next version (a memory fold) carries the block over and the digest changes only with the document
    const n = nextVersion(d, {}, 1_790_000_100);
    expect(n.swarm).toEqual(d.swarm!);
    expect(n.prev).toBe(soulDigest(d));
  });

  test("shape rules: one lead, contiguous seats, unique safe names, seat 1's model is the soul's", () => {
    const errs = (f: (d: SoulDoc) => void) => {
      const d = swarm();
      f(d);
      return checkSoul(d).join("\n");
    };
    expect(errs((d) => (d.swarm!.members[1]!.role = "lead"))).toContain("exactly one lead, has 2");
    expect(errs((d) => (d.swarm!.members[0]!.role = "builder"))).toContain("exactly one lead, has 0");
    expect(errs((d) => (d.swarm!.members[2]!.seat = 5))).toContain("seat: must be 3");
    expect(errs((d) => (d.swarm!.members[1]!.name = "wren 1"))).toContain("used by another seat");
    expect(errs((d) => (d.swarm!.members[1]!.name = "a — b"))).toContain("name");
    expect(errs((d) => (d.swarm!.members[1]!.name = "Linus Torvalds"))).toContain("names a real person");
    expect(errs((d) => (d.model = HAIKU))).toContain("must equal soul.model");
    expect(errs((d) => delete (d as { model?: unknown }).model)).toContain("names its model");
    expect(errs((d) => ((d.swarm as unknown as Record<string, unknown>).extra = 1))).toContain("unknown field");
    expect(errs((d) => (d.swarm!.members = Array.from({ length: 17 }, (_, i) => ({ seat: i + 1, name: `S ${i + 1}`, role: i ? "builder" : "lead", model: OPUS }))))).toContain("needs 1 to 16 seats");
  });

  test("the default lead is the seat with the priciest model; ties and unknown prices go to the lowest seat", () => {
    const price = (m: { id: string }) => ({ "claude-opus-5-5": 20, "claude-haiku-4-5": 5 })[m.id] ?? null;
    expect(defaultLead([HAIKU, OPUS, HAIKU], price)).toBe(2);
    expect(defaultLead([HAIKU, HAIKU], price)).toBe(1);
    expect(defaultLead([{ provider: "x", id: "unknown" }, HAIKU], price)).toBe(2);
    expect(defaultLead([{ provider: "x", id: "unknown" }], price)).toBe(1);
    expect(defaultSeatNames("Wren Halvard", 3)).toEqual(["Wren Halvard 1", "Wren Halvard 2", "Wren Halvard 3"]);
    expect(defaultSeatNames("x".repeat(60), 2).every((n) => n.length <= 40)).toBe(true);
  });
});
