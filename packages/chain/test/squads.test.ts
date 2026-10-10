import { describe, expect, test } from "bun:test";
import {
  DEVNET_V1_PROGRAM_IDS,
  withProgramIdsForTest,
  bounty,
  compileVaultMessage,
  decodeSquadsMultisig,
  decodeSquadsProposal,
  executeAccounts,
  Reader,
  SQUADS_PERM,
  squadsPdas,
} from "../src/index.ts";
import fx from "./fixtures/squads-accounts.json";

// Accounts written by the real Squads v4 program (mainnet build) on the fork rehearsal
// (scripts/mainnet/rehearsal.ts, recorded by scripts/mainnet/record-squads-fixture.ts).
const acct = (k: keyof typeof fx.accounts) => new Uint8Array(Buffer.from(fx.accounts[k], "base64"));
const ONE = 1_000_000n;
const BOUNTY_ARGS = { maxBountyOutBps: 5_000, selfHostedInCap: 10n * ONE, windowS: 86_400, minTtlS: 60, maxTtlS: 30 * 86_400, refundGraceS: 60, minAmount: ONE / 100n, paused: false };

describe("squads v4", () => {
  test("program config PDA is the mainnet account", () => {
    expect(squadsPdas.programConfig()).toBe("BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr");
  });

  test("multisig account decodes: 2 of 3, all permissions, vault derived", () => {
    const m = decodeSquadsMultisig(acct("multisig"));
    expect(m.threshold).toBe(2);
    expect(m.members.map((x) => x.key).sort()).toEqual([...fx.members].sort()); // the program sorts members
    expect(m.members.every((x) => x.permissions === SQUADS_PERM.all)).toBe(true);
    expect(m.configAuthority).toBe("11111111111111111111111111111111");
    expect(m.rentCollector).toBe(fx.vault);
    expect(squadsPdas.multisig(m.createKey)).toBe(fx.multisig);
    expect(squadsPdas.vault(fx.multisig, 0)).toBe(fx.vault);
  });

  test("executed proposal decodes with its two approvals", () => {
    const p = decodeSquadsProposal(acct("proposal_1"));
    expect(p.multisig).toBe(fx.multisig);
    expect(p.transactionIndex).toBe(1n);
    expect(p.status).toBe("Executed");
    expect(p.approved.length).toBe(2);
  });

  test("the program stored exactly the message compileVaultMessage built", () => {
    // recorded on a fork at the first devnet deployment's launch id (DEVNET_V1_PROGRAM_IDS)
    const ix = withProgramIdsForTest(DEVNET_V1_PROGRAM_IDS, () => bounty.setConfig({ admin: fx.vault, args: BOUNTY_ARGS }));
    const m = compileVaultMessage(fx.vault, [ix]);
    // VaultTransaction: disc, multisig, creator, index, bump, vault index, vault bump, ephemeral bumps, message (borsh u32 vecs)
    const rd = new Reader(acct("transaction_1")).expect("VaultTransaction");
    expect(rd.address()).toBe(fx.multisig);
    rd.address();
    expect(rd.u64()).toBe(1n);
    rd.bytes(3);
    rd.bytes(rd.u32());
    expect([rd.u8(), rd.u8(), rd.u8()]).toEqual([m.numSigners, m.numWritableSigners, m.numWritableNonSigners]);
    const keys = Array.from({ length: rd.u32() }, () => rd.address());
    expect(keys).toEqual(m.keys);
    expect(rd.u32()).toBe(1);
    expect(keys[rd.u8()]).toBe(ix.programId);
    const idx = Array.from(rd.bytes(rd.u32()));
    expect(idx.map((i) => keys[i])).toEqual(ix.keys.map((k) => k.pubkey));
    expect(Buffer.from(rd.bytes(rd.u32())).equals(Buffer.from(ix.data))).toBe(true);
    expect(rd.u32()).toBe(0);
  });

  test("execute accounts never mark the vault as a signer", () => {
    // recorded on a fork at the first devnet deployment's launch id (DEVNET_V1_PROGRAM_IDS)
    const ix = withProgramIdsForTest(DEVNET_V1_PROGRAM_IDS, () => bounty.setConfig({ admin: fx.vault, args: BOUNTY_ARGS }));
    const m = compileVaultMessage(fx.vault, [ix]);
    const metas = executeAccounts(m, fx.vault);
    expect(metas[0]).toEqual({ pubkey: fx.vault, isSigner: false, isWritable: true });
    expect(metas.filter((x) => x.isSigner)).toEqual([]);
  });
});
