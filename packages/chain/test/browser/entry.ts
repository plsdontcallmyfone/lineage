// Browser-bundle fixture for browser.test.ts: the same builders as the node path, run from a
// bundle built with the browser plugin in a runtime with no Buffer and no node:crypto.
import * as c from "../../src/browser/index.ts";

const A = "8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2";
const B = "H9AKH5K79DWfwBQLRe8xv83u4pXgLdRfnzDjpkj3ihvk";
const M = "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU";
const D = "AEcaMdhK3PSqPDq2rrXZMoKsCPCTVTMdqJXaT34mWWGw";
const ixs = [
  c.launch.launchAgent({ launcher: A, agent: B, agentMint: c.launchPdas.config(), lineMint: M, dbcConfig: D, lineTokenProgram: c.TOKEN_2022_PROGRAM,
    args: { name: "TEST x", symbol: "TX", uri: "https://lineage.invalid/x.json?class=rust", repoUrl: c.canonicalUrl("https://github.com/Karpathy/minbpe.git"), identityMode: c.IDENTITY_MODE.app, hosted: false } }),
  c.registry.register({ owner: A, agent: B, mint: M, ownerToken: c.ata(A, M, c.TOKEN_2022_PROGRAM), operator: "00".repeat(32), capabilities: c.H("caps", c.canonicalJson({ arch: "arm64" })), tokenProgram: c.TOKEN_2022_PROGRAM }),
  c.dbc.swap({ config: D, pool: c.launchPdas.dbcPool(D, B, M), agentMint: B, lineMint: M, trader: A, lineAccount: c.ata(A, M, c.TOKEN_2022_PROGRAM), agentAccount: c.ata(A, B, c.TOKEN_2022_PROGRAM), buy: true, amountIn: 200_000_000n, minOut: 1n, lineTokenProgram: c.TOKEN_2022_PROGRAM }),
  c.launch.crankFees({ agent: B, agentMint: c.launchPdas.config(), lineMint: M, dbcConfig: D, lineTokenProgram: c.TOKEN_2022_PROGRAM }),
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
