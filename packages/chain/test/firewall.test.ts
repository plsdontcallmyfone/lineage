// The transaction firewall (docs/plans/AGENT-WALLET-SAFETY.md section 3): the policy rule by rule, the
// strict parser, the signing guard, the chain-backed firewall on recorded pump.fun accounts, and
// property tests that fuzz instruction lists and mutate valid swaps.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import {
  accountDisc, AgentFirewall, ALT_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, ata, authorizeSigners, buildTransaction, compileMessage, compileMessageV0, computeBudget, evaluate,
  FirewallRefusal, guardKey, installAuthorizer, ixDisc, launch, LAUNCH_PROGRAM_ID, launchPdas, msg, parseMessageStrict, pump, PUMP, pumpAmm, pumpPdas, registry, registryPdas,
  resetGuardForTest, Rpc, signBytes, system, SYSTEM_PROGRAM, toAddress, token, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, Writer,
  type Address, type FirewallContext, type FirewallLimits, type Ix, type MintFacts,
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

const LIMITS: FirewallLimits = { trading_enabled: true, max_tx_quote: 100_000_000n, max_day_quote: 1_000_000_000n, min_out_bps: 9000, max_fee_lamports: 1_000_000n };
// spot: 1 token base unit costs 2 quote base units on the curve, 4 in the pool
const facts = (o: Partial<MintFacts> = {}): MintFacts => ({ registered: true, agent: addr(50), curve: { quote: 2_000_000n, base: 1_000_000n }, pool: null, ...o });
function ctx(o: Partial<FirewallContext> = {}): FirewallContext {
  return {
    key: KEY, agent: AGENT, ownMint: OWN, quoteMint: QUOTE, quoteTokenProgram: T22,
    mints: new Map([[A, facts()], [B, facts({ agent: addr(51), curve: null, pool: { quote: 4_000_000n, base: 1_000_000n } })], [OWN, facts({ agent: AGENT })]]),
    tables: new Map(), limits: LIMITS, daySpent: 0n, ...o,
  };
}
const base = (mint: Address, user = KEY) => ({ mint, quoteMint: QUOTE, quoteTokenProgram: T22, user });
const pre = (mint: Address, user = KEY) => [token.createAtaIdempotent(user, user, QUOTE, T22), token.createAtaIdempotent(user, user, mint, T22), token.createAtaIdempotent(user, PUMP.buybackRecipients[0], QUOTE, T22)];
// buy 10 quote on the curve at spot 2: 5,000,000 tokens expected; sell 1,000,000 tokens: 2,000,000 quote expected
const curveBuy = (mint = A, inQ = 10_000_000n, minOut = 4_800_000n) => pump.buyExactQuoteInV3({ ...base(mint), spendableQuoteIn: inQ, minTokensOut: minOut });
const curveSell = (mint = A, amt = 1_000_000n, minOut = 1_900_000n) => pump.sellV3({ ...base(mint), amount: amt, minQuoteOut: minOut });
const poolBuy = (mint = B, inQ = 8_000_000n, minOut = 1_900_000n) => pumpAmm.buyExactQuoteInV2({ ...base(mint), pool: pumpPdas.pool(mint, QUOTE), spendableQuoteIn: inQ, minBaseOut: minOut });
const poolSell = (mint = B, amt = 1_000_000n, minOut = 3_800_000n) => pumpAmm.sellV2({ ...base(mint), pool: pumpPdas.pool(mint, QUOTE), baseIn: amt, minQuoteOut: minOut });
const msgOf = (ixs: Ix[], payer = KEY) => compileMessage(payer, ixs, BH).bytes;
const verdict = (ixs: Ix[], c: Partial<FirewallContext> = {}, payer = KEY) => evaluate(msgOf(ixs, payer), ctx(c));
const rule = (ixs: Ix[], c: Partial<FirewallContext> = {}, payer = KEY) => {
  const v = verdict(ixs, c, payer);
  return v.ok ? "ALLOWED" : v.rule;
};
const raw = (programId: Address, keys: Ix["keys"], data: number[] | Uint8Array): Ix => ({ programId, keys, data: Uint8Array.from(data) });
const u64 = (n: bigint) => [...new Writer().u64(n).done()];

afterEach(() => resetGuardForTest());

describe("policy: what a treasury key may sign", () => {
  test("the four swaps the engine builds, with its token account creations and compute budget", () => {
    for (const [name, ixs] of [
      ["curve buy", [computeBudget.limit(300_000), ...pre(A), curveBuy()]],
      ["curve sell", [computeBudget.limit(300_000), ...pre(A), curveSell()]],
      ["pool buy", [computeBudget.limit(300_000), computeBudget.price(1), ...pre(B), poolBuy()]],
      ["pool sell", [poolSell()]],
    ] as const) {
      const v = verdict([...ixs]);
      expect([name, v.ok ? "ALLOWED" : `${v.rule}: ${v.detail}`]).toEqual([name, "ALLOWED"]);
    }
    const v = verdict([curveBuy()]);
    expect(v.ok && v.kind === "swap" && v.value).toBe(10_000_000n);
    const s = verdict([curveSell()]);
    expect(s.ok && s.value).toBe(2_000_000n); // 1,000,000 tokens at the curve's spot of 2
  });

  test("any of pump.fun's eight published buyback recipients is accepted, and nothing else in that slot", () => {
    for (let i = 0; i < 8; i++) expect(rule([pump.buyExactQuoteInV3({ ...base(A), buyback: i, spendableQuoteIn: 10_000_000n, minTokensOut: 4_800_000n })])).toBe("ALLOWED");
    const ix = curveBuy();
    ix.keys[13] = w(ata(ATTACKER, QUOTE, T22));
    expect(rule([ix])).toBe("swap_accounts");
  });

  test("messages and the bind: the key signs read-only and pays nothing", () => {
    const post = msg.postBoard({ payer: RUNTIME, signer: KEY, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new TextEncoder().encode("hello") } } });
    expect(rule([computeBudget.limit(60_000), post], {}, RUNTIME)).toBe("ALLOWED");
    expect(rule([msg.publishEncKey({ payer: RUNTIME, signer: KEY, agent: AGENT, encKey: addr(9) })], {}, RUNTIME)).toBe("ALLOWED");
    expect(rule([registry.rotateAgentKey({ owner: RUNTIME, agent: AGENT, newKey: KEY })], {}, RUNTIME)).toBe("ALLOWED");
    expect(rule([registry.setProfile({ signingKey: KEY, agent: AGENT, digest: "cd".repeat(32), seq: 2 })], {}, RUNTIME)).toBe("ALLOWED");
    // trading off or unreadable limits do not stop a post or a bind
    expect(rule([post], { limits: null }, RUNTIME)).toBe("ALLOWED");
    expect(rule([post], { limits: { ...LIMITS, trading_enabled: false } }, RUNTIME)).toBe("ALLOWED");
  });
});

describe("policy: what it refuses", () => {
  const cases: [string, () => Ix[], string, Address?][] = [
    ["a System transfer to another wallet", () => [system.transfer(KEY, ATTACKER, 1_000_000n)], "program_not_allowed"],
    ["a System transfer next to a valid swap", () => [curveBuy(), system.transfer(KEY, ATTACKER, 1n)], "program_not_allowed"],
    ["System create account", () => [system.createAccount(KEY, ATTACKER, 1n, 0, SYSTEM_PROGRAM)], "program_not_allowed"],
    ["System assign (hand the key's account to a program)", () => [raw(SYSTEM_PROGRAM, [w(KEY, true)], [1, 0, 0, 0, ...new Uint8Array(32)])], "program_not_allowed"],
    ["SPL transferChecked of $UNITS to another wallet", () => [token.transferChecked(ata(KEY, QUOTE, T22), QUOTE, ata(ATTACKER, QUOTE, T22), KEY, 5n, 6, T22)], "program_not_allowed"],
    ["SPL transfer (legacy Token program)", () => [raw(TOKEN_PROGRAM, [w(ata(KEY, QUOTE)), w(ata(ATTACKER, QUOTE)), r(KEY, true)], [3, ...u64(5n)])], "program_not_allowed"],
    ["SPL approve (delegate the treasury's tokens)", () => [raw(T22, [w(ata(KEY, QUOTE, T22)), r(ATTACKER), r(KEY, true)], [4, ...u64(1n << 60n)])], "program_not_allowed"],
    ["SPL revoke", () => [raw(T22, [w(ata(KEY, QUOTE, T22)), r(KEY, true)], [5])], "program_not_allowed"],
    ["SPL set authority (give the token account away)", () => [raw(T22, [w(ata(KEY, QUOTE, T22)), r(KEY, true)], [6, 2, 1, ...new Uint8Array(32)])], "program_not_allowed"],
    ["SPL close account (rent to another wallet)", () => [raw(T22, [w(ata(KEY, QUOTE, T22)), w(ATTACKER), r(KEY, true)], [9])], "program_not_allowed"],
    ["SPL burn", () => [raw(T22, [w(ata(KEY, A, T22)), w(A), r(KEY, true)], [8, ...u64(1n)])], "program_not_allowed"],
    ["a memo", () => [curveBuy(), raw(MEMO, [], [...new TextEncoder().encode("send to " + ATTACKER)])], "program_not_allowed"],
    ["an unknown program", () => [raw(addr(99), [w(KEY, true), w(ATTACKER)], [1, 2, 3])], "program_not_allowed"],
    ["units_launch withdraw_compute", () => [launch.withdrawCompute({ launcher: KEY, agent: AGENT, agentMint: OWN, launcherToken: ata(ATTACKER, QUOTE, T22), lineMint: QUOTE, amount: 1n, lineTokenProgram: T22 })], "program_not_allowed"],
    ["the lookup table program", () => [raw(ALT_PROGRAM, [w(addr(98)), r(KEY, true)], [1, 0, 0, 0])], "program_not_allowed"],
    ["the swap's quote account replaced by another wallet's", () => [pump.buyExactQuoteInV3({ ...base(A), userQuote: ata(ATTACKER, QUOTE, T22), spendableQuoteIn: 10_000_000n, minTokensOut: 4_800_000n })], "swap_accounts"],
    ["a sell whose proceeds go to another wallet's $UNITS account", () => [pump.sellV3({ ...base(A), userQuote: ata(ATTACKER, QUOTE, T22), amount: 1_000_000n, minQuoteOut: 1_900_000n })], "swap_accounts"],
    ["a buy whose tokens go to another wallet's account", () => [pump.buyExactQuoteInV3({ ...base(A), userBase: ata(ATTACKER, A, T22), spendableQuoteIn: 10_000_000n, minTokensOut: 4_800_000n })], "swap_accounts"],
    ["a pool sell to another wallet", () => [pumpAmm.sellV2({ ...base(B), pool: pumpPdas.pool(B, QUOTE), userQuote: ata(ATTACKER, QUOTE, T22), baseIn: 1_000_000n, minQuoteOut: 3_800_000n })], "swap_accounts"],
    ["a pool that is not the canonical one", () => [pumpAmm.buyExactQuoteInV2({ ...base(B), pool: addr(97), spendableQuoteIn: 8_000_000n, minBaseOut: 1_900_000n })], "swap_accounts"],
    ["an account appended to a valid swap", () => { const ix = curveBuy(); ix.keys.push(w(ATTACKER)); return [ix]; }, "swap_accounts"],
    ["a mint that is not registered in units_launch", () => [curveBuy(addr(40))], "mint_not_registered"],
    ["its own token", () => [curveBuy(OWN)], "own_token"],
    ["a swap quoted in another token", () => [pump.buyExactQuoteInV3({ ...base(A), quoteMint: PUMP.wsol, spendableQuoteIn: 10_000_000n, minTokensOut: 4_800_000n })], "quote_mint"],
    ["minimum out of zero", () => [curveBuy(A, 10_000_000n, 0n)], "zero_amount"],
    ["a buy that demands too little (sandwich bait)", () => [curveBuy(A, 10_000_000n, 1n)], "min_out_too_low"],
    ["a sell that demands too little", () => [curveSell(A, 1_000_000n, 1n)], "min_out_too_low"],
    ["a buy above the per-transaction value limit", () => [curveBuy(A, 100_000_001n, 49_000_000n)], "max_tx_value"],
    ["a sell above the per-transaction value limit", () => [curveSell(A, 60_000_000n, 119_000_000n)], "max_tx_value"],
    ["two swaps in one transaction", () => [curveBuy(), poolBuy()], "one_swap"],
    ["Pump buy_v3 (exact out)", () => [pump.buyV3({ ...base(A), amount: 1n, maxQuoteIn: 10_000_000n })], "instruction_not_allowed"],
    ["Pump create_v2", () => [pump.createV2({ mint: addr(41), user: KEY, creator: ATTACKER, name: "x", symbol: "x", uri: "x", quote: { kind: "sol" } })], "swap_signers"],
    ["Pump sweep_creator_fee", () => [pump.sweepCreatorFee({ payer: KEY, mint: A, quoteMint: QUOTE, creator: ATTACKER, quoteTokenProgram: T22 })], "instruction_not_allowed"],
    ["PumpSwap buy_v2 (exact out)", () => [pumpAmm.buyV2({ ...base(B), pool: pumpPdas.pool(B, QUOTE), baseOut: 1n, maxQuoteIn: 8_000_000n })], "instruction_not_allowed"],
    ["Pump collect_creator_fee_v2", () => [pump.collectCreatorFeeV2({ creator: ATTACKER, quoteMint: QUOTE, quoteTokenProgram: T22 })], "instruction_not_allowed"],
    ["PumpSwap multi_hop_swap to another wallet's account", () => [pumpAmm.multiHopSwap({ user: KEY, userIn: ata(KEY, QUOTE, T22), userOut: ata(ATTACKER, A, T22), hops: [{ kind: "curve", mint: A, quoteMint: QUOTE }], amountIn: 1n, minOut: 1n, buybackQuoteMint: QUOTE })], "instruction_not_allowed"],
    ["a token account created for another wallet", () => [token.createAtaIdempotent(KEY, ATTACKER, QUOTE, T22), curveBuy()], "ata_not_own"],
    ["a token account for a mint the swap does not trade", () => [token.createAtaIdempotent(KEY, KEY, B, T22), curveBuy()], "ata_not_own"],
    ["a buyback account the swap does not name", () => [token.createAtaIdempotent(KEY, PUMP.buybackRecipients[3], QUOTE, T22), curveBuy()], "ata_not_own"],
    ["associated token RecoverNested", () => [raw(ASSOCIATED_TOKEN_PROGRAM, [w(addr(90)), r(A), w(ata(KEY, A, T22)), r(ata(KEY, QUOTE, T22)), r(QUOTE), w(KEY, true), r(T22)], [2]), curveBuy()], "instruction_not_allowed"],
    ["token account creation alone (no swap)", () => [token.createAtaIdempotent(KEY, KEY, QUOTE, T22)], "one_swap"],
    ["a priority fee above the cap", () => [computeBudget.limit(1_400_000), computeBudget.price(1_000_000), curveBuy()], "max_fee"],
    ["a compute unit price with no limit (worst case assumed)", () => [computeBudget.price(1_000_000), curveBuy()], "max_fee"],
    ["two compute unit limits", () => [computeBudget.limit(1), computeBudget.limit(2), curveBuy()], "compute_budget"],
    ["a compute budget heap request", () => [raw("ComputeBudget111111111111111111111111111111", [], [1, 0, 0, 4, 0]), curveBuy()], "compute_budget"],
    ["compute budget only", () => [computeBudget.limit(200_000)], "nothing_to_sign"],
    ["a swap mixed with a board post", () => [curveBuy(), msg.postBoard({ payer: KEY, signer: KEY, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new Uint8Array(1) } } })], "mixed_kinds"],
    ["units_registry register", () => [raw(registry.rotateAgentKey({ owner: RUNTIME, agent: AGENT, newKey: KEY }).programId, [r(registryPdas.config()), w(RUNTIME, true), r(KEY, true)], [...ixDisc("register")])], "instruction_not_allowed", RUNTIME],
    ["units_registry propose_owner", () => [registry.proposeOwner({ owner: KEY, agent: AGENT, newOwner: ATTACKER })], "instruction_not_allowed", RUNTIME],
    ["units_registry request_unbond", () => [registry.requestUnbond({ owner: KEY, agent: AGENT, amount: 1n })], "instruction_not_allowed", RUNTIME],
    ["units_msg set_config", () => [raw(msg.postBoard({ payer: RUNTIME, signer: KEY, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new Uint8Array(1) } } }).programId, [w(addr(96)), r(KEY, true)], [...ixDisc("set_config")])], "instruction_not_allowed", RUNTIME],
  ];
  for (const [name, build, want, payer] of cases) test(name, () => expect(rule(build(), {}, payer ?? KEY)).toBe(want));

  test("four token account creations", () => {
    expect(rule([...pre(A), curveBuy()])).toBe("ALLOWED");
    const four: Ix[] = [...pre(A), { ...token.createAtaIdempotent(KEY, KEY, QUOTE, T22), data: Uint8Array.of(0) }, curveBuy()];
    expect(rule(four)).toBe("ata_creates");
  });

  test("the message header cannot lock more than the swap needs, and lists no unused account", () => {
    const m = msgOf([curveBuy()]);
    const p = parseMessageStrict(m);
    // one fewer read-only unsigned key: the last read-only account becomes writable
    const wider = Uint8Array.from(m);
    wider[2] = p.numReadonlyUnsigned - 1;
    expect(evaluate(wider, ctx())).toMatchObject({ ok: false, rule: "account_flags" });
    // an extra static key nobody names
    const extra = Uint8Array.from([...m.subarray(0, 2), p.numReadonlyUnsigned + 1, p.keys.length + 1, ...m.subarray(4, 4 + 32 * p.keys.length), ...Buffer.from(new Uint8Array(32).fill(9)), ...m.subarray(4 + 32 * p.keys.length)]);
    expect(evaluate(extra, ctx())).toMatchObject({ ok: false, rule: "unused_account" });
  });

  test("a token account whose address is not the owner's associated account", () => {
    const ix = token.createAtaIdempotent(KEY, KEY, QUOTE, T22);
    ix.keys[1] = w(ata(ATTACKER, QUOTE, T22));
    expect(rule([ix, curveBuy()])).toBe("ata_not_own");
    const funder = token.createAtaIdempotent(ATTACKER, KEY, QUOTE, T22);
    expect(rule([funder, curveBuy()])).toBe("swap_signers");
  });

  test("the daily value limit counts what the key already signed today", () => {
    expect(rule([curveBuy()], { daySpent: 990_000_000n })).toBe("ALLOWED");
    expect(rule([curveBuy()], { daySpent: 990_000_001n })).toBe("max_day_value");
  });

  test("trading off, unreadable limits, an unknown key: no swap", () => {
    expect(rule([curveBuy()], { limits: { ...LIMITS, trading_enabled: false } })).toBe("trading_off");
    expect(rule([curveBuy()], { limits: null })).toBe("no_limits");
    expect(rule([curveBuy()], { agent: null })).toBe("unknown_agent");
  });

  test("no reference price on chain: a curve swap of a migrated coin, a pool swap of a coin still on its curve", () => {
    expect(rule([curveBuy(B)])).toBe("no_reference_price");
    expect(rule([poolBuy(A)])).toBe("no_reference_price");
  });

  test("a token of the same agent under another mint", () => {
    expect(rule([curveBuy()], { mints: new Map([[A, facts({ agent: AGENT })]]) })).toBe("own_token");
  });

  test("a swap needs the key as the only signer and the fee payer", () => {
    expect(rule([curveBuy()], {}, RUNTIME)).toBe("swap_signers");
    const two = curveBuy();
    two.keys.push(r(ATTACKER, true));
    expect(rule([two])).toBe("swap_signers");
    // a swap built for another wallet that the key is asked to pay for
    expect(rule([pump.buyExactQuoteInV3({ ...base(A, ATTACKER), spendableQuoteIn: 10_000_000n, minTokensOut: 4_800_000n })])).toBe("swap_signers");
    expect(verdict([curveBuy()], { key: ATTACKER }).ok).toBe(false);
  });

  test("messages and registry calls: never as fee payer, never writable, only for its own agent", () => {
    const post = (agent: Address, payer: Address) => msg.postBoard({ payer, signer: KEY, agent, args: { lineage: "ab".repeat(32), body: { inline: new Uint8Array(3) } } });
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
  const good = () => msgOf([curveBuy()]);
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
    const table = { address: addr(120), addresses: [PUMP.global, PUMP.feeConfig, PUMP.eventAuthority, SYSTEM_PROGRAM, QUOTE] };
    const v0 = compileMessageV0(KEY, [curveBuy()], BH, [table]).bytes;
    expect(evaluate(v0, ctx())).toMatchObject({ ok: false, rule: "lookup_table" });
    expect(evaluate(v0, ctx({ tables: new Map([[table.address, table.addresses]]) })).ok).toBe(true);
    // the same indexes resolved by a table that says something else: the swap's accounts no longer match
    const lying = new Map([[table.address, [PUMP.global, PUMP.feeConfig, PUMP.eventAuthority, SYSTEM_PROGRAM, addr(121)]]]);
    expect(evaluate(v0, ctx({ tables: lying })).ok).toBe(false);
    // a table that carries the destination: the message says "the key's account" by index, the table says the attacker's
    const dest = { address: addr(122), addresses: [ata(KEY, QUOTE, T22)] };
    const v0b = compileMessageV0(KEY, [curveSell()], BH, [dest]).bytes;
    expect(evaluate(v0b, ctx({ tables: new Map([[dest.address, dest.addresses]]) })).ok).toBe(true);
    expect(evaluate(v0b, ctx({ tables: new Map([[dest.address, [ata(ATTACKER, QUOTE, T22)]]]) }))).toMatchObject({ ok: false, rule: "swap_accounts" });
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
// the chain-backed firewall on account bytes mainnet's pump.fun programs wrote (the fork fixture)

const fx = JSON.parse(readFileSync(new URL("./fixtures/pump-fork.json", import.meta.url), "utf8"));
const { line, a1, a2 } = fx.mints as { line: string; a1: string; a2: string };
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
function launchConfigBytes(): Uint8Array {
  const wr = new Writer().bytes(accountDisc("LaunchConfig"));
  for (const a of [addr(1), addr(2), LAUNCH_PROGRAM_ID, line, T22, addr(3), PUMP.program]) wr.address(a);
  wr.u16(7000).u16(3000).u64(1n).u64(2n).u64(0n).u128(0n).bool(false).u8(255).u8(255);
  for (let i = 0; i < 5; i++) wr.u64(0n);
  return wr.done();
}
function agentLaunchBytes(mint: string, agent: Address, venue: string = PUMP.program): Uint8Array {
  const wr = new Writer().bytes(accountDisc("AgentLaunch")).address(agent).address(mint).address(addr(5)).bytes(new Uint8Array(32)).string("https://github.com/a/b")
    .u8(2).bool(true).address(venue).address(pumpPdas.bondingCurve(mint)).address(addr(6)).address(addr(7)).address(addr(6)).bool(false).bool(true).i64(0n);
  for (let i = 0; i < 5; i++) wr.u64(0n);
  return wr.u8(255).u8(255).done();
}
function tokenAccountBytes(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(new Writer().address(mint).address(owner).u64(amount).done(), 0);
  return d;
}
function chainWorld(o: { tableFrozen?: boolean } = {}) {
  const m = new Map<string, { data: Uint8Array; owner: string }>();
  m.set(launchPdas.config(), { data: launchConfigBytes(), owner: LAUNCH_PROGRAM_ID });
  m.set(launchPdas.agentLaunch(a1), { data: agentLaunchBytes(a1, addr(60)), owner: LAUNCH_PROGRAM_ID });
  m.set(launchPdas.agentLaunch(a2), { data: agentLaunchBytes(a2, addr(61)), owner: LAUNCH_PROGRAM_ID });
  // a record with the right bytes under the wrong owner, and one the Meteora venue wrote
  m.set(launchPdas.agentLaunch(addr(70)), { data: agentLaunchBytes(addr(70), addr(62)), owner: SYSTEM_PROGRAM });
  m.set(launchPdas.agentLaunch(addr(71)), { data: agentLaunchBytes(addr(71), addr(63), addr(64)), owner: LAUNCH_PROGRAM_ID });
  m.set(pumpPdas.bondingCurve(a1), { data: b64(fx.accounts.a1_curve), owner: PUMP.program });
  m.set(pumpPdas.bondingCurve(a2), { data: b64(fx.accounts.a2_curve), owner: PUMP.program });
  const pool = pumpPdas.pool(a2, line);
  m.set(pool, { data: b64(fx.accounts.a2_pool), owner: PUMP.amm });
  m.set(ata(pool, a2, T22), { data: tokenAccountBytes(a2, pool, 1_000_000_000_000n), owner: T22 });
  m.set(ata(pool, line, T22), { data: tokenAccountBytes(line, pool, 500_000_000_000n), owner: T22 });
  const tbl = new Uint8Array(56 + 32);
  new DataView(tbl.buffer).setUint32(0, 1, true);
  new DataView(tbl.buffer).setBigUint64(4, (1n << 64n) - 1n, true);
  if (o.tableFrozen === false) tbl[21] = 1;
  tbl.set(new Writer().address(PUMP.global).done(), 56);
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

describe("AgentFirewall: context from chain, ledger, log", () => {
  const key = generateAgentKey();
  const lb = (mint: string) => ({ mint, quoteMint: line, quoteTokenProgram: T22, user: key.id });
  function make(o: { limits?: FirewallLimits | null; now?: () => number; tableFrozen?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "fw-"));
    const { rpc } = chainWorld(o);
    const fw = new AgentFirewall({ rpc, dir, now: o.now, identity: (k) => (k === key.id ? { agent: AGENT, ownMint: addr(72) } : null), limits: async () => (o.limits === undefined ? { ...LIMITS, min_out_bps: 0 } : o.limits) });
    return { fw, dir, rpc };
  }
  const m = (ixs: Ix[]) => compileMessage(key.id, ixs, BH).bytes;

  test("a registered coin on its curve and a migrated one in its pool are allowed; the ledger and the log record them", async () => {
    const { fw, dir } = make();
    const buy = await fw.authorize(key.id, m([pump.buyExactQuoteInV3({ ...lb(a1), spendableQuoteIn: 2_000_000n, minTokensOut: 1n })]));
    expect(buy.kind === "swap" && buy.value).toBe(2_000_000n);
    const sell = await fw.authorize(key.id, m([pumpAmm.sellV2({ ...lb(a2), pool: pumpPdas.pool(a2, line), baseIn: 1_000n, minQuoteOut: 1n })]));
    expect(sell.kind).toBe("swap");
    expect(fw.spentToday(key.id)).toBe(2_000_000n + sell.value);
    const rows = readFileSync(join(dir, "firewall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.ok, x.kind, x.key, x.agent])).toEqual([[true, "swap", key.id, AGENT], [true, "swap", key.id, AGENT]]);
    expect(JSON.stringify(rows)).not.toContain(Buffer.from(key.secret).toString("hex").slice(0, 16));
    // a second firewall on the same directory starts from the persisted ledger
    const again = new AgentFirewall({ rpc: chainWorld().rpc, dir, identity: () => ({ agent: AGENT, ownMint: null }), limits: async () => LIMITS });
    expect(again.spentToday(key.id)).toBe(fw.spentToday(key.id));
  });

  test("refused from chain facts: no launch record, a record under the wrong owner, a Meteora-era record, a transfer", async () => {
    const { fw, dir } = make();
    const buy = (mint: string) => m([pump.buyExactQuoteInV3({ ...lb(mint), spendableQuoteIn: 2_000_000n, minTokensOut: 1n })]);
    for (const [mint, want] of [[addr(73), "mint_not_registered"], [addr(70), "mint_not_registered"], [addr(71), "mint_not_registered"]] as const)
      await expect(fw.authorize(key.id, buy(mint))).rejects.toMatchObject({ rule: want });
    await expect(fw.authorize(key.id, m([system.transfer(key.id, ATTACKER, 1n)]))).rejects.toMatchObject({ rule: "program_not_allowed" });
    await expect(fw.authorize(addr(74), compileMessage(addr(74), [pump.buyExactQuoteInV3({ ...lb(a1), user: addr(74), spendableQuoteIn: 1n, minTokensOut: 1n })], BH).bytes)).rejects.toMatchObject({ rule: "unknown_agent" });
    expect(fw.spentToday(key.id)).toBe(0n);
    const rows = readFileSync(join(dir, "firewall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.every((x) => x.ok === false && typeof x.rule === "string" && /^[0-9a-f]{64}$/.test(x.message_sha256))).toBe(true);
    expect(fw.counts.mint_not_registered).toBe(3);
  });

  test("the day ledger: the limit holds across calls and resets on the next UTC day", async () => {
    let now = Date.parse("2026-10-11T12:00:00Z");
    const { fw } = make({ limits: { ...LIMITS, min_out_bps: 0, max_tx_quote: 6_000_000n, max_day_quote: 10_000_000n }, now: () => now });
    const buy = () => fw.authorize(key.id, m([pump.buyExactQuoteInV3({ ...lb(a1), spendableQuoteIn: 6_000_000n, minTokensOut: 1n })]));
    await buy();
    await expect(buy()).rejects.toMatchObject({ rule: "max_day_value" });
    now += 86_400_000;
    await buy();
    expect(fw.spentToday(key.id)).toBe(6_000_000n);
  });

  test("limits that cannot be read, trading off, a chain that cannot be read: nothing signed", async () => {
    const buy = [pump.buyExactQuoteInV3({ ...lb(a1), spendableQuoteIn: 2_000_000n, minTokensOut: 1n })];
    await expect(make({ limits: null }).fw.authorize(key.id, m(buy))).rejects.toMatchObject({ rule: "no_limits" });
    await expect(make({ limits: { ...LIMITS, trading_enabled: false } }).fw.authorize(key.id, m(buy))).rejects.toMatchObject({ rule: "trading_off" });
    const dir = mkdtempSync(join(tmpdir(), "fw-"));
    const down = new AgentFirewall({ rpc: new Rpc(async () => { throw new Error("rpc down"); }), dir, identity: () => ({ agent: AGENT, ownMint: null }), limits: async () => LIMITS });
    await expect(down.authorize(key.id, m(buy))).rejects.toMatchObject({ rule: "context_unavailable" });
    const throwing = new AgentFirewall({ rpc: chainWorld().rpc, dir, identity: () => ({ agent: AGENT, ownMint: null }), limits: async () => { throw new Error("core down"); } });
    await expect(throwing.authorize(key.id, m(buy))).rejects.toMatchObject({ rule: "no_limits" });
  });

  test("lookup tables are read from chain: a frozen one resolves, one with an authority is refused", async () => {
    const v0 = compileMessageV0(key.id, [pump.buyExactQuoteInV3({ ...lb(a1), spendableQuoteIn: 2_000_000n, minTokensOut: 1n })], BH, [{ address: addr(130), addresses: [PUMP.global] }]).bytes;
    expect((await make().fw.authorize(key.id, v0)).kind).toBe("swap");
    await expect(make({ tableFrozen: false }).fw.authorize(key.id, v0)).rejects.toMatchObject({ rule: "lookup_table" });
    const unknown = compileMessageV0(key.id, [pump.buyExactQuoteInV3({ ...lb(a1), spendableQuoteIn: 2_000_000n, minTokensOut: 1n })], BH, [{ address: addr(131), addresses: [PUMP.global] }]).bytes;
    await expect(make().fw.authorize(key.id, unknown)).rejects.toMatchObject({ rule: "lookup_table" });
  });

  test("installed: the guarded key signs the allowed swap and cannot sign the transfer", async () => {
    const { fw } = make();
    fw.install();
    guardKey(key.id);
    const ok = compileMessage(key.id, [pump.buyExactQuoteInV3({ ...lb(a1), spendableQuoteIn: 2_000_000n, minTokensOut: 1n })], BH);
    await authorizeSigners(ok.bytes, [key.id]);
    expect(signBytes(key, ok.bytes).length).toBe(64);
    const bad = compileMessage(key.id, [system.transfer(key.id, ATTACKER, 5n)], BH);
    await expect(authorizeSigners(bad.bytes, [key.id])).rejects.toThrow(/program_not_allowed/);
    expect(() => signBytes(key, bad.bytes)).toThrow(/not_authorized/);
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

/**
 * An independent statement of what an allowed message may be, written without the policy's code
 * paths: every program is on the short list; in a swap every writable account is one of the accounts
 * the venue owns for that mint or an account the key owns; in the other kinds the key is read-only
 * and not the payer.
 */
function oracle(bytes: Uint8Array, c: FirewallContext): string | null {
  const m = parseMessageStrict(bytes, c.tables);
  const progs = new Set(m.instructions.map((i) => i.programId));
  const okProgs = new Set(["ComputeBudget111111111111111111111111111111", ASSOCIATED_TOKEN_PROGRAM, PUMP.program, PUMP.amm, msg.postBoard({ payer: RUNTIME, signer: KEY, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new Uint8Array(1) } } }).programId, registry.proposeOwner({ owner: KEY, agent: AGENT, newOwner: KEY }).programId]);
  for (const p of progs) if (!okProgs.has(p)) return `program ${p}`;
  const swapIx = m.instructions.find((i) => i.programId === PUMP.program || i.programId === PUMP.amm);
  if (!swapIx) return m.keys[0] === c.key ? "the key pays for a non-swap" : m.writable[m.keys.indexOf(c.key)] ? "the key is writable in a non-swap" : null;
  if (m.numSigners !== 1 || m.keys[0] !== c.key) return "swap signers";
  const mint = swapIx.accounts[swapIx.programId === PUMP.program ? 1 : 3]!.pubkey;
  if (!c.mints.get(mint)?.registered || mint === c.ownMint) return `mint ${mint}`;
  const curve = pumpPdas.bondingCurve(mint), pool = pumpPdas.pool(mint, c.quoteMint);
  const mine = new Set([c.key, ata(c.key, c.quoteMint, T22), ata(c.key, mint, T22), pumpPdas.userVolume(c.key), pumpPdas.ammUserVolume(c.key)]);
  const venue = new Set([curve, ata(curve, mint, T22), ata(curve, c.quoteMint, T22), pool, ata(pool, mint, T22), ata(pool, c.quoteMint, T22), ...PUMP.buybackRecipients.map((b) => ata(b, c.quoteMint, T22))]);
  for (let i = 0; i < m.keys.length; i++) if (m.writable[i] && !mine.has(m.keys[i]!) && !venue.has(m.keys[i]!)) return `writable account ${m.keys[i]} is neither the key's nor the venue's`;
  return null;
}

describe("property: fuzzed instruction lists", () => {
  const programs = [SYSTEM_PROGRAM, TOKEN_PROGRAM, T22, MEMO, ALT_PROGRAM, addr(99), LAUNCH_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM, PUMP.program, PUMP.amm, "ComputeBudget111111111111111111111111111111"];
  const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const accounts = [KEY, ATTACKER, RUNTIME, QUOTE, A, B, OWN, ata(KEY, QUOTE, T22), ata(ATTACKER, QUOTE, T22), ata(KEY, A, T22), ata(ATTACKER, A, T22), pumpPdas.bondingCurve(A), pumpPdas.pool(B, QUOTE), SYSTEM_PROGRAM, T22, addr(88), addr(89)];
  const builders: ((rnd: () => number) => Ix)[] = [
    () => curveBuy(), () => curveSell(), () => poolBuy(), () => poolSell(),
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

  test("4,000 random instruction lists: whatever is allowed satisfies the independent statement; nothing throws", () => {
    // (timeouts below: a cold run derives every program address once)
    const rnd = rng(20261011);
    let allowed = 0, refused = 0;
    const c = ctx();
    for (let i = 0; i < 4000; i++) {
      const n = 1 + Math.floor(rnd() * 4);
      const ixs = Array.from({ length: n }, () => pick(rnd, builders)(rnd));
      // a program id that is also an account elsewhere, or the payer as a program, cannot compile into a valid message
      if (ixs.some((ix) => ix.programId === KEY)) continue;
      const bytes = compileMessage(KEY, ixs, BH).bytes;
      const v = evaluate(bytes, c);
      if (v.ok) {
        allowed++;
        expect([i, oracle(bytes, c)]).toEqual([i, null]);
      } else refused++;
    }
    expect(allowed).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(2000);
  }, 60_000);

  test("every single-account mutation of a valid swap is refused", () => {
    const rnd = rng(7);
    const c = ctx();
    let n = 0;
    for (const make of [curveBuy, curveSell, poolBuy, poolSell]) {
      const ref = make();
      for (let i = 0; i < ref.keys.length; i++) {
        for (const sub of [ATTACKER, ata(ATTACKER, QUOTE, T22), addr(200 + Math.floor(rnd() * 40))]) {
          const ix = make();
          if (ix.keys[i]!.pubkey === sub) continue;
          ix.keys[i] = { ...ix.keys[i]!, pubkey: sub };
          const v = evaluate(compileMessage(KEY, [ix], BH).bytes, c);
          expect([make.name, i, v.ok]).toEqual([make.name, i, false]);
          n++;
        }
      }
      // dropped and reordered accounts
      const drop = make();
      drop.keys.pop();
      expect(evaluate(compileMessage(KEY, [drop], BH).bytes, c).ok).toBe(false);
      const swap = make();
      const [x, y] = swap.programId === PUMP.program ? [9, 10] : [5, 6]; // the user's base and quote accounts
      [swap.keys[x], swap.keys[y]] = [swap.keys[y]!, swap.keys[x]!];
      expect(evaluate(compileMessage(KEY, [swap], BH).bytes, c).ok).toBe(false);
    }
    expect(n).toBeGreaterThan(190);
  });

  test("every discriminator byte flip of a valid swap is refused", () => {
    const c = ctx();
    for (const make of [curveBuy, curveSell, poolBuy, poolSell])
      for (let i = 0; i < 8; i++)
        for (const bit of [1, 16, 128]) {
          const ix = make();
          ix.data = Uint8Array.from(ix.data);
          ix.data[i]! ^= bit;
          expect(evaluate(compileMessage(KEY, [ix], BH).bytes, c).ok).toBe(false);
        }
  });

  test("6,000 random byte flips of valid messages: refused, or still within the independent statement; the parser never throws out", () => {
    const rnd = rng(99);
    const c = ctx();
    const seeds = [msgOf([computeBudget.limit(300_000), ...pre(A), curveBuy()]), msgOf([poolSell()]), msgOf([curveSell()]), msgOf([msg.postBoard({ payer: RUNTIME, signer: KEY, agent: AGENT, args: { lineage: "ab".repeat(32), body: { inline: new Uint8Array(8) } } })], RUNTIME)];
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
    // flips inside the blockhash, an amount or a message body leave a valid transaction: those stay allowed
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
