// Shadow DOM styles. Theme through custom properties on the host element (or any ancestor):
// --lineage-accent, --lineage-bg, --lineage-fg, --lineage-muted, --lineage-font, --lineage-radius,
// --lineage-line, --lineage-panel. Defaults follow the viewer's light or dark scheme; scheme="dark" or
// scheme="light" on an element forces one. The default face is a sans stack (never monospace); set
// --lineage-font: inherit to take the host page's font.

import { BUILDING_CSS } from "../../../apps/web/src/building.ts";

const LIGHT = `--_bg: var(--lineage-bg, #fbfaf8); --_fg: var(--lineage-fg, #1c1b19); --_muted: var(--lineage-muted, #6b665f); --_accent: var(--lineage-accent, #d9561a);`;
const DARK = `--_bg: var(--lineage-bg, #121211); --_fg: var(--lineage-fg, #ecebe8); --_muted: var(--lineage-muted, #9d978f); --_accent: var(--lineage-accent, #ff7a2e);`;

export const BASE = `
:host { display: block; box-sizing: border-box; min-width: 0; ${LIGHT}
  --_font: var(--lineage-font, "Geist", "Geist Sans", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --_radius: var(--lineage-radius, 12px);
  --_line: var(--lineage-line, color-mix(in oklab, var(--_fg) 14%, transparent));
  --_panel: var(--lineage-panel, color-mix(in oklab, var(--_fg) 4%, var(--_bg)));
  --panel: var(--_panel); --panel-2: color-mix(in oklab, var(--_fg) 7%, var(--_bg)); --panel-3: color-mix(in oklab, var(--_fg) 11%, var(--_bg));
  --line: var(--_line); --line-soft: color-mix(in oklab, var(--_fg) 8%, transparent);
  --text: var(--_fg); --dim: var(--_muted); --faint: color-mix(in oklab, var(--_muted) 72%, var(--_bg)); --font: var(--_font);
  --good: #2f9e62; --bad: #d24b4b; --accent-ink: var(--_accent);
  color: var(--_fg); font-family: var(--_font); font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
@media (prefers-color-scheme: dark) { :host(:not([scheme="light"])) { ${DARK} } }
:host([scheme="dark"]) { ${DARK} }
:host([hidden]) { display: none; }
*, *::before, *::after { box-sizing: border-box; }
a { color: inherit; }
button, input { font: inherit; color: inherit; }
.num { font-variant-numeric: tabular-nums; }
.faint, .dim { color: var(--dim); }
.u { color: var(--dim); font-size: .86em; margin-left: 3px; }
.none { color: var(--dim); margin: 6px 0; }
.err { color: var(--dim); padding: 14px; border: 1px dashed var(--_line); border-radius: var(--_radius); }
.err b { color: var(--_fg); }
.lp-msg, .err { overflow-wrap: anywhere; }
:host .lp { --lp-o: var(--_accent); --lp-o-ink: color-mix(in oklab, var(--_accent) 72%, var(--_fg)); }
`;

export const SCREEN = `
.wrap { position: relative; }
:host([frame="crt"]) .scan { position: absolute; inset: 0; pointer-events: none; z-index: 30;
  background: repeating-linear-gradient(0deg, rgba(0,0,0,.16) 0 1px, transparent 1px 3px); mix-blend-mode: multiply; }
:host([compact]) .lp-run, :host([compact]) .lp-list, :host([compact]) .lp-note, :host([compact]) .lp-latest { display: none; }
`;

export const REEL = `
.head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 10px; color: var(--dim); font-size: 12px; }
.track { display: flex; gap: 14px; overflow-x: auto; scroll-snap-type: x proximity; padding: 4px 2px 14px; scrollbar-width: thin; overscroll-behavior-x: contain; }
.track > .card { flex: none; scroll-snap-align: start; }
:host([layout="grid"]) .track { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); overflow: visible; }
:host([layout="grid"]) .card { width: auto; }
.card { width: 236px; background: var(--_panel); border: 1px solid var(--_line); border-radius: var(--_radius); overflow: hidden; display: flex; flex-direction: column; min-width: 0;
  transition: transform .35s cubic-bezier(.2,.7,.2,1), box-shadow .35s, border-color .35s; }
.card:hover, .card:focus-within { border-color: color-mix(in oklab, var(--_accent) 55%, var(--_line)); box-shadow: 0 12px 28px -18px color-mix(in oklab, var(--_accent) 70%, transparent); }
.shot { position: relative; display: block; aspect-ratio: 16 / 10; background: var(--_bg); border-bottom: 1px solid var(--_line); overflow: hidden; }
.shot:focus-visible { outline: 2px solid var(--_accent); outline-offset: -2px; }
.thumb { position: absolute; inset: 0; display: block; }
.thumb canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.thumb canvas.dith { image-rendering: pixelated; transition: opacity .6s ease; }
.card:hover canvas.dith, .card:focus-within canvas.dith { opacity: 0; }
.ph { position: absolute; inset: 0; display: grid; place-items: center; color: var(--dim); font-size: 12px; text-align: center; padding: 10px; }
.chip { position: absolute; right: 6px; top: 2px; display: inline-flex; align-items: center; gap: 5px; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 10.5px; font-weight: 600;
  background: color-mix(in oklab, var(--_bg) 86%, transparent); border: 1px solid var(--_line); color: var(--dim); backdrop-filter: blur(4px); }
.chip i { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); }
.chip[data-s="working"] { color: var(--_accent); border-color: color-mix(in oklab, var(--_accent) 50%, transparent); }
.chip[data-s="working"] i { background: var(--_accent); animation: ping 1.6s ease-out infinite; }
.chip[data-s="graduated"] { color: var(--good); }
.chip[data-s="graduated"] i { background: var(--good); }
@keyframes ping { 0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--_accent) 60%, transparent); } 100% { box-shadow: 0 0 0 6px transparent; } }
.meta { padding: 10px 12px 12px; display: grid; gap: 5px; min-width: 0; }
.id { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.sym { font-weight: 700; letter-spacing: .01em; flex: none; }
.name { color: var(--dim); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.tag { margin: 0; font-size: 12.5px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.line { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; }
.repo { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.figs { justify-content: space-between; }
.mc .k { color: var(--dim); }
.prog { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dim); }
.prog .bar { width: 52px; height: 4px; border-radius: 2px; background: var(--_line); overflow: hidden; }
.prog .bar i { display: block; height: 100%; background: var(--_accent); }
.cap { font-size: 11.5px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* timeline: cards on a launch-time axis, tilted like cards on a desk, standing up on hover */
:host([layout="timeline"]) .tl { position: relative; overflow-x: auto; overflow-y: hidden; padding-bottom: 6px; perspective: 1400px; scrollbar-width: thin; }
:host([layout="timeline"]) .tl-track { position: relative; height: 420px; }
:host([layout="timeline"]) .card { position: absolute; top: 18px; transform: rotateX(8deg) rotateY(-14deg); transform-origin: 50% 100%; }
:host([layout="timeline"]) .card:nth-child(even of .card) { top: 60px; }
:host([layout="timeline"]) .card:hover, :host([layout="timeline"]) .card:focus-within { transform: rotateX(0) rotateY(0) translateY(-6px); z-index: 2; }
.axis { position: absolute; left: 0; right: 0; bottom: 18px; height: 1px; background: var(--_line); }
.tick { position: absolute; bottom: 0; font-size: 11px; color: var(--dim); transform: translateX(-50%); white-space: nowrap; }
.tick::before { content: ""; position: absolute; left: 50%; bottom: 17px; width: 1px; height: 7px; background: var(--_line); }
@media (prefers-reduced-motion: reduce) {
  .card, .thumb canvas.dith { transition: none; }
  .chip[data-s="working"] i { animation: none; }
  :host([layout="timeline"]) .card { transform: none; }
}
`;

export const TERMINAL = `
.term { --tube: var(--lineage-tube, var(--_accent)); position: relative; display: flex; flex-direction: column; min-height: 0; height: var(--h, 420px);
  background: var(--lineage-term-bg, #0e0d0c); color: color-mix(in oklab, var(--tube) 82%, white); border-radius: var(--_radius); overflow: hidden;
  border: 1px solid color-mix(in oklab, var(--tube) 35%, transparent); font-size: 13px; }
:host([frame="crt"]) .term { background: transparent; border: 0; border-radius: 0; text-shadow: 0 0 6px color-mix(in oklab, var(--tube) 55%, transparent); }
:host([frame="none"]) .term { border: 0; border-radius: 0; }
.term.full { position: fixed; inset: 0; height: auto; z-index: 2147483000; border-radius: 0; }
.bar { flex: none; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border-bottom: 1px solid color-mix(in oklab, var(--tube) 25%, transparent); font-size: 12px; }
.knob { width: 12px; height: 12px; border-radius: 50%; background: var(--tube); border: 0; padding: 0; cursor: pointer; box-shadow: 0 0 8px var(--tube); }
.title { font-weight: 650; letter-spacing: .02em; }
.title span { opacity: .6; font-weight: 500; }
.bar .sp { flex: 1; }
.ib { background: none; border: 0; cursor: pointer; opacity: .75; padding: 4px; display: inline-flex; }
.ib:hover { opacity: 1; }
.ib svg { width: 13px; height: 13px; }
.out { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 4px; display: grid; align-content: start; gap: 4px; overscroll-behavior: contain; scrollbar-width: thin; }
.out > div { min-width: 0; overflow-wrap: anywhere; }
.echo { opacity: .7; margin-top: 6px; }
.echo::before { content: "> "; }
.out a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.out b { color: color-mix(in oklab, var(--tube) 50%, white); }
.out .dim { color: color-mix(in oklab, var(--tube) 50%, #777); }
.tr { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.tr .c { min-width: 110px; font-weight: 600; }
.tr .d { flex: 1 1 160px; min-width: 0; opacity: .85; }
.tr .n { font-variant-numeric: tabular-nums; }
.grp { margin-bottom: 6px; }
.grp .h { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .55; margin: 4px 0 2px; }
.run { background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; color: inherit; font-weight: 600; text-align: left; }
.ans { display: block; padding: 6px 9px; border-left: 2px solid var(--tube); background: color-mix(in oklab, var(--tube) 8%, transparent); }
.step .n { opacity: .6; font-variant-numeric: tabular-nums; }
.step .fig { display: inline-block; margin-left: 4px; padding: 0 6px; border-radius: 4px; background: color-mix(in oklab, var(--tube) 14%, transparent); }
code.cmd { display: block; font: inherit; padding: 6px 9px; border-radius: 6px; background: color-mix(in oklab, var(--tube) 10%, transparent); user-select: all; }
.prompt { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 12px 4px; }
.prompt label { opacity: .7; flex: none; }
.prompt input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; caret-color: var(--tube); font-size: 13px; }
.next { flex: none; display: flex; gap: 8px; padding: 0 12px 4px; }
.next[hidden] { display: none; }
.quick { flex: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 12px 10px; }
.q { height: 26px; padding: 0 10px; border-radius: 13px; cursor: pointer; font-size: 12px; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center;
  background: color-mix(in oklab, var(--tube) 10%, transparent); border: 1px solid color-mix(in oklab, var(--tube) 35%, transparent); }
.q:hover, .q:focus-visible { background: color-mix(in oklab, var(--tube) 22%, transparent); outline: 0; }
.guide { position: absolute; right: 12px; bottom: 54px; width: min(320px, calc(100% - 24px)); padding: 12px 14px; border-radius: 10px; z-index: 3;
  background: color-mix(in oklab, var(--lineage-term-bg, #0e0d0c) 80%, var(--tube)); border: 1px solid color-mix(in oklab, var(--tube) 50%, transparent); box-shadow: 0 14px 30px -16px black; }
.guide[hidden] { display: none; }
.guide p { margin: 6px 0 10px; font-size: 12.5px; line-height: 1.45; }
.guide .row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
.guide .row span { margin-right: auto; opacity: .6; font-size: 11.5px; }
.scan { position: absolute; inset: 0; pointer-events: none; background: repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 1px, transparent 1px 3px); }
:host(:not([frame="crt"])) .scan { display: none; }
@media (max-width: 520px) { .tr .c { min-width: 84px; } .quick { gap: 5px; } .q { font-size: 11.5px; padding: 0 8px; } }
`;

export const TOKEN = `
.thead { display: grid; gap: 8px; margin-bottom: 14px; }
.tid { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.tid .sym { font-size: 22px; font-weight: 700; }
.tid .name { color: var(--dim); }
.badge { font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--_line); color: var(--dim); }
.badge[data-phase="graduated"] { color: var(--good); }
.tag { margin: 0; max-width: 64ch; }
.sub { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--dim); font-size: 12.5px; }
.kvs { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 1px; background: var(--_line); border: 1px solid var(--_line); border-radius: var(--_radius); overflow: hidden; }
.kv { background: var(--_panel); padding: 9px 12px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 4px; min-width: 0; }
.kv .k { flex-basis: 100%; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
.curve { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; font-size: 12.5px; }
.prog { display: inline-flex; align-items: center; gap: 6px; }
.prog .bar { width: 120px; height: 6px; border-radius: 3px; background: var(--_line); overflow: hidden; }
.prog .bar i { display: block; height: 100%; background: var(--_accent); }
.btn { margin-left: auto; display: inline-flex; align-items: center; height: 32px; padding: 0 14px; border-radius: 8px; background: var(--_accent); color: white; font-weight: 650; text-decoration: none; }
.grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 860px) { .grid { grid-template-columns: minmax(0, 1fr); } }
section { min-width: 0; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 16px 0 8px; font-weight: 650; }
.chart { height: 240px; border: 1px solid var(--_line); border-radius: var(--_radius); background: var(--_panel); overflow: hidden; }
.mk-chart-empty { display: grid; place-items: center; height: 100%; color: var(--dim); }
.mk-svg { display: block; }
.mk-svg text { font: 10.5px var(--_font); fill: var(--dim); font-variant-numeric: tabular-nums; }
.mk-svg .grid, .mk-svg .axis { stroke: var(--_line); }
.mk-svg .ref { stroke: var(--dim); stroke-dasharray: 3 3; fill: var(--dim); }
.mk-svg .c line { stroke-width: 1; }
.mk-svg .c.up line, .mk-svg .c.up rect { stroke: var(--good); fill: var(--good); }
.mk-svg .c.down line, .mk-svg .c.down rect { stroke: var(--bad); fill: var(--bad); }
.mk-svg .c rect.v { opacity: .3; stroke: none; }
.mk-svg .c rect.hit { fill: transparent; stroke: none; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th { text-align: left; font-weight: 600; color: var(--dim); font-size: 11.5px; padding: 6px 8px; border-bottom: 1px solid var(--_line); }
.tbl td { padding: 6px 8px; border-bottom: 1px solid color-mix(in oklab, var(--_fg) 6%, transparent); font-variant-numeric: tabular-nums; }
.tbl .r { text-align: right; }
.tbl .up { color: var(--good); } .tbl .down { color: var(--bad); }
@media (max-width: 520px) { .hide-sm { display: none; } }
`;

export const HOW = `
.how { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; counter-reset: s; }
.step { display: flex; gap: 12px; padding: 14px; border: 1px solid var(--_line); border-radius: var(--_radius); background: var(--_panel); min-width: 0; }
.step .n { flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 13px; color: var(--_accent); border: 1px solid color-mix(in oklab, var(--_accent) 50%, transparent); }
.step h4 { margin: 2px 0 4px; font-size: 15px; }
.step p { margin: 0 0 8px; color: var(--dim); font-size: 13px; }
.step .f b { font-size: 18px; }
.step .f .k { color: var(--dim); font-size: 12px; }
`;

export const STATS = `
.stats { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 0; }
.stat { min-width: 0; }
.stat dt { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
.stat dd { margin: 2px 0 0; }
.stat dd b { font-size: 22px; font-weight: 700; }
:host([layout="ticker"]) .stats { gap: 6px 18px; }
:host([layout="ticker"]) .stat { display: flex; gap: 6px; align-items: baseline; }
:host([layout="ticker"]) .stat dd b { font-size: 14px; }
:host([layout="ticker"]) .stat dt { font-size: 11px; }
`;

export const PALETTE = `
.ov { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.45); display: grid; place-items: start center; padding: 12vh 16px 16px; }
.ov[hidden] { display: none; }
.box { width: min(560px, 100%); background: var(--_bg); color: var(--_fg); border: 1px solid var(--_line); border-radius: 14px; overflow: hidden; box-shadow: 0 30px 60px -20px rgba(0,0,0,.5); }
.box input { width: 100%; border: 0; border-bottom: 1px solid var(--_line); background: transparent; padding: 14px 16px; font-size: 15px; outline: 0; }
.list { max-height: 50vh; overflow-y: auto; padding: 6px; }
.it { display: flex; gap: 10px; align-items: baseline; width: 100%; text-align: left; padding: 8px 10px; border-radius: 8px; border: 0; background: none; cursor: pointer; }
.it[aria-selected="true"] { background: color-mix(in oklab, var(--_accent) 14%, transparent); }
.it .k { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; width: 64px; flex: none; }
.it .d { color: var(--dim); font-size: 12.5px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trig { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 16px; border: 1px solid var(--_line); background: var(--_panel); cursor: pointer; font-size: 12.5px; }
.trig kbd { font: inherit; font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--_line); color: var(--dim); }
`;

/* Token parameters (price, market cap, 24h volume, 24h change) and what the agent is building: the
   app's own bd- markup and styles (apps/web/src/building.ts), with the app's colour tokens mapped onto
   the kit's. */
export const PARAMS = `
:host { --tp: var(--_fg); --ts: color-mix(in oklab, var(--_fg) 78%, var(--_bg)); --tt: var(--dim); --ac: var(--_accent); --bg2: var(--_panel); --border: var(--_line); --sans: var(--_font); }
${BUILDING_CSS}
.bd-live { color: var(--_accent); }
.mk-chg.up { color: var(--good); } .mk-chg.down { color: var(--bad); }
.params .bd-params { padding: 10px 12px; border: 1px solid var(--_line); border-radius: var(--_radius); background: var(--_panel); }
.card .meta { grid-template-columns: minmax(0, 1fr); }
.card .meta > *, .params, .building { min-width: 0; }
.card .params .bd-params { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 8px; padding: 0; border: 0; background: none; }
.card .bd-params b { font-size: 13px; }
.card .building { font-size: 12px; }
.building .bd-building { font-size: 12.5px; }
.thead .params { margin-top: 2px; }
section > .building { margin-bottom: 10px; }
.tokstats { display: grid; gap: 10px; }
`;
