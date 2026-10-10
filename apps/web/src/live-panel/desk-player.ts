// Live desktop stream player (SPEC 17.7): plays an agent desktop's HLS stream (fMP4 segments, served
// through the gate at /desktops/<session>/live.m3u8) in a <video>. Safari plays HLS natively; elsewhere
// a small Media Source player reads the playlist, appends the init segment and each new segment, and
// keeps near the live edge. No library: the stream has one rendition and one codec.
//
// The stream it plays is already redacted on the server (the editor's text area and the run terminal
// are pixelated for its whole life); nothing here decides what is visible.

/** Codec of the live stream (packages/desktop/src/layout.ts LIVE_CODEC). */
export const DESK_CODEC = 'video/mp4; codecs="avc1.42e020"';

export interface DeskPlayer {
  stop(): void;
}

/** Plays `base` + "live.m3u8"; calls onGone when the stream is not there (ended or never started). */
export function playDesktop(video: HTMLVideoElement, base: string, onGone: (why: string) => void, onPlaying?: () => void): DeskPlayer {
  let dead = false;
  let misses = 0;
  const stopAll: (() => void)[] = [];
  const stop = () => {
    dead = true;
    for (const f of stopAll) f();
  };
  video.muted = true;
  video.playsInline = true;
  video.addEventListener("playing", () => onPlaying?.(), { once: true });

  const playlist = async (): Promise<{ init: string | null; segs: string[] } | null> => {
    const r = await fetch(`${base}live.m3u8`, { cache: "no-store" }).catch(() => null);
    if (!r || !r.ok) {
      if (++misses >= 4) {
        stop();
        onGone(r ? `stream ${r.status}` : "stream unreachable");
      }
      return null;
    }
    misses = 0;
    const text = await r.text();
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1] ?? null;
    const segs = text.split("\n").map((l) => l.trim()).filter((l) => /^seg-\d+\.m4s$/.test(l));
    return { init, segs };
  };

  const native = typeof video.canPlayType === "function" && video.canPlayType("application/vnd.apple.mpegurl") !== "";
  const MS: typeof MediaSource | undefined = (globalThis as any).ManagedMediaSource ?? (globalThis as any).MediaSource;
  if (native && !MS) {
    // Safari without Media Source: its own HLS player; poll the playlist only to notice the end
    video.src = `${base}live.m3u8`;
    void video.play().catch(() => undefined);
    const t = setInterval(() => void playlist(), 4000);
    stopAll.push(() => clearInterval(t), () => video.removeAttribute("src"));
    return { stop };
  }
  if (!MS || !MS.isTypeSupported(DESK_CODEC)) {
    onGone("this browser cannot play the stream");
    return { stop };
  }

  // one MediaSource per encoder run: a restarted encoder (after a geometry blackout) starts its
  // timestamps again, so a jump in segment numbers starts a fresh source
  let ms: MediaSource;
  let sb: SourceBuffer | null = null;
  let last = -1;
  let url = "";
  const fresh = () =>
    new Promise<void>((res) => {
      if (url) URL.revokeObjectURL(url);
      ms = new MS();
      sb = null;
      last = -1;
      url = URL.createObjectURL(ms);
      video.src = url;
      ms.addEventListener("sourceopen", () => {
        sb = ms.addSourceBuffer(DESK_CODEC);
        sb.mode = "segments";
        res();
      }, { once: true });
      void video.play().catch(() => undefined);
    });
  const append = (bytes: ArrayBuffer) =>
    new Promise<void>((res, rej) => {
      if (!sb) return rej(new Error("no source buffer"));
      sb.addEventListener("updateend", () => res(), { once: true });
      sb.addEventListener("error", () => rej(new Error("append failed")), { once: true });
      sb.appendBuffer(bytes);
    });
  const get = async (name: string) => {
    const r = await fetch(`${base}${name}`);
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    return r.arrayBuffer();
  };

  const tick = async () => {
    if (dead) return;
    const p = await playlist();
    if (!p || dead || !p.init || !p.segs.length) return;
    const nums = p.segs.map((s) => Number(/\d+/.exec(s)![0]));
    const first = nums[0]!;
    if (last >= 0 && (first > last + 1 || nums.at(-1)! < last)) await fresh();
    if (!sb) return;
    try {
      if (last < 0) {
        await append(await get(p.init));
        // start near the live edge: the last two segments
        last = (nums.at(-3) ?? first - 1);
      }
      for (let i = 0; i < nums.length; i++) {
        if (nums[i]! <= last) continue;
        await append(await get(p.segs[i]!));
        last = nums[i]!;
      }
      const b = video.buffered;
      if (b.length) {
        const end = b.end(b.length - 1);
        if (end - video.currentTime > 6) video.currentTime = Math.max(b.start(b.length - 1), end - 1.5);
        if (video.currentTime - b.start(0) > 40 && !sb.updating) sb.remove(b.start(0), video.currentTime - 20);
      }
      if (video.paused) void video.play().catch(() => undefined);
    } catch {
      /* a segment that rolled out of the playlist; the next tick catches up */
    }
  };
  let busy = false;
  const loop = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick().finally(() => (busy = false));
  }, 1000);
  stopAll.push(() => clearInterval(loop), () => {
    video.removeAttribute("src");
    if (url) URL.revokeObjectURL(url);
  });
  void fresh().then(() => tick());
  return { stop };
}
