import type { SessionView, SessionEvent } from "./client.ts";
import { describeEvent, repoLabel } from "./render.ts";

// A card's screen: a small still of what the agent's session shows at its latest step (the file and
// lines it last read or edited, the cursor on them), drawn on a canvas from the session's public
// events and the file at the session's parent generation. look=dither draws it a second time through
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
}

const FILE_KINDS = new Set(["read", "edit", "write", "patch"]);

/** The event a still shows: the latest one that points at a file. */
export function focusEvent(events: SessionEvent[]): SessionEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (FILE_KINDS.has(events[i]!.kind) && events[i]!.path) return events[i]!;
  return null;
}

export function thumbModel(s: Pick<SessionView, "repo" | "state" | "event_list">, fileText: string | null, rows = 14): ThumbModel {
  const ev = focusEvent(s.event_list);
  const last = s.event_list.at(-1) ?? null;
  const base: ThumbModel = { repo: repoLabel(s.repo) || "repository", file: ev?.path ?? null, lines: [], cursor: -1, caption: describeEvent(last) || "Session opened", live: s.state === "live" };
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

/** Draws a still at w x h CSS pixels into ctx (already scaled to the device ratio by the caller). */
export function drawThumb(ctx: CanvasRenderingContext2D, m: ThumbModel, w: number, h: number, p: Palette, font: string) {
  ctx.fillStyle = css(p.bg);
  ctx.fillRect(0, 0, w, h);
  // tab strip
  const top = 22;
  ctx.fillStyle = css(p.panel);
  ctx.fillRect(0, 0, w, top);
  ctx.font = `600 10px ${font}`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = css(p.accent);
  ctx.fillRect(8, 9, 5, 5);
  ctx.fillStyle = css(p.fg);
  const tab = m.file ? `${m.repo.split("/").pop()} / ${m.file.split("/").pop()}` : m.repo;
  ctx.fillText(clip(ctx, tab, w - 30), 19, top / 2 + 0.5);
  ctx.fillStyle = css(p.accent);
  ctx.fillRect(14, top - 2, Math.min(w - 28, ctx.measureText(tab).width + 10), 2);
  if (!m.lines.length) {
    const mid = top + (h - top) / 2;
    ctx.textAlign = "center";
    if (m.title) {
      ctx.font = `800 ${Math.round(h / 5)}px ${font}`;
      ctx.fillStyle = css(p.fg, 0.9);
      ctx.fillText(clip(ctx, m.title, w - 24), w / 2, mid - 8);
    }
    ctx.font = `500 11px ${font}`;
    ctx.fillStyle = css(p.muted);
    ctx.fillText(clip(ctx, m.caption, w - 24), w / 2, m.title ? mid + h / 7 : mid);
    ctx.textAlign = "left";
    return;
  }
  const lh = Math.max(10, Math.floor((h - top - 8) / m.lines.length));
  ctx.font = `400 ${Math.min(10, lh - 1)}px ${font}`;
  const gut = 26;
  m.lines.forEach((l, i) => {
    const y = top + 4 + i * lh;
    if (l.mark) {
      ctx.fillStyle = css(p.accent, l.mark === "hl" ? 0.16 : 0.24);
      ctx.fillRect(0, y, w, lh);
      ctx.fillStyle = css(p.accent);
      ctx.fillRect(0, y, 2, lh);
      if (l.mark === "sealed") {
        ctx.save();
        ctx.beginPath();
        ctx.rect(gut, y, w - gut, lh);
        ctx.clip();
        ctx.strokeStyle = css(p.accent, 0.5);
        ctx.lineWidth = 1;
        for (let x = gut - lh; x < w; x += 6) {
          ctx.beginPath();
          ctx.moveTo(x, y + lh);
          ctx.lineTo(x + lh, y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    ctx.fillStyle = css(l.mark ? p.accent : p.muted);
    ctx.textAlign = "right";
    ctx.fillText(String(l.n), gut - 6, y + lh / 2 + 0.5);
    ctx.textAlign = "left";
    if (l.mark !== "sealed") {
      const ind = /^[ \t]*/.exec(l.text)![0].replace(/\t/g, "    ").length;
      ctx.fillStyle = css(p.fg, l.mark ? 1 : 0.82);
      ctx.fillText(clip(ctx, l.text.trimStart(), w - gut - 8 - ind * 3), gut + ind * 3, y + lh / 2 + 0.5);
    }
  });
  if (m.cursor >= 0) {
    const y = top + 4 + m.cursor * lh + 2;
    const x = Math.min(w - 40, gut + 4 + Math.max(10, ctx.measureText(m.lines[m.cursor]!.text.trim().slice(0, 18)).width));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 11, y + 6);
    ctx.lineTo(x + 5.5, y + 7.5);
    ctx.lineTo(x + 3, y + 12.5);
    ctx.closePath();
    ctx.fillStyle = css(p.accent);
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
      const on = d * 1.15 > BAYER[(y & 3) * 4 + (x & 3)]!;
      const c = on ? ink : p.bg;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
}
