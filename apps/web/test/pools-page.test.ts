import { describe, expect, test } from "bun:test";
import { poolCard, poolMore, type PoolRow } from "../src/pages/pools.ts";

// The Pools page for a visitor (docs/plans/AGENT-POOLS.md 11.2): a pool's card names the two ways in
// with its repository filled in, and folds out what Core keeps about it, with honest empty states.

const A = "HHxDgMPdYJ5SCXNdsvtaQnng3PAPXrPtZGY2xYc4eDtX", B = "CuvvtxbrrWhsqM1uj6ahUvEPTJrb78zfrUr4NVqGUpAo";
const member = (agent: string, index: number) => ({ agent, mint: agent, index, joined_at: 1, contributed: "0", cross_due: "0", cross_funded: "0", payout_due: "0", buyback_due: "0", burn_due: "0", paid: "0",
  bought_quote: "0", tokens_held: "0", tokens_burned: "0" });
const POOL: PoolRow = { repo_id: "ab".repeat(32), repo_url: "https://github.com/karpathy/minbpe", address: "9".repeat(44), vault_balance: "0", active: true, created_at: 1, buckets: { payout: "0", buyback: "0", burn: "0" },
  last_epoch: null, gens: 0, milestones: 0, totals: { contributed: "0", paid: "0", bought: "0", burn_spent: "0" }, members: [member(A, 0), member(B, 1)] };

describe("a pool's card", () => {
  test("links to the wizard with the repository filled in, and to joining with the wallet of an agent already launched", () => {
    const h = poolCard(POOL, new Map()).s;
    expect(h).toContain('href="/launch?repo=karpathy%2Fminbpe" data-pool-launch>Launch an agent on karpathy/minbpe to join this pool</a>');
    expect(h).toContain('href="/pools?repo=karpathy%2Fminbpe#join" data-pool-join-link>Already launched one on it? Join with its wallet</a>');
    expect(h).toContain(`data-pool-more="${POOL.repo_id}"`);
    expect(h).not.toContain("—");
  });

  test("a pool whose repository Core does not know offers no prefilled launch link", () => {
    const h = poolCard({ ...POOL, repo_url: null }, new Map()).s;
    expect(h).not.toContain("data-pool-launch");
    expect(h).toContain('href="#join" data-pool-join-link');
  });
});

describe("settlements and purchases of one pool", () => {
  test("nothing yet: both sections say so, with no figure", () => {
    const h = poolMore([], [], new Map()).s;
    expect(h).toContain("No settlement yet.");
    expect(h).toContain("Nothing yet: no payout, purchase or burn has been sent for this pool.");
    expect(h.replace(/<[^>]+>/g, "")).not.toMatch(/\d/);
  });

  test("a settlement names its epoch, its generations and who earned which share; keeper actions link their transactions", () => {
    const h = poolMore([{ epoch: 7, signature: "S1", created_at: 5, record: { gens: 2, milestones: [{}], members: [{ agent: A, weight_bps: 7500 }, { agent: B, weight_bps: 2500 }] } }],
      [{ kind: "pay", detail: { agent: A, amount: "5" }, signature: "S2", error: null, at: 1_790_000_000_000 }, { kind: "cross_buy", detail: { holder: A, target: B }, signature: "S3", error: null, at: 1_790_000_000_000 },
        { kind: "buyback", detail: { target: B }, signature: null, error: "simulation failed", at: 1_790_000_000_000 }], new Map()).s;
    expect(h).toContain('href="/epochs/7"');
    expect(h).toContain("2 verified generations, 1 milestone");
    expect(h).toContain("HHxD…eDtX 75%, Cuvv…UpAo 25%");
    expect(h).toContain("Payout to a member&#39;s compute: HHxD…eDtX");
    expect(h).toContain("Cross holding purchase: Cuvv…UpAo, held by HHxD…eDtX");
    expect(h).toContain("/tx/S2");
    expect(h).toContain("1 attempt did not land and will be tried again.");
    expect(h).not.toContain("simulation failed");
  });
});
