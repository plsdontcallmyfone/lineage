#!/usr/bin/env bun
// M2 proposal path for a multisig member: build one Lineage admin action as a Squads v4 vault
// transaction, propose it, approve it, execute it after the time lock, or show its status.
//
//   bun scripts/mainnet/propose.ts status  --multisig <addr> [--index N]
//   bun scripts/mainnet/propose.ts propose --multisig <addr> --member <keyfile> <action> <args.json>
//   bun scripts/mainnet/propose.ts approve --multisig <addr> --member <keyfile> --index N
//   bun scripts/mainnet/propose.ts execute --multisig <addr> --member <keyfile> --index N
//   bun scripts/mainnet/propose.ts print   --multisig <addr> <action> <args.json>   (the inner instructions, base64, nothing sent)
//
// Actions are adminActions in admin.ts: registrySetConfig, registryPause, registrySetSlashCap, registrySetEpochCursor,
// challengeSetConfig, launchSetConfig, bountySetConfig, graduateByAdmin, msgSetConfig,
// upgradeProgram, setUpgradeAuthority. args.json holds that action's argument object (bigints as
// strings with an n suffix, such as "1000000n"; see admin.ts for each shape). `execute` reads the stored
// vault transaction, prints its instructions and executes exactly that.
//
// Endpoint: --rpc <url>, default the local fork (127.0.0.1:9690). A mainnet endpoint is refused unless
// --mainnet is also given (the owner's step, docs/MAINNET-RUNBOOK.md). Keyed URLs are never printed.
// Members can equally approve and execute in the Squads app: the vault transaction is standard.
import { readFileSync } from "node:fs";
import { compileVaultMessage, decodeSquadsVaultTransaction, loadKeypair, Rpc, sendAndConfirm, squads, squadsPdas, type Ix } from "@lineage/chain";
import { adminActions, multisigState, proposalState } from "./admin.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && !["--mainnet"].includes(argv[i - 1]!)));
const [cmd, action, argsPath] = positional;
const rpcUrl = flag("--rpc") ?? "http://127.0.0.1:9690";
const rpc = Rpc.http(rpcUrl, "confirmed");
const genesis = await rpc.call<string>("getGenesisHash");
if (genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" && !argv.includes("--mainnet")) throw new Error("mainnet endpoint: pass --mainnet to confirm");
const multisig = flag("--multisig") ?? (() => { throw new Error("--multisig required"); })();
const vault = squadsPdas.vault(multisig, 0);
const big = (_: string, v: unknown) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

function build(): Ix[] {
  if (!action || !argsPath) throw new Error("action and args.json required");
  const fn = (adminActions as Record<string, (...a: any[]) => Ix[]>)[action];
  if (!fn) throw new Error(`unknown action ${action}; one of ${Object.keys(adminActions).join(", ")}`);
  const args = JSON.parse(readFileSync(argsPath, "utf8"), big) as unknown[];
  return fn(vault, ...(Array.isArray(args) ? args : [args]));
}
const member = () => loadKeypair(flag("--member") ?? (() => { throw new Error("--member <keyfile> required"); })());
const index = () => BigInt(flag("--index") ?? (() => { throw new Error("--index required"); })());
const show = (m: string) => console.log(m);

if (cmd === "status") {
  const st = await multisigState(rpc, multisig);
  show(`multisig ${multisig}: ${st.threshold} of ${st.members.length}, time lock ${st.timeLock} s, last index ${st.transactionIndex}, vault ${vault}`);
  const i = flag("--index") ? index() : st.transactionIndex;
  const p = i > 0n ? await proposalState(rpc, multisig, i) : null;
  if (p) show(`proposal ${i}: ${p.status}${p.statusTs ? ` since ${new Date(Number(p.statusTs) * 1000).toISOString()}` : ""}, approved by ${p.approved.join(", ") || "none"}`);
} else if (cmd === "print") {
  const ixs = build();
  show(JSON.stringify({ vault, message_base64: Buffer.from(compileVaultMessage(vault, ixs).bytes).toString("base64"),
    instructions: ixs.map((x) => ({ program: x.programId, keys: x.keys, data_base64: Buffer.from(x.data).toString("base64") })) }, null, 2));
} else if (cmd === "propose") {
  const m = member();
  const st = await multisigState(rpc, multisig);
  const i = st.transactionIndex + 1n;
  const msg = compileVaultMessage(vault, build());
  const r = await sendAndConfirm(rpc, m, [
    squads.vaultTransactionCreate({ multisig, index: i, creator: m.id, rentPayer: m.id, message: msg.bytes, memo: action!.slice(0, 60) }),
    squads.proposalCreate({ multisig, index: i, creator: m.id, rentPayer: m.id }),
  ]);
  show(`proposed ${action} as transaction ${i}: ${r.signature}`);
} else if (cmd === "approve") {
  const r = await sendAndConfirm(rpc, member(), [squads.proposalApprove({ multisig, index: index(), member: member().id })]);
  show(`approved ${index()}: ${r.signature}`);
} else if (cmd === "execute") {
  // executes exactly what was proposed: the stored message, shown first
  const i = index();
  const tx = decodeSquadsVaultTransaction((await rpc.getAccountInfo(squadsPdas.transaction(multisig, i)))!.data);
  for (const x of tx.instructions) show(`  ${x.programId}: ${x.accounts.length} accounts, data ${Buffer.from(x.data).toString("hex").slice(0, 32)}...`);
  const r = await sendAndConfirm(rpc, member(), [squads.vaultTransactionExecute({ multisig, index: i, member: member().id, message: tx.message })], { computeUnits: 400_000 });
  show(`executed ${i}: ${r.signature}`);
} else {
  show("usage: see the header of scripts/mainnet/propose.ts");
}
