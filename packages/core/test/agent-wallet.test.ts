// Agent wallets (docs/plans/AGENT-WALLET-SAFETY.md section 2): the treasury is the registry signing
// key, the compute vault a separate address; balances are whatever the chain answers, a failed read
// is an error and never a zero, and without a chain only addresses are served.
import { afterEach, describe, expect, test } from "bun:test";
import { ata, launchPdas, TOKEN_2022_PROGRAM, type ChainReader } from "@units/chain";
import { generateAgentKey } from "@units/protocol";
import { agentWalletOf } from "../src/agent-wallet.ts";
import { bare, expectOk } from "./helpers.ts";

const envs: ReturnType<typeof bare>[] = [];
afterEach(() => {
  while (envs.length) envs.pop()!.close();
});
const QUOTE = generateAgentKey().id;

async function world() {
  const e = bare();
  envs.push(e);
  const mk = async () => {
    const b = { agent: generateAgentKey().id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/karpathy/minbpe", hosted: true, identity_mode: "app" };
    await expectOk(e.admin.c.post("/v1/admin/launches", b));
    return b;
  };
  return { e, a: await mk(), b: await mk() };
}

/** A reader answering from a table of token balances; counts its reads. */
function reader(balances: Map<string, bigint>, o: { fail?: boolean } = {}) {
  const calls = { tokenBalances: 0, getBalance: 0 };
  const r = {
    launchConfig: async () => ({ lineMint: QUOTE, lineTokenProgram: TOKEN_2022_PROGRAM }),
    mint: async () => ({ decimals: 6 }),
    tokenBalances: async (accounts: string[]) => {
      calls.tokenBalances++;
      if (o.fail) throw new Error("429 Too Many Requests");
      return accounts.map((x) => balances.get(x) ?? null);
    },
    rpc: {
      getBalance: async () => (calls.getBalance++, 123_456_789n),
      getSlot: async () => 4242,
      // a mint account: 82 bytes with the decimals at offset 44
      getMultipleAccounts: async (mints: string[]) => mints.map(() => ({ data: Object.assign(new Uint8Array(82), { 44: 6 }) })),
    },
  } as unknown as ChainReader;
  return { r, calls };
}

describe("agent wallet", () => {
  test("sim mode: the treasury address Core knows, no compute vault, no balances", async () => {
    const { e, a } = await world();
    const v = await expectOk(e.anon.get(`/v1/agents/${a.agent}/wallet`));
    expect(v).toMatchObject({ agent: a.agent, chain: false, read_at: null, treasury: { address: a.agent, is_agent_id: true, sol_lamports: null, quote: null, holdings: null }, compute_vault: null, error: null });
    const l = await expectOk(e.anon.get("/v1/wallets"));
    expect(l.chain).toBe(false);
    expect(l.wallets[a.agent]).toEqual({ treasury: a.agent, compute_vault: null });
    expect((await e.anon.get(`/v1/agents/${generateAgentKey().id}/wallet`)).status).toBe(404);
  });

  test("chain mode: SOL, quote and agent token balances as read; its own token marked; empty accounts left out", async () => {
    const { e, a, b } = await world();
    const bal = new Map<string, bigint>([
      [ata(a.agent, QUOTE, TOKEN_2022_PROGRAM), 250_000_000n],
      [launchPdas.computeVault(a.agent), 199_000_000n],
      [ata(a.agent, a.mint, TOKEN_2022_PROGRAM), 10_000_000_000n],
      [ata(a.agent, b.mint, TOKEN_2022_PROGRAM), 7n],
    ]);
    const { r, calls } = reader(bal);
    agentWalletOf(e.core).configure({ reader: r, network: "devnet", quoteSymbol: "UNITS" });
    const v = await expectOk(e.anon.get(`/v1/agents/${a.agent}/wallet`));
    expect(v).toMatchObject({
      chain: true, network: "devnet", slot: 4242, error: null,
      treasury: { address: a.agent, sol_lamports: "123456789", quote: { mint: QUOTE, symbol: "UNITS", decimals: 6, amount: "250000000" } },
      compute_vault: { address: launchPdas.computeVault(a.agent), amount: "199000000" },
    });
    expect(v.treasury.holdings).toEqual([{ mint: a.mint, agent: a.agent, amount: "10000000000", decimals: 6, own: true }, { mint: b.mint, agent: b.agent, amount: "7", decimals: 6, own: false }]);
    // the other agent holds nothing: zeros read from chain, an empty holdings list
    const w = await expectOk(e.anon.get(`/v1/agents/${b.agent}/wallet`));
    expect(w.treasury).toMatchObject({ sol_lamports: "123456789", quote: { amount: "0" }, holdings: [] });
    expect(w.compute_vault.amount).toBe("0");
    // cached: a second request within the window does not read the chain again
    await expectOk(e.anon.get(`/v1/agents/${a.agent}/wallet`));
    expect(calls.tokenBalances).toBe(2);
    e.clock.advance(31_000);
    await expectOk(e.anon.get(`/v1/agents/${a.agent}/wallet`));
    expect(calls.tokenBalances).toBe(3);
    const l = await expectOk(e.anon.get("/v1/wallets"));
    expect(l.wallets[a.agent]).toEqual({ treasury: a.agent, compute_vault: launchPdas.computeVault(a.agent) });
  });

  test("a failed chain read is an error with the addresses, never zeros, and is not cached", async () => {
    const { e, a } = await world();
    const { r, calls } = reader(new Map(), { fail: true });
    agentWalletOf(e.core).configure({ reader: r, network: "devnet", quoteSymbol: "UNITS" });
    const v = await expectOk(e.anon.get(`/v1/agents/${a.agent}/wallet`));
    expect(v.error).toMatch(/chain read failed: 429/);
    expect(v.treasury).toMatchObject({ address: a.agent, sol_lamports: null, quote: null, holdings: null });
    expect(v.compute_vault).toEqual({ address: launchPdas.computeVault(a.agent), amount: null });
    await expectOk(e.anon.get(`/v1/agents/${a.agent}/wallet`));
    expect(calls.tokenBalances).toBe(2);
  });
});
