import { describe, expect, test } from "bun:test";
import { classify, DesktopViewers, LIMITS, localCaller } from "./gate.ts";

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

  test("viewer counts: per session and total only, and only for a direct loopback caller", () => {
    let t = 0;
    const v = new DesktopViewers(() => t, 50, 300, 1000);
    v.admit("s1", "10.0.0.1");
    v.admit("s1", "10.0.0.2");
    v.admit("s1", "10.0.0.1");
    v.admit("s2", "10.0.0.1");
    const snap = v.snapshot();
    expect(snap).toEqual({ at: 0, total: 3, sessions: { s1: 2, s2: 1 } });
    // nothing but counts leaves the gate: no address key, no cap, no headroom
    expect(JSON.stringify(snap)).not.toContain("10.0.0");
    expect(Object.keys(snap).sort()).toEqual(["at", "sessions", "total"]);
    t = 2000;
    expect(v.snapshot()).toEqual({ at: 2000, total: 0, sessions: {} });

    const req = (h: Record<string, string> = {}) => new Request("http://127.0.0.1:9662/gate/viewers", { headers: h });
    expect(localCaller(req(), "127.0.0.1")).toBe(true);
    expect(localCaller(req(), "::1")).toBe(true);
    expect(localCaller(req(), "::ffff:127.0.0.1")).toBe(true);
    // through Caddy (a forwarded header) or from another machine: refused
    expect(localCaller(req({ "x-forwarded-for": "203.0.113.9" }), "127.0.0.1")).toBe(false);
    expect(localCaller(req({ forwarded: "for=203.0.113.9" }), "127.0.0.1")).toBe(false);
    expect(localCaller(req(), "203.0.113.9")).toBe(false);
    expect(localCaller(req(), null)).toBe(false);
  });
});
