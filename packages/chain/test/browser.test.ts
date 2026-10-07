// The browser build of packages/chain (wallet UI lane): the sha256 and Buffer stand-ins agree with
// node, a bundle built with the browser plugin produces byte-identical instructions and messages in
// a runtime with no Buffer and no node:crypto, the wire helpers reproduce buildTransaction, and the
// worker's co-sign check refuses what it must.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, generateAgentKey, H } from "@lineage/protocol";
import * as node from "../src/index.ts";
import { BrowserBuffer } from "../src/browser/buffer.ts";
import { DEVNET_GENESIS, simulateDetailed } from "../src/browser/client.ts";
import { buildBrowserBundle } from "../src/browser/plugin.ts";
import { Sha256 } from "../src/browser/sha256.ts";
import { decodeMessage, missingSigners, parseWire, placeSignature, unsignedWire, wireSignature, type WebKey } from "../src/browser/wire.ts";
import { cosign, inspectForCosign } from "../src/cosign.ts";

describe("stand-ins", () => {
  test("sha256 matches node on every length around the block boundaries", () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const b = new Uint8Array(randomBytes(n));
      const h = new Sha256().update(b.subarray(0, n >> 1)).update(b.subarray(n >> 1)).digest();
      expect(Buffer.from(h).toString("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    }
    expect(Buffer.from(new Sha256().update("global:launch_agent").digest()).toString("hex")).toBe(createHash("sha256").update("global:launch_agent").digest("hex"));
  });
  test("Buffer stand-in: base64 and hex round trips agree with node", () => {
    for (const n of [0, 1, 2, 3, 4, 31, 32, 33, 200]) {
      const b = new Uint8Array(randomBytes(n));
      const b64 = Buffer.from(b).toString("base64");
      expect(BrowserBuffer.from(b).toString("base64")).toBe(b64);
      expect([...BrowserBuffer.from(b64, "base64")]).toEqual([...b]);
      expect(BrowserBuffer.from(Buffer.from(b).toString("hex"), "hex").toString("hex")).toBe(Buffer.from(b).toString("hex"));
    }
    expect(BrowserBuffer.byteLength("tLINE é")).toBe(Buffer.byteLength("tLINE é"));
  });
});

describe("browser bundle", () => {
  test("builds without node builtins and reproduces the node builders byte for byte", async () => {
    const js = await buildBrowserBundle(join(import.meta.dir, "browser/entry.ts"), { minify: true });
    expect(js).not.toMatch(/from\s*"node:|require\("node:/);
    const dir = mkdtempSync(join(tmpdir(), "chain-browser-"));
    writeFileSync(join(dir, "bundle.mjs"), js);
    // a runtime without Buffer: the bundle must install its own
    const r = spawnSync("node", ["--input-type=module", "-e", `delete globalThis.Buffer; await import(${JSON.stringify(join(dir, "bundle.mjs"))});`], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.hasBuffer).toBe("function");

    const A = "8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2";
    const B = "H9AKH5K79DWfwBQLRe8xv83u4pXgLdRfnzDjpkj3ihvk";
    const M = "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU";
    const D = "AEcaMdhK3PSqPDq2rrXZMoKsCPCTVTMdqJXaT34mWWGw";
    const T = node.TOKEN_2022_PROGRAM;
    const ixs = [
      node.launch.launchAgent({ launcher: A, agent: B, agentMint: node.launchPdas.config(), lineMint: M, dbcConfig: D, lineTokenProgram: T,
        args: { name: "TEST x", symbol: "TX", uri: "https://lineage.invalid/x.json?class=rust", repoUrl: "https://github.com/karpathy/minbpe", identityMode: 2, hosted: false } }),
      node.registry.register({ owner: A, agent: B, mint: M, ownerToken: node.ata(A, M, T), operator: "00".repeat(32), capabilities: H("caps", canonicalJson({ arch: "arm64" })), tokenProgram: T }),
      node.dbc.swap({ config: D, pool: node.launchPdas.dbcPool(D, B, M), agentMint: B, lineMint: M, trader: A, lineAccount: node.ata(A, M, T), agentAccount: node.ata(A, B, T), buy: true, amountIn: 200_000_000n, minOut: 1n, lineTokenProgram: T }),
      node.launch.crankFees({ agent: B, agentMint: node.launchPdas.config(), lineMint: M, dbcConfig: D, lineTokenProgram: T }),
      node.registry.bond({ owner: A, agent: B, mint: M, ownerToken: node.ata(A, M, T), amount: 5_000_000n, tokenProgram: T }),
    ];
    expect(out.ixs).toEqual(ixs.map((i) => ({ programId: i.programId, keys: i.keys, data: node.bytesToHex(i.data) })));
    const msg = node.compileMessage(A, [node.computeBudget.limit(400_000), ixs[0]!], DEVNET_GENESIS);
    expect(out.message).toBe(node.bytesToHex(msg.bytes));
    expect(out.repoId).toBe("a7a07b033d8327a8e9772cdf7ad392f6e505757dcdeec78c61dd0715dac8ca05");
    expect(out.leaf).toBe(node.payoutLeaf(3, B, `agent:${B}:wallet`, 864000n));
    expect(out.pdas).toEqual([node.registryPdas.agent(B), node.launchPdas.computeVault(B), node.registryPdas.claimReceipt(3, node.hexToBytes(node.payoutLeaf(3, B, `agent:${B}:wallet`, 1n)))]);
  });
});

/** A WebCrypto signer over a known seed, as the page's fresh keys are. */
async function webKeyFrom(k: node.Signer): Promise<WebKey> {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(k.secret.subarray(0, 32))]);
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { id: k.id, sign: async (m) => new Uint8Array(await crypto.subtle.sign("Ed25519", priv, m as BufferSource)), exportSolanaJson: async () => Array.from(k.secret) };
}

describe("wire", () => {
  const payer = generateAgentKey();
  const agent = generateAgentKey();
  const mint = "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU";
  const ix = node.registry.register({ owner: payer.id, agent: agent.id, mint, ownerToken: node.ata(payer.id, mint, node.TOKEN_2022_PROGRAM), operator: "00".repeat(32), capabilities: "00".repeat(32), tokenProgram: node.TOKEN_2022_PROGRAM });
  const ixs = [node.computeBudget.limit(200_000), ix];

  test("unsigned wire plus placed signatures equals buildTransaction", async () => {
    const msg = node.compileMessage(payer.id, ixs, DEVNET_GENESIS);
    let wire = unsignedWire(msg);
    expect(missingSigners(wire).sort()).toEqual([payer.id, agent.id].sort());
    wire = placeSignature(wire, payer.id, node.signBytes(payer, msg.bytes));
    expect(missingSigners(wire)).toEqual([agent.id]);
    const wk = await webKeyFrom(agent);
    wire = placeSignature(wire, agent.id, await wk.sign(msg.bytes));
    const ref = node.buildTransaction(payer, ixs, DEVNET_GENESIS, [agent]);
    expect(Buffer.from(wire).toString("hex")).toBe(Buffer.from(ref.wire).toString("hex"));
    expect(wireSignature(wire)).toBe(ref.signature);
  });

  test("decodeMessage recovers every instruction, account flag and the blockhash", () => {
    const msg = node.compileMessage(payer.id, ixs, DEVNET_GENESIS);
    const d = decodeMessage(msg.bytes);
    expect(d.blockhash).toBe(DEVNET_GENESIS);
    expect(d.instructions.map((i) => ({ programId: i.programId, data: Buffer.from(i.data).toString("hex") }))).toEqual(ixs.map((i) => ({ programId: i.programId, data: Buffer.from(i.data).toString("hex") })));
    const reg = d.instructions[1]!;
    for (const [j, k] of ix.keys.entries()) {
      expect(reg.accounts[j]!.pubkey).toBe(k.pubkey);
      expect(reg.accounts[j]!.isSigner).toBe(k.isSigner || k.pubkey === payer.id);
      expect(reg.accounts[j]!.isWritable).toBe(k.isWritable || k.pubkey === payer.id);
    }
  });

  test("worker co-sign: accepts a wallet-signed register for its own key and produces the full transaction", () => {
    const msg = node.compileMessage(payer.id, ixs, DEVNET_GENESIS);
    const partial = placeSignature(unsignedWire(msg), payer.id, node.signBytes(payer, msg.bytes));
    const plan = inspectForCosign(partial, agent.id);
    expect(plan.payer).toBe(payer.id);
    const full = cosign(partial, agent);
    expect(missingSigners(full)).toEqual([]);
    expect(Buffer.from(full).toString("hex")).toBe(Buffer.from(node.buildTransaction(payer, ixs, DEVNET_GENESIS, [agent]).wire).toString("hex"));
  });

  test("worker co-sign refuses: unsigned owner, a forged owner signature, another agent, other programs", () => {
    const msg = node.compileMessage(payer.id, ixs, DEVNET_GENESIS);
    expect(() => inspectForCosign(unsignedWire(msg), agent.id)).toThrow(/has not signed/);
    const forged = placeSignature(unsignedWire(msg), payer.id, node.signBytes(generateAgentKey(), msg.bytes));
    expect(() => inspectForCosign(forged, agent.id)).toThrow(/does not verify/);
    const other = generateAgentKey();
    const signed = placeSignature(unsignedWire(msg), payer.id, node.signBytes(payer, msg.bytes));
    expect(() => inspectForCosign(signed, other.id)).toThrow(/not a signer/);
    const sneaky = [...ixs, node.system.transfer(agent.id, payer.id, 1_000_000n)];
    const m2 = node.compileMessage(payer.id, sneaky, DEVNET_GENESIS);
    const w2 = placeSignature(unsignedWire(m2), payer.id, node.signBytes(payer, m2.bytes));
    expect(() => inspectForCosign(w2, agent.id)).toThrow(/refusing to co-sign/);
    const bond = node.registry.bond({ owner: payer.id, agent: agent.id, mint, ownerToken: node.ata(payer.id, mint), amount: 1n });
    const m3 = node.compileMessage(payer.id, [{ ...bond, keys: [...bond.keys, { pubkey: agent.id, isSigner: true, isWritable: false }] }], DEVNET_GENESIS);
    const w3 = placeSignature(unsignedWire(m3), payer.id, node.signBytes(payer, m3.bytes));
    expect(() => inspectForCosign(w3, agent.id)).toThrow(/other than register/);
  });
});

describe("simulation read-out", () => {
  test("rent deposits are the lamports of accounts that the simulation creates", async () => {
    const payer = generateAgentKey();
    const fresh = generateAgentKey();
    const ix = node.system.createAccount(payer.id, fresh.id, 2_039_280n, 165, node.TOKEN_2022_PROGRAM);
    const msg = node.compileMessage(payer.id, [ix], DEVNET_GENESIS);
    const wire = unsignedWire(msg);
    const keys = decodeMessage(msg.bytes).keys;
    const acct = (lamports: number, owner: string) => ({ lamports, owner, executable: false, data: ["", "base64"] as [string, string] });
    const rpc = new node.Rpc(async (method) => {
      if (method === "getMultipleAccounts") return { value: keys.map((k) => (k === payer.id ? acct(1_000_000_000, node.SYSTEM_PROGRAM) : k === fresh.id ? null : acct(1, "NativeLoader1111111111111111111111111111111"))) };
      if (method === "simulateTransaction")
        return { value: { err: null, logs: [], unitsConsumed: 150, accounts: keys.map((k) => (k === payer.id ? acct(1_000_000_000 - 2_039_280, node.SYSTEM_PROGRAM) : k === fresh.id ? acct(2_039_280, node.TOKEN_2022_PROGRAM) : acct(1, "NativeLoader1111111111111111111111111111111"))) } };
      if (method === "getFeeForMessage") return { value: 10_000 };
      throw new Error(method);
    });
    const sim = await simulateDetailed(rpc, wire);
    const created = sim.accounts.filter((a) => a.created);
    expect(created.map((a) => a.address)).toEqual([fresh.id]);
    expect(created[0]!.after).toBe(2_039_280n);
    expect(sim.fee).toBe(10_000n);
    expect(sim.accounts.find((a) => a.address === payer.id)!.signer).toBe(true);
    expect(parseWire(wire).signatures.length).toBe(2);
  });
});
