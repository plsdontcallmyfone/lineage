import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { base58Encode } from "@lineage/protocol";
import {
  addressBytes,
  ata,
  claimFromCoreProof,
  AGENT_V2_TAIL,
  decodeAgent,
  decodeAgentLaunch,
  decodeConfig,
  decodeEpoch,
  decodeLaunchConfig,
  decodeSlashReceipt,
  findProgramAddress,
  hexToBytes,
  IDENTITY_MODE,
  isOnCurve,
  launch,
  launchPdas,
  LAUNCH_PROGRAM_ID,
  METEORA,
  OFFENCE,
  paramsFromNetworkJson,
  payoutLeaf,
  registry,
  registryPdas,
  REGISTRY_PROGRAM_ID,
  TOKEN_PROGRAM,
  usageLeaf,
  type Ix,
  type Params,
} from "../src/index.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/client-vectors.json", import.meta.url), "utf8"));
const merkle = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/merkle.json", import.meta.url), "utf8"));

/** solana_keypair::keypair_from_seed([n; 32]).pubkey() */
function k(n: number): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, n)]);
  const spki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  return base58Encode(new Uint8Array(spki.subarray(spki.length - 32)));
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const asVector = (ix: Ix) => ({ program: ix.programId, accounts: ix.keys.map((m) => [m.pubkey, m.isSigner, m.isWritable]), data: b64(ix.data) });
const vector = (name: string) => {
  const v = vectors.instructions.find((x: { name: string }) => x.name === name);
  if (!v) throw new Error(`no vector ${name}`);
  const { name: _, ...rest } = v;
  return rest;
};

// The Rust side's test_params() with register_burn 1,234,567 (onchain/tests/src/lib.rs).
const ONE = 1_000_000n;
const params: Params = {
  registerBurn: 1_234_567n, minBond: 5_000n * ONE, bondCap: 50_000n * ONE, unbondCooldownS: 600n, epochLengthS: 300, reserveBps: 8000, poolBps: 2000,
  canarySlashBps: 2500, minoritySlashBps: 500, revealSlashBps: 200, strikeLimit: 3, uReplay: 1, uAuthor: 4, finderShareBps: 1000, valueCap: 8,
  rebatePerClass: ONE, maxOpenCandidatesPerAgent: 3, authorRewardTo: 0, quorum: 2,
};
const fill = (n: number) => new Uint8Array(32).fill(n);

describe("PDAs", () => {
  test("off-curve check and bump search match the runtime", () => {
    // Every PDA in the vectors was derived by the Rust SDK.
    expect(registryPdas.config()).toBe(vector("registry.pause").accounts[0][0]);
    const [addr, bump] = findProgramAddress([new TextEncoder().encode("vault_authority")], REGISTRY_PROGRAM_ID);
    expect(addr).toBe(registryPdas.vaultAuthority());
    expect(bump).toBeLessThanOrEqual(255);
    // A real ed25519 public key is on the curve; a PDA is not.
    expect(isOnCurve(addressBytes(k(1)))).toBe(true);
    expect(isOnCurve(addressBytes(registryPdas.config()))).toBe(false);
    expect(ata(k(5), k(4), TOKEN_PROGRAM)).toBe(vector("registry.register").accounts[5][0]);
  });
});

describe("instruction builders equal the Anchor encodings", () => {
  const line = k(4);
  const owner = k(5);
  const agent = k(6);
  const mint = k(7);
  const dbcConfig = k(8);
  const launcher = k(9);
  const args = { admin: k(1), coreAuthority: k(2), launchProgram: LAUNCH_PROGRAM_ID, params, maxRebatePerEpoch: 123_456n };
  const ownerToken = ata(owner, line);
  const cases: [string, () => Ix][] = [
    ["registry.initialize", () => registry.initialize({ upgradeAuthority: k(1), mint: line, args })],
    ["registry.set_config", () => registry.setConfig({ admin: k(1), args })],
    ["registry.pause", () => registry.pause({ admin: k(1), paused: true })],
    ["registry.register", () => registry.register({ owner, agent, mint: line, ownerToken, operator: fill(7), capabilities: fill(9) })],
    ["registry.update_agent", () => registry.updateAgent({ owner, agent, operator: fill(3), capabilities: fill(4) })],
    ["registry.bond", () => registry.bond({ owner, agent, mint: line, ownerToken, amount: 5_000_000_000n })],
    ["registry.request_unbond", () => registry.requestUnbond({ owner, agent, amount: 77n })],
    ["registry.withdraw_unbonded", () => registry.withdrawUnbonded({ owner, agent, mint: line, ownerToken })],
    ["registry.slash", () => registry.slash({ coreAuthority: k(2), agent, mint: line, offence: OFFENCE.minority, epoch: 42, slashId: fill(0x5a) })],
    ["registry.set_epoch_cursor", () => registry.setEpochCursor({ admin: k(1), epochsPosted: 3, lastEpoch: 9, anchor: 7, anchorTs: 1_900_000_123 })],
    ["registry.migrate_config", () => registry.migrateConfig({ admin: k(1), maxRebatePerEpoch: 654_321n })],
    ["registry.set_slash_cap", () => registry.setSlashCap({ admin: k(1), maxSlashBpsPerEpoch: 4_321 })],
    ["registry.migrate_config_slash_cap", () => registry.migrateConfigSlashCap({ admin: k(1), maxSlashBpsPerEpoch: 2_500 })],
    ["registry.split", () => registry.split({ mint: line })],
    ["registry.post_epoch", () => registry.postEpoch({ coreAuthority: k(2), mint: line, epoch: 9, payoutRoot: fill(1), lineageRoot: fill(2),
      recordRoot: fill(3), totalUnitsMicro: 3_500_000n, poolAmount: 10n, rebateAmount: 20n })],
    ["registry.rotate_agent_key", () => registry.rotateAgentKey({ owner, agent, newKey: k(12) })],
    ["registry.revoke_agent_key", () => registry.revokeAgentKey({ owner, agent })],
    ["registry.set_profile", () => registry.setProfile({ signingKey: k(12), agent, digest: fill(0xab), seq: 7 })],
    ["registry.propose_owner", () => registry.proposeOwner({ owner, agent, newOwner: k(13) })],
    ["registry.accept_owner", () => registry.acceptOwner({ newOwner: k(13), agent })],
    ["registry.migrate_agent", () => registry.migrateAgent({ payer: k(1), agent })],
    ["registry.migrate_epoch", () => registry.migrateEpoch({ payer: k(1), epoch: 9 })],
    ["registry.claim.agent_wallet", () => registry.claim({ payer: owner, mint: line, epoch: 9, agent, destKind: 0, amount: 99n, leaf: fill(8),
      proof: [fill(5), fill(6)], destToken: ownerToken, agentRecord: registryPdas.agent(agent) })],
    ["registry.claim.wallet", () => registry.claim({ payer: owner, mint: line, epoch: 9, agent, destKind: 2, wallet: k(11), amount: 99n, leaf: fill(8),
      proof: [fill(5), fill(6)], destToken: ata(k(11), line) })],
  ];
  const largs = { admin: k(1), runtimeAuthority: k(3), computeSink: k(10), agentComputeBps: 7000, protocolBps: 3000,
    sleepThreshold: 1n, wakeThreshold: 2n, paused: false, maxDebitPerEpoch: 4_242n };
  const dbcPool = launchPdas.dbcPool(dbcConfig, mint, line);
  cases.push(
    ["launch.initialize_launch", () => launch.initialize({ upgradeAuthority: k(1), lineMint: line, dbcConfig, args: largs })],
    ["launch.set_launch_config", () => launch.setConfig({ admin: k(1), dbcConfig, args: largs })],
    ["launch.launch_agent", () => launch.launchAgent({ launcher, agent, agentMint: mint, lineMint: line, dbcConfig, args: { name: "Base58 Agent",
      symbol: "B58A", uri: "https://example.invalid/agents/b58a.json", repoUrl: "https://github.com/lineage-test/base58", identityMode: IDENTITY_MODE.app,
      hosted: true } })],
    ["launch.crank_fees", () => launch.crankFees({ agent, agentMint: mint, lineMint: line, dbcConfig })],
    ["launch.graduate", () => launch.graduate({ agentMint: mint, dbcPool, dammPool: k(12), position: k(13), positionNftAccount: k(14) })],
    ["launch.graduate_by_admin", () => launch.graduateByAdmin({ admin: k(1), agentMint: mint, dbcPool, dammPool: k(12), position: k(13),
      positionNftAccount: k(14) })],
    ["launch.repoint_position", () => launch.repointPosition({ agentMint: mint, currentPosition: k(13), position: k(15), positionNftAccount: k(16) })],
    ["launch.migrate_launch_config", () => launch.migrateConfig({ admin: k(1), maxDebitPerEpoch: 8_888n })],
    ["launch.post_usage", () => launch.postUsage({ runtimeAuthority: k(3), epoch: 3, root: fill(9) })],
    ["launch.debit_compute", () => launch.debitCompute({ runtimeAuthority: k(3), epoch: 3, agent, agentMint: mint, computeSink: k(10), lineMint: line,
      amount: 150_000n, modelTokens: 81_234, sandboxS: 412, proof: [fill(1)] })],
    ["launch.withdraw_compute", () => launch.withdrawCompute({ launcher, agent, agentMint: mint, launcherToken: ata(launcher, line), lineMint: line, amount: 5n })],
    ["launch.refresh_awake", () => launch.refreshAwake({ agent, agentMint: mint })],
  );
  for (const [name, build] of cases) test(name, () => expect(asVector(build())).toEqual(vector(name)));
  test("launch.crank_pool_fees (vaults derived from the pool)", () => {
    // The vector names arbitrary vault keys; the builder derives DAMM v2's real vault PDAs, so
    // compare everything but those two.
    const ix = asVector(launch.crankPoolFees({ agent, agentMint: mint, lineMint: line, dammPool: k(12), position: k(13), positionNftAccount: k(14) }));
    const v = vector("launch.crank_pool_fees");
    expect(ix.data).toBe(v.data);
    expect(ix.accounts.filter((_, i) => i !== 6 && i !== 7)).toEqual(v.accounts.filter((_: unknown, i: number) => i !== 6 && i !== 7));
    expect(ix.accounts[6]![0]).toBe(launchPdas.dammVault(mint, k(12)));
  });
  test("every vector is covered", () => {
    // The bounty vectors are checked in bounty.test.ts, the challenge vectors in challenge.test.ts.
    const names = new Set([...cases.map((c) => c[0]), "launch.crank_pool_fees", "launch.set_bounty_config", "launch.open_bounty", "launch.release_bounty",
      "launch.refund_bounty", "launch.cancel_bounty", "registry.set_challenge_config", "registry.open_challenge.verdict", "registry.open_challenge.slash",
      "registry.resolve_challenge.epoch", "registry.resolve_challenge.slash", "registry.resolve_challenge.failed", "registry.expire_challenge"]);
    expect(vectors.instructions.map((v: { name: string }) => v.name).filter((n: string) => !names.has(n))).toEqual([]);
  });
});

describe("account decoders read live LiteSVM accounts", () => {
  const acct = (t: string) => vectors.accounts.find((a: { type: string }) => a.type === t);
  const raw = (t: string) => new Uint8Array(Buffer.from(acct(t).data, "base64"));
  test("Config", () => {
    const c = decodeConfig(raw("Config"));
    const f = acct("Config").fields;
    expect([c.admin, c.coreAuthority, c.launchProgram, c.mint, c.tokenProgram, c.paused]).toEqual([f.admin, f.coreAuthority, f.launchProgram, f.mint,
      f.tokenProgram, f.paused]);
    expect([c.epochsPosted, c.lastEpoch, c.params.registerBurn, c.params.unbondCooldownS].map(String)).toEqual([f.epochsPosted, f.lastEpoch,
      f.registerBurn, f.unbondCooldownS]);
    expect([c.params.reserveBps, c.params.poolBps, c.params.quorum, c.params.authorRewardTo, c.params.finderShareBps]).toEqual([f.reserveBps, f.poolBps,
      f.quorum, f.authorRewardTo, f.finderShareBps]);
    expect([c.params.epochLengthS, String(c.maxRebatePerEpoch), String(c.epochAnchor), String(c.epochAnchorTs)]).toEqual([f.epochLengthS,
      f.maxRebatePerEpoch, f.epochAnchor, f.epochAnchorTs]);
    expect(c.maxSlashBpsPerEpoch).toBe(f.maxSlashBpsPerEpoch);
    // A Config written before the slash cap (2 bytes shorter) decodes without it (audit A1-08).
    const v2 = decodeConfig(raw("Config").subarray(0, raw("Config").length - 2));
    expect([String(v2.maxRebatePerEpoch), v2.maxSlashBpsPerEpoch]).toEqual([f.maxRebatePerEpoch, null]);
    // A Config the first layout wrote (26 bytes shorter) still decodes, without the new fields.
    const old = decodeConfig(raw("Config").subarray(0, raw("Config").length - 26));
    expect([old.admin, old.lastEpoch, old.maxRebatePerEpoch, old.epochAnchor, old.maxSlashBpsPerEpoch]).toEqual([c.admin, c.lastEpoch, null, null, null]);
  });
  test("SlashReceipt", () => {
    const r = decodeSlashReceipt(raw("SlashReceipt"));
    const f = acct("SlashReceipt").fields;
    expect([r.slashId, r.agent, r.offence, String(r.epoch), String(r.amount), String(r.slashedAt)]).toEqual([f.slashId, f.agent, f.offence, f.epoch,
      f.amount, f.slashedAt]);
    expect(registryPdas.slashReceipt(r.slashId)).toBe(acct("SlashReceipt").address);
  });
  test("Agent", () => {
    const a = decodeAgent(raw("Agent"));
    const f = acct("Agent").fields;
    expect([a.agent, a.owner, a.kind === "launched" ? 1 : 0, a.hosted, a.operator, a.capabilities]).toEqual([f.agent, f.owner, f.kind, f.hosted, f.operator,
      f.capabilities]);
    expect([a.burned, a.bond, a.unbondAmount, a.unbondReadyAt, a.registeredAt].map(String)).toEqual([f.burned, f.bond, f.unbondAmount, f.unbondReadyAt,
      f.registeredAt]);
    // Agent v2: the snapshot was rotated, given a profile and a pending owner.
    expect([a.version, a.signingKey, a.keySeq, String(a.keyChangedAt), a.profileDigest, a.profileSeq, a.pendingOwner, String(a.ownerSince)]).toEqual([2,
      f.signingKey, f.keySeq, f.keyChangedAt, f.profileDigest, f.profileSeq, f.pendingOwner, f.ownerSince]);
    expect(a.signingKey).not.toBe(a.agent);
    // Audit A1-08: the slash window fields (the snapshot agent was slashed once).
    expect([String(a.slashWindow), String(a.slashedInWindow)]).toEqual([f.slashWindow, f.slashedInWindow]);
    expect(a.slashedInWindow > 0n).toBe(true);
    // A v1 record (the first layout) decodes with the values migrate_agent will write.
    const old = decodeAgent(raw("Agent").subarray(0, raw("Agent").length - AGENT_V2_TAIL));
    expect([old.version, old.signingKey, old.keySeq, old.pendingOwner, old.ownerSince, old.bond]).toEqual([1, a.agent, 0, null, a.registeredAt, a.bond]);
    // A revoked key (default address) decodes as null.
    const revoked = raw("Agent").slice();
    revoked.fill(0, revoked.length - AGENT_V2_TAIL, revoked.length - AGENT_V2_TAIL + 32);
    expect(decodeAgent(revoked).signingKey).toBe(null);
  });
  test("Epoch", () => {
    const e = decodeEpoch(raw("Epoch"));
    const f = acct("Epoch").fields;
    expect([String(e.epoch), e.payoutRoot, e.lineageRoot, String(e.totalPayable), String(e.rebateAmount), String(e.claimedAmount)]).toEqual([f.epoch,
      f.payoutRoot, f.lineageRoot, f.totalPayable, f.rebateAmount, f.claimedAmount]);
    expect([e.version, e.recordRoot]).toEqual([2, f.recordRoot]);
    const old = decodeEpoch(raw("Epoch").subarray(0, raw("Epoch").length - 32));
    expect([old.version, old.recordRoot, old.payoutRoot]).toEqual([1, null, e.payoutRoot]);
  });
  test("LaunchConfig", () => {
    const c = decodeLaunchConfig(raw("LaunchConfig"));
    const f = acct("LaunchConfig").fields;
    expect([c.admin, c.runtimeAuthority, c.lineMint, c.dbcConfig, c.agentComputeBps, c.protocolBps, c.paused]).toEqual([f.admin, f.runtimeAuthority,
      f.lineMint, f.dbcConfig, f.agentComputeBps, f.protocolBps, f.paused]);
    expect([c.sleepThreshold, c.wakeThreshold, c.migrationQuoteThreshold, c.sqrtStartPrice].map(String)).toEqual([f.sleepThreshold, f.wakeThreshold,
      f.migrationQuoteThreshold, f.sqrtStartPrice]);
    expect([c.registryProgram, ...[c.maxDebitPerEpoch, c.usageEpochsPosted, c.lastUsageEpoch, c.usageAnchor, c.usageAnchorTs].map(String)]).toEqual([
      f.registryProgram, f.maxDebitPerEpoch, f.usageEpochsPosted, f.lastUsageEpoch, f.usageAnchor, f.usageAnchorTs]);
    expect(c.registryProgram).toBe(REGISTRY_PROGRAM_ID);
    const old = decodeLaunchConfig(raw("LaunchConfig").subarray(0, raw("LaunchConfig").length - 40));
    expect([old.dbcConfig, old.paused, old.maxDebitPerEpoch, old.usageAnchor]).toEqual([c.dbcConfig, c.paused, null, null]);
  });
  test("AgentLaunch", () => {
    const l = decodeAgentLaunch(raw("AgentLaunch"));
    const f = acct("AgentLaunch").fields;
    expect([l.agent, l.mint, l.launcher, l.repoId, l.repoUrl, l.identityMode, l.hosted, l.dbcPool, l.graduated, l.awake, String(l.createdAt)]).toEqual([
      f.agent, f.mint, f.launcher, f.repoId, f.repoUrl, f.identityMode, f.hosted, f.dbcPool, f.graduated, f.awake, f.createdAt]);
  });
  test("a wrong discriminator is refused", () => {
    expect(() => decodeAgent(raw("Config"))).toThrow("not a Agent account");
  });
});

describe("leaves", () => {
  test("payout and usage leaves equal the fixtures the programs verified", () => {
    for (const l of merkle.payout.leaves) expect(payoutLeaf(merkle.payout.epoch, l.agent, l.dest, l.amount)).toBe(l.leaf);
    for (const u of merkle.usage.leaves) expect(usageLeaf({ epoch: merkle.usage.epoch, ...u })).toBe(u.leaf);
  });
  test("Core proof items become claim fields", () => {
    for (const l of merkle.payout.leaves) {
      const c = claimFromCoreProof({ epoch: merkle.payout.epoch, ...l, root: merkle.payout.root });
      expect(c.amount).toBe(BigInt(l.amount));
      expect(c.leaf).toEqual(hexToBytes(l.leaf));
      if (l.dest.startsWith("wallet:")) expect([c.destKind, c.wallet]).toEqual([2, l.dest.slice(7)]);
      else if (l.dest.endsWith(":compute")) expect([c.destKind, c.agentRecord]).toEqual([1, undefined]);
      else expect([c.destKind, c.agentRecord]).toEqual([0, registryPdas.agent(l.agent)]);
    }
    const l = merkle.payout.leaves[0];
    expect(() => claimFromCoreProof({ epoch: merkle.payout.epoch, ...l, amount: "1", root: merkle.payout.root })).toThrow("leaf does not match");
    expect(() => claimFromCoreProof({ epoch: merkle.payout.epoch, ...l, root: "00".repeat(32) })).toThrow("proof does not verify");
  });
});

describe("params", () => {
  test("config/network.json maps onto the onchain params", () => {
    const net = JSON.parse(readFileSync(new URL("../../../config/network.json", import.meta.url), "utf8"));
    const p = paramsFromNetworkJson(net, 6);
    expect(p.reserveBps + p.poolBps).toBe(10_000);
    expect(p.registerBurn).toBe((BigInt(net.register_burn) * 10n ** 6n) / 10n ** BigInt(net.token_decimals));
    expect(p.finderShareBps).toBe(Math.round(net.finder_share * 10_000));
    expect(METEORA.dbcProgram).toBe(vector("launch.crank_fees").accounts[14][0]);
  });
});
