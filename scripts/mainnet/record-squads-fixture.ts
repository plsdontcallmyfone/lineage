#!/usr/bin/env bun
// Records the rehearsal's Squads v4 accounts from the fork (multisig, an executed proposal, a vault
// transaction) into packages/chain/test/fixtures/squads-accounts.json for squads.test.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { squadsPdas } from "@lineage/chain";
import { fork } from "./lib.ts";
import last from "./REHEARSAL-LAST.json";

const ms = (last as { multisig: { address: string; vault: string; members: string[] } }).multisig;
const pick = async (a: string) => Buffer.from((await fork.getAccountInfo(a))!.data).toString("base64");
const out = {
  note: "Squads v4 accounts written by the real program on the mainnet fork rehearsal (scripts/mainnet/rehearsal.ts)",
  multisig: ms.address, vault: ms.vault, members: ms.members,
  accounts: {
    multisig: await pick(ms.address),
    proposal_1: await pick(squadsPdas.proposal(ms.address, 1)),
    transaction_1: await pick(squadsPdas.transaction(ms.address, 1)),
  },
};
writeFileSync(join(import.meta.dir, "../../packages/chain/test/fixtures/squads-accounts.json"), JSON.stringify(out, null, 2) + "\n");
console.log("recorded");
