import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { PUMP, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Address, type Ix } from "@units/chain";
import { actionIxs, burnAccountAddress, parseConfig, type Action, type Chain, type KeeperConfig, type Outcome, type Prepared, type Sim, type Snapshot } from "../src/index.ts";

// A model of the chain for the keeper's state machine tests: a wallet, the fees waiting on pump.fun,
// a compute address and a token supply, with pump.fun's Global and fee config taken from the fork
// fixture so the keeper's real quote math runs. A transaction lands the first time it is submitted
// (unless told to drop it) and never twice; `die` stops the "process" once at a chosen point.
//
// Tokens are moved by the instructions of the signed transaction, not by the plan: `sign` builds
// them with the keeper's own builder (plans.ts), hands them to the keeper's check like the real
// chain does, and a landed transaction credits and debits the token accounts its instructions name
// (a buy credits its base account, a burn or a transfer debits its source). So a burn aimed at the
// wallet's own account would show in `own`.

export const revive = (_k: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
export const fixture = JSON.parse(readFileSync(new URL("./fixtures/fork.json", import.meta.url), "utf8"), revive) as {
  config: Record<string, unknown>;
  transactions: { action: Action; snapshot: Snapshot; cu_limit: number; cu_price: number; size: number; compute_units: number; instructions: { program: string; accounts: string[]; data: string }[] }[];
};

// The fixture was recorded when the keeper bought into the wallet's associated token account. The
// keeper now buys into its own burn account (plans.ts BURN_SEED); the recorded snapshots get that
// account, in the state the associated one was in, until the fork proof is rerun and records it.
for (const t of fixture.transactions) t.snapshot.burnAccount ??= { address: burnAccountAddress(fixture.config.creator as Address, t.snapshot.mint.program), exists: t.snapshot.tokenAta.exists, amount: 0n };

export type Point = "sign" | "before-submit" | "after-submit" | "status" | "outcome";
export const POINTS: Point[] = ["sign", "before-submit", "after-submit", "status", "outcome"];
export class Died extends Error {}

export const TOKEN_ACCOUNT_RENT = 2_039_280n, VOLUME_RENT = 1_844_400n, VAULT_RENT = 890_880n, BASE_FEE = 5_000n;

export class FakeChain implements Chain {
  readonly base: Snapshot;
  wallet: bigint;
  waiting = 0n;
  vault = 0n;
  compute = 0n;
  supply: bigint;
  /** Token balances by account: the wallet's own (associated) account and the keeper's burn account. */
  readonly balances = new Map<Address, bigint>();
  readonly ownAccount: Address;
  readonly burnAccount: Address;
  /** The keeper's burn account (and Pump's volume account) exist. */
  ataExists = false;
  /** Changes the instructions of the next transactions before they are checked and signed (a compromised or wrong builder). */
  tamper: ((ixs: Ix[], a: Action) => Ix[]) | null = null;
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
  /** Every transaction that was signed, with the instructions it carried. */
  readonly signed: { action: Action; ixs: Ix[]; signature: string }[] = [];
  private readonly txs = new Map<string, { action: Action; ixs: Ix[]; outcome: Outcome | null; lastValid: number }>();
  private readonly wires = new Map<string, string>();
  private n = 0;

  constructor(readonly cfg: KeeperConfig, own: bigint) {
    this.base = fixture.transactions[0]!.snapshot;
    this.wallet = own;
    this.supply = this.base.mint.supply;
    this.genesis = this.base.genesis;
    this.ownAccount = this.base.tokenAta.address;
    this.burnAccount = burnAccountAddress(cfg.creator, this.base.mint.program);
  }
  /** What the keeper's burn account holds. */
  get tokens(): bigint { return this.balances.get(this.burnAccount) ?? 0n; }
  set tokens(v: bigint) { this.balances.set(this.burnAccount, v); }
  /** What the wallet's own token account holds: the owner's coins. */
  get own(): bigint { return this.balances.get(this.ownAccount) ?? 0n; }
  set own(v: bigint) { this.balances.set(this.ownAccount, v); }

  /** What the instructions do to token balances: an error, or the new balances and the supply burned. */
  private tokenEffects(ixs: Ix[]): { err: string | null; after: Map<Address, bigint>; burned: bigint } {
    const after = new Map(this.balances);
    let burned = 0n;
    const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);
    const debit = (acct: Address, n: bigint) => {
      const have = after.get(acct) ?? 0n;
      if (have < n) return false;
      after.set(acct, have - n);
      return true;
    };
    for (const ix of ixs) {
      const d = ix.data;
      if (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) {
        if (d[0] === 8 || d[0] === 15) { // Burn, BurnChecked
          if (!debit(ix.keys[0]!.pubkey, u64(d, 1))) return { err: "insufficient tokens", after, burned };
          burned += u64(d, 1);
        } else if (d[0] === 3 || d[0] === 12) { // Transfer, TransferChecked
          const dest = ix.keys[d[0] === 3 ? 1 : 2]!.pubkey;
          if (!debit(ix.keys[0]!.pubkey, u64(d, 1))) return { err: "insufficient tokens", after, burned };
          after.set(dest, (after.get(dest) ?? 0n) + u64(d, 1));
        }
      } else if (ix.programId === PUMP.program && ix.keys.length > 9 && d.length >= 24) after.set(ix.keys[9]!.pubkey, (after.get(ix.keys[9]!.pubkey) ?? 0n) + u64(d, 8)); // buy_v3: exact amount out
      else if (ix.programId === PUMP.amm && ix.keys.length > 5 && d.length >= 24) after.set(ix.keys[5]!.pubkey, (after.get(ix.keys[5]!.pubkey) ?? 0n) + u64(d, 8)); // buy_v2
    }
    return { err: null, after, burned };
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
      vault: this.vault, tokenAta: { address: this.ownAccount, exists: this.balances.has(this.ownAccount), amount: this.own },
      burnAccount: { address: this.burnAccount, exists: this.ataExists, amount: this.tokens },
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
      if (commit) this.ataExists = true;
    } else if (!commit && this.tokens < a.tokens) return { err: "insufficient tokens", delta: -fee, created: 0n, collected: 0n };
    return { err: null, delta, created, collected };
  }

  async simulate(a: Action): Promise<Sim> {
    if (this.simFail === a.kind) return { ok: false, error: "custom program error", logs: ["Program log: no"], units: 0, walletDelta: 0n, createdRent: 0n, size: 500 };
    const e = this.effect(a, 0n, false);
    return { ok: !e.err, error: e.err, logs: [], units: 50_000, walletDelta: e.delta, createdRent: e.created, size: 500 };
  }
  async sign(a: Action, s: Snapshot, _cu: number, _price: number, check: (ixs: Ix[]) => void): Promise<Prepared> {
    this.maybeDie(a.kind, "sign");
    const built = actionIxs(this.cfg, s, a);
    const ixs = this.tamper ? this.tamper(built, a) : built;
    check(ixs); // throws: nothing is signed
    const signature = `sig${++this.n}`;
    this.signed.push({ action: a, ixs, signature });
    this.txs.set(signature, { action: a, ixs, outcome: null, lastValid: this.height + 150 });
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
          const tok = this.tokenEffects(t.ixs);
          const e = tok.err ? { err: tok.err, delta: -fee, created: 0n, collected: 0n } : this.effect(t.action, fee, true);
          if (!e.err) {
            for (const [k, v] of tok.after) this.balances.set(k, v);
            this.supply -= tok.burned;
          }
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
    slippage_bps: 100, priority_fee: { percentile: 75, floor_micro_lamports: 0, cap_micro_lamports: 50000 }, protected_units: "0", confirm_timeout_s: 10, state_path: join(dir, "state.json"),
    log_path: join(dir, "runs.jsonl"), ...over,
  });
}
