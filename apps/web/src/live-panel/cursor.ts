// The panel's pointer: a system arrow or I-beam that moves on eased curves with a slight overshoot,
// in stepped frames (default 12 fps, like a screen recording at a low frame rate rather than a smooth
// 60 fps tween). Positions are in the window's own (unscaled) coordinates.

export type CursorKind = "arrow" | "ibeam";

// macOS-style arrow: black body, white outline; the tip is the hot spot (1, 1).
export const ARROW = `<svg class="cur-arrow" viewBox="0 0 17 24" width="17" height="24" aria-hidden="true"><path d="M1.5 1.5v18.2l4.4-4.3 2.9 6.6 2.9-1.3-2.8-6.4h6.2z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
// I-beam: thin black stroke with serifs and a white halo; the hot spot is its centre.
export const IBEAM = `<svg class="cur-ibeam" viewBox="0 0 11 20" width="11" height="20" aria-hidden="true"><path d="M2 1.5c1.8 0 2.8.5 3.5 1.4.7-.9 1.7-1.4 3.5-1.4M2 18.5c1.8 0 2.8-.5 3.5-1.4.7.9 1.7 1.4 3.5 1.4M5.5 2.9v14.2M3.6 10h3.8" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M2 1.5c1.8 0 2.8.5 3.5 1.4.7-.9 1.7-1.4 3.5-1.4M2 18.5c1.8 0 2.8-.5 3.5-1.4.7.9 1.7 1.4 3.5 1.4M5.5 2.9v14.2M3.6 10h3.8" fill="none" stroke="#111" stroke-width="1.2" stroke-linecap="round"/></svg>`;

export interface Pt {
  x: number;
  y: number;
}

/** Ease out with a small overshoot past 1 that settles back (back easing, s = 1.2). */
export function easeOutBack(t: number, s = 1.2): number {
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

/** A point on the quadratic curve from a to b, bowed sideways by `bow` (fraction of the distance). */
export function curvePoint(a: Pt, b: Pt, t: number, bow: number): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const c = { x: (a.x + b.x) / 2 - dy * bow, y: (a.y + b.y) / 2 + dx * bow };
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/** Frames of a move from a to b: eased progress along a bowed curve, sampled at fps. */
export function movePath(a: Pt, b: Pt, ms: number, fps: number, bow: number): Pt[] {
  const n = Math.max(1, Math.round((ms / 1000) * fps));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const e = easeOutBack(i / n);
    // the curve parameter stays in [0, 1]; the overshoot continues along the final direction
    const p = curvePoint(a, b, Math.min(1, e), bow);
    if (e > 1) {
      const q = curvePoint(a, b, 0.98, bow);
      const len = Math.hypot(b.x - q.x, b.y - q.y) || 1;
      const over = (e - 1) * Math.hypot(b.x - a.x, b.y - a.y);
      p.x = b.x + ((b.x - q.x) / len) * over;
      p.y = b.y + ((b.y - q.y) / len) * over;
    }
    out.push(p);
  }
  out[out.length - 1] = { ...b };
  return out;
}

/** Duration of a move: longer for longer distances, like a hand (Fitts-like), in ms at 1x. */
export function moveMs(a: Pt, b: Pt): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return Math.max(260, Math.min(820, 220 + 90 * Math.log2(1 + d / 12)));
}

/**
 * Human typing rhythm: how many characters each frame adds. Frames are about 1000/fps ms; short
 * text types a character or two per frame with pauses after punctuation and line ends, long text
 * speeds up so a whole edit stays under about `capMs` at 1x.
 */
export function typingChunks(text: string, fps: number, capMs = 2600, seed = 7): number[] {
  const frameMs = 1000 / fps;
  const maxFrames = Math.max(1, Math.floor(capMs / frameMs));
  // about 11 characters a second for a person; faster when the text would not fit the cap
  const natural = Math.max(1, (text.length / 11) * fps);
  const perFrame = Math.max(1, text.length / Math.min(maxFrames, natural));
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    let n = Math.max(1, Math.round(perFrame * (0.55 + rnd() * 0.9)));
    n = Math.min(n, text.length - i);
    const chunk = text.slice(i, i + n);
    out.push(n);
    i += n;
    // a beat after a line end or punctuation, while the hands move on
    if (perFrame < 6 && /[\n.;:,)]$/.test(chunk) && rnd() < 0.6) out.push(0);
  }
  return out;
}
