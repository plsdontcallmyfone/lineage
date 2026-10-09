import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ata, ChainReader, launchPdas, Rpc, sendAndConfirm, system, token, TOKEN_2022_PROGRAM, type Ix, type LaunchConfig, type Signer } from "@lineage/chain";

// How a trading treasury is funded (plan T), without a program change:
//
// 1. Trade share of fee income. Each usage epoch the hosted runtime reads the agent's fee income from
//    chain (AgentLaunch.to_compute, the agent's share of its trading fees credited to its compute
//    vault) and adds trade_share_bps of what is new since the last share as a "trade share" line of
//    the agent's usage leaf. debit_compute moves it, with the compute usage, from the compute vault to
//    the compute sink (the runtime authority's tLINE account), and the runtime forwards exactly the
//    trade share from the sink to the treasury in a second transaction. Anyone can recompute it: the
//    basis (to_compute before and after, bps) is published with the funding record, the debit receipt
//    and both transfers are on chain. A share is taken only when the vault keeps at least the wake
//    threshold after paying the compute usage and the share, so trading never starves compute; a
//    skipped share stays owed (the baseline does not move).
// 2. An optional allocation at launch: the launcher sends tLINE to the allocation escrow (published as
//    allocation_escrow in GET /v1/trading/config) with a memo naming the agent; the runtime forwards
//    it to the agent's treasury once the agent is bound, and publishes both signatures.
// 3. Gas: SOL for the treasury key's fees, topped up by the runtime authority, published as funding
//    "gas" in lamports.

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const ALLOCATION_MEMO = "lineage-trade-alloc:";

export function memoIx(text: string): Ix {
  return { programId: MEMO_PROGRAM, keys: [], data: new TextEncoder().encode(text) };
}

export interface ShareBasis {
  mint: string;
  to_compute_from: string;
  to_compute_to: string;
  bps: number;
}

/**
 * The trade share now owed: floor((to_compute - baseline) x bps / 10,000), or null with the reason
 * it is not taken this epoch. `vault` is the compute vault balance, `computeOwed` what the epoch's
 * compute usage already debits, `wake` the wake threshold the vault must keep.
 */
export function tradeShareOf(o: { mint: string; toCompute: bigint; baseline: bigint; bps: number; vault: bigint; computeOwed: bigint; wake: bigint }):
  | { amount: bigint; basis: ShareBasis }
  | { amount: null; why: string } {
  if (o.bps <= 0) return { amount: null, why: "trade_share_bps is 0" };
  if (o.toCompute <= o.baseline) return { amount: null, why: "no new fee income" };
  const amount = ((o.toCompute - o.baseline) * BigInt(o.bps)) / 10_000n;
  if (amount <= 0n) return { amount: null, why: "share rounds to 0" };
  if (o.vault - o.computeOwed - amount < o.wake) return { amount: null, why: "the compute vault would fall below the wake threshold; compute first" };
  return { amount, basis: { mint: o.mint, to_compute_from: o.baseline.toString(), to_compute_to: o.toCompute.toString(), bps: o.bps } };
}

interface ShareState {
  baselines: Record<string, { to_compute: string; since: number }>;
  /** deposit signature -> what became of it */
  allocations: Record<string, { agent: string; amount: string; launcher: string | null; at: number; forwarded: string | null }>;
  alloc_cursor: string | null;
}

/** Baselines of the trade share and allocation deposits, persisted next to the trader's state. */
export class FundingStore {
  state: ShareState;
  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { baselines: {}, allocations: {}, alloc_cursor: null };
  }
  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
  /** The baseline for `agent`; on first sight it is the current fee income (no share of fees earned before trading). */
  baseline(agent: string, current: bigint, now: number): bigint {
    const b = this.state.baselines[agent];
    if (b) return BigInt(b.to_compute);
    this.state.baselines[agent] = { to_compute: current.toString(), since: now };
    this.save();
    return current;
  }
  commit(agent: string, toCompute: string, now: number) {
    const b = this.state.baselines[agent];
    if (b && BigInt(b.to_compute) >= BigInt(toCompute)) return;
    this.state.baselines[agent] = { to_compute: toCompute, since: now };
    this.save();
  }
}

/** Devnet transfers for funding: the runtime authority forwards trade shares and gas; the escrow key forwards allocations. */
export class ChainFunder {
  readonly reader: ChainReader;
  private lc: LaunchConfig | null = null;
  private decimals: number | null = null;
  constructor(readonly rpc: Rpc, private runtimeKey: Signer, private o: { escrow?: Signer; log?: (m: string) => void; onTx?: (what: string, sig: string, fee?: number) => void } = {}) {
    this.reader = new ChainReader(rpc);
  }
  async config() {
    if (!this.lc) {
      this.lc = await this.reader.launchConfig();
      if (!this.lc) throw new Error("lineage_launch is not initialized");
      this.decimals = (await this.reader.mint(this.lc.lineMint))!.decimals;
    }
    return { lc: this.lc, decimals: this.decimals! };
  }
  /** Fee income credited to the agent's compute vault so far (AgentLaunch.to_compute). */
  async feeIncome(mint: string): Promise<bigint> {
    const la = await this.reader.agentLaunch(mint);
    return la?.toCompute ?? 0n;
  }
  async computeVault(agent: string): Promise<bigint> {
    return (await this.reader.tokenBalance(launchPdas.computeVault(agent))) ?? 0n;
  }
  private async send(what: string, payer: Signer, ixs: Ix[], signers: Signer[] = []) {
    const r = await sendAndConfirm(this.rpc, payer, ixs, { signers, log: this.o.log });
    this.o.onTx?.(what, r.signature, r.fee);
    return r.signature;
  }
  /** Trade share: compute sink (the runtime authority's tLINE account) to the treasury's tLINE account. */
  async forwardShare(treasury: string, amount: bigint, note: string): Promise<string> {
    const { lc, decimals } = await this.config();
    if (lc.computeSink !== ata(this.runtimeKey.id, lc.lineMint, lc.lineTokenProgram)) throw new Error("the compute sink is not this runtime authority's token account; the trade share cannot be forwarded");
    return this.send(`trade share ${amount} to treasury ${treasury} (${note})`, this.runtimeKey, [
      token.createAtaIdempotent(this.runtimeKey.id, treasury, lc.lineMint, lc.lineTokenProgram),
      token.transferChecked(lc.computeSink, lc.lineMint, ata(treasury, lc.lineMint, lc.lineTokenProgram), this.runtimeKey.id, amount, decimals, lc.lineTokenProgram),
      memoIx(`lineage-trade-share:${note}`),
    ]);
  }
  /** Gas: SOL from the runtime authority to the treasury key. */
  async gas(treasury: string, lamports: bigint): Promise<string> {
    return this.send(`gas ${lamports} lamports to treasury ${treasury}`, this.runtimeKey, [system.transfer(this.runtimeKey.id, treasury, lamports)]);
  }
  /** The escrow's tLINE account (the address the launch form sends allocations to). */
  async escrowAccount(): Promise<string | null> {
    if (!this.o.escrow) return null;
    const { lc } = await this.config();
    return ata(this.o.escrow.id, lc.lineMint, lc.lineTokenProgram);
  }
  /** Creates the escrow's tLINE account when it does not exist yet (the runtime authority pays the rent). */
  async ensureEscrow(): Promise<string | null> {
    const acct = await this.escrowAccount();
    if (!acct || !this.o.escrow) return acct;
    if (await this.rpc.getAccountInfo(acct)) return acct;
    const { lc } = await this.config();
    await this.send(`create the allocation escrow ${acct}`, this.runtimeKey, [token.createAtaIdempotent(this.runtimeKey.id, this.o.escrow.id, lc.lineMint, lc.lineTokenProgram)]);
    return acct;
  }

  /**
   * New deposits into the escrow: transfers whose transaction carries the memo
   * `lineage-trade-alloc:<agent>`. Reads signatures newer than the cursor, oldest first.
   */
  async deposits(cursor: string | null): Promise<{ deposits: { sig: string; agent: string; amount: bigint; launcher: string | null }[]; cursor: string | null }> {
    const acct = await this.escrowAccount();
    if (!acct) return { deposits: [], cursor };
    const sigs = await this.rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [acct, { limit: 100, ...(cursor ? { until: cursor } : {}), commitment: "confirmed" }]);
    const out: { sig: string; agent: string; amount: bigint; launcher: string | null }[] = [];
    for (const s of [...sigs].reverse()) {
      if (s.err) continue;
      const tx = await this.rpc.call<any>("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (!tx?.meta) continue;
      const memo = (tx.meta.logMessages as string[] | null)?.map((l) => /Memo \(len \d+\): "(.*)"$/.exec(l)?.[1]).find((m) => m?.startsWith(ALLOCATION_MEMO));
      if (!memo) continue;
      const agent = memo.slice(ALLOCATION_MEMO.length);
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agent)) continue;
      const keys: string[] = tx.transaction.message.accountKeys;
      const idx = keys.indexOf(acct);
      const pre = (tx.meta.preTokenBalances ?? []).find((b: any) => b.accountIndex === idx);
      const post = (tx.meta.postTokenBalances ?? []).find((b: any) => b.accountIndex === idx);
      const amount = BigInt(post?.uiTokenAmount?.amount ?? "0") - BigInt(pre?.uiTokenAmount?.amount ?? "0");
      if (amount <= 0n) continue;
      out.push({ sig: s.signature, agent, amount, launcher: keys[0] ?? null });
    }
    return { deposits: out, cursor: sigs[0]?.signature ?? cursor };
  }
  /** Allocation: escrow to the treasury (the runtime authority pays the fee, the escrow key signs). */
  async forwardAllocation(treasury: string, amount: bigint, deposit: string): Promise<string> {
    if (!this.o.escrow) throw new Error("no escrow key");
    const { lc, decimals } = await this.config();
    const from = ata(this.o.escrow.id, lc.lineMint, lc.lineTokenProgram);
    return this.send(`allocation ${amount} to treasury ${treasury} (deposit ${deposit})`, this.runtimeKey, [
      token.createAtaIdempotent(this.runtimeKey.id, treasury, lc.lineMint, lc.lineTokenProgram),
      token.transferChecked(from, lc.lineMint, ata(treasury, lc.lineMint, lc.lineTokenProgram), this.o.escrow.id, amount, decimals, lc.lineTokenProgram),
      memoIx(`lineage-trade-alloc-forward:${deposit}`),
    ], [this.o.escrow]);
  }
}

export { TOKEN_2022_PROGRAM };
