#!/usr/bin/env bun
// units site, second instance: sends back what the keys that live only on the server still hold, so
// the instance can be removed without leaving funds behind (docs/DEPLOY-SITE.md "Second instance
// (mainnet test)"). The site owner key: its whole quote-token balance to the recipient's token account
// (created if missing, paid by the owner key), its emptied token account closed (the rent comes back to
// it), then all its SOL. The three verifier keys: all their SOL. Each key pays its own fee and is left
// with 0 lamports. Bonds stay in the registry: they cannot be withdrawn before the unbond cooldown, and
// not at all once the programs are closed. Runs on the server as the instance's main account. Only
// public keys, amounts and signatures are printed; the endpoint is never printed.
//
//   bun scripts/deploy/site-sweep.ts --plan                 read only: what each key holds and what would move
//   bun scripts/deploy/site-sweep.ts --check                read only: exit 1 while any key holds more than dust
//   bun scripts/deploy/site-sweep.ts --to <recipient>       send
// --state <file> and --log <file> replace the instance's chain state file and transaction log (tests).
//
// Dust: a key holding no more than one base fee (5,000 lamports) cannot pay to move it.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, ChainReader, loadKeypair, Rpc, sendAndConfirm, system, token, TOKEN_2022_PROGRAM, type Ix, type Signer } from "@units/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { applyNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { instanceLayout } from "./instance.ts";

export const BASE_FEE = 5_000n;
/** What a key can send away: everything above the one fee it pays itself; 0 when it holds no more than that. */
export const sweepable = (lamports: bigint) => (lamports > BASE_FEE ? lamports - BASE_FEE : 0n);
/** SPL Token / Token-2022 CloseAccount: an empty token account's lamports go to `dest`. */
export function closeTokenAccount(account: string, dest: string, owner: string, tokenProgram: string): Ix {
  return { programId: tokenProgram, keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data: Uint8Array.of(9) };
}

if (import.meta.main) {
  const ROOT = join(import.meta.dir, "..", "..");
  const argv = process.argv.slice(2);
  const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
  const PLAN = argv.includes("--plan"), CHECK = argv.includes("--check");
  const to = opt("to");
  if (!PLAN && !CHECK && !to) {
    console.error("usage: site-sweep.ts --plan | --check | --to <recipient address>");
    process.exit(2);
  }
  if (to && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) throw new Error("--to must be a base58 address");
  const L = instanceLayout(process.env.UNITS_INSTANCE);
  const SITE = join(homedir(), ".config", "lineage", "site");
  const log = (m: string) => console.log(`[site-sweep] ${m}`);
  const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(9)} SOL`;
  try {
    const stateFile = opt("state") ?? L.stateFile;
    const state = JSON.parse(readFileSync(stateFile.startsWith("/") ? stateFile : join(ROOT, stateFile), "utf8"));
    const profile = L.network === "mainnet" ? applyNetworkProfile() : null;
    const rpc = Rpc.http(profile ? rpcUrlFor(profile) : devnetRpcUrl(), "confirmed");
    const reader = new ChainReader(rpc);
    const mint = state.line_mint as string, tp = (state.line_token_program as string) ?? TOKEN_2022_PROGRAM, decimals = Number(state.line_decimals ?? 6);
    const keys: { name: string; key: Signer }[] = ["owner", "verifier-ref", "verifier-v1", "verifier-v2"].filter((n) => existsSync(join(SITE, `${n}.json`))).map((n) => ({ name: n, key: loadKeypair(join(SITE, `${n}.json`)) }));
    if (!keys.length) log("no site keys on this server");
    const send = async (what: string, payer: Signer, ixs: Ix[], o: { priorityMicroLamports?: number } = {}) => {
      const r = await sendAndConfirm(rpc, payer, ixs, o);
      appendFileSync(opt("log") ?? `${L.state}/site/tx-log.jsonl`, JSON.stringify({ at: new Date().toISOString(), step: "site-sweep", what, fee: r.fee ?? null, signature: r.signature }) + "\n");
      log(`${what}: ${r.signature}`);
    };
    let left = 0;
    for (const { name, key } of keys) {
      const isOwner = name === "owner";
      const acct = ata(key.id, mint, tp);
      const coins = isOwner ? ((await reader.tokenBalance(acct).catch(() => null)) ?? 0n) : 0n;
      const hasAcct = isOwner && !!(await rpc.getAccountInfo(acct));
      const lam = await rpc.getBalance(key.id);
      log(`${name} ${key.id}: ${sol(lam)}${isOwner ? `, ${coins} quote token base units${hasAcct ? "" : " (no token account)"}` : ""}`);
      if (sweepable(lam) > 0n || coins > 0n) left++;
      if (!to) {
        if (coins > 0n) log(`  plan: ${coins} quote token base units to the recipient's token account, then close ${name}'s token account`);
        else if (hasAcct) log(`  plan: close ${name}'s empty token account (its rent returns to ${name})`);
        log(sweepable(lam) > 0n || hasAcct ? `  plan: all its SOL to the recipient, less its own fees` : `  plan: nothing to move (no more than the fee it would pay)`);
        continue;
      }
      if (hasAcct && lam >= 2n * BASE_FEE) {
        if (lam < 3_000_000n && coins > 0n && !(await rpc.getAccountInfo(ata(to, mint, tp)))) throw new Error(`${name} holds too little SOL to create the recipient's token account; send it 0.003 SOL or create that account first`);
        const ixs: Ix[] = coins > 0n ? [token.createAtaIdempotent(key.id, to, mint, tp), token.transferChecked(acct, mint, ata(to, mint, tp), key.id, coins, decimals, tp)] : [];
        ixs.push(closeTokenAccount(acct, key.id, key.id, tp));
        await send(`${name}: ${coins} quote token base units to ${to}, token account closed`, key, ixs);
      }
      const now = await rpc.getBalance(key.id);
      // the last transfer carries no priority fee, so its fee is exactly the base fee and the key is left with 0
      if (sweepable(now) > 0n) await send(`${name}: ${sol(sweepable(now))} to ${to}`, key, [system.transfer(key.id, to, sweepable(now))], { priorityMicroLamports: 0 });
      const after = await rpc.getBalance(key.id);
      log(`  ${name} now holds ${sol(after)}`);
      if (after !== 0n && sweepable(now) > 0n) throw new Error(`${name} still holds ${after} lamports`);
    }
    // bonds: told, never moved
    for (const { name, key } of keys.filter((k) => k.name !== "owner")) {
      const a = await reader.agent(key.id).catch(() => null);
      if (a && a.bond > 0n) log(`${name}: bond of ${a.bond} quote token base units stays in the registry (not withdrawable before the unbond cooldown; lost when the programs are closed)`);
    }
    if (CHECK) {
      log(left ? `${left} key(s) still hold more than dust: sweep first` : "nothing left to sweep");
      process.exit(left ? 1 : 0);
    }
    log(to ? "done" : "plan done (nothing sent)");
  } catch (e) {
    console.error(`[site-sweep] failed: ${(e as Error).message.replace(/https?:\/\/\S+/g, "[url]")}`);
    process.exit(2);
  }
}
