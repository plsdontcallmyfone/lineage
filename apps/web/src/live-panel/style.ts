// Styles for the agent's screen, injected once by the component so it mounts anywhere (the session
// page, the token page, the agent profile, the Explorer hover, the embed kit's shadow roots).
//
// Two parts, both in the host page's own tokens (no fonts or colours of their own beyond the live dot):
// - .lp-scr: the screen. The desktop's video fills it at the desktop's own 16:10 shape; every other
//   state is text on the page's panel colour, so the screen is never an unexplained black box.
// - the deck under it: a state pill, one caption line of facts, the sealing note and the latest event.

export const CSS = `
.lp { --lp-o: #e06510; position: relative; min-width: 0; font-size: 13px; }
.lp-stage { min-width: 0; }

/* ------------------------------------------------------------------------------- the screen */
.lp-scr { position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden; background: var(--panel); color: var(--text); font-family: var(--font, var(--sans, system-ui, sans-serif)); }
.lp[data-frame="window"] .lp-scr { border-radius: 12px; box-shadow: 0 0 0 1px var(--line); }
.lp[data-frame="device"] .lp-scr { border-radius: 10px / 13px; }
.lp-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; background: var(--panel); }
.lp-scr[data-show="msg"] .lp-video { visibility: hidden; }
.lp-scr[data-show="video"] .lp-msg { display: none; }
.lp-msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 18px 22px; overflow: auto; }
/* text states: at least the screen's 16:10, taller when the text needs it (a phone) */
.lp-scr[data-show="msg"] { aspect-ratio: auto; display: grid; }
.lp-scr[data-show="msg"]::before { content: ""; grid-area: 1 / 1; padding-top: 62.5%; }
.lp-scr[data-show="msg"] .lp-msg { position: relative; inset: auto; grid-area: 1 / 1; overflow: visible; }
.lp-msg-in { max-width: 520px; width: 100%; display: grid; gap: 8px; justify-items: center; text-align: center; }
.lp-msg-t { font-size: 17px; line-height: 1.3; font-weight: 600; letter-spacing: -.01em; color: var(--text); overflow-wrap: anywhere; }
.lp-msg-s { font-size: 13px; line-height: 1.5; color: var(--dim); max-width: 460px; }
.lp-msg-in .lp-btn { margin-top: 4px; }
.lp-scr[data-kind="connecting"] .lp-msg-t::before, .lp-scr[data-kind="loading"] .lp-msg-t::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 9px; vertical-align: 2px; border-radius: 50%; background: var(--dim); animation: lp-blink 1.2s ease-in-out infinite; }
@keyframes lp-blink { 50% { opacity: .25; } }
.lp-kv { margin: 6px 0 0; display: grid; grid-template-columns: max-content minmax(0, auto); gap: 4px 14px; text-align: left; font-size: 12.5px; }
.lp-kv div { display: contents; }
.lp-kv dt { color: var(--faint); }
.lp-kv dd { margin: 0; color: var(--text); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.lp-kv a, .lp-facts-links a { color: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 2px; }
.lp-facts-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 16px; font-size: 12.5px; }
.lp-stall { position: absolute; left: 10px; bottom: 10px; max-width: calc(100% - 20px); padding: 5px 10px; border-radius: 8px; font-size: 12px; background: color-mix(in oklab, var(--panel) 88%, transparent); color: var(--text); box-shadow: 0 0 0 1px var(--line); }
.lp-stall[hidden] { display: none; }

/* ------------------------------------------------------------------------------- the deck */
.lp-deck { margin-top: 12px; display: grid; gap: 6px; min-width: 0; }
.lp-say { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 24px; }
.lp-state { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 11px; font-size: 11.5px; font-weight: 600; color: var(--dim); background: var(--panel-2, var(--panel)); border: 1px solid var(--line); }
.lp-state i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.lp-state[data-s="live"] { color: var(--text); }
.lp-state[data-s="paused"] i { background: var(--warn, #d4a72c); }
.lp-state[data-s="live"] i { background: #e5484d; animation: lp-pulse 1.6s ease-out infinite; }
@keyframes lp-pulse { 0% { box-shadow: 0 0 0 0 rgba(229,72,77,.45); } 100% { box-shadow: 0 0 0 6px transparent; } }
.lp-say .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text); }
.lp-say .tm, .lp-latest .tm { flex: none; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.lp-note, .lp-latest { font-size: 12px; color: var(--dim); min-width: 0; overflow-wrap: anywhere; }
.lp-latest .k { color: var(--faint); }
.lp-latest .tm { margin-left: 8px; }
.lp-note[hidden], .lp-latest[hidden], .lp-run[hidden] { display: none; }
.lp-btn { appearance: none; font: inherit; font-size: 12px; font-weight: 550; color: var(--text); background: var(--panel-2, var(--panel)); border: 1px solid var(--line); border-radius: 8px; height: 30px; padding: 0 12px; cursor: pointer; }
.lp-btn:hover { background: var(--panel-3, var(--panel-2, var(--panel))); }
.lp :focus-visible { outline: 1.5px solid var(--lp-o); outline-offset: 1px; }

.lp-run { margin-top: 14px; border-top: 1px solid var(--line-soft, var(--line)); padding-top: 12px; display: grid; gap: 8px; }
.lp-run-h { font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
.lp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.lp-row .lbl { font-size: 12.5px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.lp-row .lbl span { color: var(--faint); font-weight: 500; }
.lp-none { color: var(--faint); font-size: 12.5px; }
.lp-ok { color: var(--good); }
.lp-bad { color: var(--bad); }

.lp-list { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.lp-list:empty { display: none; }
.lp-sess { appearance: none; font: inherit; font-size: 12px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; height: 30px; padding: 0 10px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; max-width: 100%; }
.lp-sess span { color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-sess i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: #e5484d; }

@media (max-width: 760px) {
  .lp-msg { padding: 14px; }
  .lp-msg-t { font-size: 15px; }
  .lp-say { flex-wrap: wrap; row-gap: 4px; }
  .lp-say .t { flex-basis: calc(100% - 90px); }
}
@media (prefers-reduced-motion: reduce) {
  .lp-state[data-s="live"] i, .lp-scr .lp-msg-t::before { animation: none; }
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
