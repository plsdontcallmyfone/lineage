#!/usr/bin/env bun
// The $UNITS fee keeper: collects the $UNITS coin's own pump.fun creator fees to the creator wallet,
// sends the compute share to the compute funding address and spends the burn share on $UNITS, which
// it burns (owner decision 2026-10-12: 50% compute, 50% buyback and burn). docs/MAINNET-RUNBOOK.md
// "UNITS fee keeper".
//
//   bun packages/fee-keeper/src/main.ts --config <file> [--send] [--json]
//
// Without --send it is a dry run: it reads the chain, simulates each transaction and prints the plan;
// nothing is signed, sent or written. On mainnet --send also needs "enabled": true in the config.
// Exit status: 0 done (or nothing to do), 2 refused (before anything, or a transaction refused right
// before signing: nothing of it was signed), 3 a transaction is still unconfirmed (the next run
// settles it), 1 any other error (a config without protected_units is one).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKeypair, Rpc, type Signer } from "@units/chain";
import { RpcChain } from "./chain.ts";
import { loadConfig, publicConfig } from "./config.ts";
import { runKeeper } from "./keeper.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes(n);

/** The $UNITS mint the repository names for mainnet (config/profile.json), or null when it cannot be read. */
function mainnetUnitsMint(): string | null {
  try {
    const p = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/profile.json"), "utf8"));
    const q = p?.profiles?.mainnet?.quote;
    const m = q?.units_mint ?? q?.line_mint;
    return typeof m === "string" ? m : null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const file = flag("--config");
  if (!file || has("--help")) {
    console.error("usage: bun packages/fee-keeper/src/main.ts --config <file> [--send] [--json]");
    return file ? 0 : 1;
  }
  const cfg = loadConfig(file);
  const send = has("--send");
  let signer: Signer | null = null;
  if (cfg.key_path && existsSync(cfg.key_path)) signer = loadKeypair(cfg.key_path);
  else if (send) throw new Error(cfg.key_path ? `config.key_path ${cfg.key_path} does not exist` : "config.key_path is null: dry runs only");
  const chain = new RpcChain(Rpc.http(cfg.rpc_url!, "confirmed"), cfg, signer);
  const say = (m: string) => { if (!has("--json")) console.log(`[fee-keeper] ${m}`); };
  say(`${send ? "SEND" : "dry run (nothing is sent; pass --send to send)"}`);
  if (!has("--json")) console.log(`[fee-keeper] config ${JSON.stringify(publicConfig(cfg))}`);
  const report = await runKeeper(cfg, chain, { send, signer: signer?.id ?? null, mainnetUnitsMint: mainnetUnitsMint(), log: say });
  if (has("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    say(`cluster ${report.cluster}, coin on the ${report.phase}; creator fees waiting: ${JSON.stringify(report.waiting_lamports)}`);
    for (const r of report.refused) say(`REFUSED: ${r}`);
    for (const s of report.steps) {
      say(`${s.step}: ${s.result}: ${s.detail}${s.signature ? ` (${s.signature})` : ""}`);
      if (s.amounts) say(`  amounts ${JSON.stringify(s.amounts)}`);
      if (s.simulation) say(`  simulation ${JSON.stringify(s.simulation)}`);
    }
    if (report.owed) say(`owed after this run: ${JSON.stringify(report.owed)}`);
    if (report.record) say(`logged ${report.record.run_id}`);
  }
  if (report.refused.length) return 2;
  return report.steps.some((s) => s.result === "waiting") ? 3 : 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(`[fee-keeper] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
