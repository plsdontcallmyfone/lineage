// The transaction firewall (docs/plans/AGENT-WALLET-SAFETY.md section 3): the policy rule by rule, the
// strict parser, the signing guard, the chain-backed firewall, and property tests that fuzz
// instruction lists. Agents do not trade (owner decision 2026-10-12): every swap is refused, in every
// shape the earlier policy allowed and in every shape it did not.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import {
  AgentFirewall, ALT_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, ata, authorizeSigners, buildTransaction, compileMessage, compileMessageV0, computeBudget, evaluate,
  FirewallRefusal, guardKey, installAuthorizer, ixDisc, launch, LAUNCH_PROGRAM_ID, msg, msgPdas, parseMessageStrict, pump, PUMP, pumpAmm, pumpPdas, registry, registryPdas,
  resetGuardForTest, Rpc, signBytes, system, SYSTEM_PROGRAM, toAddress, token, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, Writer,
  type Address, type FirewallContext, type Ix,
} from "../src/index.ts";
import { r, w } from "../src/registry.ts";

const T22 = TOKEN_2022_PROGRAM;
const addr = (n: number, salt = 0): Address => toAddress(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7 + salt * 13 + 1) & 0xff));
const BH = addr(250);
const KEY = addr(1);
const AGENT = addr(2);
const OWN = addr(3);
const QUOTE = addr(4);
const A = addr(5); // another agent's token, on its curve
const B = addr(6); // another agent's token, migrated to its pool
const ATTACKER = addr(66);
const RUNTIME = addr(7);
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const COMPUTE = "ComputeBudget111111111111111111111111111111";

function ctx(o: Partial<FirewallContext> = {}): FirewallContext {
  return { key: KEY, agent: AGENT, tables: new Map(), ...o };
}
const base = (mint: Address, user = KEY) => ({ mint, quoteMint: QUOTE, quoteTokenProgram: T22, user });
const pre = (mint: Address, user = KEY) => [token.createAtaIdempotent(user, user, QUOTE, T22), token.createAtaIdempotent(user, user, mint, T22), token.createAtaIdempotent(user, PUMP.buybackRecipients[0], QUOTE, T22)];
// the four swaps the removed trading engine built, exactly as the earlier policy allowed them
const curveBuy = (mint = A, inQ = 10_000_000n, minOut = 4_800_000n) => pump.buyExactQuoteInV3({ ...base(mint), spendableQuoteIn: inQ, minTokensOut: minOut });
const curveSell = (mint = A, amt = 1_000_000n, minOut = 1_900_000n) => pump.sellV3({ ...base(mint), amount: amt, minQuoteOut: minOut });
const poolBuy = (mint = B, inQ = 8_000_000n, minOut = 1_900_000n) => pumpAmm.buyExactQuoteInV2({ ...base(mint), pool: pumpPdas.pool(mint, QUOTE), spendableQuoteIn: inQ, minBaseOut: minOut });
const poolSell = (mint = B, amt = 1_000_000n, minOut = 3_800_000n) => pumpAmm.sellV2({ ...base(mint), pool: pumpPdas.pool(mint, QUOTE), baseIn: amt, minQuoteOut: minOut });
const SWAPS = [curveBuy, curveSell, poolBuy, poolSell] as const;
const post = (agent: Address = AGENT, payer: Address = RUNTIME, signer: Address = KEY) => msg.postBoard({ payer, signer, agent, args: { lineage: "ab".repeat(32), body: { inline: new TextEncoder().encode("hello") } } });
const msgOf = (ixs: Ix[], payer = KEY) => compileMessage(payer, ixs, BH).bytes;
const verdict = (ixs: Ix[], c: Partial<FirewallContext> = {}, payer = KEY) => evaluate(msgOf(ixs, payer), ctx(c));
const rule = (ixs: Ix[], c: Partial<FirewallContext> = {}, payer = KEY) => {
  const v = verdict(ixs, c, payer);
  return v.ok ? "ALLOWED" : v.rule;
};
const raw = (programId: Address, keys: Ix["keys"], data: number[] | Uint8Array): Ix => ({ programId, keys, data: Uint8Array.from(data) });
const u64 = (n: bigint) => [...new Writer().u64(n).done()];

afterEach(() => resetGuardForTest());

describe("policy: what an agent key may sign", () => {
  test("its own posts, its bind and its profile: the key signs read-only and pays nothing", () => {
    expect(rule([computeBudget.limit(60_000), post()], {}, RUNTIME)).toBe("ALLOWED");
    expect(rule([msg.publishEncKey({ payer: RUNTIME, signer: KEY, agent: AGENT, encKey: addr(9) })], {}, RUNTIME)).toBe("ALLOWED");
    expect(rule([registry.rotateAgentKey({ owner: RUNTIME, agent: AGENT, newKey: KEY })], {}, RUNTIME)).toBe("ALLOWED");
    expect(rule([registry.setProfile({ signingKey: KEY, agent: AGENT, digest: "cd".repeat(32), seq: 2 })], {}, RUNTIME)).toBe("ALLOWED");
    const v = verdict([post()], {}, RUNTIME);
    expect(v.ok && v.kind).toBe("message");
  });
});

describe("policy: every swap is refused", () => {
  test("the four swaps the earlier policy allowed, alone, with token account creations, with a compute budget", () => {
    for (const make of SWAPS) {
      const mint = make === curveBuy || make === curveSell ? A : B;
      expect([make.name, rule([make()])]).toEqual([make.name, "swap_not_allowed"]);
      expect([make.name, rule([computeBudget.limit(300_000), ...pre(mint), make()])]).toEqual([make.name, "swap_not_allowed"]);
      expect([make.name, rule([computeBudget.limit(300_000), computeBudget.price(1), make()])]).toEqual([make.name, "swap_not_allowed"]);
    }
  });

  test("with any of pump.fun's eight buyback recipients", () => {
    for (let i = 0; i < 8; i++) expect(rule([pump.buyExactQuoteInV3({ ...base(A), buyback: i, spendableQuoteIn: 10_000_000n, minTokensOut: 4_800_000n })])).toBe("swap_not_allowed");
  });

  test("whoever pays, whatever the size, whatever the token (another agent's, its own, an unregistered one, one quoted in SOL)", () => {
    for (const make of SWAPS) expect(rule([make()], {}, RUNTIME)).toBe("swap_not_allowed");
    expect(rule([curveBuy(A, 1n, 1n)])).toBe("swap_not_allowed");
    expect(rule([curveSell(A, 1n, 1n)])).toBe("swap_not_allowed");
    expect(rule([curveBuy(OWN)])).toBe("swap_not_allowed");
    expect(rule([curveSell(OWN)])).toBe("swap_not_allowed");
    expect(rule([curveBuy(addr(40))])).toBe("swap_not_allowed");
    expect(rule([pump.buyExactQuoteInV3({ ...base(A), quoteMint: PUMP.wsol, spendableQuoteIn: 10_000_000n, minTokensOut: 4_800_000n })])).toBe("swap_not_allowed");
  });

  test("every other pump.fun and PumpSwap instruction, and Jupiter", () => {
    const cases: [string, Ix][] = [
      ["Pump buy_v3 (exact out)", pump.buyV3({ ...base(A), amount: 1n, maxQuoteIn: 10_000_000n })],
      ["Pump create_v2", pump.createV2({ mint: addr(41), user: KEY, creator: ATTACKER, name: "x", symbol: "x", uri: "x", quote: { kind: "sol" } })],
      ["Pump sweep_creator_fee", pump.sweepCreatorFee({ payer: KEY, mint: A, quoteMint: QUOTE, creator: ATTACKER, quoteTokenProgram: T22 })],
      ["Pump collect_creator_fee_v2", pump.collectCreatorFeeV2({ creator: ATTACKER, quoteMint: QUOTE, quoteTokenProgram: T22 })],
      ["PumpSwap buy_v2 (exact out)", pumpAmm.buyV2({ ...base(B), pool: pumpPdas.pool(B, QUOTE), baseOut: 1n, maxQuoteIn: 8_000_000n })],
      ["PumpSwap multi_hop_swap", pumpAmm.multiHopSwap({ user: KEY, userIn: ata(KEY, QUOTE, T22), userOut: ata(KEY, A, T22), hops: [{ kind: "curve", mint: A, quoteMint: QUOTE }], amountIn: 1n, minOut: 1n, buybackQuoteMint: QUOTE })],
      ["a Jupiter route", raw(JUPITER, [w(KEY, true), w(ata(KEY, QUOTE, T22)), w(ata(KEY, A, T22))], [1, 2, 3, 4, 5, 6, 7, 8])],
      ["an unknown Pump instruction", raw(PUMP.program, [w(KEY, true)], [9, 9, 9, 9, 9, 9, 9, 9])],
    ];
    for (const [name, ix] of cases) expect([name, rule([ix])]).toEqual([name, "swap_not_allowed"]);
  });

  test("a swap next to something the key may sign is still refused, as is a swap for an unknown key", () => {
    expect(rule([post(), curveBuy()], {}, RUNTIME)).toBe("swap_not_allowed");
    expect(rule([registry.setProfile({ signingKey: KEY, agent: AGENT, digest: "cd".repeat(32), seq: 2 }), poolSell()], {}, RUNTIME)).toBe("swap_not_allowed");
    expect(rule([curveBuy()], { agent: null })).toBe("swap_not_allowed");
    expect(rule([curveBuy(A, 10_000_000n, 4_800_000n)], { key: ATTACKER })).toBe("swap_not_allowed");
  });

  test("a swap whose accounts come from a lookup table: refused once resolved, refused while unresolved", () => {
    const table = { address: addr(120), addresses: [PUMP.global, PUMP.feeConfig, PUMP.eventAuthority, SYSTEM_PROGRAM, QUOTE] };
    for (const make of SWAPS) {
      const v0 = compileMessageV0(KEY, [make()], BH, [table]).bytes;
      expect(evaluate(v0, ctx())).toMatchObject({ ok: false, rule: "lookup_table" });
      expect(evaluate(v0, ctx({ tables: new Map([[table.address, table.addresses]]) }))).toMatchObject({ ok: false, rule: "swap_not_allowed" });
    }
  });

  test("every single-account mutation and every discriminator flip of those swaps is refused too", () => {
    const c = ctx();
    let n = 0;
    for (const make of SWAPS) {
      const ref = make();
      for (let i = 0; i < ref.keys.length; i++)
        for (const sub of [ATTACKER, ata(ATTACKER, QUOTE, T22), addr(200 + i)]) {
          const ix = make();
          if (ix.keys[i]!.pubkey === sub) continue;
          ix.keys[i] = { ...ix.keys[i]!, pubkey: sub };
          expect([make.name, i, evaluate(compileMessage(KEY, [ix], BH).bytes, c).ok]).toEqual([make.name, i, false]);
          n++;
        }
      for (let i = 0; i < 8; i++)
        for (const bit of [1, 16, 128]) {
          const ix = make();
          ix.data = Uint8Array.from(ix.data);
          ix.data[i]! ^= bit;
          expect(evaluate(compileMessage(KEY, [ix], BH).bytes, c)).toMatchObject({ ok: false, rule: "swap_not_allowed" });
        }
    }
    expect(n).toBeGreaterThan(190);
  });
});

describe("policy: what else it refuses", () => {
  const cases: [string, () => Ix[], string, Address?][] = [
    ["a System transfer to another wallet", () => [system.transfer(KEY, ATTACKER, 1_000_000n)], "program_not_allowed"],
    ["a System transfer next to a post", () => [post(), system.transfer(KEY, ATTACKER, 1n)], "program_not_allowed", RUNTIME],
    ["System create account", () => [system.createAccount(KEY, ATTACKER, 1n, 0, SYSTEM_PROGRAM)], "program_not_allowed"],
    ["System assign (hand the key's account to a program)", () => [raw(SYSTEM_PROGRAM, [w(KEY, true)], [1, 0, 0, 0, ...new Uint8Array(32)])], "program_not_allowed"],
    ["SPL transferChecked of $UNITS to another wallet", () => [token.transferChecked(ata(KEY, QUOTE, T22), QUOTE, ata(ATTACKER, QUOTE, T22), KEY, 5n, 6, T22)], "program_not_allowed"],
    ["SPL transferChecked of its own launch holding", () => [token.transferChecked(ata(KEY, OWN, T22), OWN, ata(ATTACKER, OWN, T22), KEY, 5n, 6, T22)], "program_not_allowed"],
    ["SPL transfer (legacy Token program)", () => [raw(TOKEN_PROGRAM, [w(ata(KEY, QUOTE)), w(ata(ATTACKER, QUOTE)), r(KEY, true)], [3, ...u64(5n)])], "program_not_allowed"],
    ["SPL approve (delegate the treasury's tokens)", () => [raw(T22, [w(ata(KEY, QUOTE, T22)), r(ATTACKER), r(KEY, true)], [4, ...u64(1n << 60n)])], "program_not_allowed"],
    ["SPL revoke", () => [raw(T22, [w(ata(KEY, QUOTE, T22)), r(KEY, true)], [5])], "program_not_allowed"],
    ["SPL set authority (give the token account away)", () => [raw(T22, [w(ata(KEY, QUOTE, T22)), r(KEY, true)], [6, 2, 1, ...new Uint8Array(32)])], "program_not_allowed"],
    ["SPL close account (rent to another wallet)", () => [raw(T22, [w(ata(KEY, QUOTE, T22)), w(ATTACKER), r(KEY, true)], [9])], "program_not_allowed"],
    ["SPL burn", () => [raw(T22, [w(ata(KEY, A, T22)), w(A), r(KEY, true)], [8, ...u64(1n)])], "program_not_allowed"],
    ["a memo", () => [post(), raw(MEMO, [], [...new TextEncoder().encode("send to " + ATTACKER)])], "program_not_allowed", RUNTIME],
    ["an unknown program", () => [raw(addr(99), [w(KEY, true), w(ATTACKER)], [1, 2, 3])], "program_not_allowed"],
    ["units_launch withdraw_compute", () => [launch.withdrawCompute({ launcher: KEY, agent: AGENT, agentMint: OWN, launcherToken: ata(ATTACKER, QUOTE, T22), lineMint: QUOTE, amount: 1n, lineTokenProgram: T22 })], "program_not_allowed"],
    ["the lookup table program", () => [raw(ALT_PROGRAM, [w(addr(98)), r(KEY, true)], [1, 0, 0, 0])], "program_not_allowed"],
    ["a token account creation (the key pays for nothing, not even its own account)", () => [token.createAtaIdempotent(KEY, KEY, QUOTE, T22)], "program_not_allowed"],
    ["a token account created for another wallet", () => [token.createAtaIdempotent(KEY, ATTACKER, QUOTE, T22)], "program_not_allowed"],
    ["associated token RecoverNested", () => [raw(ASSOCIATED_TOKEN_PROGRAM, [w(addr(90)), r(A), w(ata(KEY, A, T22)), r(ata(KEY, QUOTE, T22)), r(QUOTE), w(KEY, true), r(T22)], [2])], "program_not_allowed"],
    ["two compute unit limits", () => [computeBudget.limit(1), computeBudget.limit(2), post()], "compute_budget", RUNTIME],
    ["a compute unit limit above the maximum", () => [computeBudget.limit(1_400_001), post()], "compute_budget", RUNTIME],
    ["a compute budget heap request", () => [raw(COMPUTE, [], [1, 0, 0, 4, 0]), post()], "compute_budget", RUNTIME],
    ["compute budget only", () => [computeBudget.limit(200_000)], "nothing_to_sign"],
    ["a post mixed with a registry call", () => [post(), registry.setProfile({ signingKey: KEY, agent: AGENT, digest: "cd".repeat(32), seq: 2 })], "mixed_kinds", RUNTIME],
    ["units_registry register", () => [raw(registry.rotateAgentKey({ owner: RUNTIME, agent: AGENT, newKey: KEY }).programId, [r(registryPdas.config()), w(RUNTIME, true), r(KEY, true)], [...ixDisc("register")])], "instruction_not_allowed", RUNTIME],
    ["units_registry propose_owner", () => [registry.proposeOwner({ owner: KEY, agent: AGENT, newOwner: ATTACKER })], "instruction_not_allowed", RUNTIME],
    ["units_registry request_unbond", () => [registry.requestUnbond({ owner: KEY, agent: AGENT, amount: 1n })], "instruction_not_allowed", RUNTIME],
    ["units_msg set_config", () => [raw(post().programId, [w(addr(96)), r(KEY, true)], [...ixDisc("set_config")])], "instruction_not_allowed", RUNTIME],
  ];
  for (const [name, build, want, payer] of cases) test(name, () => expect(rule(build(), {}, payer ?? KEY)).toBe(want));

  test("an unknown key, a key that does not sign", () => {
    expect(rule([post()], { agent: null }, RUNTIME)).toBe("unknown_agent");
    expect(rule([post()], { key: ATTACKER }, RUNTIME)).toBe("not_a_signer");
  });

  test("messages and registry calls: never as fee payer, never writable, only for its own agent", () => {
    expect(rule([post(AGENT, KEY)])).toBe("key_pays");
    expect(rule([post(addr(77), RUNTIME)], {}, RUNTIME)).toBe("message_accounts");
    expect(rule([registry.rotateAgentKey({ owner: RUNTIME, agent: addr(77), newKey: KEY })], {}, RUNTIME)).toBe("registry_accounts");
    expect(rule([registry.rotateAgentKey({ owner: KEY, agent: AGENT, newKey: RUNTIME })], {}, RUNTIME)).toBe("registry_accounts");
    expect(rule([registry.setProfile({ signingKey: KEY, agent: addr(77), digest: "cd".repeat(32), seq: 2 })], {}, RUNTIME)).toBe("registry_accounts");
    // the key made writable by the message header
    const wr = post(AGENT, RUNTIME);
    wr.keys[1] = w(KEY, true);
    expect(rule([wr], {}, RUNTIME)).toBe("key_writable");
    // a post next to a System transfer the payer would make
    expect(rule([post(AGENT, RUNTIME), system.transfer(RUNTIME, ATTACKER, 1n)], {}, RUNTIME)).toBe("program_not_allowed");
  });
});

describe("strict parser and lookup tables", () => {
  const good = () => msgOf([post()], RUNTIME);
  test("the unmodified message is allowed", () => {
    expect(evaluate(good(), ctx()).ok).toBe(true);
  });
  test("trailing bytes, truncation, an unknown version", () => {
    expect(evaluate(Uint8Array.from([...good(), 0]), ctx()).ok).toBe(false);
    expect(evaluate(good().subarray(0, good().length - 1), ctx()).ok).toBe(false);
    expect(evaluate(Uint8Array.from([0x81, ...good()]), ctx()).ok).toBe(false);
    expect(evaluate(new Uint8Array(0), ctx()).ok).toBe(false);
  });
  test("a length that is not in its shortest encoding", () => {
    const m = good();
    // the key count sits right after the three header bytes: re-encode it with a redundant continuation byte
    const n = m[3]!;
    const bad = Uint8Array.from([...m.subarray(0, 3), n | 0x80, 0x00, ...m.subarray(4)]);
    expect(() => parseMessageStrict(bad)).toThrow(/shortest/);
    expect(evaluate(bad, ctx())).toMatchObject({ ok: false, rule: "malformed" });
  });
  test("a duplicated account key and an index past the key list", () => {
    const m = good();
    const dup = Uint8Array.from(m);
    dup.set(m.subarray(4, 36), 4 + 32); // second key becomes a copy of the first
    expect(evaluate(dup, ctx())).toMatchObject({ ok: false, rule: "malformed" });
    const p = parseMessageStrict(m);
    const tail = Uint8Array.from(m);
    // the first account index of the only instruction: point it past the key list
    const at = 4 + 32 * p.keys.length + 32 + 1 + 1 + 1;
    tail[at] = 250;
    expect(evaluate(tail, ctx())).toMatchObject({ ok: false, rule: "malformed" });
  });
  test("version 0: unresolved tables are refused; resolved ones are checked like static accounts", () => {
    const table = { address: addr(120), addresses: [registryPdas.agent(AGENT), msgPdas.state(AGENT)] };
    const v0 = compileMessageV0(RUNTIME, [post()], BH, [table]).bytes;
    expect(parseMessageStrict(v0, null).lookups.length).toBe(1);
    expect(evaluate(v0, ctx())).toMatchObject({ ok: false, rule: "lookup_table" });
    expect(evaluate(v0, ctx({ tables: new Map([[table.address, table.addresses]]) })).ok).toBe(true);
    // the same indexes resolved by a table that says something else: the post is no longer this agent's
    const lying = new Map([[table.address, [registryPdas.agent(addr(77)), msgPdas.state(addr(77))]]]);
    expect(evaluate(v0, ctx({ tables: lying }))).toMatchObject({ ok: false, rule: "message_accounts" });
  });
});

describe("the signing guard", () => {
  test("a guarded key signs nothing without a ticket, and a ticket is for exactly those bytes, once", async () => {
    const k = generateAgentKey();
    const m = compileMessage(k.id, [system.transfer(k.id, ATTACKER, 1n)], BH);
    expect(signBytes(k, m.bytes).length).toBe(64); // not guarded yet: an ordinary key
    guardKey(k.id);
    expect(() => signBytes(k, m.bytes)).toThrow(FirewallRefusal);
    expect(() => buildTransaction(k, [system.transfer(k.id, ATTACKER, 1n)], BH)).toThrow(/not_authorized/);
    // no firewall installed: default deny
    await expect(authorizeSigners(m.bytes, [k.id])).rejects.toThrow(/no_firewall/);
    let asked = 0;
    installAuthorizer(async () => void asked++);
    await authorizeSigners(m.bytes, [k.id]);
    expect(asked).toBe(1);
    const other = compileMessage(k.id, [system.transfer(k.id, ATTACKER, 2n)], BH);
    expect(() => signBytes(k, other.bytes)).toThrow(/not_authorized/); // a ticket for other bytes does not help
    expect(signBytes(k, m.bytes).length).toBe(64);
    expect(() => signBytes(k, m.bytes)).toThrow(/not_authorized/); // single use
  });

  test("a refusing firewall leaves no ticket; an unguarded co-signer passes through", async () => {
    const k = generateAgentKey();
    const payer = generateAgentKey();
    guardKey(k.id);
    installAuthorizer(async (key) => {
      throw new FirewallRefusal("program_not_allowed", "test", key);
    });
    const m = compileMessage(payer.id, [system.transfer(payer.id, ATTACKER, 1n), registry.rotateAgentKey({ owner: payer.id, agent: AGENT, newKey: k.id })], BH);
    await expect(authorizeSigners(m.bytes, [payer.id, k.id])).rejects.toThrow(/program_not_allowed/);
    expect(() => signBytes(k, m.bytes)).toThrow(/not_authorized/);
    expect(signBytes(payer, m.bytes).length).toBe(64);
  });
});

// ------------------------------------------------------------------------------------------------
// the chain-backed firewall

function chainWorld(o: { tableFrozen?: boolean } = {}) {
  const m = new Map<string, { data: Uint8Array; owner: string }>();
  const tbl = new Uint8Array(56 + 64);
  new DataView(tbl.buffer).setUint32(0, 1, true);
  new DataView(tbl.buffer).setBigUint64(4, (1n << 64n) - 1n, true);
  if (o.tableFrozen === false) tbl[21] = 1;
  tbl.set(new Writer().address(registryPdas.agent(AGENT)).address(msgPdas.state(AGENT)).done(), 56);
  m.set(addr(130), { data: tbl, owner: ALT_PROGRAM });
  const calls: string[] = [];
  const rawAcc = (a: string) => {
    const x = m.get(a);
    return x ? { data: [Buffer.from(x.data).toString("base64"), "base64"], owner: x.owner, lamports: 1, executable: false } : null;
  };
  const rpc = new Rpc(async (method, params) => {
    calls.push(method);
    if (method === "getAccountInfo") return { value: rawAcc(params[0] as string) };
    if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map(rawAcc) };
    throw new Error(`unexpected ${method}`);
  });
  return { rpc, calls };
}

describe("AgentFirewall: identity from the runtime, tables from chain, the decision log", () => {
  const key = generateAgentKey();
  const payer = generateAgentKey();
  const lb = (mint: string) => ({ mint, quoteMint: QUOTE, quoteTokenProgram: T22, user: key.id });
  function make(o: { tableFrozen?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "fw-"));
    const { rpc, calls } = chainWorld(o);
    const fw = new AgentFirewall({ rpc, dir, identity: (k) => (k === key.id ? { agent: AGENT } : null) });
    return { fw, dir, rpc, calls };
  }
  const m = (ixs: Ix[], by = key.id) => compileMessage(by, ixs, BH).bytes;
  const ownPost = () => post(AGENT, payer.id, key.id);
  const swaps = (): [string, Ix][] => [
    ["curve buy", pump.buyExactQuoteInV3({ ...lb(A), spendableQuoteIn: 2_000_000n, minTokensOut: 1n })],
    ["curve sell", pump.sellV3({ ...lb(A), amount: 1_000n, minQuoteOut: 1n })],
    ["pool buy", pumpAmm.buyExactQuoteInV2({ ...lb(B), pool: pumpPdas.pool(B, QUOTE), spendableQuoteIn: 2_000_000n, minBaseOut: 1n })],
    ["pool sell", pumpAmm.sellV2({ ...lb(B), pool: pumpPdas.pool(B, QUOTE), baseIn: 1_000n, minQuoteOut: 1n })],
  ];

  test("every swap is refused and logged, without a single chain read; a post is allowed and logged", async () => {
    const { fw, dir, calls } = make();
    for (const [name, ix] of swaps()) await expect(fw.authorize(key.id, m([ix])).then(() => name)).rejects.toMatchObject({ rule: "swap_not_allowed" });
    expect(calls).toEqual([]);
    const ok = await fw.authorize(key.id, m([ownPost()], payer.id));
    expect(ok.kind).toBe("message");
    const rows = readFileSync(join(dir, "firewall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.ok, x.kind, x.rule, x.key, x.agent, x.value])).toEqual([
      ...swaps().map(() => [false, null, "swap_not_allowed", key.id, AGENT, "0"]),
      [true, "message", null, key.id, AGENT, "0"],
    ]);
    expect(rows.every((x) => /^[0-9a-f]{64}$/.test(x.message_sha256))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(Buffer.from(key.secret).toString("hex").slice(0, 16));
    expect(fw.counts).toEqual({ swap_not_allowed: 4, allowed: 1 });
  });

  test("a transfer, a key the runtime does not know", async () => {
    const { fw } = make();
    await expect(fw.authorize(key.id, m([system.transfer(key.id, ATTACKER, 1n)]))).rejects.toMatchObject({ rule: "program_not_allowed" });
    await expect(fw.authorize(addr(74), compileMessage(payer.id, [post(AGENT, payer.id, addr(74))], BH).bytes)).rejects.toMatchObject({ rule: "unknown_agent" });
  });

  test("a chain that cannot be read: a message with a lookup table is not signed; a swap is refused all the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-"));
    const down = new AgentFirewall({ rpc: new Rpc(async () => { throw new Error("rpc down"); }), dir, identity: () => ({ agent: AGENT }) });
    const v0 = compileMessageV0(payer.id, [ownPost()], BH, [{ address: addr(130), addresses: [registryPdas.agent(AGENT), msgPdas.state(AGENT)] }]).bytes;
    await expect(down.authorize(key.id, v0)).rejects.toMatchObject({ rule: "context_unavailable" });
    for (const [, ix] of swaps()) await expect(down.authorize(key.id, m([ix]))).rejects.toMatchObject({ rule: "swap_not_allowed" });
  });

  test("lookup tables are read from chain: a frozen one resolves, one with an authority is refused, a missing one is refused", async () => {
    const tableOf = (address: Address) => ({ address, addresses: [registryPdas.agent(AGENT), msgPdas.state(AGENT)] });
    const v0 = compileMessageV0(payer.id, [ownPost()], BH, [tableOf(addr(130))]).bytes;
    expect((await make().fw.authorize(key.id, v0)).kind).toBe("message");
    await expect(make({ tableFrozen: false }).fw.authorize(key.id, v0)).rejects.toMatchObject({ rule: "lookup_table" });
    const unknown = compileMessageV0(payer.id, [ownPost()], BH, [tableOf(addr(131))]).bytes;
    await expect(make().fw.authorize(key.id, unknown)).rejects.toMatchObject({ rule: "lookup_table" });
    // a swap through a frozen table is read, resolved and refused
    const swapV0 = compileMessageV0(key.id, [swaps()[0]![1]], BH, [{ address: addr(130), addresses: [registryPdas.agent(AGENT), msgPdas.state(AGENT)] }]).bytes;
    await expect(make().fw.authorize(key.id, swapV0)).rejects.toMatchObject({ rule: "swap_not_allowed" });
  });

  test("installed: the guarded key signs its post and cannot sign a swap or a transfer", async () => {
    const { fw } = make();
    fw.install();
    guardKey(key.id);
    const ok = compileMessage(payer.id, [ownPost()], BH);
    await authorizeSigners(ok.bytes, [payer.id, key.id]);
    expect(signBytes(key, ok.bytes).length).toBe(64);
    for (const [name, ix] of swaps()) {
      const bad = compileMessage(key.id, [ix], BH);
      await expect(authorizeSigners(bad.bytes, [key.id]).then(() => name)).rejects.toThrow(/swap_not_allowed/);
      expect(() => signBytes(key, bad.bytes)).toThrow(/not_authorized/);
      expect(() => buildTransaction(key, [ix], BH)).toThrow(/not_authorized/);
    }
    const transfer = compileMessage(key.id, [system.transfer(key.id, ATTACKER, 5n)], BH);
    await expect(authorizeSigners(transfer.bytes, [key.id])).rejects.toThrow(/program_not_allowed/);
    expect(() => signBytes(key, transfer.bytes)).toThrow(/not_authorized/);
  });
});

// ------------------------------------------------------------------------------------------------
// property tests

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MSG_PROGRAM = post().programId;
const REGISTRY_PROGRAM = registry.proposeOwner({ owner: KEY, agent: AGENT, newOwner: KEY }).programId;

/**
 * An independent statement of what an allowed message may be, written without the policy's code
 * paths: every program is compute budget, units_msg or units_registry (so no swap, no token and no
 * System instruction), and the key is a read-only signer that is not the fee payer.
 */
function oracle(bytes: Uint8Array, c: FirewallContext): string | null {
  const m = parseMessageStrict(bytes, c.tables);
  const okProgs = new Set([COMPUTE, MSG_PROGRAM, REGISTRY_PROGRAM]);
  for (const i of m.instructions) if (!okProgs.has(i.programId)) return `program ${i.programId}`;
  const at = m.keys.indexOf(c.key);
  if (at < 0 || at >= m.numSigners) return "the key does not sign";
  if (at === 0) return "the key pays";
  if (m.writable[at]) return "the key is writable";
  return null;
}

describe("property: fuzzed instruction lists", () => {
  const programs = [SYSTEM_PROGRAM, TOKEN_PROGRAM, T22, MEMO, ALT_PROGRAM, addr(99), LAUNCH_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM, PUMP.program, PUMP.amm, JUPITER, COMPUTE, MSG_PROGRAM, REGISTRY_PROGRAM];
  const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const accounts = [KEY, ATTACKER, RUNTIME, QUOTE, A, B, OWN, ata(KEY, QUOTE, T22), ata(ATTACKER, QUOTE, T22), ata(KEY, A, T22), ata(ATTACKER, A, T22), pumpPdas.bondingCurve(A), pumpPdas.pool(B, QUOTE), SYSTEM_PROGRAM, T22, addr(88), addr(89)];
  const builders: ((rnd: () => number) => Ix)[] = [
    () => curveBuy(), () => curveSell(), () => poolBuy(), () => poolSell(),
    (rnd) => post(pick(rnd, [AGENT, AGENT, addr(77)])),
    () => msg.publishEncKey({ payer: RUNTIME, signer: KEY, agent: AGENT, encKey: addr(9) }),
    (rnd) => registry.rotateAgentKey({ owner: RUNTIME, agent: pick(rnd, [AGENT, AGENT, addr(77)]), newKey: KEY }),
    () => registry.setProfile({ signingKey: KEY, agent: AGENT, digest: "cd".repeat(32), seq: 2 }),
    (rnd) => token.createAtaIdempotent(pick(rnd, [KEY, ATTACKER]), pick(rnd, [KEY, ATTACKER, PUMP.buybackRecipients[0]]), pick(rnd, [QUOTE, A, B]), T22),
    (rnd) => system.transfer(KEY, pick(rnd, accounts), BigInt(Math.floor(rnd() * 1e9))),
    (rnd) => token.transferChecked(ata(KEY, QUOTE, T22), QUOTE, ata(pick(rnd, [KEY, ATTACKER]), QUOTE, T22), KEY, 1n, 6, T22),
    (rnd) => computeBudget.limit(Math.floor(rnd() * 2_000_000)),
    (rnd) => computeBudget.price(Math.floor(rnd() * 2_000_000)),
    (rnd) => pump.buyExactQuoteInV3({ ...base(pick(rnd, [A, B, OWN, addr(40)])), userQuote: rnd() < 0.5 ? ata(ATTACKER, QUOTE, T22) : undefined, userBase: rnd() < 0.3 ? ata(ATTACKER, A, T22) : undefined, spendableQuoteIn: BigInt(Math.floor(rnd() * 2e8)), minTokensOut: BigInt(Math.floor(rnd() * 1e8)) }),
    (rnd) => pumpAmm.sellV2({ ...base(pick(rnd, [A, B])), pool: rnd() < 0.5 ? pumpPdas.pool(B, QUOTE) : addr(97), userQuote: rnd() < 0.5 ? ata(ATTACKER, QUOTE, T22) : undefined, baseIn: BigInt(Math.floor(rnd() * 3e6)), minQuoteOut: BigInt(Math.floor(rnd() * 1e7)) }),
    (rnd) => {
      const n = Math.floor(rnd() * 6);
      const keys = Array.from({ length: n }, () => ({ pubkey: pick(rnd, accounts), isSigner: false, isWritable: rnd() < 0.5 }));
      if (rnd() < 0.5) keys.unshift({ pubkey: KEY, isSigner: true, isWritable: rnd() < 0.5 });
      return { programId: pick(rnd, programs), keys, data: Uint8Array.from({ length: Math.floor(rnd() * 40) }, () => Math.floor(rnd() * 256)) };
    },
  ];
  const swapPrograms = new Set<string>([PUMP.program, PUMP.amm, JUPITER]);

  test("4,000 random instruction lists: whatever is allowed satisfies the independent statement and carries no swap; nothing throws", () => {
    // (timeouts below: a cold run derives every program address once)
    const rnd = rng(20261012);
    let allowed = 0, refused = 0, withSwap = 0;
    const c = ctx();
    for (let i = 0; i < 4000; i++) {
      const n = 1 + Math.floor(rnd() * 4);
      const ixs = Array.from({ length: n }, () => pick(rnd, builders)(rnd));
      const payer = rnd() < 0.5 ? KEY : RUNTIME;
      // a program id that is also the payer cannot compile into a valid message
      if (ixs.some((ix) => ix.programId === payer)) continue;
      const bytes = compileMessage(payer, ixs, BH).bytes;
      const v = evaluate(bytes, c);
      const swap = ixs.some((ix) => swapPrograms.has(ix.programId));
      if (swap) {
        withSwap++;
        expect([i, v.ok ? "ALLOWED" : v.rule]).toEqual([i, "swap_not_allowed"]);
      }
      if (v.ok) {
        allowed++;
        expect([i, oracle(bytes, c)]).toEqual([i, null]);
      } else refused++;
    }
    expect(allowed).toBeGreaterThan(20);
    expect(withSwap).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(2000);
  }, 60_000);

  test("6,000 random byte flips of valid messages: refused, or still within the independent statement; the parser never throws out", () => {
    const rnd = rng(99);
    const c = ctx();
    const seeds = [msgOf([computeBudget.limit(300_000), ...pre(A), curveBuy()]), msgOf([poolSell()]), msgOf([curveSell()]), msgOf([post()], RUNTIME), msgOf([computeBudget.limit(60_000), registry.setProfile({ signingKey: KEY, agent: AGENT, digest: "cd".repeat(32), seq: 2 })], RUNTIME)];
    let still = 0;
    for (let i = 0; i < 6_000; i++) {
      const b = Uint8Array.from(pick(rnd, seeds));
      const flips = 1 + Math.floor(rnd() * 3);
      for (let f = 0; f < flips; f++) b[Math.floor(rnd() * b.length)]! ^= 1 << Math.floor(rnd() * 8);
      const v = evaluate(b, c);
      if (!v.ok) continue;
      still++;
      expect([i, oracle(b, c)]).toEqual([i, null]);
    }
    // flips inside the blockhash or a message body leave a valid post: those stay allowed
    expect(still).toBeGreaterThan(0);
  }, 60_000);

  test("random bytes are never allowed", () => {
    const rnd = rng(3);
    const c = ctx();
    for (let i = 0; i < 5000; i++) {
      const b = Uint8Array.from({ length: 1 + Math.floor(rnd() * 600) }, () => Math.floor(rnd() * 256));
      expect(evaluate(b, c).ok).toBe(false);
    }
  });
});
