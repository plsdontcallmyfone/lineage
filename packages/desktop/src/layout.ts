// The desktop's fixed layout and the live stream's redaction (docs/plans/AGENT-DESKTOPS.md, SPEC 17.7).
//
// 1280x800, four tiles that never move (images/desktop/rootfs/etc/lineage-desktop/rc.xml):
//
//   +------------------+------------------+
//   |                  |  browser         |  Chromium: the code host's page for what the agent reads
//   |  editor          |  640x400         |
//   |  640x800         +------------------+
//   |  (micro, read    |  term  640x200   |  navigation: ls, and searches over the parent generation
//   |   only)          +------------------+
//   |                  |  run   640x200   |  sandbox runs, results, searches over the edited tree
//   +------------------+------------------+
//
// While an attempt's edits are sealed (the whole of a live stream: the gate opens only after the
// verdict, SPEC 17.3) the stream pixelates the editor's text area (its line number gutter and status
// line stay readable) and the whole run tile. Redaction is by screen position inside one static ffmpeg
// filter, so nothing at run time can switch it off; what may go where is decided by the router in
// seal.ts, and a window outside its tile stops the stream (the geometry guard).

export const SCREEN = { w: 1280, h: 800 } as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Tile = "editor" | "browser" | "term" | "run";

export const TILES: Record<Tile, Rect> = {
  editor: { x: 0, y: 0, w: 640, h: 800 },
  browser: { x: 640, y: 0, w: 640, h: 400 },
  term: { x: 640, y: 400, w: 640, h: 200 },
  run: { x: 640, y: 600, w: 640, h: 200 },
};

/** X window class of each tile (desk-session). */
export const CLASSES: Record<Tile, string> = {
  editor: "LineageEditor",
  browser: "LineageBrowser",
  term: "LineageTerm",
  run: "LineageRun",
};

/**
 * Character cell of the tiles' xterm (DejaVu Sans Mono 10 at Xvfb's default resolution), measured
 * from frames of the running image (2026-10-10: 8x17 px, text at x = 4 + 8 * gutter cells).
 */
export const CELL = { w: 8, h: 17 } as const;
/** xterm's inner border (-b 4). */
export const XTERM_BORDER = 4;
/**
 * micro's line number gutter is as wide as the file's line count has digits, plus a space. The
 * redaction starts after the narrowest gutter (one digit and its space), so no file's text is ever
 * left of it; a longer file's line numbers are pixelated past their first digit (the cursor line
 * stays in the status line, and the browser tile shows the same lines numbered).
 */
export const GUTTER_CELLS = 2;
/** Rows of text above micro's status line in the 800 px editor tile (46 rows: 44 text, status, messages). */
export const TEXT_ROWS = 44;

/** Side of a pixelation block, px. Larger than two text lines, so no glyph or line survives. */
export const BLOCK = 32;

/** The rectangles the live stream pixelates while edits are sealed. */
export function sealedRects(): Rect[] {
  const e = TILES.editor;
  const gx = XTERM_BORDER + GUTTER_CELLS * CELL.w;
  return [
    { x: e.x + gx, y: e.y, w: e.w - gx, h: XTERM_BORDER + TEXT_ROWS * CELL.h },
    { ...TILES.run },
  ].map(evenRect);
}

/** yuv420p needs even offsets and sizes; widen outward by at most a pixel so nothing is uncovered. */
function evenRect(r: Rect): Rect {
  const x = r.x - (r.x % 2);
  const y = r.y - (r.y % 2);
  const w = r.w + (r.x - x);
  const h = r.h + (r.y - y);
  return { x, y, w: w + (w % 2), h: h + (h % 2) };
}

/** The ffmpeg filter graph of the live stream: input [0:v], output [v]. */
export function liveFilter(rects: Rect[] = sealedRects(), block = BLOCK): string {
  const n = rects.length;
  const parts: string[] = [`[0:v]split=${n + 1}[b0]${rects.map((_, i) => `[s${i}]`).join("")}`];
  rects.forEach((r, i) => {
    const bw = Math.max(1, Math.floor(r.w / block));
    const bh = Math.max(1, Math.floor(r.h / block));
    // area downscale = the mean of each block; neighbor upscale = flat blocks
    parts.push(`[s${i}]crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${bw}:${bh}:flags=area,scale=${r.w}:${r.h}:flags=neighbor[p${i}]`);
  });
  rects.forEach((r, i) => parts.push(`[b${i}][p${i}]overlay=${r.x}:${r.y}${i === n - 1 ? ",format=yuv420p[v]" : `[b${i + 1}]`}`));
  return parts.join(";");
}

/** H.264 profile and level of the live stream; the panel's player opens its source buffer with this codec string. */
export const LIVE_CODEC = "avc1.42e020"; // constrained baseline, level 3.2 (1280x800 needs more than 3.1)
export const LIVE_FPS = 5;
export const SEGMENT_S = 2;

/** ffmpeg argv for the live stream: x11grab, the redaction filter, fMP4 HLS into `dir`. */
export function liveArgs(dir: string, display = ":0"): string[] {
  return [
    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "x11grab", "-draw_mouse", "1", "-framerate", String(LIVE_FPS), "-video_size", `${SCREEN.w}x${SCREEN.h}`, "-i", `${display}.0`,
    "-filter_complex", liveFilter(), "-map", "[v]",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-level", "3.2",
    "-g", String(LIVE_FPS * SEGMENT_S), "-keyint_min", String(LIVE_FPS * SEGMENT_S), "-sc_threshold", "0",
    "-b:v", "500k", "-maxrate", "700k", "-bufsize", "1400k",
    "-f", "hls", "-hls_time", String(SEGMENT_S), "-hls_list_size", "8",
    "-hls_flags", "delete_segments+independent_segments+temp_file+discont_start", "-hls_start_number_source", "epoch",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", `${dir}/seg-%d.m4s`,
    `${dir}/live.m3u8`,
  ];
}

/** Largest recording kept (Core's blob store takes 32 MB). */
export const RECORDING_MAX_BYTES = 30_000_000;

/** ffmpeg argv for the full-quality recording (unredacted; published only once the gate opens). */
export function recordArgs(file: string, display = ":0"): string[] {
  return [
    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "x11grab", "-draw_mouse", "1", "-framerate", String(LIVE_FPS), "-video_size", `${SCREEN.w}x${SCREEN.h}`, "-i", `${display}.0`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-g", "50",
    "-movflags", "+faststart", "-fs", String(RECORDING_MAX_BYTES), "-y", file,
  ];
}

/** `r` lies inside `t`. */
export function inside(r: Rect, t: Rect): boolean {
  return r.x >= t.x && r.y >= t.y && r.x + r.w <= t.x + t.w && r.y + r.h <= t.y + t.h && r.w > 0 && r.h > 0;
}
