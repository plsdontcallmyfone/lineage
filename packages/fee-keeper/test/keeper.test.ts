import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PUMP, r, TOKEN_2022_PROGRAM, w, Writer, type Ix } from "@units/chain";
import { extra, loadState, MAINNET_GENESIS, readLog, runKeeper, type Action, type KeeperConfig, type RunReport } from "../src/index.ts";
import { BASE_FEE, Died, FakeChain, POINTS, testConfig, TOKEN_ACCOUNT_RENT, VAULT_RENT, VOLUME_RENT } from "./fake.ts";

// The keeper's state machine against a model of the chain (fake.ts): the money rules, the limits,
// the refusals, and an interruption at every point of every transaction.

const OWN = 1_000_000_000n;
const B = BigInt;
const opts = (cfg: KeeperConfig, over: Record<string, unknown> = {}) => ({ send: true, signer: cfg.creator, sleep: async () => undefined, pollMs: 0, resendMs: 0, ...over });
const run = (cfg: KeeperConfig, ch: FakeChain, over: Record<string, unknown> = {}) => runKeeper(cfg, ch, opts(cfg, over));
const state = (cfg: KeeperConfig) => loadState(cfg.state_path, cfg.mint, cfg.creator);
const ledger = (cfg: KeeperConfig) => { const s = state(cfg); return s.compute_owed + s.buyback_owed + s.reserve; };
const step = (r: RunReport, s: string) => r.steps.find((x) => x.step === s);
/** The wallet holds its own SOL plus exactly what the ledger says, and no transaction is in flight. */
function settled(cfg: KeeperConfig, ch: FakeChain) {
  expect(ch.wallet).toBe(OWN + ledger(cfg));
  expect(state(cfg).pending).toBeNull();
  expect(state(cfg).run).toBeNull();
}

describe("one run", () => {
  test("collect, split 50/50, pay compute, buy and burn in one transaction; the wallet's own SOL is untouched", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    const supply0 = ch.supply;
    const r = await run(cfg, ch);
    const rec = r.record!;
    const net = 100_000_000n - VAULT_RENT - BASE_FEE;
    expect([rec.collected_lamports, rec.collect_cost_lamports, rec.reserve_lamports]).toEqual(["100000000", (VAULT_RENT + BASE_FEE).toString(), "10000000"]);
    expect(rec.compute_share_lamports).toBe(((net - 10_000_000n) / 2n).toString());
    expect(rec.burn_share_lamports).toBe(rec.compute_share_lamports);
    expect(B(rec.collected_lamports)).toBe(B(rec.collect_cost_lamports) + B(rec.reserve_lamports) + B(rec.compute_share_lamports) + B(rec.burn_share_lamports));
    expect(ch.compute).toBe(B(rec.compute_share_lamports));
    expect(rec.compute_lamports).toBe(rec.compute_share_lamports);
    expect(supply0 - ch.supply).toBe(B(rec.units_bought));
    expect([rec.units_burned, rec.burn_signature]).toEqual([rec.units_bought, rec.buyback_signature]);
    expect(B(rec.units_bought) > 0n).toBe(true);
    expect(ch.tokens).toBe(0n);
    expect(B(rec.overhead_lamports)).toBe(2n * BASE_FEE + TOKEN_ACCOUNT_RENT + VOLUME_RENT);
    expect(state(cfg).reserve).toBe(10_000_000n - B(rec.overhead_lamports));
    expect([ch.count("collect"), ch.count("compute"), ch.count("buyback"), ch.count("burn")]).toEqual([1, 1, 1, 0]);
    expect(readLog(cfg.log_path)).toEqual([rec]);
    expect(rec.owed).toEqual({ compute_lamports: "0", buyback_lamports: state(cfg).buyback_owed.toString(), burn_units: "0", reserve_lamports: state(cfg).reserve.toString() });
    settled(cfg, ch);
  });

  test("a second run with nothing new sends nothing and writes nothing", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    await run(cfg, ch);
    const before = { wallet: ch.wallet, compute: ch.compute, supply: ch.supply, state: readFileSync(cfg.state_path, "utf8"), submits: ch.submits.length };
    ch.waiting = 4_999_999n; // under min_collect_lamports
    const r = await run(cfg, ch);
    expect(r.record).toBeNull();
    expect(r.steps.every((s) => s.result === "skipped")).toBe(true);
    expect({ wallet: ch.wallet, compute: ch.compute, supply: ch.supply, state: readFileSync(cfg.state_path, "utf8"), submits: ch.submits.length }).toEqual(before);
    expect(readLog(cfg.log_path).length).toBe(1);
  });

  test("a dry run plans every step from the predicted collection and changes nothing", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    const r = await runKeeper(cfg, ch, { send: false });
    expect(r.mode).toBe("dry-run");
    expect(r.steps.map((s) => [s.step, s.result])).toEqual([["collect", "would"], ["compute", "would"], ["buyback", "would"]]);
    const net = 100_000_000n - VAULT_RENT - BASE_FEE;
    expect(step(r, "collect")!.amounts).toMatchObject({ predicted_net_lamports: net.toString(), reserve_lamports: "10000000", compute_share_lamports: ((net - 10_000_000n) / 2n).toString() });
    expect(step(r, "compute")!.amounts!.compute_lamports).toBe(((net - 10_000_000n) / 2n).toString());
    expect([ch.submits.length, ch.wallet, ch.compute, ch.waiting]).toEqual([0, OWN, 0n, 100_000_000n]);
    expect(existsSync(cfg.state_path) || existsSync(cfg.log_path) || existsSync(`${cfg.state_path}.lock`)).toBe(false);
  });
});

describe("limits", () => {
  test("under min_collect_lamports nothing is collected; the first sweep's vault rent counts against it", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 4_999_999n;
    expect(step(await run(cfg, ch), "collect")).toMatchObject({ result: "skipped" });
    ch.waiting = 5_000_000n; // enough to look at, but the vault top-up and the fee leave less than the minimum
    const r = await run(cfg, ch);
    expect(step(r, "collect")!.detail).toContain("after its cost, under min_collect_lamports");
    expect([ch.submits.length, ch.wallet]).toEqual([0, OWN]);
    ch.waiting = 5_000_000n + VAULT_RENT + BASE_FEE;
    expect((await run(cfg, ch)).record!.collected_lamports).toBe((5_000_000n + VAULT_RENT + BASE_FEE).toString());
    expect(ch.count("collect")).toBe(1);
  });

  test("a buyback above max_buyback_lamports is spread over the next runs, one buy per run, without collecting again", async () => {
    const cfg = testConfig({ max_buyback_lamports: "20000000" }), ch = new FakeChain(cfg, OWN);
    ch.waiting = 120_000_000n;
    const first = (await run(cfg, ch)).record!;
    const share = B(first.burn_share_lamports);
    expect(B(first.buyback_lamports) <= 20_000_000n).toBe(true);
    let runs = 1;
    for (; runs < 10; runs++) {
      const r = await run(cfg, ch);
      if (!r.record) break;
      expect([r.record.collect_signature, r.record.compute_signature]).toEqual([null, null]);
      expect(B(r.record.buyback_lamports) <= 20_000_000n).toBe(true);
      settled(cfg, ch);
    }
    const log = readLog(cfg.log_path);
    expect([ch.count("collect"), ch.count("compute"), ch.count("buyback")]).toEqual([1, 1, log.length]);
    expect(log.length).toBe(3);
    expect(log.reduce((s, r) => s + B(r.buyback_lamports), 0n) + state(cfg).buyback_owed).toBe(share);
    expect(state(cfg).buyback_owed < 1_000_000n).toBe(true);
    expect(log.reduce((s, r) => s + B(r.units_burned), 0n)).toBe(ch.base.mint.supply - ch.supply);
  });

  test("the buy asks for what the budget buys at slippage_bps worse and caps its cost at the budget", async () => {
    for (const bps of [0, 100, 1000]) {
      const cfg = testConfig({ slippage_bps: bps, max_buyback_lamports: "30000000" }), ch = new FakeChain(cfg, OWN);
      ch.waiting = 200_000_000n;
      const seen: Action[] = [];
      const sign = ch.sign.bind(ch);
      ch.sign = async (a, s, c, p, k) => (seen.push(a), sign(a, s, c, p, k));
      await run(cfg, ch);
      const buy = seen.find((a) => a.kind === "buyback") as Extract<Action, { kind: "buyback" }>;
      expect(buy.maxLamports).toBe(30_000_000n);
      seen.length = 0;
      if (bps > 0) {
        const cfg0 = testConfig({ slippage_bps: 0, max_buyback_lamports: "30000000" }), ch0 = new FakeChain(cfg0, OWN);
        ch0.waiting = 200_000_000n;
        const sign0 = ch0.sign.bind(ch0);
        ch0.sign = async (a, s, c, p, k) => (seen.push(a), sign0(a, s, c, p, k));
        await run(cfg0, ch0);
        const buy0 = seen.find((a) => a.kind === "buyback") as Extract<Action, { kind: "buyback" }>;
        expect(buy.tokens < buy0.tokens).toBe(true);
      }
    }
  });

  test("under min_buyback_lamports the buyback share is carried, not sent", async () => {
    const cfg = testConfig({ min_buyback_lamports: "50000000" }), ch = new FakeChain(cfg, OWN);
    ch.waiting = 60_000_000n;
    const r = await run(cfg, ch);
    expect(step(r, "buyback")).toMatchObject({ result: "skipped" });
    expect([ch.count("buyback"), state(cfg).buyback_owed.toString()]).toEqual([0, r.record!.burn_share_lamports]);
    settled(cfg, ch);
  });

  test("a transaction whose fee and rent the reserve does not cover is not sent: the wallet's own SOL is never used", async () => {
    const cfg = testConfig({ fee_reserve_lamports: "1000000" }), ch = new FakeChain(cfg, OWN); // under the first buy's account rent
    ch.waiting = 100_000_000n;
    const r = await run(cfg, ch);
    expect(step(r, "buyback")!.detail).toContain("the fee reserve holds");
    expect([ch.count("collect"), ch.count("compute"), ch.count("buyback")]).toEqual([1, 1, 0]);
    settled(cfg, ch);
    const none = testConfig({ fee_reserve_lamports: "0" }), ch2 = new FakeChain(none, OWN);
    ch2.waiting = 100_000_000n;
    await run(none, ch2);
    expect([ch2.count("collect"), ch2.count("compute"), ch2.count("buyback"), ch2.compute]).toEqual([1, 0, 0, 0n]);
    expect(ch2.wallet).toBe(OWN + ledger(none));
  });

  test("the priority fee enters the fee bound and is paid from the reserve", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    ch.microLamports = 50_000;
    const r = await runKeeper(cfg, ch, { send: false });
    // 50000 simulated units * 1.2 + 5000 = 65000 CU at 50000 micro-lamports = 3250 lamports, plus the base fee
    expect(step(r, "collect")!.amounts).toMatchObject({ cu_limit: "65000", cu_price_micro_lamports: "50000", fee_bound_lamports: "8250" });
  });

  test("a compute share too small to open an empty compute address is carried", async () => {
    const cfg = testConfig({ fee_reserve_lamports: "5500000", min_collect_lamports: "100000" }), ch = new FakeChain(cfg, OWN);
    ch.waiting = 7_000_000n; // net 6104120, reserve 5500000, 302060 each
    const r = await run(cfg, ch);
    expect(step(r, "compute")!.detail).toContain("under the rent-exempt minimum");
    expect([ch.compute, state(cfg).compute_owed]).toEqual([0n, 302_060n]);
    ch.waiting = 3_000_000n;
    const r2 = await run(cfg, ch);
    expect(B(r2.record!.compute_lamports)).toBe(302_060n + B(r2.record!.compute_share_lamports));
    expect(ch.compute).toBe(B(r2.record!.compute_lamports));
  });
});

describe("refusals", () => {
  const refused = async (cfg: KeeperConfig, ch: FakeChain, over: Record<string, unknown> = {}) => {
    ch.waiting = 100_000_000n;
    const r = await run(cfg, ch, over);
    expect([r.steps.length, ch.submits.length, existsSync(cfg.state_path)]).toEqual([0, 0, false]);
    return r.refused.join(" | ");
  };
  test("mainnet: --send alone is not enough, enabled: true is needed too; the mint must be the $UNITS mint", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.genesis = MAINNET_GENESIS;
    expect(await refused(cfg, ch)).toContain("config.enabled is not true");
    const on = testConfig({ enabled: true }), ch2 = new FakeChain(on, OWN);
    ch2.genesis = MAINNET_GENESIS;
    expect(await refused(on, ch2, { mainnetUnitsMint: "GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump" })).toContain("on mainnet config.mint must be the $UNITS mint");
    const ch3 = new FakeChain(on, OWN);
    ch3.genesis = MAINNET_GENESIS;
    ch3.waiting = 100_000_000n;
    expect((await run(on, ch3, { mainnetUnitsMint: on.mint })).record).not.toBeNull();
    // enabled: true without --send is still a dry run
    const ch4 = new FakeChain(on, OWN);
    ch4.genesis = MAINNET_GENESIS;
    ch4.waiting = 100_000_000n;
    expect([(await runKeeper(on, ch4, { send: false })).mode, ch4.submits.length]).toEqual(["dry-run", 0]);
  });
  test("the creator on chain, the key, the pair and the compute address must match the config", async () => {
    const cfg = testConfig();
    let ch = new FakeChain(cfg, OWN);
    expect(await refused(cfg, ch, { signer: cfg.compute_address })).toContain("the key at config.key_path");
    expect(await refused(cfg, new FakeChain(cfg, OWN), { signer: null })).toContain("no key loaded");
    ch = new FakeChain(testConfig(), OWN);
    const other = testConfig({ creator: cfg.compute_address, compute_address: cfg.creator });
    const read = ch.read.bind(ch);
    ch.read = async () => ({ ...(await read()), curve: { ...(await read()).curve, creator: cfg.creator } });
    expect(await refused(other, ch, { signer: other.creator })).toContain("not config.creator");
    ch = new FakeChain(cfg, OWN);
    const read2 = ch.read.bind(ch);
    ch.read = async () => ({ ...(await read2()), curve: { ...(await read2()).curve, quoteMint: cfg.mint } });
    expect(await refused(cfg, ch)).toContain("not SOL");
    ch = new FakeChain(cfg, OWN);
    const read3 = ch.read.bind(ch);
    ch.read = async () => ({ ...(await read3()), compute: { lamports: 1n, owner: PUMP.program, executable: false } });
    expect(await refused(cfg, ch)).toContain("not a wallet");
    ch = new FakeChain(cfg, OWN);
    const read4 = ch.read.bind(ch);
    ch.read = async () => ({ ...(await read4()), compute: { lamports: 1n, owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true } });
    expect(await refused(cfg, ch)).toContain("is a program");
  });
  test("a state file of another coin or wallet is refused; a second keeper on the same state is refused", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    await run(cfg, ch);
    const moved = testConfig({ state_path: cfg.state_path, log_path: cfg.log_path, creator: cfg.compute_address, compute_address: cfg.creator });
    const ch2 = new FakeChain(moved, OWN);
    await expect(run(moved, ch2)).rejects.toThrow("belongs to mint");
    writeFileSync(`${cfg.state_path}.lock`, String(process.pid));
    await expect(run(cfg, ch)).rejects.toThrow("another keeper run holds");
    writeFileSync(`${cfg.state_path}.lock`, "999999999"); // a dead process: the lock is taken over
    expect((await run(cfg, ch)).refused).toEqual([]);
    expect(existsSync(`${cfg.state_path}.lock`)).toBe(false);
  });
  test("while the curve awaits migration the keeper collects and pays compute, and holds the buyback", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    const read = ch.read.bind(ch);
    ch.read = async () => ({ ...(await read()), phase: "awaiting_migration" as const });
    ch.waiting = 100_000_000n;
    const r = await run(cfg, ch);
    expect(step(r, "buyback")!.detail).toContain("not migrated yet");
    expect([ch.count("collect"), ch.count("compute"), ch.count("buyback")]).toEqual([1, 1, 0]);
    expect(state(cfg).buyback_owed.toString()).toBe(r.record!.burn_share_lamports);
  });
});

describe("interruptions", () => {
  /** Runs until a run completes without dying; returns how many runs died. */
  async function untilDone(cfg: KeeperConfig, ch: FakeChain): Promise<number> {
    for (let died = 0; ; died++) {
      try {
        await run(cfg, ch);
        return died;
      } catch (e) {
        if (!(e instanceof Died)) throw e;
        if (died > 5) throw new Error("did not recover");
      }
    }
  }
  for (const kind of ["collect", "compute", "buyback", "burn"] as const) for (const point of POINTS) {
    test(`killed at ${point} of the ${kind} transaction: the next run resumes and nothing is sent twice`, async () => {
      const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
      ch.fitsOne = kind !== "burn"; // a buy that cannot carry its burn: the burn is its own transaction
      ch.waiting = 100_000_000n;
      const supply0 = ch.supply;
      ch.die = { kind, point };
      const died = await untilDone(cfg, ch);
      expect(died).toBe(1);
      expect(ch.die).toBeNull();
      const log = readLog(cfg.log_path);
      expect(log.length).toBe(1);
      const rec = log[0]!;
      expect([ch.count("collect"), ch.count("compute"), ch.count("buyback"), ch.count("burn")]).toEqual([1, 1, 1, kind === "burn" ? 1 : 0]);
      expect(rec.collected_lamports).toBe("100000000");
      expect(B(rec.collected_lamports)).toBe(B(rec.collect_cost_lamports) + B(rec.reserve_lamports) + B(rec.compute_share_lamports) + B(rec.burn_share_lamports));
      expect(ch.compute).toBe(B(rec.compute_share_lamports));
      expect(rec.compute_share_lamports).toBe(rec.burn_share_lamports);
      expect(supply0 - ch.supply).toBe(B(rec.units_bought));
      expect(rec.units_burned).toBe(rec.units_bought);
      expect([ch.tokens, state(cfg).burn_owed]).toEqual([0n, 0n]);
      settled(cfg, ch);
      // every signature that was signed for a kind that landed is the one in the record: no second transaction was built
      expect(new Set(ch.landed.map((x) => x.signature)).size).toBe(ch.landed.length);
      const again = await run(cfg, ch);
      expect(again.record).toBeNull();
      expect(readLog(cfg.log_path).length).toBe(1);
    });
  }

  test("killed between the log line and closing the run: the line is not written twice and the next collection gets its own", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    await run(cfg, ch);
    const rec = readLog(cfg.log_path)[0]!;
    // put the run back as the crash would have left it: logged, not closed
    const s = state(cfg);
    s.run = { record: rec, done: ["compute", "buyback"], logged: false };
    writeFileSync(cfg.state_path, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
    ch.waiting = 50_000_000n;
    const r = await run(cfg, ch);
    const log = readLog(cfg.log_path);
    expect(log.length).toBe(2);
    expect(log[1]!.run_id).not.toBe(rec.run_id);
    expect([log[1]!.collected_lamports, r.record!.run_id]).toEqual(["50000000", log[1]!.run_id]);
    expect(ch.count("collect")).toBe(2);
    settled(cfg, ch);
  });

  test("a transaction that never lands expires: nothing is booked, and the next run builds a new one", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    ch.drop = true;
    const lost = ch.submit.bind(ch);
    let dropped: string | null = null;
    ch.submit = async (w) => {
      const sig = new TextDecoder().decode(w);
      if (dropped === null && ch.drop) dropped = sig;
      if (sig === dropped) { ch.submits.push(sig); ch.height += 10; return; } // the network never takes it
      return lost(w);
    };
    const r = await run(cfg, ch);
    expect(step(r, "collect")).toMatchObject({ result: "skipped", signature: dropped! });
    expect(step(r, "collect")!.detail).toContain("expired");
    expect([ch.count("collect"), ch.wallet, state(cfg).pending, r.record]).toEqual([0, OWN, null, null]);
    ch.drop = false;
    const r2 = await run(cfg, ch);
    expect([r2.record!.collected_lamports, r2.record!.collect_signature === dropped]).toEqual(["100000000", false]);
    settled(cfg, ch);
  });

  test("not confirmed within confirm_timeout_s: the run stops with the transaction recorded; the next run settles it and goes on", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    let t = 0;
    const slow = ch.status.bind(ch);
    let hide = true;
    ch.status = async (s) => (hide ? "unknown" : slow(s));
    const height = ch.blockHeight.bind(ch);
    ch.blockHeight = async () => (hide ? 1000 : height());
    const r = await run(cfg, ch, { now: () => new Date((t += 4000)), resendMs: 1e12 });
    expect(step(r, "collect")).toMatchObject({ result: "waiting" });
    expect([r.record, state(cfg).pending!.action.kind, ch.count("collect")]).toEqual([null, "collect", 1]); // it did land; the RPC had not shown it yet
    expect(readLog(cfg.log_path).length).toBe(0);
    hide = false;
    const r2 = await run(cfg, ch);
    expect(r2.record!.collected_lamports).toBe("100000000");
    expect([ch.count("collect"), ch.count("compute"), ch.count("buyback")]).toEqual([1, 1, 1]);
    settled(cfg, ch);
  });

  test("a transaction that lands with an error costs its fee from the reserve and moves nothing else", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    await run(cfg, ch);
    const before = state(cfg);
    ch.waiting = 50_000_000n;
    ch.failNext = true; // the collect fails on chain
    const r = await run(cfg, ch);
    expect(step(r, "collect")).toMatchObject({ result: "failed" });
    expect([ch.count("collect"), ch.waiting, r.record]).toEqual([1, 50_000_000n, null]);
    expect(state(cfg).reserve).toBe(before.reserve - BASE_FEE);
    expect(ch.wallet).toBe(OWN + ledger(cfg));
    const r3 = await run(cfg, ch);
    expect(r3.record!.collected_lamports).toBe("50000000");
    settled(cfg, ch);
  });

  test("a failed simulation sends nothing", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.waiting = 100_000_000n;
    ch.simFail = "collect";
    const r = await run(cfg, ch);
    expect(step(r, "collect")!.detail).toContain("the simulation failed");
    expect([ch.submits.length, ch.wallet]).toEqual([0, OWN]);
  });

  test("tokens owed to the burn that are not in the wallet are not burned from anything else", async () => {
    const cfg = testConfig(), ch = new FakeChain(cfg, OWN);
    ch.fitsOne = false;
    ch.waiting = 100_000_000n;
    ch.die = { kind: "burn", point: "sign" };
    await expect(run(cfg, ch)).rejects.toThrow(Died);
    const owed = state(cfg).burn_owed;
    expect(owed > 0n && ch.tokens === owed).toBe(true);
    ch.tokens = owed - 1n; // someone moved a base unit out
    const r = await run(cfg, ch);
    expect(step(r, "burn")!.detail).toContain("not burning");
    expect([ch.count("burn"), state(cfg).burn_owed]).toEqual([0, owed]);
    ch.tokens = owed + 500n; // coins someone sent into the keeper's burn account: only what the keeper bought is burned
    await run(cfg, ch);
    expect([ch.count("burn"), ch.tokens, state(cfg).burn_owed]).toEqual([1, 500n, 0n]);
  });
});

// The creator wallet is the owner's wallet: its own (associated) $UNITS token account holds the
// owner's 25,000,000 coins. The keeper buys into and burns from its own burn account, and whatever
// goes wrong with its accounting or its builder, those coins are not the source of a burn.
describe("the owner's coins in the creator wallet", () => {
  const OWNED = 25_000_000_000_000n; // 25,000,000 coins at 6 decimals
  const setup = (over: Record<string, unknown> = {}) => {
    const cfg = testConfig({ protected_units: OWNED.toString(), ...over }), ch = new FakeChain(cfg, OWN);
    ch.own = OWNED;
    ch.waiting = 100_000_000n;
    return { cfg, ch, supply0: ch.supply };
  };
  const died = (p: Promise<unknown>) => expect(p).rejects.toThrow(Died);
  const rawState = (cfg: KeeperConfig) => JSON.parse(readFileSync(cfg.state_path, "utf8")) as Record<string, unknown>;
  /** No signed transaction names the wallet's own token account. */
  const neverNamed = (ch: FakeChain) => expect(ch.signed.some((t) => t.ixs.some((i) => i.keys.some((k) => k.pubkey === ch.ownAccount)))).toBe(false);

  test("a normal run burns exactly what it bought, in the buy's transaction, and the 25,000,000 are intact", async () => {
    const { cfg, ch, supply0 } = setup();
    const rec = (await run(cfg, ch)).record!;
    const buy = ch.signed.find((t) => t.action.kind === "buyback")!.action as Extract<Action, { kind: "buyback" }>;
    expect(buy.burn).toBe(true);
    expect([rec.units_bought, rec.units_burned, (supply0 - ch.supply).toString()]).toEqual([buy.tokens.toString(), buy.tokens.toString(), buy.tokens.toString()]);
    expect([ch.own, ch.tokens, ch.count("buyback"), ch.count("burn")]).toEqual([OWNED, 0n, 1, 0]);
    expect([state(cfg).burn_owed, state(cfg).burn_floor, state(cfg).burn_account]).toEqual([0n, null, ch.burnAccount]);
    expect(ch.burnAccount).not.toBe(ch.ownAccount);
    neverNamed(ch);
    settled(cfg, ch);
  });

  test("a burn sent after its buy burns exactly the bought amount; the floor is what the burn account held before the buy", async () => {
    const { cfg, ch, supply0 } = setup();
    ch.fitsOne = false;
    ch.die = { kind: "burn", point: "sign" };
    await died(run(cfg, ch));
    const bought = ch.tokens;
    expect(bought > 0n).toBe(true);
    expect([state(cfg).burn_owed, state(cfg).burn_floor, ch.own, ch.supply]).toEqual([bought, 0n, OWNED, supply0]);
    const rec = (await run(cfg, ch)).record!;
    expect([rec.units_bought, rec.units_burned, (supply0 - ch.supply).toString()]).toEqual([bought.toString(), bought.toString(), bought.toString()]);
    expect([ch.own, ch.tokens, ch.count("buyback"), ch.count("burn")]).toEqual([OWNED, 0n, 1, 1]);
    expect([state(cfg).burn_owed, state(cfg).burn_floor]).toEqual([0n, null]);
    neverNamed(ch);
    settled(cfg, ch);
  });

  test("burn_owed inflated by a bogus amount: nothing is burned, the debt is kept, the 25,000,000 are intact", async () => {
    for (const bogus of [1n, 1_000_000n, OWNED]) {
      const { cfg, ch, supply0 } = setup();
      ch.fitsOne = false;
      ch.die = { kind: "burn", point: "sign" };
      await died(run(cfg, ch));
      const bought = ch.tokens, raw = rawState(cfg);
      raw.burn_owed = `${bought + bogus}n`;
      writeFileSync(cfg.state_path, JSON.stringify(raw));
      for (let i = 0; i < 2; i++) {
        const r = await run(cfg, ch);
        expect(step(r, "burn")).toMatchObject({ result: "skipped", amounts: { burn_owed_units: (bought + bogus).toString(), burn_account_units: bought.toString(), burn_floor_units: "0" } });
        expect(step(r, "burn")!.detail).toBe(`not burning: the keeper's burn account ${ch.burnAccount} holds ${bought} base units, ${bought + bogus} are owed to the burn and the account held 0 before the keeper's buys (burn_floor): a burn would take ${bogus} base units those buys did not add. The debt is kept; check the account and the state`);
      }
      expect([ch.count("burn"), ch.own, ch.tokens, ch.supply, state(cfg).burn_owed]).toEqual([0, OWNED, bought, supply0, bought + bogus]);
      neverNamed(ch);
    }
    // the same with coins already in the burn account before the buy (the floor): they are not burned for the bogus part either
    const { cfg, ch } = setup();
    ch.fitsOne = false;
    ch.ataExists = true;
    ch.tokens = 9_000_000n;
    ch.die = { kind: "burn", point: "sign" };
    await died(run(cfg, ch));
    const bought = ch.tokens - 9_000_000n, raw = rawState(cfg);
    expect(state(cfg).burn_floor).toBe(9_000_000n);
    raw.burn_owed = `${bought + 5n}n`;
    writeFileSync(cfg.state_path, JSON.stringify(raw));
    expect(step(await run(cfg, ch), "burn")!.detail).toContain("a burn would take 5 base units those buys did not add");
    raw.burn_owed = `${bought}n`;
    writeFileSync(cfg.state_path, JSON.stringify({ ...rawState(cfg), burn_owed: raw.burn_owed }));
    await run(cfg, ch);
    expect([ch.count("burn"), ch.tokens, ch.own]).toEqual([1, 9_000_000n, OWNED]);
  });

  test("the wallet's own account under protected_units: refused before anything; dropping under it mid-run refuses the next transaction before signing", async () => {
    const a = setup();
    a.ch.own = OWNED - 1n;
    const r = await run(a.cfg, a.ch);
    expect(r.refused).toEqual([`the wallet's own $UNITS token account ${a.ch.ownAccount} holds ${OWNED - 1n} base units, under config.protected_units ${OWNED}: nothing is signed until the owner checks the wallet or changes protected_units`]);
    expect([r.steps.length, a.ch.signed.length, a.ch.submits.length, existsSync(a.cfg.state_path)]).toEqual([0, 0, 0, false]);
    expect((await runKeeper(a.cfg, a.ch, { send: false })).refused.length).toBe(1);
    // the snapshot the compute transfer is built from still shows 25,000,000; the check runs on what is read right before signing
    const b = setup();
    const read = b.ch.read.bind(b.ch);
    let reads = 0;
    b.ch.read = async () => { const s = await read(); return ++reads >= 4 ? { ...s, tokenAta: { ...s.tokenAta, amount: OWNED - 1n } } : s; };
    const r2 = await run(b.cfg, b.ch);
    expect(r2.refused.length).toBe(1);
    expect(r2.refused[0]).toStartWith("refused before signing: the ");
    expect(r2.refused[0]).toContain(`holds ${OWNED - 1n} base units, under config.protected_units ${OWNED}`);
    const kinds = b.ch.signed.map((t) => t.action.kind);
    expect(kinds.includes("buyback")).toBe(false);
    expect([b.ch.submits.length, b.ch.count("buyback"), state(b.cfg).pending, b.ch.own]).toEqual([kinds.length, 0, null, OWNED]);
  });

  test("a crafted transaction (a transfer, a larger burn, a burn or a sale of the wallet's own coins) is refused before signing", async () => {
    const transferOut = (from: (ch: FakeChain) => string) => (ch: FakeChain, cfg: KeeperConfig): Ix =>
      ({ programId: TOKEN_2022_PROGRAM, keys: [w(from(ch)), r(cfg.mint), w(cfg.compute_address), r(cfg.creator, true)], data: new Writer().u8(12).u64(1_000_000n).u8(6).done() });
    const cases: { name: string; fits: boolean; kind: Action["kind"]; change: (ixs: Ix[], ch: FakeChain, cfg: KeeperConfig, a: Action) => Ix[]; says: string }[] = [
      { name: "transfer out of the wallet's own account", fits: true, kind: "buyback", change: (ixs, ch, cfg) => [...ixs, transferOut((c) => c.ownAccount)(ch, cfg)], says: "names the wallet's own $UNITS token account" },
      { name: "transfer out of the burn account", fits: true, kind: "buyback", change: (ixs, ch, cfg) => [...ixs, transferOut((c) => c.burnAccount)(ch, cfg)], says: "is not the keeper's own buy, burn or account creation" },
      { name: "burn of the wallet's own account", fits: true, kind: "buyback", change: (ixs, ch, cfg, a) => [...ixs.slice(0, -1), extra.burnChecked(ch.ownAccount, cfg.mint, cfg.creator, (a as { tokens: bigint }).tokens, 6, TOKEN_2022_PROGRAM)], says: "names the wallet's own $UNITS token account" },
      { name: "a larger burn in the buy's transaction", fits: true, kind: "buyback", change: (ixs, ch, cfg, a) => [...ixs.slice(0, -1), extra.burnChecked(ch.burnAccount, cfg.mint, cfg.creator, (a as { tokens: bigint }).tokens + OWNED, 6, TOKEN_2022_PROGRAM)], says: "a burn in a buy's transaction is of exactly what that buy delivers" },
      { name: "a larger burn on its own", fits: false, kind: "burn", change: (_ixs, ch, cfg, a) => [extra.burnChecked(ch.burnAccount, cfg.mint, cfg.creator, (a as { tokens: bigint }).tokens + 1n, 6, TOKEN_2022_PROGRAM)], says: "of its plan" },
      { name: "a burn on its own aimed at the wallet's own account", fits: false, kind: "burn", change: (_ixs, ch, cfg, a) => [extra.burnChecked(ch.ownAccount, cfg.mint, cfg.creator, (a as { tokens: bigint }).tokens, 6, TOKEN_2022_PROGRAM)], says: "names the wallet's own $UNITS token account" },
      { name: "a compute transfer that also moves the owner's coins", fits: true, kind: "compute", change: (ixs, ch, cfg) => [...ixs, transferOut((c) => c.ownAccount)(ch, cfg)], says: "names the wallet's own $UNITS token account" },
    ];
    for (const c of cases) {
      const { cfg, ch, supply0 } = setup();
      ch.fitsOne = c.fits;
      ch.tamper = (ixs, a) => (a.kind === c.kind ? c.change(ixs, ch, cfg, a) : ixs);
      const r = await run(cfg, ch);
      expect(r.refused.length).toBe(1);
      expect(r.refused[0]).toStartWith(`refused before signing: the ${c.kind} transaction`);
      expect(r.refused[0]).toContain(c.says);
      // nothing of that kind was signed or sent, nothing is in flight, and the coins are where they were
      expect(ch.signed.some((t) => t.action.kind === c.kind)).toBe(false);
      expect([ch.count(c.kind), state(cfg).pending, ch.own, ch.submits.length]).toEqual([0, null, OWNED, ch.signed.length]);
      expect(supply0 - ch.supply).toBe(0n);
      // the builder fixed: the next run finishes the work and the coins are still intact
      ch.tamper = null;
      await run(cfg, ch);
      expect([ch.own, ch.tokens, state(cfg).burn_owed, ch.count("buyback")]).toEqual([OWNED, 0n, 0n, 1]);
      expect(supply0 - ch.supply > 0n).toBe(true);
      settled(cfg, ch);
    }
  });

  test("the fake chain would show it: the same crafted burn, unchecked, takes the owner's coins", async () => {
    // what the check stands in front of: with the check switched off (a chain that does not call it), the burn lands on the wallet's own account
    const { cfg, ch } = setup();
    ch.tamper = (ixs, a) => (a.kind === "buyback" ? [...ixs.slice(0, -1), extra.burnChecked(ch.ownAccount, cfg.mint, cfg.creator, a.tokens, 6, TOKEN_2022_PROGRAM)] : ixs);
    const sign = ch.sign.bind(ch);
    ch.sign = (a, s, c, p) => sign(a, s, c, p, () => undefined);
    await run(cfg, ch);
    expect(ch.own < OWNED).toBe(true);
  });

  test("a state from before burn_floor existed, with a burn owed: nothing is burned until an operator sets burn_floor", async () => {
    const { cfg, ch, supply0 } = setup();
    ch.fitsOne = false;
    ch.die = { kind: "burn", point: "sign" };
    await died(run(cfg, ch));
    const bought = ch.tokens, raw = rawState(cfg);
    delete raw.burn_floor;
    delete raw.burn_account;
    writeFileSync(cfg.state_path, JSON.stringify(raw));
    expect([state(cfg).burn_owed, state(cfg).burn_floor]).toEqual([bought, null]);
    for (let i = 0; i < 2; i++) {
      ch.waiting = 100_000_000n; // a later buy sent without its burn does not set the floor on its own
      const r = await run(cfg, ch);
      expect(step(r, "burn")!.result).toBe("skipped");
      expect(step(r, "burn")!.detail).toContain("the state has no burn_floor (a state written before it existed, or edited): not burning. An operator sets burn_floor in");
      expect(step(r, "burn")!.amounts).toMatchObject({ burn_floor_units: "not set" });
    }
    expect([ch.count("burn"), ch.own, ch.supply, state(cfg).burn_floor]).toEqual([0, OWNED, supply0, null]);
    const owed = state(cfg).burn_owed;
    expect([owed, ch.count("buyback")]).toEqual([ch.tokens, 2]); // the interrupted run's own buy, then one more
    // the operator, with the timer stopped: burn_floor = what the burn account holds that the keeper did not buy (here nothing)
    writeFileSync(cfg.state_path, JSON.stringify({ ...rawState(cfg), burn_floor: "0n" }));
    ch.waiting = 0n;
    await run(cfg, ch);
    expect([ch.count("burn"), ch.own, ch.tokens, supply0 - ch.supply, state(cfg).burn_owed, state(cfg).burn_floor]).toEqual([1, OWNED, 0n, owed, 0n, null]);
    // a floor that is not an amount is refused, not guessed
    writeFileSync(cfg.state_path, JSON.stringify({ ...rawState(cfg), burn_floor: "25000000000000" }));
    await expect(run(cfg, ch)).rejects.toThrow("burn_floor is not null or a non-negative amount");
  });
});

// How a buy sent without its burn is booked: burn_owed is credited once, with the bought amount, only
// for a buy that landed without an error, whatever interrupts the run.
describe("booking a buy sent without its burn", () => {
  const OWNED = 25_000_000_000_000n;
  const setup = () => {
    const cfg = testConfig({ protected_units: OWNED.toString() }), ch = new FakeChain(cfg, OWN);
    ch.own = OWNED;
    ch.fitsOne = false;
    ch.waiting = 100_000_000n;
    ch.simFail = "burn"; // the burn is held back so the debt can be read
    return { cfg, ch, supply0: ch.supply };
  };
  const finish = async (cfg: KeeperConfig, ch: FakeChain, supply0: bigint, bought: bigint) => {
    ch.simFail = null;
    await run(cfg, ch);
    expect([ch.count("buyback"), ch.count("burn"), ch.tokens, ch.own, supply0 - ch.supply, state(cfg).burn_owed, state(cfg).burn_floor]).toEqual([1, 1, 0n, OWNED, bought, 0n, null]);
    settled(cfg, ch);
  };

  for (const point of POINTS) test(`killed at ${point} of the buy: burn_owed is credited once, with what the buy delivered`, async () => {
    const { cfg, ch, supply0 } = setup();
    ch.die = { kind: "buyback", point };
    await expect(run(cfg, ch)).rejects.toThrow(Died);
    // "sign": nothing was recorded. Later points: the signed bytes are in the state, booked or not
    expect(state(cfg).burn_owed).toBe(0n);
    expect(state(cfg).pending?.action.kind ?? null).toBe(point === "sign" ? null : "buyback");
    for (let i = 0; i < 3; i++) await run(cfg, ch); // three more runs: the same buy is never booked again
    const bought = ch.tokens;
    expect(bought > 0n).toBe(true);
    expect([ch.count("buyback"), state(cfg).burn_owed, state(cfg).burn_floor, ch.signed.filter((t) => t.action.kind === "buyback").length]).toEqual([1, bought, 0n, 1]);
    await finish(cfg, ch, supply0, bought);
  });

  test("a buy confirmed only after the run gave up waiting (resent meanwhile) is booked once by the next run", async () => {
    const { cfg, ch, supply0 } = setup();
    let t = 0, hide = false;
    const status = ch.status.bind(ch), height = ch.blockHeight.bind(ch), sign = ch.sign.bind(ch);
    ch.sign = async (a, s, c, p, k) => { if (a.kind === "buyback") hide = true; return sign(a, s, c, p, k); };
    ch.status = async (s) => (hide ? "unknown" : status(s));
    ch.blockHeight = async () => (hide ? 1000 : height());
    const r = await run(cfg, ch, { now: () => new Date((t += 2500)), resendMs: 1 });
    expect(step(r, "buyback")).toMatchObject({ result: "waiting" });
    const sig = state(cfg).pending!.signature;
    expect(ch.submits.filter((x) => x === sig).length > 1).toBe(true); // resent, the same bytes
    expect([ch.count("buyback"), state(cfg).burn_owed, state(cfg).pending!.action.kind]).toEqual([1, 0n, "buyback"]); // it landed once; not booked yet
    hide = false;
    for (let i = 0; i < 3; i++) await run(cfg, ch);
    const bought = ch.tokens;
    expect([ch.count("buyback"), state(cfg).burn_owed, bought > 0n]).toEqual([1, bought, true]);
    await finish(cfg, ch, supply0, bought);
  });

  test("a buy that never lands, or lands with an error, credits nothing and leaves no floor", async () => {
    // never lands: the network drops it and its blockhash expires
    const a = setup();
    const submit = a.ch.submit.bind(a.ch);
    let dropped: string | null = null;
    a.ch.submit = async (wire) => {
      const sig = new TextDecoder().decode(wire);
      if (a.ch.signed.find((t) => t.signature === sig)!.action.kind !== "buyback" || (dropped !== null && sig !== dropped)) return submit(wire);
      dropped = sig;
      a.ch.submits.push(sig);
      a.ch.height += 200;
    };
    const r = await run(a.cfg, a.ch);
    expect(step(r, "buyback")).toMatchObject({ result: "skipped", signature: dropped! });
    expect([a.ch.count("buyback"), a.ch.tokens, state(a.cfg).burn_owed, state(a.cfg).burn_floor, state(a.cfg).pending, a.ch.count("burn"), a.ch.own]).toEqual([0, 0n, 0n, null, null, 0, OWNED]);
    expect(step(r, "burn")).toBeUndefined(); // nothing owed: no burn was even considered
    // lands with an error: only its fee is paid
    const b = setup();
    const sign = b.ch.sign.bind(b.ch);
    b.ch.sign = async (x, s, c, p, k) => { if (x.kind === "buyback") b.ch.failNext = true; return sign(x, s, c, p, k); };
    const r2 = await run(b.cfg, b.ch);
    expect(step(r2, "buyback")).toMatchObject({ result: "failed" });
    expect([b.ch.tokens, state(b.cfg).burn_owed, state(b.cfg).burn_floor, b.ch.count("burn"), b.ch.own, b.ch.supply]).toEqual([0n, 0n, null, 0, OWNED, b.supply0]);
  });
});
