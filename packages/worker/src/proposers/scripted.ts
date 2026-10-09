import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiff, type CandidateKind } from "@lineage/protocol";
import { applyPatch } from "@lineage/sandbox";
import { heldByOthers, targetKey, type PlannedTarget, type Proposal, type ProposeContext, type Proposer } from "./types.ts";

// Scripted proposer: submits prepared patches in order (fixture patches, hand-written candidates
// in recipes/<name>/candidates/). Used by the e2e suite and for replaying known improvements
// without a model. A patch that no longer applies to the current parent is skipped.

export interface ScriptEntry {
  name: string;
  kind: CandidateKind;
  target: string | string[];
  diff: string;
}

export function loadScript(dir: string, names?: string[]): ScriptEntry[] {
  const indexPath = join(dir, "index.json");
  if (!existsSync(indexPath)) throw new Error(`no index.json in ${dir}`);
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, { kind: CandidateKind; target: string | string[]; canary?: boolean }>;
  const order = names ?? Object.keys(index).filter((n) => !index[n]!.canary);
  return order.map((name) => {
    const meta = index[name];
    if (!meta) throw new Error(`no patch ${name} in ${dir}`);
    return { name, kind: meta.kind, target: meta.target, diff: readFileSync(join(dir, `${name}.diff`), "utf8") };
  });
}

export class ScriptedProposer implements Proposer {
  readonly name = "scripted";
  private queue: ScriptEntry[];

  constructor(entries: ScriptEntry[]) {
    this.queue = [...entries];
  }

  get remaining(): number {
    return this.queue.length;
  }

  /**
   * Picks the first scripted patch that applies to the parent, preferring (advisory collaboration)
   * one whose target no other agent holds an intent on. Deterministic: script order, then held or not.
   */
  async plan(ctx: ProposeContext): Promise<PlannedTarget | null> {
    const held = ctx.collab === "advisory" ? heldByOthers(ctx) : new Set<string>();
    const applies = this.queue.filter((e) => Bun.spawnSync(["git", "apply", "--check", "--whitespace=nowarn", "-"], { cwd: ctx.tree, stdin: Buffer.from(e.diff) }).exitCode === 0);
    const pick = applies.find((e) => !held.has(targetKey(e.kind, e.target))) ?? applies[0];
    if (!pick) return null;
    if (pick !== applies[0] || held.size) ctx.log(`scripted: plan ${pick.name} on ${JSON.stringify(pick.target)}${held.has(targetKey(pick.kind, pick.target)) ? " (every applying target is held; intents are advisory)" : held.size ? " (skipping targets other agents hold intents on)" : ""}`);
    // propose() takes the planned patch next
    this.queue = [pick, ...this.queue.filter((e) => e !== pick)];
    return { kind: pick.kind, target: pick.target, note: `scripted ${pick.name}` };
  }

  async propose(ctx: ProposeContext): Promise<Proposal | null> {
    while (this.queue.length) {
      const next = this.queue.shift()!;
      // apply onto the working tree without committing: the author diffs the working tree
      const p = Bun.spawnSync(["git", "apply", "--whitespace=nowarn", "-"], { cwd: ctx.tree, stdin: Buffer.from(next.diff) });
      if (p.exitCode !== 0) {
        ctx.log(`scripted: ${next.name} does not apply to the current parent, skipped`);
        continue;
      }
      ctx.log(`scripted: proposing ${next.name}`);
      sessionHunks(ctx, next);
      reportEdits(ctx, next);
      return { kind: next.kind, target: next.target, rationale: `scripted patch ${next.name}` };
    }
    return null;
  }
}

/**
 * Live activity for a scripted patch: one edit per hunk, as the range of PARENT lines it replaces
 * (the parent file is public; the new text stays sealed until reveal), then the proposal itself.
 */
function reportEdits(ctx: ProposeContext, entry: ScriptEntry) {
  try {
    for (const f of parseDiff(entry.diff)) {
      if (f.status === "add" || !f.oldPath) continue; // a new file is not in the parent tree
      for (const h of f.hunks) {
        const m = /^@@ -(\d+)(?:,(\d+))? /.exec(h);
        if (!m) continue;
        const start = Math.max(1, Number(m[1]));
        const len = m[2] === undefined ? 1 : Number(m[2]);
        ctx.activity?.({ kind: "edit", path: f.oldPath, start_line: start, end_line: Math.max(start, start + len - 1) });
      }
    }
    ctx.activity?.({ kind: "propose", target: Array.isArray(entry.target) ? entry.target.join(",").slice(0, 200) : entry.target });
  } catch {
    /* telemetry never breaks authoring */
  }
}

/** One hunk of a unified diff as before and after text, anchored where it lands when hunks apply in order. */
export interface PatchHunk {
  path: string;
  start: number;
  oldLen: number;
  newLen: number;
  before: string;
  after: string;
}

export function patchHunks(diff: string): PatchHunk[] {
  const out: PatchHunk[] = [];
  for (const f of parseDiff(diff)) {
    const path = f.newPath ?? f.oldPath;
    if (!path || f.binary || f.status === "delete") continue;
    let cur: PatchHunk | null = null;
    const b: string[] = [];
    const a: string[] = [];
    const close = () => {
      if (cur) out.push({ ...cur, before: b.join("\n"), after: a.join("\n") });
      b.length = 0;
      a.length = 0;
    };
    for (const l of f.hunks) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m) {
        close();
        // the new-side start is where this hunk lands once every earlier hunk of the file applied
        cur = { path, start: Math.max(1, Number(m[3])), oldLen: m[2] === undefined ? 1 : Number(m[2]), newLen: m[4] === undefined ? 1 : Number(m[4]), before: "", after: "" };
        continue;
      }
      if (!cur || l.startsWith("\\")) continue;
      const body = l.slice(1);
      if (l.startsWith("-")) b.push(body);
      else if (l.startsWith("+")) a.push(body);
      else (b.push(body), a.push(body));
    }
    close();
  }
  return out;
}

/** Session events (SPEC 17.3) for a scripted patch: one labelled edit per hunk, in apply order. */
function sessionHunks(ctx: ProposeContext, entry: ScriptEntry) {
  try {
    const hunks = patchHunks(entry.diff);
    hunks.forEach((h, i) =>
      ctx.session?.({
        kind: "patch",
        label: `applying patch ${entry.name}, hunk ${i + 1} of ${hunks.length}`.slice(0, 200),
        path: h.path,
        start_line: h.start,
        end_line: Math.max(h.start, h.start + h.oldLen - 1),
        lines_before: h.oldLen,
        lines_after: h.newLen,
        before: h.before.slice(0, 40_000),
        after: h.after.slice(0, 40_000),
      }),
    );
  } catch {
    /* telemetry never breaks authoring */
  }
}

export { applyPatch };
