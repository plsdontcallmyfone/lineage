import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { playlistFiles } from "./e2b.ts";

// The live stream files of a session's desktop, for the gate (GET /desktops/<session>/<file>,
// scripts/deploy/gate.ts). Only the playlist, its init segment and the segments the current playlist
// lists are served (an unfinished or dropped segment never is); nothing once the attempt ended.

const FILE = /^\/desktops\/([0-9a-f]{64})\/(live\.m3u8|init\.mp4|seg-\d{1,20}\.m4s)$/;

const types: Record<string, string> = { m3u8: "application/vnd.apple.mpegurl", mp4: "video/mp4", m4s: "video/iso.segment" };

export function desktopHandler(root: string) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/desktops/")) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
    const m = FILE.exec(url.pathname);
    if (!m) return Response.json({ error: "not_found" }, { status: 404 });
    const [, session, file] = m as unknown as [string, string, string];
    let s: { dir: string; ended_at: number | null };
    try {
      s = JSON.parse(readFileSync(join(root, "sessions", `${session}.json`), "utf8"));
    } catch {
      return Response.json({ error: "no_desktop" }, { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (s.ended_at) return Response.json({ error: "ended" }, { status: 410, headers: { "cache-control": "no-store" } });
    const pl = join(s.dir, "live.m3u8");
    if (!existsSync(pl)) return Response.json({ error: "starting" }, { status: 404, headers: { "cache-control": "no-store" } });
    const text = readFileSync(pl, "utf8");
    if (file !== "live.m3u8" && !playlistFiles(text).includes(file)) return Response.json({ error: "not_found" }, { status: 404 });
    const body = file === "live.m3u8" ? text : Bun.file(join(s.dir, file));
    if (file !== "live.m3u8" && !existsSync(join(s.dir, file))) return Response.json({ error: "not_found" }, { status: 404 });
    return new Response(body, {
      headers: { "content-type": types[file.split(".").pop()!]!, "cache-control": file === "live.m3u8" ? "no-store" : "public, max-age=60" },
    });
  };
}
