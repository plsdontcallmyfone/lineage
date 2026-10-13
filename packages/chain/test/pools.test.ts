import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKey, repoId } from "@units/protocol";
import { ASSOCIATED_TOKEN_PROGRAM, ixDisc, launchPdas, LAUNCH_PROGRAM_ID, POOL_ACCOUNT_LEN, POOL_MEMBER_ACCOUNT_LEN, POOL_VAULT_ACCOUNT_LEN, poolPdas, pools, registryPdas, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from "../src/index.ts";

// join_pool as the Pools page builds it (docs/plans/AGENT-POOLS.md 11): the accounts in the program's
// order (pool.rs JoinPool), one signer (the owner's wallet), the existing members' records trailing.

const k = () => generateAgentKey().id;
const REPO = repoId("https://github.com/karpathy/minbpe");

describe("join_pool builder", () => {
  test("first member: thirteen accounts in the program's order, only the owner's wallet signs", () => {
    const owner = k(), agent = k(), mint = k(), line = k();
    const ix = pools.joinPool({ signer: owner, agent, agentMint: mint, repoId: REPO, lineMint: line, members: [] });
    expect(ix.programId).toBe(LAUNCH_PROGRAM_ID);
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(ixDisc("join_pool")));
    expect(ix.keys.map((m) => m.pubkey)).toEqual([launchPdas.config(), poolPdas.config(), owner, launchPdas.agentLaunch(mint), registryPdas.agent(agent), poolPdas.pool(REPO), poolPdas.member(agent),
      poolPdas.auth(REPO), poolPdas.vault(REPO, line, TOKEN_2022_PROGRAM), line, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM]);
    expect(ix.keys.filter((m) => m.isSigner).map((m) => m.pubkey)).toEqual([owner]);
    // the agent's key is not among the accounts at all: nothing the agent holds signs a join
    expect(ix.keys.some((m) => m.pubkey === agent)).toBe(false);
    expect(ix.keys.filter((m) => m.isWritable).map((m) => m.pubkey)).toEqual([owner, launchPdas.agentLaunch(mint), poolPdas.pool(REPO), poolPdas.member(agent), poolPdas.vault(REPO, line, TOKEN_2022_PROGRAM)]);
  });

  test("a later member: every existing member's record follows, writable, in member order", () => {
    const owner = k(), agent = k(), mint = k(), line = k(), a = k(), b = k();
    const ix = pools.joinPool({ signer: owner, agent, agentMint: mint, repoId: REPO, lineMint: line, members: [a, b] });
    expect(ix.keys.slice(13)).toEqual([{ pubkey: poolPdas.member(a), isSigner: false, isWritable: true }, { pubkey: poolPdas.member(b), isSigner: false, isWritable: true }]);
  });

  test("the pool is the repository's: its address follows from the repository id alone", () => {
    expect(poolPdas.pool(REPO)).toBe(poolPdas.pool(repoId("https://github.com/karpathy/minbpe")));
    expect(poolPdas.pool(REPO)).not.toBe(poolPdas.pool(repoId("https://github.com/karpathy/nanogpt")));
  });

  test("the account sizes the page prices are the ones the deployed program created on the fork of mainnet", () => {
    const rec = JSON.parse(readFileSync(join(import.meta.dir, "../../../scripts/mainnet/LAUNCH-UPGRADE-FORK-LAST.json"), "utf8"));
    const sizes = JSON.stringify(rec);
    // first member: Pool, PoolMember, the vault; a later member: PoolMember
    expect(sizes).toContain(`"created_bytes":[${POOL_ACCOUNT_LEN},${POOL_MEMBER_ACCOUNT_LEN},${POOL_VAULT_ACCOUNT_LEN}]`);
    expect(sizes).toContain(`"created_bytes":[${POOL_MEMBER_ACCOUNT_LEN}]`);
  });
});
