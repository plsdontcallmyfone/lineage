import { get, getOptional, loadConfig } from "./api.ts";
import { DEFAULT_IO, type PanelIO } from "./live-panel/index.ts";

// Swarms on the pages (docs/plans/SWARMS.md 6): one coin whose work is done by several agents ("seats").
// Everything here reads Core's swarm routes, which exist only while Core's `swarms` flag is on
// (network.features.swarms in GET /v1/config). While it is off nothing is requested and every page is
// what it was.

export interface SeatView {
  seat: number;
  name: string;
  role: "lead" | "builder";
  model: { provider: string; id: string };
  runtime: {
    state: "working" | "waiting" | "paused" | "asleep";
    why: string | null;
    since: number | null;
    unit: string | null;
    target: string | null;
    model: { provider: string; id: string } | null;
    desktop: { state: "starting" | "running" | "paused" | "none"; why: string | null; since: number | null; stream: string | null; charged: boolean } | null;
    spend: { usd: number | null; sandbox_s: number | null; desktop_s: number | null; desktop_usd: number | null; attempts: number | null; epochs: number | null } | null;
    reported_at: number;
  } | null;
  heartbeat: { at: number; awake: boolean; job: string; phase: string | null; lineage_id: string | null } | null;
  session: { session_id: string; lineage_id: string; started_at: number } | null;
  last: { commit_id: string; candidate_id: string | null; status: string; reason: string | null; kind: string; target: string | string[]; lineage_id: string; finalized_at: number | null; gen_id: string | null; ratio: number | null } | null;
  totals: { final: number; accepted: number };
}

export interface SwarmRecordRow {
  commit_id: string;
  candidate_id: string | null;
  gen_id: string | null;
  lineage_id: string;
  kind: string;
  target: string | string[];
  finalized_at: number | null;
  ratio: number | null;
  seat: number;
  name: string | null;
  model: string | null;
}

export interface SwarmView {
  agent: string;
  size: number;
  lead: number;
  seats: SeatView[];
  record: SwarmRecordRow[];
}

/** Whether this network runs swarms (Core's config, read once per page load). */
export async function swarmsOn(): Promise<boolean> {
  try {
    return (await loadConfig()).features?.swarms === true;
  } catch {
    return false;
  }
}

/** A coin's seats, or null: a solo agent, swarms are off, or Core did not answer. */
export async function swarmOf(agent: string): Promise<SwarmView | null> {
  if (!(await swarmsOn())) return null;
  try {
    const v = await getOptional<SwarmView & { seats: SeatView[] | null }>(`agents/${agent}/swarm`);
    return v && Array.isArray(v.seats) && v.seats.length >= 2 ? ({ ...v, record: Array.isArray(v.record) ? v.record : [] } as SwarmView) : null;
  } catch {
    return null;
  }
}

export interface SwarmListRow {
  agent: string;
  size: number;
  lead: number;
  working: number | null;
  stream: string | null;
}

/** Every swarm by agent id (the Explorer's badge); empty while swarms are off. */
export async function swarmList(): Promise<Map<string, SwarmListRow>> {
  if (!(await swarmsOn())) return new Map();
  try {
    const r = await getOptional<{ swarms: SwarmListRow[] }>("swarms");
    return new Map((r.swarms ?? []).map((s) => [s.agent, s]));
  } catch {
    return new Map();
  }
}

/**
 * The live panel's data access for ONE seat of a swarm: the panel asks for an agent's sessions and for
 * its desktop, and this answers with that seat's own (its sessions by Core's `seat` field, its desktop
 * from the runtime's seat report). Everything else is the panel's default.
 */
export function seatPanelIO(agent: string, seat: number): Partial<PanelIO> {
  return {
    get: async <T = any>(path: string): Promise<T> => {
      if (path.startsWith(`agents/${agent}/spend`)) {
        const [spend, sw] = await Promise.all([get<any>(path), swarmOf(agent)]);
        const d = sw?.seats.find((s) => s.seat === seat)?.runtime?.desktop ?? null;
        return { ...spend, spend: spend?.spend ? { ...spend.spend, desktop: d ? { state: d.state, why: d.why, since: d.since, stream: d.stream } : null } : spend?.spend } as T;
      }
      if (path.startsWith("sessions?") && path.includes(`agent=${agent}`)) {
        const all = await get<any[]>(path);
        return all.filter((s) => (s.seat ?? 1) === seat) as T;
      }
      return DEFAULT_IO.get<T>(path);
    },
  };
}
