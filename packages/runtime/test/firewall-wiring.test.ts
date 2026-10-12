// The firewall as the hosted runtime wires it (docs/plans/AGENT-WALLET-SAFETY.md 3.1): every key the
// runtime's store hands out is guarded; with the runtime's firewall installed every swap is refused
// before anything is signed or sent (agents do not trade, owner decision 2026-10-12), a post and the
// bind are signed, and nothing else is; and a tripwire lists every file that can make a signature.
import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { base58Decode, base58Encode, generateAgentKey } from "@units/protocol";
import {
  ata, authorizeSigners, compileMessage, FirewallRefusal, isGuarded, msg, pump, pumpAmm, pumpPdas, registry,
  resetGuardForTest, Rpc, sendAndConfirm, system, toAddress, token, TOKEN_2022_PROGRAM, type Address, type Ix,
} from "@units/chain";
import { cosign } from "../../chain/src/cosign.ts";
import { parseWire, unsignedWire } from "../../chain/src/browser/wire.ts";
import { installAgentFirewall } from "../src/firewall.ts";
import { StateStore } from "../src/state.ts";

const T22 = TOKEN_2022_PROGRAM;
const ROOT = join(import.meta.dir, "../../..");
const addr = (n: number): Address => toAddress(Uint8Array.from({ length: 32 }, (_, i) => (n * 41 + i * 3 + 9) & 0xff));
const BH = addr(250);
const line = addr(10), a1 = addr(11), a2 = addr(12);
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const verifies = (signer: Address, message: Uint8Array, sig: Uint8Array) => verify(null, message, createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(base58Decode(signer))]), format: "der", type: "spki" }), sig);

/** A chain that accepts whatever is sent, recording it. */
function chain() {
  const wires: Uint8Array[] = [];
  const calls: string[] = [];
  const rpc = new Rpc(async (method, params) => {
    calls.push(method);
    switch (method) {
      case "getAccountInfo": return { value: null };
      case "getMultipleAccounts": return { value: (params[0] as string[]).map(() => null) };
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
  return { rpc, wires, calls };
}

const AGENT = generateAgentKey().id;

function runtime() {
  const dir = mkdtempSync(join(tmpdir(), "fw-wiring-"));
  const store = new StateStore(dir, { mode: "devnet", runtime: addr(90), now: 0 });
  const key = store.keyFor(AGENT);
  const { rpc, wires, calls } = chain();
  const logs: string[] = [];
  const fw = installAgentFirewall({ rpc, stateDir: dir, view: { agents: () => ({ [AGENT]: { key_id: key.id } }) }, log: (m) => logs.push(m) });
  return { dir, store, key, rpc, wires, calls, fw, logs };
}

/** The swaps the removed trading engine sent, built for `user`. */
function swaps(user: Address): [string, Ix[]][] {
  const b = (mint: Address) => ({ mint, quoteMint: line, quoteTokenProgram: T22, user });
  const pre = (mint: Address) => [token.createAtaIdempotent(user, user, line, T22), token.createAtaIdempotent(user, user, mint, T22)];
  return [
    ["curve buy", [...pre(a1), pump.buyExactQuoteInV3({ ...b(a1), spendableQuoteIn: 5_000_000n, minTokensOut: 1n })]],
    ["curve sell", [pump.sellV3({ ...b(a1), amount: 1_000_000n, minQuoteOut: 1n })]],
    ["pool buy", [...pre(a2), pumpAmm.buyExactQuoteInV2({ ...b(a2), pool: pumpPdas.pool(a2, line), spendableQuoteIn: 5_000_000n, minBaseOut: 1n })]],
    ["pool sell", [pumpAmm.sellV2({ ...b(a2), pool: pumpPdas.pool(a2, line), baseIn: 1_000_000n, minQuoteOut: 1n })]],
  ];
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
  test("every swap is refused before anything is signed or sent, whether the agent key or the runtime pays", async () => {
    const w = runtime();
    const payer = generateAgentKey();
    for (const [name, ixs] of swaps(w.key.id)) {
      await expect(sendAndConfirm(w.rpc, w.key, ixs).then(() => name)).rejects.toMatchObject({ rule: "swap_not_allowed" });
      await expect(sendAndConfirm(w.rpc, payer, ixs, { signers: [w.key] }).then(() => name)).rejects.toMatchObject({ rule: "swap_not_allowed" });
    }
    expect(w.wires.length).toBe(0);
    expect(w.calls.filter((c) => c === "sendTransaction" || c === "simulateTransaction")).toEqual([]);
    expect(w.fw.counts).toEqual({ swap_not_allowed: 8 });
    expect(w.logs.some((l) => l.includes("every swap is refused (agents do not trade)"))).toBe(true);
    expect(w.logs.filter((l) => l.includes("REFUSED") && l.includes("swap_not_allowed")).length).toBe(8);
    const rows = readFileSync(join(w.dir, "firewall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.ok, x.rule, x.agent])).toEqual(Array.from({ length: 8 }, () => [false, "swap_not_allowed", AGENT]));
  }, 20_000);

  test("a board post goes out; the same post with a transfer next to it, or with the agent key paying, does not", async () => {
    const w = runtime();
    const payer = generateAgentKey();
    const post = msg.postBoard({ payer: payer.id, signer: w.key.id, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new TextEncoder().encode("accepted: encode_ir 12% better") } } });
    const r = await sendAndConfirm(w.rpc, payer, [post], { signers: [w.key], computeUnits: 60_000 });
    expect(r.signature.length).toBeGreaterThan(40);
    const p = parseWire(w.wires[0]!);
    expect(verifies(w.key.id, p.message, p.signatures[1]!)).toBe(true);
    await expect(sendAndConfirm(w.rpc, payer, [post, system.transfer(payer.id, addr(66), 1n)], { signers: [w.key] })).rejects.toMatchObject({ rule: "program_not_allowed" });
    await expect(sendAndConfirm(w.rpc, w.key, [msg.postBoard({ payer: w.key.id, signer: w.key.id, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new Uint8Array(1) } } })])).rejects.toMatchObject({ rule: "key_pays" });
    expect(w.wires.length).toBe(1);
  }, 20_000);

  test("a transfer, a token approval and a transfer of its launch holding are refused", async () => {
    const on = runtime();
    for (const ixs of [
      [system.transfer(on.key.id, addr(66), 1_000_000n)],
      [{ programId: T22, keys: [{ pubkey: ata(on.key.id, line, T22), isSigner: false, isWritable: true }, { pubkey: addr(66), isSigner: false, isWritable: false }, { pubkey: on.key.id, isSigner: true, isWritable: false }], data: Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 0, 0) }],
      [token.transferChecked(ata(on.key.id, addr(70), T22), addr(70), ata(addr(66), addr(70), T22), on.key.id, 1n, 6, T22)],
    ]) await expect(sendAndConfirm(on.rpc, on.key, ixs)).rejects.toBeInstanceOf(FirewallRefusal);
    expect(on.wires.length).toBe(0);
    expect(on.logs.some((l) => l.includes("REFUSED") && l.includes("program_not_allowed"))).toBe(true);
  });

  test("the bind: the key co-signs a rotation of its own agent's record to itself, and no other", async () => {
    const w = runtime();
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
    // reviewed callers; a new one fails here until someone has checked which key it signs with
    const reviewed = [
      "packages/chain/src/cosign.ts", // co-signs after authorizeSigners
      "packages/chain/src/tx.ts", // signMessageWith
      "packages/core/src/fee-claims.ts", // Core's claim attestor key signs a claim attestation; Core holds no agent key
    ];
    expect(callers.filter((c) => !reviewed.includes(c))).toEqual([]);
    expect(callers).toEqual(expect.arrayContaining(["packages/chain/src/cosign.ts", "packages/chain/src/tx.ts"]));
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

  test("no trading engine: the package is gone and nothing in the runtime or the worker builds a swap", () => {
    expect(readdirSync(join(ROOT, "packages"))).not.toContain("trader");
    const SWAP = /\bpump(Amm)?\.(buy|sell)\w*\(|multiHopSwap\(|planSwap\w*\(|from "[^"]*\/trader\//;
    const hits = files.filter((f) => /^packages\/(runtime|worker|core|identity|souls|desktop|mirror|sandbox)\//.test(rel(f)) && SWAP.test(src(f))).map(rel);
    expect(hits).toEqual([]);
  });
});
