import { describe, expect, test } from "bun:test";
import { BLOCK, liveFilter, SCREEN, sealedRects, type Rect } from "../src/layout.ts";

// The live stream's redaction on real pixels: a busy test pattern (high-frequency detail everywhere,
// like text) goes through the exact filter graph with the ffmpeg of the lineage/desktop image. Inside
// the sealed rectangles every block must be flat (one value: nothing of the detail survives);
// outside them the frame must be unchanged. Skipped when Docker or the image is missing.

const IMAGE = "lineage/desktop";
const have = Bun.spawnSync(["docker", "image", "inspect", IMAGE], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

function gray(filter: string | null): Uint8Array {
  const vf = filter ? ["-filter_complex", filter.replace("[0:v]", "[0:v]format=yuv420p,"), "-map", "[v]"] : ["-vf", "format=yuv420p"];
  const p = Bun.spawnSync([
    "docker", "run", "--rm", "--network", "none", "--entrypoint", "ffmpeg", IMAGE,
    "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${SCREEN.w}x${SCREEN.h}:rate=1,noise=alls=100:allf=t`, "-frames:v", "1",
    ...vf, "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return new Uint8Array(p.stdout);
}

const at = (f: Uint8Array, x: number, y: number) => f[y * SCREEN.w + x]!;
const inRects = (rs: Rect[], x: number, y: number) => rs.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

describe.skipIf(!have)("redaction on real frames", () => {
  test("sealed rectangles become flat blocks; the rest of the frame is untouched", () => {
    const rects = sealedRects();
    // deterministic noise needs the same seed in both runs: compare against an unfiltered frame of the same source
    const src = gray(null);
    const out = gray(liveFilter(rects));
    expect(out.length).toBe(SCREEN.w * SCREEN.h);
    for (const r of rects) {
      // flat blocks: along any row of the rectangle the value may change only at block edges (at most
      // one change per block, plus one at each edge for chroma), and likewise down any column; the
      // source changes at nearly every pixel
      const nx = Math.max(1, Math.floor(r.w / BLOCK));
      const ny = Math.max(1, Math.floor(r.h / BLOCK));
      for (let y = r.y; y < r.y + r.h; y++) {
        let changes = 0;
        for (let x = r.x + 1; x < r.x + r.w; x++) if (Math.abs(at(out, x, y) - at(out, x - 1, y)) > 2) changes++;
        expect(changes).toBeLessThanOrEqual(2 * nx + 2);
      }
      for (let x = r.x; x < r.x + r.w; x++) {
        let changes = 0;
        for (let y = r.y + 1; y < r.y + r.h; y++) if (Math.abs(at(out, x, y) - at(out, x, y - 1)) > 2) changes++;
        expect(changes).toBeLessThanOrEqual(2 * ny + 2);
      }
      let srcChanges = 0;
      for (let x = r.x + 1; x < r.x + r.w; x++) if (Math.abs(at(src, x, r.y + 10) - at(src, x - 1, r.y + 10)) > 2) srcChanges++;
      expect(srcChanges).toBeGreaterThan(r.w / 2);
      // and the source had detail there (the test would prove nothing on a flat source)
      let smin = 255, smax = 0;
      for (let x = r.x + 2; x < r.x + 30; x++) {
        const v = at(src, x, r.y + 10);
        smin = Math.min(smin, v);
        smax = Math.max(smax, v);
      }
      expect(smax - smin).toBeGreaterThan(40);
    }
    // outside: identical, sampled (a pixel next to a rectangle may differ through chroma; keep 2 px off)
    let diffs = 0, n = 0;
    for (let y = 0; y < SCREEN.h; y += 7)
      for (let x = 0; x < SCREEN.w; x += 5) {
        if (inRects(rects.map((r) => ({ x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 })), x, y)) continue;
        n++;
        if (Math.abs(at(src, x, y) - at(out, x, y)) > 1) diffs++;
      }
    expect(n).toBeGreaterThan(5000);
    expect(diffs).toBe(0);
  }, 60_000);
});
