import { join } from "node:path";
import { loadOrCreateKeypair, Rpc, type Signer } from "@lineage/chain";
import type { AgentKey } from "@lineage/protocol";
import { CoreClient } from "../../core/src/client.ts";
import { ChainVenue } from "./chain-venue.ts";
import { ChainFunder, FundingStore, tradeShareOf, type ShareBasis } from "./funding.ts";
import { Trader, type MarketToken, type TradingAgent } from "./trader.ts";
import type { Venue } from "./venue.ts";
import { routedDecisionModel, type Usage } from "./analyst.ts";
import { RegistrySource } from "../../runtime/src/providers.ts";

// Wiring of the trader into the hosted runtime (packages/runtime): the runtime calls `share` when a
// usage epoch is due (the trade share rides the agent's usage leaf) and `forward` after epochs post
// (the share goes from the compute sink to the treasury); `attach` gives the trader the runtime's
// bound agents and their keys, and `start` runs the trader's own loop next to the runtime's.

/** The `trading` block of runtime.json. Absent or enabled false: the runtime does not trade. */
export interface TradingRuntimeConfig {
  enabled: boolean;
  /** seconds between trader ticks (default 60) */
  poll_s?: number;
  /** market indexer base URL (default http://127.0.0.1:9668) */
  market?: string;
}

/** What the runtime calls (structurally typed so the runtime does not import this package's internals). */
export interface TradingHooks {
  share(o: { agent: string; mint: string; vault: bigint; computeOwed: bigint; wake: bigint }): Promise<{ amount: bigint; basis: ShareBasis } | null>;
  forward(epochs: ShareEpoch[], save: () => void): Promise<void>;
}

/** The parts of a closed usage epoch the forwarder reads and writes. */
export interface ShareEpoch {
  epoch: number;
  done: boolean;
  debits: Record<string, string>;
  leaves: { agent: string; amount: string; cost: string; trade_share?: string; trade_basis?: unknown; trade_forward?: string | null }[];
}

/** What the trader reads from the runtime. */
export interface RuntimeView {
  state: { agents: Record<string, { status: string; mint: string | null; key_id: string }> };
  store: { keyFor(agent: string): AgentKey };
  /** the runtime's caps, metering and board posts for analyses (packages/runtime runtime.ts) */
  analysisSurface?(): { room(agent: string, reserve?: number): number; meter(agent: string, u: Usage): void; send(agent: string, to: string, text: string): Promise<string | null> };
}

/** What of a leaf's trade share reached the sink: the vault paid min(cost, balance), compute first. */
export function forwardAmount(l: { amount: string; cost: string; trade_share?: string }): bigint {
  const share = BigInt(l.trade_share ?? "0");
  const left = BigInt(l.amount) - (BigInt(l.cost) - share);
  return left <= 0n ? 0n : left < share ? left : share;
}

export async function marketTokens(market: string): Promise<MarketToken[]> {
  const r = await fetch(`${market.replace(/\/+$/, "")}/market/tokens?limit=500`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`market: HTTP ${r.status}`);
  const body = (await r.json()) as { tokens: { mint: string; agent: string; price: number | null; decimals?: number; change_24h: number | null; phase: string; migrated?: boolean; venue?: string; symbol?: string | null; volume_24h?: number | null; trades_24h?: number | null; holders?: number | null; curve_progress?: number | null; repo_url?: string | null; class?: string | null; lineage_id?: string | null }[] };
  const numOrNull = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return body.tokens.map((t) => ({
    mint: t.mint,
    agent: t.agent,
    price: typeof t.price === "number" && t.price > 0 ? t.price : null,
    decimals: typeof t.decimals === "number" ? t.decimals : 6,
    change_24h: typeof t.change_24h === "number" ? t.change_24h : null,
    // pump.fun only; launches the Meteora venue recorded (devnet history) are read-only: not tradable
    venue: t.venue === "meteora" ? null : t.phase === "graduated" || t.migrated ? "pump_pool" : "pump_curve",
    info: {
      symbol: typeof t.symbol === "string" ? t.symbol : null,
      phase: t.phase ?? null,
      volume_24h: numOrNull(t.volume_24h),
      trades_24h: numOrNull(t.trades_24h),
      holders: numOrNull(t.holders),
      curve_progress: numOrNull(t.curve_progress),
      repo_url: typeof t.repo_url === "string" ? t.repo_url : null,
      class: typeof t.class === "string" ? t.class : null,
      lineage_id: typeof t.lineage_id === "string" ? t.lineage_id : null,
    },
  }));
}

export interface TradingSetup {
  hooks: TradingHooks;
  trader: Trader;
  attach(rt: RuntimeView): void;
  start(): () => void;
}

/**
 * Devnet trading for a runtime. `escrow` is created under the state directory (trader/escrow.json)
 * on first use; its tLINE account is the allocation escrow the admin publishes in the trading config.
 */
export function chainTrading(o: {
  core: string;
  stateDir: string;
  runtimeKey: Signer;
  rpcUrl: string;
  cfg: TradingRuntimeConfig;
  log: (m: string) => void;
  onTx?: (what: string, sig: string, fee?: number) => void;
  venue?: Venue;
  rpc?: Rpc;
  /** provider keys on this host (providers.env, model.env): the agents' own models analyse with them */
  keys?: Record<string, string>;
}): TradingSetup {
  const rpc = o.rpc ?? Rpc.http(o.rpcUrl, "confirmed");
  const escrow = loadOrCreateKeypair(join(o.stateDir, "trader", "escrow.json")).key;
  const funder = new ChainFunder(rpc, o.runtimeKey, { escrow, log: o.log, onTx: o.onTx });
  const store = new FundingStore(join(o.stateDir, "trader", "funding.json"));
  const venue = o.venue ?? new ChainVenue(rpc, { log: o.log, onTx: o.onTx });
  let rt: RuntimeView | null = null;
  const registry = new RegistrySource({ core: o.core, log: (m) => o.log(`trader: ${m}`) });
  const agents = async (): Promise<TradingAgent[]> => {
    if (!rt) return [];
    return Object.entries(rt.state.agents)
      .filter(([, s]) => s.status === "bound" && s.mint)
      .map(([agent, s]) => ({ agent, mint: s.mint, key: rt!.store.keyFor(agent) }));
  };
  const trader = new Trader({
    core: o.core,
    runtimeKey: o.runtimeKey,
    venue,
    tokens: () => marketTokens(o.cfg.market ?? "http://127.0.0.1:9668"),
    agents,
    stateDir: join(o.stateDir, "trader"),
    lineDecimals: 6,
    log: (m) => o.log(`trader: ${m}`),
    gas: (treasury, lamports) => funder.gas(treasury, lamports),
    analysis: {
      model: (agent, override) => routedDecisionModel({ core: o.core, agent, keys: o.keys ?? {}, registry, override }),
      room: (agent, reserve) => rt?.analysisSurface?.().room(agent, reserve) ?? 0,
      meter: (agent, u) => rt?.analysisSurface?.().meter(agent, u),
      post: async (agent, board, text) => (rt?.analysisSurface ? rt.analysisSurface().send(agent, board, text) : null),
    },
  });
  const anon = new CoreClient(o.core, null);
  const bps = async () => {
    const r = await anon.get("/v1/trading/config");
    return r.status === 200 && r.body.enabled ? Number(r.body.trade_share_bps) : 0;
  };

  const hooks: TradingHooks = {
    async share(a) {
      const toCompute = await funder.feeIncome(a.mint);
      const base = store.baseline(a.agent, toCompute, Date.now());
      const s = tradeShareOf({ mint: a.mint, toCompute, baseline: base, bps: await bps(), vault: a.vault, computeOwed: a.computeOwed, wake: a.wake });
      if (s.amount === null) {
        if (s.why !== "no new fee income" && s.why !== "trade_share_bps is 0") o.log(`trader: ${a.agent.slice(0, 6)} trade share not taken: ${s.why}`);
        return null;
      }
      return { amount: s.amount, basis: s.basis };
    },
    async forward(epochs, save) {
      for (const e of epochs) {
        for (const l of e.leaves) {
          if (!l.trade_share || l.trade_forward !== undefined) continue;
          const debit = e.debits[l.agent];
          if (!debit || debit === "none") continue;
          const fwd = forwardAmount(l);
          const basis = l.trade_basis as ShareBasis;
          const key = rt?.state.agents[l.agent];
          if (!key || fwd === 0n) {
            l.trade_forward = null;
            save();
            continue;
          }
          const sig = await funder.forwardShare(key.key_id, fwd, `${l.agent}:${e.epoch}`);
          l.trade_forward = sig;
          save();
          store.commit(l.agent, basis.to_compute_to, Date.now());
          trader.noteFunding(l.agent, fwd);
          await trader.publish({
            kind: "funding", ref: `share:${l.agent}:${e.epoch}`, agent: l.agent, at: Date.now(), source: "trade_share", amount: fwd.toString(), signature: sig,
            treasury: key.key_id, basis: { ...basis, usage_epoch: e.epoch, debit, leaf_amount: l.amount, leaf_cost: l.cost },
          });
          o.log(`trader: ${l.agent.slice(0, 6)} trade share ${fwd} forwarded (usage epoch ${e.epoch}, debit ${debit.slice(0, 10)}..., ${sig.slice(0, 10)}...)`);
        }
      }
    },
  };

  /** Allocation deposits: forwarded once their agent is bound (pending ones are kept). */
  const allocations = async () => {
    const { deposits, cursor } = await funder.deposits(store.state.alloc_cursor);
    for (const d of deposits)
      if (!store.state.allocations[d.sig]) store.state.allocations[d.sig] = { agent: d.agent, amount: d.amount.toString(), launcher: d.launcher, at: Date.now(), forwarded: null };
    store.state.alloc_cursor = cursor;
    store.save();
    for (const [sig, d] of Object.entries(store.state.allocations)) {
      if (d.forwarded) continue;
      const a = rt?.state.agents[d.agent];
      if (!a || a.status !== "bound") continue;
      const fwd = await funder.forwardAllocation(a.key_id, BigInt(d.amount), sig);
      d.forwarded = fwd;
      store.save();
      trader.noteFunding(d.agent, BigInt(d.amount));
      await trader.publish({ kind: "funding", ref: `alloc:${sig}`, agent: d.agent, at: Date.now(), source: "allocation", amount: d.amount, signature: fwd, treasury: a.key_id, basis: { deposit: sig, launcher: d.launcher } });
      o.log(`trader: ${d.agent.slice(0, 6)} launch allocation ${d.amount} forwarded (${fwd.slice(0, 10)}...)`);
    }
  };

  return {
    hooks,
    trader,
    attach(r) {
      rt = r;
    },
    start() {
      let stop = false;
      const every = Math.max(10, o.cfg.poll_s ?? 60) * 1000;
      void (async () => {
        const esc = await funder.ensureEscrow().catch((e) => (o.log(`trader: allocation escrow not ready: ${(e as Error).message}`), null));
        o.log(`trader: started (poll ${every / 1000} s); allocation escrow ${esc ?? "none"}`);
        while (!stop) {
          await allocations().catch((e) => o.log(`trader: allocations: ${(e as Error).message}`));
          const r = await trader.tick().catch((e) => (o.log(`trader: tick: ${(e as Error).message}`), null));
          if (r && (r.trades || r.refused.length)) o.log(`trader: tick: ${r.trades} trade(s); refused ${r.refused.filter((x) => !x.private).map((x) => x.rule).join(", ") || "none"}`);
          for (let t = 0; t < every && !stop; t += 1000) await Bun.sleep(1000);
        }
      })();
      return () => {
        stop = true;
      };
    },
  };
}
