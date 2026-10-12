import { AgentFirewall, guardKey, type FirewallLimits, type Rpc } from "@units/chain";

// The hosted runtime's transaction firewall (docs/plans/AGENT-WALLET-SAFETY.md section 3). One per
// process, installed before any agent key is used on chain: every key the runtime's store hands out
// is guarded (state.ts keyFor), and a guarded key signs a transaction only when this firewall allows
// exactly those bytes. Identity (which agent a key signs for, and its own token) comes from the
// runtime's persisted state; the limits come from Core's admin-editable trading config. When Core
// cannot be read the limits are null and no swap is signed (messages and the bind still are: they
// move nothing).

/** The trading config fields the firewall reads, as Core serves them. */
export function limitsOf(cfg: unknown): FirewallLimits | null {
  if (typeof cfg !== "object" || cfg === null) return null;
  const c = cfg as Record<string, unknown>;
  const uint = (v: unknown) => (typeof v === "string" && /^\d{1,30}$/.test(v) ? BigInt(v) : null);
  const int = (v: unknown, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= hi ? v : null);
  const tx = uint(c.firewall_max_tx_line), day = uint(c.firewall_max_day_line), bps = int(c.firewall_min_out_bps, 10_000), fee = int(c.firewall_max_fee_lamports, 1_000_000_000);
  if (typeof c.enabled !== "boolean" || tx === null || day === null || bps === null || fee === null) return null;
  return { trading_enabled: c.enabled, max_tx_quote: tx, max_day_quote: day, min_out_bps: bps, max_fee_lamports: BigInt(fee) };
}

/** Reads the limits from Core, cached for `ttl_ms`; a failed read is null (and is not cached). */
export function coreLimits(core: string, o: { fetch?: typeof fetch; ttl_ms?: number; now?: () => number } = {}): () => Promise<FirewallLimits | null> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  let cached: { at: number; v: FirewallLimits } | null = null;
  return async () => {
    if (cached && now() - cached.at < (o.ttl_ms ?? 15_000)) return cached.v;
    const r = await f(`${core.replace(/\/+$/, "")}/v1/trading/config`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const v = limitsOf(await r.json());
    if (v) cached = { at: now(), v };
    return v;
  };
}

export interface FirewallAgents {
  /** the runtime's persisted agents: agent id -> its runtime key id and its own token */
  agents(): Record<string, { key_id: string; mint: string | null }>;
}

/** Builds the runtime's firewall, guards every key the state already names and installs it for the process. */
export function installAgentFirewall(o: { rpc: Rpc; core: string; stateDir: string; view: FirewallAgents; log: (m: string) => void; limits?: () => Promise<FirewallLimits | null>; /** this runtime's own trading switch (runtime.json); false or absent: no swap is signed whatever Core's config says */ tradingOn?: boolean }): AgentFirewall {
  const read = o.limits ?? coreLimits(o.core);
  const fw = new AgentFirewall({
    rpc: o.rpc,
    dir: o.stateDir,
    log: o.log,
    limits: async () => {
      const l = await read();
      return l && { ...l, trading_enabled: l.trading_enabled && o.tradingOn === true };
    },
    identity: (key) => {
      for (const [agent, s] of Object.entries(o.view.agents())) if (s.key_id === key) return { agent, ownMint: s.mint };
      return null;
    },
  }).install();
  for (const s of Object.values(o.view.agents())) guardKey(s.key_id);
  o.log(`firewall: installed; ${Object.keys(o.view.agents()).length} agent key(s) guarded; swaps ${o.tradingOn === true ? "follow Core's trading config" : "refused (trading is off in this runtime's config)"}; decisions in ${o.stateDir}/firewall.jsonl`);
  return fw;
}
