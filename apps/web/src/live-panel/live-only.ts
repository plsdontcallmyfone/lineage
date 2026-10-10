// Live only (owner direction 2026-10-10: "no recordings for now, we want the live stuff always").
// The UI half of the runtime's `recordings` flag (packages/desktop DesktopConfig.recordings,
// scripts/deploy/site-config.ts): while RECORDINGS_SHOWN is false every surface that shows an
// agent's machine (token page, session page, agent profile, Explorer card hover, deck columns, the
// embed kit's <lineage-screen>, reel and thumbnails) shows only work in progress. With no live session
// it shows an idle state instead of a past session: "Desktop ended: next session starting" right after
// a session, "Agent idle since <time>" later, with the time the last one
// ended, or the pause the runtime reports (GET /v1/agents/:id/spend: provider_balance_low, and
// spend.waiting for an empty compute vault). Since the honest screen lane the UI has no replay or
// recording player at all (the screen shows the real desktop stream or text); the flag stays false for
// the surfaces that read it, and Core keeps any recording it already stores.

/** Show past sessions (step-through replay) and desktop recordings. false: live work only. */
export const RECORDINGS_SHOWN = false;

export type IdleKind = "next" | "vault" | "provider";

export interface IdleStatus {
  kind: IdleKind;
  /** when the agent's last session ended (ms), or null when Core lists none */
  last_end: number | null;
}

/** The pause the runtime reports for an agent, from GET /v1/agents/:id/spend (null when none or unknown). */
export function pauseOf(spend: any): Exclude<IdleKind, "next"> | null {
  if (!spend || typeof spend !== "object") return null;
  if (spend.provider_balance_low === true) return "provider";
  const w = typeof spend.spend?.waiting === "string" ? spend.spend.waiting : "";
  if (/^provider balance low/i.test(w)) return "provider";
  if (/^(compute vault exhausted|asleep)/i.test(w)) return "vault";
  return null;
}

const spendCache = new Map<string, { at: number; p: Promise<any> }>();

/** The agent's idle status: the runtime's pause if it reports one, else waiting for the next session. */
export async function idleStatus(get: (path: string) => Promise<any>, agent: string | null | undefined, lastEnd: number | null): Promise<IdleStatus> {
  if (!agent) return { kind: "next", last_end: lastEnd };
  let c = spendCache.get(agent);
  if (!c || Date.now() - c.at > 30_000) {
    c = { at: Date.now(), p: get(`agents/${agent}/spend`).catch(() => null) };
    spendCache.set(agent, c);
  }
  const kind = pauseOf(await c.p) ?? "next";
  return { kind, last_end: lastEnd };
}

/** When a session ended: its end, else its last event (a session that never closed). */
export function endOf(s: { ended_at?: number | null; last_at?: number | null; at?: number | null } | null | undefined): number | null {
  if (!s) return null;
  const t = s.ended_at ?? s.last_at ?? s.at ?? null;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
}

/** The latest end over a list of sessions that are not live. */
export function lastEndOf(list: { state: string; ended_at?: number | null; last_at?: number | null }[]): number | null {
  let best: number | null = null;
  for (const s of list) {
    if (s.state === "live") continue;
    const t = endOf(s);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

function agoText(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The headline of the idle state. */
export function idleTitle(st: IdleStatus): string {
  return st.kind === "vault" ? "Paused: vault empty" : st.kind === "provider" ? "Paused: provider balance low" : "Starting next session";
}

/** The line under it: when the last session ended (or that there was none). */
export function idleSub(st: IdleStatus, now = Date.now()): string {
  if (st.last_end === null) return "No session has run yet.";
  const at = new Date(st.last_end);
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = now - st.last_end > 20 * 3600_000 ? `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ` : "";
  return `Last session ended ${day}${clock} (${agoText(st.last_end, now)}).`;
}

/** how soon after a session ends the idle state still says the next one is starting */
export const NEXT_WINDOW_MS = 5 * 60_000;

/** The idle headline on the agent's screen: right after a session the next one is starting; later, since when the agent is idle. */
export function idleHeadline(st: IdleStatus, now = Date.now()): string {
  if (st.kind !== "next") return idleTitle(st);
  if (st.last_end === null) return "Agent idle: no session has run yet";
  if (now - st.last_end < NEXT_WINDOW_MS) return "Desktop ended: next session starting";
  const at = new Date(st.last_end);
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = now - st.last_end > 20 * 3600_000 ? `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ` : "";
  return `Agent idle since ${day}${clock}`;
}

/** One line for a small screen (cards, thumbnails). */
export function idleCaption(st: IdleStatus, now = Date.now()): string {
  if (st.kind !== "next") return idleTitle(st);
  if (st.last_end === null) return "Agent idle: no session has run yet";
  return now - st.last_end < NEXT_WINDOW_MS ? "Desktop ended: next session starting" : `Agent idle, last session ended ${agoText(st.last_end, now)}`;
}
