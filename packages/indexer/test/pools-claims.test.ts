import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pumpPdas } from "@units/chain";
import { decodeTx, type RawTx, type TokenCtx } from "../src/decode.ts";

// units_launch pool and fee-route events (docs/plans/AGENT-POOLS.md, GITHUB-FEE-CLAIMS.md) in real
// devnet transactions recorded by scripts/pools/devnet-proof.ts: the routed crank's slices beside
// its FeesCranked, a join, and the keeper's cross-holding, buyback and burn purchases (CPI buys:
// the pump.fun trade inside them is indexed like any other trade of the token).

const FX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "pools-claims-devnet-txs.json"), "utf8")) as {
  agents: { name: string; agent: string; mint: string }[]; pool: { address: string; authority: string }; splits: Record<string, string>[]; line_mint: string; launch_program: string; txs: Record<string, RawTx>;
};
const [A, B] = FX.agents as [typeof FX.agents[0], typeof FX.agents[0]];
const ctx = (mint: string): TokenCtx => ({ mint, lineMint: FX.line_mint, curve: pumpPdas.bondingCurve(mint), pool: pumpPdas.pool(mint, FX.line_mint), baseDecimals: 6, quoteDecimals: 6, launchProgram: FX.launch_program });
const ev = (name: string, mint: string, kind: string) => decodeTx(FX.txs[name]!, ctx(mint)).events.filter((e) => e.kind === kind);

describe("pools and fee routes", () => {
  test("a routed crank: FeesCranked carries compute and protocol, fees_routed the GitHub and pool slices, and they add up", () => {
    const d = decodeTx(FX.txs.crank_a!, ctx(A.mint));
    const split = FX.splits.find((s) => s.agent === "A" && s.label === "first")!;
    expect(d.fees).toHaveLength(1);
    const f = d.fees[0]!;
    expect([f.feesRaw, f.toComputeRaw, f.toProtocolRaw].map(String)).toEqual([split.fees!, split.toCompute!, split.toProtocol!]);
    const [r] = d.events.filter((e) => e.kind === "fees_routed");
    expect(r!.detail).toMatchObject({ agent: A.agent, fees: split.fees, to_github: split.toGithub, to_pool: split.toPool, pool: FX.pool.address });
    expect(BigInt(r!.detail.github_id!)).toBeGreaterThan(0n);
    expect(f.toComputeRaw + f.toProtocolRaw + BigInt(r!.detail.to_github!) + BigInt(r!.detail.to_pool!)).toBe(f.feesRaw);
    // another token's context sees nothing of it
    expect(decodeTx(FX.txs.crank_a!, ctx(B.mint)).events.filter((e) => e.kind === "fees_routed")).toEqual([]);
  });
  test("join: the second member of the repository's pool", () => {
    const [j] = ev("join_b", B.mint, "pool_joined");
    expect(j!.detail).toMatchObject({ pool: FX.pool.address, agent: B.agent, index: "1", members: "2" });
    expect(j!.detail.repo_id).toMatch(/^[0-9a-f]{64}$/);
  });
  test("the keeper's purchases: kind, holder, target, amounts; the trade itself is a curve buy by the pool authority", () => {
    for (const [name, kind] of [["keeper_cross", "pool_cross_buy"], ["keeper_buyback", "pool_buyback"], ["keeper_burn", "pool_burn"]] as const) {
      const hit = [A, B].map((m) => ({ m, d: decodeTx(FX.txs[name]!, ctx(m.mint)) })).find((x) => x.d.events.some((e) => e.kind === kind))!;
      expect(hit).toBeDefined();
      const e = hit.d.events.find((x) => x.kind === kind)!;
      expect(e.detail).toMatchObject({ pool: FX.pool.address, target: hit.m.agent, venue: "curve" });
      expect(kind === "pool_cross_buy" ? e.detail.holder !== "" && e.detail.holder !== hit.m.agent : e.detail.holder === "").toBe(true);
      const [t] = hit.d.trades;
      expect([t!.venue, t!.side, t!.trader]).toEqual(["curve", "buy", FX.pool.authority]);
      expect(String(t!.baseRaw)).toBe(e.detail.tokens!);
      expect(String(t!.quoteRaw)).toBe(e.detail.quote_spent!);
    }
  });
});
