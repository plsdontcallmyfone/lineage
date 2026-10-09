#!/usr/bin/env bun
// On the site server (as the lineage user): publishes the runtime's allocation escrow in Core's trading
// config, so the launch form offers the optional trading allocation. The escrow key is the one the
// trader created under the runtime's state directory (trader/escrow.json); its tLINE account is what
// the config publishes. Signed with Core's admin key; nothing secret is printed.
// Usage: bun scripts/trader/site-escrow.ts [--state /var/lib/lineage/runtime] [--admin-key ~/.config/lineage/site/admin.json]
//        [--core http://127.0.0.1:9660] [--set '{"global_trades_per_epoch":120}']
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSolanaJson } from "@lineage/protocol";
import { ata, loadKeypair, TOKEN_2022_PROGRAM } from "@lineage/chain";
import { CoreClient } from "../../packages/core/src/client.ts";

const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const STATE = arg("state", "/var/lib/lineage/runtime");
const ADMIN = arg("admin-key", join(homedir(), ".config/lineage/site/admin.json"));
const CORE = arg("core", "http://127.0.0.1:9660");
const extra = JSON.parse(arg("set", "{}")) as Record<string, unknown>;
const escrowFile = join(STATE, "trader", "escrow.json");
if (!existsSync(escrowFile)) throw new Error(`${escrowFile} does not exist: start the runtime with trading enabled first`);
const escrow = loadKeypair(escrowFile);
const chain = JSON.parse(readFileSync("scripts/devnet/devnet.json", "utf8"));
const account = ata(escrow.id, chain.line_mint, TOKEN_2022_PROGRAM);
const admin = new CoreClient(CORE, keyFromSolanaJson(JSON.parse(readFileSync(ADMIN, "utf8"))));
const r = await admin.post("/v1/admin/trading/config", { allocation_escrow: account, ...extra });
if (r.status !== 200) throw new Error(`trading config: HTTP ${r.status} ${JSON.stringify(r.body)}`);
console.log(JSON.stringify({ allocation_escrow: r.body.allocation_escrow, escrow_owner: escrow.id, enabled: r.body.enabled, set: Object.keys(extra) }));
