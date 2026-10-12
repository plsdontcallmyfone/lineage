import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { parseConfig, type Action, type Chain, type KeeperConfig, type Outcome, type Prepared, type Sim, type Snapshot } from "../src/index.ts";

// A model of the chain for the keeper's state machine tests: a wallet, the fees waiting on pump.fun,
// a compute address and a token supply, with pump.fun's Global and fee config taken from the fork
// fixture so the keeper's real quote math runs. A transaction lands the first time it is submitted
// (unless told to drop it) and never twice; `die` stops the "process" once at a chosen point.

export const revive = (_k: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
export const fixture = JSON.parse(readFileSync(new URL("./fixtures/fork.json", import.meta.url), "utf8"), revive) as {
  config: Record<string, unknown>;
  transactions: { action: Action; snapshot: Snapshot; cu_limit: number; cu_price: number; size: number; compute_units: number; instructions: { program: string; accounts: string[]; data: string }[] }[];
};

export type Point = "sign" | "before-submit" | "after-submit" | "status" | "outcome";
export const POINTS: Point[] = ["sign", "before-submit", "after-submit", "status", "outcome"];
export class Died extends Error {}

export const TOKEN_ACCOUNT_RENT = 2_074_080n, VOLUME_RENT = 1_844_400n, VAULT_RENT = 890_880n, BASE_FEE = 5_000n;

export class FakeChain implements Chain {
  readonly base: Snapshot;
  wallet: bigint;
  waiting = 0n;
  vault = 0n;
  compute = 0n;
  supply: bigint;
  tokens = 0n;
  ataExists = false;
  height = 1000;
  genesis: string;
  fitsOne = true;
  /** The next submitted transaction is lost (never lands). */
  drop = false;
  /** The next landed transaction fails on chain (fee paid, nothing else). */
  failNext = false;
  simFail: Action["kind"] | null = null;
  die: { kind: Action["kind"]; point: Point } | null = null;
  microLamports = 0;
  readonly landed: { kind: Action["kind"]; signature: string }[] = [];
  readonly submits: string[] = [];
  private readonly txs = new Map<string, { action: Action; outcome: Outcome | null; lastValid: number }>();
  private readonly wires = new Map<string, string>();
  private n = 0;

  constructor(readonly cfg: KeeperConfig, own: bigint) {
    this.base = fixture.transactions[0]!.snapshot;
    this.wallet = own;
    this.supply = this.base.mint.supply;
    this.genesis = this.base.genesis;
  }

  private maybeDie(kind: Action["kind"], point: Point) {
    if (this.die && this.die.kind === kind && this.die.point === point) {
      this.die = null;
      throw new Died(`died at ${point} of ${kind}`);
    }
  }

  async read(): Promise<Snapshot> {
    const b = this.base;
    return {
      ...b, genesis: this.genesis, wallet: this.wallet, mint: { ...b.mint, supply: this.supply }, curve: { ...b.curve, creator: this.cfg.creator, creatorFee: this.waiting },
      vault: this.vault, tokenAta: { address: b.tokenAta.address, exists: this.ataExists, amount: this.tokens },
      compute: { lamports: this.compute, owner: this.compute > 0n ? "11111111111111111111111111111111" : null, executable: false },
    };
  }
  async price(): Promise<number> {
    return this.microLamports;
  }
  fits(a: Action): boolean {
    return a.kind !== "buyback" || !a.burn || this.fitsOne;
  }

  /** What the action does to the model, as an outcome; applies it when `commit`. */
  private effect(a: Action, fee: bigint, commit: boolean): { err: string | null; delta: bigint; created: bigint; collected: bigint } {
    let delta = -fee, created = 0n, collected = 0n;
    if (a.kind === "collect") {
      const topUp = this.vault < VAULT_RENT ? VAULT_RENT - this.vault : 0n;
      collected = this.waiting;
      delta += collected - topUp;
      if (commit) { this.vault = VAULT_RENT; this.waiting = 0n; }
    } else if (a.kind === "compute") {
      if (this.wallet < a.lamports + fee) return { err: "insufficient lamports", delta: -fee, created: 0n, collected: 0n };
      delta -= a.lamports;
      if (commit) this.compute += a.lamports;
    } else if (a.kind === "buyback") {
      const cost = (a.maxLamports * 10_000n) / 10_100n;
      created = this.ataExists ? 0n : TOKEN_ACCOUNT_RENT + VOLUME_RENT;
      if (this.wallet < cost + created + fee) return { err: "insufficient lamports", delta: -fee, created: 0n, collected: 0n };
      delta -= cost + created;
      if (commit) {
        this.ataExists = true;
        if (a.burn) this.supply -= a.tokens;
        else this.tokens += a.tokens;
      }
    } else {
      if (this.tokens < a.tokens) return { err: "insufficient tokens", delta: -fee, created: 0n, collected: 0n };
      if (commit) { this.tokens -= a.tokens; this.supply -= a.tokens; }
    }
    return { err: null, delta, created, collected };
  }

  async simulate(a: Action): Promise<Sim> {
    if (this.simFail === a.kind) return { ok: false, error: "custom program error", logs: ["Program log: no"], units: 0, walletDelta: 0n, createdRent: 0n, size: 500 };
    const e = this.effect(a, 0n, false);
    return { ok: !e.err, error: e.err, logs: [], units: 50_000, walletDelta: e.delta, createdRent: e.created, size: 500 };
  }
  async sign(a: Action, _s: Snapshot, _cu: number, _price: number): Promise<Prepared> {
    this.maybeDie(a.kind, "sign");
    const signature = `sig${++this.n}`;
    this.txs.set(signature, { action: a, outcome: null, lastValid: this.height + 150 });
    const wire = new TextEncoder().encode(signature);
    this.wires.set(Buffer.from(wire).toString("base64"), signature);
    return { wire, signature, lastValidBlockHeight: this.height + 150 };
  }
  async submit(wire: Uint8Array): Promise<void> {
    const signature = this.wires.get(Buffer.from(wire).toString("base64"))!;
    const t = this.txs.get(signature)!;
    this.maybeDie(t.action.kind, "before-submit");
    this.submits.push(signature);
    if (t.outcome === null && this.height <= t.lastValid) {
      if (this.drop) this.drop = false;
      else {
        const fee = BASE_FEE;
        if (this.failNext) {
          this.failNext = false;
          this.wallet -= fee;
          t.outcome = { err: "custom program error", slot: this.height, walletDelta: -fee, fee, createdRent: 0n, collected: 0n, units: 1 };
        } else {
          const e = this.effect(t.action, fee, true);
          this.wallet += e.err ? -fee : e.delta;
          t.outcome = { err: e.err, slot: this.height, walletDelta: e.err ? -fee : e.delta, fee, createdRent: e.created, collected: e.collected, units: 50_000 };
          if (!e.err) this.landed.push({ kind: t.action.kind, signature });
        }
      }
    }
    this.height++;
    this.maybeDie(t.action.kind, "after-submit");
  }
  async status(signature: string): Promise<"landed" | "unknown"> {
    const t = this.txs.get(signature);
    if (t) this.maybeDie(t.action.kind, "status");
    return t?.outcome ? "landed" : "unknown";
  }
  async blockHeight(): Promise<number> {
    return this.height;
  }
  async outcome(signature: string): Promise<Outcome> {
    const t = this.txs.get(signature)!;
    this.maybeDie(t.action.kind, "outcome");
    return t.outcome!;
  }
  count = (kind: Action["kind"]) => this.landed.filter((x) => x.kind === kind).length;
}

export function testConfig(over: Record<string, unknown> = {}): KeeperConfig {
  const dir = mkdtempSync(join(tmpdir(), "units-fee-keeper-test-"));
  return parseConfig({
    enabled: false, rpc_url: "http://127.0.0.1:1", mint: fixture.config.mint, creator: fixture.config.creator, key_path: null, compute_address: generateAgentKey().id,
    compute_bps: 5000, burn_bps: 5000, fee_reserve_lamports: "10000000", min_collect_lamports: "5000000", min_buyback_lamports: "1000000", max_buyback_lamports: "50000000",
    slippage_bps: 100, priority_fee: { percentile: 75, floor_micro_lamports: 0, cap_micro_lamports: 50000 }, confirm_timeout_s: 10, state_path: join(dir, "state.json"),
    log_path: join(dir, "runs.jsonl"), ...over,
  });
}
