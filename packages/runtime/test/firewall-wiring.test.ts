// The firewall as the hosted runtime wires it (docs/plans/AGENT-WALLET-SAFETY.md 3.1): every key the
// runtime's store hands out is guarded; with the runtime's firewall installed, the chain venue's real
// buy and sell are signed and sent, a post is signed with trading off, and nothing else is; the
// limits come from Core's trading config; and a tripwire lists every file that can make a signature.
import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { base58Decode, base58Encode, generateAgentKey } from "@units/protocol";
import {
  accountDisc, ata, authorizeSigners, compileMessage, decodeBondingCurve, FirewallRefusal, isGuarded, LAUNCH_PROGRAM_ID, launchPdas, msg, parseMessageStrict, PUMP, pumpPdas, registry,
  resetGuardForTest, Rpc, sendAndConfirm, system, toAddress, TOKEN_2022_PROGRAM, Writer, type Address, type FirewallLimits,
} from "@units/chain";
import { cosign } from "../../chain/src/cosign.ts";
import { parseWire, unsignedWire } from "../../chain/src/browser/wire.ts";
import { mergeTradingConfig, TRADING_DEFAULTS } from "../../core/src/scores.ts";
import { ChainVenue } from "../../trader/src/chain-venue.ts";
import type { TokenView } from "../../trader/src/policy.ts";
import { coreLimits, installAgentFirewall, limitsOf } from "../src/firewall.ts";
import { StateStore } from "../src/state.ts";

const T22 = TOKEN_2022_PROGRAM;
const ROOT = join(import.meta.dir, "../../..");
const fx = JSON.parse(readFileSync(join(ROOT, "packages/chain/test/fixtures/pump-fork.json"), "utf8"));
const { line, a1, a2 } = fx.mints as { line: string; a1: string; a2: string };
const addr = (n: number): Address => toAddress(Uint8Array.from({ length: 32 }, (_, i) => (n * 41 + i * 3 + 9) & 0xff));
const BH = addr(250);
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const verifies = (signer: Address, message: Uint8Array, sig: Uint8Array) => verify(null, message, createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(base58Decode(signer))]), format: "der", type: "spki" }), sig);

function launchConfigBytes(): Uint8Array {
  const wr = new Writer().bytes(accountDisc("LaunchConfig"));
  for (const a of [addr(1), addr(2), LAUNCH_PROGRAM_ID, line, T22, addr(3), PUMP.program]) wr.address(a);
  wr.u16(7000).u16(3000).u64(1n).u64(2n).u64(0n).u128(0n).bool(false).u8(255).u8(255);
  for (let i = 0; i < 5; i++) wr.u64(0n);
  return wr.done();
}
function agentLaunchBytes(mint: string, agent: Address, graduated: boolean): Uint8Array {
  const wr = new Writer().bytes(accountDisc("AgentLaunch")).address(agent).address(mint).address(addr(5)).bytes(new Uint8Array(32)).string("https://github.com/a/b")
    .u8(2).bool(true).address(PUMP.program).address(pumpPdas.bondingCurve(mint)).address(graduated ? pumpPdas.pool(mint, line) : addr(6)).address(addr(7)).address(addr(6)).bool(graduated).bool(true).i64(0n);
  for (let i = 0; i < 5; i++) wr.u64(0n);
  return wr.u8(255).u8(255).done();
}
function tokenAccountBytes(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(new Writer().address(mint).address(owner).u64(amount).done(), 0);
  return d;
}

/** A chain that answers reads from the fork fixture and accepts whatever is sent, recording it. */
function chain() {
  const m = new Map<string, { data: Uint8Array; owner: string }>();
  m.set(launchPdas.config(), { data: launchConfigBytes(), owner: LAUNCH_PROGRAM_ID });
  m.set(launchPdas.agentLaunch(a1), { data: agentLaunchBytes(a1, addr(60), false), owner: LAUNCH_PROGRAM_ID });
  m.set(launchPdas.agentLaunch(a2), { data: agentLaunchBytes(a2, addr(61), true), owner: LAUNCH_PROGRAM_ID });
  m.set(pumpPdas.bondingCurve(a1), { data: b64(fx.accounts.a1_curve), owner: PUMP.program });
  m.set(pumpPdas.bondingCurve(a2), { data: b64(fx.accounts.a2_curve), owner: PUMP.program });
  const pool = pumpPdas.pool(a2, line);
  m.set(pool, { data: b64(fx.accounts.a2_pool), owner: PUMP.amm });
  m.set(ata(pool, a2, T22), { data: tokenAccountBytes(a2, pool, 1_000_000_000_000n), owner: T22 });
  m.set(ata(pool, line, T22), { data: tokenAccountBytes(line, pool, 500_000_000_000n), owner: T22 });
  m.set(ata(PUMP.buybackRecipients[0], line, T22), { data: tokenAccountBytes(line, PUMP.buybackRecipients[0], 0n), owner: T22 });
  const wires: Uint8Array[] = [];
  const rawAcc = (a: string) => {
    const x = m.get(a);
    return x ? { data: [Buffer.from(x.data).toString("base64"), "base64"], owner: x.owner, lamports: 1, executable: false } : null;
  };
  const rpc = new Rpc(async (method, params) => {
    switch (method) {
      case "getAccountInfo": return { value: rawAcc(params[0] as string) };
      case "getMultipleAccounts": return { value: (params[0] as string[]).map(rawAcc) };
      case "getBalance": return { value: 1_000_000_000 };
      case "getLatestBlockhash": return { value: { blockhash: BH, lastValidBlockHeight: 100 } };
      case "simulateTransaction": return { value: { err: null, logs: [] } };
      case "sendTransaction": {
        const wire = Uint8Array.from(Buffer.from(params[0] as string, "base64"));
        wires.push(wire);
        return base58Encode(parseWire(wire).signatures[0]!);
      }
      case "getSignatureStatuses": return { value: (params[0] as string[]).map(() => ({ err: null, confirmationStatus: "confirmed", slot: 1 })) };
      case "getTransaction": return { meta: { err: null, fee: 5000, logMessages: [] }, slot: 1 };
      case "getBlockHeight": return 1;
      default: throw new Error(`unexpected ${method}`);
    }
  });
  return { rpc, wires };
}

const ON: FirewallLimits = { trading_enabled: true, max_tx_quote: 100_000_000n, max_day_quote: 1_000_000_000n, min_out_bps: 9000, max_fee_lamports: 1_000_000n };
const AGENT = generateAgentKey().id;
const tok = (mint: string, venue: TokenView["venue"]): TokenView => ({ mint, agent: addr(60), parties: [], price: 0.01, decimals: 6, change_24h: null, venue });

function runtime(limits: FirewallLimits | null) {
  const dir = mkdtempSync(join(tmpdir(), "fw-wiring-"));
  const store = new StateStore(dir, { mode: "devnet", runtime: addr(90), now: 0 });
  const key = store.keyFor(AGENT);
  const { rpc, wires } = chain();
  const logs: string[] = [];
  const fw = installAgentFirewall({ rpc, core: "http://127.0.0.1:1", stateDir: dir, view: { agents: () => ({ [AGENT]: { key_id: key.id, mint: addr(70) } }) }, log: (m) => logs.push(m), limits: async () => limits });
  return { dir, store, key, rpc, wires, fw, logs, venue: new ChainVenue(rpc) };
}

afterEach(() => resetGuardForTest());

describe("the runtime's keys are guarded", () => {
  test("a key made or loaded by the store is guarded at once; without a firewall it signs no transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-wiring-"));
    const store = new StateStore(dir, { mode: "sim", runtime: addr(90), now: 0 });
    const key = store.keyFor(AGENT);
    expect(isGuarded(key.id)).toBe(true);
    resetGuardForTest();
    expect(isGuarded(key.id)).toBe(false);
    expect(new StateStore(dir, { mode: "sim", runtime: addr(90), now: 0 }).keyFor(AGENT).id).toBe(key.id); // loaded from its file
    expect(isGuarded(key.id)).toBe(true);
    const { rpc, wires } = chain();
    await expect(sendAndConfirm(rpc, key, [system.transfer(key.id, addr(66), 1n)])).rejects.toMatchObject({ rule: "no_firewall" });
    expect(wires.length).toBe(0);
  });
});

describe("with the runtime's firewall installed", () => {
  test("the chain venue's buy on a curve and sell in a pool are signed by the treasury key and sent", async () => {
    const w = runtime(ON);
    const curve = decodeBondingCurve(b64(fx.accounts.a1_curve));
    const amount = 5_000_000n;
    const expected = (amount * curve.virtualTokenReserves) / curve.virtualQuoteReserves;
    const buy = await w.venue.execute(w.key, tok(a1, "pump_curve"), "buy", amount, (expected * 95n) / 100n);
    expect(buy.venue).toBe("pump_curve");
    // the pool's spot as the firewall reads it (vaults plus the pool's virtual quote reserve)
    const pool = (await w.fw.context(w.key.id, compileMessage(w.key.id, (await (w.venue as unknown as { ixs(o: string, m: string, b: boolean, i: bigint, x: bigint): Promise<Parameters<typeof compileMessage>[1]> }).ixs(w.key.id, a2, false, 1n, 1n)), BH).bytes)).mints.get(a2)!.pool!;
    const sell = await w.venue.execute(w.key, tok(a2, "pump_pool"), "sell", 1_000_000n, (((1_000_000n * pool.quote) / pool.base) * 95n) / 100n);
    expect(sell.venue).toBe("pump_pool");
    expect(w.wires.length).toBe(2);
    for (const wire of w.wires) {
      const p = parseWire(wire);
      expect(p.signatures.length).toBe(1);
      expect(verifies(w.key.id, p.message, p.signatures[0]!)).toBe(true);
      const m = parseMessageStrict(p.message);
      expect(m.keys[0]).toBe(w.key.id);
      expect(m.instructions.map((i) => i.programId).filter((x) => x !== "ComputeBudget111111111111111111111111111111" && x !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")).toEqual([m.instructions.at(-1)!.programId]);
    }
    expect(w.fw.counts.allowed).toBe(2);
    expect(w.fw.spentToday(w.key.id)).toBeGreaterThan(amount);
    const rows = readFileSync(join(w.dir, "firewall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.ok, x.kind, x.agent])).toEqual([[true, "swap", AGENT], [true, "swap", AGENT]]);
  }, 20_000);

  test("trading off in the config: the same buy is refused before anything is signed or sent; a board post still goes out", async () => {
    const w = runtime({ ...ON, trading_enabled: false });
    await expect(w.venue.execute(w.key, tok(a1, "pump_curve"), "buy", 5_000_000n, 1n)).rejects.toMatchObject({ rule: "trading_off" });
    expect(w.wires.length).toBe(0);
    const payer = generateAgentKey();
    const post = msg.postBoard({ payer: payer.id, signer: w.key.id, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new TextEncoder().encode("accepted: encode_ir 12% better") } } });
    const r = await sendAndConfirm(w.rpc, payer, [post], { signers: [w.key], computeUnits: 60_000 });
    expect(r.signature.length).toBeGreaterThan(40);
    const p = parseWire(w.wires[0]!);
    expect(verifies(w.key.id, p.message, p.signatures[1]!)).toBe(true);
    // the same post with a transfer next to it, and a post with the agent key paying: refused
    await expect(sendAndConfirm(w.rpc, payer, [post, system.transfer(payer.id, addr(66), 1n)], { signers: [w.key] })).rejects.toMatchObject({ rule: "program_not_allowed" });
    await expect(sendAndConfirm(w.rpc, w.key, [msg.postBoard({ payer: w.key.id, signer: w.key.id, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new Uint8Array(1) } } })])).rejects.toMatchObject({ rule: "key_pays" });
    expect(w.wires.length).toBe(1);
  }, 20_000);

  test("limits Core cannot serve: no swap; a transfer, an approval and a withdrawal are refused whatever the limits", async () => {
    const w = runtime(null);
    await expect(w.venue.execute(w.key, tok(a1, "pump_curve"), "buy", 5_000_000n, 1n)).rejects.toMatchObject({ rule: "no_limits" });
    const on = runtime(ON);
    for (const ixs of [
      [system.transfer(on.key.id, addr(66), 1_000_000n)],
      [{ programId: T22, keys: [{ pubkey: ata(on.key.id, line, T22), isSigner: false, isWritable: true }, { pubkey: addr(66), isSigner: false, isWritable: false }, { pubkey: on.key.id, isSigner: true, isWritable: false }], data: Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 0, 0) }],
    ]) await expect(sendAndConfirm(on.rpc, on.key, ixs)).rejects.toBeInstanceOf(FirewallRefusal);
    expect(on.wires.length).toBe(0);
    expect(on.logs.some((l) => l.includes("REFUSED") && l.includes("program_not_allowed"))).toBe(true);
  });

  test("the bind: the key co-signs a rotation of its own agent's record to itself, and no other", async () => {
    const w = runtime(null);
    const owner = generateAgentKey();
    const own = unsignedWire(compileMessage(owner.id, [registry.rotateAgentKey({ owner: owner.id, agent: AGENT, newKey: w.key.id })], BH));
    await authorizeSigners(parseWire(own).message, [w.key.id]);
    const signed = parseWire(cosign(own, w.key));
    expect(verifies(w.key.id, signed.message, signed.signatures[1]!)).toBe(true);
    const other = unsignedWire(compileMessage(owner.id, [registry.rotateAgentKey({ owner: owner.id, agent: addr(77), newKey: w.key.id })], BH));
    await expect(authorizeSigners(parseWire(other).message, [w.key.id])).rejects.toMatchObject({ rule: "registry_accounts" });
    expect(() => cosign(other, w.key)).toThrow(FirewallRefusal);
  });
});

describe("limits from Core's trading config", () => {
  test("the defaults map to limits; a config without the fields, or with bad ones, gives none", () => {
    const cfg = mergeTradingConfig(TRADING_DEFAULTS, { enabled: false });
    expect(limitsOf(cfg)).toEqual({ trading_enabled: false, max_tx_quote: 100_000_000n, max_day_quote: 1_000_000_000n, min_out_bps: 9000, max_fee_lamports: 1_000_000n });
    const { firewall_max_tx_line: _drop, ...old } = cfg;
    expect(limitsOf(old)).toBeNull();
    expect(limitsOf({ ...cfg, firewall_min_out_bps: 10_001 })).toBeNull();
    expect(limitsOf({ ...cfg, firewall_max_day_line: "-1" })).toBeNull();
    expect(limitsOf(null)).toBeNull();
    // admin edits go through the same bounds as every other limit
    expect(mergeTradingConfig(cfg, { firewall_max_tx_line: "5", firewall_min_out_bps: 9500 }).firewall_max_tx_line).toBe("5");
    expect(() => mergeTradingConfig(cfg, { firewall_min_out_bps: 10_001 })).toThrow();
    expect(() => mergeTradingConfig(cfg, { firewall_max_day_line: 5 })).toThrow();
  });
  test("a failed read is null and is not cached; a good read is cached", async () => {
    let n = 0, ok = false;
    const f = (async () => (n++, ok ? Response.json(mergeTradingConfig(TRADING_DEFAULTS, {})) : new Response("no", { status: 503 }))) as unknown as typeof fetch;
    const read = coreLimits("http://core", { fetch: f });
    expect(await read()).toBeNull();
    ok = true;
    expect((await read())?.trading_enabled).toBe(true);
    await read();
    expect(n).toBe(2);
  });
});

describe("tripwire: where signatures can be made", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e === "test" || e === "dist" || e.startsWith(".")) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(e) && !/\.test\.ts$/.test(e)) files.push(p);
    }
  };
  for (const pkg of readdirSync(join(ROOT, "packages"))) walk(join(ROOT, "packages", pkg));
  const src = (f: string) => readFileSync(f, "utf8");
  const rel = (f: string) => relative(ROOT, f);

  test("only two files hold an ed25519 private-key signing primitive: transactions (guarded) and statements (hex digests)", () => {
    const PRIMITIVE = /createPrivateKey\(|\bedSign\(|\bsign\(null\b|subtle\.sign\(|nacl\.sign|from "tweetnacl|from "@noble\/|from "@solana\/web3\.js/;
    const hits = files.filter((f) => PRIMITIVE.test(src(f))).map(rel).sort();
    expect(hits).toEqual([
      "packages/chain/src/browser/wire.ts", // WebCrypto keys made in a launcher's own tab (never a runtime key)
      "packages/chain/src/tx.ts", // signBytes: transactions, through the guard
      "packages/core/src/seal.ts", // X25519 message sealing, not a signature
      "packages/protocol/src/auth.ts", // signMessage: requests and statement digests, never transaction bytes
    ]);
  });

  test("signBytes consults the guard before it signs, and only the sender paths call it", () => {
    const tx = src(join(ROOT, "packages/chain/src/tx.ts"));
    const body = /export function signBytes\(key: Signer, message: Uint8Array\): Uint8Array \{\n([\s\S]*?)\n\}/.exec(tx)![1]!;
    expect(body.trim().split("\n")[0]!.trim()).toBe("consumeTicket(key.id, message);");
    const callers = files.filter((f) => /\bsignBytes\(/.test(src(f))).map(rel).sort();
    expect(callers).toEqual(["packages/chain/src/cosign.ts", "packages/chain/src/tx.ts"]);
    // both senders ask the firewall before they sign
    expect(src(join(ROOT, "packages/chain/src/sender.ts"))).toMatch(/await authorizeSigners\([\s\S]{0,200}\n\s*const tx = buildTransaction\(/);
    expect(src(join(ROOT, "packages/chain/src/cosign.ts"))).toMatch(/await authorizeSigners\([\s\S]{0,120}\n\s*const signed = cosign\(/);
  });

  test("the guard has no way to release a key outside tests", () => {
    const g = src(join(ROOT, "packages/chain/src/guard.ts"));
    expect(g).not.toMatch(/guarded\.delete\(/);
    expect((g.match(/guarded\.clear\(/g) ?? []).length).toBe(1);
    const users = files.filter((f) => /resetGuardForTest\(/.test(src(f))).map(rel);
    expect(users).toEqual(["packages/chain/src/guard.ts"]);
  });
});
