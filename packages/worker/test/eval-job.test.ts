// The sandbox host's job runner (packages/worker/src/eval-job.ts): what it refuses before running anything.
import { expect, test } from "bun:test";
import { jobError, runJob } from "../src/eval-job.ts";
import { RecipeBook } from "../src/recipes.ts";

const good = { v: 1, recipe_id: "ab".repeat(32), deps_digest: "cd".repeat(32), parent_patches: [], candidate_patch: "", seed: "0123456789abcdef" };

test("job validation", () => {
  expect(jobError(good)).toBeNull();
  expect(jobError({ ...good, v: 2 })).toMatch(/version/);
  expect(jobError({ ...good, recipe_id: "../../etc" })).toMatch(/hex/);
  expect(jobError({ ...good, parent_patches: [1] })).toMatch(/parent_patches/);
  expect(jobError({ ...good, candidate_patch: null })).toMatch(/candidate_patch/);
  expect(jobError({ ...good, enabled_metrics: ["ok_ir", "$(id)"] })).toMatch(/enabled_metrics/);
  expect(jobError(null)).not.toBeNull();
});

test("a recipe this host's release does not have is a host answer, not a crash", async () => {
  const a = await runJob(good as never, new RecipeBook());
  expect(a).toEqual({ ok: false, kind: "host", error: "recipe abababababab is not in this host's release; update the host" });
});
