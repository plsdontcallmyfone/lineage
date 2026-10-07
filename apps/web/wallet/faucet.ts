// Server-side tLINE faucet for devnet (wallet UI lane). The TEST mint's authority is revoked, so
// nothing is minted: the faucet wallet (~/.config/lineage/devnet/faucet.json, funded once from the
// supply holder by apps/web/scripts/fund-faucet.ts) transfers a small fixed amount. One drip per
// wallet per window, a global hourly cap, every drip appended to a JSONL log. It never sends SOL.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  addressBytes,
  ata,
  isOnCurve,
  loadKeypair,
  Rpc,
  sendAndConfirm,
  token,
  TOKEN_2022_PROGRAM,
  TxError,
  type Signer,
} from "@lineage/chain";
import { DEVNET_GENESIS } from "../../../packages/chain/src/browser/client.ts";

export interface FaucetOptions {
  keyPath: string;
  logPath: string;
  rpcUrl: string;
  lineMint: string;
  decimals: number;
  /** Base units per drip. */
  amount: bigint;
  perWalletMs: number;
  perHour: number;
}

interface Drip {
  at: number;
  wallet: string;
  amount: string;
  signature: string;
  fee?: number;
}

export class Faucet {
  private rpc: Rpc;
  private key: Signer | null = null;
  private drips: Drip[] = [];
  private busy = new Set<string>();
  private cluster: string | null = null;

  constructor(readonly o: FaucetOptions) {
    this.rpc = Rpc.http(o.rpcUrl, "confirmed");
    if (existsSync(o.keyPath)) this.key = loadKeypair(o.keyPath);
    if (existsSync(o.logPath))
      for (const line of readFileSync(o.logPath, "utf8").split("\n"))
        if (line.trim())
          try {
            this.drips.push(JSON.parse(line));
          } catch {
            /* skip a torn line */
          }
  }

  get address() {
    return this.key?.id ?? null;
  }

  /** Public state: address, balances read from chain, limits. */
  async info() {
    if (!this.key) return { enabled: false, reason: "no faucet key: run bun apps/web/scripts/fund-faucet.ts", amount: this.o.amount.toString() };
    const tokenAccount = ata(this.key.id, this.o.lineMint, TOKEN_2022_PROGRAM);
    const [sol, acct] = await Promise.all([this.rpc.getBalance(this.key.id), this.rpc.getAccountInfo(tokenAccount)]);
    const line = acct ? new DataView(acct.data.buffer, acct.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n;
    const hourAgo = Date.now() - 3_600_000;
    return {
      enabled: line >= this.o.amount && sol > 5_000_000n,
      address: this.key.id,
      token_account: tokenAccount,
      sol_lamports: sol.toString(),
      line_base_units: line.toString(),
      amount: this.o.amount.toString(),
      per_wallet_hours: this.o.perWalletMs / 3_600_000,
      per_hour: this.o.perHour,
      drips_last_hour: this.drips.filter((d) => d.at > hourAgo).length,
      drips_total: this.drips.length,
    };
  }

  lastDrip(wallet: string): Drip | null {
    for (let i = this.drips.length - 1; i >= 0; i--) if (this.drips[i]!.wallet === wallet) return this.drips[i]!;
    return null;
  }

  async drip(wallet: string): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.key) return { status: 503, body: { error: "faucet_unfunded", message: "the faucet has no key yet (apps/web/scripts/fund-faucet.ts)" } };
    let bytes: Uint8Array;
    try {
      bytes = addressBytes(wallet);
    } catch {
      return { status: 400, body: { error: "bad_address", message: "not a base58 address" } };
    }
    if (!isOnCurve(bytes)) return { status: 400, body: { error: "bad_address", message: "a wallet address is an ed25519 key, not a program-derived address" } };
    if (!this.cluster) {
      const g = await this.rpc.call<string>("getGenesisHash", []);
      if (g !== DEVNET_GENESIS) return { status: 503, body: { error: "not_devnet", message: `faucet RPC genesis ${g} is not devnet` } };
      this.cluster = "devnet";
    }
    const last = this.lastDrip(wallet);
    if (last && Date.now() - last.at < this.o.perWalletMs)
      return { status: 429, body: { error: "rate_limited", message: "one drip per wallet per window", next_at: last.at + this.o.perWalletMs, last } };
    if (this.drips.filter((d) => d.at > Date.now() - 3_600_000).length >= this.o.perHour)
      return { status: 429, body: { error: "rate_limited", message: `the faucet sends at most ${this.o.perHour} drips an hour` } };
    if (this.busy.has(wallet)) return { status: 409, body: { error: "in_flight", message: "a drip to this wallet is in flight" } };
    this.busy.add(wallet);
    try {
      const T22 = TOKEN_2022_PROGRAM;
      const from = ata(this.key.id, this.o.lineMint, T22);
      const r = await sendAndConfirm(this.rpc, this.key, [
        token.createAtaIdempotent(this.key.id, wallet, this.o.lineMint, T22),
        token.transferChecked(from, this.o.lineMint, ata(wallet, this.o.lineMint, T22), this.key.id, this.o.amount, this.o.decimals, T22),
      ]);
      const d: Drip = { at: Date.now(), wallet, amount: this.o.amount.toString(), signature: r.signature, fee: r.fee };
      this.drips.push(d);
      appendFileSync(this.o.logPath, JSON.stringify(d) + "\n", { mode: 0o600 });
      console.log(`[faucet] ${this.o.amount} base units of tLINE to ${wallet}: ${r.signature}`);
      return { status: 200, body: { ...d } };
    } catch (e) {
      const logs = e instanceof TxError ? e.logs.slice(-8) : [];
      return { status: 502, body: { error: "send_failed", message: (e as Error).message, logs } };
    } finally {
      this.busy.delete(wallet);
    }
  }
}
