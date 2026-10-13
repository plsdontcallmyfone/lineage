import { get } from "../api.ts";
import { lineageName } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { mount as mountLivePanel, type LivePanelHandle } from "../live-panel/index.ts";
import { providerLogo } from "../provider-logo.ts";
import { seatPanelIO, swarmOf, type SeatView, type SwarmView } from "../swarm.ts";
import { drawThumb, thumbModel, type ThumbModel } from "../../../../packages/embed/src/thumb.ts";
import { palette } from "./explorer.ts";
import { providerName } from "./social-ui.ts";

// The coin page of a swarm (docs/plans/SWARMS.md 6): the centre panel's "Computers" view. One large
// live screen (the existing live panel, given a seat), a row of thumbnail tiles for the other seats
// (a click makes a tile the large one; only the large screen plays video), a row per seat in the
// page's own row style (name, role, model, what it is on, its last final result), and the record of
// accepted changes naming the seat and model of each. A solo coin never loads any of this.
//
// What is shown per seat while it works is what its session and its intent already say (the unit and
// the target). A seat's result is its newest FINAL candidate: Core names no seat on an open one.

const STYLE = `
.sw-wrap{display:flex;flex-direction:column;min-width:0}
.sw-stage{padding:12px 12px 0}
.sw-now{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 16px 0;font:500 13px/1.4 var(--sans);letter-spacing:-.01em;color:var(--ts)}
.sw-now b{color:var(--tp);font-weight:500}
.sw-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:12px}
.sw-tile{display:flex;flex-direction:column;gap:6px;min-width:0;padding:6px;border:0;background:var(--bg3);border-radius:16px;corner-shape:squircle;cursor:pointer;text-align:left;color:inherit;font:inherit;transition:background .15s}
.sw-tile:hover{background:var(--pill)}
.sw-tile:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.sw-scr{--ex-scr-bg:#0a0908;--ex-scr-panel:#1a1c20;--ex-scr-fg:#e6e8ec;--ex-scr-muted:#7a808c;--ex-scr-accent:var(--ac);position:relative;aspect-ratio:16/10;background:var(--ex-scr-bg);border-radius:12px;corner-shape:squircle;overflow:hidden}
.sw-scr canvas{display:block;width:100%;height:100%}
.sw-tl{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0;padding:0 4px 2px;font:500 12px/1.4 var(--sans);letter-spacing:-.01em}
.sw-tl span:first-child{color:var(--tp);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sw-tl .sw-st{color:var(--tt);white-space:nowrap}
.sw-st.working{color:var(--good)}
.sw-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px 6px;border-top:1px solid var(--border);font:500 12px/1.4 var(--sans);letter-spacing:-.01em;color:var(--tt)}
.sw-seats>li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;align-items:center;cursor:pointer}
.sw-seats>li[aria-current="true"]{background:var(--bg3)}
.sw-seats .tk-row-main{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.sw-seats .sw-model{display:inline-flex;align-items:center;gap:5px;color:var(--ts);font-size:12.5px}
.sw-seats .tk-row-sub{white-space:normal}
.sw-seats .sw-res{grid-column:2;grid-row:1 / span 2;text-align:right;font:500 12px/1.4 var(--sans);color:var(--tt);font-variant-numeric:tabular-nums;white-space:nowrap}
.sw-res.ok{color:var(--good)}
.sw-record>li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px}
.sw-record .sw-when{grid-column:2;grid-row:1 / span 2;align-self:center;color:var(--tt);font-size:12px;white-space:nowrap}
.sw-units{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:6px}
.sw-units li{font-size:13.5px;color:var(--tp);min-width:0}
.sw-units li span{color:var(--tt)}
@media (max-width:640px){
  .sw-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
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
export function seatState(s: SeatView): { text: string; cls: string } {
  const r = s.runtime;
  if (!r) return { text: s.session ? "Working" : "Not started", cls: s.session ? "working" : "" };
  if (r.state === "working") return { text: "Working", cls: "working" };
  if (r.state === "asleep") return { text: "Asleep", cls: "" };
  if (r.state === "paused") return { text: "Paused: vault low", cls: "" };
  return { text: r.why && /^Waiting for verdicts/.test(r.why) ? "Waiting for verdicts" : "Between attempts", cls: "" };
}

/** What a seat is on now: its target and unit while an attempt runs, else its state with the runtime's reason. */
function seatNow(s: SeatView): Raw {
  const r = s.runtime;
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
    return html`<li data-seat="${s.seat}" aria-current="${String(s.seat === shown)}" title="Show ${s.name}'s screen">
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

/** The markup of the Computers pane (the large screen is mounted by mountSwarmPane). */
export function swarmPane(sw: SwarmView): Raw {
  injectStyle();
  return html`<div class="sw-wrap" id="mk-swarm">
    <div class="sw-stage"><div id="sw-live" class="mk-live" style="padding:0"></div></div>
    <div class="sw-now" id="sw-now"></div>
    <div class="sw-tiles" id="sw-tiles" role="group" aria-label="Other computers of this swarm"></div>
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
    const unit = s.runtime?.state === "working" ? (s.runtime.unit ?? s.session?.lineage_id) : s.session?.lineage_id;
    if (unit) (by.get(unit) ?? by.set(unit, []).get(unit)!).push(s);
  }
  if (!by.size) return html`<ul class="sw-units" id="sw-units"><li><span>No unit in work right now.</span></li></ul>`;
  return html`<ul class="sw-units" id="sw-units">${[...by].map(([unit, seats]) => html`<li><a class="link" href="/units/${unit}">${lineageName(unit)}</a> <span>${seats.map((s) => `${s.name}${s.runtime?.target ? ` on ${s.runtime.target}` : ""}`).join(", ")}</span></li>`)}</ul>`;
}

export interface SwarmPaneHandle {
  /** called when the Computers view is shown: mounts the large screen the first time */
  show(): void;
  destroy(): void;
}

export function mountSwarmPane(root: HTMLElement, first: SwarmView, o: { agent: string; label?: string }): SwarmPaneHandle {
  let sw = first;
  let shown = first.lead;
  let live: LivePanelHandle | null = null;
  let visible = false;
  let dead = false;
  const stage = root.querySelector<HTMLElement>("#sw-live")!;
  const tiles = root.querySelector<HTMLElement>("#sw-tiles")!;
  const thumbs = new Map<string, ThumbModel>();

  const mountLive = () => {
    live?.destroy();
    stage.innerHTML = "";
    const seat = sw.seats.find((s) => s.seat === shown) ?? sw.seats[0]!;
    live = mountLivePanel(stage, { agent: o.agent, seat: seat.seat, io: seatPanelIO(o.agent, seat.seat), label: seat.name, list: false, frame: "none", caption: false });
  };

  async function modelOf(s: SeatView): Promise<ThumbModel> {
    const st = seatState(s);
    const base: ThumbModel = { repo: s.name, file: null, lines: [], cursor: -1, caption: st.text, live: st.cls === "working", title: s.name };
    if (!s.session) return base;
    const hit = thumbs.get(s.session.session_id);
    try {
      const view = await get<any>(`sessions/${s.session.session_id}`);
      const ev = [...(view.event_list ?? [])].reverse().find((e: any) => ["read", "edit", "write", "patch"].includes(e.kind) && e.path);
      let text: string | null = null;
      if (ev) text = (await get<any>(`lineages/${view.lineage_id}/file?gen=${view.gen_id}&path=${encodeURIComponent(ev.path)}`).catch(() => null))?.text ?? null;
      const m = thumbModel(view, typeof text === "string" ? text : null);
      thumbs.set(s.session.session_id, m);
      return m.lines.length ? m : { ...m, title: s.name };
    } catch {
      return hit ?? base;
    }
  }

  async function paintTile(btn: HTMLElement, s: SeatView) {
    const scr = btn.querySelector<HTMLElement>(".sw-scr");
    const canvas = scr?.querySelector("canvas");
    if (!scr || !canvas) return;
    const m = await modelOf(s);
    if (dead || !scr.isConnected) return;
    const w = Math.max(120, Math.round(scr.clientWidth || 160));
    const h = Math.max(75, Math.round(scr.clientHeight || 100));
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const cs = getComputedStyle(scr);
    drawThumb(ctx, m, w, h, palette(cs), cs.fontFamily || "sans-serif");
  }

  const paint = () => {
    const cur = sw.seats.find((s) => s.seat === shown) ?? sw.seats[0]!;
    const st = seatState(cur);
    const now = root.querySelector<HTMLElement>("#sw-now");
    if (now) now.innerHTML = html`<b>${cur.name}</b><span class="b outline">${ROLE[cur.role]}</span>${modelChip(cur.model)}<span class="sw-st ${st.cls}">${seatNow(cur)}</span>`.s;
    const others = sw.seats.filter((s) => s.seat !== shown);
    tiles.innerHTML = html`${others.map((s) => {
      const x = seatState(s);
      return html`<button type="button" class="sw-tile" data-seat="${s.seat}" aria-label="Show ${s.name}'s screen"><div class="sw-scr"><canvas aria-hidden="true"></canvas></div><div class="sw-tl"><span>${s.name}</span><span class="sw-st ${x.cls}">${x.text}</span></div></button>`;
    })}`.s;
    if (visible) for (const b of tiles.querySelectorAll<HTMLElement>(".sw-tile")) void paintTile(b, sw.seats.find((s) => String(s.seat) === b.dataset.seat)!);
    const rows = root.querySelector<HTMLElement>("#sw-seats");
    if (rows) rows.innerHTML = seatRows(sw, shown).s;
    const rec = root.querySelector<HTMLElement>("#sw-record");
    if (rec) rec.innerHTML = recordRows(sw).s;
    const units = document.querySelector<HTMLElement>("#sw-units");
    if (units) units.outerHTML = swarmBuilding(sw).s;
  };

  const pick = (ev: Event) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-seat]");
    if (!b || (ev.target as HTMLElement).closest("a")) return;
    const n = Number(b.dataset.seat);
    if (!n || n === shown) return;
    shown = n;
    if (visible) mountLive();
    paint();
  };
  tiles.addEventListener("click", pick);
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
    show() {
      visible = true;
      if (!live) mountLive();
      paint();
    },
    destroy() {
      dead = true;
      clearInterval(timer);
      live?.destroy();
    },
  };
}
