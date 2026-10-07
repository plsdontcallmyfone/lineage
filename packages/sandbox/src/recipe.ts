import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { H, recipeId, sha256Hex, type Recipe } from "@lineage/protocol";

// Recipe loading and validation, SPEC section 6. A recipe lives in recipes/<name>/ with
// recipe.yml, an optional overlay/ (harness files copied into the tree, always protected) and
// optional canaries/ (known-bad patches, used by Core).

export interface LoadedRecipe {
  recipe: Recipe;
  recipe_id: string;
  dir: string;
  overlayDir: string | null;
  overlayFiles: string[];
}

export class RecipeError extends Error {}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function overlayDigest(dir: string): { digest: string; files: string[] } {
  const files = walk(dir)
    .map((p) => relative(dir, p))
    .sort();
  const entries = files.map((f) => [f, sha256Hex(readFileSync(join(dir, f)))]);
  return { digest: H("overlay", JSON.stringify(entries)), files };
}

const req = (cond: unknown, msg: string) => {
  if (!cond) throw new RecipeError(msg);
};

export function validateRecipe(r: Recipe): void {
  req(typeof r.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(r.name), "name must be lowercase kebab");
  req(typeof r.repo === "string" && r.repo.length > 0, "repo required");
  req(["rust", "solana", "zig", "cuda", "python", "go", "cpp"].includes(r.class), "class must be one of rust, solana, zig, cuda, python, go, cpp (SPEC 6.1)");
  req(r.requires && (r.requires.arch === "amd64" || r.requires.arch === "arm64"), "requires.arch must be amd64 or arm64");
  if (r.class === "cuda") req(r.requires.gpu?.vendor === "nvidia" && /^\d+\.\d+$/.test(r.requires.gpu.sm ?? ""), "cuda recipes require requires.gpu { vendor: nvidia, sm: \"<major.minor>\" }");
  req(/^[0-9a-f]{40}$/.test(r.commit), "commit must be a full 40-hex sha");
  req(typeof r.image === "string" && /@sha256:[0-9a-f]{64}$/.test(r.image), "image must be pinned as name@sha256:<id>");
  req(r.workdir === "/work/src", "workdir must be /work/src");
  req(Array.isArray(r.prepare), "prepare must be a list");
  req(Array.isArray(r.build?.commands) && r.build.commands.length > 0, "build.commands required");
  req(typeof r.test?.command === "string" && typeof r.test?.parser === "string", "test.command and test.parser required");
  req(Array.isArray(r.metrics), "metrics must be a list");
  const names = new Set<string>();
  for (const m of r.metrics) {
    req(/^[a-z0-9_]+$/.test(m.name), `metric name ${m.name}`);
    req(!names.has(m.name), `duplicate metric ${m.name}`);
    names.add(m.name);
    req(m.kind === "perf" || m.kind === "slim", `metric ${m.name}: kind`);
    req(m.direction === "lower" || m.direction === "higher", `metric ${m.name}: direction`);
    req(typeof m.min_effect === "number" && m.min_effect > 0 && m.min_effect < 1, `metric ${m.name}: min_effect in (0,1)`);
    if (!m.deterministic) req((m.rounds ?? 0) >= 5, `metric ${m.name}: noisy metrics need rounds >= 5`);
  }
  const p = r.patch;
  req(p && Array.isArray(p.allowed_paths) && p.allowed_paths.length > 0, "patch.allowed_paths required");
  req(Array.isArray(p.protected_paths), "patch.protected_paths required");
  req(p.max_files > 0 && p.max_lines > 0, "patch bounds");
  const l = r.limits;
  req(l && l.cpus > 0 && l.memory_mb >= 256 && l.pids >= 64 && l.wall_s > 0, "limits");
}

/** Overlay paths are always protected, whatever the recipe says (SPEC 6). */
function withOverlayProtected(r: Recipe, overlayFiles: string[]): Recipe {
  const prot = new Set(r.patch.protected_paths);
  for (const f of overlayFiles) prot.add(f);
  return { ...r, patch: { ...r.patch, protected_paths: [...prot].sort() } };
}

export function loadRecipe(dir: string): LoadedRecipe {
  const file = join(dir, "recipe.yml");
  req(existsSync(file), `missing ${file}`);
  const raw = Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const overlayDir = existsSync(join(dir, "overlay")) && statSync(join(dir, "overlay")).isDirectory() ? join(dir, "overlay") : null;
  const ov = overlayDir ? overlayDigest(overlayDir) : { digest: undefined, files: [] as string[] };
  let recipe: Recipe = { ...(raw as unknown as Recipe), overlay_digest: ov.digest };
  recipe.test = { exclude: [], ...recipe.test };
  recipe.build = { reproducible: false, artifacts: [], ...recipe.build };
  validateRecipe(recipe);
  recipe = withOverlayProtected(recipe, ov.files);
  return { recipe, recipe_id: recipeId(recipe), dir, overlayDir, overlayFiles: ov.files };
}
