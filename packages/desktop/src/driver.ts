import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { b64, type DesktopInstance } from "./backend.ts";
import { CLASSES, type Tile } from "./layout.ts";
import type { Action, Seal } from "./seal.ts";

// The driver: carries out each tool call of the agent's loop as real desktop actions (xdotool and
// the tiles' command pipes, images/desktop/rootfs/usr/local/bin). The tool loop stays the authority:
// the toolbox reads and writes the working tree; the desktop shows that same tree (mounted, or for
// E2B copied and kept current file by file) and does what the agent did on it:
//
//   read      the file opens in the editor at the range, which is selected; the browser opens the
//             code host's page for the same lines
//   search    the search runs in a terminal (navigation terminal over the parent generation, or the
//             run terminal once the tree is edited)
//   edit      the edited file opens in the editor at the change, the changed lines selected
//   evaluate  the sandbox run's phases and its output scroll by in the run terminal
//   list      the directory listing in the navigation terminal
//
// Actions run one at a time in order. A backlog (a fast tool loop) drops the oldest navigation
// actions first; run-terminal output is never dropped. Every action passes seal.check first.

const BACKLOG = 12;

/**
 * The code host's own error pages (GitHub answers a slow or failed page with its "Unicorn!" 502/504
 * page or a "Server Error" page, a proxy with a bare gateway error). The driver reads the browser
 * window's title after a page load and reloads such a page a bounded number of times, waiting
 * longer before each try. A missing page (404) and a rate limit page are not reloaded: a reload
 * cannot fix the first and makes the second worse.
 */
const ERROR_TITLE = /^(?:unicorn!|server error|50[0-4]\b|(?:bad gateway|gateway time-?out|service unavailable)\b)/i;
export const isErrorPageTitle = (title: string): boolean => ERROR_TITLE.test(title.trim());

/** Waits before each look at the page: the first is the load itself, the rest back off. At most `length - 1` reloads. */
export const RELOAD_WAITS_MS = [2500, 2000, 4000, 8000];

export interface DriverOpts {
  /** waits before each title check (tests shorten them) */
  reloadWaitsMs?: number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

export class Driver {
  private q: Action[] = [];
  private running: Promise<void> | null = null;
  private wins = new Map<Tile, string>();
  private n = 0;
  readonly done = { actions: 0, refused: 0, failed: 0, dropped: 0, reloads: 0 };
  /** the page whose load is still being checked for an error page: which look is next and when */
  private page: { url: string; look: number; due: number } | null = null;
  private acting = false;
  private waits: number[];
  private now: () => number;
  private sleep: (ms: number) => Promise<unknown>;

  constructor(
    private inst: DesktopInstance,
    private seal: Seal,
    private tree: string,
    private log: (m: string) => void = () => {},
    o: DriverOpts = {},
  ) {
    this.waits = o.reloadWaitsMs ?? RELOAD_WAITS_MS;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /**
   * Has the driver check a page the browser opened by itself (the desktop's first page) the same
   * way as a page it navigated to.
   */
  watchPage(url: string): void {
    if (this.seal.phase === "ended" || !this.waits.length) return;
    this.page = { url, look: 0, due: this.now() + this.waits[0]! };
    if (!this.running) this.running = this.pump().finally(() => (this.running = null));
  }

  enqueue(actions: Action[]): void {
    if (!actions.length || this.seal.phase === "ended") return;
    this.q.push(...actions);
    while (this.q.length > BACKLOG) {
      const i = this.q.findIndex((a) => a.tile !== "run");
      if (i < 0) break;
      this.q.splice(i, 1);
      this.done.dropped++;
    }
    if (!this.running) this.running = this.pump().finally(() => (this.running = null));
  }

  /** Waits until the queue is empty (or `ms` passed). */
  async idle(ms = 30_000): Promise<void> {
    const t0 = Date.now();
    // a page still being watched for an error page does not hold the caller: only actions do
    while ((this.acting || this.q.length) && Date.now() - t0 < ms) await Bun.sleep(50);
  }

  /** Waits until the queue is empty and no page is being watched any more (or `ms` passed). */
  async settled(ms = 30_000): Promise<void> {
    const t0 = Date.now();
    while ((this.running || this.q.length || this.page) && Date.now() - t0 < ms) await Bun.sleep(20);
  }

  /** Stops acting: the queue is dropped. */
  stop(): void {
    this.q = [];
    this.page = null;
  }

  private async pump(): Promise<void> {
    while (this.q.length || this.page) {
      if (this.seal.phase === "ended") return void (this.page = null);
      // the page check runs between actions, in order with them; with nothing else to do the pump waits for it
      if (this.page && (this.now() >= this.page.due || !this.q.length)) {
        const wait = this.page.due - this.now();
        if (wait > 0) {
          await this.sleep(Math.min(wait, 100));
          continue;
        }
        await this.lookAtPage().catch((e) => {
          this.page = null;
          this.log(`desktop: browser page check failed: ${(e as Error).message}`);
        });
        continue;
      }
      const a = this.q.shift()!;
      try {
        this.seal.check(a);
      } catch (e) {
        this.done.refused++;
        this.log(`desktop: refused ${a.tile} ${a.op}: ${(e as Error).message}`);
        continue;
      }
      this.acting = true;
      try {
        await this.act(a);
        this.done.actions++;
      } catch (e) {
        this.done.failed++;
        this.log(`desktop: ${a.tile} ${a.op} failed: ${(e as Error).message}`);
      } finally {
        this.acting = false;
      }
    }
  }

  /** One look at the page being watched: an error page is reloaded (bounded, with backoff), anything else ends the watch. */
  private async lookAtPage(): Promise<void> {
    const p = this.page;
    if (!p) return;
    const w = await this.win("browser");
    if (!w) return void (this.page = null);
    const r = await this.inst.exec(["xdotool", "getwindowname", w], { timeoutMs: 5000 });
    if (this.page !== p) return; // a newer navigation replaced it
    const title = r.code === 0 ? r.stdout.trim() : "";
    if (!isErrorPageTitle(title)) return void (this.page = null);
    const next = p.look + 1;
    if (next >= this.waits.length) {
      this.page = null;
      this.log(`desktop: the code host still answers with an error page after ${p.look} reload${p.look === 1 ? "" : "s"} (${title.slice(0, 60)}); left as it is`);
      return;
    }
    // only ever the page the seal allows (the snapshot commit's pages); the reload itself is one key
    await this.x(["xdotool", "windowactivate", "--sync", w, "key", "--clearmodifiers", "F5"], "browser reload");
    this.done.reloads++;
    this.log(`desktop: the code host answered with an error page (${title.slice(0, 60)}); reload ${next} of ${this.waits.length - 1}`);
    this.page = { url: p.url, look: next, due: this.now() + this.waits[next]! };
  }

  private async win(t: Tile): Promise<string | null> {
    const have = this.wins.get(t);
    if (have) return have;
    const r = await this.inst.exec(["xdotool", "search", "--onlyvisible", "--class", CLASSES[t]]);
    const id = r.stdout.split(/\s+/).find(Boolean) ?? null;
    if (id) this.wins.set(t, id);
    return id;
  }

  private async x(argv: string[], what: string): Promise<void> {
    const r = await this.inst.exec(argv, { timeoutMs: 20_000 });
    if (r.code !== 0) throw new Error(`${what}: exit ${r.code} ${r.stderr.trim().slice(0, 160)}`);
  }

  /** The host file under the tree (no symlinks out), for a desktop holding a copy. */
  private hostFile(rel: string): Uint8Array | null {
    const abs = join(this.tree, rel);
    if (!existsSync(abs)) return null;
    const root = realpathSync(this.tree);
    const real = realpathSync(abs);
    if (!real.startsWith(root + sep)) return null;
    return readFileSync(real);
  }

  private async act(a: Action): Promise<void> {
    switch (a.tile) {
      case "editor": {
        // the toolbox records an edit and then writes it in the same tick: read the file after a pause
        await Bun.sleep(30);
        if (this.inst.push) {
          const bytes = this.hostFile(a.path);
          if (bytes) await this.inst.push(a.path, bytes);
        }
        const w = await this.win("editor");
        if (!w) throw new Error("no editor window");
        // leave the file shown now (micro quits; at the prompt the key does nothing), then open the next
        await this.x(["xdotool", "windowactivate", "--sync", w, "key", "--clearmodifiers", "ctrl+q"], "editor quit");
        await Bun.sleep(150);
        await this.x(["desk-cmd", "editor", "open", b64(a.path), String(a.line)], "editor open");
        await Bun.sleep(450);
        if (a.select > 0) await this.x(["xdotool", "windowactivate", "--sync", w, "key", "--clearmodifiers", "--repeat", String(a.select + 1), "--delay", "25", "shift+Down"], "editor select");
        return;
      }
      case "browser": {
        const w = await this.win("browser");
        if (!w) return; // a desktop without a browser still shows the rest
        await this.x(["xdotool", "windowactivate", "--sync", w, "key", "--clearmodifiers", "ctrl+l"], "browser focus");
        await this.x(["xdotool", "type", "--delay", "8", "--clearmodifiers", `${a.url}\n`], "browser address");
        if (this.waits.length) this.page = { url: a.url, look: 0, due: this.now() + this.waits[0]! };
        return;
      }
      case "term":
      case "run":
        if (a.op === "ls") return this.x(["desk-cmd", a.tile, "ls", b64(a.path)], `${a.tile} ls`);
        if (a.op === "search") {
          // a desktop holding a copy of the tree gets every edited file before a search over it
          if (a.tile === "run" && this.inst.push) {
            await Bun.sleep(30);
            for (const p of this.seal.dirty) {
              const bytes = p.includes("\0") ? null : this.hostFile(p);
              if (bytes) await this.inst.push(p, bytes);
            }
          }
          return this.x(["desk-cmd", a.tile, "search", b64(a.pattern)], `${a.tile} search`);
        }
        if (a.op === "show" && a.tile === "run") {
          const name = `out-${++this.n}`;
          await this.inst.exec(["desk-put", name], { stdin: a.text });
          return this.x(["desk-cmd", "run", "show", name, b64(a.title)], "run show");
        }
        return;
    }
  }
}
