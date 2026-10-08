#!/usr/bin/env bun
// Lineage site: funds the site's devnet accounts from the owner's machine. Runs LOCALLY (the
// devnet deployer key never leaves this machine). Idempotent: an account already at its minimum
// gets nothing.
//
//   bun scripts/deploy/fund-site.ts --owner <site owner pubkey> [--plan]
//
// Sends (devnet only, refused on any other genesis):
//   - SOL to the site owner up to 0.1 when under 0.05 (verifier registration and bond fees, rent);
//   - tLINE to the site owner: 3 register burns + 2 min bonds (read from the registry), less what it holds;
//   - SOL to the Core authority up to 0.3 when under 0.1 (each post_epoch costs about 0.0015 SOL: Epoch
//     account rent 0.00148844 measured 2026-10-08, plus the fee).
// Reports the faucet's balances (fund it with apps/web/scripts/fund-faucet.ts if low).
// Every transaction is appended to scripts/deploy/SITE-DEVNET.md. Keys are reported by public key only.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, ChainReader, loadKeypair, Rpc, sendAndConfirm, system, token, TOKEN_2022_PROGRAM, type Ix } from "@lineage/chain";
import { DEVNET_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";

const ROOT = join(import.meta.dir, "..", "..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const PLAN = argv.includes("--plan");
const OWNER = opt("owner");
if (!OWNER) {
  console.error("--owner <site owner pubkey> is required");
  process.exit(2);
}
const LAMPORTS = 1_000_000_000n;
const LOGMD = join(import.meta.dir, "SITE-DEVNET.md");
const devnet = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
const reader = new ChainReader(rpc);
const T22 = TOKEN_2022_PROGRAM;
const mint = devnet.line_mint as string;
const log = (m: string) => console.log(`[fund-site] ${m}`);
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(6);

const genesis = await rpc.call<string>("getGenesisHash", []);
if (genesis !== DEVNET_GENESIS) throw new Error(`RPC genesis ${genesis} is not devnet; refusing`);
const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));

function logTx(what: string, signature: string, fee?: number) {
  if (!existsSync(LOGMD))
    writeFileSync(LOGMD, "# Site devnet transactions\n\nEvery devnet transaction the site deploy kit sent (scripts/deploy/fund-site.ts locally, scripts/deploy/site-chain.ts on the server). Fee in lamports as returned by the RPC.\n\n| When (UTC) | Step | What | Fee | Signature |\n|---|---|---|---|---|\n");
  appendFileSync(LOGMD, `| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | fund | ${what} | ${fee ?? "?"} | \`${signature}\` |\n`);
}
async function send(what: string, ixs: Ix[]) {
  if (PLAN) return log(`plan: ${what}`);
  const r = await sendAndConfirm(rpc, dep, ixs, { log: (m) => log(`  ${m}`) });
  logTx(what, r.signature, r.fee);
  log(`${what}: ${r.signature}`);
}
async function topUpSol(to: string, label: string, min: bigint, target: bigint) {
  const bal = await rpc.getBalance(to);
  if (bal >= min) return log(`${label} ${to}: ${sol(bal)} SOL, ok`);
  await send(`fund ${label} ${to} with ${sol(target - bal)} SOL`, [system.transfer(dep.id, to, target - bal)]);
}

const cfg = await reader.registryConfig();
if (!cfg) throw new Error("registry config not found");
log(`deployer ${dep.id}: ${sol(await rpc.getBalance(dep.id))} SOL`);
await topUpSol(OWNER, "site owner", LAMPORTS / 20n, LAMPORTS / 10n);
await topUpSol(cfg.coreAuthority, "Core authority", LAMPORTS / 10n, (LAMPORTS * 3n) / 10n);

const wantLine = cfg.params.registerBurn * 3n + cfg.params.minBond * 2n;
const ownerAta = ata(OWNER, mint, T22);
const have = (await reader.tokenBalance(ownerAta)) ?? 0n;
// Verifiers already registered and bonded need nothing more; site-chain.ts reports the exact need.
const site = await Promise.all((opt("verifiers") ?? "").split(",").filter(Boolean).map((v) => reader.agent(v)));
const spent = site.reduce((s, r) => s + (r ? r.burned + r.bond : 0n), 0n);
const need = wantLine - spent - have;
if (need > 0n)
  await send(`send ${need} tLINE base units to site owner ${OWNER}`, [
    token.createAtaIdempotent(dep.id, OWNER, mint, T22),
    token.transferChecked(devnet.line_holder, mint, ownerAta, dep.id, need, devnet.line_decimals, T22),
  ]);
else log(`site owner tLINE: ${have} base units held, ${spent} already burned or bonded; ok`);

const faucetPath = join(homedir(), ".config", "lineage", "devnet", "faucet.json");
if (existsSync(faucetPath)) {
  const f = loadKeypair(faucetPath).id;
  const [fs, fl] = [await rpc.getBalance(f), (await reader.tokenBalance(ata(f, mint, T22))) ?? 0n];
  log(`faucet ${f}: ${sol(fs)} SOL, ${fl} tLINE base units${fs < 20_000_000n ? " (LOW: fund it with apps/web/scripts/fund-faucet.ts)" : ""}`);
}
log(PLAN ? "plan done (nothing sent)" : "done");
