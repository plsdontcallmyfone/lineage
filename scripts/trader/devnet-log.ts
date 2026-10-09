// Appends devnet transactions of the agent trading lane (plan T) to onchain/DEVNET.md, in this lane's
// own section (created on first use; rows inserted at the end of the section's table even when other
// lanes appended sections after it).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEVNET_MD = join(import.meta.dir, "..", "..", "onchain", "DEVNET.md");
const HEAD = "## Agent trading (plan T, agent trading lane)";

export function logTx(what: string, sig: string, fee?: number | string) {
  let md = readFileSync(DEVNET_MD, "utf8");
  if (!md.includes(HEAD)) {
    appendFileSync(DEVNET_MD, `\n${HEAD}\n\nDevnet transactions of the agent trading lane: smoke checks of the trade venue and the treasury funding paths (scripts/trader/devnet-smoke.ts, local TEST keys funded by the Lineage deployer, passed explicitly), binding TEST agents to the site runtime (scripts/trader/bind.ts) and their funding (scripts/trader/fund.ts). Trades the site runtime places are published by Core at GET /v1/trades with their signatures, not listed here. No program change. Fee in lamports as returned by the RPC.\n\n| When (UTC) | What | Fee | Signature |\n|---|---|---|---|\n`);
    md = readFileSync(DEVNET_MD, "utf8");
  }
  const row = `| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | ${what.replace(/\|/g, "/")} | ${fee ?? "?"} | \`${sig}\` |\n`;
  const start = md.indexOf(HEAD);
  const next = md.indexOf("\n## ", start + HEAD.length);
  const end = next < 0 ? md.length : next + 1;
  const sec = md.slice(start, end);
  const lastRow = sec.lastIndexOf("\n|");
  const lineEnd = sec.indexOf("\n", lastRow + 1);
  const at = start + (lineEnd < 0 ? sec.length : lineEnd + 1);
  writeFileSync(DEVNET_MD, md.slice(0, at) + row + md.slice(at));
}
