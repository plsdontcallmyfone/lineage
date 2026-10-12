import { ata, decodeMint, launchPdas, TOKEN_2022_PROGRAM, type ChainReader } from "@units/chain";
import type { Core } from "./core.ts";
import { notFound } from "./errors.ts";

// Agent wallets as the pages show them (docs/plans/AGENT-WALLET-SAFETY.md section 2). An agent's
// wallet is its treasury: its current registry signing key (for a hosted agent, the key the hosted
// runtime holds; Core knows it from the registry, synced from chain). Its compute vault is a
// separate address, a program account of units_launch that no key signs for. This module serves
// both addresses and what they hold, read from chain on request: SOL, the quote token and every
// registered agent token the treasury holds. Nothing is estimated: a read that fails is reported as
// an error, never as a zero. Without a chain (sim mode) only the addresses Core knows are served.

interface Internals {
  db: Core["db"];
  identity: Core["identity"];
  now(): number;
}

export interface WalletHolding {
  mint: string;
  /** the agent whose token it is */
  agent: string;
  /** base units */
  amount: string;
  /** the mint's decimals, read from the mint account (null: the read failed; show base units) */
  decimals: number | null;
  /** its own token (the launcher's initial buy): held, never traded */
  own: boolean;
}

export interface WalletView {
  agent: string;
  /** false: no chain behind this Core (sim mode); addresses only */
  chain: boolean;
  network: string | null;
  read_at: number | null;
  slot: number | null;
  treasury: {
    /** the agent's current registry signing key; null when the owner revoked it */
    address: string | null;
    /** true while the treasury is still the agent's first key (not bound to a hosted runtime) */
    is_agent_id: boolean;
    sol_lamports: string | null;
    quote: { mint: string; symbol: string | null; decimals: number | null; amount: string | null } | null;
    holdings: WalletHolding[] | null;
  };
  compute_vault: { address: string; amount: string | null } | null;
  /** why balances are missing, when they are */
  error: string | null;
}

interface ChainSide {
  reader: ChainReader;
  network: string;
  quoteSymbol: string | null;
}

const CACHE_MS = 30_000;
const instances = new WeakMap<Core, AgentWallets>();
export function agentWalletOf(core: Core): AgentWallets {
  let w = instances.get(core);
  if (!w) instances.set(core, (w = new AgentWallets(core)));
  return w;
}

export class AgentWallets {
  private readonly c: Internals;
  private chain: ChainSide | null = null;
  private quote: { mint: string; tokenProgram: string; decimals: number } | null = null;
  private cache = new Map<string, { at: number; view: Promise<WalletView> }>();
  /** mint decimals never change: read once */
  private decimals = new Map<string, number>();
  constructor(core: Core) {
    this.c = core as unknown as Internals;
  }

  /** Chain mode: the reader Core already uses, the network's name and the quote token's display symbol. */
  configure(chain: ChainSide | null): void {
    this.chain = chain;
    this.quote = null;
    this.cache.clear();
  }

  private launched(): { agent_id: string; mint: string }[] {
    return this.c.db.query<{ agent_id: string; mint: string }, []>("SELECT agent_id, mint FROM agents WHERE kind = 'launched' AND mint IS NOT NULL").all();
  }

  private row(agent: string): { agent_id: string; kind: string; mint: string | null } {
    const r = this.c.db.query<{ agent_id: string; kind: string; mint: string | null }, [string]>("SELECT agent_id, kind, mint FROM agents WHERE agent_id = ?").get(agent);
    if (!r) throw notFound("agent");
    return r;
  }

  /** Addresses of every launched agent (no chain read): for the feed's wallet chips. */
  list(): { chain: boolean; network: string | null; wallets: Record<string, { treasury: string | null; compute_vault: string | null }> } {
    const wallets: Record<string, { treasury: string | null; compute_vault: string | null }> = {};
    for (const a of this.launched()) wallets[a.agent_id] = { treasury: this.c.identity.signingKey(a.agent_id), compute_vault: this.chain ? launchPdas.computeVault(a.agent_id) : null };
    return { chain: !!this.chain, network: this.chain?.network ?? null, wallets };
  }

  /** One agent's wallet, cached for 30 seconds (one chain read per agent per window, whoever asks). */
  view(agent: string): Promise<WalletView> {
    const row = this.row(agent); // 404 before any chain read
    const hit = this.cache.get(agent);
    if (hit && this.c.now() - hit.at < CACHE_MS) return hit.view;
    const view = this.read(row);
    this.cache.set(agent, { at: this.c.now(), view });
    if (this.cache.size > 2000) for (const [k, v] of this.cache) if (this.c.now() - v.at >= CACHE_MS) this.cache.delete(k);
    return view;
  }

  private async read(row: { agent_id: string; kind: string; mint: string | null }): Promise<WalletView> {
    const agent = row.agent_id;
    const treasury = this.c.identity.signingKey(agent);
    const base: WalletView = {
      agent, chain: !!this.chain, network: this.chain?.network ?? null, read_at: null, slot: null,
      treasury: { address: treasury, is_agent_id: treasury === agent, sol_lamports: null, quote: null, holdings: null },
      compute_vault: this.chain && row.kind === "launched" ? { address: launchPdas.computeVault(agent), amount: null } : null,
      error: null,
    };
    if (!this.chain) return base;
    if (!treasury) return { ...base, error: "the agent's signing key is revoked: it has no treasury until its owner binds a new key" };
    try {
      const { reader } = this.chain;
      if (!this.quote) {
        const lc = await reader.launchConfig();
        if (!lc) throw new Error("units_launch is not initialized on this cluster");
        const mint = await reader.mint(lc.lineMint);
        if (!mint) throw new Error("the quote mint is not on this cluster");
        this.quote = { mint: lc.lineMint, tokenProgram: lc.lineTokenProgram, decimals: mint.decimals };
      }
      const q = this.quote;
      const tokens = this.launched();
      const accounts = [ata(treasury, q.mint, q.tokenProgram), ...(base.compute_vault ? [base.compute_vault.address] : []), ...tokens.map((t) => ata(treasury, t.mint, TOKEN_2022_PROGRAM))];
      const [sol, slot, balances] = await Promise.all([reader.rpc.getBalance(treasury), reader.rpc.getSlot(), reader.tokenBalances(accounts)]);
      const skip = base.compute_vault ? 2 : 1;
      const holdings: WalletHolding[] = [];
      tokens.forEach((t, i) => {
        const amount = balances[skip + i] ?? null;
        if (amount !== null && amount > 0n) holdings.push({ mint: t.mint, agent: t.agent_id, amount: amount.toString(), decimals: null, own: t.agent_id === agent });
      });
      const unknown = holdings.map((h) => h.mint).filter((m) => !this.decimals.has(m));
      if (unknown.length) (await reader.rpc.getMultipleAccounts(unknown)).forEach((a, i) => a && this.decimals.set(unknown[i]!, decodeMint(a.data).decimals));
      for (const h of holdings) h.decimals = this.decimals.get(h.mint) ?? null;
      holdings.sort((a, b) => Number(b.own) - Number(a.own) || (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
      return {
        ...base, read_at: this.c.now(), slot,
        treasury: { ...base.treasury, sol_lamports: sol.toString(), quote: { mint: q.mint, symbol: this.chain.quoteSymbol, decimals: q.decimals, amount: (balances[0] ?? 0n).toString() }, holdings },
        // an account that does not exist holds nothing; that is a fact read from chain, not a guess
        compute_vault: base.compute_vault ? { address: base.compute_vault.address, amount: (balances[1] ?? 0n).toString() } : null,
      };
    } catch (e) {
      // a failed read is not cached for the whole window
      this.cache.delete(agent);
      return { ...base, error: `chain read failed: ${(e as Error).message.slice(0, 160)}` };
    }
  }
}
