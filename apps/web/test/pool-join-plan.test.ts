import { describe, expect, test } from "bun:test";
import { actionLabel, joinCost, joinFacts, joinState, joinUnits, networkFee, pct, rentFromSimulation, stateLine, type JoinCfg } from "../wallet/pool-join-plan.ts";

// The Pools page's "Join a pool" (docs/plans/AGENT-POOLS.md 11): what one agent is offered, what the
// review says before signing and what the join costs. The settings are mainnet's PoolConfig as read
// on 2026-10-13; every sentence must follow whatever the chain holds.

const CFG: JoinCfg = { paused: false, maxMembers: 8, poolFeeBps: 2000, payoutBps: 4000, buybackBps: 4000, burnBps: 2000, crossHoldQuote: 17_000_000_000n };
const base = { featureOn: true, cfg: CFG, venue: "pump", agent: "A", isMember: false, pool: null as { members: string[] } | null };
const coin = (b: bigint) => `${(Number(b) / 1e6).toLocaleString("en-US")} UNITS`;
const usd = (b: bigint) => `$${((Number(b) / 1e6) * 0.0002728).toFixed(2)}`;

describe("the state of one agent", () => {
  test("no pool for its repository: it would open it", () => {
    expect(joinState(base)).toEqual({ kind: "open" });
    expect(actionLabel(joinState(base), "Tandem", "karpathy/minbpe")).toBe("Open this repository's pool with Tandem");
    expect(stateLine(joinState(base), "karpathy/minbpe")).toBe("karpathy/minbpe has no pool yet. The first member opens it. A pool starts routing fees only when a second agent joins.");
  });

  test("a pool exists: it joins it, the members are named by the state", () => {
    const s = joinState({ ...base, pool: { members: ["B"] } });
    expect(s).toEqual({ kind: "join", members: ["B"] });
    expect(actionLabel(s, "Tandem", "karpathy/minbpe")).toBe("Join the pool of karpathy/minbpe");
    expect(stateLine(s, "karpathy/minbpe")).toBe("karpathy/minbpe has a pool with 1 agent.");
    expect(stateLine(joinState({ ...base, pool: { members: ["B", "C"] } }), "o/r")).toBe("o/r has a pool with 2 agents.");
  });

  test("already a member: no action; alone it says plainly that nothing is routed yet", () => {
    const alone = joinState({ ...base, isMember: true, pool: { members: ["A"] } });
    expect(alone).toEqual({ kind: "member", members: ["A"], routing: false });
    expect(actionLabel(alone, "Tandem", "o/r")).toBeNull();
    expect(stateLine(alone, "o/r")).toBe("In the pool of o/r, alone so far. A pool starts routing fees only when a second agent joins.");
    const two = joinState({ ...base, isMember: true, pool: { members: ["B", "A"] } });
    expect(two).toMatchObject({ kind: "member", routing: true });
    expect(stateLine(two, "o/r")).toBe("In the pool of o/r with 1 other agent. Its pool share is routed at every fee collection.");
    // a membership shows whatever the switches say, and says routing is paused
    const paused = joinState({ ...base, cfg: { ...CFG, paused: true }, isMember: true, pool: { members: ["B", "A"] } });
    expect(paused).toMatchObject({ kind: "member", routing: false });
    expect(stateLine(paused, "o/r")).toContain("Routing is paused");
    expect(joinState({ ...base, featureOn: false, isMember: true, pool: { members: ["A", "B"] } })).toMatchObject({ kind: "member", routing: false });
  });

  test("nothing is offered that the program would refuse: switched off, paused, full, another venue", () => {
    expect(joinState({ ...base, featureOn: false })).toEqual({ kind: "off" });
    expect(joinState({ ...base, cfg: null })).toEqual({ kind: "off" });
    expect(joinState({ ...base, cfg: { ...CFG, paused: true } })).toEqual({ kind: "paused" });
    expect(joinState({ ...base, venue: "meteora" })).toEqual({ kind: "other_venue" });
    const full = joinState({ ...base, cfg: { ...CFG, maxMembers: 2 }, pool: { members: ["B", "C"] } });
    expect(full).toEqual({ kind: "full", members: ["B", "C"], max: 2 });
    expect(stateLine(full, "o/r")).toBe("The pool of o/r is full: 2 of 2 agents.");
    for (const s of [joinState({ ...base, featureOn: false }), joinState({ ...base, cfg: { ...CFG, paused: true } }), joinState({ ...base, venue: "meteora" }), full]) expect(actionLabel(s, "T", "o/r")).toBeNull();
  });
});

describe("what joining does, before signing", () => {
  const facts = (o: Partial<Parameters<typeof joinFacts>[0]> = {}) => Object.fromEntries(joinFacts({ cfg: CFG, others: 1, routeBps: null, agentName: "Tandem", coin, usd, maxFeeBps: 5000, ...o }).map((f) => [f.key, f.text]));

  test("the share, the split and the cross holding carry the chain's numbers", () => {
    const f = facts();
    expect(f.share).toBe("20% of the creator fees Tandem keeps go to the pool's vault each time its fees are collected. With this agent the pool has two members, so routing starts for both.");
    expect(f.split).toContain("40% is paid to members by their verified work");
    expect(f.split).toContain("40% buys members' coins when a member's change is accepted");
    expect(f.split).toContain("20% buys members' coins and burns them");
    expect(f.cross).toContain("Tandem buys about $4.64 (17,000 UNITS) of the other member's coin, and that member buys the same amount of Tandem's coin.");
    expect(f.cross).toContain("Your wallet does not pay for this, now or later. Each agent's purchases are paid from its own pool share, first");
    expect(f.compute).toBe("The other 80% of the fees it keeps still go to its own compute.");
  });

  test("it follows other settings, never a constant", () => {
    const f = facts({ cfg: { ...CFG, poolFeeBps: 1250, payoutBps: 5000, buybackBps: 2500, burnBps: 2500, crossHoldQuote: 500_000n } });
    expect(f.share).toStartWith("12.5% of the creator fees");
    expect(f.split).toContain("50% is paid");
    expect(f.split).toContain("25% buys members' coins when");
    expect(f.cross).toContain("(0.5 UNITS)");
    expect(f.compute).toStartWith("The other 87.5%");
    expect(facts({ cfg: { ...CFG, crossHoldQuote: 0n } }).cross).toBe("Cross holding: none is set. Members do not buy each other's coins on joining.");
  });

  test("the first member is told nothing is routed until a second joins, and owes nothing yet", () => {
    const f = facts({ others: 0 });
    expect(f.share).toEndWith("A pool with one member routes nothing: this starts when a second agent joins.");
    expect(f.cross).toContain("When another agent joins, Tandem buys about $4.64 (17,000 UNITS) of its coin");
  });

  test("joining a pool of three: one purchase per member, the total stated", () => {
    const f = facts({ others: 3 });
    expect(f.share).toEndWith("The pool is already routing.");
    expect(f.cross).toContain("of each of the 3 other members' coins, about $13.91 (51,000 UNITS) in all");
  });

  test("with no dollar price the amount is given in the coin and says so", () => {
    expect(facts({ usd: () => null }).cross).toContain("buys 17,000 UNITS (no US dollar price right now) of the other member's coin");
  });

  test("an agent that also routes to its repository's owners: both shares come out of the same fees", () => {
    expect(facts({ routeBps: 2000 }).compute).toBe("Tandem already routes 20% of the fees it keeps to the owners of its repository. Both shares come out of the same fees, so 60% is left for its own compute.");
  });

  test("it says that joining cannot be undone, and that the settings can change up to the program's cap", () => {
    const f = facts();
    expect(f.undo).toBe("Joining cannot be undone. The program has no way to leave a pool, and what Tandem routed stays in the pool.");
    expect(f.settings).toContain("the program never lets the pool share go above 50%");
  });

  test("no em dash and no placeholder in any sentence", () => {
    for (const o of [{}, { others: 0 }, { others: 4 }, { routeBps: 2000 }, { usd: () => null }])
      for (const t of Object.values(facts(o))) { expect(t).not.toContain("—"); expect(t).not.toMatch(/undefined|NaN|TBA/); }
  });
});

describe("what a join costs", () => {
  // mainnet rent for 675, 170 and 195 bytes: the fork rehearsal measured 7,238,920 lamports for a first join and
  // 1,645,840 for the next, each with a 5,000 lamport fee (scripts/mainnet/LAUNCH-UPGRADE-FORK-LAST.json)
  const rent = { pool: 4_079_240n, vault: 1_513_840n, member: 1_640_840n };

  test("the first member pays for the pool, its vault and its own membership; a later one for its membership only", () => {
    const first = joinCost({ opens: true, rent, fee: 5000n });
    expect(first.lines.map((l) => l.key)).toEqual(["pool", "vault", "member", "fee"]);
    expect(first.rent).toBe(rent.pool + rent.vault + rent.member);
    expect(first.total).toBe(7_238_920n);
    const later = joinCost({ opens: false, rent, fee: 5000n });
    expect(later.lines.map((l) => l.key)).toEqual(["member", "fee"]);
    expect(later.total).toBe(1_645_840n);
  });

  test("the network fee: one signature and the priority price on the compute limit", () => {
    expect(networkFee(160_000, 0)).toBe(5000n);
    expect(networkFee(160_000, 1)).toBe(5001n);
    expect(networkFee(180_000, 50_000)).toBe(5000n + 9000n);
    // the limit leaves room over what the fork measured (77,781 first, 53,586 second) and grows with the members
    expect(joinUnits(0)).toBeGreaterThanOrEqual(Math.ceil(77_781 * 1.6));
    expect(joinUnits(1)).toBeGreaterThan(joinUnits(0));
    expect(joinUnits(7)).toBeLessThanOrEqual(400_000);
  });

  test("percentages", () => {
    expect(pct(2000)).toBe("20%");
    expect(pct(1250)).toBe("12.5%");
    expect(pct(5)).toBe("0.05%");
  });
});

describe("the rent the review states is what the simulation charged", () => {
  const at = { pool: "POOL", vault: "VAULT", member: "MEMBER" };
  const acct = (address: string, created: boolean, after: bigint | null) => ({ address, created, after });

  test("a first member: the three accounts the simulation created", () => {
    const r = rentFromSimulation([acct("WALLET", false, 10n), acct("POOL", true, 4_079_240n), acct("MEMBER", true, 1_640_840n), acct("VAULT", true, 1_513_840n)], at);
    expect(r).toEqual({ opens: true, rent: { pool: 4_079_240n, vault: 1_513_840n, member: 1_640_840n } });
    expect(joinCost({ ...r!, fee: 5000n }).total).toBe(7_238_920n);
  });

  test("a later member: the pool and its vault exist, only the membership is charged", () => {
    const r = rentFromSimulation([acct("POOL", false, 4_079_240n), acct("VAULT", false, 1_513_840n), acct("MEMBER", true, 1_640_840n)], at);
    expect(r).toEqual({ opens: false, rent: { pool: 0n, vault: 0n, member: 1_640_840n } });
    expect(joinCost({ ...r!, fee: 5000n }).lines.map((l) => l.key)).toEqual(["member", "fee"]);
  });

  test("a simulation that created no membership is not a join", () => {
    expect(rentFromSimulation([acct("POOL", false, 1n), acct("MEMBER", false, null)], at)).toBeNull();
    expect(rentFromSimulation([], at)).toBeNull();
  });
});
