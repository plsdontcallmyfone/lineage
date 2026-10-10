import { describe, expect, test } from "bun:test";
import { marketApi } from "../src/api.ts";
import { syncCore } from "../src/core-sync.ts";
import { openDb } from "../src/db.ts";

// Token directory support (FRONTEND-EMBED.md amendment 2): Core's agents, lineages, sessions and
// provenance joined into /market/tokens, its filters and sorts, and /market/summary. Core is a fake
// serving the shapes of Core's public routes.

const A = { mint: "MintA111111111111111111111111111111111111111", agent: "AgentA11111111111111111111111111111111111111" };
const B = { mint: "MintB111111111111111111111111111111111111111", agent: "AgentB11111111111111111111111111111111111111" };
const C = { mint: "MintC111111111111111111111111111111111111111", agent: "AgentC11111111111111111111111111111111111111" };

function setup() {
  const db = openDb(":memory:");
  db.query("INSERT INTO meta (k, v) VALUES ('line_decimals', '6')").run();
  const ins = db.prepare(`INSERT INTO tokens (mint, agent, launcher, launch_account, name, symbol, decimals, repo_url, created_at, dbc_config, dbc_pool, dbc_base_vault,
    dbc_quote_vault, compute_vault, supply, spot_price, graduated, awake, to_compute) VALUES (?,?,?,?,?,?,6,?,?,'CFG','P','BV','QV','V','100000000000000',?,?,?,?)`);
  ins.run(A.mint, A.agent, "L", "LA", "Alpha agent", "ALPHA", "https://github.com/karpathy/minbpe", 100, 0.01, 0, 1, "5000000");
  ins.run(B.mint, B.agent, "L", "LB", "Beta agent", "BETA", "https://github.com/keis/base58", 200, 0.5, 1, 1, "1000000");
  ins.run(C.mint, C.agent, "L", "LC", "Gamma", "GAMMA", "https://github.com/x/y", 300, 0.02, 0, 0, "9000000");
  return db;
}

const LIN_A = "a".repeat(64);
const LIN_B = "b".repeat(64);
const core: Record<string, unknown> = {
  "/v1/agents": [{ agent_id: A.agent, mint: A.mint, target_repo: "https://github.com/karpathy/minbpe", kind: "launched" },
    { agent_id: B.agent, mint: B.mint, target_repo: "https://github.com/keis/base58", kind: "launched" },
    { agent_id: "Verifier1111111111111111111111111111111111", mint: null, target_repo: null, kind: "verifier" }],
  "/v1/lineages": [{ lineage_id: LIN_A, repo: "https://github.com/karpathy/minbpe", status: "active" }, { lineage_id: LIN_B, repo: "https://github.com/keis/base58", status: "active" }],
  [`/v1/lineages/${LIN_A}`]: { lineage_id: LIN_A, repo: "https://github.com/karpathy/minbpe", recipe: { class: "python" }, generations: [
    { entry_type: "root", author: null }, { entry_type: "patch", author: A.agent }, { entry_type: "patch", author: A.agent, reverted_by: "r" },
    { entry_type: "patch", author: A.agent }, { entry_type: "revert", author: null }] },
  [`/v1/lineages/${LIN_B}`]: { lineage_id: LIN_B, repo: "https://github.com/keis/base58", recipe: { class: "python" }, generations: [{ entry_type: "patch", author: B.agent }] },
  "/v1/sessions?limit=500": [
    { session_id: "s1", agent: A.agent, state: "live", class: "python", lineage_id: LIN_A, repo: null, proposer: "anthropic", started_at: 10, last_at: 50 },
    { session_id: "s0", agent: A.agent, state: "final", class: "python", lineage_id: LIN_A, repo: null, proposer: "anthropic", started_at: 1, last_at: 5 },
    { session_id: "s2", agent: B.agent, state: "ended", class: "python", lineage_id: LIN_B, repo: null, proposer: "scripted", started_at: 3, last_at: 4 },
    { session_id: "s3", agent: null, state: "sealed", class: "python", lineage_id: LIN_B, repo: null, proposer: "anthropic", started_at: 60, last_at: 70 },
  ],
  [`/v1/candidates?author=${A.agent}&limit=20`]: [{ candidate_id: "c1", status: "accepted" }],
  "/v1/candidates/c1/provenance": { record: { models: ["claude-opus-5-5"] } },
};
const get = async (p: string) => {
  if (!(p in core)) throw new Error(`404 ${p}`);
  return structuredClone(core[p]);
};

describe("token directory", () => {
  test("Core join: class, verified generations, latest public session, model", async () => {
    const db = setup();
    expect(await syncCore(db, get, 1000)).toBe(3);
    const api = marketApi(db, () => ({}));
    const r = (await (await api(new Request("http://x/market/tokens?sort=newest"))).json()) as any;
    const a = r.tokens.find((t: any) => t.mint === A.mint);
    expect(a).toMatchObject({ class: "python", generations: 2, model: "claude-opus-5-5", provider: "Anthropic", state: "working", fees_to_compute: 5,
      session: { id: "s1", state: "live", at: 50 } });
    const b = r.tokens.find((t: any) => t.mint === B.mint);
    expect(b).toMatchObject({ generations: 1, model: "scripted", state: "graduated", session: { id: "s2" } });
    const c = r.tokens.find((t: any) => t.mint === C.mint);
    expect(c).toMatchObject({ class: null, generations: null, model: null, state: "asleep", awake: false }); // no Core record: unknown, not zero
    expect(r.total).toBe(3);
    expect(r.facets.class).toEqual({ python: 2, unknown: 1 });
    expect(r.facets.model).toEqual({ "claude-opus-5-5": 1, scripted: 1, unknown: 1 });
  });

  test("filters, sorts, paging and summary", async () => {
    const db = setup();
    await syncCore(db, get, 1000);
    const api = marketApi(db, () => ({}));
    const list = async (q: string) => ((await (await api(new Request(`http://x/market/tokens?${q}`))).json()) as any);
    const syms = async (q: string) => (await list(q)).tokens.map((t: any) => t.symbol);
    expect(await syms("sort=market_cap")).toEqual(["BETA", "GAMMA", "ALPHA"]);
    expect(await syms("sort=fees")).toEqual(["GAMMA", "ALPHA", "BETA"]);
    expect(await syms("sort=verified")).toEqual(["ALPHA", "BETA", "GAMMA"]);
    expect(await syms("sort=awake")).toEqual(["ALPHA", "BETA", "GAMMA"]);
    expect(await syms("state=asleep")).toEqual(["GAMMA"]);
    expect(await syms("state=graduated")).toEqual(["BETA"]);
    expect(await syms("state=awake&sort=newest")).toEqual(["BETA", "ALPHA"]);
    expect(await syms("class=python&sort=newest")).toEqual(["BETA", "ALPHA"]);
    expect(await syms("model=unknown")).toEqual(["GAMMA"]);
    expect(await syms("q=alp")).toEqual(["ALPHA"]);
    expect(await syms(`q=${B.mint}`)).toEqual(["BETA"]);
    expect(await syms("q=$gamma")).toEqual(["GAMMA"]);
    const p = await list("sort=newest&limit=2&offset=2");
    expect([p.count, p.tokens.length, p.tokens[0].symbol]).toEqual([3, 1, "ALPHA"]);
    const s = (await (await api(new Request("http://x/market/summary"))).json()) as any;
    expect(s).toMatchObject({ tokens: 3, awake: 2, working: 1, graduated: 1, verified_generations: 3, fees_to_compute: 15, core_synced_at: 1000 });
  });

  test("before any Core sync the Core figures are null, never zero", async () => {
    const api = marketApi(setup(), () => ({}));
    const s = (await (await api(new Request("http://x/market/summary"))).json()) as any;
    expect([s.working, s.verified_generations, s.tokens]).toEqual([null, null, 3]);
  });

  test("hidden launches, launcher filter, agent face and what it is building", async () => {
    const db = setup();
    const core2: Record<string, unknown> = {
      ...core,
      [`/v1/lineages/${LIN_A}`]: { lineage_id: LIN_A, repo: "https://github.com/karpathy/minbpe", recipe: { class: "python" }, generations: [
        { gen_id: "g1", entry_type: "patch", author: A.agent, accepted_at: 100, effect: { metric: "train_ir", ratio: 0.9 } },
        { gen_id: "g2", entry_type: "patch", author: A.agent, accepted_at: 200, effect: { metric: "encode_ir", ratio: 0.8 } },
        { gen_id: "g3", entry_type: "patch", author: A.agent, accepted_at: 300, reverted_by: "r", effect: { metric: "encode_ir", ratio: 0.5 } }] },
      "/v1/sessions/s1": { event_list: [{ kind: "read", path: "minbpe/base.py" }, { kind: "phase", phase: "think" }, { kind: "edit", path: "minbpe/basic.py" }, { kind: "eval" }] },
      [`/v1/agents/${A.agent}/profile`]: { soul: { name: "Alpha", tagline: "counts merges" }, media: { avatar: { url: "/v1/media/abc" } } },
      [`/v1/agents/${B.agent}/profile`]: { soul: null, media: { avatar: null } },
      "/v1/hidden": { hidden: [{ mint: C.mint, agent: C.agent, reason: "ui check", added_at: 5 }], count: 1 },
    };
    await syncCore(db, async (p) => {
      if (!(p in core2)) throw new Error(`404 ${p}`);
      return structuredClone(core2[p]);
    }, 1000);
    db.query("UPDATE tokens SET launcher = 'W' WHERE mint = ?").run(C.mint);
    const api = marketApi(db, () => ({}));
    const list = async (q: string) => ((await (await api(new Request(`http://x/market/tokens?${q}`))).json()) as any);
    const l = await list("sort=newest");
    expect(l.tokens.map((t: any) => t.symbol)).toEqual(["BETA", "ALPHA"]);
    expect([l.count, l.total]).toEqual([2, 2]);
    expect((await list("q=gamma")).count).toBe(0); // search too
    expect((await list("hidden=1")).count).toBe(3);
    const mine = await list("launcher=W");
    expect(mine.tokens.map((t: any) => [t.symbol, t.hidden?.reason])).toEqual([["GAMMA", "ui check"]]);
    const detail = (await (await api(new Request(`http://x/market/tokens/${C.mint}`))).json()) as any;
    expect(detail.hidden).toMatchObject({ reason: "ui check" }); // the direct link still resolves
    const a = l.tokens.find((t: any) => t.mint === A.mint);
    expect(a).toMatchObject({ agent_name: "Alpha", tagline: "counts merges", avatar: "/v1/media/abc", hidden: null,
      building: { repo: "https://github.com/karpathy/minbpe", live: true, session_id: "s1", file: "minbpe/basic.py",
        last: { gen_id: "g2", lineage_id: LIN_A, metric: "encode_ir", ratio: 0.8, at: 200 } } });
    const b = l.tokens.find((t: any) => t.mint === B.mint);
    expect(b.building).toMatchObject({ live: false, file: null, last: null });
    const s = (await (await api(new Request("http://x/market/summary"))).json()) as any;
    expect(s).toMatchObject({ tokens: 2, hidden: 1 });
    // a Core without the list keeps the last one read
    await syncCore(db, get, 2000);
    expect((await list("")).count).toBe(2);
  });
});
