// Styles for the live agent panel, injected once by the component so it mounts anywhere (the session
// page, the token page, the embed kit's shadow roots).
//
// Three layers:
// - .cr: the browser window, after Chrome's current desktop UI (tab strip with the active-tab flares,
//   toolbar, pill omnibox, macOS window controls), light and dark from its own palette, set in the
//   system UI face like the real thing.
// - .gh: the page, a code host's file view (header, breadcrumbs, a boxed file with line numbers),
//   light and dark. Code is set in the app's sans face (owner rule: no monospace); leading whitespace
//   is a fixed-width spacer so indentation lines up.
// - the deck under the window or machine: what the agent is doing, replay controls, runs and verdict,
//   in the host page's own tokens.
// The accent appears only as a thin focus ring on the element the agent is acting on.

export const CSS = `
.lp { --lp-o: #e06510; --lp-ring: 0 0 0 1.5px var(--lp-o); position: relative; min-width: 0; font-size: 13px; }
.lp-stage { min-width: 0; }
.lp-fit { position: relative; overflow: hidden; min-width: 0; }
.lp[data-frame="window"] .lp-fit { border-radius: 10px; box-shadow: 0 0 0 .5px rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.12), 0 18px 40px -16px rgba(0,0,0,.45); }

/* ------------------------------------------------------------------------------- the window */
.cr {
  --cr-frame: #dee3ea; --cr-tool: #ffffff; --cr-omni: #edf2fa; --cr-ico: #474747; --cr-ico-off: #b5b8bc;
  --cr-text: #1f1f1f; --cr-dim: #5f6368; --cr-tab-text: #45474a; --cr-hover: rgba(255,255,255,.55); --cr-sep: #a6abb3;
  --cr-btn-hover: rgba(31,31,31,.08); --cr-line: #e3e3e3; --cr-spin: #0b57d0;
  --gh-bg: #ffffff; --gh-fg: #1f2328; --gh-muted: #59636e; --gh-line: #d1d9e0; --gh-soft: #f6f8fa; --gh-ln: #8c959f;
  --gh-hl: #fff8c5; --gh-hl-n: #9a6700; --gh-add: #dafbe1; --gh-add-n: #aceebb; --gh-del: #ffebe9; --gh-del-n: #ffcecb;
  --gh-sel: rgba(0, 110, 255, .24); --gh-seal: rgba(89, 99, 110, .12); --gh-caret: #1f2328; --gh-link: #0969da;
  position: absolute; left: 0; top: 0; transform-origin: 0 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--cr-frame); color: var(--cr-text);
  font: 400 12px/1.4 -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased; user-select: none; cursor: default;
}
.cr[data-scheme="dark"] {
  --cr-frame: #1f2023; --cr-tool: #35363a; --cr-omni: #202124; --cr-ico: #c4c7c5; --cr-ico-off: #6f7377;
  --cr-text: #e8eaed; --cr-dim: #9aa0a6; --cr-tab-text: #c4c7c5; --cr-hover: rgba(255,255,255,.07); --cr-sep: #5f6368;
  --cr-btn-hover: rgba(255,255,255,.1); --cr-line: #4a4c50; --cr-spin: #a8c7fa;
  --gh-bg: #0d1117; --gh-fg: #f0f6fc; --gh-muted: #9198a1; --gh-line: #3d444d; --gh-soft: #151b23; --gh-ln: #656c76;
  --gh-hl: rgba(187,128,9,.17); --gh-hl-n: #d29922; --gh-add: rgba(46,160,67,.17); --gh-add-n: rgba(63,185,80,.32); --gh-del: rgba(248,81,73,.12); --gh-del-n: rgba(248,81,73,.3);
  --gh-sel: rgba(56,139,253,.38); --gh-seal: rgba(145,152,161,.12); --gh-caret: #f0f6fc; --gh-link: #4493f8;
}
.lp[data-frame="window"] .cr { border-radius: 10px; }
.cr svg { display: block; }

.cr-strip { flex: none; height: 41px; display: flex; align-items: flex-end; padding: 0 6px 0 0; position: relative; }
.cr-lights { flex: none; align-self: center; display: flex; gap: 8px; padding: 0 14px 0 13px; margin-top: 1px; }
.cr-lights i { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.18); }
.cr-lights i:nth-child(2) { background: #febc2e; }
.cr-lights i:nth-child(3) { background: #28c840; }
.cr-tabs { flex: 1; min-width: 0; display: flex; align-items: flex-end; height: 34px; }
.cr-tab { appearance: none; border: 0; font: inherit; color: var(--cr-tab-text); background: transparent; cursor: default; position: relative;
  flex: 0 1 220px; min-width: 44px; height: 34px; padding: 0 6px 0 12px; display: flex; align-items: center; gap: 8px; border-radius: 9px 9px 0 0; }
.cr-tab::before, .cr-tab::after { content: ""; position: absolute; bottom: 0; width: 9px; height: 9px; pointer-events: none; display: none; }
.cr-tab::before { left: -9px; background: radial-gradient(circle at 0 0, transparent 8.5px, var(--cr-tool) 9px); }
.cr-tab::after { right: -9px; background: radial-gradient(circle at 100% 0, transparent 8.5px, var(--cr-tool) 9px); }
.cr-tab[aria-selected="true"] { background: var(--cr-tool); color: var(--cr-text); z-index: 1; min-width: 92px; }
.cr-tab[aria-selected="true"]::before, .cr-tab[aria-selected="true"]::after { display: block; }
.cr-tab:not([aria-selected="true"]):hover { box-shadow: inset 0 -5px 0 var(--cr-frame), inset 0 5px 0 var(--cr-frame); background: var(--cr-hover); border-radius: 12px; }
.cr-t { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-align: left; font-size: 12px;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent); }
.cr-x { flex: none; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; color: var(--cr-ico); }
.cr-x svg { width: 12px; height: 12px; }
.cr-tabs[data-many="1"] .cr-tab:not([aria-selected="true"]) .cr-x { display: none; }
.cr-tab:hover .cr-x:hover { background: var(--cr-btn-hover); }
.cr-sep { flex: none; width: 1px; height: 18px; margin: 0 0 8px; background: var(--cr-sep); opacity: .6; }
.cr-sep.off { opacity: 0; }
.cr-fav { flex: none; width: 16px; height: 16px; display: grid; place-items: center; }
.cr-fav-s { border-radius: 4px; background: var(--cr-text); color: var(--cr-frame); font-size: 10px; font-weight: 700; line-height: 1; }
.cr[data-scheme="dark"] .cr-fav-s { background: #e8eaed; color: #1f2023; }
.cr-fav-g svg { width: 16px; height: 16px; color: var(--cr-ico); }
.cr-spin { border-radius: 50%; border: 2px solid transparent; border-top-color: var(--cr-spin); border-right-color: var(--cr-spin); width: 14px; height: 14px; margin: 1px; animation: cr-spin .8s steps(8) infinite; }
@keyframes cr-spin { to { transform: rotate(360deg); } }
.cr-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--cr-dim); }
.cr-mark { flex: none; color: var(--cr-dim); }
.cr-mark svg { width: 13px; height: 13px; }
.cr-ib { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; color: var(--cr-ico); }
.cr-ib.off { color: var(--cr-ico-off); }
.cr-new { width: 28px; height: 28px; margin: 0 0 3px 6px; }
.cr-new svg { width: 18px; height: 18px; }
.cr-new.pressed, .cr-ib.pressed { background: var(--cr-btn-hover); }
.cr-tsearch { width: 28px; height: 28px; align-self: center; margin-top: 1px; }
.cr-tsearch svg { width: 16px; height: 16px; }

.cr-tool { flex: none; height: 40px; display: flex; align-items: center; gap: 2px; padding: 0 6px; background: var(--cr-tool); position: relative; z-index: 1;
  box-shadow: 0 1px 0 var(--cr-line); }
.cr-tool > .cr-ib { width: 34px; height: 34px; }
.cr-tool > .cr-ib svg { width: 20px; height: 20px; }
.cr-omni { flex: 1; min-width: 0; height: 34px; margin: 0 6px; border-radius: 17px; background: var(--cr-omni); display: flex; align-items: center; gap: 4px; padding: 0 6px 0 4px; }
.cr-omni[data-edit="1"] { background: var(--cr-tool); box-shadow: 0 0 0 1px var(--cr-line), 0 1px 3px rgba(0,0,0,.08); }
.cr-site { flex: none; width: 26px; height: 26px; border-radius: 13px; display: grid; place-items: center; color: var(--cr-ico); }
.cr-site svg { width: 17px; height: 17px; }
.cr-url { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; font-size: 14px; letter-spacing: -.005em; padding-left: 4px;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent); }
.cr-url .h { color: var(--cr-text); }
.cr-url .r { color: var(--cr-dim); }
.cr-url .ph { color: var(--cr-dim); }
.cr-star { flex: none; width: 28px; height: 28px; display: grid; place-items: center; color: var(--cr-ico); }
.cr-star svg { width: 18px; height: 18px; }
.cr-avatar { flex: none; width: 24px; height: 24px; margin: 0 5px; border-radius: 50%; display: grid; place-items: center; font-size: 11.5px; font-weight: 600; color: #fff;
  background: linear-gradient(140deg, #6a8caf, #3f6185); }
.cr-caret { display: inline-block; width: 1px; height: 1.2em; vertical-align: -.25em; background: var(--cr-text); animation: cr-blink 1.06s steps(1) infinite; }
@keyframes cr-blink { 50% { opacity: 0; } }

.cr-page { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; background: var(--gh-bg); color: var(--gh-fg); scrollbar-width: none; }
.cr-page::-webkit-scrollbar { display: none; }
.cr-page[data-kind="sandbox"] { background: var(--gh-soft); }
.cr-page[data-kind="new"] { background: var(--cr-tool); }
.cr-doc { min-height: 100%; }
/* agent desktops (SPEC 17.7): the desktop's stream or recording in place of the page */
.cr[data-desk="1"] .cr-page { display: none; }
.cr[data-desk="1"] .cr-cursor { display: none; }
.cr-desk { flex: 1; min-height: 0; position: relative; background: #111318; display: flex; flex-direction: column; }
.cr-desk[hidden] { display: none; }
.cr-desk-v { flex: 1; min-height: 0; width: 100%; object-fit: contain; background: #111318; display: block; }
.cr-desk-bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: var(--cr-tool); border-top: 1px solid var(--cr-line); font-size: 12px; color: var(--cr-dim); }
.cr-desk-tag { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-desk-sw { flex: none; font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--cr-line); background: transparent; color: var(--cr-text); cursor: pointer; }
.lp-deskback { margin-right: 8px; }
.cr-desk-sw:hover { background: var(--cr-btn-hover); }
.cr .ring, .cr .gh-code.ring { box-shadow: var(--lp-ring) !important; }
.cr-omni.ring { box-shadow: var(--lp-ring), 0 1px 3px rgba(0,0,0,.08) !important; }

.cr-cursor { position: absolute; left: 0; top: 0; z-index: 20; pointer-events: none; will-change: transform; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
.cr-cursor[data-on="0"] { visibility: hidden; }
.cr-cursor[data-pressed="1"] svg { transform: scale(.92); transform-origin: 2px 2px; }

/* ------------------------------------------------------------------------------- the page */
.gh-top { display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 16px; background: var(--gh-soft); border-bottom: 1px solid var(--gh-line); font-size: 14px; min-width: 0; }
.gh-menu { flex: none; width: 30px; height: 30px; border-radius: 6px; border: 1px solid var(--gh-line); display: grid; place-content: center; gap: 3px; }
.gh-menu i { display: block; width: 13px; height: 1.5px; border-radius: 1px; background: var(--gh-muted); }
.gh-repo { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gh-repo b { font-weight: 600; }
.gh-repo .sl, .gh-crumbs .sl { color: var(--gh-muted); }
.gh-find { margin-left: auto; flex: 0 1 260px; min-width: 120px; height: 30px; border-radius: 6px; border: 1px solid var(--gh-line); background: var(--gh-bg);
  display: flex; align-items: center; gap: 7px; padding: 0 9px; color: var(--gh-fg); font-size: 13px; overflow: hidden; white-space: nowrap; }
.gh-find svg { width: 15px; height: 15px; color: var(--gh-muted); flex: none; }
.gh-find .v { overflow: hidden; text-overflow: ellipsis; }
.gh-find .ph, .gh-find .v:empty::before { color: var(--gh-muted); }
.gh-find .cr-caret { background: var(--gh-caret); }
.gh-nav { display: flex; gap: 4px; padding: 0 16px; background: var(--gh-soft); border-bottom: 1px solid var(--gh-line); font-size: 13.5px; color: var(--gh-fg); overflow: hidden; }
.gh-nav span { display: inline-flex; align-items: center; gap: 7px; padding: 9px 9px 10px; white-space: nowrap; }
.gh-nav span[aria-current] { font-weight: 600; box-shadow: inset 0 -2px 0 var(--gh-fg); }
.gh-nav svg { width: 15px; height: 15px; color: var(--gh-muted); }
.gh-wrap { padding: 14px 16px 28px; min-width: 0; }
.gh-crumbs { font-size: 15px; display: flex; flex-wrap: wrap; gap: 5px; margin: 2px 0 12px; }
.gh-crumbs span:not(.sl) { color: var(--gh-link); }
.gh-crumbs b { font-weight: 600; }
.gh-box { border: 1px solid var(--gh-line); border-radius: 6px; overflow: hidden; background: var(--gh-bg); min-width: 0; }
.gh-bh { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 7px 10px 7px 12px; background: var(--gh-soft); border-bottom: 1px solid var(--gh-line); font-size: 13px; }
.gh-bh .sp { flex: 1; }
.gh-bh svg { width: 15px; height: 15px; color: var(--gh-muted); flex: none; }
.gh-seg { display: inline-flex; border: 1px solid var(--gh-line); border-radius: 6px; overflow: hidden; }
.gh-seg span { padding: 4px 11px; font-size: 12.5px; font-weight: 600; }
.gh-seg span[aria-pressed] { background: var(--gh-bg); box-shadow: 0 0 0 1px var(--gh-line); border-radius: 5px; }
.gh-seg span:not([aria-pressed]) { color: var(--gh-muted); }
.gh-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--gh-line); border-radius: 6px; background: var(--gh-soft); font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.gh-btn svg { width: 14px; height: 14px; }
.gh-ico { padding: 0 7px; }
.dim { color: var(--gh-muted); }
.gh-file .gh-bh .dim { font-size: 12.5px; }

.gh-code { overflow-x: auto; scrollbar-width: none; }
.gh-code::-webkit-scrollbar { display: none; }
.lp-lines { padding: 8px 0 10px; min-width: max-content; font: 400 12.5px/20px var(--font, "Geist", "GeistSans", system-ui, sans-serif); font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0; font-variant-numeric: tabular-nums; color: var(--gh-fg); }
.lp-l { display: flex; min-height: 20px; position: relative; }
.lp-n { flex: none; width: 56px; padding-right: 14px; text-align: right; color: var(--gh-ln); font-size: 12px; }
.lp-c { white-space: pre; tab-size: 4; padding: 0 28px 0 4px; }
.lp-i { display: inline-block; width: calc(var(--w) * 0.53em); }
/* a read keeps its drag selection; .hl only names the range (the address carries #L) */
.lp-l.sel .lp-c { background: var(--gh-sel); }
.lp-l.del { background: var(--gh-del); }
.lp-l.del .lp-n { background: var(--gh-del-n); color: var(--gh-fg); }
.lp-l.typing, .lp-l.edited { background: var(--gh-add); }
.lp-l.typing .lp-n, .lp-l.edited .lp-n { background: var(--gh-add-n); color: var(--gh-fg); }
.lp-l.sealed { background: repeating-linear-gradient(135deg, var(--gh-seal) 0 6px, transparent 6px 12px); }
.lp-l.sealed .lp-c { color: var(--gh-muted); }
.lp-caret { display: inline-block; width: 1.5px; height: 1.15em; margin-left: 1px; vertical-align: -0.2em; background: var(--gh-caret); animation: cr-blink 1.06s steps(1) infinite; }
.lp-seal { position: absolute; right: 12px; top: 1px; display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: var(--gh-muted);
  background: var(--gh-bg); border: 1px solid var(--gh-line); white-space: nowrap; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
.lp-seal svg { width: 11px; height: 11px; }

.gh-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 13px; flex-wrap: wrap; }
.gh-bar .gh-btn b { font-weight: 600; }
.gh-av { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #fff; background: linear-gradient(140deg, #6a8caf, #3f6185); flex: none; }
.gh-row { appearance: none; width: 100%; border: 0; border-top: 1px solid var(--gh-line); background: var(--gh-bg); color: var(--gh-fg); font: inherit; font-size: 13.5px; display: flex; align-items: center; gap: 10px; padding: 8px 14px; text-align: left; cursor: default; min-width: 0; }
.gh-box .gh-bh + .gh-row { border-top: 0; }
.gh-row svg { width: 16px; height: 16px; color: var(--gh-muted); flex: none; }
.gh-row .p { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-row .c { color: var(--gh-muted); font-size: 12.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.gh-row:hover { background: var(--gh-soft); }
.gh-about { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 16px; margin: 16px 2px 0; font-size: 13px; }
.gh-about dt { color: var(--gh-muted); font-size: 12px; }
.gh-about dd { margin: 2px 0 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.gh-about a, .gh-box a { color: var(--gh-link); text-decoration: none; }
.gh-sr { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 15px; margin: 2px 0 10px; }
.gh-sub { font-size: 12.5px; margin: 0 0 8px; }
.gh-hit { margin-bottom: 12px; }
.gh-hit .gh-bh { min-height: 36px; font-size: 13px; }
.gh-hit .gh-bh b { font-weight: 600; color: var(--gh-link); }

.sb { padding: 18px 18px 24px; }
.sb-h { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; font-size: 14px; }
.sb-h .dim { font-size: 12.5px; margin-top: 1px; }
.sb-ic { width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; background: var(--gh-bg); border: 1px solid var(--gh-line); color: var(--gh-muted); }
.sb-term { border-radius: 8px; background: #16181d; color: #d7dae0; padding: 12px 14px; display: grid; gap: 4px; font: 400 12.5px/1.6 var(--font, "Geist", system-ui, sans-serif); font-variant-numeric: tabular-nums; }
.sb-l { display: flex; align-items: center; gap: 10px; }
.sb-l[data-s="wait"] { color: #6c7280; }
.sb-i { width: 14px; height: 14px; display: grid; place-items: center; color: #7ee2a8; }
.sb-i svg { width: 14px; height: 14px; }
.sb-spin { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid #d7dae0; border-right-color: transparent; animation: cr-spin .8s steps(8) infinite; }
.sb-p { min-width: 92px; }
.sb-t { color: #8b91a0; }
.sb-res { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding-top: 8px; border-top: 1px solid #2a2d35; }
.sb-res svg { width: 14px; height: 14px; }
.sb-res.ok { color: #7ee2a8; }
.sb-res.bad { color: #ff8f86; }
.sb-out { margin: 4px 0 0; color: #a9aebb; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.sb-out.sealed { display: flex; align-items: center; gap: 8px; }
.sb-out.sealed svg { width: 14px; height: 14px; }

.pg-msg { min-height: 220px; display: grid; place-items: center; padding: 28px; text-align: center; color: var(--gh-muted); font-size: 13.5px; }
.pg-msg.sm { min-height: 120px; }
.pg-msg b { color: var(--gh-fg); }
.pg-new { min-height: 100%; }

/* ------------------------------------------------------------------------------- the deck */
.lp-deck { margin-top: 12px; display: grid; gap: 8px; min-width: 0; }
.lp-say { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 24px; }
.lp-state { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 11px; font-size: 11.5px; font-weight: 600; color: var(--dim); background: var(--panel-2); border: 1px solid var(--line-soft); white-space: nowrap; }
.lp-state i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.lp-state[data-s="live"] { color: var(--text); }
.lp-state[data-s="paused"] i { background: var(--warn, #d4a72c); }
.lp-idle .lp-idle-sub, .lp-facts .lp-idle-sub { margin-top: 6px; color: var(--gh-muted); font-size: 12.5px; }
.lp-facts .lp-idle-sub { margin-top: 14px; }
.lp-facts-links { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.lp-state[data-s="live"] i, .lp-livedot { background: #e5484d; animation: lp-pulse 1.6s ease-out infinite; }
.lp-livedot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; }
@keyframes lp-pulse { 0% { box-shadow: 0 0 0 0 rgba(229,72,77,.45); } 100% { box-shadow: 0 0 0 6px transparent; } }
.lp-say .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text); }
.lp-say .t b { font-weight: 600; }
.lp-say .t q { color: var(--dim); font-style: normal; }
.lp-say .tm { flex: none; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.lp-prog { position: relative; height: 3px; border-radius: 2px; background: var(--line-soft); cursor: pointer; }
.lp-prog::before { content: ""; position: absolute; inset: -6px 0; }
.lp-prog i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: var(--dim); transition: width .25s linear; }
.lp-prog[hidden] { display: none; }
.lp-ctlrow { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
.lp-banner { flex: 1 1 260px; min-width: 0; font-size: 12px; color: var(--dim); }
.lp-banner[hidden] { display: none; }
.lp-ctl { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
.lp-btn { appearance: none; font: inherit; font-size: 12px; font-weight: 550; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; height: 28px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.lp-btn svg { width: 12px; height: 12px; }
.lp-btn:hover { background: var(--panel-2); }
.lp-btn[disabled] { opacity: .45; cursor: default; }
.lp-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; height: 28px; }
.lp-seg button { appearance: none; font: inherit; font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--dim); background: var(--panel); border: 0; border-left: 1px solid var(--line-soft); padding: 0 7px; cursor: pointer; }
.lp-seg button:first-child { border-left: 0; }
.lp-seg button[aria-pressed="true"] { background: var(--panel-3, var(--panel-2)); color: var(--text); font-weight: 650; }
.lp :focus-visible { outline: 1.5px solid var(--lp-o); outline-offset: 1px; }

.lp-run { margin-top: 14px; border-top: 1px solid var(--line-soft); padding-top: 12px; display: grid; gap: 8px; }
.lp-run-h { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
.lp-run-h .aside { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 500; }
.lp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.lp-row .lbl { font-size: 12.5px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.lp-row .lbl span { color: var(--faint); font-weight: 500; }
.lp-ph { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.lp-ph span { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 11px; font-size: 11.5px; border: 1px solid var(--line-soft); color: var(--faint); background: var(--panel-2); font-variant-numeric: tabular-nums; }
.lp-ph span svg { width: 11px; height: 11px; }
.lp-ph span[data-s="done"] { color: var(--text); }
.lp-ph span[data-s="done"] svg { color: var(--good); }
.lp-ph span[data-s="on"] { color: var(--text); border-color: var(--line); }
.lp-ph span[data-s="on"] i { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); animation: cr-blink 1s steps(1) infinite; }
.lp-out-t { appearance: none; font: inherit; font-size: 12px; color: var(--accent-ink, var(--text)); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.lp-out { display: grid; gap: 6px; padding: 10px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line-soft); font-size: 12px; min-width: 0; }
.lp-out pre { margin: 0; font: 400 11.5px/1.55 var(--font); font-variant-numeric: tabular-nums; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dim); max-height: 180px; overflow: auto; }
.lp-out .st { display: flex; flex-wrap: wrap; gap: 4px 10px; font-weight: 600; }
.lp-out .st span { color: var(--faint); font-weight: 500; font-variant-numeric: tabular-nums; }
.lp-none { color: var(--faint); font-size: 12.5px; }
.lp-ok { color: var(--good); }
.lp-bad { color: var(--bad); }

.lp-list { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.lp-sess { appearance: none; font: inherit; font-size: 12px; color: var(--dim); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; font-variant-numeric: tabular-nums; }
.lp-sess[aria-current="true"] { border-color: var(--text); color: var(--text); font-weight: 600; }
.lp-sess i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.lp-sess i[data-s="live"] { background: #e5484d; }

@media (max-width: 760px) {
  .lp-ctl { margin-left: 0; width: 100%; }
  .lp-ctl .lp-seg, .lp-ctl .lp-none { margin-left: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .cr-spin, .sb-spin, .lp-caret, .cr-caret, .lp-state[data-s="live"] i, .lp-livedot, .lp-ph span[data-s="on"] i { animation: none; }
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
