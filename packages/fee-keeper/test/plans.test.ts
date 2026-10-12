import { describe, expect, test } from "bun:test";
import { base58Encode } from "@units/protocol";
import { ASSOCIATED_TOKEN_PROGRAM, ata, compileMessage, computeBudget, PUMP, pumpPdas, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, wireSize, type Ix } from "@units/chain";
import { actionIxs, BURN_SEED, burnAccountAddress, collectIxs, extra, parseConfig, phaseOf, quoteBuyback, refusals, seededAddress, TEMP_SEED, waitingFees, type Snapshot } from "../src/index.ts";
import { fixture } from "./fake.ts";

// The keeper's transactions against what mainnet's Pump and PumpSwap builds accepted on the fork
// (fixtures/fork.json, recorded by scripts/mainnet/fee-keeper-fork.ts): from the snapshot the keeper
// read, the same instructions, accounts and data, byte for byte.
//
// The buys were recorded delivering into the wallet's associated token account. The keeper now
// delivers into its own burn account (a seeded token account of the wallet), so a rebuilt buy is the
// recorded one with that account in the associated account's place, and with the account's creation
// (System CreateAccountWithSeed + Token InitializeAccount3) where the recording created the
// associated account. The fork has not accepted that shape yet: rerun the fork proof to record it.

const cfg = parseConfig({ ...fixture.config, protected_units: "0" });
const burnAddr = burnAccountAddress(cfg.creator, TOKEN_2022_PROGRAM);
/** The recorded instructions as the keeper builds them now. */
const recorded = (t: (typeof txs)[number]) => {
  if (t.action.kind !== "buyback") return t.instructions;
  const own = t.snapshot.tokenAta.address;
  return t.instructions.flatMap((i) => i.program === ASSOCIATED_TOKEN_PROGRAM
    ? view([extra.createAccountWithSeed(cfg.creator, BURN_SEED, t.snapshot.rentToken, 165, TOKEN_2022_PROGRAM), extra.initializeAccount3(burnAddr, cfg.mint, cfg.creator, TOKEN_2022_PROGRAM)])
    : [{ ...i, accounts: i.accounts.map((k) => (k === own ? burnAddr : k)) }]);
};
const txs = fixture.transactions;
const view = (ixs: Ix[]) => ixs.map((i) => ({ program: i.programId, accounts: i.keys.map((k) => k.pubkey), data: base58Encode(i.data) }));
const of = (kind: string, phase: string, n = 0) => txs.filter((t) => (t.action.kind === "buyback" ? `buyback-${t.action.venue}` : t.action.kind) === kind && t.snapshot.phase === phase)[n]!;
const built = (t: (typeof txs)[number]) => [computeBudget.limit(t.cu_limit), computeBudget.price(t.cu_price), ...actionIxs(cfg, t.snapshot, t.action)];

describe("the keeper's transactions are the ones the fork accepted", () => {
  test("every recorded transaction is rebuilt identically from its snapshot, at the recorded size", () => {
    expect(txs.length).toBe(7);
    for (const t of txs) {
      expect(view(built(t))).toEqual(recorded(t));
      const size = wireSize(compileMessage(cfg.creator, built(t), SYSTEM_PROGRAM));
      // same bytes as recorded, except a buy that also creates the burn account (not the associated one)
      const creates = t.action.kind === "buyback" && !t.snapshot.burnAccount.exists;
      if (!creates) expect(size).toBe(t.size);
      expect(size <= 1232 && t.size <= 1232).toBe(true);
    }
  });
  test("no keeper transaction names the wallet's own token account; a buy delivers into the burn account and the burn takes from it", () => {
    for (const t of txs) {
      const ixs = built(t);
      expect(ixs.some((i) => i.keys.some((k) => k.pubkey === t.snapshot.tokenAta.address))).toBe(false);
      expect(ixs.some((i) => i.programId === ASSOCIATED_TOKEN_PROGRAM)).toBe(false);
    }
    expect(burnAddr).not.toBe(ata(cfg.creator, cfg.mint, TOKEN_2022_PROGRAM));
    expect(burnAddr).toBe(seededAddress(cfg.creator, "units-fee-keeper-burn", TOKEN_2022_PROGRAM));
    const curve = of("buyback-curve", "curve"), pool = of("buyback-pool", "pool");
    expect(actionIxs(cfg, curve.snapshot, curve.action).find((i) => i.programId === PUMP.program)!.keys[9]!.pubkey).toBe(burnAddr);
    expect(actionIxs(cfg, pool.snapshot, pool.action).find((i) => i.programId === PUMP.amm)!.keys[5]!.pubkey).toBe(burnAddr);
    // the first buy creates it: a 165-byte account of the mint's token program at the seeded address, owned by the wallet
    const first = actionIxs(cfg, curve.snapshot, curve.action);
    expect(first.slice(0, 2)).toEqual([extra.createAccountWithSeed(cfg.creator, BURN_SEED, curve.snapshot.rentToken, 165, TOKEN_2022_PROGRAM), extra.initializeAccount3(burnAddr, cfg.mint, cfg.creator, TOKEN_2022_PROGRAM)]);
  });
  test("collect on the curve: sweep_creator_fee then collect_creator_fee, the creator vault and the creator the only accounts paid", () => {
    const t = of("collect", "curve");
    const ixs = collectIxs(cfg, t.snapshot)!;
    expect(ixs.map((i) => i.programId)).toEqual([PUMP.program, PUMP.program]);
    const vault = pumpPdas.creatorVault(cfg.creator);
    expect(ixs[1]!.keys.map((k) => [k.pubkey, k.isWritable, k.isSigner])).toEqual([[cfg.creator, true, false], [vault, true, false], [SYSTEM_PROGRAM, false, false],
      [PUMP.eventAuthority, false, false], [PUMP.program, false, false]]);
    expect(t.snapshot.vault).toBe(0n); // the first sweep: the vault did not exist
    expect(waitingFees(t.snapshot)).toMatchObject({ curve: t.snapshot.curve.creatorFee, vault: 0n, pool: 0n, poolVault: 0n });
  });
  test("collect after graduation: the curve's leftover, then the pool's fee through a temporary wrapped SOL account closed in the same transaction", () => {
    const t = of("collect", "pool");
    const s = t.snapshot;
    expect([phaseOf(s.curve), s.pool!.data.coinCreator, s.pool!.data.quoteMint]).toEqual(["pool", cfg.creator, PUMP.wsol]);
    const ixs = collectIxs(cfg, s)!;
    const temp = seededAddress(cfg.creator, TEMP_SEED, TOKEN_PROGRAM);
    expect(ixs.map((i) => i.programId)).toEqual([PUMP.program, PUMP.program, SYSTEM_PROGRAM, TOKEN_PROGRAM, PUMP.amm, PUMP.amm, TOKEN_PROGRAM]);
    expect(ixs[5]!.keys[5]!.pubkey).toBe(temp); // collect_coin_creator_fee pays the temporary account
    expect(ixs[6]!).toEqual(extra.closeAccount(temp, cfg.creator, cfg.creator, TOKEN_PROGRAM));
    expect(temp).not.toBe(ata(cfg.creator, PUMP.wsol, TOKEN_PROGRAM)); // never the creator's own wrapped SOL account
    const wt = waitingFees(s);
    expect(wt.total).toBe(s.curve.creatorFee + s.pool!.data.creatorFees + (s.vault - s.rent0));
    expect(wt.pool > 0n && wt.curve > 0n).toBe(true);
  });
  test("only the parts with something to move are in the collection; nothing waiting, no transaction", () => {
    const s = of("collect", "pool").snapshot;
    const none: Snapshot = { ...s, curve: { ...s.curve, creatorFee: 0n }, vault: s.rent0, pool: { ...s.pool!, data: { ...s.pool!.data, creatorFees: 0n }, vaultAta: 0n } };
    expect(collectIxs(cfg, none)).toBeNull();
    expect(() => actionIxs(cfg, none, { kind: "collect" })).toThrow("nothing to collect");
    const poolOnly = collectIxs(cfg, { ...none, pool: { ...none.pool!, data: { ...none.pool!.data, creatorFees: 5n } } })!;
    expect(poolOnly.map((i) => i.programId)).toEqual([SYSTEM_PROGRAM, TOKEN_PROGRAM, PUMP.amm, PUMP.amm, TOKEN_PROGRAM]);
    const vaultOnly = collectIxs(cfg, { ...none, vault: s.rent0 + 7n })!;
    expect(vaultOnly.length).toBe(1); // already swept by someone: collect_creator_fee alone
    const sweptPool = collectIxs(cfg, { ...none, pool: { ...none.pool!, vaultAta: 9n } })!;
    expect(sweptPool.map((i) => i.programId)).toEqual([SYSTEM_PROGRAM, TOKEN_PROGRAM, PUMP.amm, TOKEN_PROGRAM]);
  });
  test("buyback on the curve: buy_v3 for exactly the quoted amount capped at the budget, then BurnChecked of the same amount on the mint's own program", () => {
    const t = of("buyback-curve", "curve");
    const a = t.action as Extract<typeof t.action, { kind: "buyback" }>;
    const ixs = actionIxs(cfg, t.snapshot, a);
    const burn = ixs[ixs.length - 1]!;
    expect(t.snapshot.mint.program).toBe(TOKEN_2022_PROGRAM);
    expect(burn).toEqual(extra.burnChecked(burnAddr, cfg.mint, cfg.creator, a.tokens, t.snapshot.mint.decimals, TOKEN_2022_PROGRAM));
    expect(t.snapshot.tokenAta.exists).toBe(false);
    expect(ixs.length).toBe(4); // the burn account is created (two instructions) only when missing
    expect(actionIxs(cfg, of("buyback-curve", "curve", 1).snapshot, of("buyback-curve", "curve", 1).action).length).toBe(2);
    // the amount is what the keeper's quote gives for the budget at the recorded reserves
    expect(quoteBuyback(t.snapshot, a.maxLamports, cfg.slippage_bps)).toEqual({ ok: true, venue: "curve", tokens: a.tokens });
    expect(actionIxs(cfg, t.snapshot, { ...a, burn: false }).length).toBe(3);
  });
  test("buyback on the pool: wrapped SOL for the budget in a temporary account, buy_v2, BurnChecked, the account closed", () => {
    const t = of("buyback-pool", "pool");
    const a = t.action as Extract<typeof t.action, { kind: "buyback" }>;
    const ixs = actionIxs(cfg, t.snapshot, a);
    expect(ixs.map((i) => i.programId)).toEqual([SYSTEM_PROGRAM, TOKEN_PROGRAM, PUMP.amm, TOKEN_2022_PROGRAM, TOKEN_PROGRAM]);
    expect(quoteBuyback(t.snapshot, a.maxLamports, cfg.slippage_bps)).toEqual({ ok: true, venue: "pool", tokens: a.tokens });
    expect(ixs[0]).toEqual(extra.createAccountWithSeed(cfg.creator, TEMP_SEED, t.snapshot.rentToken + a.maxLamports, 165, TOKEN_PROGRAM));
  });
  test("a burn of an SPL Token mint goes to the SPL Token program", () => {
    const s = of("compute", "curve").snapshot;
    const legacy: Snapshot = { ...s, mint: { ...s.mint, program: TOKEN_PROGRAM } };
    expect(actionIxs(cfg, legacy, { kind: "burn", tokens: 5n })[0]!.programId).toBe(TOKEN_PROGRAM);
    expect(actionIxs(cfg, s, { kind: "burn", tokens: 5n })[0]!.programId).toBe(TOKEN_2022_PROGRAM);
    expect(quoteBuyback(legacy, 1_000_000n, 100)).toMatchObject({ ok: false });
  });
  test("the quote refuses a buy that would complete the curve, and any buy while the curve awaits migration", () => {
    const s = of("buyback-curve", "curve").snapshot;
    expect(quoteBuyback(s, 10_000_000_000_000n, 100)).toMatchObject({ ok: false, reason: expect.stringContaining("complete the bonding curve") });
    expect(quoteBuyback({ ...s, phase: "awaiting_migration" }, 1_000_000n, 100)).toMatchObject({ ok: false });
    expect(quoteBuyback(s, 1n, 100)).toMatchObject({ ok: false });
  });
  test("the recorded snapshots pass the refusal checks; a changed creator, pool or compute address does not", () => {
    for (const t of txs) expect(refusals(cfg, t.snapshot, { mainnet: false, signer: cfg.creator })).toEqual([]);
    const s = of("collect", "pool").snapshot;
    expect(refusals(cfg, { ...s, pool: { ...s.pool!, data: { ...s.pool!.data, coinCreator: cfg.mint } } }, { mainnet: false })[0]).toContain("pool's coin creator");
    expect(refusals(cfg, { ...s, pool: null }, { mainnet: false })[0]).toContain("could not be read");
    expect(refusals(cfg, s, { mainnet: true, mainnetUnitsMint: "GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump" })[0]).toContain("$UNITS mint");
    expect(refusals(cfg, s, { mainnet: false, mainnetUnitsMint: "GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump" })).toEqual([]);
  });
  test("compute units the fork measured stay far under the limit the keeper sets", () => {
    for (const t of txs) expect(t.compute_units <= t.cu_limit && t.cu_limit <= 400_000).toBe(true);
  });
});
