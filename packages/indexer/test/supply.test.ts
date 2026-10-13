import { describe, expect, test } from "bun:test";
import { base58Encode } from "@units/protocol";
import { accountDisc, addressBytes, ata, launchPdas, openBountyPdas, PUMP, pumpPdas, registryPdas, Rpc, RpcError, seededAddress, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, toAddress, type Address,
  type Transport } from "@units/chain";
import { marketApi } from "../src/api.ts";
import { burnOf, decodeBurns, walletMoves } from "../src/burns.ts";
import { openDb } from "../src/db.ts";
import type { RawTx } from "../src/decode.ts";
import { breakdown, burnAgreement, categoryOf, CATEGORIES, KEEPER_BURN_SEED, SupplyIndexer, type Holding, type Known } from "../src/supply.ts";
import { USD_SCHEMA } from "../src/usd.ts";

// The Supply section's data (supply.ts, burns.ts): the burn decoder, the wallet movements, the supply
// breakdown adding up to the supply, the agreement of the two burn figures, the bounded history read
// (idempotent, resumable, nothing fetched twice, nothing fetched when nothing is missing), the routes
// and their honest empty state.

// ---------------------------------------------------------------------------------------------------
// builders

const key = (n: number) => toAddress(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 200 : i === 31 ? n & 255 : i === 30 ? (n >> 8) & 255 : 7)));
const MINT = key(1), OTHER_MINT = key(2), DEV = key(3), ALICE = key(4), BOB = key(5), PROGRAM_X = key(6), POOL_VAULT = key(7), LOOKED_UP = key(8);
const DEV_ATA = ata(DEV, MINT, TOKEN_2022_PROGRAM);
const KEEPER_BURN = seededAddress(DEV, KEEPER_BURN_SEED, TOKEN_2022_PROGRAM);
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const burnData = (amount: bigint) => cat(Uint8Array.of(8), u64(amount));
const burnCheckedData = (amount: bigint, decimals = 6) => cat(Uint8Array.of(15), u64(amount), Uint8Array.of(decimals));

interface IxSpec { program: string; accounts: string[]; data: Uint8Array; inner?: IxSpec[] }
let sigN = 0;
/** A getTransaction answer (encoding "json") with these instructions; `balances` are [account, mint, owner, before, after]. */
function mkTx(o: { slot: number; time?: number | null; ixs: IxSpec[]; payer?: string; failed?: boolean; balances?: [string, string, string, bigint | null, bigint | null][]; loaded?: string[]; sig?: string }): RawTx {
  const loaded = new Set(o.loaded ?? []);
  const keys: string[] = [o.payer ?? ALICE];
  const idx = (k: string) => (loaded.has(k) ? -1 : keys.includes(k) ? keys.indexOf(k) : keys.push(k) - 1);
  const all = o.ixs.flatMap((x) => [x, ...(x.inner ?? [])]);
  for (const x of all) { idx(x.program); x.accounts.forEach(idx); }
  for (const b of o.balances ?? []) idx(b[0]);
  const writable = [...loaded];
  const at = (k: string) => (loaded.has(k) ? keys.length + writable.indexOf(k) : keys.indexOf(k));
  const enc = (x: IxSpec) => ({ programIdIndex: at(x.program), accounts: x.accounts.map(at), data: base58Encode(x.data) });
  const bal = (which: 3 | 4) => (o.balances ?? []).filter((b) => b[which] !== null).map((b) => ({ accountIndex: at(b[0]), mint: b[1], owner: b[2], uiTokenAmount: { amount: String(b[which]), decimals: 6 } }));
  return {
    slot: o.slot, blockTime: o.time === undefined ? 1_791_850_000 + o.slot : o.time,
    transaction: { signatures: [o.sig ?? base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i < 4 ? (++sigN >> (8 * i)) & 255 : 9)))], message: { accountKeys: keys, instructions: o.ixs.map(enc) } },
    meta: { err: o.failed ? { InstructionError: [0, "Custom"] } : null, logMessages: [], innerInstructions: o.ixs.flatMap((x, i) => (x.inner?.length ? [{ index: i, instructions: x.inner.map(enc) }] : [])),
      preTokenBalances: bal(3), postTokenBalances: bal(4), loadedAddresses: { writable, readonly: [] } },
  };
}
const burnIx = (account: string, mint: string, authority: string, amount: bigint, program = TOKEN_2022_PROGRAM): IxSpec => ({ program, accounts: [account, mint, authority], data: burnData(amount) });

// ---------------------------------------------------------------------------------------------------

describe("burn decoder", () => {
  test("Burn (tag 8) at top level: account, mint, authority, amount, fee payer", () => {
    const tx = mkTx({ slot: 10, payer: DEV, ixs: [burnIx(DEV_ATA, MINT, DEV, 1_500_000n)] });
    expect(decodeBurns(tx)).toEqual([{ sig: tx.transaction.signatures[0]!, idx: 0, slot: 10, time: 1_791_850_010, mint: MINT, account: DEV_ATA, authority: DEV, amountRaw: 1_500_000n,
      checked: false, via: null, payer: DEV }]);
  });

  test("BurnChecked (tag 15) inside another program's instruction: `via` is that program, the authority its PDA", () => {
    const pda = key(40), vault = key(41);
    const tx = mkTx({ slot: 11, ixs: [
      { program: "ComputeBudget111111111111111111111111111111", accounts: [], data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0) },
      { program: PROGRAM_X, accounts: [vault, MINT, pda], data: Uint8Array.of(8, 1, 2, 3, 4, 5, 6, 7, 8), inner: [
        { program: TOKEN_2022_PROGRAM, accounts: [vault, MINT, ALICE, pda], data: cat(Uint8Array.of(12), u64(5n), Uint8Array.of(6)) }, // TransferChecked: not a burn
        { program: TOKEN_2022_PROGRAM, accounts: [vault, MINT, pda], data: burnCheckedData(42_000_000n) },
      ] },
    ] });
    const b = decodeBurns(tx);
    expect(b).toHaveLength(1);
    // position among all instructions in execution order: budget 0, program 1, its transfer 2, its burn 3
    expect(b[0]).toMatchObject({ idx: 3, mint: MINT, account: vault, authority: pda, amountRaw: 42_000_000n, checked: true, via: PROGRAM_X, payer: ALICE });
  });

  test("only the token programs burn: the same bytes sent to another program are nothing, and the legacy Token program counts", () => {
    expect(decodeBurns(mkTx({ slot: 12, ixs: [{ program: PROGRAM_X, accounts: [DEV_ATA, MINT, DEV], data: burnData(9n) }] }))).toEqual([]);
    expect(decodeBurns(mkTx({ slot: 12, ixs: [burnIx(DEV_ATA, MINT, DEV, 9n, TOKEN_PROGRAM)] }))).toHaveLength(1);
  });

  test("other token instructions and short data are not burns", () => {
    for (const tag of [3, 7, 9, 12, 14]) expect(burnOf(TOKEN_2022_PROGRAM, [DEV_ATA, MINT, DEV], cat(Uint8Array.of(tag), u64(5n), Uint8Array.of(6)))).toBeNull();
    expect(burnOf(TOKEN_2022_PROGRAM, [DEV_ATA, MINT, DEV], Uint8Array.of(8, 1, 2, 3))).toBeNull(); // Burn without its amount
    expect(burnOf(TOKEN_2022_PROGRAM, [DEV_ATA, MINT, DEV], cat(Uint8Array.of(15), u64(5n)))).toBeNull(); // BurnChecked without its decimals
    expect(burnOf(TOKEN_2022_PROGRAM, [DEV_ATA, MINT], burnData(5n))).toBeNull(); // no authority
    expect(burnOf(TOKEN_2022_PROGRAM, [DEV_ATA, MINT, DEV], burnData(5n))).toMatchObject({ amountRaw: 5n });
  });

  test("a failed transaction burned nothing", () => {
    expect(decodeBurns(mkTx({ slot: 13, failed: true, ixs: [burnIx(DEV_ATA, MINT, DEV, 9n)] }))).toEqual([]);
  });

  test("the mint filter keeps one coin's burns; several burns in one transaction keep their own positions", () => {
    const tx = mkTx({ slot: 14, ixs: [burnIx(DEV_ATA, MINT, DEV, 1n), burnIx(key(50), OTHER_MINT, ALICE, 2n), burnIx(DEV_ATA, MINT, DEV, 3n)] });
    expect(decodeBurns(tx).map((b) => [b.idx, b.mint, b.amountRaw])).toEqual([[0, MINT, 1n], [1, OTHER_MINT, 2n], [2, MINT, 3n]]);
    expect(decodeBurns(tx, new Set([MINT])).map((b) => [b.idx, b.amountRaw])).toEqual([[0, 1n], [2, 3n]]);
  });

  test("accounts loaded from a lookup table (version 0 and 1 transactions) are resolved", () => {
    const tx = mkTx({ slot: 15, loaded: [LOOKED_UP, MINT], ixs: [burnIx(LOOKED_UP, MINT, ALICE, 77n)] });
    expect(tx.transaction.message.accountKeys).not.toContain(MINT);
    expect(decodeBurns(tx)).toMatchObject([{ account: LOOKED_UP, mint: MINT, authority: ALICE, amountRaw: 77n }]);
  });
});

describe("wallet movements", () => {
  const swap: IxSpec = { program: PUMP.amm, accounts: [DEV_ATA], data: Uint8Array.of(1) };
  const transfer: IxSpec = { program: TOKEN_2022_PROGRAM, accounts: [DEV_ATA, MINT, key(60), DEV], data: cat(Uint8Array.of(12), u64(1n), Uint8Array.of(6)) };
  const kinds = (tx: RawTx) => walletMoves(tx, DEV_ATA, MINT).moves.map((m) => [m.kind, m.amountRaw]);

  test("coins in or out of a pump.fun or PumpSwap transaction are a buy or a sell; any other transaction is received or sent", () => {
    expect(kinds(mkTx({ slot: 1, ixs: [swap], balances: [[DEV_ATA, MINT, DEV, 100n, 350n]] }))).toEqual([["bought", 250n]]);
    expect(kinds(mkTx({ slot: 2, ixs: [swap], balances: [[DEV_ATA, MINT, DEV, 350n, 50n]] }))).toEqual([["sold", 300n]]);
    expect(kinds(mkTx({ slot: 3, ixs: [transfer], balances: [[DEV_ATA, MINT, DEV, 50n, 20n]] }))).toEqual([["sent", 30n]]);
    expect(kinds(mkTx({ slot: 4, ixs: [transfer], balances: [[DEV_ATA, MINT, DEV, null, 20n]] }))).toEqual([["received", 20n]]);
  });

  test("a burn is its own movement, apart from what else the transaction moved", () => {
    // a buy of 500 into the account and a burn of 500 from it in one transaction: the balance does not move, both are recorded
    const tx = mkTx({ slot: 5, ixs: [swap, burnIx(DEV_ATA, MINT, DEV, 500n)], balances: [[DEV_ATA, MINT, DEV, 40n, 40n]] });
    expect(kinds(tx)).toEqual([["burned", 500n], ["bought", 500n]]);
    expect(walletMoves(tx, DEV_ATA, MINT).balanceAfterRaw).toBe(40n);
    expect(kinds(mkTx({ slot: 6, ixs: [burnIx(DEV_ATA, MINT, DEV, 15n)], balances: [[DEV_ATA, MINT, DEV, 40n, 25n]] }))).toEqual([["burned", 15n]]);
  });

  test("a failed transaction, and one that only names the account, move nothing", () => {
    expect(walletMoves(mkTx({ slot: 7, failed: true, ixs: [swap], balances: [[DEV_ATA, MINT, DEV, 1n, 9n]] }), DEV_ATA, MINT)).toEqual({ moves: [], balanceAfterRaw: null });
    expect(walletMoves(mkTx({ slot: 8, ixs: [swap] }), DEV_ATA, MINT)).toEqual({ moves: [], balanceAfterRaw: null });
  });
});

// ---------------------------------------------------------------------------------------------------

const KNOWN = (): Known => ({ poolVaults: new Set([POOL_VAULT]), computeVaults: new Set([key(70), key(71)]), agentPoolVaults: new Set([key(72)]), launchBountyVaults: new Set([key(73)]),
  creatorPdas: new Set([key(74)]), launchAuthority: key(75), registryAuthority: key(76), bondVault: key(77), bountyAuthority: key(78), developerWallet: DEV });

describe("where the supply sits", () => {
  const k = KNOWN();
  const holdings: Holding[] = [
    { account: POOL_VAULT, owner: key(90), amountRaw: 400n },
    { account: key(70), owner: k.launchAuthority, amountRaw: 30n }, { account: key(71), owner: k.launchAuthority, amountRaw: 5n },
    { account: key(79), owner: k.launchAuthority, amountRaw: 7n }, // a claim escrow: the launch program's authority, not a compute vault
    { account: key(72), owner: key(91), amountRaw: 11n }, // an agent pool's vault
    { account: key(73), owner: k.launchAuthority, amountRaw: 13n }, // a bounty vault of the launch program
    { account: key(80), owner: k.bountyAuthority, amountRaw: 17n },
    { account: k.bondVault, owner: k.registryAuthority, amountRaw: 19n }, { account: key(81), owner: k.registryAuthority, amountRaw: 23n },
    { account: key(82), owner: key(74), amountRaw: 29n },
    { account: DEV_ATA, owner: DEV, amountRaw: 31n }, { account: KEEPER_BURN, owner: DEV, amountRaw: 2n },
    { account: key(83), owner: ALICE, amountRaw: 100n }, { account: key(84), owner: BOB, amountRaw: 50n }, { account: key(85), owner: BOB, amountRaw: 0n },
  ];
  const supply = holdings.reduce((n, h) => n + h.amountRaw, 0n);

  test("each account lands in one category", () => {
    const by = Object.fromEntries(breakdown(supply, holdings, k).rows.map((r) => [r.key, [r.accounts, r.amountRaw]]));
    expect(by).toEqual({ liquidity_pool: [1, 400n], wallets: [2, 150n], developer_wallet: [2, 33n], compute_vaults: [2, 35n], creator_fees: [1, 29n], verifier_bonds: [1, 19n],
      protocol_accounts: [1, 23n], bounty_escrows: [2, 30n], claims_and_pools: [2, 18n] });
    expect(categoryOf({ account: key(99), owner: key(98) }, k)).toBe("wallets");
    // without a developer wallet its accounts are wallets like any other
    expect(categoryOf({ account: DEV_ATA, owner: DEV }, { ...k, developerWallet: null })).toBe("wallets");
  });

  test("the rows add up to the supply read from the mint, exactly", () => {
    const b = breakdown(supply, holdings, k);
    expect(b.rows.reduce((n, r) => n + r.amountRaw, 0n)).toBe(supply);
    expect(b.driftRaw).toBe(0n);
    expect(b.rows.map((r) => r.key).sort()).toEqual(CATEGORIES.map((c) => c.key).sort());
  });

  test("they still add up when the accounts were listed a moment after a burn the mint read did not see yet: the difference is stated", () => {
    // the mint said 1,000 more than the accounts hold (a burn of 1,000 from a wallet landed between the two reads)
    const b = breakdown(supply + 1000n, holdings, k);
    expect(b.rows.reduce((n, r) => n + r.amountRaw, 0n)).toBe(supply + 1000n);
    expect(b.driftRaw).toBe(1000n);
    expect(b.accountsRaw).toBe(supply);
  });

  test("random holdings: the sum of the rows is always the supply", () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let round = 0; round < 50; round++) {
      const owners = [k.launchAuthority, k.registryAuthority, k.bountyAuthority, DEV, ALICE, BOB, key(74), key(120 + rnd(20))];
      const hs: Holding[] = Array.from({ length: 1 + rnd(60) }, (_, i) => ({ account: rnd(5) === 0 ? [POOL_VAULT, key(70), key(72), key(73), k.bondVault][rnd(5)]! + (i ? "" : "") : key(300 + i),
        owner: owners[rnd(owners.length)]!, amountRaw: BigInt(rnd(1_000_000)) * BigInt(rnd(1_000_000)) }));
      const s = hs.reduce((n, h) => n + h.amountRaw, 0n);
      const b = breakdown(s, hs, k);
      expect(b.rows.reduce((n, r) => n + r.amountRaw, 0n)).toBe(s);
      expect(b.driftRaw).toBe(0n);
    }
  });
});

describe("the two burn figures", () => {
  test("created supply minus supply now, against the sum of the stored burn instructions", () => {
    expect(burnAgreement(1_000n, 1_000n, 0n)).toEqual({ burnedRaw: 0n, indexedRaw: 0n, unmatchedRaw: 0n, agree: true });
    expect(burnAgreement(1_000n, 930n, 70n)).toEqual({ burnedRaw: 70n, indexedRaw: 70n, unmatchedRaw: 0n, agree: true });
    expect(burnAgreement(1_000n, 930n, 50n)).toMatchObject({ burnedRaw: 70n, unmatchedRaw: 20n, agree: false });
    expect(burnAgreement(1_000n, 930n, 80n)).toMatchObject({ unmatchedRaw: -10n, agree: false });
  });
});

// ---------------------------------------------------------------------------------------------------
// a chain: one mint with a signature list, a supply that falls with each burn, and the accounts the snapshot reads

const INITIAL = 1_000_000_000_000_000n;
interface Entry { tx: RawTx; failed: boolean }
function chain(o: { holders?: Holding[]; dev?: boolean } = {}) {
  const list: Entry[] = []; // oldest first
  const lists = new Map<string, Entry[]>(); // per token account
  let supply = INITIAL;
  let hidden = 0n; // supply that left without a burn instruction (to test the unmatched state)
  const asked: string[] = [];
  const calls: Record<string, number> = {};
  const state = { dieAfter: Infinity, served: 0, refuseTokenAccounts: false };
  const push = (tx: RawTx, account?: string, failed = false) => {
    const e = { tx, failed };
    list.push(e);
    if (account) lists.set(account, [...(lists.get(account) ?? []), e]);
    if (!failed) for (const b of decodeBurns(tx, new Set([MINT]))) supply -= b.amountRaw;
    return tx.transaction.signatures[0]!;
  };
  let slot = 100;
  const trade = () => push(mkTx({ slot: ++slot, ixs: [{ program: PUMP.amm, accounts: [POOL_VAULT, MINT], data: Uint8Array.of(1) }] }));
  const burn = (account: string, authority: string, amount: bigint, opts: { failed?: boolean; time?: number | null; via?: string } = {}) =>
    push(mkTx({ slot: ++slot, time: opts.time, payer: authority, failed: opts.failed, ixs: [opts.via ? { program: opts.via, accounts: [account, MINT, authority], data: Uint8Array.of(9), inner: [burnIx(account, MINT, authority, amount)] }
      : burnIx(account, MINT, authority, amount)], balances: account === DEV_ATA || account === KEEPER_BURN ? [[account, MINT, DEV, amount, 0n]] : [] }), account, opts.failed);
  const mintData = () => { const d = new Uint8Array(82); new DataView(d.buffer).setBigUint64(36, supply - hidden, true); d[44] = 6; d[45] = 1; return d; };
  const curveAddr = pumpPdas.bondingCurve(MINT);
  // a migrated curve: every reserve zero, the supply it was created with, a SOL pair (the zero key)
  const curveData = cat(accountDisc("BondingCurve"), u64(0n), u64(0n), u64(0n), u64(0n), u64(INITIAL), Uint8Array.of(1), addressBytes(DEV), Uint8Array.of(0, 0), new Uint8Array(32));
  const poolAddr = pumpPdas.pool(MINT, PUMP.wsol);
  const poolData = cat(accountDisc("Pool"), Uint8Array.of(255), Uint8Array.of(0, 0), addressBytes(DEV), addressBytes(MINT), addressBytes(PUMP.wsol), addressBytes(key(200)), addressBytes(POOL_VAULT),
    addressBytes(key(201)), u64(1n));
  const acc = (owner: string, data: Uint8Array) => ({ lamports: 1, owner, executable: false, rentEpoch: 0, data: [Buffer.from(data).toString("base64"), "base64"] });
  const transport: Transport = async (method, params) => {
    calls[method] = (calls[method] ?? 0) + 1;
    if (method === "getSignaturesForAddress") {
      const [addr, opt] = params as [string, { until?: string; before?: string; limit: number }];
      let l = [...(addr === MINT ? list : lists.get(addr) ?? [])].reverse().map((e) => ({ signature: e.tx.transaction.signatures[0]!, slot: e.tx.slot, err: e.failed ? { e: 1 } : null, blockTime: e.tx.blockTime }));
      if (opt.before) l = l.slice(l.findIndex((s) => s.signature === opt.before) + 1);
      if (opt.until) { const i = l.findIndex((s) => s.signature === opt.until); if (i >= 0) l = l.slice(0, i); }
      return l.slice(0, opt.limit);
    }
    if (method === "getTransaction") {
      const [sig] = params as [string];
      if (state.served >= state.dieAfter) throw new RpcError("getTransaction: gave up after 9 attempts (network: socket closed)");
      state.served++;
      asked.push(sig);
      return structuredClone(list.find((e) => e.tx.transaction.signatures[0] === sig)?.tx ?? null);
    }
    if (method === "getMultipleAccounts") {
      const [addrs] = params as [string[]];
      return { value: addrs.map((a) => (a === MINT ? acc(TOKEN_2022_PROGRAM, mintData()) : a === curveAddr ? acc(PUMP.program, curveData) : a === poolAddr ? acc(PUMP.amm, poolData) : null)) };
    }
    if (method === "getProgramAccounts") {
      const [program] = params as [string];
      if (program !== TOKEN_2022_PROGRAM) return [];
      if (state.refuseTokenAccounts) throw new RpcError("getProgramAccounts: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb excluded from account secondary indexes; this RPC method unavailable for key", -32010);
      return (o.holders ?? []).map((h) => ({ pubkey: h.account, account: { data: [Buffer.from(cat(addressBytes(h.owner as Address), u64(h.amountRaw))).toString("base64"), "base64"] } }));
    }
    throw new Error(`unexpected ${method}`);
  };
  const db = openDb(":memory:");
  db.exec(USD_SCHEMA);
  const rpc = new Rpc(transport);
  const clock = { t: 1_792_000_000 };
  const make = (maxFetchPerPass = 400) => new SupplyIndexer(db, rpc, (sig) => rpc.call<RawTx | null>("getTransaction", [sig, {}]), () => ({ mint: MINT, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM }),
    { devWallet: o.dev === false ? null : DEV, maxFetchPerPass, now: () => clock.t });
  const api = marketApi(db, () => ({}), { now: () => clock.t, usd: () => ({ ok: true, usd: 0.002, read_at: clock.t, age_s: 0, max_age_s: 300, quote_mint: MINT, pair_mint: PUMP.wsol, pair: "SOL", pair_per_quote: 1, pair_usd: 1,
    sol_usd: 1, venue: "pool", account: poolAddr, sources: { pair_per_quote: "", pair_usd: "" } }) });
  const get = async (path: string) => (await api(new Request(`http://x/market/${path}`))).json() as Promise<any>;
  return { db, make, get, api, trade, burn, asked, calls, state, clock, supply: () => supply - hidden, lose: (n: bigint) => { hidden += n; }, sigs: () => list.map((e) => e.tx.transaction.signatures[0]!) };
}
const stored = (db: ReturnType<typeof openDb>) => (db.query("SELECT amount_raw AS a FROM burns WHERE mint = ?").all(MINT) as { a: string }[]).reduce((n, r) => n + BigInt(r.a), 0n);
const ranges = (db: ReturnType<typeof openDb>) => (db.query("SELECT COUNT(*) AS n FROM supply_ranges").get() as { n: number }).n;

describe("reading the mint's history only while a burn is missing", () => {
  test("no burn: nothing is fetched, the cursor sits at the head, the figures agree at zero", async () => {
    const c = chain({ dev: false });
    for (let i = 0; i < 30; i++) c.trade();
    await c.make().pass();
    expect(c.asked).toEqual([]);
    expect(c.db.query("SELECT top_sig, unmatched_raw FROM supply_scan WHERE mint = ?").get(MINT)).toEqual({ top_sig: c.sigs().at(-1)!, unmatched_raw: "0" });
    const o = await c.get("supply");
    expect(o.burned).toMatchObject({ raw: "0", indexed_raw: "0", indexed_events: 0, agree: true, state: "agree" });
  });

  test("burns are found from the head backwards and the read stops as soon as the two figures agree", async () => {
    const c = chain({ dev: false });
    for (let i = 0; i < 40; i++) c.trade(); // old history that never needs reading
    c.burn(key(210), ALICE, 5_000_000n);
    for (let i = 0; i < 10; i++) c.trade();
    c.burn(key(211), BOB, 7_000_000n);
    for (let i = 0; i < 5; i++) c.trade();
    const ix = c.make();
    expect(await ix.pass()).toEqual({ more: false });
    expect(stored(c.db)).toBe(12_000_000n);
    expect(INITIAL - c.supply()).toBe(12_000_000n);
    // 5 trades, a burn, 10 trades, a burn: 17 transactions; the 40 older ones were never asked for
    expect(c.asked).toHaveLength(17);
    expect(ranges(c.db)).toBe(0);
    expect((await c.get("supply")).burned).toMatchObject({ raw: "12000000", indexed_raw: "12000000", agree: true, state: "agree", indexed_events: 2 });

    // idempotent: another pass, and another instance on the same database, fetch nothing
    await ix.pass();
    await c.make().pass();
    expect(c.asked).toHaveLength(17);
    expect(stored(c.db)).toBe(12_000_000n);
    expect((c.db.query("SELECT COUNT(*) AS n FROM burns").get() as { n: number }).n).toBe(2);
  });

  test("a burn after the figures agreed: only the signatures since the cursor are read", async () => {
    const c = chain({ dev: false });
    for (let i = 0; i < 20; i++) c.trade();
    c.burn(key(210), ALICE, 1_000n);
    const ix = c.make();
    await ix.pass();
    const before = c.asked.length;
    for (let i = 0; i < 3; i++) c.trade();
    await ix.pass(); // no burn since: nothing fetched, the cursor moves to the new head
    expect(c.asked.length).toBe(before);
    c.trade();
    const sig = c.burn(key(212), BOB, 2_000n);
    c.trade();
    await ix.pass();
    // the trade after the burn and the burn itself; the read stops there
    expect(c.asked.slice(before)).toEqual([c.sigs().at(-1)!, sig]);
    expect(stored(c.db)).toBe(3_000n);
  });

  test("a long history is read over several passes, resumes from its cursor, and no signature is fetched twice", async () => {
    const c = chain({ dev: false });
    c.burn(key(210), ALICE, 9_000n); // the oldest transaction of the mint
    for (let i = 0; i < 50; i++) c.trade();
    const ix = c.make(12);
    let passes = 0, more = true;
    while (more) {
      more = (await ix.pass()).more;
      passes++;
      if (more) { expect(ranges(c.db)).toBeGreaterThan(0); expect((await c.get("supply")).burned.state).toBe("reading"); }
      // a trade lands while the history is still being read: it is picked up as its own range
      if (passes === 2) c.trade();
      expect(passes).toBeLessThan(20);
    }
    expect(passes).toBeGreaterThan(4);
    expect(stored(c.db)).toBe(9_000n);
    expect(new Set(c.asked).size).toBe(c.asked.length);
    expect(c.asked).toHaveLength(52);
    expect(ranges(c.db)).toBe(0);
  });

  test("the RPC dies in the middle: what was read is kept, the next pass goes on from there", async () => {
    const c = chain({ dev: false });
    c.burn(key(210), ALICE, 4_000n);
    for (let i = 0; i < 30; i++) c.trade();
    c.state.dieAfter = 10;
    await expect(c.make().pass()).rejects.toThrow(/gave up/);
    expect(c.asked).toHaveLength(10);
    expect(ranges(c.db)).toBe(1);
    expect(c.db.query("SELECT last_error FROM supply_scan WHERE mint = ?").get(MINT)).toMatchObject({ last_error: expect.stringContaining("gave up") });
    c.state.dieAfter = Infinity;
    await c.make().pass(); // a restart: a new instance on the same database
    expect(new Set(c.asked).size).toBe(c.asked.length);
    expect(c.asked).toHaveLength(31);
    expect(stored(c.db)).toBe(4_000n);
    expect((await c.get("supply")).burned.agree).toBe(true);
  });

  test("a failed transaction is never fetched", async () => {
    const c = chain({ dev: false });
    c.burn(key(210), ALICE, 4_000n);
    const failed = c.burn(key(210), ALICE, 99_000n, { failed: true });
    c.trade();
    await c.make().pass();
    expect(c.asked).not.toContain(failed);
    expect(stored(c.db)).toBe(4_000n);
  });

  test("supply that left without a burn instruction is stated, after the list was read once, and the list is not read again", async () => {
    const c = chain({ dev: false });
    c.burn(key(210), ALICE, 4_000n);
    for (let i = 0; i < 6; i++) c.trade();
    c.lose(1_500n);
    const ix = c.make();
    await ix.pass();
    expect(c.asked).toHaveLength(7);
    expect((await c.get("supply")).burned).toMatchObject({ raw: "5500", indexed_raw: "4000", unmatched_raw: "1500", agree: false, state: "unmatched" });
    await ix.pass();
    await ix.pass();
    expect(c.asked).toHaveLength(7);
  });
});

describe("the developer wallet", () => {
  test("its burns are found through its own token account, so the mint's list is not read at all", async () => {
    const c = chain();
    for (let i = 0; i < 25; i++) c.trade();
    c.burn(DEV_ATA, DEV, 60_000_000n);
    for (let i = 0; i < 25; i++) c.trade();
    await c.make().pass();
    expect(c.asked).toHaveLength(1);
    expect(stored(c.db)).toBe(60_000_000n);
    const o = await c.get("supply");
    expect(o.burned).toMatchObject({ agree: true, indexed_events: 1 });
    expect(o.developer).toMatchObject({ wallet: DEV, burned: { events: 1, raw: "60000000", share_of_initial: 60_000_000 / Number(INITIAL) } });
  });

  test("burns by signer: the developer wallet, the fee keeper's own account, another wallet; the filter and the dollars of the time", async () => {
    const c = chain();
    const t0 = 1_791_900_000;
    c.db.query("INSERT INTO quote_usd_samples (t, usd, pair_usd, pair_per_quote, venue) VALUES (?, 0.001, 1, 1, 'pool'), (?, 0.003, 1, 1, 'pool')").run(t0, t0 + 86_400);
    const s1 = c.burn(DEV_ATA, DEV, 10_000_000n, { time: t0 + 60 });
    const s2 = c.burn(KEEPER_BURN, DEV, 4_000_000n, { time: t0 + 86_400 + 60 });
    const s3 = c.burn(key(210), ALICE, 1_000_000n, { time: t0 + 86_400 + 120, via: PROGRAM_X });
    const s4 = c.burn(key(211), BOB, 500_000n, { time: t0 - 90_000 }); // before any reading was stored
    c.clock.t = t0 + 2 * 86_400 + 5;
    await c.make().pass();
    const all = await c.get("supply/burns");
    expect(all.signers).toEqual({ all: 4, developer: 1, fee_keeper: 1, agent_pool: 0, other: 2 });
    const by = Object.fromEntries(all.events.map((e: any) => [e.signature, e]));
    expect(by[s1]).toMatchObject({ amount: 10, usd: 0.01, usd_basis: "at_time", signer: { kind: "developer", label: "Developer wallet", address: DEV }, via: null });
    expect(by[s2]).toMatchObject({ amount: 4, usd: 0.012, signer: { kind: "fee_keeper", label: "Fee keeper" } });
    expect(by[s3]).toMatchObject({ amount: 1, usd: 0.003, signer: { kind: "address", address: ALICE }, via: PROGRAM_X });
    // no reading for its time: no dollar figure, never today's price in its place
    expect(by[s4]).toMatchObject({ amount: 0.5, usd: null, usd_basis: null });
    expect(all.usd_at_burn).toBeNull();
    // one bar per UTC day from the first burn to today, with the running total
    expect(all.days.map((d: any) => [d.events, d.amount, d.cumulative])).toEqual([[1, 0.5, 0.5], [1, 10, 10.5], [2, 5, 15.5], [0, 0, 15.5]]);
    expect(all.days[0].usd).toBeNull();
    expect(all.days[1].usd).toBeCloseTo(0.01, 9);

    const dev = await c.get("supply/burns?signer=developer");
    expect(dev.events.map((e: any) => e.signature)).toEqual([s1]);
    expect(dev).toMatchObject({ count: 1, amount: 10, usd_at_burn: 0.01 });
    const o = await c.get("supply");
    expect(o.burned.by_signer.map((g: any) => [g.kind, g.label, g.raw])).toEqual([["developer", "Developer wallet", "10000000"], ["fee_keeper", "Fee keeper", "4000000"], ["address", "Other wallets", "1500000"]]);
    expect(o.developer.burned).toMatchObject({ events: 1, amount: 10, usd_at_burn: 0.01 });
    expect(o.burned.usd_at_burn).toBeNull();
  });

  test("its balance after each transaction and what it did, from its token accounts' own lists", async () => {
    const c = chain({ holders: [{ account: DEV_ATA, owner: DEV, amountRaw: 0n }] });
    c.burn(DEV_ATA, DEV, 25_000_000n);
    await c.make().pass();
    const d = await c.get("supply/developer");
    expect(d).toMatchObject({ ok: true, wallet: DEV, synced: true, balance_raw: "0" });
    expect(d.activity.burned).toMatchObject({ count: 1, amount: 25 });
    expect(d.activity.bought).toMatchObject({ count: 0, amount: 0 });
    expect(d.history).toHaveLength(1);
    expect(d.history[0]).toMatchObject({ balance: 0 });
    expect(d.moves).toMatchObject([{ kind: "burned", amount: 25 }]);
  });
});

describe("routes and their empty state", () => {
  test("before the first read: the reason in words, no figure", async () => {
    const c = chain();
    for (const p of ["supply", "supply/burns", "supply/developer", "supply/holders"]) expect(await c.get(p)).toMatchObject({ ok: false, reason: "the supply has not been read yet" });
    expect(await c.get("supply/coins")).toMatchObject({ ok: true, coins: [], totals: { coins: 0 } });
    expect((await c.api(new Request("http://x/market/supply/nothing"))).status).toBe(404);
    expect((await c.api(new Request("http://x/market/supply/burns/more"))).status).toBe(404);
  });

  test("no burn yet: zero burned by both counts, no events, no days, nothing dressed as a chart", async () => {
    const c = chain({ holders: [{ account: POOL_VAULT, owner: key(90), amountRaw: 700n }, { account: key(83), owner: ALICE, amountRaw: INITIAL - 700n }] });
    for (let i = 0; i < 3; i++) c.trade();
    await c.make().pass();
    const o = await c.get("supply");
    expect(o).toMatchObject({ ok: true, supply_raw: String(INITIAL), initial_supply_raw: String(INITIAL), mint_authority: null });
    expect(o.burned).toMatchObject({ amount: 0, raw: "0", indexed_events: 0, agree: true, usd_at_burn: 0, first_at: null, by_signer: [] });
    const b = await c.get("supply/burns");
    expect(b).toMatchObject({ ok: true, count: 0, amount: 0, events: [], days: [] });
    expect(o.developer.burned).toMatchObject({ events: 0, amount: 0 });
  });

  test("the breakdown served adds up to the supply; shares and dollars come from it; top holders carry labels", async () => {
    const holders: Holding[] = [
      { account: POOL_VAULT, owner: key(90), amountRaw: 400_000_000_000_000n }, { account: DEV_ATA, owner: DEV, amountRaw: 100_000_000_000_000n },
      { account: launchPdas.computeVault(key(230)), owner: launchPdas.authority(), amountRaw: 1_000_000n }, // not in a launch record here: a launch-program account, so an escrow
      { account: registryPdas.bondVault(), owner: registryPdas.vaultAuthority(), amountRaw: 50_000_000_000_000n },
      { account: key(86), owner: openBountyPdas.authority(), amountRaw: 25_000_000_000_000n },
      { account: key(83), owner: ALICE, amountRaw: 300_000_000_000_000n }, { account: key(84), owner: BOB, amountRaw: 100_000_000_000_000n },
      { account: key(85), owner: BOB, amountRaw: 24_999_999_000_000n },
    ];
    const c = chain({ holders });
    await c.make().pass();
    const o = await c.get("supply");
    const sum = o.breakdown.reduce((n: bigint, r: any) => n + BigInt(r.amount_raw), 0n);
    expect(sum).toBe(BigInt(o.supply_raw));
    expect(o.drift_raw).toBe("0");
    const row = (k: string) => o.breakdown.find((r: any) => r.key === k);
    expect(row("liquidity_pool")).toMatchObject({ label: "Liquidity pool", accounts: 1, amount: 400_000_000, share: 0.4, usd: 800_000 });
    expect(row("wallets")).toMatchObject({ accounts: 3, share: 0.424999999 });
    expect(row("developer_wallet")).toMatchObject({ amount: 100_000_000, share: 0.1 });
    expect(row("verifier_bonds").amount).toBe(50_000_000);
    expect(row("bounty_escrows").amount).toBe(25_000_000);
    expect(row("claims_and_pools").amount).toBe(1);
    expect(o.breakdown.reduce((n: number, r: any) => n + r.share, 0)).toBeCloseTo(1, 8);
    expect(o.supply_usd).toBe(2_000_000);
    expect(o.developer).toMatchObject({ balance: 100_000_000, share: 0.1, balance_usd: 200_000 });

    const h = await c.get("supply/holders?limit=4");
    expect(h.top.map((t: any) => [t.rank, t.kind, t.label, t.accounts, t.share])).toEqual([[1, "liquidity_pool", "Liquidity pool", 1, 0.4], [2, "wallets", `${ALICE.slice(0, 4)}…${ALICE.slice(-4)}`, 1, 0.3],
      [3, "wallets", `${BOB.slice(0, 4)}…${BOB.slice(-4)}`, 2, 0.124999999], [4, "developer_wallet", "Developer wallet", 1, 0.1]]);
    expect(h).toMatchObject({ wallets: 3, token_accounts: 8 });
    expect(h.concentration.top10_share).toBeCloseTo(1, 8);
    expect(h.concentration.top10_wallets_share).toBeCloseTo(0.524999999, 8);
  });

  test("an RPC that does not list token accounts: the supply and the burns are still served, the breakdown says why it is missing", async () => {
    const c = chain();
    c.state.refuseTokenAccounts = true;
    c.burn(DEV_ATA, DEV, 3_000n);
    await c.make().pass();
    const o = await c.get("supply");
    expect(o).toMatchObject({ ok: true, breakdown: null, holders: null, breakdown_reason: "the RPC of this instance does not list the coin's token accounts" });
    expect(o.burned).toMatchObject({ raw: "3000", agree: true });
    expect(await c.get("supply/holders")).toMatchObject({ ok: false, top: [] });
  });

  test("without a dollar reading every dollar figure is null", async () => {
    const c = chain({ holders: [{ account: key(83), owner: ALICE, amountRaw: INITIAL }] });
    await c.make().pass();
    const api = marketApi(c.db, () => ({}), { now: () => c.clock.t });
    const o = (await (await api(new Request("http://x/market/supply"))).json()) as any;
    expect(o.usd.ok).toBe(false);
    expect(o.supply_usd).toBeNull();
    expect(o.breakdown.every((r: any) => r.usd === null)).toBe(true);
    expect(o.developer.balance_usd).toBeNull();
  });
});
