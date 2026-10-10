// Live desktop stream player (SPEC 17.7): plays an agent desktop's HLS stream (fMP4 segments, served
// through the gate at /desktops/<session>/live.m3u8) in a <video>. Safari plays HLS natively; elsewhere
// a small Media Source player reads the playlist, appends the init segment and each new segment, and
// keeps near the live edge. No library: the stream has one rendition and one codec.
//
// The stream it plays is already redacted on the server (the editor's text area and the run terminal
// are pixelated for its whole life); nothing here decides what is visible.
//
// It reports what is true about the stream, so the screen never sits black without saying why:
//   connecting  no frame decoded yet (or the desktop says it is still starting)
//   playing     frames are arriving and the video is moving
//   stalled     the last frame is on screen but no new segment arrived for STALL_MS
//   blocked     the browser refused to start playback on its own (a click starts it)
//   gone        the stream is not there, with the reason the desktop service or the browser gave

/** Codec of the live stream (packages/desktop/src/layout.ts LIVE_CODEC). */
export const DESK_CODEC = 'video/mp4; codecs="avc1.42e020"';

export type DeskStatus =
  | { kind: "connecting"; detail?: string }
  | { kind: "playing" }
  | { kind: "stalled"; since: number }
  | { kind: "blocked" }
  | { kind: "gone"; reason: string; code: string };

export interface DeskPlayer {
  stop(): void;
  /** starts playback after the browser blocked it (a user gesture) */
  resume(): void;
}

/** no new segment for this long while playing: the screen says the frames stopped */
const STALL_MS = 10_000;
/** the desktop service answers "starting" until the encoder wrote its first playlist */
const START_GRACE_MS = 60_000;
/** each request gives up after this long (a hung upstream must not freeze the loop) */
const FETCH_MS = 8_000;

/** Why a stream answer means no stream, in words, from the gate's or the desktop service's error body. */
export function goneReason(status: number, error: string | null): { reason: string; code: string } {
  if (error === "no_desktop") return { code: error, reason: "the desktop service has no desktop for this session" };
  if (error === "ended" || status === 410) return { code: "ended", reason: "the desktop ended" };
  if (error === "starting") return { code: error, reason: "the desktop has not published any video yet" };
  if (error === "upstream_unreachable" || status === 502 || status === 503 || status === 504) return { code: "upstream", reason: "the desktop host is unreachable" };
  if (error === "too_many_viewers") return { code: error, reason: "too many people are watching this desktop right now" };
  if (status === 429) return { code: "rate", reason: "the site is limiting stream requests" };
  if (status === 404) return { code: "not_found", reason: "the site has no stream for this session" };
  if (status === 0) return { code: "network", reason: "the stream could not be reached" };
  return { code: `http_${status}`, reason: `the stream answered HTTP ${status}` };
}

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response | null> {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const t = ac ? setTimeout(() => ac.abort(), FETCH_MS) : null;
  try {
    return await fetch(url, { ...init, signal: ac?.signal });
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Plays `base` + "live.m3u8" and reports its status as it changes. */
export function playDesktop(video: HTMLVideoElement, base: string, onStatus: (s: DeskStatus) => void): DeskPlayer {
  let dead = false;
  let misses = 0;
  let firstAsk = Date.now();
  let lastKind = "";
  const stopAll: (() => void)[] = [];
  const say = (s: DeskStatus) => {
    if (dead) return;
    const key = s.kind === "gone" ? `gone:${s.code}` : s.kind === "connecting" ? `connecting:${s.detail ?? ""}` : s.kind;
    if (key === lastKind) return;
    lastKind = key;
    onStatus(s);
  };
  const stop = () => {
    dead = true;
    for (const f of stopAll) f();
  };
  const gone = (status: number, error: string | null) => {
    const g = goneReason(status, error);
    stop();
    dead = false; // let the final status through
    say({ kind: "gone", ...g });
    dead = true;
  };
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  const tryPlay = () =>
    void video.play()?.catch((e: any) => {
      if (e?.name === "NotAllowedError") say({ kind: "blocked" });
    });
  // frames moving: "playing"; the time advancing is the proof, not the event alone
  let lastT = -1;
  const onTime = () => {
    if (video.currentTime !== lastT && video.readyState >= 2) {
      lastT = video.currentTime;
      if (lastKind !== "playing" && !lastKind.startsWith("stalled")) say({ kind: "playing" });
    }
  };
  video.addEventListener("timeupdate", onTime);
  stopAll.push(() => video.removeEventListener("timeupdate", onTime));
  say({ kind: "connecting" });

  /** The playlist, or null after reporting why there is none. */
  const playlist = async (): Promise<{ init: string | null; segs: string[] } | null> => {
    const r = await timedFetch(`${base}live.m3u8`, { cache: "no-store" });
    if (dead) return null;
    if (!r || !r.ok) {
      const body = r ? await r.json().catch(() => null) : null;
      const err = typeof body?.error === "string" ? body.error : null;
      if (r && r.status === 404 && err === "starting" && Date.now() - firstAsk < START_GRACE_MS) {
        say({ kind: "connecting", detail: "The desktop is starting its video encoder." });
        return null;
      }
      // a terminal answer ends it at once; a flaky one after a few tries
      if (r && (err === "no_desktop" || err === "ended" || r.status === 410)) gone(r.status, err);
      else if (++misses >= 4) gone(r?.status ?? 0, err);
      return null;
    }
    misses = 0;
    const text = await r.text();
    if (!text.startsWith("#EXTM3U")) {
      // a page or an error document where the playlist should be (a proxy without the desktop route)
      if (++misses >= 4) {
        stop();
        dead = false;
        say({ kind: "gone", code: "not_hls", reason: "the site answered with something other than a video playlist" });
        dead = true;
      }
      return null;
    }
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1] ?? null;
    const segs = text.split("\n").map((l) => l.trim()).filter((l) => /^seg-\d+\.m4s$/.test(l));
    return { init, segs };
  };

  const native = typeof video.canPlayType === "function" && video.canPlayType("application/vnd.apple.mpegurl") !== "";
  const MS: typeof MediaSource | undefined = (globalThis as any).ManagedMediaSource ?? (globalThis as any).MediaSource;
  if (native && !MS) {
    // Safari without Media Source: its own HLS player; poll the playlist only to notice the end
    video.src = `${base}live.m3u8`;
    tryPlay();
    const t = setInterval(() => void playlist(), 4000);
    stopAll.push(() => clearInterval(t), () => video.removeAttribute("src"));
    return { stop, resume: tryPlay };
  }
  if (!MS || !MS.isTypeSupported(DESK_CODEC)) {
    say({ kind: "gone", code: "codec", reason: "this browser cannot play the stream's H.264 video" });
    dead = true;
    return { stop, resume: () => undefined };
  }

  // one MediaSource per encoder run: a restarted encoder (after a geometry blackout) starts its
  // timestamps again, so a jump in segment numbers starts a fresh source
  let ms: MediaSource;
  let sb: SourceBuffer | null = null;
  let last = -1;
  let url = "";
  let appendedAt = 0;
  const fresh = () =>
    new Promise<void>((res) => {
      if (url) {
        URL.revokeObjectURL(url);
        say({ kind: "connecting", detail: "The desktop restarted its video encoder." });
      }
      ms = new MS();
      sb = null;
      last = -1;
      lastT = -1;
      url = URL.createObjectURL(ms);
      video.src = url;
      ms.addEventListener(
        "sourceopen",
        () => {
          try {
            sb = ms.addSourceBuffer(DESK_CODEC);
            sb.mode = "segments";
          } catch {
            say({ kind: "gone", code: "codec", reason: "this browser cannot play the stream's H.264 video" });
          }
          res();
        },
        { once: true },
      );
      tryPlay();
    });
  const append = (bytes: ArrayBuffer) =>
    new Promise<void>((res, rej) => {
      if (!sb) return rej(new Error("no source buffer"));
      const done = () => (sb!.removeEventListener("error", bad), res());
      const bad = () => (sb!.removeEventListener("updateend", done), rej(new Error("append failed")));
      sb.addEventListener("updateend", done, { once: true });
      sb.addEventListener("error", bad, { once: true });
      sb.appendBuffer(bytes);
    });
  const get = async (name: string) => {
    const r = await timedFetch(`${base}${name}`);
    if (!r || !r.ok) throw new Error(`${name} ${r?.status ?? "unreachable"}`);
    return r.arrayBuffer();
  };

  const tick = async () => {
    if (dead) return;
    const p = await playlist();
    if (!p || dead) return;
    if (!p.init || !p.segs.length) {
      say({ kind: "connecting", detail: "The desktop's playlist has no video segments yet." });
      return;
    }
    const nums = p.segs.map((s) => Number(/\d+/.exec(s)![0]));
    const first = nums[0]!;
    if (last >= 0 && (first > last + 1 || nums.at(-1)! < last)) await fresh();
    if (!sb) return;
    try {
      if (last < 0) {
        await append(await get(p.init));
        // start near the live edge: the last two segments
        last = nums.at(-3) ?? first - 1;
      }
      for (let i = 0; i < nums.length; i++) {
        if (nums[i]! <= last) continue;
        await append(await get(p.segs[i]!));
        last = nums[i]!;
        appendedAt = Date.now();
      }
      const b = video.buffered;
      if (b.length) {
        const start = b.start(0);
        const end = b.end(b.length - 1);
        // segment timestamps start where the encoder is, not at 0: jump into the buffered range
        if (video.currentTime < start || end - video.currentTime > 6) video.currentTime = Math.max(start, end - 1.5);
        if (video.currentTime - start > 40 && !sb.updating) sb.remove(start, video.currentTime - 20);
      }
      if (video.paused && lastKind !== "blocked") tryPlay();
    } catch {
      /* a segment that rolled out of the playlist; the next tick catches up */
    }
    if (appendedAt && Date.now() - appendedAt > STALL_MS && lastKind === "playing") say({ kind: "stalled", since: appendedAt });
    else if (lastKind === "stalled" && Date.now() - appendedAt < STALL_MS) say({ kind: "playing" });
  };
  let busy = false;
  const loop = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick().finally(() => (busy = false));
  }, 1000);
  stopAll.push(
    () => clearInterval(loop),
    () => {
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* nothing loaded */
      }
      if (url) URL.revokeObjectURL(url);
    },
  );
  firstAsk = Date.now();
  void fresh().then(() => tick());
  return { stop, resume: tryPlay };
}
