// The pump.fun venue's initial buy for the launch wizard (docs/plans/LAUNCH-FRONTING.md section 6,
// option B; owner decisions 2026-10-10): after create_v2 + register_pump_launch, the launcher buys
// exactly initial_buy_bps of the supply with buy_v3 and the tokens land in the agent key's token
// account. The quote is pump.fun's arithmetic on the curve create_v2 is about to write (seeded from
// $LINE's live reserves); the launch simulation stays the authority for the cost shown.
import {
  ata,
  decodeBondingCurve,
  decodePumpFeeConfig,
  decodePumpGlobal,
  decodePumpPool,
  decodeTokenAccount,
  launchPdas,
  maxBuyInput,
  PUMP,
  pumpInitialBuy,
  pumpPdas,
  pumpQuotedCurve,
  quoteInitialBuy,
  TOKEN_2022_PROGRAM,
} from "../../../packages/chain/src/browser/index.ts";
import { rpc } from "./chain.ts";
import { setInitialBuyBuilder } from "./fronting.ts";

const T22 = TOKEN_2022_PROGRAM;

/** Registers the pump.fun initial buy with the wizard. `lineMint` is $LINE; `linePool` its pool once migrated; `creatorFeeBps` the LaunchConfig value. */
export function registerPumpInitialBuy(o: { lineMint: () => string; linePool: () => { pool: string; baseVault: string; quoteVault: string } | undefined;
  creatorFeeBps: () => bigint }) {
  const global = async () => {
    const g = await rpc.getAccountInfo(PUMP.global);
    if (!g) throw new Error("pump.fun's Global account is not on this cluster");
    return decodePumpGlobal(g.data);
  };
  setInitialBuyBuilder({
    supply: async () => (await global()).tokenTotalSupply,
    build: async ({ launcher, agent, agentMint, amountOut, slippageBps }) => {
      const line = o.lineMint(), lp = o.linePool();
      const [g, fcA, curveA, bbA, poolA, baseA, quoteA] = await rpc.getMultipleAccounts([PUMP.global, PUMP.feeConfig, pumpPdas.bondingCurve(line),
        ata(PUMP.buybackRecipients[0], line, T22), ...(lp ? [lp.pool, lp.baseVault, lp.quoteVault] : [])]);
      if (!g || !fcA || !curveA) throw new Error("pump.fun's Global, fee config or the quote coin's curve is missing on this cluster");
      const G = decodePumpGlobal(g.data);
      const pool = lp && poolA && baseA && quoteA
        ? { pool: decodePumpPool(poolA.data), baseReserve: decodeTokenAccount(baseA.data).amount, quoteReserve: decodeTokenAccount(quoteA.data).amount } : undefined;
      const fresh = pumpQuotedCurve(G, { curve: decodeBondingCurve(curveA.data), pool }, launchPdas.pumpCreator(agent), line, o.creatorFeeBps());
      const quote = quoteInitialBuy(G, decodePumpFeeConfig(fcA.data), fresh, amountOut);
      const maxIn = maxBuyInput(quote, slippageBps);
      return {
        ixs: pumpInitialBuy({ launcher, agent, agentMint, lineMint: line, amountOut, maxIn, lineTokenProgram: T22, createBuyback: !bbA }),
        amountOut,
        quote,
        maxIn,
        treasuryAccount: ata(agent, agentMint, T22),
      };
    },
  });
}
