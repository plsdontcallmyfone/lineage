import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateKind } from "@lineage/protocol";
import { applyPatch } from "@lineage/sandbox";
import type { Proposal, ProposeContext, Proposer } from "./types.ts";

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
      return { kind: next.kind, target: next.target, rationale: `scripted patch ${next.name}` };
    }
    return null;
  }
}

export { applyPatch };
