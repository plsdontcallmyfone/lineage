import { addressBytes, hexToBytes, ixDisc, Reader, Writer, type Address } from "./codec.ts";
import { ata, ASSOCIATED_TOKEN_PROGRAM, pda, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM } from "./pda.ts";
import { r, registryPdas, w, type AccountMeta, type Ix } from "./registry.ts";
import { LAUNCH_PROGRAM_ID } from "./programs.ts";
import { launchPdas } from "./launch.ts";
import { pump, pumpAmm, pumpPdas, PUMP } from "./pump.ts";

// Agent pools of units_launch (docs/plans/AGENT-POOLS.md, program src/pool.rs): PDAs, builders and
// decoders. A pool is keyed by the repository id the program computed at launch. Buys are sent by
// the pool keeper; the program builds the venue instruction itself and checks the result by balances.

export const POOL_BUY = { cross: 0, buyback: 1, burn: 2 } as const;
export const POOL_VENUE = { curve: 0, amm: 1 } as const;
export const MAX_POOL_MEMBERS = 16;

const repoBytes = (repoId: string | Uint8Array) => (typeof repoId === "string" ? hexToBytes(repoId) : repoId);

export const poolPdas = {
  config: () => pda(LAUNCH_PROGRAM_ID, "pool_config"),
  pool: (repoId: string | Uint8Array) => pda(LAUNCH_PROGRAM_ID, "pool", repoBytes(repoId)),
  /** Signer only: owns the pool vault (its $UNITS ATA) and one ATA per member mint. */
  auth: (repoId: string | Uint8Array) => pda(LAUNCH_PROGRAM_ID, "pool_auth", repoBytes(repoId)),
  member: (agent: Address) => pda(LAUNCH_PROGRAM_ID, "pool_member", addressBytes(agent)),
  cross: (holder: Address, target: Address) => pda(LAUNCH_PROGRAM_ID, "cross", addressBytes(holder), addressBytes(target)),
  vault: (repoId: string | Uint8Array, lineMint: Address, lineTokenProgram: Address = TOKEN_2022_PROGRAM) => ata(poolPdas.auth(repoId), lineMint, lineTokenProgram),
  /** Where an agent holds its cross-holding of `mint`: the agent key's own token account, beside its launch holding. */
  heldBy: (agent: Address, mint: Address) => ata(agent, mint, TOKEN_2022_PROGRAM),
  /** Where the pool holds a member's token (buybacks). */
  holding: (repoId: string | Uint8Array, mint: Address) => ata(poolPdas.auth(repoId), mint, TOKEN_2022_PROGRAM),
};

export interface PoolConfigArgs {
  keeper: Address;
  autoJoin: boolean;
  paused: boolean;
  maxMembers: number;
  poolFeeBps: number;
  payoutBps: number;
  buybackBps: number;
  burnBps: number;
  authorBuybackBps: number;
  buybackPerGenBps: number;
  burnPerMilestoneBps: number;
  crossHoldQuote: bigint;
  maxBuyQuote: bigint;
}

const data = (name: string) => new Writer().bytes(ixDisc(name));

/** The venue instruction's accounts as `pool_buy` forwards them: nobody signs at the top level. */
function venueKeys(a: { repoId: string; mint: Address; lineMint: Address; lineTokenProgram: Address; venue: number }): AccountMeta[] {
  const user = poolPdas.auth(a.repoId);
  const ix = a.venue === POOL_VENUE.amm
    ? pumpAmm.buyV2({ pool: pumpPdas.pool(a.mint, a.lineMint), mint: a.mint, quoteMint: a.lineMint, user, quoteTokenProgram: a.lineTokenProgram, baseOut: 0n, maxQuoteIn: 0n })
    : pump.buyV3({ mint: a.mint, quoteMint: a.lineMint, user, quoteTokenProgram: a.lineTokenProgram, amount: 0n, maxQuoteIn: 0n });
  return ix.keys.map((k) => ({ ...k, isSigner: false }));
}

export const pools = {
  setPoolConfig(a: { admin: Address; args: PoolConfigArgs }): Ix {
    const c = a.args;
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), w(a.admin, true), w(poolPdas.config()), r(SYSTEM_PROGRAM)],
      data: data("set_pool_config").address(c.keeper).bool(c.autoJoin).bool(c.paused).u8(c.maxMembers).u16(c.poolFeeBps).u16(c.payoutBps).u16(c.buybackBps)
        .u16(c.burnBps).u16(c.authorBuybackBps).u16(c.buybackPerGenBps).u16(c.burnPerMilestoneBps).u64(c.crossHoldQuote).u64(c.maxBuyQuote).done(),
    };
  },
  /** `signer`: the agent's registry owner, or anyone while auto_join is on. `members`: the pool's current member agents, in order. */
  joinPool(a: { signer: Address; agent: Address; agentMint: Address; repoId: string; lineMint: Address; members: Address[]; lineTokenProgram?: Address }): Ix {
    const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM;
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), r(poolPdas.config()), w(a.signer, true), w(launchPdas.agentLaunch(a.agentMint)), r(registryPdas.agent(a.agent)),
        w(poolPdas.pool(a.repoId)), w(poolPdas.member(a.agent)), r(poolPdas.auth(a.repoId)), w(poolPdas.vault(a.repoId, a.lineMint, tp)), r(a.lineMint), r(tp),
        r(ASSOCIATED_TOKEN_PROGRAM), r(SYSTEM_PROGRAM), ...a.members.map((m) => w(poolPdas.member(m)))],
      data: data("join_pool").done(),
    };
  },
  /** Keeper: one settlement per pool and posted registry epoch. `weights` in member order, bps. */
  poolSettle(a: { keeper: Address; repoId: string; members: Address[]; epoch: bigint | number; gens: number; weights: number[]; milestones: number; evidence: string | Uint8Array }): Ix {
    const d = data("pool_settle").u64(a.epoch).u16(a.gens).u32(a.weights.length);
    for (const x of a.weights) d.u16(x);
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), r(poolPdas.config()), r(a.keeper, true), r(registryPdas.config()), w(poolPdas.pool(a.repoId)), ...a.members.map((m) => w(poolPdas.member(m)))],
      data: d.u8(a.milestones).fixed32(a.evidence).done(),
    };
  },
  /** Anyone: a member's allocated payout into its compute vault. */
  poolPay(a: { repoId: string; agent: Address; agentMint: Address; lineMint: Address; lineTokenProgram?: Address }): Ix {
    const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM;
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), w(poolPdas.pool(a.repoId)), r(poolPdas.auth(a.repoId)), w(poolPdas.vault(a.repoId, a.lineMint, tp)), w(poolPdas.member(a.agent)),
        w(launchPdas.agentLaunch(a.agentMint)), w(launchPdas.computeVault(a.agent)), r(a.lineMint), r(tp)],
      data: data("pool_pay").done(),
    };
  },
  /** Keeper: buys `target`'s token with its buyback (held) or burn (burned) budget. */
  poolBuy(a: { keeper: Address; repoId: string; target: Address; targetMint: Address; lineMint: Address; kind: number; venue: number; tokenAmount: bigint; maxQuote: bigint;
    lineTokenProgram?: Address }): Ix {
    const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM;
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), r(poolPdas.config()), r(a.keeper, true), w(poolPdas.pool(a.repoId)), w(poolPdas.auth(a.repoId)), w(poolPdas.vault(a.repoId, a.lineMint, tp)),
        w(poolPdas.member(a.target)), w(a.targetMint), w(poolPdas.holding(a.repoId, a.targetMint)), r(TOKEN_2022_PROGRAM),
        r(a.venue === POOL_VENUE.amm ? PUMP.amm : PUMP.program), ...venueKeys({ repoId: a.repoId, mint: a.targetMint, lineMint: a.lineMint, lineTokenProgram: tp, venue: a.venue })],
      data: data("pool_buy").u8(a.kind).u8(a.venue).u64(a.tokenAmount).u64(a.maxQuote).done(),
    };
  },
  /**
   * Keeper: `holder`'s cross-holding purchase of `target`'s token, once per ordered pair. The pool authority buys and the
   * tokens land in the holder agent's own token account (`poolPdas.heldBy`, which must exist): held by the agent.
   */
  poolCrossBuy(a: { keeper: Address; repoId: string; holder: Address; target: Address; targetMint: Address; lineMint: Address; venue: number; tokenAmount: bigint;
    maxQuote: bigint; lineTokenProgram?: Address }): Ix {
    const tp = a.lineTokenProgram ?? TOKEN_2022_PROGRAM;
    return {
      programId: LAUNCH_PROGRAM_ID,
      keys: [r(launchPdas.config()), r(poolPdas.config()), w(a.keeper, true), w(poolPdas.pool(a.repoId)), w(poolPdas.auth(a.repoId)), w(poolPdas.vault(a.repoId, a.lineMint, tp)),
        w(poolPdas.member(a.holder)), w(poolPdas.member(a.target)), w(poolPdas.cross(a.holder, a.target)), r(a.targetMint), w(poolPdas.holding(a.repoId, a.targetMint)),
        w(poolPdas.heldBy(a.holder, a.targetMint)), r(TOKEN_2022_PROGRAM), r(a.venue === POOL_VENUE.amm ? PUMP.amm : PUMP.program), r(SYSTEM_PROGRAM),
        ...venueKeys({ repoId: a.repoId, mint: a.targetMint, lineMint: a.lineMint, lineTokenProgram: tp, venue: a.venue })],
      data: data("pool_cross_buy").u8(a.venue).u64(a.tokenAmount).u64(a.maxQuote).done(),
    };
  },
  /** The crank's trailing accounts for a pool member. */
  crankRouteKeys(agent: Address, repoId: string, lineMint: Address, lineTokenProgram: Address = TOKEN_2022_PROGRAM): AccountMeta[] {
    return [r(poolPdas.config()), w(poolPdas.member(agent)), w(poolPdas.pool(repoId)), w(poolPdas.vault(repoId, lineMint, lineTokenProgram))];
  },
};

export type PoolConfig = PoolConfigArgs;
export function decodePoolConfig(d: Uint8Array): PoolConfig {
  const rd = new Reader(d).expect("PoolConfig");
  return { keeper: rd.address(), autoJoin: rd.bool(), paused: rd.bool(), maxMembers: rd.u8(), poolFeeBps: rd.u16(), payoutBps: rd.u16(), buybackBps: rd.u16(), burnBps: rd.u16(),
    authorBuybackBps: rd.u16(), buybackPerGenBps: rd.u16(), burnPerMilestoneBps: rd.u16(), crossHoldQuote: rd.u64(), maxBuyQuote: rd.u64() };
}

export interface Pool {
  repoId: string;
  members: Address[];
  vault: Address;
  createdAt: bigint;
  bucketPayout: bigint;
  bucketBuyback: bigint;
  bucketBurn: bigint;
  settled: boolean;
  lastEpoch: bigint;
  gens: bigint;
  milestones: number;
  contributed: bigint;
  paid: bigint;
  bought: bigint;
  burnSpent: bigint;
}
export function decodePool(d: Uint8Array): Pool {
  const rd = new Reader(d).expect("Pool");
  const repoId = rd.hex32();
  const members = Array.from({ length: rd.u32() }, () => rd.address());
  return { repoId, members, vault: rd.address(), createdAt: rd.i64(), bucketPayout: rd.u64(), bucketBuyback: rd.u64(), bucketBurn: rd.u64(), settled: rd.bool(),
    lastEpoch: rd.u64(), gens: rd.u64(), milestones: rd.u32(), contributed: rd.u64(), paid: rd.u64(), bought: rd.u64(), burnSpent: rd.u64() };
}

export interface PoolMember {
  pool: Address;
  agent: Address;
  mint: Address;
  index: number;
  joinedAt: bigint;
  contributed: bigint;
  crossPairs: number;
  crossDue: bigint;
  crossFunded: bigint;
  payoutDue: bigint;
  buybackDue: bigint;
  burnDue: bigint;
  paid: bigint;
  boughtQuote: bigint;
  tokensHeld: bigint;
  tokensBurned: bigint;
}
export function decodePoolMember(d: Uint8Array): PoolMember {
  const rd = new Reader(d).expect("PoolMember");
  return { pool: rd.address(), agent: rd.address(), mint: rd.address(), index: rd.u8(), joinedAt: rd.i64(), contributed: rd.u64(), crossPairs: rd.u8(), crossDue: rd.u64(),
    crossFunded: rd.u64(), payoutDue: rd.u64(), buybackDue: rd.u64(), burnDue: rd.u64(), paid: rd.u64(), boughtQuote: rd.u64(), tokensHeld: rd.u64(), tokensBurned: rd.u64() };
}

export interface CrossHolding {
  holder: Address;
  target: Address;
  quoteSpent: bigint;
  tokens: bigint;
  boughtAt: bigint;
}
export function decodeCrossHolding(d: Uint8Array): CrossHolding {
  const rd = new Reader(d).expect("CrossHolding");
  return { holder: rd.address(), target: rd.address(), quoteSpent: rd.u64(), tokens: rd.u64(), boughtAt: rd.i64() };
}

/** How one settlement divides the buckets (pool.rs `pool_settle`), for Core's record and verify-settlement. */
export function settlementAllocation(cfg: Pick<PoolConfig, "authorBuybackBps" | "buybackPerGenBps" | "burnPerMilestoneBps">,
  buckets: { payout: bigint; buyback: bigint; burn: bigint }, a: { gens: number; weights: number[]; milestones: number }) {
  const n = a.weights.length, bps = (x: bigint, b: number | bigint) => (x * BigInt(b)) / 10_000n, cap = (x: number) => BigInt(Math.min(10_000, x));
  const members = a.weights.map(() => ({ payout: 0n, buyback: 0n, burn: 0n }));
  if (a.gens > 0) {
    const b = bps(buckets.buyback, cap(a.gens * cfg.buybackPerGenBps));
    a.weights.forEach((wt, i) => {
      if (!wt) return;
      members[i]!.payout += bps(buckets.payout, wt);
      const bi = bps(b, wt), own = bps(bi, cfg.authorBuybackBps), each = (bi - own) / BigInt(n - 1);
      members[i]!.buyback += own;
      members.forEach((m, j) => { if (j !== i) m.buyback += each; });
    });
  }
  if (a.milestones > 0) {
    const each = bps(buckets.burn, cap(a.milestones * cfg.burnPerMilestoneBps)) / BigInt(n);
    for (const m of members) m.burn += each;
  }
  return members;
}
