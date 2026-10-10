// Browser-bundle fixture for browser.test.ts: the same builders as the node path, run from a
// bundle built with the browser plugin in a runtime with no Buffer and no node:crypto.
import * as c from "../../src/browser/index.ts";

const A = "8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2";
const B = "H9AKH5K79DWfwBQLRe8xv83u4pXgLdRfnzDjpkj3ihvk";
const M = "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU";
const ixs = [
  c.launch.registerPumpLaunch({ launcher: A, agent: B, agentMint: c.launchPdas.config(), lineMint: M, lineTokenProgram: c.TOKEN_2022_PROGRAM,
    args: { repoUrl: c.canonicalUrl("https://github.com/Karpathy/minbpe.git"), identityMode: c.IDENTITY_MODE.app, hosted: false } }),
  c.registry.register({ owner: A, agent: B, mint: M, ownerToken: c.ata(A, M, c.TOKEN_2022_PROGRAM), operator: "00".repeat(32), capabilities: c.H("caps", c.canonicalJson({ arch: "arm64" })), tokenProgram: c.TOKEN_2022_PROGRAM }),
  c.pump.buyV3({ mint: B, quoteMint: M, quoteTokenProgram: c.TOKEN_2022_PROGRAM, user: A, amount: 200_000_000n, maxQuoteIn: 1_000_000n }),
  c.launch.crankPumpFees({ agent: B, agentMint: c.launchPdas.config(), lineMint: M, lineTokenProgram: c.TOKEN_2022_PROGRAM }),
  c.registry.bond({ owner: A, agent: B, mint: M, ownerToken: c.ata(A, M, c.TOKEN_2022_PROGRAM), amount: 5_000_000n, tokenProgram: c.TOKEN_2022_PROGRAM }),
];
const msg = c.compileMessage(A, [c.computeBudget.limit(400_000), ...ixs.slice(0, 1)], "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
const out = {
  hasBuffer: typeof (globalThis as any).Buffer,
  ixs: ixs.map((i) => ({ programId: i.programId, keys: i.keys, data: c.bytesToHex(i.data) })),
  message: c.bytesToHex(msg.bytes),
  unsigned: c.base64Encode(c.unsignedWire(msg)),
  repoId: c.repoId("https://github.com/karpathy/minbpe"),
  leaf: c.payoutLeaf(3, B, `agent:${B}:wallet`, 864000n),
  pdas: [c.registryPdas.agent(B), c.launchPdas.computeVault(B), c.registryPdas.claimReceipt(3, c.hexToBytes(c.payoutLeaf(3, B, `agent:${B}:wallet`, 1n)))],
};
console.log(JSON.stringify(out));
