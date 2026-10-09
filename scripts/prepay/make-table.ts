#!/usr/bin/env bun
// Plan C: creates, fills and freezes the devnet address lookup table a v0 launch transaction reads
// (packages/chain launchTableAddresses), and records it as `launch_lookup_table` in
// scripts/devnet/devnet.json. Idempotent: a recorded table whose content is right and which is frozen
// is left alone. Pays with the Lineage devnet deployer, passed explicitly; prints no key.
//
//   bun scripts/prepay/make-table.ts [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeLookupTable, launchTableAddresses, loadKeypair, lookupTable, Rpc, sendAndConfirm } from "@lineage/chain";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STATE = join(ROOT, "scripts/devnet/devnet.json");
const dry = process.argv.includes("--dry-run");
const state = JSON.parse(readFileSync(STATE, "utf8"));
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
await assertDevnet(rpc);
const want = launchTableAddresses({ lineMint: state.line_mint, dbcConfig: state.dbc_config, lineTokenProgram: state.line_token_program });
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

if (state.launch_lookup_table) {
  const acc = await rpc.getAccountInfo(state.launch_lookup_table);
  const t = acc ? decodeLookupTable(acc.data) : null;
  if (t && same(t.addresses, want) && t.authority === null) {
    console.log(`launch lookup table ${state.launch_lookup_table}: ${t.addresses.length} addresses, frozen, content as expected; nothing to do`);
    process.exit(0);
  }
  console.log(`recorded table ${state.launch_lookup_table} is ${t ? `not as expected (frozen ${t.authority === null}, ${t.addresses.length} addresses)` : "missing"}; making a new one`);
}

const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
const before = await rpc.getBalance(dep.id);
console.log(`deployer ${dep.id}: ${Number(before) / 1e9} SOL; ${want.length} addresses`);
if (dry) process.exit(0);
const slot = await rpc.getSlot();
const { ix: create, address } = lookupTable.create({ authority: dep.id, payer: dep.id, recentSlot: slot - 1 });
const r1 = await sendAndConfirm(rpc, dep, [create, lookupTable.extend({ table: address, authority: dep.id, payer: dep.id, addresses: want })]);
console.log(`create + extend ${address}: ${r1.signature}`);
const r2 = await sendAndConfirm(rpc, dep, [lookupTable.freeze({ table: address, authority: dep.id })]);
console.log(`freeze: ${r2.signature}`);
const t = decodeLookupTable((await rpc.getAccountInfo(address))!.data);
if (!same(t.addresses, want) || t.authority !== null) throw new Error("the table read back is not the expected frozen content");
const after = await rpc.getBalance(dep.id);
state.launch_lookup_table = address;
writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
console.log(JSON.stringify({ table: address, addresses: t.addresses.length, frozen: true, create: r1.signature, freeze: r2.signature, sol: Number(before - after) / 1e9 }));
