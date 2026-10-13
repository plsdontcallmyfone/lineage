import { loadLineageNames } from "../api.ts";
import { lineageName } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { mount as mountLivePanel, type LivePanelHandle } from "../live-panel/index.ts";
import { providerLogo } from "../provider-logo.ts";
import { seatPanelIO, swarmOf, type SeatView, type SwarmView } from "../swarm.ts";
import { providerName } from "./social-ui.ts";

// The coin page of a swarm (docs/plans/SWARMS.md 6; owner 2026-10-13: "two toggles for computer 1 and
// computer 2"). The centre panel's control reads Chart, Computer 1, Computer 2, ... (one button per
// agent of the swarm). A computer's view is that agent's live screen (the existing live panel, given
// a seat; only the shown one plays video), its own line under it (name, role, model, what it is on,
// its last final result), a row per agent in the page's own row style with the shown one marked, and
// the record of accepted changes naming the agent and model of each. The choice is kept per coin for
// the browser session and falls back to Chart. A solo coin never loads any of this.
//
// What is shown per seat while it works is what its session and its intent already say (the unit and
// the target). A seat's result is its newest FINAL candidate: Core names no seat on an open one.

const STYLE = `
.sw-wrap{display:flex;flex-direction:column;min-width:0}
.sw-stage{padding:12px 12px 0}
.sw-now{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 16px 0;font:500 13px/1.4 var(--sans);letter-spacing:-.01em;color:var(--ts)}
.sw-now b{color:var(--tp);font-weight:500}
.sw-now{padding-bottom:12px}
.sw-now .sw-st{color:var(--tt)}
.sw-now .sw-nres{flex-basis:100%;color:var(--tt);font-size:12.5px}
.sw-now .sw-nres.ok{color:var(--good)}
.sw-st.working{color:var(--good)}
.sw-rest{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:100%;aspect-ratio:16/9;max-height:520px;padding:24px;text-align:center;font-family:var(--sans)}
.sw-rest b{font-weight:600;font-size:18px;letter-spacing:-.01em;color:var(--tp)}
.sw-rest p{margin:0;max-width:520px;font-size:14px;line-height:1.45;color:var(--ts)}
.seg.sw-view{flex-wrap:nowrap;max-width:100%;overflow-x:auto;scrollbar-width:none}
.seg.sw-view::-webkit-scrollbar{display:none}
.seg.sw-view button{flex:none;white-space:nowrap}
.sw-profile-seg{margin-right:10px}
.sw-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px 6px;border-top:1px solid var(--border);font:500 12px/1.4 var(--sans);letter-spacing:-.01em;color:var(--tt)}
.sw-seats>li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;align-items:center;cursor:pointer}
.sw-profile{margin-top:16px}
.sw-profile .sw-seats>li{cursor:default}
.sw-seats>li[aria-current="true"]{background:var(--bg3)}
.sw-seats .tk-row-main{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.sw-model{display:inline-flex;align-items:center;gap:5px;color:var(--ts);font-size:12.5px}
.sw-record .tk-row-sub{white-space:normal}
.sw-record{max-height:420px;overflow-y:auto}
.sw-seats .tk-row-sub{white-space:normal}
.sw-seats .sw-res{grid-column:2;grid-row:1 / span 2;text-align:right;font:500 12px/1.4 var(--sans);color:var(--tt);font-variant-numeric:tabular-nums;white-space:nowrap}
.sw-res.ok{color:var(--good)}
.sw-record>li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px}
.sw-record .sw-when{grid-column:2;grid-row:1 / span 2;align-self:center;color:var(--tt);font-size:12px;white-space:nowrap}
.sw-units{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:6px}
.sw-units li{font-size:13.5px;color:var(--tp);min-width:0}
.sw-units li span{color:var(--tt)}
@media (max-width:640px){
  .seg.sw-view .sw-vl{display:none}
  .sw-seats>li,.sw-record>li{grid-template-columns:minmax(0,1fr)}
  .sw-seats .sw-res,.sw-record .sw-when{grid-column:1;grid-row:auto;text-align:left}
}`;

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById("sw-style")) return;
  const s = document.createElement("style");
  s.id = "sw-style";
  s.textContent = STYLE;
  document.head.appendChild(s);
}

const targetText = (t: string | string[]) => (Array.isArray(t) ? t.join(", ") : t);
const ROLE: Record<SeatView["role"], string> = { lead: "Lead", builder: "Builder" };

/** A seat's state in a few words: what the runtime reports, in the words the page shows. */
/** The runtime's statement about a seat, or null when it is older than three minutes (the runtime reports about once a minute). */
const fresh = (s: SeatView) => (s.runtime && Date.now() - s.runtime.reported_at <= 180_000 ? s.runtime : null);

export function seatState(s: SeatView): { text: string; cls: string } {
  const r = fresh(s);
  if (s.runtime && !r) return { text: s.session ? "Working" : "Not reporting", cls: s.session ? "working" : "" };
  if (!r) return { text: s.session ? "Working" : "Not started", cls: s.session ? "working" : "" };
  if (r.state === "working") return { text: "Working", cls: "working" };
  if (r.state === "asleep") return { text: "Asleep", cls: "" };
  if (r.state === "paused") return { text: "Paused: vault low", cls: "" };
  return { text: r.why && /^Waiting for verdicts/.test(r.why) ? "Waiting for verdicts" : "Between attempts", cls: "" };
}

/** What a seat is on now: its target and unit while an attempt runs, else its state with the runtime's reason. */
function seatNow(s: SeatView): Raw {
  const r = fresh(s);
  if (s.runtime && !r && !s.session) return html`Its computer has not reported in the last minutes`;
  if (r?.state === "working" && r.target) return html`Working on <b>${r.target}</b>${r.unit ? html` in ${lineageName(r.unit)}` : ""}`;
  if (s.session && (!r || r.state === "working")) return html`Working in ${lineageName(s.session.lineage_id)}`;
  if (!r) return html`No report from its computer yet`;
  if (r.state === "asleep") return html`Asleep: the vault is below the wake threshold`;
  if (r.state === "paused") return html`Paused: vault low`;
  return html`${r.why && !/vault/i.test(r.why) ? r.why : "Between attempts"}`;
}

/** A seat's newest final candidate, or that it has none. */
function seatResult(s: SeatView): { text: string; cls: string } {
  const l = s.last;
  if (!l) return { text: "No final result yet", cls: "" };
  if (l.status === "accepted") return { text: `Accepted: ${targetText(l.target)}${l.ratio !== null ? ` at ${l.ratio.toFixed(4)} of before` : ""}`, cls: "ok" };
  return { text: `${l.status === "expired" ? "Expired" : "Rejected"}: ${targetText(l.target)}${l.reason ? ` (${l.reason.replace(/_/g, " ")})` : ""}`, cls: "" };
}

const modelChip = (m: { provider: string; id: string }): Raw => html`<span class="sw-model">${providerLogo(m.provider, providerName(m.provider) ?? "", 13)}${m.id}</span>`;

function seatRows(sw: SwarmView, shown: number): Raw {
  return html`${sw.seats.map((s) => {
    const res = seatResult(s);
    return html`<li data-seat="${s.seat}" aria-current="${String(s.seat === shown)}" >
      <div class="tk-row-main"><span>${s.name}</span><span class="b outline">${ROLE[s.role]}</span>${modelChip(s.model)}</div>
      <div class="tk-row-sub">${seatNow(s)}</div>
      <div class="sw-res ${res.cls}">${res.text}<br><span class="faint">${s.totals.accepted} accepted of ${s.totals.final} final</span></div></li>`;
  })}`;
}

function recordRows(sw: SwarmView): Raw {
  if (!sw.record.length) return html`<li><div class="tk-row-sub">No accepted change yet. A change is listed here, with the agent and model that wrote it, once independent replays accept it.</div></li>`;
  return html`${sw.record.map(
    (r) => html`<li>
      <div class="tk-row-main">${r.gen_id ? html`<a class="link" href="/generations/${r.gen_id}">${r.kind} ${targetText(r.target)}</a>` : html`${r.kind} ${targetText(r.target)}`} in ${lineageName(r.lineage_id)}${r.ratio !== null ? html` <span class="num faint">${r.ratio.toFixed(4)} of before</span>` : ""}</div>
      <div class="tk-row-sub">by ${r.name ?? `agent ${r.seat}`}${r.model ? html` (${r.model})` : ""} of this swarm</div>
      ${r.finalized_at ? html`<time class="sw-when" data-ago="${r.finalized_at}"></time>` : ""}</li>`,
  )}`;
}

/**
 * One button per agent of the swarm for a segmented control: "Computer 1", "Computer 2", ... On a
 * narrow screen the word is left out and the number stays; the full label and the agent's name are
 * the button's accessible name either way.
 */
export function seatButtons(sw: SwarmView, pressed: number | null): Raw {
  injectStyle();
  return html`${sw.seats.map((s) => html`<button type="button" data-view-b="computer" data-seat="${s.seat}" aria-pressed="${String(s.seat === pressed)}" aria-label="Computer ${s.seat}: ${s.name}" title="${s.name}"><span class="sw-vl">Computer </span>${s.seat}</button>`)}`;
}

const VIEW_KEY = (coin: string) => `units-coin-view:${coin}`;
/** The view a coin page was last left on in this browser session: "chart", or a seat number. Chart when nothing is kept or storage is not there. */
export function keptView(coin: string, sw: SwarmView): "chart" | number {
  try {
    const v = sessionStorage.getItem(VIEW_KEY(coin));
    const n = v && /^computer:\d{1,2}$/.test(v) ? Number(v.slice(9)) : 0;
    return n && sw.seats.some((s) => s.seat === n) ? n : "chart";
  } catch {
    return "chart";
  }
}
export function keepView(coin: string, v: "chart" | number): void {
  try {
    sessionStorage.setItem(VIEW_KEY(coin), v === "chart" ? "chart" : `computer:${v}`);
  } catch {
    /* a private window: the choice lasts for this page only */
  }
}

/** The markup of a computer's pane (the screen is mounted by mountSwarmPane). */
export function swarmPane(sw: SwarmView): Raw {
  injectStyle();
  return html`<div class="sw-wrap" id="mk-swarm">
    <div class="sw-stage"><div id="sw-live" class="mk-live" style="padding:0"></div></div>
    <div class="sw-now" id="sw-now"></div>
    <div class="sw-h"><span>${sw.size} agents, one coin, one vault</span><span>Last final result</span></div>
    <ul class="tk-rows sw-seats" id="sw-seats">${seatRows(sw, sw.lead)}</ul>
    <div class="sw-h"><span>Accepted changes</span><span class="num">${sw.record.length}</span></div>
    <ul class="tk-rows sw-record" id="sw-record">${recordRows(sw)}</ul>
  </div>`;
}

/** "What the swarm is building": one line per unit in work, with the agents on it. */
export function swarmBuilding(sw: SwarmView): Raw {
  const by = new Map<string, SeatView[]>();
  for (const s of sw.seats) {
    const r = fresh(s);
    const unit = r?.state === "working" ? (r.unit ?? s.session?.lineage_id) : s.session?.lineage_id;
    if (unit) (by.get(unit) ?? by.set(unit, []).get(unit)!).push(s);
  }
  if (!by.size) return html`<ul class="sw-units" id="sw-units"><li><span>No unit in work right now.</span></li></ul>`;
  return html`<ul class="sw-units" id="sw-units">${[...by].map(([unit, seats]) => html`<li><a class="link" href="/units/${unit}">${lineageName(unit)}</a> <span>${seats.map((s) => `${s.name}${fresh(s)?.target ? ` on ${fresh(s)!.target}` : ""}`).join(", ")}</span></li>`)}</ul>`;
}

/** The agent profile's seat list: one profile for the swarm, its agents under it (empty for a solo agent or while swarms are off). */
export async function swarmSeatsPanel(agent: string): Promise<Raw> {
  const sw = await swarmOf(agent);
  if (!sw) return html``;
  injectStyle();
  return html`<section class="panel sw-profile"><div class="panel-h"><h2>Agents of this swarm <span class="count num">${sw.size}</span></h2><div class="aside"><span class="faint">one coin, one vault, one record</span></div></div>
    <ul class="tk-rows sw-seats" style="cursor:default">${seatRows(sw, 0)}</ul></section>`;
}

export interface SwarmPaneHandle {
  /** a computer's view is shown: mounts that agent's screen (the only one that plays) */
  show(seat: number): void;
  /** the chart is shown: no screen plays */
  hide(): void;
  destroy(): void;
}

/** The shown agent's own line under its screen: name, role, model, what it is on, its last final result. */
function seatLine(s: SeatView): Raw {
  const st = seatState(s);
  const res = seatResult(s);
  return html`<b>${s.name}</b><span class="b outline">${ROLE[s.role]}</span>${modelChip(s.model)}<span class="sw-st ${st.cls}">${seatNow(s)}</span><span class="sw-nres ${res.cls}">${res.text}</span>`;
}

export function mountSwarmPane(root: HTMLElement, first: SwarmView, o: { agent: string; label?: string; onSeat?: (seat: number) => void }): SwarmPaneHandle {
  let sw = first;
  let shown = first.lead;
  let live: LivePanelHandle | null = null;
  let liveSeat = 0;
  let visible = false;
  let dead = false;
  const stage = root.querySelector<HTMLElement>("#sw-live")!;

  const unmountLive = () => {
    live?.destroy();
    live = null;
    liveSeat = 0;
    stage.innerHTML = "";
  };
  const mountLive = () => {
    unmountLive();
    const seat = sw.seats.find((s) => s.seat === shown) ?? sw.seats[0]!;
    liveSeat = seat.seat;
    // the live panel says a resting screen in words (the runtime's reason, "Paused: vault low"), never an empty box
    live = mountLivePanel(stage, { agent: o.agent, seat: seat.seat, io: seatPanelIO(o.agent, seat.seat), label: seat.name, list: false, frame: "none", caption: false });
  };

  /** A seat that rests (its vault cannot carry it, or the swarm is asleep): said in words in place of a screen. */
  const resting = (s: SeatView): Raw | null => {
    const r = fresh(s);
    if (r?.state === "paused") return html`<div class="sw-rest" data-rest="paused"><b>Paused: vault low</b><p>The vault cannot pay for this agent's next attempt beside the others', so its computer rests. It starts again when the vault is funded.</p></div>`;
    if (r?.state === "asleep") return html`<div class="sw-rest" data-rest="asleep"><b>Asleep</b><p>The vault is below the wake threshold. The computer starts again when the vault is funded.</p></div>`;
    return null;
  };
  /** The stage for the shown seat: its live screen, or its resting line. Only ever one screen. */
  const stageFor = (cur: SeatView) => {
    if (!visible) return;
    const rest = resting(cur);
    if (rest) {
      if (live) unmountLive();
      if (stage.dataset.rest !== `${cur.seat}:${rest.s.length}`) stage.innerHTML = rest.s;
      stage.dataset.rest = `${cur.seat}:${rest.s.length}`;
      return;
    }
    if (stage.dataset.rest) {
      delete stage.dataset.rest;
      stage.innerHTML = "";
    }
    if (!live || liveSeat !== shown) mountLive();
  };

  const paint = () => {
    const cur = sw.seats.find((s) => s.seat === shown) ?? sw.seats[0]!;
    stageFor(cur);
    const now = root.querySelector<HTMLElement>("#sw-now");
    if (now) now.innerHTML = seatLine(cur).s;
    const rows = root.querySelector<HTMLElement>("#sw-seats");
    if (rows) rows.innerHTML = seatRows(sw, shown).s;
    const rec = root.querySelector<HTMLElement>("#sw-record");
    if (rec) rec.innerHTML = recordRows(sw).s;
    const units = document.querySelector<HTMLElement>("#sw-units");
    if (units) units.outerHTML = swarmBuilding(sw).s;
  };

  // a row is a second way to the same choice: the control above follows through onSeat
  const pick = (ev: Event) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-seat]");
    if (!b || (ev.target as HTMLElement).closest("a")) return;
    const n = Number(b.dataset.seat);
    if (!n || n === shown) return;
    o.onSeat?.(n);
  };
  // unit names for the rows (Core's list of units, read once)
  void loadLineageNames().then(() => !dead && paint()).catch(() => undefined);
  root.querySelector("#sw-seats")?.addEventListener("click", pick);
  paint();

  const timer = setInterval(async () => {
    if (dead || !stage.isConnected) return clearInterval(timer);
    const next = await swarmOf(o.agent);
    if (!next || dead) return;
    sw = next;
    paint();
  }, 15_000);

  return {
    show(seat) {
      if (sw.seats.some((s) => s.seat === seat)) shown = seat;
      visible = true;
      paint();
    },
    hide() {
      if (!visible) return;
      visible = false;
      unmountLive();
      delete stage.dataset.rest;
    },
    destroy() {
      dead = true;
      clearInterval(timer);
      live?.destroy();
    },
  };
}

/**
 * The agent profile's Desktop panel for a swarm: the same per-agent control ("Computer 1", "Computer 2")
 * over the one screen there, starting on the lead. Returns the handle that replaces the solo panel's.
 */
export function mountSeatDesktop(seg: HTMLElement, liveEl: HTMLElement, agent: string, sw: SwarmView): { destroy(): void } {
  let live: LivePanelHandle | null = null;
  const show = (seat: number) => {
    const s = sw.seats.find((x) => x.seat === seat) ?? sw.seats[0]!;
    live?.destroy();
    liveEl.innerHTML = "";
    live = mountLivePanel(liveEl, { agent, seat: s.seat, io: seatPanelIO(agent, s.seat), label: s.name, list: false, frame: "none", caption: false });
    seg.innerHTML = seatButtons(sw, s.seat).s;
  };
  seg.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-seat]");
    if (b && b.getAttribute("aria-pressed") !== "true") show(Number(b.dataset.seat));
  });
  seg.hidden = false;
  show(sw.lead);
  return { destroy: () => live?.destroy() };
}
