import type { SessionView, SessionEvent } from "./client.ts";
import { describeEvent, repoLabel } from "./render.ts";
import { addressOf } from "../../../apps/web/src/live-panel/chrome.ts";

// A card's screen: a small still of what the agent's session shows at its latest step (the live
// panel's browser window on the file and lines it last read or edited, the pointer on them), drawn
// on a canvas from the session's public events and the file at the session's parent generation. look=dither draws it a second time through
// an ordered (Bayer 4x4) dither in the host's colors; hovering develops it to the clean frame.

export interface ThumbLine {
  n: number;
  text: string;
  mark: "" | "hl" | "edit" | "sealed";
}
export interface ThumbModel {
  repo: string;
  file: string | null;
  lines: ThumbLine[];
  /** index into lines of the cursor's line, or -1 */
  cursor: number;
  caption: string;
  live: boolean;
  /** drawn large on a screen with no file to show (the token's ticker) */
  title?: string;
  /** the address bar: where the agent is looking, as the live panel shows it */
  url?: string;
}

const FILE_KINDS = new Set(["read", "edit", "write", "patch"]);

/** The event a still shows: the latest one that points at a file. */
export function focusEvent(events: SessionEvent[]): SessionEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (FILE_KINDS.has(events[i]!.kind) && events[i]!.path) return events[i]!;
  return null;
}

export function thumbModel(s: Pick<SessionView, "repo" | "state" | "event_list"> & { commit?: string }, fileText: string | null, rows = 14): ThumbModel {
  const ev = focusEvent(s.event_list);
  const last = s.event_list.at(-1) ?? null;
  const base: ThumbModel = { repo: repoLabel(s.repo) || "repository", file: ev?.path ?? null, lines: [], cursor: -1, caption: describeEvent(last) || "Session opened", live: s.state === "live" };
  const place = ev ? { kind: "file" as const, path: ev.path!, start: ev.start_line, end: ev.end_line } : { kind: "home" as const };
  const a = addressOf(s.repo, s.commit ?? "", place);
  base.url = s.commit || ev ? `${a.host}${a.rest}` : undefined;
  if (!ev) return base;
  const start = Math.max(1, ev.start_line ?? 1);
  const end = Math.max(start, ev.end_line ?? start);
  const src = fileText === null ? [] : fileText.replace(/\n$/, "").split("\n");
  const from = Math.max(1, Math.min(start - 3, Math.max(1, src.length - rows + 1)));
  const mark: ThumbLine["mark"] = ev.kind === "read" ? "hl" : ev.after === undefined ? "sealed" : "edit";
  for (let n = from; n < from + rows; n++) {
    if (n > src.length && n > end) break;
    base.lines.push({ n, text: src[n - 1] ?? "", mark: n >= start && n <= end ? mark : "" });
  }
  base.cursor = base.lines.findIndex((l) => l.n === start);
  return base;
}

export interface Palette {
  bg: [number, number, number];
  fg: [number, number, number];
  muted: [number, number, number];
  accent: [number, number, number];
  panel: [number, number, number];
}

const css = (c: [number, number, number], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// the browser window's own colors (the live panel's .cr palette), light and dark
const CHROME = {
  light: { frame: "#dee3ea", tool: "#ffffff", omni: "#edf2fa", ico: "#474747", text: "#1f1f1f", dim: "#5f6368", page: "#ffffff", fg: "#1f2328", ln: "#8c959f", line: "#d1d9e0", sel: "rgba(0,110,255,.24)", add: "#dafbe1", seal: "rgba(89,99,110,.16)" },
  dark: { frame: "#1f2023", tool: "#35363a", omni: "#202124", ico: "#c4c7c5", text: "#e8eaed", dim: "#9aa0a6", page: "#0d1117", fg: "#f0f6fc", ln: "#656c76", line: "#3d444d", sel: "rgba(56,139,253,.38)", add: "rgba(46,160,67,.25)", seal: "rgba(145,152,161,.16)" },
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]) {
  const [a, b, c, d] = typeof r === "number" ? [r, r, r, r] : r;
  ctx.beginPath();
  ctx.moveTo(x + a, y);
  ctx.lineTo(x + w - b, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + b);
  ctx.lineTo(x + w, y + h - c);
  ctx.quadraticCurveTo(x + w, y + h, x + w - c, y + h);
  ctx.lineTo(x + d, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - d);
  ctx.lineTo(x, y + a);
  ctx.quadraticCurveTo(x, y, x + a, y);
  ctx.closePath();
}

/**
 * Draws a still at w x h CSS pixels into ctx (already scaled to the device ratio by the caller): a
 * small browser window like the live panel's (tab, address bar, the code host's file view) with the
 * lines the agent last read or edited selected and the system pointer on them.
 */
export function drawThumb(ctx: CanvasRenderingContext2D, m: ThumbModel, w: number, h: number, p: Palette, font: string) {
  const dark = 0.2126 * p.bg[0] + 0.7152 * p.bg[1] + 0.0722 * p.bg[2] < 128;
  const k = dark ? CHROME.dark : CHROME.light;
  const ui = `-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = "middle";
  // tab strip, with the window controls and one tab
  ctx.fillStyle = k.frame;
  ctx.fillRect(0, 0, w, h);
  const strip = 20;
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(9 + i * 7.5, strip / 2 + 0.5, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  const tx = 34;
  const tw = Math.min(150, Math.max(70, w * 0.5));
  ctx.fillStyle = k.tool;
  roundRect(ctx, tx, 4, tw, strip - 4 + 1, [5, 5, 0, 0]);
  ctx.fill();
  ctx.fillStyle = k.text;
  roundRect(ctx, tx + 7, strip / 2 - 1.5, 7, 7, 1.6);
  ctx.fill();
  ctx.font = `500 8px ${ui}`;
  ctx.fillStyle = k.text;
  const tab = m.file ? (m.file.split("/").pop() ?? m.file) : m.repo || "New Tab";
  ctx.fillText(clip(ctx, tab, tw - 30), tx + 18, strip / 2 + 2.5);
  // toolbar: back, reload, the address
  const tb = 19;
  ctx.fillStyle = k.tool;
  ctx.fillRect(0, strip, w, tb);
  ctx.strokeStyle = k.ico;
  ctx.lineWidth = 1;
  const cy = strip + tb / 2;
  ctx.beginPath();
  ctx.moveTo(13, cy);
  ctx.lineTo(6.5, cy);
  ctx.moveTo(9.5, cy - 3);
  ctx.lineTo(6.5, cy);
  ctx.lineTo(9.5, cy + 3);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(22, cy, 3, -0.4, Math.PI * 1.55);
  ctx.stroke();
  const ox = 31;
  const ow = w - ox - 20;
  ctx.fillStyle = k.omni;
  roundRect(ctx, ox, strip + 3, ow, tb - 6, (tb - 6) / 2);
  ctx.fill();
  ctx.font = `400 7.5px ${ui}`;
  const url = m.url ?? m.repo;
  const host = url.split("/")[0] ?? "";
  const shown = clip(ctx, url, ow - 12);
  ctx.fillStyle = k.text;
  ctx.fillText(shown.slice(0, Math.min(host.length, shown.length)), ox + 6, cy + 0.5);
  if (shown.length > host.length) {
    const hw = ctx.measureText(host).width;
    ctx.fillStyle = k.dim;
    ctx.fillText(shown.slice(host.length), ox + 6 + hw, cy + 0.5);
  }
  ctx.beginPath();
  ctx.arc(w - 10, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#4f7299";
  ctx.fill();
  // the page
  const top = strip + tb;
  ctx.fillStyle = k.page;
  ctx.fillRect(0, top, w, h - top);
  ctx.fillStyle = k.line;
  ctx.fillRect(0, top, w, 0.6);
  if (!m.lines.length) {
    const mid = top + (h - top) / 2;
    ctx.textAlign = "center";
    if (m.title) {
      ctx.font = `800 ${Math.round(h / 5.5)}px ${font}`;
      ctx.fillStyle = k.fg;
      ctx.fillText(clip(ctx, m.title, w - 24), w / 2, mid - 8);
    }
    ctx.font = `500 10px ${font}`;
    ctx.fillStyle = k.dim;
    ctx.fillText(clip(ctx, m.caption, w - 24), w / 2, m.title ? mid + h / 8 : mid);
    ctx.textAlign = "left";
    return;
  }
  const lh = Math.max(9, Math.floor((h - top - 6) / m.lines.length));
  ctx.font = `400 ${Math.min(9, lh - 1)}px ${font}`;
  const gut = 24;
  m.lines.forEach((l, i) => {
    const y = top + 3 + i * lh;
    const ind = /^[ \t]*/.exec(l.text)![0].replace(/\t/g, "    ").length;
    const text = clip(ctx, l.text.trimStart(), w - gut - 8 - ind * 2.6);
    if (l.mark === "edit") {
      ctx.fillStyle = k.add;
      ctx.fillRect(0, y, w, lh);
    } else if (l.mark === "sealed") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, w, lh);
      ctx.clip();
      ctx.strokeStyle = k.seal;
      ctx.lineWidth = 2;
      for (let x = -lh; x < w; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, y + lh);
        ctx.lineTo(x + lh, y);
        ctx.stroke();
      }
      ctx.restore();
    } else if (l.mark === "hl") {
      // the drag selection covers the text of each line
      ctx.fillStyle = k.sel;
      ctx.fillRect(gut + 2 + ind * 2.6, y, Math.max(6, ctx.measureText(text).width + 3), lh);
    }
    ctx.fillStyle = k.ln;
    ctx.textAlign = "right";
    ctx.fillText(String(l.n), gut - 5, y + lh / 2 + 0.5);
    ctx.textAlign = "left";
    if (l.mark !== "sealed") {
      ctx.fillStyle = k.fg;
      ctx.fillText(text, gut + 3 + ind * 2.6, y + lh / 2 + 0.5);
    }
  });
  if (m.cursor >= 0) {
    // the system arrow: black with a white edge
    const ln = m.lines[m.cursor]!;
    const y = top + 3 + m.cursor * lh + lh * 0.55;
    const x = Math.min(w - 30, gut + 6 + Math.max(10, ctx.measureText(ln.text.trim().slice(0, 18)).width));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 12);
    ctx.lineTo(x + 2.9, y + 9.2);
    ctx.lineTo(x + 4.8, y + 13.4);
    ctx.lineTo(x + 6.6, y + 12.6);
    ctx.lineTo(x + 4.8, y + 8.5);
    ctx.lineTo(x + 8.8, y + 8.5);
    ctx.closePath();
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function clip(ctx: CanvasRenderingContext2D, s: string, max: number) {
  if (max <= 0) return "";
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + "...").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + "...";
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/**
 * Ordered dither of RGBA pixels into the palette: each pixel becomes the background, or its nearest
 * ink (foreground or accent) when its contrast against the background beats the Bayer threshold.
 */
export function dither(px: Uint8ClampedArray, w: number, h: number, p: Palette) {
  const [br, bgc, bb] = p.bg;
  const span = Math.max(40, Math.hypot(p.fg[0] - br, p.fg[1] - bgc, p.fg[2] - bb));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
      const d = Math.min(1, Math.hypot(r - br, g - bgc, b - bb) / span);
      const da = Math.hypot(r - p.accent[0], g - p.accent[1], b - p.accent[2]);
      const df = Math.hypot(r - p.fg[0], g - p.fg[1], b - p.fg[2]);
      const ink = da < df ? p.accent : p.fg;
      // a contrast curve: faint fills (highlight bands, hatching) thin out, text and strokes stay solid
      const on = Math.pow(d, 1.6) * 1.2 > BAYER[(y & 3) * 4 + (x & 3)]!;
      const c = on ? ink : p.bg;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
}
