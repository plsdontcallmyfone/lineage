// The runtime key pool (docs/plans/SEAMLESS-BIND.md section 10): runtime keys made ahead of time, each
// with a durable nonce account that already exists, so a launch can carry a backup bind signature
// that does not expire with a blockhash. A nonce account's value exists only once the account does
// (scripts/launch-e2e/nonce-devnet.ts), so the account cannot be made in the launch's own approval.
//
// Two processes, as with the key store:
//   - the RUNTIME side (PoolKeeper, the only code here that holds the platform payer, which is the
//     runtime authority key) makes keys and their nonce accounts, bounded by `target`, `low`, `cap` and
//     `per_pass`, and closes a nonce account when it has done its job, the rent back to the payer;
//   - the BIND SERVICE takes a ready key for a new reservation (takePoolKey) and gives it back when the
//     reservation expires without the key ever having signed (returnPoolKey). It holds no payer key.
//
// Files, all under <state_dir>/pool-keys (mode 700, key files 600), beside <state_dir>/keys:
//   <key id>.json          a ready key: its nonce account exists on chain with this key as authority
//   .making-<key id>.json  a key whose nonce account is being created (promoted or removed at the next pass)
//   issued.json            every key this pool ever made: public halves only, with what became of it
//   payer                  the payer's public key (the nonce account of a key is derived from it)
//   status.json            what the last pass saw, for the bind service's health answer
//
// A pool key is guarded by the transaction firewall from the moment it is read. In the pool it belongs
// to no agent, so it can sign one thing: the withdrawal of its own nonce account back to the payer.
// Taken for an agent it becomes that agent's key file and nothing else's; a key that ever co-signed is
// never given to another agent (reserve.ts sets it aside, and its nonce account is closed here).
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKey, keyFromSolanaJson, type AgentKey } from "@units/protocol";
import { guardKey } from "../../chain/src/guard.ts";
import { decodeNonceAccount, nonce, NONCE_ACCOUNT_LEN, nonceAccountFor } from "../../chain/src/nonce.ts";
import { keyFileIn, keyIfAny } from "./keystore.ts";

const KEY_FILE = /^([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/;
export const poolDir = (stateDir: string) => join(stateDir, "pool-keys");
const readJson = <T>(file: string): T | null => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
};
const writeAtomic = (file: string, body: unknown, mode = 0o600) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, typeof body === "string" ? body : JSON.stringify(body, null, 1), { mode });
  renameSync(tmp, file);
};

/** The ready keys' public halves (file names only: no key is read). */
export function readyPoolKeys(stateDir: string): string[] {
  try {
    return readdirSync(poolDir(stateDir)).map((f) => KEY_FILE.exec(f)?.[1]).filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

/** The payer whose address the pool's nonce accounts are derived from; null when no pool was ever made here. */
export function poolPayer(stateDir: string): string | null {
  try {
    const p = readFileSync(join(poolDir(stateDir), "payer"), "utf8").trim();
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p) ? p : null;
  } catch {
    return null;
  }
}

export interface IssuedKey {
  made_at: number;
  /** the nonce account was closed and its rent returned (the key is then an ordinary key, or retired) */
  closed_at?: number;
}
export const issuedKeys = (stateDir: string): Record<string, IssuedKey> => readJson<Record<string, IssuedKey>>(join(poolDir(stateDir), "issued.json")) ?? {};

/** The nonce account of `keyId` when it is a pool key whose account was not closed; null for every other key. */
export function poolNonceOf(stateDir: string, keyId: string): { account: string; payer: string } | null {
  const payer = poolPayer(stateDir);
  const k = payer ? issuedKeys(stateDir)[keyId] : undefined;
  return payer && k && !k.closed_at ? { account: nonceAccountFor(payer, keyId), payer } : null;
}

export interface PoolStatus {
  at: number;
  ok: boolean;
  why: string | null;
  ready: number;
  /** nonce accounts of this pool that exist on chain (ready, handed out, or waiting to be closed) */
  alive: number;
  target: number;
  low: number;
  cap: number;
  rent_lamports: string | null;
  /** rent held in the pool's nonce accounts now; it returns to the payer as they close */
  locked_lamports: string | null;
  payer: string | null;
  payer_lamports: string | null;
  made: number;
  closed: number;
}
export const poolStatus = (stateDir: string): PoolStatus | null => readJson<PoolStatus>(join(poolDir(stateDir), "status.json"));

/**
 * Bind service: gives `agent` a ready pool key as ITS key file, when the agent has none yet. The pool
 * file is linked to keys/<agent>.json (link fails when the agent already has a key: then that key
 * stays) and removed from the pool. Null when there is no ready key or the agent has a key.
 */
export function takePoolKey(stateDir: string, agent: string): AgentKey | null {
  const file = keyFileIn(stateDir, agent);
  if (existsSync(file)) return null;
  mkdirSync(join(stateDir, "keys"), { recursive: true, mode: 0o700 });
  for (const id of readyPoolKeys(stateDir)) {
    const from = join(poolDir(stateDir), `${id}.json`);
    try {
      linkSync(from, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; // the agent got a key meanwhile
      continue; // this pool key went away meanwhile: the next one
    }
    try {
      unlinkSync(from);
    } catch {
      /* already gone */
    }
    return keyIfAny(file);
  }
  return null;
}

/** Bind service: the agent never launched and the key never signed: it goes back to the pool, its nonce account untouched. */
export function returnPoolKey(stateDir: string, agent: string, keyId: string): boolean {
  if (!poolNonceOf(stateDir, keyId)) return false;
  const file = keyFileIn(stateDir, agent);
  try {
    linkSync(file, join(poolDir(stateDir), `${keyId}.json`));
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export interface PoolConfig {
  enabled?: boolean;
  /** ready keys the pool is filled up to */
  target?: number;
  /** a refill starts when fewer than this many are ready */
  low?: number;
  /** nonce accounts alive at once, never more (ready, handed out and waiting to be closed together) */
  cap?: number;
  /** creations in one pass (one pass a minute): the rate limit */
  per_pass?: number;
  /** lamports the payer keeps for its other work (binds, cranks, epoch posts): a refill never takes it below this */
  payer_floor_lamports?: number;
}
export const POOL_DEFAULTS = { target: 20, low: 8, cap: 40, per_pass: 4, payer_floor_lamports: 50_000_000 };

export interface PoolChain {
  rent(): Promise<bigint>;
  balance(address: string): Promise<bigint>;
  /** account infos in order; null for an account that does not exist */
  accounts(addresses: string[]): Promise<({ data: Uint8Array; lamports: bigint; owner: string } | null)[]>;
  /** signs with the payer and `extra`, sends and confirms */
  send(ixs: ReturnType<typeof nonce.create>, extra: AgentKey[]): Promise<string>;
  /** the registry signing key of `agent`; null when it has no record. Throws when the chain did not answer. */
  signingKey(agent: string): Promise<string | null>;
}

export interface PoolOwners {
  /** agent -> key id of the agents the runtime holds, and of live reservations */
  agents(): Record<string, { key_id: string }>;
  reserved(): Record<string, { key_id: string }>;
}

/** The runtime side: fills the pool and closes nonce accounts that are done. One pass at a time. */
export class PoolKeeper {
  private cfg: Required<Omit<PoolConfig, "enabled">>;
  private running: Promise<PoolStatus> | null = null;
  private log: (m: string) => void;
  private now: () => number;
  /** key id -> where its key file is, for keys that are neither ready nor an agent's the runtime knows */
  private found = new Map<string, string>();

  constructor(private o: { stateDir: string; payer: string; chain: PoolChain; owners: PoolOwners; config?: PoolConfig; log?: (m: string) => void; now?: () => number }) {
    const c = { ...POOL_DEFAULTS, ...(o.config ?? {}) };
    this.cfg = { target: c.target, low: Math.min(c.low, c.target), cap: Math.max(c.cap, 0), per_pass: Math.max(1, c.per_pass), payer_floor_lamports: c.payer_floor_lamports };
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    mkdirSync(poolDir(o.stateDir), { recursive: true, mode: 0o700 });
    const known = poolPayer(o.stateDir);
    if (known && known !== o.payer) throw new Error(`the key pool in ${poolDir(o.stateDir)} was made by payer ${known}, not ${o.payer}: its nonce accounts are derived from that address`);
    if (!known) writeAtomic(join(poolDir(o.stateDir), "payer"), `${o.payer}\n`, 0o644);
  }

  private dir = () => poolDir(this.o.stateDir);
  private saveIssued(i: Record<string, IssuedKey>) {
    writeAtomic(join(this.dir(), "issued.json"), i);
  }

  pass(): Promise<PoolStatus> {
    return (this.running ??= this.once().finally(() => (this.running = null)));
  }

  /** Where the key file of a pool key that is not ready lives: an agent's key file, or a retired key. */
  private fileOf(keyId: string, owners: Record<string, { key_id: string }>): { file: string; agent: string | null } | null {
    for (const [agent, s] of Object.entries(owners)) if (s.key_id === keyId) return { file: keyFileIn(this.o.stateDir, agent), agent };
    const hit = this.found.get(keyId);
    if (hit && existsSync(hit)) return { file: hit, agent: null };
    // retired keys (reserve.ts sets a key aside when its reservation expired after it had co-signed)
    const dir = join(this.o.stateDir, "expired-keys");
    try {
      for (const f of readdirSync(dir)) {
        if (!KEY_FILE.test(f)) continue;
        const file = join(dir, f);
        try {
          const id = keyFromSolanaJson(JSON.parse(readFileSync(file, "utf8"))).id;
          guardKey(id);
          this.found.set(id, file);
        } catch {
          /* not a key file */
        }
      }
    } catch {
      /* no retired keys */
    }
    const again = this.found.get(keyId);
    return again ? { file: again, agent: null } : null;
  }

  private async once(): Promise<PoolStatus> {
    const { chain, payer, stateDir } = this.o;
    const st: PoolStatus = { at: this.now(), ok: true, why: null, ready: 0, alive: 0, target: this.cfg.target, low: this.cfg.low, cap: this.cfg.cap, rent_lamports: null, locked_lamports: null, payer, payer_lamports: null, made: 0, closed: 0 };
    try {
      const issued = issuedKeys(stateDir);
      // a creation that was interrupted: promoted when its account exists, removed when it does not
      for (const f of readdirSync(this.dir()).filter((x) => x.startsWith(".making-"))) {
        const id = f.slice(".making-".length, -".json".length);
        const [acc] = await chain.accounts([nonceAccountFor(payer, id)]);
        if (acc && decodeNonceAccount(acc.data, acc.owner)?.authority === id) renameSync(join(this.dir(), f), join(this.dir(), `${id}.json`));
        else {
          unlinkSync(join(this.dir(), f));
          delete issued[id];
        }
        this.saveIssued(issued);
      }
      const open = Object.keys(issued).filter((id) => !issued[id]!.closed_at);
      const infos = await chain.accounts(open.map((id) => nonceAccountFor(payer, id)));
      const alive = new Map<string, bigint>();
      open.forEach((id, i) => {
        const a = infos[i];
        if (a && decodeNonceAccount(a.data, a.owner)?.authority === id) alive.set(id, a.lamports);
        else issued[id]!.closed_at = this.now(); // gone from chain: nothing to return
      });
      const ready = new Set(readyPoolKeys(stateDir));
      const owners = { ...this.o.owners.reserved(), ...this.o.owners.agents() };
      // close what is done: the agent is bound (the backup signature is void once the account is gone), or the key was retired
      for (const [id, lamports] of alive) {
        if (ready.has(id)) continue;
        const at = this.fileOf(id, owners);
        if (!at) continue; // its key file is not here: nothing can sign for it
        let close = at.agent === null;
        if (at.agent !== null) close = (await chain.signingKey(at.agent)) === id;
        // not bound: a reservation that may still launch, or a hosted launch that waits for its bind (the backup signature may be needed)
        if (!close) continue;
        const key = keyIfAny(at.file);
        if (!key || key.id !== id) continue;
        try {
          const sig = await chain.send([nonce.withdraw(nonceAccountFor(payer, id), payer, id, lamports)], [key]);
          issued[id]!.closed_at = this.now();
          alive.delete(id);
          st.closed++;
          this.saveIssued(issued);
          this.log(`key pool: closed the nonce account of ${id} (${at.agent ? `agent ${at.agent} is bound` : "a retired key"}), ${lamports} lamports back to the payer: ${sig}`);
        } catch (e) {
          this.log(`key pool: nonce account of ${id} not closed: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      // refill
      const rent = await chain.rent();
      st.rent_lamports = rent.toString();
      let balance = await chain.balance(payer);
      if (ready.size < this.cfg.low) {
        let want = Math.min(this.cfg.target - ready.size, this.cfg.cap - alive.size, this.cfg.per_pass);
        const each = rent + 10_000n;
        while (want > 0 && balance - each < BigInt(this.cfg.payer_floor_lamports)) want--;
        if (want <= 0 && ready.size === 0) {
          st.ok = false;
          st.why = alive.size >= this.cfg.cap ? `the pool is at its cap of ${this.cfg.cap} nonce accounts and none is ready` : `the payer holds ${balance} lamports: a refill would take it under its floor of ${this.cfg.payer_floor_lamports}`;
        }
        for (let i = 0; i < want; i++) {
          if (balance - each < BigInt(this.cfg.payer_floor_lamports)) break;
          const key = generateAgentKey();
          guardKey(key.id);
          const making = join(this.dir(), `.making-${key.id}.json`);
          writeFileSync(making, JSON.stringify(Array.from(key.secret)), { mode: 0o600, flag: "wx" });
          issued[key.id] = { made_at: this.now() };
          this.saveIssued(issued);
          try {
            const sig = await chain.send(nonce.create(payer, key.id, rent), []);
            renameSync(making, join(this.dir(), `${key.id}.json`));
            ready.add(key.id);
            alive.set(key.id, rent);
            balance -= each;
            st.made++;
            this.log(`key pool: made key ${key.id} with nonce account ${nonceAccountFor(payer, key.id)} (${rent} lamports, returned when it closes): ${sig}`);
          } catch (e) {
            unlinkSync(making);
            delete issued[key.id];
            this.saveIssued(issued);
            st.ok = ready.size > 0;
            st.why = `a nonce account could not be created: ${(e as Error).message.split("\n")[0]!.slice(0, 160)}`;
            this.log(`key pool: ${st.why}`);
            break;
          }
        }
      }
      this.saveIssued(issued);
      st.ready = ready.size;
      st.alive = alive.size;
      st.locked_lamports = [...alive.values()].reduce((a, b) => a + b, 0n).toString();
      st.payer_lamports = (await chain.balance(payer).catch(() => balance)).toString();
    } catch (e) {
      st.ok = false;
      st.why = `pool pass failed: ${(e as Error).message.split("\n")[0]!.slice(0, 160)}`;
      st.ready = readyPoolKeys(stateDir).length;
      this.log(`key pool: ${st.why}`);
    }
    writeAtomic(join(this.dir(), "status.json"), st, 0o644);
    return st;
  }

  start(everyMs = 60_000): () => void {
    void this.pass();
    const t = setInterval(() => void this.pass(), everyMs);
    return () => clearInterval(t);
  }
}
void NONCE_ACCOUNT_LEN;
