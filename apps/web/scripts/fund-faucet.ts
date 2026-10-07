#!/usr/bin/env bun
// One-time (idempotent) funding of the devnet tLINE faucet (wallet UI lane). Creates the faucet key
// at ~/.config/lineage/devnet/faucet.json (mode 600) and tops it up from the devnet deployer, which
// holds the TEST supply (scripts/devnet/devnet.json line_holder): SOL for fees and recipients' token
// accounts, and tLINE to transfer. Nothing is minted: the tLINE mint authority is revoked.
// Usage: bun apps/web/scripts/fund-faucet.ts [--sol 0.2] [--line 100000]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, loadKeypair, loadOrCreateKeypair, Rpc, sendAndConfirm, system, token, TOKEN_2022_PROGRAM } from "@lineage/chain";
import { assertDevnet } from "../../../packages/chain/src/browser/client.ts";
import { logWalletTx } from "./devnet-log.ts";

const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const state = JSON.parse(readFileSync(join(import.meta.dir, "../../../scripts/devnet/devnet.json"), "utf8"));
const rpc = Rpc.http(process.env.LINEAGE_DEVNET_RPC ?? state.rpc_url, "confirmed");
await assertDevnet(rpc);
const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
const { key: faucet, created } = loadOrCreateKeypair(join(homedir(), ".config", "lineage", "devnet", "faucet.json"));
console.log(`faucet ${faucet.id}${created ? " (new key)" : ""}`);
const T22 = TOKEN_2022_PROGRAM;
const ONE = 10n ** BigInt(state.line_decimals);
const wantSol = BigInt(Math.round(Number(arg("sol", "0.2")) * 1e9));
const wantLine = BigInt(arg("line", "100000")) * ONE;
const mint = state.line_mint;
const fAta = ata(faucet.id, mint, T22);

const bal = await rpc.getBalance(faucet.id);
if (bal < wantSol) {
  const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, faucet.id, wantSol - bal)]);
  logWalletTx("faucet", `fund faucet ${faucet.id} with ${Number(wantSol - bal) / 1e9} SOL from the deployer`, r.signature, r.fee);
  console.log(`SOL: ${r.signature}`);
}
const acct = await rpc.getAccountInfo(fAta);
const have = acct ? new DataView(acct.data.buffer, acct.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n;
if (have < wantLine) {
  const r = await sendAndConfirm(rpc, dep, [
    token.createAtaIdempotent(dep.id, faucet.id, mint, T22),
    token.transferChecked(state.line_holder, mint, fAta, dep.id, wantLine - have, state.line_decimals, T22),
  ]);
  logWalletTx("faucet", `send ${(wantLine - have) / ONE} tLINE from the supply holder ${state.line_holder} to the faucet's account ${fAta}`, r.signature, r.fee);
  console.log(`tLINE: ${r.signature}`);
}
console.log(`faucet holds ${Number(await rpc.getBalance(faucet.id)) / 1e9} SOL; deployer ${Number(await rpc.getBalance(dep.id)) / 1e9} SOL`);
