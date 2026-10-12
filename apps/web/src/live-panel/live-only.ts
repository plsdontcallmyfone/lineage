// Live only (owner direction 2026-10-10: "no recordings for now, we want the live stuff always").
// The UI half of the runtime's `recordings` flag (packages/desktop DesktopConfig.recordings,
// scripts/deploy/site-config.ts): while RECORDINGS_SHOWN is false every surface that shows an
// agent's machine (token page, session page, agent profile, Explorer card hover, deck columns, the
// embed kit's <units-screen>, reel and thumbnails) shows only work in progress. With no live session
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
  /** the agent's own desktop as the runtime reports it (one E2B desktop per agent); absent when desktops are per attempt */
  desktop?: { state: "starting" | "running" | "paused" | "none"; why: string | null; since: number | null; stream?: string | null } | null;
  /** whether the runtime masks the live video (editor text and run terminal pixelated); null or absent when it did not say */
  masked?: boolean | null;
  /** why the agent's attempts do not start for want of a desktop, in the runtime's words (a funded, bound agent); absent otherwise */
  waiting_desktop?: string;
  /** the runtime's sentence while the agent's repository has no unit yet (unit setup, packages/runtime/src/unit-setup.ts); absent otherwise */
  setup?: string;
}

/** The runtime's unit setup sentence (spend.waiting "setting up: ...", "no unit possible for ...", "unit setup for ... stopped ..."), else null. */
export function setupOf(spend: any): string | null {
  const w = typeof spend?.spend?.waiting === "string" ? (spend.spend.waiting as string).trim() : "";
  return /^(setting up|no unit possible|unit setup)\b/i.test(w) ? w.slice(0, 300) : null;
}

/** The runtime's reason when an agent waits for a desktop (spend.waiting "waiting for a desktop: <why>", packages/runtime desktop-gate.ts), else null. */
export function desktopWaitOf(spend: any): string | null {
  const w = typeof spend?.spend?.waiting === "string" ? spend.spend.waiting : "";
  const m = /^waiting for a desktop:?\s*(.*)$/i.exec(w.trim());
  return m ? m[1]!.trim().slice(0, 200) || "none is free" : null;
}

/** The agent's own desktop from GET /v1/agents/:id/spend, or null (per-attempt desktops, or not reported). */
export function desktopOf(spend: any): IdleStatus["desktop"] {
  const d = spend?.spend?.desktop;
  if (!d || typeof d !== "object" || !["starting", "running", "paused", "none"].includes(d.state)) return null;
  // the id the agent's own stream is served under while its desktop runs: the screen stays live between sessions
  const stream = d.state === "running" && typeof d.stream === "string" && /^[0-9a-f]{64}$/.test(d.stream) ? d.stream : null;
  return { state: d.state, why: typeof d.why === "string" && d.why ? d.why : null, since: typeof d.since === "number" ? d.since : null, ...(stream ? { stream } : {}) };
}

/** What the screen says instead of a picture while the agent's own desktop is not running: text only. */
function desktopLine(st: IdleStatus): string | null {
  const d = st.desktop;
  if (!d) return null;
  if (d.state === "paused") return `Desktop paused: ${d.why ?? "agent idle"}`;
  if (d.state === "starting") return "Desktop starting";
  if (d.state === "none") return `No desktop: ${d.why ?? "not created yet"}`;
  return null;
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
  const spend = await c.p;
  const kind = pauseOf(spend) ?? "next";
  const desktop = desktopOf(spend);
  const wait = kind === "next" ? desktopWaitOf(spend) : null;
  const masked = typeof spend?.desktop_masked === "boolean" ? { masked: spend.desktop_masked as boolean } : {};
  const setup = kind === "next" ? setupOf(spend) : null;
  return { kind, last_end: lastEnd, ...(desktop ? { desktop } : {}), ...(wait ? { waiting_desktop: wait } : {}), ...(setup ? { setup } : {}), ...masked };
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
  if (st.kind === "next" && st.setup) return /^no unit possible/i.test(st.setup) ? "No unit possible for this repository" : /^unit setup/i.test(st.setup) ? "Unit setup stopped" : "Setting up its unit";
  if (st.kind === "next" && st.waiting_desktop) return `Waiting for a desktop: ${st.waiting_desktop}`;
  return st.kind === "vault" ? "Paused: vault empty" : st.kind === "provider" ? "Paused: provider balance low" : "Starting next session";
}

/** The line under it: when the last session ended (or that there was none). */
export function idleSub(st: IdleStatus, now = Date.now()): string {
  // a paused desktop is said in words; it comes back by itself
  const desk = st.desktop?.state === "paused" ? " Its desktop is paused and resumes with its next session." : "";
  // no unit for its repository yet: the runtime's own sentence says why
  if (st.kind === "next" && st.setup) return `${st.setup.charAt(0).toUpperCase()}${st.setup.slice(1)}${/[.!?]$/.test(st.setup) ? "" : "."}`;
  if (st.last_end === null) return `No session has run yet.${desk}`;
  const at = new Date(st.last_end);
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = now - st.last_end > 20 * 3600_000 ? `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ` : "";
  return `Last session ended ${day}${clock} (${agoText(st.last_end, now)}).${desk}`;
}

/** how soon after a session ends the idle state still says the next one is starting */
export const NEXT_WINDOW_MS = 5 * 60_000;

/** The idle headline on the agent's screen: right after a session the next one is starting; later, since when the agent is idle. */
export function idleHeadline(st: IdleStatus, now = Date.now()): string {
  if (st.kind !== "next" || st.waiting_desktop || st.setup) return idleTitle(st);
  const desk = desktopLine(st);
  if (desk) return desk;
  if (st.last_end === null) return "Agent idle: no session has run yet";
  // an agent with its own desktop keeps it between sessions: it did not end
  if (now - st.last_end < NEXT_WINDOW_MS) return st.desktop ? "Next session starting" : "Desktop ended: next session starting";
  const at = new Date(st.last_end);
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = now - st.last_end > 20 * 3600_000 ? `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ` : "";
  return `Agent idle since ${day}${clock}`;
}

/** One line for a small screen (cards, thumbnails). */
export function idleCaption(st: IdleStatus, now = Date.now()): string {
  if (st.kind !== "next" || st.waiting_desktop || st.setup) return idleTitle(st);
  const desk = desktopLine(st);
  if (desk) return desk;
  if (st.last_end === null) return "Agent idle: no session has run yet";
  return now - st.last_end < NEXT_WINDOW_MS ? (st.desktop ? "Next session starting" : "Desktop ended: next session starting") : `Agent idle, last session ended ${agoText(st.last_end, now)}`;
}
