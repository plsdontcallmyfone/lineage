#!/usr/bin/env bun
// Devnet only: tops up hosted agents' compute vaults with test $UNITS from the devnet faucet key
// (worthless devnet test tokens; 20 test $UNITS are 1 USD of compute at the TEST rate), then
// refresh_awake for each. A plain token transfer into the vault PDA, as scripts/deploy/site-authors.ts
// does for the scripted authors; the hosted runtime reads the vault's balance from chain.
//
//   bun scripts/devnet/vault-topup.ts --amount 400 <agent>:<agent mint> [...]   (add --send to send)
//
// Without --send it only prints each vault's balance. Keys are passed explicitly: the faucet key holds
// the tokens, the devnet deployer pays the fees. Never changes the solana CLI config. Prints one
// SITE-DEVNET.md row per transaction.
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, launch, launchPdas, loadKeypair, sendAndConfirm, token, TOKEN_2022_PROGRAM, type Ix } from "@units/chain";
import { deployer, KEY_DIR, loadState, reader, rpc } from "./lib.ts";

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");
const amountArg = argv.includes("--amount") ? argv[argv.indexOf("--amount") + 1] : undefined;
const pairs = argv.filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
const state = loadState();
// devnet only: the state file says so and the RPC answers with devnet's genesis hash
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
if (state.mode !== "devnet" || (await rpc.call<string>("getGenesisHash")) !== DEVNET_GENESIS) throw new Error("devnet only");
if (!state.line_mint) throw new Error("no line_mint in scripts/devnet/devnet.json");
const DEC = Number(state.line_decimals ?? 6);
const units = (n: bigint) => (Number(n) / 10 ** DEC).toFixed(DEC);
if (!pairs.length || (SEND && !(Number(amountArg) > 0 && Number(amountArg) <= 2000))) {
  console.error("usage: bun scripts/devnet/vault-topup.ts --amount <test $UNITS, at most 2000> <agent>:<agent mint> [...] [--send]");
  process.exit(2);
}
const amount = BigInt(Math.round(Number(amountArg ?? 0) * 10 ** DEC));
const faucet = loadKeypair(join(KEY_DIR, "faucet.json"));
const payer = deployer();
const mint: string = state.line_mint;
const from = ata(faucet.id, mint, TOKEN_2022_PROGRAM);
console.log(`faucet ${faucet.id} holds ${units((await reader.tokenBalance(from)) ?? 0n)} test $UNITS; fee payer ${payer.id} (${(Number(await rpc.getBalance(payer.id)) / 1e9).toFixed(4)} SOL); keys from ${join(homedir(), ".config", "lineage")} (not printed)`);
const row = (what: string, r: { fee?: number | bigint | null; signature: string }) =>
  console.log(`| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | vault top-up | ${what} | ${r.fee ?? "?"} | \`${r.signature}\` |`);
for (const p of pairs) {
  const [agent, agentMint] = p.split(":") as [string, string];
  const vault = launchPdas.computeVault(agent);
  const before = (await reader.tokenBalance(vault)) ?? 0n;
  console.log(`${agent}: compute vault ${vault} holds ${units(before)} test $UNITS`);
  if (!SEND) continue;
  const ixs: Ix[] = [token.transferChecked(from, mint, vault, faucet.id, amount, DEC, TOKEN_2022_PROGRAM)];
  const sent = await sendAndConfirm(rpc, payer, ixs, { signers: [faucet] });
  row(`send ${units(amount)} test $UNITS from the faucet to the compute vault ${vault} of hosted agent ${agent}`, sent);
  const woke = await sendAndConfirm(rpc, payer, [launch.refreshAwake({ agent, agentMint })]);
  row(`refresh_awake for hosted agent ${agent}`, woke);
  console.log(`${agent}: compute vault now holds ${units((await reader.tokenBalance(vault)) ?? 0n)} test $UNITS`);
}
