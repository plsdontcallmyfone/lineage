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

export class Driver {
  private q: Action[] = [];
  private running: Promise<void> | null = null;
  private wins = new Map<Tile, string>();
  private n = 0;
  readonly done = { actions: 0, refused: 0, failed: 0, dropped: 0 };

  constructor(
    private inst: DesktopInstance,
    private seal: Seal,
    private tree: string,
    private log: (m: string) => void = () => {},
  ) {}

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
    while ((this.running || this.q.length) && Date.now() - t0 < ms) await Bun.sleep(50);
  }

  /** Stops acting: the queue is dropped. */
  stop(): void {
    this.q = [];
  }

  private async pump(): Promise<void> {
    while (this.q.length) {
      const a = this.q.shift()!;
      if (this.seal.phase === "ended") return;
      try {
        this.seal.check(a);
      } catch (e) {
        this.done.refused++;
        this.log(`desktop: refused ${a.tile} ${a.op}: ${(e as Error).message}`);
        continue;
      }
      try {
        await this.act(a);
        this.done.actions++;
      } catch (e) {
        this.done.failed++;
        this.log(`desktop: ${a.tile} ${a.op} failed: ${(e as Error).message}`);
      }
    }
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
