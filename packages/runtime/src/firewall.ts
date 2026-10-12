import { AgentFirewall, guardKey, type Rpc } from "@units/chain";

// The hosted runtime's transaction firewall (docs/plans/AGENT-WALLET-SAFETY.md section 3). One per
// process, installed before any agent key is used on chain: every key the runtime's store hands out
// is guarded (state.ts keyFor), and a guarded key signs a transaction only when this firewall allows
// exactly those bytes. Identity (which agent a key signs for) comes from the runtime's persisted
// state. Agents do not trade (owner decision 2026-10-12): no swap is signed for an agent key, so
// there is no trading config to read here. What is signed moves nothing: the agent's own posts,
// its bind and its profile.

export interface FirewallAgents {
  /** the runtime's persisted agents: agent id -> its runtime key id */
  agents(): Record<string, { key_id: string }>;
}

/** Builds the runtime's firewall, guards every key the state already names and installs it for the process. */
export function installAgentFirewall(o: { rpc: Rpc; stateDir: string; view: FirewallAgents; log: (m: string) => void }): AgentFirewall {
  const fw = new AgentFirewall({
    rpc: o.rpc,
    dir: o.stateDir,
    log: o.log,
    identity: (key) => {
      for (const [agent, s] of Object.entries(o.view.agents())) if (s.key_id === key) return { agent };
      return null;
    },
  }).install();
  for (const s of Object.values(o.view.agents())) guardKey(s.key_id);
  o.log(`firewall: installed; ${Object.keys(o.view.agents()).length} agent key(s) guarded; every swap is refused (agents do not trade); decisions in ${o.stateDir}/firewall.jsonl`);
  return fw;
}
