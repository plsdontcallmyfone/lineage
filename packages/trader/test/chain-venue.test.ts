// The chain venue trades pump.fun only: routing from the launch record and chain (curve while it runs,
// the canonical PumpSwap pool once migrated), the exact instructions it signs, and the refusal of
// launches the Meteora venue recorded (devnet history, read-only). The RPC is a mock answering with
// account bytes mainnet's pump.fun programs wrote on the mainnet fork (packages/chain/test/fixtures/pump-fork.json).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { accountDisc, ata, ixDisc, launchPdas, toAddress, LAUNCH_PROGRAM_ID, PUMP, pumpPdas, Rpc, TOKEN_2022_PROGRAM, Writer } from "@lineage/chain";
import { ChainVenue } from "../src/chain-venue.ts";

const fx = JSON.parse(readFileSync(new URL("../../chain/test/fixtures/pump-fork.json", import.meta.url), "utf8"));
const { line, a1, a2 } = fx.mints as { line: string; a1: string; a2: string };
const T22 = TOKEN_2022_PROGRAM;
const addr = (n: number) => toAddress(new Uint8Array(32).fill(n + 1));

function launchConfig(): Uint8Array {
  const w = new Writer().bytes(accountDisc("LaunchConfig"));
  for (const a of [addr(1), addr(2), LAUNCH_PROGRAM_ID, line, T22, addr(3), PUMP.program]) w.address(a);
  w.u16(7000).u16(3000).u64(1n).u64(2n).u64(0n).u128(0n).bool(false).u8(255).u8(255);
  for (let i = 0; i < 5; i++) w.u64(0n);
  return w.done();
}
function agentLaunch(mint: string, venue: string, graduated: boolean): Uint8Array {
  const w = new Writer().bytes(accountDisc("AgentLaunch")).address(addr(4)).address(mint).address(addr(5)).bytes(new Uint8Array(32)).string("https://github.com/a/b")
    .u8(2).bool(true).address(venue).address(pumpPdas.bondingCurve(mint)).address(graduated ? pumpPdas.pool(mint, line) : addr(6)).address(addr(7)).address(addr(6))
    .bool(graduated).bool(true).i64(0n);
  for (let i = 0; i < 5; i++) w.u64(0n);
  return w.u8(255).u8(255).done();
}

function mockRpc(accounts: Map<string, { data: Uint8Array; owner: string }>) {
  const raw = (a: string) => {
    const x = accounts.get(a);
    return x ? { data: [Buffer.from(x.data).toString("base64"), "base64"], owner: x.owner, lamports: 1, executable: false } : null;
  };
  return new Rpc(async (method, params) => {
    if (method === "getAccountInfo") return { value: raw(params[0] as string) };
    if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map(raw) };
    throw new Error(`unexpected ${method}`);
  });
}
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

function world(o: { venue?: string; graduated?: boolean; mint?: string; buybackExists?: boolean } = {}) {
  const mint = o.mint ?? a1;
  const m = new Map<string, { data: Uint8Array; owner: string }>();
  m.set(launchPdas.config(), { data: launchConfig(), owner: LAUNCH_PROGRAM_ID });
  m.set(launchPdas.agentLaunch(mint), { data: agentLaunch(mint, o.venue ?? PUMP.program, o.graduated ?? false), owner: LAUNCH_PROGRAM_ID });
  m.set(pumpPdas.bondingCurve(a1), { data: b64(fx.accounts.a1_curve), owner: PUMP.program });
  m.set(pumpPdas.bondingCurve(a2), { data: b64(fx.accounts.a2_curve), owner: PUMP.program });
  m.set(pumpPdas.pool(a2, line), { data: b64(fx.accounts.a2_pool), owner: PUMP.amm });
  if (o.buybackExists) m.set(ata(PUMP.buybackRecipients[0], line, T22), { data: new Uint8Array(165), owner: T22 });
  return new ChainVenue(mockRpc(m));
}
const owner = addr(0);
const ixsOf = (v: ChainVenue, mint: string, buy: boolean) => (v as unknown as { ixs: (o: string, m: string, b: boolean, i: bigint, x: bigint) => Promise<{ programId: string; keys: { pubkey: string }[]; data: Uint8Array }[]> }).ixs(owner, mint, buy, 1_000n, 7n);
const disc = (d: Uint8Array) => [...d.subarray(0, 8)];

describe("ChainVenue on pump.fun", () => {
  test("a coin on its curve: Pump buy_exact_quote_in_v3 with $LINE in, sell_v3 out; ATAs and the buyback account created first", async () => {
    const v = world();
    expect(await v.route(a1)).toEqual({ kind: "pump_curve" });
    const buy = await ixsOf(v, a1, true);
    const swap = buy.at(-1)!;
    expect(swap.programId).toBe(PUMP.program);
    expect(disc(swap.data)).toEqual([...ixDisc("buy_exact_quote_in_v3")]);
    expect(swap.keys[9]!.pubkey).toBe(ata(owner, a1, T22));
    expect(swap.keys[13]!.pubkey).toBe(ata(PUMP.buybackRecipients[0], line, T22));
    expect(buy.slice(0, -1).map((x) => x.keys[1]!.pubkey)).toEqual([ata(owner, line, T22), ata(owner, a1, T22), ata(PUMP.buybackRecipients[0], line, T22)]);
    const sell = (await ixsOf(v, a1, false)).at(-1)!;
    expect(disc(sell.data)).toEqual([...ixDisc("sell_v3")]);
  });
  test("the buyback account is not created again once it exists", async () => {
    const v = world({ buybackExists: true });
    expect((await ixsOf(v, a1, true)).length).toBe(3);
  });
  test("a migrated coin: PumpSwap buy_exact_quote_in_v2 / sell_v2 on its canonical pool", async () => {
    const v = world({ mint: a2 });
    expect(await v.route(a2)).toEqual({ kind: "pump_pool", pool: pumpPdas.pool(a2, line) });
    const swap = (await ixsOf(v, a2, true)).at(-1)!;
    expect(swap.programId).toBe(PUMP.amm);
    expect(swap.keys[0]!.pubkey).toBe(pumpPdas.pool(a2, line));
    expect(disc(swap.data)).toEqual([...ixDisc("buy_exact_quote_in_v2")]);
    const sell = (await ixsOf(v, a2, false)).at(-1)!;
    expect(disc(sell.data)).toEqual([...ixDisc("sell_v2")]);
  });
  test("a Meteora-era launch (devnet history) is refused: read-only", async () => {
    const v = world({ venue: addr(6) });
    await expect(v.route(a1)).rejects.toThrow(/Meteora venue.*read-only/);
  });
});
