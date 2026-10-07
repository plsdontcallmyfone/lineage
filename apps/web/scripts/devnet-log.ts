// Appends wallet UI lane devnet transactions to onchain/DEVNET.md under this lane's own heading.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOG = join(import.meta.dir, "..", "..", "..", "onchain", "DEVNET.md");
const HEAD = "## Transactions (wallet UI lane)";

export function logWalletTx(step: string, what: string, signature: string, fee?: number | string) {
  if (!readFileSync(LOG, "utf8").includes(HEAD))
    appendFileSync(
      LOG,
      `\n${HEAD}\n\nDevnet transactions sent by the Wallet page (apps/web/wallet) and its tooling: the faucet funding, the faucet's drips, and the headless browser check (apps/web/scripts/wallet-e2e.ts) driving the page with a mock Wallet Standard wallet that signs with a local devnet test key. Fee in lamports as returned by the RPC.\n\n| When (UTC) | Step | What | Fee | Signature |\n|---|---|---|---|---|\n`,
    );
  const when = new Date().toISOString().replace("T", " ").slice(0, 19);
  appendFileSync(LOG, `| ${when} | ${step} | ${what.replace(/\|/g, "/")} | ${fee ?? "?"} | \`${signature}\` |\n`);
}
