import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRecipe, prepareDeps, type DepsLayer, type LoadedRecipe } from "@lineage/sandbox";

// Local recipe registry. In M1 workers carry the recipes directory (harness overlays included) and
// match Core's recipe_id against their local copies; a mismatch means the worker must update.
// M2 distributes overlays and dependency layers as content-addressed blobs (MILESTONES M2).

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export class RecipeBook {
  private byId = new Map<string, LoadedRecipe>();
  private deps = new Map<string, DepsLayer>();

  constructor(dir = join(REPO_ROOT, "recipes")) {
    // LINEAGE_RECIPES_EXTRA: more recipe directories (":"-separated), e.g. the e2e's second lineage of one repo
    for (const d of [dir, ...(process.env.LINEAGE_RECIPES_EXTRA ?? "").split(":").filter(Boolean)]) this.loadDir(d);
  }

  private loadDir(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(join(dir, e.name, "recipe.yml"))) continue;
      try {
        const l = loadRecipe(join(dir, e.name));
        this.byId.set(l.recipe_id, l);
      } catch {
        // an invalid recipe directory is skipped; it cannot match any Core recipe id
      }
    }
  }

  get(recipe_id: string): LoadedRecipe {
    const l = this.byId.get(recipe_id);
    if (!l) throw new Error(`recipe ${recipe_id.slice(0, 12)} not found locally; update the recipes directory`);
    return l;
  }

  has(recipe_id: string): boolean {
    return this.byId.has(recipe_id);
  }

  all(): LoadedRecipe[] {
    return [...this.byId.values()];
  }

  async depsFor(l: LoadedRecipe, expected?: string): Promise<DepsLayer> {
    let d = this.deps.get(l.recipe_id);
    if (!d) {
      d = await prepareDeps(l);
      this.deps.set(l.recipe_id, d);
    }
    if (expected && d.digest !== expected) throw new Error(`dependency layer ${d.digest.slice(0, 12)} differs from the snapshot's ${expected.slice(0, 12)}`);
    return d;
  }
}
