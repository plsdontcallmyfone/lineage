import type { SessionEventInput } from "../../worker/src/session.ts";
import { CLASSES, inside, TILES, type Rect, type Tile } from "./layout.ts";

// The sealing state machine of one desktop (docs/plans/AGENT-DESKTOPS.md "Sealing", SPEC 17.3, 10.7).
//
// Edits must not be readable before the verdict: a visible patch can be copied and committed first,
// and edit text typed in under a named agent links it to an open candidate. Three mechanisms, each
// enough on its own for its part:
//
// 1. Static redaction (layout.ts). The live stream pixelates the editor's text area and the whole run
//    tile in one ffmpeg filter for its whole life. A live stream never shows unredacted content:
//    Core's gate opens only after the verdict, after the attempt (and so the stream) ended.
// 2. The router (route). Everything shown is placed by tile: file contents only in the editor; sandbox
//    output, results and searches over an edited tree only in the run tile; the navigation terminal
//    gets listings and searches over the committed parent generation (git grep HEAD inside the
//    desktop, so an edit written while a search runs cannot appear); the browser only the code host's
//    page at the snapshot commit. A stacked attempt (SPEC 12.4) starts on its own sealed pending patch,
//    so all its searches go to the run tile. `check` re-asserts these rules before the driver acts.
// 3. The geometry guard (geometry). The redaction is by screen position, so the editor and run windows
//    must sit inside their tiles. Anything else (a window moved, resized past its tile, missing, or
//    unreadable state) puts the desktop in blackout: the live encoder is stopped and its unfinished
//    segment discarded until the windows are back.
//
// The recording is unredacted. It stays on the desktop host ("held") after the attempt and is
// published to Core's blob store only once Core reports the session's gate open (candidate final, or
// the attempt ended without one, or abandoned): `publishable`.

export type Phase = "warming" | "live" | "blackout" | "ended";
export type RecordingState = "recording" | "held" | "published" | "none";

export type Action =
  | { tile: "editor"; op: "open"; path: string; line: number; select: number }
  | { tile: "browser"; op: "goto"; url: string }
  | { tile: "term" | "run"; op: "ls"; path: string }
  | { tile: "term" | "run"; op: "search"; pattern: string }
  | { tile: "run"; op: "show"; title: string; text: string };

export interface SealOpts {
  /** the attempt builds on its own pending (sealed) candidate (SPEC 12.4) */
  stacked: boolean;
  /** the target repository URL (a github.com repository gets browser pages) */
  repo: string | null;
  /** the snapshot commit the browser pages show */
  commit: string;
}

/** Gate states (SPEC 17.3) in which sealed content, and so the recording, is public. */
export const OPEN_STATES = new Set(["final", "ended", "abandoned"]);

const SAFE_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0\n]{1,400}$/;

export function githubBase(repo: string | null): string | null {
  if (!repo) return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

export class Seal {
  phase: Phase = "warming";
  recording: RecordingState = "recording";
  /** files this attempt edited or wrote */
  readonly dirty = new Set<string>();
  /** why the desktop is in blackout */
  why: string | null = null;
  private gh: string | null;

  constructor(readonly o: SealOpts) {
    this.gh = githubBase(o.repo);
  }

  /** Searches over the working copy may show changed lines. */
  get treeSealed(): boolean {
    return this.o.stacked || this.dirty.size > 0;
  }

  /**
   * What the desktop shows for one session event. Updates the seal state first (synchronously, before
   * the tool writes the file: the toolbox records an edit before it writes), then places the action.
   */
  route(e: SessionEventInput): Action[] {
    if (this.phase === "ended") return [];
    const path = typeof e.path === "string" && SAFE_PATH.test(e.path) ? e.path : null;
    switch (e.kind) {
      case "list":
        return [{ tile: "term", op: "ls", path: path ?? "." }];
      case "read": {
        if (!path) return [];
        const a = Math.max(1, e.start_line ?? 1);
        const b = Math.max(a, e.end_line ?? a);
        const out: Action[] = [{ tile: "editor", op: "open", path, line: a, select: Math.min(b - a, 60) }];
        // the code host shows the snapshot commit: a file this attempt edited is not the one there
        if (this.gh && !this.dirty.has(path)) out.push({ tile: "browser", op: "goto", url: `${this.gh}/blob/${this.o.commit}/${path.split("/").map(encodeURIComponent).join("/")}#L${a}-L${b}` });
        return out;
      }
      case "search": {
        if (typeof e.query !== "string" || !e.query) return [];
        return [{ tile: this.treeSealed ? "run" : "term", op: "search", pattern: e.query.slice(0, 500) }];
      }
      case "edit":
      case "write":
      case "patch": {
        if (!path) {
          // an edit we cannot place still seals the tree
          this.dirty.add("\0unknown");
          return [];
        }
        this.dirty.add(path);
        return [{ tile: "editor", op: "open", path, line: Math.max(1, e.start_line ?? 1), select: Math.min(Math.max(0, (e.lines_after ?? 1) - 1), 60) }];
      }
      case "evaluate":
        return [{ tile: "run", op: "show", title: `$ lineage sandbox evaluate ${(e.eval_kind ?? "").slice(0, 40)} ${(e.target ?? "").slice(0, 120)}`.trim(), text: "" }];
      case "phase":
        return e.phase ? [{ tile: "run", op: "show", title: `  ${e.phase} ...`, text: "" }] : [];
      case "result": {
        const steps = (e.steps ?? []).map((s) => `-- ${s.step}${s.side ? ` (${s.side})` : ""}: exit ${s.exit}, ${(s.duration_ms / 1000).toFixed(1)} s${s.timed_out ? ", timed out" : ""}\n${s.tail}`).join("\n");
        return [{ tile: "run", op: "show", title: `outcome: ${e.outcome ?? "?"}`, text: [e.output ?? "", steps].filter(Boolean).join("\n").slice(0, 200_000) }];
      }
      default:
        // note, submit, give_up: sealed text with no place on the desktop
        return [];
    }
  }

  /** Throws if an action would put sealed content where the live stream shows it. Called right before the driver acts. */
  check(a: Action): void {
    switch (a.tile) {
      case "term":
        if (a.op === "search" && this.treeSealed) throw new Error("seal: a search over an edited tree may not run in the navigation terminal");
        if (a.op !== "ls" && a.op !== "search") throw new Error("seal: the navigation terminal shows listings and searches only");
        return;
      case "browser":
        if (!this.gh || !a.url.startsWith(`${this.gh}/blob/${this.o.commit}/`)) throw new Error("seal: the browser shows the code host's page at the snapshot commit only");
        return;
      case "editor":
      case "run":
        return;
      default:
        throw new Error("seal: unknown tile");
    }
  }

  /**
   * The geometry guard: the editor and run windows (the sealed content) must each lie inside their
   * tiles, and both must be there. `windows` is what desk-geom reported; null when it could not be read.
   * Returns whether the stream may run.
   */
  geometry(windows: { cls: string; rect: Rect }[] | null): boolean {
    if (this.phase === "ended") return false;
    const bad = (why: string) => {
      this.phase = "blackout";
      this.why = why;
      return false;
    };
    if (!windows) return bad("window geometry unreadable");
    for (const t of ["editor", "run"] as Tile[]) {
      const mine = windows.filter((w) => w.cls === CLASSES[t]);
      if (!mine.length) return bad(`${t} window missing`);
      for (const w of mine) if (!inside(w.rect, TILES[t])) return bad(`${t} window outside its tile (${w.rect.x},${w.rect.y} ${w.rect.w}x${w.rect.h})`);
    }
    // a window of another tile reaching outside its own tile could cover a sealed tile's neighbour: harmless
    // (it shows no sealed content), but it means the layout is off, so stop too
    for (const w of windows) {
      const t = (Object.keys(CLASSES) as Tile[]).find((k) => CLASSES[k] === w.cls);
      if (t && !inside(w.rect, TILES[t])) return bad(`${t} window outside its tile`);
    }
    this.phase = "live";
    this.why = null;
    return true;
  }

  get streamAllowed(): boolean {
    return this.phase === "live";
  }

  /** The attempt ended: no more stream; the recording waits for the gate. */
  end(hasRecording: boolean): void {
    this.phase = "ended";
    this.recording = hasRecording ? "held" : "none";
  }

  /** The recording may be published: held, and Core reports the gate open. */
  publishable(gateState: string | null | undefined): boolean {
    return this.recording === "held" && !!gateState && OPEN_STATES.has(gateState);
  }
}
