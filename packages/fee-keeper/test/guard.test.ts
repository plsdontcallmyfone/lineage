import { describe, expect, test } from "bun:test";
import { computeBudget, PUMP, pump, r, system, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, w, Writer, type Address, type Ix } from "@units/chain";
import { actionIxs, extra, guardTransaction, parseConfig, type Action, type Snapshot } from "../src/index.ts";
import { fixture } from "./fake.ts";

// guard.ts on its own: what the instructions of a transaction may do to the wallet's $UNITS, read
// from the instructions themselves. The transactions the keeper builds pass; the same transactions
// with one instruction added or changed do not.

const OWNED = 25_000_000_000_000n; // 25,000,000 coins at 6 decimals
const cfg = parseConfig({ ...fixture.config, protected_units: OWNED.toString() });
const T22 = TOKEN_2022_PROGRAM;
const of = (kind: string) => fixture.transactions.find((t) => (t.action.kind === "buyback" ? `buyback-${t.action.venue}` : t.action.kind) === kind)!;
const snapOf = (s: Snapshot, held = 0n): Snapshot => ({ ...s, tokenAta: { ...s.tokenAta, exists: true, amount: OWNED }, burnAccount: { ...s.burnAccount, amount: held } });
const check = (s: Snapshot, a: Action, ixs: Ix[], over: { own?: bigint; protectedUnits?: bigint } = {}) => guardTransaction({
  ixs: [computeBudget.limit(100_000), computeBudget.price(1), ...ixs], action: a, creator: cfg.creator, mint: cfg.mint, tokenProgram: s.mint.program, decimals: s.mint.decimals,
  own: { address: s.tokenAta.address, amount: over.own ?? s.tokenAta.amount }, burn: { address: s.burnAccount.address, amount: s.burnAccount.amount }, protectedUnits: over.protectedUnits ?? cfg.protected_units });
const tok = (program: Address, keys: Ix["keys"], data: Uint8Array): Ix => ({ programId: program, keys, data });
const somewhere = cfg.compute_address;

describe("the check before signing", () => {
  const buyT = of("buyback-curve"), poolT = of("buyback-pool");
  const buy = buyT.action as Extract<Action, { kind: "buyback" }>, s = snapOf(buyT.snapshot), own = s.tokenAta.address, burnAcct = s.burnAccount.address;
  const good = actionIxs(cfg, s, buy);

  test("every transaction the keeper builds passes, with 25,000,000 of the owner's coins in the wallet's own account", () => {
    for (const t of fixture.transactions) expect(check(snapOf(t.snapshot), t.action, actionIxs(cfg, snapOf(t.snapshot), t.action))).toBeNull();
    for (const t of [buyT, poolT]) {
      const a = { ...t.action, burn: false } as Action;
      expect(check(snapOf(t.snapshot), a, actionIxs(cfg, snapOf(t.snapshot), a))).toBeNull();
    }
    const burn: Action = { kind: "burn", tokens: 7n };
    expect(check(snapOf(s, 7n), burn, actionIxs(cfg, snapOf(s, 7n), burn))).toBeNull();
  });

  test("the wallet's own account under protected_units: nothing is signed, whatever the transaction", () => {
    for (const t of fixture.transactions) {
      const why = check(snapOf(t.snapshot), t.action, actionIxs(cfg, snapOf(t.snapshot), t.action), { own: OWNED - 1n });
      expect(why).toContain(`holds ${OWNED - 1n} base units, under config.protected_units ${OWNED}`);
      expect(why).toStartWith(`refused before signing: the ${t.action.kind} transaction`);
    }
    expect(check(s, buy, good, { own: 0n, protectedUnits: 0n })).toBeNull();
  });

  test("any instruction naming the wallet's own account is refused: transfer, burn, close, approve, a sell, even a read", () => {
    const naming: Ix[] = [
      tok(T22, [w(own), r(cfg.mint), w(somewhere), r(cfg.creator, true)], new Writer().u8(12).u64(1n).u8(6).done()), // TransferChecked
      tok(T22, [w(own), w(somewhere), r(cfg.creator, true)], new Writer().u8(3).u64(1n).done()), // Transfer
      extra.burnChecked(own, cfg.mint, cfg.creator, buy.tokens, 6, T22), // the keeper's own burn, aimed at the wrong account
      extra.closeAccount(own, cfg.creator, cfg.creator, T22),
      tok(T22, [w(own), r(somewhere), r(cfg.creator, true)], new Writer().u8(4).u64(1n).done()), // Approve
      pump.sellV3({ mint: cfg.mint, quoteMint: PUMP.wsol, user: cfg.creator, userBase: own, amount: 1n, minQuoteOut: 1n }),
      pump.buyV3({ mint: cfg.mint, quoteMint: PUMP.wsol, user: cfg.creator, userBase: own, amount: 1n, maxQuoteIn: 1n }), // a buy into it is not the keeper's either
      tok(somewhere, [r(own)], Uint8Array.of(0)),
    ];
    for (const ix of naming) {
      expect(check(s, buy, [...good, ix])).toContain(`names the wallet's own $UNITS token account ${own}`);
      expect(check(s, { kind: "collect" }, [ix])).toContain("the keeper never touches it");
    }
    // the buy with its burn redirected to the wallet's own account
    expect(check(s, buy, [...good.slice(0, -1), extra.burnChecked(own, cfg.mint, cfg.creator, buy.tokens, 6, T22)])).toContain("names the wallet's own");
  });

  test("a burn in a buy's transaction is of exactly what the buy asks for", () => {
    const burnOf = (n: bigint) => [...good.slice(0, -1), extra.burnChecked(burnAcct, cfg.mint, cfg.creator, n, 6, T22)];
    expect(check(s, buy, burnOf(buy.tokens))).toBeNull();
    expect(check(s, buy, burnOf(buy.tokens + 1n))).toBe(`refused before signing: the buyback transaction burns ${buy.tokens + 1n} base units and buys ${buy.tokens}: a burn in a buy's transaction is of exactly what that buy delivers`);
    expect(check(snapOf(buyT.snapshot, OWNED), buy, burnOf(buy.tokens + OWNED))).toContain("a burn in a buy's transaction is of exactly what that buy delivers");
    expect(check(s, buy, burnOf(buy.tokens - 1n))).toContain("is of exactly what that buy delivers");
    expect(check(s, buy, [...good, good[good.length - 1]!])).toContain("burns from the keeper's burn account twice");
    expect(check(s, buy, good.slice(0, -1))).toContain("holds no burn and its plan burns what it buys");
    expect(check(s, { ...buy, burn: false }, good)).toContain("its plan burns nothing");
    expect(check(s, { ...buy, tokens: buy.tokens - 1n }, good)).toContain(`buys ${buy.tokens} base units, not the ${buy.tokens - 1n} of its plan`);
    // the burn before the buy, and a buy delivering somewhere else
    const [create, init, b, burn] = good as [Ix, Ix, Ix, Ix];
    expect(check(s, buy, [create, init, burn, b])).toContain("burns before its buy");
    expect(check(s, buy, [pump.buyV3({ mint: cfg.mint, quoteMint: PUMP.wsol, user: cfg.creator, userBase: somewhere, amount: buy.tokens, maxQuoteIn: 1n })])).toContain("holds no buy into the keeper's burn account");
    expect(check(s, buy, [...good, b])).toContain("buys twice");
  });

  test("a burn on its own: the planned amount, never more than the burn account holds, never with another instruction on that account", () => {
    const held = snapOf(buyT.snapshot, 100n), a: Action = { kind: "burn", tokens: 100n };
    const burn = (n: bigint) => [extra.burnChecked(burnAcct, cfg.mint, cfg.creator, n, 6, T22)];
    expect(check(held, a, burn(100n))).toBeNull();
    expect(check(held, a, burn(101n))).toContain("burns 101 base units, not the 100 of its plan");
    expect(check(held, { kind: "burn", tokens: 101n }, burn(101n))).toContain("burns 101 base units and the keeper's burn account");
    expect(check(held, a, [])).toContain("holds no burn of the keeper's burn account");
    expect(check(held, a, [...burn(100n), ...good.slice(2, 3)])).toContain("buys $UNITS, which a burn transaction never does");
    // Burn (unchecked), a burn signed by someone else, a burn of another mint's decimals: not the keeper's BurnChecked
    expect(check(held, a, [tok(T22, [w(burnAcct), w(cfg.mint), r(cfg.creator, true)], new Writer().u8(8).u64(100n).done())])).toContain("is not the keeper's own buy, burn or account creation");
    expect(check(held, a, [extra.burnChecked(burnAcct, cfg.mint, somewhere, 100n, 6, T22)])).toContain("is not the keeper's own buy, burn or account creation");
    expect(check(held, a, [extra.burnChecked(burnAcct, cfg.mint, cfg.creator, 100n, 9, T22)])).toContain("is not the keeper's own buy, burn or account creation");
    // a burn of some other token account of the wallet
    expect(check(held, a, [...burn(100n), extra.burnChecked(somewhere, cfg.mint, cfg.creator, 1n, 6, T22)])).toContain("which is not the keeper's burn account");
  });

  test("nothing else may touch the burn account: transfer, close, approve, authority, a sell, a foreign program", () => {
    const others: Ix[] = [
      tok(T22, [w(burnAcct), r(cfg.mint), w(somewhere), r(cfg.creator, true)], new Writer().u8(12).u64(1n).u8(6).done()),
      tok(T22, [w(burnAcct), w(somewhere), r(cfg.creator, true)], new Writer().u8(3).u64(1n).done()),
      tok(T22, [w(somewhere), w(burnAcct), r(cfg.creator, true)], new Writer().u8(3).u64(1n).done()), // a transfer in is not a buy either
      extra.closeAccount(burnAcct, cfg.creator, cfg.creator, T22),
      tok(T22, [w(burnAcct), r(somewhere), r(cfg.creator, true)], new Writer().u8(4).u64(1n).done()),
      tok(T22, [w(burnAcct), r(cfg.creator, true)], new Writer().u8(6).u8(2).u8(1).address(somewhere).done()), // SetAuthority
      pump.sellV3({ mint: cfg.mint, quoteMint: PUMP.wsol, user: cfg.creator, userBase: burnAcct, amount: 1n, minQuoteOut: 1n }),
      tok(somewhere, [w(burnAcct), r(cfg.creator, true)], Uint8Array.of(1, 2, 3)),
      extra.burnChecked(burnAcct, cfg.mint, cfg.creator, 1n, 6, TOKEN_PROGRAM), // the other token program
      extra.initializeAccount3(burnAcct, cfg.mint, somewhere, T22), // owned by someone else
      { ...extra.createAccountWithSeed(cfg.creator, "units-fee-keeper-burn", 1n, 165, somewhere), keys: [w(cfg.creator, true), w(burnAcct)] }, // created for another program
      { ...extra.createAccountWithSeed(cfg.creator, "units-fee-keeper-burn", 1n, 82, T22), keys: [w(cfg.creator, true), w(burnAcct)] }, // not a token account's size
      tok("11111111111111111111111111111111", [w(burnAcct, true), w(somewhere)], new Writer().u32(2).u64(1n).done()), // a System transfer out of it
    ];
    for (const ix of others) {
      const why = `touches the keeper's burn account ${burnAcct} and is not the keeper's own buy, burn or account creation`;
      expect(check(s, buy, [...good, ix])).toContain(why);
      expect(check(s, { kind: "compute", lamports: 1n }, [system.transfer(cfg.creator, somewhere, 1n), ix])).toContain(why);
    }
    // a collect or a compute transfer that buys or burns
    expect(check(s, { kind: "compute", lamports: 1n }, good)).toContain("buys or burns $UNITS, which a compute transaction never does");
    expect(check(snapOf(buyT.snapshot, 5n), { kind: "collect" }, [extra.burnChecked(burnAcct, cfg.mint, cfg.creator, 5n, 6, T22)])).toContain("which a collect transaction never does");
  });
});
