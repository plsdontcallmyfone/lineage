#!/usr/bin/env bun
// The runbook's setup commands (docs/MAINNET-RUNBOOK.md), the same code the fork rehearsal runs
// (steps.ts). Idempotent: each step reads chain state first and skips what exists, so a stopped run
// resumes. Keys are passed as files; nothing reads `solana config`; no key or keyed URL is printed.
//
//   bun scripts/mainnet/initialize.ts multisig --params <launch-params.json> --payer <key> --create-key <key> [--rpc <url>] [--mainnet]
//   bun scripts/mainnet/initialize.ts init     --params <launch-params.json> --payer <deployer key> --dbc-config-key <key> --multisig <addr> [--lookup-table <addr from an earlier run>] [--priority-micro-lamports N] [--rpc <url>] [--mainnet]
//   bun scripts/mainnet/initialize.ts check    --params <launch-params.json> --multisig <addr> [--rpc <url>] [--mainnet]
//
// --rpc defaults to the local fork (127.0.0.1:9690). A mainnet endpoint is refused without --mainnet.
// Program ids come from the active network profile: run with LINEAGE_NETWORK=mainnet (the mainnet ids,
// on the fork and on mainnet); a mainnet endpoint under any other profile is refused.
import { loadKeypair, Rpc, sendAndConfirm, squadsPdas, TxError, type Ix, type Signer } from "@lineage/chain";
import { checkEndpoint, checkHandover, createMultisig, initializeAll, loadLaunchParams, programIdsNow, useActiveProfile } from "./steps.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const need = (n: string) => flag(n) ?? (() => { throw new Error(`${n} required`); })();
const rpcUrl = flag("--rpc") ?? "http://127.0.0.1:9690";
const rpc = Rpc.http(rpcUrl, "confirmed");
// program ids from the active network profile (LINEAGE_NETWORK=mainnet for the runbook and the fork)
const profile = useActiveProfile();
const genesis = await checkEndpoint(rpc, profile, { deployed: cmd !== "multisig", local: rpcUrl.startsWith("http://127.0.0.1:") });
const isMainnet = genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
if (isMainnet && !argv.includes("--mainnet")) throw new Error("mainnet endpoint: pass --mainnet to confirm");
const price = flag("--priority-micro-lamports") ? Number(flag("--priority-micro-lamports")) : undefined;
const ids = programIdsNow();
console.log(`[init] ${isMainnet ? "MAINNET" : "not mainnet"} (genesis ${genesis.slice(0, 8)}...), ${profile.network} profile: registry ${ids.registry}, launch ${ids.launch}, msg ${ids.msg}`);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`[init] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const send = async (what: string, payer: Signer, ixs: Ix[], o: { signers?: Signer[]; computeUnits?: number } = {}) => {
  try {
    const r = await sendAndConfirm(rpc, payer, ixs, { ...o, priorityMicroLamports: price, computeUnits: o.computeUnits ?? (price ? 400_000 : undefined) });
    console.log(`[init] ${what}: ${r.signature} (fee ${r.fee})`);
    return r;
  } catch (e) {
    if (e instanceof TxError) for (const l of e.logs.slice(-15)) console.error(`    ${l}`);
    throw e;
  }
};

const P = loadLaunchParams(need("--params"));
if (cmd === "multisig") {
  const r = await createMultisig(rpc, send, check, loadKeypair(need("--payer")), loadKeypair(need("--create-key")), P);
  console.log(JSON.stringify(r));
} else if (cmd === "init") {
  const multisig = need("--multisig");
  const vault = squadsPdas.vault(multisig, 0);
  const r = await initializeAll(rpc, send, check, loadKeypair(need("--payer")), loadKeypair(need("--dbc-config-key")), P, vault, flag("--lookup-table"));
  console.log(JSON.stringify({ vault, ...r }));
} else if (cmd === "check") {
  await checkHandover(rpc, check, squadsPdas.vault(need("--multisig"), 0), P);
} else {
  console.log("usage: see the header of scripts/mainnet/initialize.ts");
  process.exit(2);
}
if (failed) process.exit(1);
