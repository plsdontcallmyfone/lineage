import { afterEach, describe, expect, test } from "bun:test";

// the wallet bundle keeps its session on window; a bare object is enough here (as in identity-step.test.ts)
(globalThis as any).window ??= globalThis;
(globalThis as any).addEventListener ??= () => {};
(globalThis as any).dispatchEvent ??= () => true;
const { M } = await import("../wallet/models.ts");
const { depositBase, depositUsd, minUsd, P, SEATS } = await import("../wallet/prepay.ts");
const { leadSeat, onSwarmInput, SW, swarmBlock, swarmFields, swarmProblem, swarmReview, withSwarm } = await import("../wallet/swarm-step.ts");

// The launch form's swarm fields (apps/web/wallet/swarm-step.ts; docs/plans/SWARMS.md 6): nothing while
// Core's swarms flag is off, and with it on a roster in the signed soul and Core's credits minimum
// once per agent.

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };
const entry = (c: { provider: string; id: string }, output: number) => ({ ...c, name: c.id, status: "verified", rate: { input: 1, output } });
const doc = () => ({ persona: { name: "Wren Halvard" }, model: HAIKU }) as { persona: { name: string }; model?: typeof HAIKU; swarm?: unknown };
const input = (name: string, value: string) => ({ name, value }) as unknown as HTMLInputElement;

function setup(on: boolean) {
  P.cfg = { min_usd: "10", default_usd: "10", line_per_usd: "20" } as never;
  M.view = { registry: { models: [entry(OPUS, 20), entry(HAIKU, 5)], providers: [], default: HAIKU } as never, availability: { providers: {}, reported_at: null }, models: [{ ...OPUS, pickable: true, why: null }, { ...HAIKU, pickable: true, why: null }] } as never;
  M.pick = "anthropic/claude-haiku-4-5";
  SW.cfg = on ? { settings: { max_members: 4, seat_desktop_usd_per_h: 0.1656, seat_desktop_free_seats: 1 }, min_usd_per_seat: "10", max_now: 4, capacity: { seats_free: null } } : null;
  SW.size = 1;
  SW.rows = [];
  SW.lead = null;
  SW.name1 = "";
  SEATS.n = 1;
}
afterEach(() => setup(false));

describe("launch form, swarms off", () => {
  test("no field, no block in the soul, the credits minimum is Core's own", () => {
    setup(false);
    expect(swarmFields("Wren").s).toBe("");
    expect(onSwarmInput(input("l_sw_size", "3"), null)).toBe(false);
    const d = doc();
    expect(withSwarm(d as never)).toEqual(d as never);
    expect(Object.keys(withSwarm(d as never))).not.toContain("swarm");
    expect(swarmReview("Wren")).toBeNull();
    expect(swarmProblem("Wren")).toBeNull();
    expect(minUsd()).toBe("10");
    expect(depositUsd("")).toBe("10");
    expect(depositBase("10", 6)).toBe(200_000_000n);
    expect(() => depositBase("9", 6)).toThrow("at least $10.00.");
  });
});

describe("launch form, swarms on", () => {
  test("one agent is today's launch; three agents put a roster in the soul and ask Core's minimum three times", () => {
    setup(true);
    expect(swarmBlock("Wren")).toBeNull();
    expect(minUsd()).toBe("10");
    expect(onSwarmInput(input("l_sw_size", "3"), null)).toBe(true);
    expect(minUsd()).toBe("30");
    const d = withSwarm(doc() as never) as { swarm?: { members: { seat: number; name: string; role: string; model: { id: string } }[] } };
    expect(d.swarm!.members.map((m) => [m.seat, m.name, m.role, m.model.id])).toEqual([[1, "Wren Halvard 1", "lead", HAIKU.id], [2, "Wren Halvard 2", "builder", HAIKU.id], [3, "Wren Halvard 3", "builder", HAIKU.id]]);
    expect(() => depositBase("29.99", 6)).toThrow("at least $30.00 ($10.00 for each of the 3 agents)");
    expect(depositBase("30", 6)).toBe(600_000_000n);
    // a pricier model on agent 2 makes it the default lead; picking a lead by hand wins
    onSwarmInput(input("l_sw_model_2", "anthropic/claude-opus-5-5"), null);
    expect(leadSeat()).toBe(2);
    onSwarmInput(input("l_sw_role_3", "lead"), null);
    expect(leadSeat()).toBe(3);
    expect(swarmBlock("Wren")!.members.filter((m) => m.role === "lead").map((m) => m.seat)).toEqual([3]);
    // names: typed ones are kept, a duplicate is refused in words
    onSwarmInput(input("l_sw_name_2", "Wren 1"), null);
    expect(swarmProblem("Wren")).toContain("same name");
    onSwarmInput(input("l_sw_name_2", "Tern"), null);
    expect(swarmProblem("Wren")).toBeNull();
    expect(swarmReview("Wren")!.s).toContain("3 agents");
    expect(swarmReview("Wren")!.s).toContain("$30.00 in all");
    expect(swarmFields("Wren").s).toContain("$0.1656 an hour each");
    // back to one agent: no block, Core's own minimum
    onSwarmInput(input("l_sw_size", "1"), null);
    expect(Object.keys(withSwarm(doc() as never))).not.toContain("swarm");
    expect(minUsd()).toBe("10");
  });

  test("the minimum is exact for a decimal setting", () => {
    setup(true);
    P.cfg = { min_usd: "12.50", default_usd: "12.50", line_per_usd: "20" } as never;
    SEATS.n = 3;
    expect(minUsd()).toBe("37.5");
    SEATS.n = 4;
    expect(minUsd()).toBe("50");
  });
});
