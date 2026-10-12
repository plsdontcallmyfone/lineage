// The trading limits the first trading tests were written against (plan T's TEST table, 2026-10-09),
// with the risk layer of 2026-10-12 switched off. Those tests check the mechanics of each older rule
// at these values; the conservative defaults and the risk layer have their own tests
// (packages/core/test/risk.test.ts, packages/trader/test/risk.test.ts). Tests only.
export const LEGACY_LIMITS = {
  max_position_bps: 1000, max_trade_bps: 300, max_open_positions: 8, daily_loss_bps: 500, max_drawdown_bps: 2000, stop_loss_bps: 1500, take_profit_bps: 4000,
  max_slippage_bps: 200, max_impact_bps: 100, cooldown_s: 600, min_hold_s: 1800,
  temperaments: { aggressive: { size_bps: 300 }, balanced: { size_bps: 200 }, careful: { size_bps: 100 } }, default_temperament: "aggressive",
  eligibility_min_generations: 0, eligibility_min_age_s: 0, max_deployed_bps: 10_000, max_trades_per_day: 100_000, network_max_exposure_bps: 10_000,
  herd_window_s: 0, wash_window_s: 0, network_drawdown_bps: 0, breaker_failures: 1000,
} as const;
