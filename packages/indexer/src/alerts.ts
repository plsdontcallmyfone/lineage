// pump.fun watch (docs/plans/PUMPFUN-LAUNCHES.md 6.6): pump.fun's admins can reassign a coin's creator
// (admin_cto, set_creator, admin_cto_pool), change fee schedules (Terms 14.1) and set
// Global.max_curve_depth to 0, which stops new coins quoted in $LINE. Each refresh compares chain state
// with what our records expect and with a baseline recorded the first time the indexer saw pump.fun.

export interface PumpBaseline {
  maxCurveDepth: number;
  /** sha256 of the Pump Fees fee_config account data for Pump and for PumpSwap. */
  feeConfigSha: string;
  ammFeeConfigSha: string;
  recordedAt: number;
}
export interface PumpAlert {
  kind: "curve_creator" | "pool_creator" | "max_curve_depth" | "fee_config" | "amm_fee_config";
  subject: string;
  detail: string;
}
export interface PumpWatch {
  tokens: { mint: string; expectedCreator: string; curveCreator: string | null; poolCoinCreator: string | null }[];
  maxCurveDepth: number | null;
  feeConfigSha: string | null;
  ammFeeConfigSha: string | null;
}

/** Every difference from what we expect; empty when all is as recorded. */
export function pumpAlerts(w: PumpWatch, baseline: PumpBaseline | null): PumpAlert[] {
  const out: PumpAlert[] = [];
  for (const t of w.tokens) {
    if (t.curveCreator !== null && t.curveCreator !== t.expectedCreator)
      out.push({ kind: "curve_creator", subject: t.mint, detail: `bonding curve creator is ${t.curveCreator}, not the agent's creator PDA ${t.expectedCreator}` });
    if (t.poolCoinCreator !== null && t.poolCoinCreator !== t.expectedCreator)
      out.push({ kind: "pool_creator", subject: t.mint, detail: `PumpSwap pool coin_creator is ${t.poolCoinCreator}, not the agent's creator PDA ${t.expectedCreator}` });
  }
  if (w.maxCurveDepth !== null && w.maxCurveDepth < 1)
    out.push({ kind: "max_curve_depth", subject: "pump_global", detail: `max_curve_depth is ${w.maxCurveDepth}: new coins quoted in $LINE are refused` });
  else if (baseline && w.maxCurveDepth !== null && w.maxCurveDepth !== baseline.maxCurveDepth)
    out.push({ kind: "max_curve_depth", subject: "pump_global", detail: `max_curve_depth changed from ${baseline.maxCurveDepth} to ${w.maxCurveDepth}` });
  if (baseline && w.feeConfigSha !== null && w.feeConfigSha !== baseline.feeConfigSha)
    out.push({ kind: "fee_config", subject: "pump_fee_config", detail: "Pump's fee config changed since the baseline" });
  if (baseline && w.ammFeeConfigSha !== null && w.ammFeeConfigSha !== baseline.ammFeeConfigSha)
    out.push({ kind: "amm_fee_config", subject: "pump_amm_fee_config", detail: "PumpSwap's fee config changed since the baseline" });
  return out;
}
