import { decodeLookupTable, loadKeypair, type ChainReader } from "@units/chain";
import type { ChainSettings } from "./chain.ts";
import type { Core } from "./core.ts";
import { featureOn } from "./features.ts";
import { feeClaimsOf } from "./fee-claims.ts";
import { poolsOf } from "./pools.ts";

/**
 * Chain-mode wiring of the pools and fee-claims modules (called once from main.ts). The keeper and
 * attestor keys are separate service keys named by env, never Core's epoch authority and never an
 * agent key; without a key file the module serves reads only.
 */
export async function wirePoolsAndClaims(core: Core, reader: ChainReader, settings: ChainSettings, network: string): Promise<void> {
  const pools = featureOn(core, "agent_pools"), claims = featureOn(core, "github_fee_claims");
  if (!pools && !claims) return;
  const lc = await reader.launchConfig();
  if (!lc) {
    console.error("pools and claims: no LaunchConfig on chain; the features stay read-less");
    return;
  }
  const base = { rpc: reader.rpc, lineMint: lc.lineMint, lineTokenProgram: lc.lineTokenProgram };
  if (claims) {
    const path = process.env.UNITS_FEE_CLAIMS_ATTESTOR_KEY;
    const attestor = path ? loadKeypair(path) : null;
    feeClaimsOf(core).configure({ ...base, attestor, network });
    console.log(`fee claims: on${attestor ? `, attestor ${attestor.id}` : ", no attestor key (reads and proofs only)"}`);
  }
  if (pools) {
    const path = process.env.UNITS_POOL_KEEPER_KEY;
    const keeper = path ? loadKeypair(path) : null;
    const tableAt = (settings as unknown as { launch_lookup_table?: string }).launch_lookup_table;
    let table = null;
    if (typeof tableAt === "string") {
      const acc = await reader.rpc.getAccountInfo(tableAt).catch(() => null);
      if (acc) table = { address: tableAt, addresses: decodeLookupTable(acc.data).addresses };
    }
    poolsOf(core).configure({ ...base, keeper, table, keeperEveryS: Number(process.env.UNITS_POOL_KEEPER_EVERY_S ?? 0), log: (m) => console.log(m) });
    console.log(`agent pools: on${keeper ? `, keeper ${keeper.id}` : ", no keeper key (reads and coordination only)"}`);
    await poolsOf(core).sync().catch((e) => console.error(`agent pools: first sync failed: ${String((e as Error)?.message ?? e)}`));
  }
}
