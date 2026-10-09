// Styles for the live agent panel, injected once by the component so it mounts anywhere the app
// stylesheet is loaded (the session page, the token page). Tokens first, light and dark.
//
// Code is set in Geist like the rest of the app (owner rule: no monospace). Alignment: each line's
// leading whitespace is rendered as a fixed-width spacer (one column = --lp-col, a tab = 4 columns),
// so indentation lines up exactly whatever the proportional glyph widths are; the rest of the line
// keeps tabular figures and its own spacing.

export const CSS = `
.lp {
  --lp-o: #f0661a;
  --lp-o-ink: #b8460a;
  --lp-o-soft: color-mix(in oklab, var(--lp-o) 12%, transparent);
  --lp-hl: color-mix(in oklab, var(--lp-o) 7%, transparent);
  --lp-o-line: color-mix(in oklab, var(--lp-o) 55%, var(--line));
  --lp-glow: color-mix(in oklab, var(--lp-o) 38%, transparent);
  --lp-chrome: var(--panel-3);
  --lp-chrome-2: var(--panel-2);
  --lp-code: var(--panel);
  --lp-del: color-mix(in oklab, #d03b3b 14%, var(--panel));
  --lp-add: color-mix(in oklab, var(--lp-o) 9%, var(--panel));
  --lp-col: 0.52em;
  --lp-lh: 21px;
  position: relative; isolation: isolate; border-radius: 12px; background: var(--lp-code);
  border: 1px solid var(--lp-o-line); min-width: 0; font-size: 13px;
  box-shadow: 0 0 0 1px color-mix(in oklab, var(--lp-o) 18%, transparent), 0 10px 30px -18px rgba(0,0,0,.35);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .lp { --lp-o: #ff7a2e; --lp-o-ink: #ffae7a; --lp-glow: color-mix(in oklab, var(--lp-o) 34%, transparent); }
}
:root[data-theme="dark"] .lp { --lp-o: #ff7a2e; --lp-o-ink: #ffae7a; --lp-glow: color-mix(in oklab, var(--lp-o) 34%, transparent); }
.lp::before {
  content: ""; position: absolute; inset: -1px; border-radius: 12px; pointer-events: none; z-index: -1;
  box-shadow: 0 0 0 1px var(--lp-o), 0 0 22px 3px var(--lp-glow), inset 0 0 18px -6px var(--lp-glow);
  opacity: .35; transition: opacity .6s ease;
}
.lp[data-active="1"]::before { animation: lp-glow 2.8s ease-in-out infinite alternate; opacity: 1; }
@keyframes lp-glow { from { opacity: .45; } to { opacity: 1; } }

.lp-tabs { display: flex; align-items: flex-end; gap: 2px; padding: 8px 10px 0; background: var(--lp-chrome); border-radius: 11px 11px 0 0; min-width: 0; }
.lp-dots { display: flex; gap: 6px; padding: 0 8px 11px 2px; flex: none; }
.lp-dots i { width: 10px; height: 10px; border-radius: 50%; background: color-mix(in oklab, var(--faint) 45%, transparent); }
.lp-tabrow { display: flex; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; flex: 1; }
.lp-tabrow::-webkit-scrollbar { display: none; }
.lp-tab { appearance: none; font: inherit; color: var(--dim); background: transparent; border: 0; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 9px 9px 0 0;
  max-width: 200px; min-width: 0; flex: none; font-size: 12.5px; position: relative; }
.lp-tab span.n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-tab:hover { background: color-mix(in oklab, var(--panel) 55%, transparent); color: var(--text); }
.lp-tab[aria-selected="true"] { background: var(--lp-code); color: var(--text); font-weight: 550; }
.lp-tab[aria-selected="true"]::after { content: ""; position: absolute; left: 10px; right: 10px; top: 0; height: 2px; border-radius: 0 0 2px 2px; background: var(--lp-o); }
.lp-tab:focus-visible, .lp-btn:focus-visible, .lp-seg button:focus-visible, .lp-sess:focus-visible, .lp-prog:focus-visible, .lp-out-t:focus-visible { outline: 2px solid var(--lp-o); outline-offset: 1px; }
.lp-tab svg { width: 12px; height: 12px; flex: none; color: var(--faint); }
.lp-tab .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--lp-o); flex: none; }
.lp-state { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 10px 10px; font-size: 12px; font-weight: 600; color: var(--dim); white-space: nowrap; }
.lp-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.lp-state[data-s="live"] { color: var(--lp-o-ink); }
.lp-state[data-s="live"] i { background: var(--lp-o); box-shadow: 0 0 0 0 var(--lp-glow); animation: lp-ping 1.6s ease-out infinite; }
@keyframes lp-ping { 0% { box-shadow: 0 0 0 0 var(--lp-glow); } 100% { box-shadow: 0 0 0 7px transparent; } }

.lp-bar { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: var(--lp-code); border-bottom: 1px solid var(--line-soft); min-width: 0; flex-wrap: wrap; }
.lp-addr { flex: 1 1 240px; min-width: 0; display: flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px; border-radius: 15px; background: var(--lp-chrome-2); color: var(--dim); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.lp-addr svg { width: 12px; height: 12px; flex: none; color: var(--faint); }
.lp-addr .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lp-addr b { color: var(--text); font-weight: 550; }
.lp-addr .rng { color: var(--lp-o-ink); flex: none; }
.lp-find { display: none; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--lp-o-line); background: var(--lp-o-soft); color: var(--text); font-size: 12px; max-width: 100%; min-width: 0; }
.lp-find[data-on="1"] { display: inline-flex; }
.lp-find .q { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lp-find .m { color: var(--dim); flex: none; font-variant-numeric: tabular-nums; }
.lp-ctl { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
.lp-btn { appearance: none; font: inherit; font-size: 12px; font-weight: 550; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; height: 28px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.lp-btn svg { width: 12px; height: 12px; }
.lp-btn:hover { border-color: var(--lp-o-line); }
.lp-btn[disabled] { opacity: .45; cursor: default; }
.lp-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; height: 28px; }
.lp-seg button { appearance: none; font: inherit; font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--dim); background: var(--panel); border: 0; border-left: 1px solid var(--line-soft); padding: 0 7px; cursor: pointer; }
.lp-seg button:first-child { border-left: 0; }
.lp-seg button[aria-pressed="true"] { background: var(--lp-o-soft); color: var(--lp-o-ink); font-weight: 650; }
.lp-prog { position: relative; height: 4px; background: var(--line-soft); cursor: pointer; }
.lp-prog i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--lp-o); border-radius: 0 2px 2px 0; transition: width .25s linear; }
.lp-prog[hidden] { display: none; }

.lp-view { position: relative; height: var(--lp-h, 440px); background: var(--lp-code); }
.lp-code { position: absolute; inset: 0; overflow: auto; overscroll-behavior: contain; }
.lp-lines { position: relative; padding: 10px 0 40px; min-width: max-content; font: 400 12.5px/var(--lp-lh) var(--font); font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0; font-variant-numeric: tabular-nums; }
.lp-l { display: flex; min-height: var(--lp-lh); position: relative; }
.lp-n { flex: none; width: 52px; padding-right: 12px; text-align: right; color: var(--faint); font-size: 11.5px; user-select: none; }
.lp-c { white-space: pre; tab-size: 4; padding-right: 28px; color: var(--text); }
.lp-i { display: inline-block; width: calc(var(--w) * var(--lp-col)); }
.lp-l.hl { background: var(--lp-hl); }
.lp-l.hl .lp-n { color: var(--lp-o-ink); box-shadow: inset 2px 0 0 var(--lp-o); }
.lp-l.del { background: var(--lp-del); }
.lp-l.del .lp-c { text-decoration: line-through; text-decoration-color: color-mix(in oklab, #d03b3b 60%, transparent); }
.lp-l.typing, .lp-l.edited { background: var(--lp-add); }
.lp-l.edited .lp-n { box-shadow: inset 2px 0 0 var(--lp-o); }
.lp-l.sealed { background: repeating-linear-gradient(135deg, var(--lp-o-soft) 0 6px, transparent 6px 12px); }
.lp-l.sealed .lp-c { color: var(--dim); }
.lp-l.sealed .lp-n { color: var(--lp-o-ink); box-shadow: inset 2px 0 0 var(--lp-o); }
.lp-caret { display: inline-block; width: 2px; height: 1.15em; margin-left: 1px; vertical-align: -0.2em; background: var(--lp-o); animation: lp-blink 1s steps(1) infinite; }
@keyframes lp-blink { 50% { opacity: 0; } }
.lp-seal { position: absolute; right: 12px; display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: var(--lp-o-ink); background: var(--lp-code); border: 1px solid var(--lp-o-line); white-space: nowrap; pointer-events: none; }
.lp-seal svg { width: 11px; height: 11px; }

.lp-cursor { position: absolute; left: 0; top: 0; z-index: 3; pointer-events: none; transition: transform .45s cubic-bezier(.3,.7,.2,1), opacity .3s; opacity: 0; will-change: transform; }
.lp-cursor[data-on="1"] { opacity: 1; }
.lp-cursor svg { display: block; width: 20px; height: 22px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.28)); }
.lp-cursor .tag { position: absolute; left: 16px; top: 18px; padding: 2px 7px; border-radius: 6px; background: var(--lp-o); color: #fff; font-size: 11px; font-weight: 650; white-space: nowrap; box-shadow: 0 2px 8px -2px var(--lp-glow); }

.lp-home { position: absolute; inset: 0; overflow: auto; padding: 18px 20px; }
.lp-home h3 { font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
.lp-home .sub { color: var(--dim); margin-top: 3px; font-size: 12.5px; overflow-wrap: anywhere; }
.lp-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); border-radius: 9px; overflow: hidden; margin-top: 14px; }
.lp-kv > div { background: var(--lp-code); padding: 9px 12px; min-width: 0; }
.lp-kv .k { font-size: 11px; color: var(--faint); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
.lp-kv .v { margin-top: 3px; font-weight: 600; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-files { margin-top: 14px; display: grid; gap: 4px; }
.lp-files button { appearance: none; font: inherit; text-align: left; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line-soft); background: var(--lp-code); color: var(--text); cursor: pointer; min-width: 0; }
.lp-files button:hover { border-color: var(--lp-o-line); }
.lp-files .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.lp-files .c { color: var(--faint); font-size: 12px; flex: none; font-variant-numeric: tabular-nums; }
.lp-msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--dim); }
.lp-msg b { color: var(--text); }
.lp-msg[hidden], .lp-home[hidden], .lp-code[hidden] { display: none; }

.lp-say { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--line-soft); background: var(--lp-chrome-2); min-height: 40px; min-width: 0; }
.lp-say .ic { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--lp-o-soft); color: var(--lp-o-ink); }
.lp-say .ic svg { width: 12px; height: 12px; }
.lp-say .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.lp-say .t b { font-weight: 600; }
.lp-say .t q { color: var(--dim); font-style: normal; }
.lp-say .tm { flex: none; color: var(--faint); font-size: 11.5px; font-variant-numeric: tabular-nums; }

.lp-run { border-top: 1px solid var(--line-soft); padding: 10px 12px 12px; display: grid; gap: 8px; background: var(--lp-code); border-radius: 0 0 11px 11px; }
.lp-run-h { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
.lp-run-h .aside { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 500; }
.lp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.lp-row .lbl { font-size: 12.5px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.lp-row .lbl span { color: var(--faint); font-weight: 500; }
.lp-ph { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.lp-ph span { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 11px; font-size: 11.5px; border: 1px solid var(--line-soft); color: var(--faint); background: var(--panel-2); font-variant-numeric: tabular-nums; }
.lp-ph span svg { width: 10px; height: 10px; }
.lp-ph span[data-s="done"] { color: var(--text); }
.lp-ph span[data-s="done"] svg { color: var(--good); }
.lp-ph span[data-s="on"] { color: var(--lp-o-ink); border-color: var(--lp-o-line); background: var(--lp-o-soft); }
.lp-ph span[data-s="on"] i { width: 6px; height: 6px; border-radius: 50%; background: var(--lp-o); animation: lp-blink 1s steps(1) infinite; }
.lp-out-t { appearance: none; font: inherit; font-size: 12px; color: var(--accent-ink); background: none; border: 0; padding: 0; cursor: pointer; }
.lp-out { display: grid; gap: 6px; padding: 10px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line-soft); font-size: 12px; min-width: 0; }
.lp-out pre { margin: 0; font: 400 11.5px/1.55 var(--font); font-variant-numeric: tabular-nums; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dim); max-height: 180px; overflow: auto; }
.lp-out .st { display: flex; flex-wrap: wrap; gap: 4px 10px; font-weight: 600; }
.lp-out .st span { color: var(--faint); font-weight: 500; font-variant-numeric: tabular-nums; }
.lp-none { color: var(--faint); font-size: 12.5px; }
.lp-ok { color: var(--good); }
.lp-bad { color: var(--bad); }

.lp-list { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.lp-sess { appearance: none; font: inherit; font-size: 12px; color: var(--dim); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; font-variant-numeric: tabular-nums; }
.lp-sess[aria-current="true"] { border-color: var(--lp-o-line); color: var(--lp-o-ink); background: var(--lp-o-soft); font-weight: 600; }
.lp-sess i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.lp-sess i[data-s="live"] { background: var(--lp-o); }
.lp-banner { display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 12.5px; background: var(--lp-o-soft); color: var(--text); border-bottom: 1px solid var(--lp-o-line); }
.lp-banner svg { width: 12px; height: 12px; color: var(--lp-o-ink); flex: none; }
.lp-banner[hidden] { display: none; }

@media (max-width: 760px) {
  .lp { --lp-h: 360px; font-size: 12.5px; }
  .lp-dots { display: none; }
  .lp-n { width: 40px; padding-right: 8px; }
  .lp-ctl { margin-left: 0; width: 100%; }
  .lp-ctl .lp-seg, .lp-ctl .lp-none { margin-left: auto; }
  .lp-addr { flex-basis: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .lp[data-active="1"]::before { animation: none; opacity: .85; }
  .lp-cursor { transition: opacity .2s; }
  .lp-caret, .lp-state[data-s="live"] i, .lp-ph span[data-s="on"] i { animation: none; }
  .lp-prog i { transition: none; }
}
`;

/** Injects the panel's stylesheet once per document, or once per shadow root (the embed kit). */
export function ensureStyle(root: Document | ShadowRoot = document) {
  if (root instanceof Document) {
    if (root.getElementById("lp-style")) return;
  } else if (root.querySelector("style[data-lp-style]")) return;
  const s = document.createElement("style");
  s.id = "lp-style";
  s.dataset.lpStyle = "";
  s.textContent = CSS;
  (root instanceof Document ? root.head : root).appendChild(s);
}
