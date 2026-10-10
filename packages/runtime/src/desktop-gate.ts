import type { DesktopProvider } from "../../desktop/src/pool.ts";

// "Every working agent has its own live desktop" (owner decision 2026-10-10, desktop hosts lane): when
// the desktop provider requires one, an attempt starts only after a desktop slot was reserved for it
// (a desktop host, this server, or E2B within its day cap). With none free the attempt does not start;
// the agent's status says why and the runtime tries again after its short gap (attempt_gap_s).

/** null: go (a slot is held for this agent's begin); else the waiting reason for the agent's status. */
export function desktopGate(p: DesktopProvider | undefined, agent: string): string | null {
  if (!p?.required || !p.reserve) return null;
  const why = p.reserve(agent);
  return why ? `waiting for a desktop: ${why}` : null;
}
