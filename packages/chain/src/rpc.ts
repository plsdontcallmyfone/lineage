import type { Address } from "./codec.ts";

// A minimal Solana JSON-RPC client over fetch. The transport is injectable so tests replay
// recorded responses (FixtureTransport) and scripts can record them (RecordingTransport).

export type Transport = (method: string, params: unknown[]) => Promise<unknown>;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** HTTP JSON-RPC with retries on 429, 5xx and network errors (not on RPC-level errors). */
export function httpTransport(url: string, opts: { retries?: number; fetch?: typeof fetch } = {}): Transport {
  const f = opts.fetch ?? fetch;
  const retries = opts.retries ?? 5;
  let id = 0;
  return async (method, params) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(8000, 400 * 2 ** (attempt - 1))));
      let res: Response;
      try {
        res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new RpcError(`${method}: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { result?: unknown; error?: { message: string; code: number; data?: unknown } };
      if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code, body.error.data);
      return body.result;
    }
    throw lastErr instanceof Error ? lastErr : new RpcError(`${method}: failed`);
  };
}

const fixtureKey = (method: string, params: unknown[]) => JSON.stringify([method, params]);

/** Wraps a transport and keeps every read response, for writing a fixture file. */
export class RecordingTransport {
  readonly entries = new Map<string, unknown>();
  constructor(
    private inner: Transport,
    private record: (method: string) => boolean = (m) => m.startsWith("get"),
  ) {}
  readonly transport: Transport = async (method, params) => {
    const out = await this.inner(method, params);
    if (this.record(method)) this.entries.set(fixtureKey(method, params), out);
    return out;
  };
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.entries);
  }
}

/** Answers from recorded responses only; an unrecorded call throws (no live RPC in unit tests). */
export function fixtureTransport(recorded: Record<string, unknown>): Transport {
  return async (method, params) => {
    const k = fixtureKey(method, params);
    if (!(k in recorded)) throw new RpcError(`no recorded response for ${k.slice(0, 200)}`);
    return structuredClone(recorded[k]);
  };
}

export interface AccountInfo {
  address: Address;
  lamports: bigint;
  owner: Address;
  executable: boolean;
  data: Uint8Array;
}

type RawAccount = { lamports: number; owner: string; executable: boolean; data: [string, string] } | null;
const toAccount = (address: Address, a: RawAccount): AccountInfo | null =>
  a ? { address, lamports: BigInt(a.lamports), owner: a.owner, executable: a.executable, data: new Uint8Array(Buffer.from(a.data[0], "base64")) } : null;

export type Commitment = "processed" | "confirmed" | "finalized";

export class Rpc {
  constructor(
    readonly transport: Transport,
    readonly commitment: Commitment = "confirmed",
  ) {}
  static http(url: string, commitment: Commitment = "confirmed") {
    return new Rpc(httpTransport(url), commitment);
  }
  call<T>(method: string, params: unknown[] = []): Promise<T> {
    return this.transport(method, params) as Promise<T>;
  }

  async getAccountInfo(address: Address): Promise<AccountInfo | null> {
    const r = await this.call<{ value: RawAccount }>("getAccountInfo", [address, { encoding: "base64", commitment: this.commitment }]);
    return toAccount(address, r.value);
  }
  async getMultipleAccounts(addresses: Address[]): Promise<(AccountInfo | null)[]> {
    const out: (AccountInfo | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const r = await this.call<{ value: RawAccount[] }>("getMultipleAccounts", [chunk, { encoding: "base64", commitment: this.commitment }]);
      r.value.forEach((a, j) => out.push(toAccount(chunk[j]!, a)));
    }
    return out;
  }
  /** Program accounts whose data starts with `prefix` (an 8-byte Anchor discriminator), optionally sized. */
  async getProgramAccounts(program: Address, filters: { memcmp?: { offset: number; bytes: Uint8Array }[]; dataSize?: number } = {}): Promise<AccountInfo[]> {
    const f: unknown[] = [];
    for (const m of filters.memcmp ?? []) f.push({ memcmp: { offset: m.offset, bytes: Buffer.from(m.bytes).toString("base64"), encoding: "base64" } });
    if (filters.dataSize !== undefined) f.push({ dataSize: filters.dataSize });
    const r = await this.call<{ pubkey: string; account: NonNullable<RawAccount> }[]>("getProgramAccounts", [
      program,
      { encoding: "base64", commitment: this.commitment, filters: f },
    ]);
    return r.map((x) => toAccount(x.pubkey, x.account)!).sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  }
  async getBalance(address: Address): Promise<bigint> {
    return BigInt((await this.call<{ value: number }>("getBalance", [address, { commitment: this.commitment }])).value);
  }
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return (await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: this.commitment }])).value;
  }
  async getBlockHeight(): Promise<number> {
    return this.call<number>("getBlockHeight", [{ commitment: this.commitment }]);
  }
  async getSlot(): Promise<number> {
    return this.call<number>("getSlot", [{ commitment: this.commitment }]);
  }
  async getMinimumBalanceForRentExemption(size: number): Promise<bigint> {
    return BigInt(await this.call<number>("getMinimumBalanceForRentExemption", [size]));
  }
  async sendRawTransaction(wire: Uint8Array, skipPreflight = false): Promise<string> {
    return this.call<string>("sendTransaction", [
      Buffer.from(wire).toString("base64"),
      { encoding: "base64", skipPreflight, preflightCommitment: this.commitment, maxRetries: 0 },
    ]);
  }
  async simulate(wire: Uint8Array): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number }> {
    return (
      await this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>("simulateTransaction", [
        Buffer.from(wire).toString("base64"),
        { encoding: "base64", sigVerify: false, commitment: this.commitment, replaceRecentBlockhash: false },
      ])
    ).value;
  }
  async getSignatureStatuses(sigs: string[]): Promise<({ err: unknown; confirmationStatus: Commitment | null; slot: number } | null)[]> {
    return (await this.call<{ value: ({ err: unknown; confirmationStatus: Commitment | null; slot: number } | null)[] }>("getSignatureStatuses", [sigs, { searchTransactionHistory: true }])).value;
  }
  async getTransaction(sig: string): Promise<{ meta: { err: unknown; fee: number; logMessages: string[] | null; computeUnitsConsumed?: number } | null; slot: number } | null> {
    return this.call("getTransaction", [sig, { encoding: "json", commitment: this.commitment, maxSupportedTransactionVersion: 0 }]);
  }
}
