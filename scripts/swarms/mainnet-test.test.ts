import { describe, expect, test } from "bun:test";
import { streamIdOf } from "../../packages/desktop/src/agent-desktops.ts";
import { slotKey } from "../../packages/runtime/src/swarm.ts";
import { blockers, estimateSwarmSol, seatStream, type Preflight } from "./mainnet-test.ts";

// scripts/swarms/mainnet-test.ts: when the test swarm may be sent, and the SOL it is said to need.

const cfg = (over: Partial<NonNullable<Preflight["cfg"]>> = {}): NonNullable<Preflight["cfg"]> => ({ max_members: 2, max_now: 2, open: true, restricted: true, seats_free: 44, min_usd_per_seat: 10, seat_desktop_usd_per_h: 0.1656, seat_desktop_free_seats: 1, ...over });
const pre = (over: Partial<Preflight> = {}): Preflight => ({ seats: 2, site_official: true, flag: true, cfg: cfg(), units: ["minbpe", "minbpe-heavy"], balance_sol: 0.42, ...over });

describe("the mainnet test swarm's preflight", () => {
  test("nothing stands in the way when swarms are on, open to the wallet, large enough, with screens and a unit", () => {
    expect(blockers(pre())).toEqual([]);
  });

  test("each reason is named: the flag, the wallet list, the size, the screens, the unit, the site", () => {
    expect(blockers(pre({ flag: false, cfg: null }))).toEqual(["swarms are switched off on the site (Core features.swarms)"]);
    expect(blockers(pre({ cfg: cfg({ open: false, max_now: 1 }) }))).toEqual(["swarms are not open to this launcher wallet (Core swarm.launchers)"]);
    expect(blockers(pre({ seats: 3 }))).toEqual(["the largest swarm is 2 (swarm.max_members), below 3"]);
    expect(blockers(pre({ cfg: cfg({ max_now: 1, seats_free: 1 }) }))).toEqual(["only 1 screen(s) are free now, so the form offers at most 1 agent(s)"]);
    expect(blockers(pre({ units: [] }))).toEqual(["the repository has no active unit on the site"]);
    expect(blockers(pre({ site_official: false }))[0]).toBe("the site is not the official mainnet deployment");
  });

  test("the estimate is the one-agent figure plus the further agents' credits with the slippage bound", () => {
    const e = estimateSwarmSol({ solo_must_hold_sol: 0.2, credits_usd_per_seat: 10, seats: 2, sol_usd: 100, slippage_bps: 100 });
    expect(e.extra_credits_sol).toBeCloseTo(0.1, 12);
    expect(e.need_sol).toBeCloseTo(0.301, 12);
    expect(estimateSwarmSol({ solo_must_hold_sol: 0.2, credits_usd_per_seat: 10, seats: 4, sol_usd: 100, slippage_bps: 0 }).need_sol).toBeCloseTo(0.5, 12);
  });

  test("a seat's stream id is the desktop service's own", () => {
    const agent = "HHxDgMPdYJ5SCXNdsvtaQnng3PAPXrPtZGY2xYc4eDtX";
    for (const seat of [1, 2, 3]) expect(seatStream(agent, seat)).toBe(streamIdOf(slotKey(agent, seat)));
    expect(seatStream(agent, 1)).not.toBe(seatStream(agent, 2));
  });
});
