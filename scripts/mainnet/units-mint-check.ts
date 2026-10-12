#!/usr/bin/env bun
// Is the official $UNITS mint live? Read only: prints what mainnet says about the mint the mainnet
// profile records (config/profile.json mainnet quote.units_mint; owner 2026-10-12:
// GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump, a pre-generated pump.fun address) and whether it can be
// the quote of agent launches: it exists, it is a pump.fun coin (Token-2022, no mint or freeze
// authority) paired with SOL or USDC, never mayhem mode, and pump.fun's Global.max_curve_depth is 1
// or more. Exits 0 only when all of that holds. Sends nothing; prints no endpoint.
//
//   bun scripts/mainnet/units-mint-check.ts [--mint <address>]
//
// Reads through UNITS_MAINNET_RPC when set (environment or ~/.config/units/rpc.env), else the public endpoint.
import { ChainReader, curveMigrated, decodeBondingCurve, decodePumpGlobal, decodePumpPool, PUMP, pumpPdas, Rpc, TOKEN_2022_PROGRAM } from "@units/chain";
import { loadNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";

const argv = process.argv.slice(2);
const profile = loadNetworkProfile({ env: { ...process.env, UNITS_NETWORK: "mainnet", UNITS_PROFILE_LOCAL: undefined } });
const mint = argv.includes("--mint") ? argv[argv.indexOf("--mint") + 1]! : profile.quote.line_mint;
if (!mint) throw new Error("the mainnet profile names no $UNITS mint (quote.units_mint)");
let url = "https://api.mainnet-beta.solana.com";
try {
  url = rpcUrlFor(profile);
} catch { /* no keyed endpoint: the public one, for reads */ }
const rpc = Rpc.http(url, "confirmed");
const SOL = "11111111111111111111111111111111", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
let bad = 0;
const line = (ok: boolean | null, what: string, detail = "") => {
  if (ok === false) bad++;
  console.log(`[units-mint] ${ok === null ? "    " : ok ? "ok  " : "NO  "} ${what}${detail ? `: ${detail}` : ""}`);
};
try {
  if ((await rpc.call<string>("getGenesisHash")) !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("the endpoint is not mainnet");
  console.log(`[units-mint] ${mint} (config/profile.json mainnet quote.units_mint, status ${profile.quote.line_mint_status ?? "not set"}; the quote in use is ${profile.quote.symbol}, ${profile.quote.status})`);
  const g = decodePumpGlobal((await rpc.getAccountInfo(PUMP.global))!.data);
  line(g.maxCurveDepth >= 1, "pump.fun Global.max_curve_depth is 1 or more", `${g.maxCurveDepth}`);
  const acct = await rpc.getAccountInfo(mint);
  line(!!acct, "the mint exists on mainnet", acct ? `owner ${acct.owner}` : "no account at this address: not created yet");
  if (acct) {
    const m = await new ChainReader(rpc).mint(mint);
    line(!!m && m.tokenProgram === TOKEN_2022_PROGRAM && m.mintAuthority === null && m.freezeAuthority === null, "a Token-2022 mint with no mint authority and no freeze authority", m ? `decimals ${m.decimals}, supply ${m.supply}` : "not a mint");
    const ca = await rpc.getAccountInfo(pumpPdas.bondingCurve(mint));
    const c = ca && ca.owner === PUMP.program ? decodeBondingCurve(ca.data) : null;
    line(!!c, "it has a pump.fun bonding curve", c ? `creator ${c.creator}` : "none: not a pump.fun coin");
    if (c) {
      line(c.quoteMint === SOL || c.quoteMint === USDC, "paired with SOL or USDC", c.quoteMint === SOL ? "SOL" : c.quoteMint);
      line(c.depth === 0, "curve depth 0 (not itself quoted in a pump coin)", `${c.depth}`);
      line(!c.isMayhemMode, "not mayhem mode");
      if (curveMigrated(c)) {
        const pool = pumpPdas.pool(mint, c.quoteMint === SOL ? PUMP.wsol : c.quoteMint);
        const pa = await rpc.getAccountInfo(pool);
        line(!!pa, "migrated to PumpSwap: its canonical pool exists (launch params need line_pool and a launch table that names it)", pa ? `${pool}, base vault ${decodePumpPool(pa.data).poolBaseTokenAccount}, quote vault ${decodePumpPool(pa.data).poolQuoteTokenAccount}` : pool);
      } else if (c.complete) line(false, "the curve is complete and awaits migration: launches fail (QuoteCurveAwaitingMigration) until anyone runs migrate_v2");
      else line(null, "trading on its bonding curve", `virtual reserves ${c.virtualQuoteReserves} quote / ${c.virtualTokenReserves} base`);
    }
  }
} catch (e) {
  bad++;
  console.log(`[units-mint] could not be checked (${(e as Error).name}: ${String((e as Error).message).replace(url, "[endpoint]").slice(0, 160)})`);
}
console.log(`[units-mint] ${bad ? "NOT USABLE yet" : "USABLE as the quote of agent launches"}${bad ? "" : ": set config/profile.json mainnet quote.mint to it, quote.status and units_mint_status to live, and launch-params line_mint"}`);
process.exit(bad ? 1 : 0);
