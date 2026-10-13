// Joining a repository's pool for an agent that is already launched (docs/plans/AGENT-POOLS.md 11):
// the state of one agent, the action it offers, what joining does in plain words and what it costs.
// Pure functions of chain reads, no browser and no RPC here, so the page's logic is unit tested.
// Every number in a sentence is an argument: PoolConfig as read from chain, never a constant.

/** The fields of PoolConfig the page states (packages/chain decodePoolConfig). */
export interface JoinCfg { paused: boolean; maxMembers: number; poolFeeBps: number; payoutBps: number; buybackBps: number; burnBps: number; crossHoldQuote: bigint }

export type JoinState =
  /** pools are not switched on for this network (the chain's feature bit, or Core's flag) */
  | { kind: "off" }
  /** the admin paused pools: the program refuses a join */
  | { kind: "paused" }
  /** a record of another venue: the program joins pump.fun launches only */
  | { kind: "other_venue" }
  /** already a member; `routing` is false while it is alone in its pool */
  | { kind: "member"; members: string[]; routing: boolean }
  /** the pool holds as many members as the program's setting allows */
  | { kind: "full"; members: string[]; max: number }
  /** no pool for this repository yet: this agent would open it as its first member */
  | { kind: "open" }
  /** a pool exists: this agent can join it */
  | { kind: "join"; members: string[] };

/** What the Pools page offers one agent, from what the chain holds for it. */
export function joinState(a: { featureOn: boolean; cfg: JoinCfg | null; venue: string; agent: string; isMember: boolean; pool: { members: string[] } | null }): JoinState {
  const members = a.pool?.members ?? [];
  // a membership is shown whatever the switches say: it exists on chain
  if (a.isMember || members.includes(a.agent)) return { kind: "member", members, routing: members.length >= 2 && !!a.cfg && !a.cfg.paused && a.featureOn };
  if (!a.featureOn || !a.cfg) return { kind: "off" };
  if (a.cfg.paused) return { kind: "paused" };
  if (a.venue !== "pump") return { kind: "other_venue" };
  if (!members.length) return { kind: "open" };
  if (members.length >= a.cfg.maxMembers) return { kind: "full", members, max: a.cfg.maxMembers };
  return { kind: "join", members };
}

/** A share in basis points as a percentage: 2000 is "20%", 1250 is "12.5%". */
export const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** The one primary action of an agent's row, or null when it has none. */
export function actionLabel(s: JoinState, agentName: string, repoName: string): string | null {
  if (s.kind === "open") return `Open this repository's pool with ${agentName}`;
  if (s.kind === "join") return `Join the pool of ${repoName}`;
  return null;
}

/** The line under an agent's name: where it stands. */
export function stateLine(s: JoinState, repoName: string): string {
  switch (s.kind) {
    case "off": return "Pools are not open on this network.";
    case "paused": return "Pools are paused by the network's admin. Nothing can join until they are opened again.";
    case "other_venue": return "This agent's coin was not launched on pump.fun, and only pump.fun launches can join a pool.";
    case "member": return s.members.length < 2
      ? `In the pool of ${repoName}, alone so far. A pool starts routing fees only when a second agent joins.`
      : s.routing ? `In the pool of ${repoName} with ${s.members.length - 1} other ${plural(s.members.length - 1, "agent")}. Its pool share is routed at every fee collection.`
      : `In the pool of ${repoName} with ${s.members.length - 1} other ${plural(s.members.length - 1, "agent")}. Routing is paused by the network's admin.`;
    case "full": return `The pool of ${repoName} is full: ${s.members.length} of ${s.max} agents.`;
    case "open": return `${repoName} has no pool yet. The first member opens it. A pool starts routing fees only when a second agent joins.`;
    case "join": return `${repoName} has a pool with ${s.members.length} ${plural(s.members.length, "agent")}.`;
  }
}

export interface Fact { key: "share" | "split" | "cross" | "compute" | "undo" | "settings"; text: string }

/**
 * What joining does, sentence by sentence, for the review before signing. `others` is how many
 * members the pool has now. `routeBps` is the agent's fee route to its repository's owners (null
 * without one). `usd` turns $UNITS base units into a dollar figure, or null when no price is known.
 */
export function joinFacts(a: { cfg: JoinCfg; others: number; routeBps: number | null; agentName: string; coin: (base: bigint) => string; usd: (base: bigint) => string | null; maxFeeBps: number }): Fact[] {
  const { cfg, others, agentName: name } = a;
  const amount = (base: bigint) => { const d = a.usd(base); return d ? `about ${d} (${a.coin(base)})` : `${a.coin(base)} (no US dollar price right now)`; };
  const facts: Fact[] = [];
  facts.push({ key: "share", text: `${pct(cfg.poolFeeBps)} of the creator fees ${name} keeps go to the pool's vault each time its fees are collected. ${others === 0
    ? "A pool with one member routes nothing: this starts when a second agent joins."
    : others === 1 ? "With this agent the pool has two members, so routing starts for both." : "The pool is already routing."}` });
  facts.push({ key: "split", text: `What reaches the vault is split three ways: ${pct(cfg.payoutBps)} is paid to members by their verified work, into their compute balance; ${pct(cfg.buybackBps)} buys members' coins when a member's change is accepted; ${pct(cfg.burnBps)} buys members' coins and burns them when the repository crosses a milestone.` });
  if (cfg.crossHoldQuote > 0n) {
    const each = amount(cfg.crossHoldQuote);
    const who = others === 0 ? `When another agent joins, ${name} buys ${each} of its coin, and it buys the same amount of ${name}'s coin.`
      : others === 1 ? `${name} buys ${each} of the other member's coin, and that member buys the same amount of ${name}'s coin.`
      : `${name} buys ${each} of each of the ${others} other members' coins, ${amount(cfg.crossHoldQuote * BigInt(others))} in all, and each of them buys the same amount of ${name}'s coin.`;
    facts.push({ key: "cross", text: `Cross holding: ${who} Your wallet does not pay for this, now or later. Each agent's purchases are paid from its own pool share, first: until they are covered, nothing from that agent reaches payouts, buybacks or burns. The network's keeper sends the purchases and the coins are held by the agent.` });
  } else {
    facts.push({ key: "cross", text: "Cross holding: none is set. Members do not buy each other's coins on joining." });
  }
  const left = 10_000 - cfg.poolFeeBps - (a.routeBps ?? 0);
  facts.push({ key: "compute", text: a.routeBps
    ? `${name} already routes ${pct(a.routeBps)} of the fees it keeps to the owners of its repository. Both shares come out of the same fees, so ${pct(left)} is left for its own compute.`
    : `The other ${pct(left)} of the fees it keeps still go to its own compute.` });
  facts.push({ key: "undo", text: `Joining cannot be undone. The program has no way to leave a pool, and what ${name} routed stays in the pool.` });
  facts.push({ key: "settings", text: `These are the network's settings as read from the chain now. The network's admin can change them for every member; the program never lets the pool share go above ${pct(a.maxFeeBps)}.` });
  return facts;
}

export interface JoinCost { lines: { key: "pool" | "vault" | "member" | "fee"; label: string; lamports: bigint }[]; rent: bigint; fee: bigint; total: bigint }

/**
 * What one join costs the signing wallet: the rent of the accounts the program creates (the pool
 * and its vault only for the first member) and the network fee. No instruction closes these
 * accounts, so the rent does not come back.
 */
export function joinCost(a: { opens: boolean; rent: { pool: bigint; vault: bigint; member: bigint }; fee: bigint }): JoinCost {
  const lines: JoinCost["lines"] = [];
  if (a.opens) lines.push({ key: "pool", label: "The pool's account", lamports: a.rent.pool }, { key: "vault", label: "The pool's vault", lamports: a.rent.vault });
  lines.push({ key: "member", label: "This agent's membership", lamports: a.rent.member });
  const rent = lines.reduce((s, l) => s + l.lamports, 0n);
  lines.push({ key: "fee", label: "Network fee", lamports: a.fee });
  return { lines, rent, fee: a.fee, total: rent + a.fee };
}

/**
 * The rent the simulated join really charges: the lamports of each account the simulation created
 * (packages/chain simulateDetailed). Null when the simulation did not create the membership, which
 * means it did not run the join.
 */
export function rentFromSimulation(accounts: { address: string; created: boolean; after: bigint | null }[], at: { pool: string; vault: string; member: string }): { opens: boolean; rent: { pool: bigint; vault: bigint; member: bigint } } | null {
  const made = (address: string) => { const a = accounts.find((x) => x.address === address); return a && a.created && a.after !== null ? a.after : null; };
  const member = made(at.member), pool = made(at.pool), vault = made(at.vault);
  if (member === null) return null;
  return { opens: pool !== null, rent: { pool: pool ?? 0n, vault: vault ?? 0n, member } };
}

/** The base fee of one signature plus the priority fee of `units` compute units at `microLamports` each. */
export const networkFee = (units: number, microLamports: number): bigint => 5000n + BigInt(Math.ceil((units * microLamports) / 1_000_000));

/** The compute limit a join is sent with: measured 77,781 units for a first member and 53,586 for a second on the fork of mainnet, more with each existing member's record. */
export const joinUnits = (others: number): number => 160_000 + 20_000 * others;
