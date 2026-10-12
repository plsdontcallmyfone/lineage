import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PUMP } from "@units/chain";
import { loadState, MAINNET_GENESIS, readLog, runKeeper, type Action, type KeeperConfig, type RunReport } from "../src/index.ts";
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
      ch.sign = async (a, s, c, p) => (seen.push(a), sign(a, s, c, p));
      await run(cfg, ch);
      const buy = seen.find((a) => a.kind === "buyback") as Extract<Action, { kind: "buyback" }>;
      expect(buy.maxLamports).toBe(30_000_000n);
      seen.length = 0;
      if (bps > 0) {
        const cfg0 = testConfig({ slippage_bps: 0, max_buyback_lamports: "30000000" }), ch0 = new FakeChain(cfg0, OWN);
        ch0.waiting = 200_000_000n;
        const sign0 = ch0.sign.bind(ch0);
        ch0.sign = async (a, s, c, p) => (seen.push(a), sign0(a, s, c, p));
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
    ch.tokens = owed + 500n; // the wallet's own $UNITS sit in the same account: only what the keeper bought is burned
    await run(cfg, ch);
    expect([ch.count("burn"), ch.tokens, state(cfg).burn_owed]).toEqual([1, 500n, 0n]);
  });
});
