import { describe, expect, test } from "bun:test";
import { classify, DesktopViewers, LIMITS } from "./gate.ts";

// Agent desktop streams through the gate (SPEC 17.7): their own class, only the stream's file names,
// a viewer cap per session and over all sessions.

const S = "a".repeat(64);

describe("desktop streams", () => {
  test("only the playlist, init and numbered segments of a 64 hex session, GET or HEAD", () => {
    for (const f of ["live.m3u8", "init.mp4", "seg-1760000000.m4s"]) {
      const r = classify("GET", `/desktops/${S}/${f}`);
      expect(r).toEqual({ klass: "desktop", upstream: "runtime", cors: true, stream: false, sameOrigin: false });
    }
    for (const p of [`/desktops/${S}/`, `/desktops/${S}/rec.mp4`, `/desktops/${S}/../sessions/x.json`, `/desktops/${S.slice(1)}/live.m3u8`, `/desktops/${S}/seg-1.ts`, "/desktops/", `/desktops/${S}/live.m3u8/x`])
      expect("refuse" in classify("GET", p)).toBe(true);
    expect(classify("POST", `/desktops/${S}/live.m3u8`)).toEqual({ refuse: 405, why: "method" });
    expect(LIMITS.desktop.perMin).toBeGreaterThanOrEqual(60);
  });

  test("viewer cap: per session and in total; a known viewer always passes; viewers expire", () => {
    let t = 0;
    const v = new DesktopViewers(() => t, 2, 3, 1000);
    expect(v.admit("s1", "a")).toBe(true);
    expect(v.admit("s1", "b")).toBe(true);
    expect(v.admit("s1", "c")).toBe(false);
    expect(v.admit("s1", "a")).toBe(true);
    expect(v.admit("s2", "c")).toBe(true);
    expect(v.admit("s2", "d")).toBe(false); // total 3
    t = 2000;
    expect(v.admit("s1", "c")).toBe(true);
    expect(v.count()).toBe(1);
  });
});
