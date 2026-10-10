// Prepaid credits at launch (plan C): v0 messages with a lookup table (byte layout checked by hand
// here and end to end by devnet in scripts/prepay/launch-e2e.ts), the browser decoder on v0, the
// deposit math, and the launch transaction plan.
import { describe, expect, test } from "bun:test";
import { generateAgentKey } from "@lineage/protocol";
import * as c from "../src/index.ts";
import { decodeMessage, missingSigners, placeSignature, unsignedWire } from "../src/browser/wire.ts";
import { inspectForCosign } from "../src/cosign.ts";

const k = () => generateAgentKey().id;
const LINE = "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU";
const BH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const T22 = c.TOKEN_2022_PROGRAM;

function launchIxs(o: { strings?: number; soul?: boolean } = {}) {
  const launcher = k(), agent = k(), mint = k();
  const base = { name: "TEST minbpe speedups", symbol: "TMBPE", uri: "https://lineage.invalid/devnet/agents/tmbpe.json?class=python", repoUrl: "https://github.com/karpathy/minbpe" };
  const used = base.name.length + base.symbol.length + base.uri.length + base.repoUrl.length;
  const pad = Math.max(0, (o.strings ?? used) - used), toUri = Math.min(pad, 200 - base.uri.length);
  const uri = base.uri + "x".repeat(toUri), repoUrl = base.repoUrl + "x".repeat(pad - toUri);
  const main = c.pumpLaunchMain({ launcher, agent, agentMint: mint, line: { mint: LINE, tokenProgram: T22 }, name: base.name, symbol: base.symbol, uri,
    args: { repoUrl, identityMode: 2, hosted: true } });
  const rest = c.launch.prepay({ launcher, agent, agentMint: mint, lineMint: LINE, amount: 200_000_000n, decimals: 6, lineTokenProgram: T22 });
  const soul = o.soul ? c.registry.setProfile({ signingKey: agent, agent, digest: new Uint8Array(32).fill(7), seq: 1 }) : null;
  return { launcher, agent, mint, main, rest, soul };
}
const budget = [c.computeBudget.limit(450_000), c.computeBudget.price(1)];
const table = (addresses = c.launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22 })) => ({ address: k(), addresses });

describe("v0 messages", () => {
  test("compileMessageV0: version prefix, static signers and programs, table indexes", () => {
    const l = launchIxs({ soul: true });
    const t = table();
    const ixs = [...budget, ...l.main, ...l.rest, l.soul!];
    const m = c.compileMessageV0(l.launcher, ixs, BH, [t]);
    expect(m.bytes[0]).toBe(0x80);
    expect(m.keys.slice(0, m.numSigners).sort()).toEqual([l.launcher, l.agent, l.mint].sort());
    expect(m.keys[0]).toBe(l.launcher);
    // invoked programs stay static even though the table holds the registry program and Token-2022
    for (const p of [c.REGISTRY_PROGRAM_ID, T22, c.LAUNCH_PROGRAM_ID, c.COMPUTE_BUDGET_PROGRAM, c.PUMP.program]) expect(m.keys).toContain(p);
    expect(m.loaded.readonly).toContain(c.PUMP.global);
    expect(m.loaded.readonly).not.toContain(T22);
    for (const a of [...m.loaded.writable, ...m.loaded.readonly]) expect(m.keys).not.toContain(a);
    // the message ends with one table lookup: its address, then the writable and read-only indexes
    const tail = m.bytes.subarray(m.bytes.length - (1 + 32 + 1 + m.loaded.writable.length + 1 + m.loaded.readonly.length));
    expect(tail[0]).toBe(1);
    expect(c.toAddress(tail.subarray(1, 33))).toBe(t.address);
    expect(tail[33]).toBe(m.loaded.writable.length);
    expect([...tail.subarray(34, 34 + m.loaded.writable.length)].map((i) => t.addresses[i])).toEqual(m.loaded.writable);
    expect([...tail.subarray(35 + m.loaded.writable.length)].map((i) => t.addresses[i])).toEqual(m.loaded.readonly);
  });

  test("the browser decoder reads a v0 message back, resolving the table", () => {
    const l = launchIxs();
    const t = table();
    const ixs = [...budget, ...l.main, ...l.rest];
    const m = c.compileMessageV0(l.launcher, ixs, BH, [t]);
    const d = decodeMessage(m.bytes, new Map([[t.address, t.addresses]]));
    expect(d.version).toBe(0);
    expect(d.blockhash).toBe(BH);
    expect(d.lookups.length).toBe(1);
    d.instructions.forEach((ix, i) => {
      expect(ix.programId).toBe(ixs[i]!.programId);
      ix.accounts.forEach((a, j) => {
        expect(a.pubkey).toBe(ixs[i]!.keys[j]!.pubkey);
        if (ixs[i]!.keys[j]!.isWritable) expect(a.isWritable).toBe(true);
        if (ixs[i]!.keys[j]!.isSigner) expect(a.isSigner).toBe(true);
      });
    });
    // without the table the loaded accounts are marked, never guessed
    expect(decodeMessage(m.bytes).keys.some((x) => x.startsWith(`${t.address}#`))).toBe(true);
  });

  test("signatures land in the static signer slots of a v0 wire; co-sign refuses v0", () => {
    const payer = generateAgentKey(), agent = generateAgentKey();
    const ix = c.registry.setProfile({ signingKey: agent.id, agent: agent.id, digest: new Uint8Array(32), seq: 1 });
    const m = c.compileMessageV0(payer.id, [ix], BH, [{ address: k(), addresses: [c.registryPdas.config(), c.registryPdas.agent(agent.id)] }]);
    let wire = unsignedWire(m);
    expect(missingSigners(wire).sort()).toEqual([payer.id, agent.id].sort());
    wire = placeSignature(wire, payer.id, c.signBytes(payer, m.bytes));
    expect(missingSigners(wire)).toEqual([agent.id]);
    expect(() => inspectForCosign(wire, agent.id)).toThrow(/v0/);
    wire = placeSignature(wire, agent.id, c.signBytes(agent, m.bytes));
    expect(missingSigners(wire)).toEqual([]);
  });

  test("decodeLookupTable reads the on-chain layout", () => {
    const addrs = [k(), k()];
    const d = new Uint8Array(56 + 64);
    const dv = new DataView(d.buffer);
    dv.setUint32(0, 1, true);
    dv.setBigUint64(4, 2n ** 64n - 1n, true);
    dv.setBigUint64(12, 99n, true);
    d.set(c.addressBytes(addrs[0]!), 56);
    d.set(c.addressBytes(addrs[1]!), 88);
    expect(c.decodeLookupTable(d)).toEqual({ addresses: addrs, authority: null, deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 99n });
    const auth = k();
    d[21] = 1;
    d.set(c.addressBytes(auth), 22);
    expect(c.decodeLookupTable(d).authority).toBe(auth);
  });
});

describe("deposit math", () => {
  const cfg = c.parsePrepayConfig({ min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "test", compute_price_line_per_usd: "20",
    compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0 });
  test("USD to base units rounds up; back to cents rounds down", () => {
    expect(c.usdToBase("10", "20", 6)).toBe(200_000_000n);
    expect(c.usdToBase("10.01", "20", 6)).toBe(200_200_000n);
    expect(c.usdToBase("1", "0.3", 6)).toBe(300_000n);
    expect(c.usdToBase("1", "3", 0)).toBe(3n);
    expect(c.usdToBase("0.5", "3", 0)).toBe(2n); // 1.5 rounds up
    expect(c.baseToUsdCents(200_000_000n, "20", 6)).toBe(1000n);
    expect(c.baseToUsdCents(199_999_999n, "20", 6)).toBe(999n);
    expect(c.cmpDec("10.0", "10")).toBe(0);
    expect(c.cmpDec("9.99", "10")).toBe(-1);
  });
  test("first-run budget from the runtime's published prices", () => {
    // 200 tLINE - 600 s x 0.002 = 198.8 tLINE, at 20 per USD = 9.94 USD, 19 attempts at 0.5
    expect(c.firstRunBudget(cfg, 200_000_000n, 6)).toEqual({ usd: 9.94, attempts: 19 });
    expect(c.firstRunBudget(cfg, 1_000_000n, 6)).toEqual({ usd: 0, attempts: 0 });
  });
  test("config validation", () => {
    expect(() => c.parsePrepayConfig({ ...cfg, default_usd: "5" })).toThrow(/below min_usd/);
    expect(() => c.parsePrepayConfig({ ...cfg, line_per_usd: "0" })).toThrow(/positive/);
    expect(() => c.parsePrepayConfig({ ...cfg, rate_status: "maybe" })).toThrow(/rate_status/);
    expect(() => c.parsePrepayConfig({ ...cfg, min_usd: 10 })).toThrow(/min_usd/);
  });
});

describe("launch transaction plan (pump.fun: create_v2 + register_pump_launch, then deposit + wake)", () => {
  test("typical launch, deposit and wake without a soul: one v0 transaction (legacy is over the packet)", () => {
    const l = launchIxs();
    const p = c.planLaunch({ payer: l.launcher, main: l.main, rest: l.rest, soul: null, budget, table: table(), v0: true });
    expect(p.mode).toBe("v0");
    expect(p.txs[0]!.ixs).toEqual([...l.main, ...l.rest]);
    expect(p.txs[0]!.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
  });
  test("with a soul: still one v0 transaction for typical strings", () => {
    const l = launchIxs({ soul: true });
    const p = c.planLaunch({ payer: l.launcher, main: l.main, rest: l.rest, soul: l.soul, budget, table: table(), v0: true });
    expect(p.mode).toBe("v0");
    expect(p.txs.length).toBe(1);
    expect(p.txs[0]!.ixs.length).toBe(5);
  });
  test("MAX_LAUNCH_STRINGS: create_v2 + register_pump_launch alone fit one v0 transaction at the cap, not one byte over", () => {
    const at = launchIxs({ strings: c.MAX_LAUNCH_STRINGS });
    expect(c.planLaunch({ payer: at.launcher, main: at.main, soul: null, budget, table: table(), v0: true }).txs[0]!.size).toBe(c.PACKET_LIMIT);
    const over = launchIxs({ strings: c.MAX_LAUNCH_STRINGS + 1 });
    expect(() => c.planLaunch({ payer: over.launcher, main: over.main, soul: null, budget, table: table(), v0: true })).toThrow(/packet limit/);
  });
  test("the longest strings with a soul: two transactions, the launch first, deposit + wake + soul second", () => {
    const l = launchIxs({ strings: c.MAX_LAUNCH_STRINGS, soul: true });
    const p = c.planLaunch({ payer: l.launcher, main: l.main, rest: l.rest, soul: l.soul, budget, table: table(), v0: true });
    expect(p.mode).toBe("split");
    expect(p.txs[0]!.ixs).toEqual(l.main);
    expect(p.txs[1]!.ixs).toEqual([...l.rest, l.soul!]);
  });
  test("a wallet without v0 cannot launch on pump.fun: a clear error", () => {
    const l = launchIxs({ soul: true });
    expect(() => c.planLaunch({ payer: l.launcher, main: l.main, rest: l.rest, soul: l.soul, budget, table: table(), v0: false })).toThrow(/over the 1232-byte.*no v0/);
  });
  test("deposit instructions: transferChecked from the launcher's account into the compute vault, then refresh_awake", () => {
    const l = launchIxs();
    const [t, r] = l.rest;
    expect(t!.programId).toBe(T22);
    expect(t!.keys[0]!.pubkey).toBe(c.ata(l.launcher, LINE, T22));
    expect(t!.keys[2]!.pubkey).toBe(c.launchPdas.computeVault(l.agent));
    expect(t!.keys[3]).toEqual({ pubkey: l.launcher, isSigner: true, isWritable: false });
    expect(r!.programId).toBe(c.LAUNCH_PROGRAM_ID);
    expect(r!.keys.map((x) => x.pubkey)).toEqual([c.launchPdas.config(), c.launchPdas.agentLaunch(l.mint), c.launchPdas.computeVault(l.agent)]);
  });
});
