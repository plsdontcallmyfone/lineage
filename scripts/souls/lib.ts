// Shared bits of the souls lane's proof scripts: the lane spend ledger (Claude USD, cap 2 USD for
// the lane) and key files. Spend is appended to scripts/souls/RUNS.md as it happens.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "../..");
export const LEDGER = join(import.meta.dir, "spend.jsonl");
export const RUNS = join(import.meta.dir, "RUNS.md");
export const LANE_CAP_USD = 2;

export function laneSpent(): number {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).reduce((a, l) => a + Number(JSON.parse(l).usd ?? 0), 0);
}

export function recordSpend(e: { what: string; usd: number; calls: number; models: string[]; input_tokens: number; output_tokens: number; ok: boolean }) {
  appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
  if (!existsSync(RUNS)) appendFileSync(RUNS, "# Souls lane: Claude spend\n\nEvery model call this lane made, as measured from each response's usage at the published rate of the model that answered. Lane cap: 2 USD.\n\n| When (UTC) | What | Calls | Input tokens | Output tokens | USD | Result |\n|---|---|---|---|---|---|---|\n");
  appendFileSync(RUNS, `| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | ${e.what} | ${e.calls} | ${e.input_tokens} | ${e.output_tokens} | ${e.usd.toFixed(4)} | ${e.ok ? "ok" : "failed checks"} |\n`);
}
