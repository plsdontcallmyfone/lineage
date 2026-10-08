#!/usr/bin/env bun
// Lineage site: re-pins recipes to THIS machine's architecture and locally built sandbox images.
//
//   bun scripts/deploy/arch-recipes.ts fixture-b58,base58-py,minbpe [--check]
//
// Recipes in the repository pin arm64 image ids (`lineage/<class>:<tag>@sha256:<id>`) and require
// arm64: they were calibrated on an Apple M4. A metric like cachegrind instruction counts differs
// between architectures, and an image id built here differs from the Mac's, so an amd64 server can
// not serve those recipes as committed. This script rewrites, in the deployed release only (never
// in the repository), each named recipe's `requires.arch` to this machine's arch and its image pin
// to the id of the image built here from images/<class>. The recipe id changes with it, so Core
// calibrates a new lineage for it (a different image is a different recipe, RUNBOOK section
// "Prerequisites"); the reference runner then measures every baseline on this machine.
// On an arm64 server whose images match the committed ids the recipe is left as committed.
// Arch-specific harness files: scripts/deploy/<arch>/<name>/** is copied into the release's
// recipes/<name>/overlay (amd64: the Go harness entry stubs, entry_amd64.s next to entry_arm64.s;
// bitcoin-base58's Makefile), and scripts/deploy/<arch>/<name>.replace.json ([[from, to], ...]) is
// applied to its recipe.yml (amd64: the zig recipes' -target aarch64-linux-musl becomes x86_64).
// --check only prints what it would change. Prints { name: recipe_id } as JSON on the last line.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRecipe } from "@lineage/sandbox";
import { doctor } from "../../packages/worker/src/doctor.ts";

const ROOT = join(import.meta.dir, "..", "..");
const argv = process.argv.slice(2);
const names = (argv.find((a) => !a.startsWith("--")) ?? "").split(",").filter(Boolean);
const CHECK = argv.includes("--check");
if (!names.length) {
  console.error("usage: arch-recipes.ts <name,name,...> [--check]");
  process.exit(2);
}
const arch = doctor().capabilities.arch;
const out: Record<string, string> = {};
for (const name of names) {
  const file = join(ROOT, "recipes", name, "recipe.yml");
  const text = readFileSync(file, "utf8");
  const m = /^image:\s*"?([^"@\s]+)@sha256:([0-9a-f]{64})"?\s*$/m.exec(text);
  if (!m) throw new Error(`${name}: no pinned image line`);
  const ref = m[1]!;
  const insp = Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Id}}", ref], { stdout: "pipe", stderr: "pipe" });
  const local = insp.stdout.toString().trim().replace(/^sha256:/, "");
  if (insp.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(local)) throw new Error(`${name}: image ${ref} is not built here (docker build -t ${ref} images/<class>)`);
  const replFile = join(import.meta.dir, arch, `${name}.replace.json`);
  const repl: [string, string][] = arch !== "arm64" && existsSync(replFile) ? JSON.parse(readFileSync(replFile, "utf8")) : [];
  const next = repl
    .reduce((t, [from, to]) => t.split(from).join(to), text)
    .replace(/^image:.*$/m, `image: "${ref}@sha256:${local}"`)
    .replace(/^requires:\s*\{([^}]*)\}/m, (_all, inner: string) => `requires: {${inner.replace(/arch:\s*\w+/, `arch: ${arch}`)}}`);
  const extra = join(import.meta.dir, arch, name);
  const hasExtra = arch !== "arm64" && existsSync(extra);
  if (hasExtra && !CHECK) cpSync(extra, join(ROOT, "recipes", name, "overlay"), { recursive: true });
  const changed = next !== text || hasExtra;
  if (next !== text && !CHECK) writeFileSync(file, next);
  const loaded = loadRecipe(join(ROOT, "recipes", name));
  out[name] = loaded.recipe_id;
  console.log(`${name}: ${changed ? (CHECK ? "would re-pin" : "re-pinned") : "unchanged"} to ${arch}${hasExtra ? ` (+ ${arch} overlay files)` : ""}, image ${ref}@sha256:${local.slice(0, 12)}..., recipe ${loaded.recipe_id.slice(0, 12)}...`);
}
console.log(JSON.stringify(out));
