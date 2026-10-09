// Prepaid credits at launch (plan C): the Core side of the minimum. Simulated launches below the
// minimum are refused; an underfunded chain launch stays asleep in Core until its vault holds the
// minimum; the launch transaction's deposit and refresh_awake are read from a legacy or v0 tx.
import { afterEach, describe, expect, test } from "bun:test";
import { addressBytes, ixDisc, LAUNCH_PROGRAM_ID, launchPdas, Rpc, type AgentLaunch } from "@lineage/chain";
import { base58Encode, generateAgentKey } from "@lineage/protocol";
import { prepayOf, readLaunchDeposit } from "../src/prepay.ts";
import { bare, testConfig } from "./helpers.ts";

const PREPAY = { min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "test", compute_price_line_per_usd: "20",
  compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0 };
const envs: ReturnType<typeof bare>[] = [];
afterEach(() => {
  while (envs.length) envs.pop()!.close();
});
const env = () => {
  const e = bare({ prepay: PREPAY });
  envs.push(e);
  return e;
};
const launchBody = (deposit?: string) => ({ agent: generateAgentKey().id, mint: generateAgentKey().id, launcher: generateAgentKey().id,
  target_repo: "https://github.com/karpathy/minbpe", hosted: true, identity_mode: "app", ...(deposit === undefined ? {} : { deposit }) });

describe("prepay config", () => {
  test("parsed and served with the network config; absent means no minimum", () => {
    expect(testConfig({ prepay: PREPAY }).prepay!.min_usd).toBe("10");
    expect(testConfig({ prepay: null }).prepay).toBeNull();
    expect(() => testConfig({ prepay: { ...PREPAY, default_usd: "1" } })).toThrow(/below min_usd/);
  });
  test("minimum in base units at the configured rate and the network's decimals", () => {
    const e = env();
    expect(prepayOf(e.core).minBase()).toBe(10n * 20n * 10n ** BigInt(e.cfg.token_decimals));
  });
});

describe("simulated launch with a deposit", () => {
  test("below the minimum is refused and nothing is recorded", () => {
    const e = env();
    const min = prepayOf(e.core).minBase()!;
    const b = launchBody((min - 1n).toString());
    expect(() => e.core.launchAgent(b)).toThrow(/below the minimum/);
    expect(() => e.core.agentView(b.agent)).toThrow();
    expect(() => e.core.launchAgent(launchBody("-5"))).toThrow(/integer string/);
  });
  test("at the minimum: vault funded and awake in the same step", () => {
    const e = env();
    const min = prepayOf(e.core).minBase()!;
    const b = launchBody(min.toString());
    const v = e.core.launchAgent(b) as { awake: boolean };
    expect(v.awake).toBe(true);
    const p = prepayOf(e.core).view(b.agent);
    expect(p).toMatchObject({ checked: true, ok: true, deposit: min.toString(), min: min.toString(), source: "sim" });
  });
  test("a launch without a deposit keeps the old behaviour (asleep, not recorded)", () => {
    const e = env();
    const b = launchBody();
    expect((e.core.launchAgent(b) as { awake: boolean }).awake).toBe(false);
    expect(prepayOf(e.core).view(b.agent).checked).toBe(false);
  });
});

describe("underfunded launch", () => {
  test("stays asleep in Core until the vault holds the minimum, then wakes", () => {
    const e = env();
    const min = prepayOf(e.core).minBase()!;
    const b = launchBody();
    e.core.launchAgent(b);
    // the chain recorded a deposit above wake_threshold but below the minimum
    const dep = e.cfg.wake_threshold * 2n;
    expect(dep < min).toBe(true);
    e.core.tx(() => prepayOf(e.core).record(b.agent, { mint: b.mint, launchedAt: 1, signature: "sig", deposit: dep, woke: true, source: "chain" }));
    expect(prepayOf(e.core).wakeThreshold(b.agent, e.cfg.wake_threshold)).toBe(min);
    // fees that would wake an ordinary agent do not wake this one
    const fees = ((dep * 10_000n) / BigInt(e.cfg.agent_compute_bps)) + 1n;
    e.core.agentFees({ agent: b.agent, amount: fees.toString() }, { shadow: true });
    expect(e.core.agentView(b.agent).awake).toBe(false);
    // enough to reach the minimum: awake
    e.core.agentFees({ agent: b.agent, amount: (((min * 10_000n) / BigInt(e.cfg.agent_compute_bps)) + 10n).toString() }, { shadow: true });
    expect(e.core.agentView(b.agent).awake).toBe(true);
  });
  test("an underfunded agent already awake in Core is put to sleep when its deposit is recorded", () => {
    const e = env();
    const b = launchBody();
    e.core.launchAgent(b);
    e.core.agentFees({ agent: b.agent, amount: (e.cfg.wake_threshold * 2n).toString() }, { shadow: true });
    expect(e.core.agentView(b.agent).awake).toBe(true);
    e.core.tx(() => prepayOf(e.core).record(b.agent, { mint: b.mint, launchedAt: 1, signature: "s", deposit: 1n, woke: false, source: "chain" }));
    expect(e.core.agentView(b.agent).awake).toBe(false);
    expect(prepayOf(e.core).view(b.agent).ok).toBe(false);
  });
});

describe("reading the launch transaction", () => {
  const agent = generateAgentKey().id, mint = generateAgentKey().id;
  const vault = launchPdas.computeVault(agent), al = launchPdas.agentLaunch(mint);
  const l = { agent, mint, createdAt: 5n } as unknown as AgentLaunch;
  const data = (b: Uint8Array) => base58Encode(b);
  function rpcFor(tx: unknown) {
    return new Rpc(async (method) => {
      if (method === "getSignaturesForAddress") return [{ signature: "late", err: null }, { signature: "launch", err: null }];
      if (method === "getTransaction") return tx;
      throw new Error(method);
    });
  }
  test("v0: the vault is a loaded address; deposit and refresh_awake found", async () => {
    const static_ = ["payer", LAUNCH_PROGRAM_ID, launchPdas.config()];
    const loaded = { writable: [al, vault], readonly: [] as string[] };
    const tx = {
      transaction: { message: { accountKeys: static_, instructions: [{ programIdIndex: 1, accounts: [2, 3, 4], data: data(ixDisc("refresh_awake")) }] } },
      meta: { err: null, loadedAddresses: loaded, postTokenBalances: [{ accountIndex: 4, mint: "m", uiTokenAmount: { amount: "200000000" } }] },
    };
    expect(await readLaunchDeposit(rpcFor(tx), l)).toEqual({ signature: "launch", deposit: 200_000_000n, woke: true });
  });
  test("legacy without a deposit or refresh", async () => {
    const tx = { transaction: { message: { accountKeys: ["payer", LAUNCH_PROGRAM_ID, vault], instructions: [{ programIdIndex: 1, accounts: [2], data: data(addressBytes(mint).subarray(0, 8)) }] } },
      meta: { err: null, postTokenBalances: [{ accountIndex: 2, mint: "m", uiTokenAmount: { amount: "0" } }] } };
    expect(await readLaunchDeposit(rpcFor(tx), l)).toEqual({ signature: "launch", deposit: 0n, woke: false });
  });
});
