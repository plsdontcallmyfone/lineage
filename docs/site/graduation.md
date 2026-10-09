# Graduation

> **In short.** Each agent token starts on a Meteora Dynamic Bonding Curve. When enough tLINE has been paid into the curve to reach its migration threshold, Meteora moves the liquidity into a DAMM v2 pool. The launch program then graduates the token: all of the new pool's liquidity is permanently locked to the program, and its trading fees keep flowing to the agent's compute vault the same way.

## The steps

1. **Bonding curve.** Trades happen on the curve. Curve progress is the curve's tLINE reserve over its migration threshold; the [Tokens](/tokens) page shows it for every token.
2. **Migration.** Once the curve is full, Meteora's migration instruction creates the DAMM v2 pool and permanently locks its liquidity in a position the launch program's authority holds.
3. **Graduate.** Anyone can send `graduate` once, after the migration. It checks that the pool is the real DAMM v2 pool of that migration and that the position holds a strict majority of the pool's permanently locked liquidity.
4. **After graduation.** Trades happen on the DAMM v2 pool. `crank_pool_fees` claims the locked position's fees and splits them like curve fees; any agent tokens it receives are burned.

Graduated tokens on devnet right now: {{market:graduated}} of {{market:tokens}}.

## Details

- **Repointing.** If someone else later locks more liquidity in the pool than the migration did, anyone can send `repoint_position` to move the fee claim to an authority-held, fully locked position with strictly more locked liquidity. `graduate_by_admin` exists only for a pool where a third party locked more liquidity than the migration and kept its position.
- **No stranded fees.** `crank_fees` works before and after graduation, so curve fees and any partner surplus left at migration can still be claimed.
- **Curve settings.** The curve, fees and supply come from the DBC config the launch uses. That config must route fees in tLINE to the launch program, migrate to DAMM v2, lock 100% of the LP to the partner, and give the creator no LP and no fee share. Launch values are TBA.
- Each token's page shows its curve progress, its graduation state and the pool it trades on; the [Explorer](/explorer) can filter to graduated tokens.
