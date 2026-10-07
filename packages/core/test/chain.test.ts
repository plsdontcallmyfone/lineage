import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDisc, ChainReader, fixtureTransport, hexToBytes, Reader, registryPdas, Rpc, Writer, type Ix, type Transport } from "@lineage/chain";
import { ChainBridge, chainBootstrap, parseChainSettings } from "../src/chain.ts";
import { FakeClock } from "../src/clock.ts";
import { CoreClient } from "../src/client.ts";
import { parseNetworkConfig } from "../src/config.ts";
import { Core } from "../src/core.ts";
import { serve } from "../src/http.ts";
import { generateAgentKey, merkleProof, merkleRoot, verifyProof } from "../src/protocol.ts";
import { CAPS, ROOT } from "./helpers.ts";

// Core chain mode against devnet state recorded by scripts/devnet/record-fixtures.ts: no live RPC.

const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/devnet-rpc.json"), "utf8"));
const base = parseNetworkConfig(JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8")));
const SETTINGS = parseChainSettings({ mode: "devnet", rpc_url: "https://api.devnet.solana.com", registry_program: "2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY",
  launch_program: "8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT" })!;
const MINBPE = fx.state.agents.minbpe.agent as string;
const VERIFIER = fx.state.agents["verifier-test"].agent as string;

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/**
 * Recorded responses, plus optional overrides. Claim receipts of epochs posted inside a test cannot
 * be in the recording, so an unrecorded getMultipleAccounts answers "no such accounts".
 */
function transport(extra?: (method: string, params: unknown[]) => unknown): Transport {
  const rec = fixtureTransport(fx.responses);
  return async (method, params) => {
    const v = extra?.(method, params);
    if (v !== undefined) return v;
    try {
      return await rec(method, params);
    } catch (e) {
      if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map(() => null) };
      throw e;
    }
  };
}

async function setup(opts: { coreKey?: string; send?: (label: string, ixs: Ix[]) => Promise<{ signature: string }>; extra?: (m: string, p: unknown[]) => unknown } = {}) {
  const reader = new ChainReader(new Rpc(transport(opts.extra)), SETTINGS.registry_program, SETTINGS.launch_program);
  const boot = await chainBootstrap(base, reader);
  const dir = mkdtempSync(join(tmpdir(), "lineage-chain-"));
  const admin = generateAgentKey();
  const clock = new FakeClock(Date.now());
  const core = new Core({ dataDir: dir, network: boot.network, adminId: admin.id, clock, chainMode: true, firstEpoch: boot.firstEpoch, randomHex: (n) => "ab".repeat(n) });
  const bridge = new ChainBridge(core, SETTINGS, { reader, coreKey: opts.coreKey ? { id: opts.coreKey, secret: new Uint8Array(64) } : null, send: opts.send });
  cleanup.push(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { core, bridge, boot, admin, clock };
}

describe("chain mode bootstrap", () => {
  test("chain-held parameters replace the file's; the first epoch follows the last posted one", async () => {
    const { boot } = await setup();
    expect(boot.decimals).toBe(6);
    // config/network.json says 1 LINE at 9 decimals; the registry holds it at the mint's 6
    expect(boot.network.register_burn).toBe(1_000_000n);
    expect(boot.network.min_bond).toBe(5_000_000n);
    expect(boot.network.rebate_per_class).toBe(1_000n);
    expect(boot.network.token_decimals).toBe(6);
    expect([boot.network.agent_compute_bps, boot.network.protocol_bps, boot.network.reserve_bps, boot.network.pool_bps]).toEqual([7000, 3000, 8000, 2000]);
    expect(boot.network.epoch_length_s).toBe(base.epoch_length_s);
    expect(boot.firstEpoch).toBe(fx.state.first_epoch);
    expect(boot.registry.mint).toBe(fx.state.line_mint);
  });
  test("sim stays the default", () => {
    expect(parseChainSettings(undefined)).toBeNull();
    expect(parseChainSettings({ mode: "sim" })).toBeNull();
    expect(() => parseChainSettings({ mode: "mainnet" })).toThrow();
  });
});

describe("mirror", () => {
  test("agents whose Agent PDA exists are registered with their onchain bond; launched agents get their compute vault", async () => {
    const { core, bridge } = await setup();
    await bridge.tick();
    const v = core.agentView(VERIFIER);
    expect(v.kind).toBe("verifier");
    expect(v.bond).toBe("5000000");
    const l = core.agentView(MINBPE);
    expect(l.kind).toBe("launched");
    expect(l.target_repo).toBe("https://github.com/karpathy/minbpe");
    expect(l.hosted).toBe(true);
    expect(l.identity_mode).toBe("app");
    const snap = bridge.view() as any;
    expect(BigInt(l.compute)).toBe(BigInt(snap.compute[MINBPE].balance));
    expect(l.awake).toBe(BigInt(l.compute) >= base.wake_threshold / 1000n);
    // vault figures come from the chain read, and the ledger mirrors them
    expect(snap.slot).toBe(fx.state.slot);
    const bal = core.ledger.balances();
    expect(bal.reserve).toBe(snap.balances.reserve);
    expect(bal.pool ?? "0").toBe(snap.balances.pool);
    expect(core.ledger.reconcile().ok).toBe(true);
    // a second sync changes nothing
    const entries = core.ledger.reconcile().entries;
    await bridge.tick();
    expect(core.ledger.reconcile().entries).toBe(entries);
  });

  test("simulated registration, bonds, fees, usage and claims are refused with on_chain", async () => {
    const { core, admin } = await setup();
    const server = serve(core, { port: 0 });
    cleanup.push(() => server.stop(true));
    const url = `http://127.0.0.1:${server.port}`;
    const k = generateAgentKey();
    const a = new CoreClient(url, admin);
    for (const [c, path, body] of [
      [new CoreClient(url, k), "/v1/agents", {}],
      [new CoreClient(url, k), `/v1/agents/${k.id}/bond`, { amount: "1" }],
      [a, "/v1/admin/creator-rewards", { amount: "1" }],
      [a, "/v1/admin/agent-fees", { agent: k.id, amount: "1" }],
      [a, "/v1/admin/launches", { agent: k.id, mint: k.id, launcher: k.id, target_repo: "https://github.com/a/b" }],
      [a, "/v1/admin/usage", { agent: k.id, amount: "1" }],
    ] as const) {
      const r = await c.post(path, body);
      expect([path, r.status, r.body.error]).toEqual([path, 409, "on_chain"]);
    }
    const chain = await new CoreClient(url, null).get("/v1/chain");
    expect(chain.body.mode).toBe("devnet");
  });

  test("declared capabilities must match a nonzero digest registered on chain", async () => {
    const { core, bridge } = await setup();
    await bridge.tick();
    // verifier-test registered with a zero digest: anything may be declared
    expect(core.setCapabilities(VERIFIER, { capabilities: CAPS }).capabilities as unknown).toEqual(CAPS);
    core.db.query("UPDATE agents SET chain_caps = ? WHERE agent_id = ?").run(core.capsDigest(CAPS), VERIFIER);
    expect(core.setCapabilities(VERIFIER, { capabilities: CAPS }).capabilities as unknown).toEqual(CAPS);
    expect(() => core.setCapabilities(VERIFIER, { capabilities: { ...CAPS, cpus: 2 } })).toThrow(/registered on chain/);
  });
});

describe("epoch posting", () => {
  test("a closed epoch goes to post_epoch with Core's root and totals, signed by the Core authority", async () => {
    const reg = await new ChainReader(new Rpc(transport())).registryConfig();
    const sent: { label: string; ixs: Ix[] }[] = [];
    const { core, bridge } = await setup({ coreKey: reg!.coreAuthority, send: async (label, ixs) => (sent.push({ label, ixs }), { signature: `sig${sent.length}` }) });
    await bridge.tick();
    // two replays' worth of units and rebates for the verifier, units for the launched agent's authoring
    core.tx(() => {
      (core as any).addUnits(VERIFIER, "replay", "r1", 2, 2_000n);
      (core as any).addUnits(MINBPE, "author", "g1", 5);
    });
    const closed = core.closeEpoch();
    expect(closed.n).toBe(fx.state.first_epoch);
    const reserveBefore = core.ledger.balance("reserve");
    await bridge.tick();
    expect(sent.map((s) => s.label)).toEqual([`post_epoch ${closed.n}`]);
    const ix = sent[0]!.ixs[0]!;
    expect(ix.programId).toBe(SETTINGS.registry_program);
    expect(ix.keys[1]).toEqual({ pubkey: reg!.coreAuthority, isSigner: true, isWritable: true });
    expect(ix.keys[2]!.pubkey).toBe(registryPdas.epoch(closed.n));
    const rd = new Reader(ix.data.subarray(8));
    expect(rd.u64()).toBe(BigInt(closed.n));
    expect(rd.hex32()).toBe(closed.root!);
    expect(rd.hex32()).toBe(closed.lineage_root!);
    expect(rd.u64()).toBe(7_000_000n);
    expect(rd.u64()).toBe(BigInt(closed.pool_amount!));
    expect(rd.u64()).toBe(2_000n);
    expect(closed.rebate_amount).toBe("2000");
    // the recorded pool is empty, so the leaves are the rebate only
    const leaves = closed.payouts as { agent: string; dest: string; amount: string; leaf: string }[];
    expect(leaves.map((l) => [l.agent, l.dest, l.amount])).toEqual([[VERIFIER, `agent:${VERIFIER}:wallet`, "2000"]]);
    expect(verifyProof(leaves[0]!.leaf, merkleProof([leaves[0]!.leaf], 0), merkleRoot([leaves[0]!.leaf]))).toBe(true);
    expect(core.chainEpochs()).toMatchObject([{ n: closed.n, signature: "sig1", error: null }]);
    // before the post the mirror held the rebate back from the reserve (decided, not yet sent)
    expect(reserveBefore).toBe(BigInt((bridge.view() as any).balances.reserve) - 2_000n);
    // posted epochs are not resent; once posted, the mirror follows the chain's reserve as read
    // (the recording predates the post, so here that is the pre-post figure)
    await bridge.tick();
    expect(sent.length).toBe(1);
    expect(core.ledger.balance("reserve")).toBe(BigInt((bridge.view() as any).balances.reserve));
    expect(core.ledger.reconcile().ok).toBe(true);
    expect((bridge.view() as any).posted_epochs).toMatchObject([{ n: closed.n, signature: "sig1" }]);
  });

  test("an epoch at or before the chain's last posted epoch is refused, not sent", async () => {
    const reg = await new ChainReader(new Rpc(transport())).registryConfig();
    const sent: string[] = [];
    const { core, bridge } = await setup({ coreKey: reg!.coreAuthority, send: async (label) => (sent.push(label), { signature: "x" }) });
    core.db.query("UPDATE epochs SET n = 0").run(); // as if Core had started from 0 again
    core.closeEpoch();
    await bridge.tick();
    expect(sent).toEqual([]);
    expect(core.chainEpochs()[0]!.error).toMatch(/not after the last posted epoch/);
  });

  test("without the Core authority key the bridge only reads", async () => {
    const sent: string[] = [];
    const { core, bridge } = await setup({ coreKey: generateAgentKey().id, send: async (l) => (sent.push(l), { signature: "x" }) });
    core.closeEpoch();
    await bridge.tick();
    expect(sent).toEqual([]);
    expect((bridge.view() as any).core_signing).toBe(false);
  });

  test("a ClaimReceipt on chain marks the leaf claimed and moves it out of payable", async () => {
    const reg = await new ChainReader(new Rpc(transport())).registryConfig();
    let receiptFor: string | null = null;
    const extra = (method: string, params: unknown[]) => {
      if (method !== "getMultipleAccounts" || !receiptFor) return undefined;
      const keys = params[0] as string[];
      if (!keys.includes(receiptFor)) return undefined;
      const data = new Writer().bytes(accountDisc("ClaimReceipt")).u64(0).fixed32("00".repeat(32)).address(VERIFIER).address(VERIFIER).u64(2000).i64(0).u8(255).done();
      return { value: keys.map((k) => (k === receiptFor ? { lamports: 1, owner: SETTINGS.registry_program, executable: false, data: [Buffer.from(data).toString("base64"), "base64"] } : null)) };
    };
    const { core, bridge } = await setup({ coreKey: reg!.coreAuthority, send: async () => ({ signature: "s" }), extra });
    await bridge.tick();
    core.tx(() => (core as any).addUnits(VERIFIER, "replay", "r1", 2, 2_000n));
    const ep = core.closeEpoch();
    await bridge.tick();
    const leaf = (ep.payouts as { leaf: string }[])[0]!.leaf;
    receiptFor = registryPdas.claimReceipt(ep.n, hexToBytes(leaf));
    await bridge.tick();
    expect(core.proofs(ep.n, VERIFIER)[0]!.claimed).toBe(true);
    expect(core.ledger.balance(`epoch:${ep.n}:payable`)).toBe(0n);
    expect(core.ledger.balance(`agent:${VERIFIER}:wallet`)).toBe(2000n);
    expect(core.ledger.reconcile().ok).toBe(true);
  });
});
