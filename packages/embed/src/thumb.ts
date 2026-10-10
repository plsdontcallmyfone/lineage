import type { SessionView, SessionEvent } from "./client.ts";
import { describeEvent, repoLabel } from "./render.ts";

// A card's screen: a small still of facts from the agent's session, drawn on a canvas from the
// session's public events and the file at the session's parent generation: a header line naming the
// repository and the file and lines it last read or edited, then those real lines (edited lines tinted,
// sealed ranges hatched with no text). No drawn browser, address bar or pointer: the still is labelled
// for what it is, not dressed as a screenshot. look=dither draws it a second time through an ordered
// (Bayer 4x4) dither in the host's colors; hovering develops it to the clean frame.

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
  /** what the lines are: "<file>, lines a to b, last read" (or edited) */
  label?: string;
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
  if (!ev) return base;
  const start = Math.max(1, ev.start_line ?? 1);
  const end = Math.max(start, ev.end_line ?? start);
  base.label = `${ev.path}, ${end > start ? `lines ${start} to ${end}` : `line ${start}`}, ${ev.kind === "read" ? "last read" : "last edited"}`;
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

// the still's own colors, light and dark
const INK = {
  light: { bar: "#eceae5", page: "#ffffff", text: "#1f2328", dim: "#5f6368", ln: "#8c959f", line: "#d1d9e0", sel: "rgba(0,110,255,.18)", add: "#dafbe1", seal: "rgba(89,99,110,.16)" },
  dark: { bar: "#1d1e21", page: "#0d1117", text: "#f0f6fc", dim: "#9aa0a6", ln: "#656c76", line: "#3d444d", sel: "rgba(56,139,253,.30)", add: "rgba(46,160,67,.25)", seal: "rgba(145,152,161,.16)" },
};

/**
 * Draws a still at w x h CSS pixels into ctx (already scaled to the device ratio by the caller): a
 * header line of facts (live dot, repository, the file and lines) over the lines the agent last read
 * or edited, as Core serves them.
 */
export function drawThumb(ctx: CanvasRenderingContext2D, m: ThumbModel, w: number, h: number, p: Palette, font: string) {
  const dark = 0.2126 * p.bg[0] + 0.7152 * p.bg[1] + 0.0722 * p.bg[2] < 128;
  const k = dark ? INK.dark : INK.light;
  ctx.textBaseline = "middle";
  ctx.fillStyle = k.page;
  ctx.fillRect(0, 0, w, h);
  // the header: a live dot when the session is live, the repository, what the lines are
  const top = 20;
  ctx.fillStyle = k.bar;
  ctx.fillRect(0, 0, w, top);
  ctx.fillStyle = k.line;
  ctx.fillRect(0, top - 0.6, w, 0.6);
  let x = 8;
  if (m.live) {
    ctx.beginPath();
    ctx.arc(x + 3, top / 2, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#e5484d";
    ctx.fill();
    x += 11;
  }
  ctx.font = `600 8px ${font}`;
  ctx.fillStyle = k.text;
  const hs = clip(ctx, m.live ? `Live: ${m.repo}` : m.repo, Math.max(40, w * 0.45));
  ctx.fillText(hs, x, top / 2 + 0.5);
  if (m.label) {
    const hw = ctx.measureText(hs).width;
    ctx.font = `400 8px ${font}`;
    ctx.fillStyle = k.dim;
    ctx.fillText(clip(ctx, m.label, w - x - hw - 16), x + hw + 8, top / 2 + 0.5);
  }
  if (!m.lines.length) {
    const mid = top + (h - top) / 2;
    ctx.textAlign = "center";
    if (m.title) {
      ctx.font = `800 ${Math.round(h / 5.5)}px ${font}`;
      ctx.fillStyle = k.text;
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
      for (let sx = -lh; sx < w; sx += 6) {
        ctx.beginPath();
        ctx.moveTo(sx, y + lh);
        ctx.lineTo(sx + lh, y);
        ctx.stroke();
      }
      ctx.restore();
    } else if (l.mark === "hl") {
      ctx.fillStyle = k.sel;
      ctx.fillRect(0, y, w, lh);
    }
    ctx.fillStyle = k.ln;
    ctx.textAlign = "right";
    ctx.fillText(String(l.n), gut - 5, y + lh / 2 + 0.5);
    ctx.textAlign = "left";
    if (l.mark !== "sealed") {
      ctx.fillStyle = k.text;
      ctx.fillText(text, gut + 3 + ind * 2.6, y + lh / 2 + 0.5);
    }
  });
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
