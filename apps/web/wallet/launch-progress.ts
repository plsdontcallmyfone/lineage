// The launched screen's progress list (owner 2026-10-13, "clear comms"): right after a launch the
// launcher sees five steps that tick by themselves (launched, setup finished, measurement ready, first
// session, first result), each with what it means, and under them the one status line every page
// shows (src/agent-status.ts) with the one thing to do, when there is one. A time is said only where
// it is measured: Core's usual setup time from recorded setups (GET /v1/repo-check), nothing else.
// Reads only: the chain (is it bound), Core (lifecycle, results, the runtime's report) and the market
// indexer (a session). It asks again every 15 s until every step is done or the screen is gone.
import { actionLink, agentStatus, factsOf, statusHtml, type AgentStatus, type SpendAnswer } from "../src/agent-status.ts";
import { html, type Raw } from "../src/html.ts";

export interface Progress {
  hosted: boolean;
  /** the hosted runtime holds its signing key; null when the chain was not read */
  bound: boolean | null;
  /** Core's lifecycle: undefined until Core has read the launch */
  lifecycle?: "setting_up" | "active" | null;
  /** it has had a working session */
  session: boolean;
  /** verifiers have judged a change of its */
  result: boolean;
  /** minutes a setup usually takes, from recorded setups; null when there are too few */
  setup_minutes: number | null;
}

export interface Step {
  key: "launched" | "bound" | "ready" | "session" | "result";
  title: string;
  text: string;
  state: "done" | "now" | "todo";
}

/** The steps in order; the first one not done is `now`. A self-hosted agent has no setup step. */
export function progressSteps(p: Progress): Step[] {
  const ready = p.lifecycle === "active";
  const usual = p.setup_minutes ? ` Usually within ${p.setup_minutes} ${p.setup_minutes === 1 ? "minute" : "minutes"}.` : "";
  const rows: [Step["key"], string, boolean, string, string][] = [
    ["launched", "Launched", true, "Your coin and its agent exist on Solana.", ""],
    ...(p.hosted ? ([["bound", "Setup finished", p.bound === true, "The hosted runtime can work for it.", "One approval from your wallet lets the hosted runtime work for it."]] as typeof rows) : []),
    ["ready", "Measurement ready", ready, "The network can measure its work on the repository.", `The agent sets up how its work on the repository is measured, and verifiers check it.${usual}`],
    ["session", "First session", p.session, "It has started working on the repository.", "Its first working session starts by itself."],
    ["result", "First result", p.result, "Verifiers have judged its first change.", "Verifiers replay its first change and judge it."],
  ];
  let open = false;
  return rows.map(([key, title, done, was, will]) => {
    const state: Step["state"] = done ? "done" : open ? "todo" : "now";
    if (!done) open = true;
    return { key, title, text: done ? was : will, state };
  });
}

export function progressHtml(steps: Step[], status: AgentStatus, action: Raw | string = ""): Raw {
  return html`<div class="lp" id="w-progress-list"><ol class="lp-steps">${steps.map((s) => html`<li class="lp-step" data-step-key="${s.key}" data-state="${s.state}"><span class="lp-dot" aria-hidden="true"></span><div><b>${s.title}</b><span class="lp-t">${s.text}</span></div></li>`)}</ol>
    <div class="lp-now">${statusHtml(status, action)}</div></div>`;
}

const getJson = (url: string, f: typeof fetch) => f(url, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

/** One read of everything the list shows. `chainBound` is the caller's read of the registry record. */
export async function readProgress(o: { agent: string; mint: string; hosted: boolean; repo: string | null; chainBound: () => Promise<boolean | null>; setupMinutes?: number | null }, f: typeof fetch = fetch): Promise<{ progress: Progress; status: AgentStatus }> {
  const [bound, prof, spend, tok] = await Promise.all([
    o.hosted ? o.chainBound().catch(() => null) : Promise.resolve(null),
    getJson(`/api/agents/${o.agent}/profile?optional=1`, f),
    o.hosted ? (getJson(`/api/agents/${o.agent}/spend`, f) as Promise<SpendAnswer | null>) : Promise.resolve(null),
    getJson(`/market/tokens/${o.mint}`, f),
  ]);
  const p = prof && !prof._miss ? prof : null;
  const lifecycle = p ? (p.lifecycle === "setting_up" || p.lifecycle === "active" ? p.lifecycle : null) : null;
  let minutes = o.setupMinutes ?? null;
  // the usual setup time is asked for once, and only while the agent is setting up
  if (minutes === null && o.setupMinutes === undefined && lifecycle === "setting_up" && o.repo) {
    const c = await getJson(`/api/repo-check?repo=${encodeURIComponent(o.repo)}`, f);
    minutes = typeof c?.setup_minutes === "number" && c.setup_minutes > 0 ? c.setup_minutes : null;
  }
  const b = tok?.building ?? null;
  const progress: Progress = { hosted: o.hosted, bound, lifecycle: p ? lifecycle : undefined, session: !!(b?.live || b?.session_id || tok?.session), result: !!(b?.last || (p?.stats?.final ?? 0) >= 1), setup_minutes: minutes };
  const status = agentStatus(factsOf({ now: Date.now(), hosted: o.hosted, lifecycle: p ? lifecycle : null, awake: p?.awake ?? tok?.awake ?? null, covered: !!p?.compute_covered, live: !!b?.live, bound, spend }));
  return { progress, status };
}

/**
 * Paints the list into `el` and keeps it current. `bindButton` is the launched screen's own "Finish
 * setup" button (it runs the bind there); funding opens the coin's page.
 */
export function mountLaunchProgress(el: HTMLElement, o: { agent: string; mint: string; hosted: boolean; repo: string | null; chainBound: () => Promise<boolean | null>; bindButton: Raw; everyMs?: number }, f: typeof fetch = fetch): () => void {
  let stopped = false;
  let minutes: number | null | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped || !el.isConnected) return;
    const r = await readProgress({ ...o, setupMinutes: minutes }, f).catch(() => null);
    if (stopped || !el.isConnected) return;
    if (r) {
      if (r.progress.lifecycle === "setting_up" || r.progress.setup_minutes !== null) minutes = r.progress.setup_minutes;
      const steps = progressSteps(r.progress);
      el.innerHTML = progressHtml(steps, r.status, r.status.action?.kind === "bind" ? o.bindButton : actionLink(r.status, { mint: o.mint })).s;
      if (steps.every((s) => s.state === "done")) return;
    }
    timer = setTimeout(() => void tick(), o.everyMs ?? 15_000);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
