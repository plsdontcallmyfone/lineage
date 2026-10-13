import { describe, expect, test } from "bun:test";
import type { AgentKey } from "@units/protocol";
import type { CoreClient } from "../../core/src/client.ts";
import { MORE_UNITS_DEFAULTS, MoreUnits, moreUnitsError, type DryUnit, type MoreHost, type MoreUnitsConfig, type RepoMore } from "../src/more-units.ts";
import type { DraftJob, DraftResult } from "../src/unit-setup.ts";

// More units per repository (more-units.ts, docs/plans/AGENT-EFFICIENCY.md 8.2): when every unit of a
// repository has run dry one agent drafts another, within the limits, and every refusal has a reason.

const REPO = "https://github.com/acme/thing";
const A = "AgentAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const B = "AgentBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";
const DAY = 86_400_000;
const T0 = 100 * DAY;
const unit = (n: number, dry: boolean, age_days = 30): DryUnit => ({ lineage_id: `${n}`.repeat(64), recipe_name: n === 1 ? "thing" : `thing-${n}`, repo: REPO, created_at: T0 - age_days * DAY, dry, fresh: false, line: dry ? "Most recent attempts found nothing more to improve here: 9 of the last 12 ended without an improvement." : null });

type Budget = { usd: number } | { usd: null; why: string; vault?: boolean };

function world(o: { units: DryUnit[]; agents?: { agent: string; status?: string; target_repo?: string; setting_up?: boolean }[]; draft?: (j: DraftJob) => Promise<DraftResult>; budget?: (agent: string, cap: number) => Budget; covered?: boolean; network?: Budget; cfg?: MoreUnitsConfig; dry404?: boolean; off?: boolean }) {
  const agents = o.agents ?? [{ agent: A }, { agent: B }];
  const w = {
    now: T0,
    units: o.units,
    proposals: [] as { proposal_id: string; repo: string; status: string; reason: string | null }[],
    store: {} as Record<string, RepoMore>,
    drafts: [] as DraftJob[],
    runs: [] as { agent: string; maxUsd: number; network: boolean }[],
    jobs: [] as Promise<void>[],
    running: new Set<string>(),
    metered: [] as { agent: string; usd: number }[],
    logs: [] as string[],
    reads: 0,
  };
  const core = {
    get: async (path: string) => {
      if (path === "/v1/units/dry") return (w.reads++, o.dry404 ? { status: 404, body: { error: "not_found" } } : { status: 200, body: { settings: {}, units: w.units } });
      if (path.startsWith("/v1/recipe-proposals")) return { status: 200, body: w.proposals };
      return { status: 404, body: null };
    },
  } as unknown as CoreClient;
  const host: MoreHost = {
    core,
    log: (m) => w.logs.push(m),
    now: () => w.now,
    save: () => {},
    store: () => w.store,
    agents: () => agents.map((a) => ({ agent: a.agent, status: a.status ?? "bound", target_repo: a.target_repo ?? REPO })),
    keyOf: () => ({ id: "k" }) as unknown as AgentKey,
    awake: () => true,
    busy: (a) => w.running.has(a),
    freeSlot: () => true,
    settingUp: (a) => agents.find((x) => x.agent === a)?.setting_up === true,
    budget: (agent, cap) => o.budget?.(agent, cap) ?? { usd: cap },
    covered: () => o.covered === true,
    networkBudget: (_a, cap) => o.network ?? { usd: Math.min(cap, 1) },
    run: (agent, maxUsd, job, network) => {
      w.running.add(agent);
      w.runs.push({ agent, maxUsd, network });
      w.jobs.push(job({ model: (u) => w.metered.push({ agent, usd: u.usd }), sandbox: () => {} }).finally(() => w.running.delete(agent)));
    },
  };
  const more = new MoreUnits(o.off ? o.cfg : { enabled: true, ...(o.cfg ?? {}) }, host, {
    read: async () => {
      throw new Error("an additional unit never reads the repository's head");
    },
    draft: async (j) => {
      w.drafts.push(j);
      j.meter.model({ model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.4 });
      return o.draft ? o.draft(j) : { kind: "proposed", proposal_id: "p1", name: "thing-2" };
    },
  });
  const tick = async (advance_ms = 301_000) => {
    w.now += advance_ms;
    await more.tick();
    await Bun.sleep(0);
    await Promise.all(w.jobs);
  };
  const state = () => more.status()[REPO];
  return { w, more, tick, state };
}

describe("more units", () => {
  test("a unit that still has gains: nothing is drafted", async () => {
    const { w, tick, state } = world({ units: [unit(1, true), unit(2, false, 20)] });
    await tick();
    expect(w.drafts).toHaveLength(0);
    expect(state()).toMatchObject({ state: "not_dry" });
    expect(state()!.why).toBe("1 of 2 units of acme/thing still has gains to find (thing-2)");
    expect(w.logs).toHaveLength(0);
  });

  test("every unit dry: the lowest agent that can pay drafts once, metered to it, told which units exist; then the verifiers, then the unit", async () => {
    const { w, tick, state } = world({ units: [unit(1, true)] });
    await tick();
    expect(w.drafts).toHaveLength(1);
    expect(w.drafts[0]).toMatchObject({ repo: REPO, agent: A, capUsd: 1.5, more: { units: ["1".repeat(64)] } });
    expect(w.runs).toEqual([{ agent: A, maxUsd: 1.5, network: false }]);
    expect(w.metered).toEqual([{ agent: A, usd: 0.4 }]);
    expect(w.store[REPO]).toMatchObject({ drafts: 1, usd: 0.4, proposal_id: "p1" });
    expect(w.logs.some((l) => l.includes("is drafting an additional unit for acme/thing (draft 1 of 2, cap 1.5000 USD): every one of its 1 unit has run dry"))).toBe(true);
    // the proposal is with the verifiers: no second draft
    w.proposals = [{ proposal_id: "p1", repo: REPO, status: "calibrating", reason: null }];
    await tick();
    await tick();
    expect(w.drafts).toHaveLength(1);
    expect(state()).toMatchObject({ state: "calibrating" });
    // accepted: the set is closed; the new unit is fresh, so nothing more is drafted
    w.proposals = [{ proposal_id: "p1", repo: REPO, status: "accepted", reason: null }];
    w.units = [unit(1, true), { ...unit(2, false, 0), fresh: true }];
    await tick();
    expect(w.store[REPO]).toMatchObject({ drafts: 0, usd: 0, proposal_id: null, created: 1 });
    await tick();
    expect(w.drafts).toHaveLength(1);
    expect(state()).toMatchObject({ state: "not_dry" });
  });

  test("refusal: the repository is at its limit", async () => {
    const { w, tick, state } = world({ units: [unit(1, true), unit(2, true, 20), unit(3, true, 10)] });
    await tick();
    expect(w.drafts).toHaveLength(0);
    expect(state()).toMatchObject({ state: "limit" });
    expect(state()!.why).toBe("every unit of acme/thing has run dry, and it has 3 units, the most a repository may have (more_units.max_per_repo 3); no additional unit is drafted");
    // said once, not on every tick
    await tick();
    expect(w.logs.filter((l) => l.includes("the most a repository may have"))).toHaveLength(1);
  });

  test("refusal: cool-down between additional units; the first unit is not made to wait", async () => {
    const { w, tick, state } = world({ units: [unit(1, true), unit(2, true, 2)] });
    await tick();
    expect(w.drafts).toHaveLength(0);
    expect(state()).toMatchObject({ state: "cooldown" });
    expect(state()!.why).toContain("its newest unit is 2.0 days old; another is drafted 7 days after it (more_units.cooldown_days)");
    await tick(5 * DAY);
    expect(w.drafts).toHaveLength(1);
    // a first unit that ran dry on its second day
    const first = world({ units: [unit(1, true, 1)] });
    await first.tick();
    expect(first.w.drafts).toHaveLength(1);
  });

  test("refusal: no agent can pay; the vault being empty never spends network compute unless the setting says so", async () => {
    const broke = (): Budget => ({ usd: null, why: "compute vault exhausted (0 base units unowed)", vault: true });
    const off = world({ units: [unit(1, true)], budget: broke, covered: true });
    await off.tick();
    expect(off.w.drafts).toHaveLength(0);
    expect(off.state()).toMatchObject({ state: "no_payer" });
    expect(off.state()!.why).toBe("every unit of acme/thing has run dry, but no agent of it can pay for the draft of an additional unit now (compute vault exhausted (0 base units unowed)); a draft is not paid from network compute (more_units.on_network_compute is off)");
    // the setting on, and the network covering the agent: the draft runs on network compute, under its cap
    const on = world({ units: [unit(1, true)], budget: broke, covered: true, network: { usd: 0.8 }, cfg: { on_network_compute: true } });
    await on.tick();
    expect(on.w.runs).toEqual([{ agent: A, maxUsd: 0.8, network: true }]);
    // the setting on but the agent not covered (platform funding off): still no draft
    const uncovered = world({ units: [unit(1, true)], budget: broke, covered: false, cfg: { on_network_compute: true } });
    await uncovered.tick();
    expect(uncovered.w.drafts).toHaveLength(0);
    // a refusal that is not the vault (the global cap) is not turned into network spend either
    const capped = world({ units: [unit(1, true)], budget: () => ({ usd: null, why: "global runtime cap reached", vault: false }), covered: true, cfg: { on_network_compute: true } });
    await capped.tick();
    expect(capped.w.drafts).toHaveLength(0);
    // one agent broke, the other can pay: the other drafts
    const second = world({ units: [unit(1, true)], budget: (a, cap) => (a === A ? broke() : { usd: cap }) });
    await second.tick();
    expect(second.w.runs).toEqual([{ agent: B, maxUsd: 1.5, network: false }]);
  });

  test("a draft that does not pass is retried after a backoff, bounded by drafts and USD; a used-up set waits out the cool-down", async () => {
    const { w, tick, state } = world({ units: [unit(1, true)], draft: async () => ({ kind: "failed", reason: "headroom not shown" }) });
    await tick();
    expect(w.store[REPO]).toMatchObject({ drafts: 1, usd: 0.4 });
    expect(w.store[REPO]!.last_reason).toBe("draft 1 of 2 of an additional unit did not pass: headroom not shown");
    await tick(); // inside the 30 minute backoff
    expect(w.drafts).toHaveLength(1);
    expect(state()).toMatchObject({ state: "waiting" });
    await tick(1_800_000);
    expect(w.drafts).toHaveLength(2);
    expect(w.drafts[1]!.capUsd).toBe(1.5);
    await tick(4 * 3_600_000);
    expect(w.drafts).toHaveLength(2);
    expect(state()).toMatchObject({ state: "used_up" });
    expect(state()!.why).toContain("are used up (2 drafts, 0.80 USD: draft 2 of 2 of an additional unit did not pass: headroom not shown)");
    await tick(6 * DAY);
    expect(w.drafts).toHaveLength(2);
    await tick(2 * DAY); // the cool-down has passed: a new set
    expect(w.drafts).toHaveLength(3);
  });

  test("the verifiers reject the proposal (no headroom): counted as a failed draft with their reason", async () => {
    const { w, tick } = world({ units: [unit(1, true)] });
    await tick();
    w.proposals = [{ proposal_id: "p1", repo: REPO, status: "rejected", reason: "an additional unit must show headroom: metric x_ir: 30.0% of it is not the library's own work" }];
    await tick();
    expect(w.store[REPO]!.last_reason).toContain("the verifiers' calibrations of draft 1 did not pass (an additional unit must show headroom");
    expect(w.store[REPO]!.rejected).toEqual(["p1"]);
    expect(w.drafts).toHaveLength(1);
  });

  test("the drafter finds nothing more to measure: the set is closed for the cool-down", async () => {
    const { w, tick, state } = world({ units: [unit(1, true)], draft: async () => ({ kind: "impossible", reason: "one small module, already covered" }) });
    await tick();
    await tick();
    expect(w.drafts).toHaveLength(1);
    expect(state()).toMatchObject({ state: "used_up" });
    expect(state()!.why).toContain("the drafter found nothing more to measure: one small module, already covered");
  });

  test("the budget caps: a draft never gets more than what is left of repo_max_usd", async () => {
    const { w, tick } = world({ units: [unit(1, true)], cfg: { repo_max_usd: 0.9, draft_max_usd: 0.6, max_drafts: 5, retry_s: 1 }, draft: async () => ({ kind: "failed", reason: "x" }) });
    await tick();
    await tick();
    await tick();
    await tick();
    expect(w.drafts.map((d) => Number(d.capUsd.toFixed(2)))).toEqual([0.6, 0.5, 0.1]);
  });

  test("agents still setting up or not bound are left to unit setup; a Core without the signal drafts nothing and says so once; off reads nothing", async () => {
    const su = world({ units: [unit(1, true)], agents: [{ agent: A, setting_up: true }, { agent: B, status: "awaiting_owner" }] });
    await su.tick();
    expect(su.w.drafts).toHaveLength(0);
    const old = world({ units: [unit(1, true)], dry404: true });
    await old.tick();
    await old.tick();
    expect(old.w.drafts).toHaveLength(0);
    expect(old.w.logs.filter((l) => l.includes("does not serve the dry signal"))).toHaveLength(1);
    // off is the default: with no setting at all nothing is read and nothing is drafted
    for (const cfg of [undefined, { enabled: false }, { max_per_repo: 5 }]) {
      const off = world({ units: [unit(1, true)], cfg, off: true });
      await off.tick();
      expect(off.w.reads).toBe(0);
      expect(off.w.drafts).toHaveLength(0);
    }
  });

  test("defaults are the conservative ones, and the config check", () => {
    expect(MORE_UNITS_DEFAULTS).toMatchObject({ enabled: false, max_per_repo: 3, max_drafts: 2, draft_max_usd: 1.5, repo_max_usd: 3, cooldown_days: 7, on_network_compute: false });
    expect(moreUnitsError(undefined)).toBeNull();
    expect(moreUnitsError({ max_per_repo: 5, cooldown_days: 1, on_network_compute: true })).toBeNull();
    expect(moreUnitsError({ max_per_repo: 0 })).toContain("max_per_repo");
    expect(moreUnitsError({ cooldown_days: -1 })).toContain("cooldown_days");
    expect(moreUnitsError({ on_network_compute: "yes" })).toContain("on_network_compute");
    expect(moreUnitsError({ nope: 1 })).toContain("not a setting");
  });

  test("no sentence carries an em dash", async () => {
    const { w, tick, state } = world({ units: [unit(1, true), unit(2, true, 2)] });
    await tick();
    for (const s of [state()!.why, ...w.logs]) expect(s).not.toContain(String.fromCharCode(0x2014));
  });
});
